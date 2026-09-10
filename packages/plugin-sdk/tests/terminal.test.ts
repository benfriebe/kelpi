import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalAction, TerminalAttachOptions, TerminalFrame, ViewAPI } from '../index.js';
import { createTerminalScope } from '../../client/src/plugins/terminal.js';
import type { PtySubscription } from '../../client/src/connection/pty.js';

const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
};
async function tick(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness() {
    const events = new Map<string, (...args: any[]) => void>();
    const parent = { postMessage: vi.fn() };
    const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: (_event: any): void | Promise<void> => {} };
    const context = vm.createContext({
        __KELPI_VIEW__: { nonce: 'terminal', state: {}, stateVersion: 1, context: { daemonID: 'owner', paneID: 'pane' } },
        parent, TextEncoder, setTimeout, clearTimeout, console,
        document: { documentElement: { style: { setProperty: vi.fn() } } },
        addEventListener: (name: string, listener: (...args: any[]) => void) => events.set(name, listener),
        removeEventListener: (name: string) => events.delete(name),
    });
    const shared = fs.readFileSync(new URL('../api.js', import.meta.url), 'utf8').replace(/^export /gm, '');
    vm.runInContext(`(()=>{${shared}\n${fs.readFileSync(new URL('../browser.js', import.meta.url), 'utf8')}})()`, context);
    const api = (context as typeof context & { kelpi: ViewAPI }).kelpi;
    const sent = (type: string): any[] => port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
    const receive = (data: unknown): Promise<void> => Promise.resolve(port.onmessage({ data }));
    const connect = (): void => { events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'terminal' }, ports: [port] }); };
    const reply = (call: any, result: unknown = null, error?: string): Promise<void> => receive({ type: 'reply', id: call.id, result, error });
    const frame = (session: string, sequence: number, frame: TerminalFrame, generation = 1): Promise<void> => receive({ type: 'terminal-frame', session, generation, sequence, frame });
    const action = (session: string, id: string, action: TerminalAction): Promise<void> => receive({ type: 'terminal-action', session, id, action });
    const attach = async (options: Partial<TerminalAttachOptions> = {}) => {
        const attaching = api.terminal.attach({ cols: 80, rows: 24, onFrame() {}, ...options });
        await tick();
        const call = sent('call').at(-1)!;
        expect(call.method).toBe('terminal.attach');
        await reply(call); return attaching;
    };
    const pagehide = (): void => { events.get('pagehide')?.({}); };
    return { api, port, sent, connect, receive, reply, frame, action, attach, pagehide };
}

describe('browser terminal renderer sessions', () => {
    it('waits for the private channel and consumes replay before the attachment reply arrives', async () => {
        const h = harness(), consumed = vi.fn();
        const attaching = h.api.terminal.attach({ cols: 96, rows: 30, onFrame: consumed });
        await tick(); expect(h.sent('call')).toEqual([]);
        h.connect(); await tick();
        const call = h.sent('call')[0];
        expect(call).toMatchObject({ method: 'terminal.attach', args: { session: expect.any(String), cols: 96, rows: 30 } });
        const replay: TerminalFrame = { type: 'replay', data: new Uint8Array([27, 91, 50, 74]) };
        await h.frame(call.args.session, 1, replay);
        expect(consumed).toHaveBeenCalledExactlyOnceWith(replay);
        expect(h.sent('terminal-ack')).toEqual([{ type: 'terminal-ack', session: call.args.session, generation: 1, sequence: 1 }]);
        await h.reply(call);
        const session = await attaching;
        expect(session.id).toBe(call.args.session);
        expect(Object.isFrozen(session)).toBe(true);
        expect(h.api.terminal).toHaveProperty('capture');
        expect(h.api.terminal).toHaveProperty('watch');
        session.dispose();
    });

    it('grants output credit only after async parser consumption and allows an immediate next frame', async () => {
        const h = harness(); h.connect();
        const held = deferred(), consumed: string[] = [];
        let busy = 0, maximumBusy = 0;
        const session = await h.attach({ onFrame: async frame => {
            maximumBusy = Math.max(maximumBusy, ++busy);
            consumed.push(frame.type);
            if (frame.type === 'replay') await held.promise;
            busy--;
        } });
        let nextDelivery: Promise<void> | undefined;
        h.port.postMessage.mockImplementation(message => {
            if (message.type === 'terminal-ack' && message.sequence === 1) nextDelivery = h.frame(session.id, 2, { type: 'output', data: new Uint8Array([10]) });
        });
        const firstDelivery = h.frame(session.id, 1, { type: 'replay', data: new Uint8Array([27]) });
        await tick();
        expect(consumed).toEqual(['replay']); expect(h.sent('terminal-ack')).toEqual([]);
        held.resolve(); await firstDelivery; await nextDelivery;
        expect(consumed).toEqual(['replay', 'output']); expect(maximumBusy).toBe(1);
        expect(h.sent('terminal-ack').map(message => message.sequence)).toEqual([1, 2]);
        session.dispose();
    });

    it('preserves byte boundaries and orders replay, resync, modes, exit and presentation', async () => {
        const h = harness(); h.connect(); const consumed = vi.fn();
        const session = await h.attach({ onFrame: consumed });
        const frames: TerminalFrame[] = [
            { type: 'replay', data: new Uint8Array([27, 91]) },
            { type: 'output', data: new Uint8Array([51, 49, 109, 240, 159]) },
            { type: 'output', data: new Uint8Array([140, 138]) },
            { type: 'resync', reason: 'renderer fell behind' },
            { type: 'replay', data: new Uint8Array([27, 99]) },
            { type: 'modes', modes: { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'drag', mouseFormat: 'sgr', kittyKeyboardFlags: 3 } },
            { type: 'exit', exitCode: null, signal: 'SIGTERM' },
            { type: 'presentation', value: { focused: true, visible: false, theme: { foreground: '#fff' }, fontSize: 14, reveal: null } },
        ];
        for (const [index, frame] of frames.entries()) await h.frame(session.id, index + 1, frame, index < 3 ? 1 : 2);
        await h.frame(session.id, 8, frames[0]!, 2); // Duplicate already consumed.
        await h.frame(session.id, 9, frames[0]!, 1); // Delayed obsolete generation.
        expect(consumed.mock.calls.map(([frame]) => frame)).toEqual(frames);
        expect(h.sent('terminal-ack').map(message => [message.generation, message.sequence])).toEqual([[1, 1], [1, 2], [1, 3], [2, 4], [2, 5], [2, 6], [2, 7], [2, 8]]);
        session.dispose();
    });

    it('allows one active or attaching session and rejects late work after replacement', async () => {
        const h = harness(); h.connect();
        const consumed = vi.fn(), actions = vi.fn();
        const attaching = h.api.terminal.attach({ cols: 80, rows: 24, onFrame: consumed, onAction: actions });
        await expect(h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} })).rejects.toThrow('already has');
        await tick(); await h.reply(h.sent('call')[0]);
        const first = await attaching;
        await expect(h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} })).rejects.toThrow('already has');
        first.dispose(); first.dispose();
        const second = await h.attach();
        expect(second.id).not.toBe(first.id);
        await h.frame(first.id, 1, { type: 'output', data: new Uint8Array([1]) });
        await h.action(first.id, 'old-selection', { type: 'selection' });
        expect(consumed).not.toHaveBeenCalled(); expect(actions).not.toHaveBeenCalled();
        expect(h.sent('terminal-ack')).toEqual([]); expect(h.sent('terminal-action-reply')).toEqual([]);
        expect(h.sent('terminal-detach')).toEqual([{ type: 'terminal-detach', session: first.id }]);
        for (const operation of [() => first.write('x'), () => first.writeDirect('x'), () => first.resize(90, 30), () => first.setCellHeight(16)]) expect(operation).toThrow('disposed');
        second.dispose();
    });

    it('cleans up a failed attachment and permits another attachment', async () => {
        const h = harness(); h.connect();
        const failure = h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} }).catch(error => error);
        await tick(); const call = h.sent('call')[0];
        await h.reply(call, null, 'This view is not a terminal renderer.');
        expect(await failure).toMatchObject({ message: 'This view is not a terminal renderer.' });
        expect(h.sent('terminal-detach')).toEqual([{ type: 'terminal-detach', session: call.args.session }]);
        const next = await h.attach(); next.dispose();
    });

    it('cancels attachment on pagehide before connection and never sends it later', async () => {
        const h = harness();
        const failure = h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} }).catch(error => error);
        h.pagehide(); expect(await failure).toMatchObject({ message: expect.stringContaining('disposed') });
        h.connect(); await tick(); expect(h.sent('call')).toEqual([]);
        await expect(h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} })).rejects.toThrow('view disposal');
    });

    it('cancels an outstanding attachment and removes its RPC timer before a late reply', async () => {
        vi.useFakeTimers();
        try {
            const h = harness(); h.connect();
            const failure = h.api.terminal.attach({ cols: 80, rows: 24, onFrame() {} }).catch(error => error);
            await tick(); const call = h.sent('call')[0];
            expect(vi.getTimerCount()).toBe(1);
            h.pagehide(); expect(await failure).toMatchObject({ message: expect.stringContaining('disposed') });
            expect(vi.getTimerCount()).toBe(0);
            await h.reply(call); await h.frame(call.args.session, 1, { type: 'replay', data: new Uint8Array([1]) });
            expect(h.sent('terminal-detach')).toHaveLength(1); expect(h.sent('terminal-ack')).toEqual([]);
        } finally { vi.useRealTimers(); }
    });

    it('releases never-settling callbacks on disposal and suppresses late actions and acknowledgements', async () => {
        const h = harness(); h.connect();
        const held = deferred(), selected = deferred<string>();
        const frames = vi.fn(() => held.promise), actions = vi.fn(() => selected.promise);
        const session = await h.attach({ onFrame: frames, onAction: actions });
        const delivery = h.frame(session.id, 1, { type: 'replay', data: new Uint8Array([1]) });
        const selection = h.action(session.id, 'selection', { type: 'selection' });
        await tick(); expect(frames).toHaveBeenCalledOnce(); expect(actions).toHaveBeenCalledOnce();
        h.pagehide(); await Promise.all([delivery, selection]);
        held.reject(new Error('Late renderer failure')); selected.resolve('Late selected text'); await tick();
        expect(h.sent('terminal-ack')).toEqual([]); expect(h.sent('terminal-action-reply')).toEqual([]); expect(h.sent('view-error')).toEqual([]);
        expect(h.sent('terminal-detach')).toHaveLength(1);
    });

    it('fails the view without acknowledging bytes when its parser rejects', async () => {
        const h = harness(); h.connect();
        const session = await h.attach({ onFrame: async () => { throw new Error('parser failed'); } });
        await h.frame(session.id, 1, { type: 'output', data: new Uint8Array([1]) }); await tick();
        expect(h.sent('terminal-ack')).toEqual([]);
        expect(h.sent('terminal-detach')).toEqual([{ type: 'terminal-detach', session: session.id }]);
        expect(h.sent('view-error')).toEqual([{ type: 'view-error', message: 'parser failed' }]);
        expect(() => session.write('x')).toThrow('disposed');
    });

    it('rejects an overlapping host frame instead of growing an independent output queue', async () => {
        const h = harness(); h.connect(); const consumed = vi.fn(() => new Promise<void>(() => {}));
        const session = await h.attach({ onFrame: consumed });
        const first = h.frame(session.id, 1, { type: 'replay', data: new Uint8Array([1]) }); await tick();
        await h.frame(session.id, 2, { type: 'resync', reason: 'superseded' }, 2); await first; await tick();
        expect(consumed).toHaveBeenCalledOnce(); expect(h.sent('terminal-ack')).toEqual([]);
        expect(h.sent('view-error')).toEqual([{ type: 'view-error', message: expect.stringContaining('previous frame was consumed') }]);
    });

    it('clones caller bytes, encodes Unicode, and keeps direct input separate', async () => {
        const h = harness(); h.connect(); const session = await h.attach();
        const buffer = new Uint8Array([90, 65, 66, 91]), input = buffer.subarray(1, 3);
        session.write(input); input.fill(0);
        session.write('🌊'); session.writeDirect('\x1b[<0;2;3M');
        const messages = h.sent('terminal-input');
        expect([...messages[0].data]).toEqual([65, 66]); expect(messages[0].direct).toBe(false);
        expect([...messages[1].data]).toEqual([...new TextEncoder().encode('🌊')]); expect(messages[1].direct).toBe(false);
        expect([...messages[2].data]).toEqual([...new TextEncoder().encode('\x1b[<0;2;3M')]); expect(messages[2].direct).toBe(true);
        for (const message of messages) expect(message.session).toBe(session.id);
        session.dispose();
    });

    it('rejects invalid and oversized inputs before posting and enforces the UTF-8 byte limit', async () => {
        const h = harness(); h.connect(); const session = await h.attach();
        for (const value of [null, [1, 2], new Uint16Array([1]), new Uint8ClampedArray([1]), new ArrayBuffer(2), 12]) expect(() => session.write(value as any)).toThrow('string or Uint8Array');
        for (const value of ['x'.repeat(128 * 1024 + 1), '界'.repeat(44 * 1024), new Uint8Array(128 * 1024 + 1)]) expect(() => session.write(value)).toThrow('128 KiB');
        expect(h.sent('terminal-input')).toEqual([]);
        session.write('x'.repeat(128 * 1024)); session.writeDirect(new Uint8Array(128 * 1024));
        expect(h.sent('terminal-input').map(message => message.data.byteLength)).toEqual([128 * 1024, 128 * 1024]);
        session.dispose();
    });

    it('binds parser replies to their active data frame and rejects replies outside consumption', async () => {
        const h = harness(); h.connect(); const held = deferred();
        let session!: Awaited<ReturnType<ViewAPI['terminal']['attach']>>;
        session = await h.attach({ onFrame: async frame => {
            if (frame.type === 'replay' || frame.type === 'output') {
                session.writeDirect('\x1b[0n', { response: true });
                await held.promise;
            } else expect(() => session.writeDirect('\x1b[0n', { response: true })).toThrow('active replay or output callback');
        } });
        expect(() => session.writeDirect('\x1b[0n', { response: true })).toThrow('active replay or output callback');
        for (const options of [null, true, [], { response: 'true' }]) expect(() => session.writeDirect('x', options as any)).toThrow('must be a boolean');
        await h.frame(session.id, 1, { type: 'presentation', value: { focused: false, visible: false } });
        const replay = h.frame(session.id, 2, { type: 'replay', data: new Uint8Array([27, 91, 53, 110]) });
        await tick();
        expect(h.sent('terminal-input')).toEqual([{ type: 'terminal-input', session: session.id, data: new TextEncoder().encode('\x1b[0n'), direct: true, response: true, generation: 1, sequence: 2 }]);
        expect(h.sent('terminal-ack').map(message => message.sequence)).toEqual([1]);
        held.resolve(); await replay;
        expect(() => session.writeDirect('\x1b[0n', { response: true })).toThrow('active replay or output callback');
        await h.frame(session.id, 3, { type: 'output', data: new Uint8Array([27, 91, 53, 110]) }, 2);
        expect(h.sent('terminal-input').at(-1)).toMatchObject({ response: true, generation: 2, sequence: 3 });
        session.dispose();
        expect(() => session.writeDirect('\x1b[0n', { response: true })).toThrow('disposed');
    });

    it('validates required callbacks, immutable initial dimensions, resizes and cell metrics', async () => {
        const h = harness(); h.connect();
        for (const options of [null, { cols: 80, rows: 24 }, { cols: 80, rows: 24, onFrame: 'no' }, { cols: 80, rows: 24, onFrame() {}, onAction: 1 }]) await expect(h.api.terminal.attach(options as any)).rejects.toThrow('callback');
        for (const value of [0, -1, 65536, 1.5, NaN, Infinity, '80']) await expect(h.api.terminal.attach({ cols: value as any, rows: 24, onFrame() {} })).rejects.toThrow('dimensions');
        const options = { cols: 80, rows: 24, onFrame() {} };
        const attaching = h.api.terminal.attach(options); options.cols = 0; options.rows = 0;
        await tick(); const call = h.sent('call')[0]; expect(call.args).toMatchObject({ cols: 80, rows: 24 });
        await h.reply(call); const session = await attaching;
        for (const value of [0, -1, 65536, 1.5, NaN, Infinity]) expect(() => session.resize(80, value)).toThrow('dimensions');
        for (const value of [0, -1, 513, NaN, Infinity]) expect(() => session.setCellHeight(value)).toThrow('cell height');
        expect(h.sent('terminal-resize')).toEqual([]); expect(h.sent('terminal-metrics')).toEqual([]);
        session.resize(65535, 1); session.setCellHeight(16.5);
        expect(h.sent('terminal-resize')).toEqual([{ type: 'terminal-resize', session: session.id, cols: 65535, rows: 1 }]);
        expect(h.sent('terminal-metrics')).toEqual([{ type: 'terminal-metrics', session: session.id, cellHeight: 16.5 }]);
        session.dispose();
    });

    it('returns action results without holding up terminal output and passes key/modifier details', async () => {
        const h = harness(); h.connect(); const selected = deferred<string>();
        const actions = vi.fn((action: TerminalAction) => action.type === 'selection' ? selected.promise : ['dispatchKey', 'paste'].includes(action.type) ? true : null);
        const session = await h.attach({ onAction: actions });
        const selection = h.action(session.id, 'selection', { type: 'selection' }); await tick();
        await h.frame(session.id, 1, { type: 'output', data: new Uint8Array([10]) });
        expect(h.sent('terminal-ack')).toHaveLength(1); expect(h.sent('terminal-action-reply')).toEqual([]);
        selected.resolve('Current selection'); await selection;
        const commands: TerminalAction[] = [
            { type: 'dispatchKey', key: { key: 'Enter', code: 'NumpadEnter', location: 3, type: 'keyup', ctrlKey: true, repeat: false } },
            { type: 'paste', text: 'pasted text' },
            { type: 'focus' }, { type: 'blur' }, { type: 'showKeyboard' }, { type: 'hideKeyboard' },
            { type: 'modifiers', ctrl: true, alt: false },
        ];
        for (const [index, command] of commands.entries()) await h.action(session.id, String(index), command);
        expect(actions.mock.calls.map(([action]) => action)).toEqual([{ type: 'selection' }, ...commands]);
        expect(h.sent('terminal-action-reply').map(message => message.result)).toEqual(['Current selection', true, true, null, null, null, null, null]);
        session.dispose();
    });

    it('returns neutral results for optional action handlers and ignores obsolete sessions', async () => {
        const h = harness(); h.connect(); const session = await h.attach();
        await h.action('wrong-session', 'wrong', { type: 'selection' });
        for (const action of [{ type: 'selection' }, { type: 'paste', text: 'x' }, { type: 'dispatchKey', key: { key: 'x' } }, { type: 'focus' }, { type: 'modifiers', ctrl: false, alt: true }] as TerminalAction[]) await h.action(session.id, action.type, action);
        expect(h.sent('terminal-action-reply').map(message => message.result)).toEqual(['', false, false, null, null]);
        session.dispose();
    });

    it('reports action rejection and invalid results without failing the renderer', async () => {
        const h = harness(); h.connect(); let result: unknown = null;
        const actions = vi.fn(async () => { if (result instanceof Error) throw result; return result; });
        const session = await h.attach({ onAction: actions });
        const attempts: [TerminalAction, unknown, string][] = [
            [{ type: 'selection' }, new Error('selection failed'), 'selection failed'],
            [{ type: 'selection' }, {}, 'must return a string'],
            [{ type: 'selection' }, '界'.repeat(88 * 1024), '256 KiB'],
            [{ type: 'paste', text: 'x' }, undefined, 'must return a boolean'],
            [{ type: 'dispatchKey', key: { key: 'x' } }, 'true', 'must return a boolean'],
            [{ type: 'focus' }, () => {}, 'must return null or undefined'],
            [{ type: 'modifiers', ctrl: true, alt: false }, { ctrl: true }, 'must return null or undefined'],
        ];
        for (const [index, [action, value, error]] of attempts.entries()) {
            result = value; await h.action(session.id, String(index), action);
            expect(h.sent('terminal-action-reply').at(-1)).toMatchObject({ result: null, error: expect.stringContaining(error) });
        }
        result = 'x'.repeat(256 * 1024); await h.action(session.id, 'bounded-selection', { type: 'selection' });
        expect(h.sent('terminal-action-reply').at(-1)).toMatchObject({ result });
        result = undefined; await h.action(session.id, 'side-effect', { type: 'focus' });
        expect(h.sent('terminal-action-reply').at(-1)).toMatchObject({ result: null });
        expect(h.sent('view-error')).toEqual([]); expect(h.sent('terminal-detach')).toEqual([]);
        session.dispose();
    });

    it('bounds outstanding actions and runs duplicate in-flight IDs only once', async () => {
        const h = harness(); h.connect(); const actions = vi.fn(() => new Promise(() => {}));
        const session = await h.attach({ onAction: actions });
        const pending = Array.from({ length: 32 }, (_, index) => h.action(session.id, String(index), { type: 'selection' }));
        await tick(); expect(actions).toHaveBeenCalledTimes(32);
        await h.action(session.id, '0', { type: 'selection' });
        await h.action(session.id, 'overflow', { type: 'selection' });
        expect(actions).toHaveBeenCalledTimes(32);
        expect(h.sent('terminal-action-reply')).toEqual([{ type: 'terminal-action-reply', session: session.id, id: 'overflow', result: null, error: 'Too many pending terminal actions.' }]);
        session.dispose(); await Promise.all(pending);
    });

    it('round-trips the real host bridge, preserving consumption credit and typed action replies across the iframe boundary', async () => {
        const h = harness(); h.connect();
        const held = deferred(), consumed: TerminalFrame[] = [], failed = vi.fn();
        let subscription!: PtySubscription;
        let respondToHiddenQuery: (() => void) | undefined;
        const native = { paneID: 'pane', write: vi.fn(), writeDirect: vi.fn(), resize: vi.fn(), ack: vi.fn(), unacked: 0, unsubscribe: vi.fn() };
        const scope = createTerminalScope({
            paneID: 'pane', presentation: { focused: true, visible: true }, fail: failed,
            pty: { subscribe: (_paneID, value) => {
                subscription = value;
                value.onReplay?.(new Uint8Array([27, 91, 50, 74]));
                return native;
            } },
            send: message => { void h.receive(structuredClone(message)); },
        });
        h.port.postMessage.mockImplementation(message => {
            // Real MessagePorts structured-clone into the receiver's realm. This also checks
            // that bytes, action IDs and null results agree across independently owned code.
            const value = structuredClone(message);
            if (value.type === 'call') {
                try { const result = scope.attach(value.args); void h.reply(value, result); }
                catch (error) { void h.reply(value, null, String(error)); }
            } else scope.receive(value);
        });
        try {
            let firstReplay = true;
            const actions = vi.fn((action: TerminalAction) => action.type === 'selection' ? 'Live selected text' : ['dispatchKey', 'paste'].includes(action.type) ? true : null);
            const session = await h.api.terminal.attach({ cols: 80, rows: 24, onAction: actions, onFrame: async frame => {
                consumed.push(frame);
                if (frame.type === 'replay' && firstReplay) { firstReplay = false; await held.promise; }
                else if (frame.type === 'output') respondToHiddenQuery?.();
            } });
            await tick();
            expect(consumed.map(frame => frame.type)).toEqual(['presentation', 'replay']);
            expect(native.ack).not.toHaveBeenCalled();
            subscription.onResync?.('flow-control-drop');
            subscription.onReplay?.(new Uint8Array([27, 99, 65]));
            subscription.onData(new Uint8Array([66]));
            await tick(); expect(consumed).toHaveLength(2);
            held.resolve();
            await vi.waitFor(() => expect(native.ack.mock.calls.map(([bytes]) => bytes)).toEqual([3, 1]));
            expect(consumed.map(frame => frame.type)).toEqual(['presentation', 'replay', 'presentation', 'resync', 'replay', 'output']);
            expect(await scope.action({ type: 'selection' })).toBe('Live selected text');
            expect(await scope.action({ type: 'dispatchKey', key: { key: 'Enter' } })).toBe(true);
            expect(await scope.action({ type: 'modifiers', ctrl: true, alt: false })).toBe(null);
            const bytes = new Uint8Array([65, 66]); session.write(bytes); bytes.fill(0);
            session.writeDirect('\x1b[0n'); session.resize(100, 30); session.setCellHeight(17.5);
            expect([...native.write.mock.calls[0]![0]]).toEqual([65, 66]);
            expect([...native.writeDirect.mock.calls[0]![0]]).toEqual([...new TextEncoder().encode('\x1b[0n')]);
            expect(native.resize).toHaveBeenCalledWith(100, 30); expect(scope.cellHeight).toBe(17.5);
            scope.update({ focused: false, visible: false });
            session.write('hidden'); session.resize(140, 40);
            expect(native.write).toHaveBeenCalledOnce(); expect(native.resize).toHaveBeenCalledOnce();
            respondToHiddenQuery = () => {
                session.write('hidden keyboard');
                session.writeDirect('\x1b[<0;1;1M');
                session.writeDirect('\x1b[2;3R', { response: true });
            };
            subscription.onData(new Uint8Array([27, 91, 54, 110]));
            await vi.waitFor(() => expect(native.ack.mock.calls.map(([bytes]) => bytes)).toEqual([3, 1, 4]));
            expect(native.write).toHaveBeenCalledOnce();
            expect(native.writeDirect.mock.calls.map(([data]) => new TextDecoder().decode(data))).toEqual(['\x1b[0n', '\x1b[2;3R']);
            expect(() => session.writeDirect('\x1b[2;3R', { response: true })).toThrow('active replay or output callback');
            session.dispose();
            expect(scope.attached).toBe(false); expect(native.unsubscribe).toHaveBeenCalledOnce(); expect(failed).not.toHaveBeenCalled();
        } finally { scope.dispose(); h.pagehide(); held.resolve(); }
    });

    it.each([
        { generation: 0, sequence: 1, frame: { type: 'resync', reason: 'x' } },
        { generation: 1, sequence: Infinity, frame: { type: 'resync', reason: 'x' } },
        { generation: 1, sequence: 1, frame: { type: 'output', data: [1] } },
        { generation: 1, sequence: 1, frame: { type: 'unknown' } },
    ])('rejects malformed terminal frames without invoking the renderer: %j', async envelope => {
        const h = harness(); h.connect(); const consumed = vi.fn();
        const session = await h.attach({ onFrame: consumed });
        await h.receive({ type: 'terminal-frame', session: session.id, ...envelope }); await tick();
        expect(consumed).not.toHaveBeenCalled(); expect(h.sent('terminal-ack')).toEqual([]);
        expect(h.sent('view-error')).toHaveLength(1); expect(h.sent('terminal-detach')).toHaveLength(1);
    });
});
