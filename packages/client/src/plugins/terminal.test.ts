import { PTY_FRAME_TYPES, decodeAckPayload, decodePtyFrame, encodePtyFrame, encodeResizePayload, type PtyFrameType } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyClient } from '../connection/pty';
import { KelpiConnection } from '../connection/socket';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import type { TerminalPaneProps } from '../terminal/TerminalPane';
import { createTerminalScope, TERMINAL_SCOPE_LIMITS, type TerminalHostMessage, type TerminalPresentation } from './terminal';
import { terminalPresentation } from './terminal-pane';

const PANE = '11111111-2222-4333-8444-555555555555';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const disposals: (() => void)[] = [];
type FrameMessage = Extract<TerminalHostMessage, { type: 'terminal-frame' }>;
const tick = async (): Promise<void> => { await Promise.resolve(); };

function harness(presentation: Partial<TerminalPresentation> = {}) {
    // #166 defaults: a visible renderer whose window sizes the PTY, which is what a
    // single-window session reports forever. Tests name only what they change.
    let view: TerminalPresentation = { focused: true, visible: true, ownsSize: true, ...presentation };
    const sockets = createFakeSocketFactory();
    const connection = new KelpiConnection({
        url: 'ws://daemon.test/ws', token: 'test', socketFactory: sockets.factory,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }, heartbeatIntervalMs: 0,
    });
    const pty = new PtyClient(connection, { ackThresholdBytes: 1 });
    connection.connect(); completeHandshake(sockets.last());
    const messages: TerminalHostMessage[] = [];
    const fail = vi.fn();
    const onResize = vi.fn();
    const scope = createTerminalScope({
        paneID: PANE, pty, presentation: view, send: message => messages.push(message), fail, onResize,
        frameTimeoutMs: 1000, actionTimeoutMs: 500,
    });
    disposals.push(() => { scope.dispose(); pty.dispose(); connection.close(); });
    const frames = (): FrameMessage[] => messages.filter((message): message is FrameMessage => message.type === 'terminal-frame');
    const lastFrame = (): FrameMessage => frames().at(-1)!;
    const wireFrames = () => sockets.last().frames.map(frame => decodePtyFrame(frame));
    const ack = (frame = lastFrame()): void => { scope.receive({ type: 'terminal-ack', session: frame.session, generation: frame.generation, sequence: frame.sequence }); };
    return {
        scope, pty, connection, sockets, messages, fail, frames, lastFrame, onResize, ack, wireFrames,
        attach(session = 'renderer-1') { return scope.attach({ session, cols: 120, rows: 40 }); },
        /** Change part of the presentation, as assembly does when one prop moves. */
        present(changes: Partial<TerminalPresentation>) { view = { ...view, ...changes }; scope.update(view); },
        resizes() { return sockets.last().messages().filter(message => message['type'] === 'resize-pane'); },
        json(type: string) { return sockets.last().messages().filter(message => message['type'] === type); },
        /** The daemon's `replayGrid` frame: the grid the replay BEHIND it was serialised at. */
        grid(cols: number, rows: number) {
            sockets.last().emitBinary(encodePtyFrame(PTY_FRAME_TYPES.replayGrid, PANE, encodeResizePayload(cols, rows))!);
        },
        output(type: PtyFrameType, data: string | Uint8Array) {
            sockets.last().emitBinary(encodePtyFrame(type, PANE, typeof data === 'string' ? encoder.encode(data) : data)!);
        },
        credits(): number[] { return wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.ack).map(frame => decodeAckPayload(frame!.payload)!); },
        async drain(consume?: (frame: FrameMessage['frame']) => void | Promise<void>) {
            await tick();
            let last = -1;
            while (frames().length > last && frames().length) {
                last = frames().length;
                if (consume) await consume(lastFrame().frame);
                ack(); await tick();
            }
        },
    };
}

/** A real parser makes missing queries and missing pre-query cursor state observable. */
async function parserConsumer(h: ReturnType<typeof harness>) {
    // Only the parser runs here; xterm's module probes canvas support on import.
    const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const { Terminal } = await import('@xterm/xterm').finally(() => canvas.mockRestore());
    const parser = new Terminal({ cols: 120, rows: 40 });
    disposals.push(() => parser.dispose());
    parser.onData(data => {
        const frame = h.lastFrame();
        h.scope.receive({ type: 'terminal-input', session: frame.session, generation: frame.generation,
            sequence: frame.sequence, response: true, direct: true, data: encoder.encode(data) });
    });
    return async (frame: FrameMessage['frame']): Promise<void> => {
        if (frame.type === 'replay') parser.reset();
        if (frame.type === 'replay' || frame.type === 'output') await new Promise<void>(resolve => parser.write(frame.data, resolve));
    };
}

describe('selected terminal renderer transport', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });

    it('delivers replay and live bytes in order, granting native credit only after consumption', async () => {
        const h = harness();
        expect(h.attach()).toEqual({ session: 'renderer-1', paneID: PANE });
        expect(h.messages).toEqual([]);
        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE, cols: 120, rows: 40 }]);
        h.output(PTY_FRAME_TYPES.replay, 'screen');
        h.output(PTY_FRAME_TYPES.output, '\x1b[31m尾\x1b[0m');
        await tick();
        expect(h.lastFrame().frame.type).toBe('presentation');
        h.ack(); await tick();
        expect(h.lastFrame().frame.type).toBe('replay');
        expect(decoder.decode((h.lastFrame().frame as { data: Uint8Array }).data)).toBe('screen');
        expect(h.credits()).toEqual([]);
        const replay = h.lastFrame();
        await tick();
        expect(h.lastFrame()).toBe(replay);
        h.ack(); await tick();
        expect(h.credits()).toEqual([6]);
        expect(h.lastFrame().frame.type).toBe('output');
        expect(decoder.decode((h.lastFrame().frame as { data: Uint8Array }).data)).toBe('\x1b[31m尾\x1b[0m');
        h.ack(); await tick();
        expect(h.credits()).toEqual([6, encoder.encode('\x1b[31m尾\x1b[0m').byteLength]);
        expect(h.pty.stats(PANE)?.unacked).toBe(0);
    });

    it('drains obsolete live callbacks without giving their acks credit against a newer replay', async () => {
        const h = harness(); h.attach();
        h.output(PTY_FRAME_TYPES.replay, 'old');
        await tick(); h.ack(); await tick();
        const old = h.lastFrame();
        h.output(PTY_FRAME_TYPES.output, 'superseded tail');
        h.sockets.last().emit({ type: 'pty-resync', paneID: PANE, reason: 'flow-control-drop' });
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        await tick();
        expect(h.lastFrame()).toBe(old);
        h.ack(old); await tick();
        expect(h.credits()).toEqual([]);
        expect(h.lastFrame().generation).toBe(old.generation);
        const pending = h.lastFrame().frame;
        expect(pending.type).toBe('output');
        expect(decoder.decode((pending as { data: Uint8Array }).data)).toBe('superseded tail');
        h.ack(old); // A duplicate cannot consume the new frame.
        await h.drain();
        expect(h.credits()).toEqual([5]);
        expect(h.frames().filter(message => message.frame.type === 'output')).toHaveLength(1);
        expect(h.frames().some(message => message.frame.type === 'resync')).toBe(true);
    });

    it('reconnects through the owning window and supersedes outstanding renderer credit', async () => {
        const h = harness(); h.attach();
        h.output(PTY_FRAME_TYPES.replay, 'old');
        await tick(); h.ack(); await tick();
        const old = h.lastFrame();
        h.sockets.last().serverClose(); vi.advanceTimersByTime(10); completeHandshake(h.sockets.last());
        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE, cols: 120, rows: 40 }]);
        h.output(PTY_FRAME_TYPES.replay, 'new screen');
        h.ack(old); await h.drain();
        expect(h.credits()).toEqual([10]);
    });

    it('routes mirrored input, direct protocol replies and geometry over the existing connection', () => {
        const h = harness(); h.attach();
        h.scope.receive({ type: 'terminal-input', session: 'renderer-1', data: encoder.encode('keys'), direct: false });
        h.scope.receive({ type: 'terminal-input', session: 'renderer-1', data: encoder.encode('\x1b[<0;3;4M'), direct: true });
        h.scope.write('\x15');
        h.scope.receive({ type: 'terminal-resize', session: 'renderer-1', cols: 100, rows: 30 });
        expect(h.wireFrames().map(frame => [frame?.type, decoder.decode(frame?.payload)])).toEqual([
            [PTY_FRAME_TYPES.input, 'keys'], [PTY_FRAME_TYPES.inputDirect, '\x1b[<0;3;4M'], [PTY_FRAME_TYPES.input, '\x15'],
        ]);
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 100, rows: 30 }]);
        expect(h.onResize).toHaveBeenLastCalledWith(100, 30);
    });

    it('keeps hidden attach, input, resize and reconnect from reporting a PTY grid', async () => {
        const h = harness({ focused: false, visible: false }); h.attach();
        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE }]);
        h.scope.receive({ type: 'terminal-input', session: 'renderer-1', data: encoder.encode('hidden'), direct: false });
        h.scope.receive({ type: 'terminal-resize', session: 'renderer-1', cols: 1, rows: 1 });
        h.scope.write('hidden');
        expect(h.wireFrames()).toEqual([]);
        expect(h.json('resize-pane')).toEqual([]);
        h.sockets.last().serverClose(); vi.advanceTimersByTime(10); completeHandshake(h.sockets.last());
        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE }]);
        h.present({ focused: true, visible: true });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40 }]);
        await h.drain();
        const count = h.messages.length;
        h.present({ focused: true, visible: true }); await tick();
        expect(h.messages).toHaveLength(count);
    });

    it('allows hidden device replies only for the current data frame while blocking keyboard and mouse input', async () => {
        const h = harness({ focused: false, visible: false }); h.attach();
        h.output(PTY_FRAME_TYPES.replay, 'screen');
        await tick();
        const reply = (frame: FrameMessage, text = '\x1b[0n', changes: Record<string, unknown> = {}): void => {
            h.scope.receive({ type: 'terminal-input', session: frame.session, data: encoder.encode(text), direct: true, response: true, generation: frame.generation, sequence: frame.sequence, ...changes });
        };
        reply(h.lastFrame()); // Presentation frames cannot create device replies.
        expect(h.wireFrames()).toEqual([]);
        h.ack(); await tick();
        const replay = h.lastFrame(); expect(replay.frame.type).toBe('replay');
        h.scope.receive({ type: 'terminal-input', session: replay.session, data: encoder.encode('hidden key'), direct: false });
        h.scope.receive({ type: 'terminal-input', session: replay.session, data: encoder.encode('\x1b[<0;1;1M'), direct: true });
        reply(replay, 'forged', { sequence: replay.sequence + 1 });
        reply(replay, 'forged', { generation: replay.generation + 1 });
        reply(replay, 'forged', { direct: false });
        expect(h.wireFrames()).toEqual([]);
        reply(replay);
        expect(h.wireFrames().map(frame => [frame?.type, decoder.decode(frame?.payload)])).toEqual([[PTY_FRAME_TYPES.inputDirect, '\x1b[0n']]);
        expect(h.credits()).toEqual([]);
        h.ack(); await tick();
        reply(replay, 'after callback');
        expect(h.credits()).toEqual([6]);
        h.output(PTY_FRAME_TYPES.output, '\x1b[6n'); await tick();
        const output = h.lastFrame(); expect(output.frame.type).toBe('output');
        reply(output, '\x1b[2;3R');
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect).map(frame => decoder.decode(frame!.payload))).toEqual(['\x1b[0n', '\x1b[2;3R']);
        expect(h.credits()).toEqual([6]);
        h.sockets.last().emit({ type: 'pty-resync', paneID: PANE, reason: 'flow-control-drop' });
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        reply(replay, 'completed callback');
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect)).toHaveLength(2);
        h.ack(output); await h.drain();
        expect(h.credits()).toEqual([6, 5]);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it.each([true, false])('answers a waiting program from its exact in-flight output callback after visual supersession (visible=%s)', async visible => {
        const h = harness({ focused: visible, visible }); h.attach();
        h.output(PTY_FRAME_TYPES.replay, 'screen'); await h.drain();
        // The application now waits for a cursor-position reply. The renderer's async
        // parser has this output, but has not yet consumed the query or acknowledged it.
        h.output(PTY_FRAME_TYPES.output, '\x1b[6n'); await tick();
        const query = h.lastFrame(); expect(query.frame.type).toBe('output');
        const response = { type: 'terminal-input', session: query.session, generation: query.generation,
            sequence: query.sequence, response: true, direct: true, data: encoder.encode('\x1b[2;3R') };
        let consume!: () => void;
        const callback = new Promise<void>(resolve => { consume = resolve; }).then(() => {
            h.scope.receive(response); h.ack(query);
        });
        // A resize snapshots terminal state while the renderer is still parsing. The
        // snapshot does not include DA/DSR requests, so dropping this reply would hang it.
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        h.scope.receive({ ...response, session: 'another-renderer' });
        h.scope.receive({ ...response, sequence: query.sequence + 1 });
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect)).toEqual([]);
        consume(); await callback;
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect).map(frame => decoder.decode(frame!.payload))).toEqual(['\x1b[2;3R']);
        expect(h.credits()).toEqual([6]); // Old output credit cannot consume the new replay.
        h.scope.receive(response); // Completed callback cannot answer again.
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect)).toHaveLength(1);
        await h.drain(); expect(h.credits()).toEqual([6, 5]);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it.each([true, false])('answers a queued device query before applying a newer replay (visible=%s)', async visible => {
        vi.useRealTimers();
        const h = harness({ focused: visible, visible }), consume = await parserConsumer(h);
        h.attach(); h.output(PTY_FRAME_TYPES.replay, 'screen'); await h.drain(consume);
        h.output(PTY_FRAME_TYPES.output, 'text'); await tick();
        const held = h.lastFrame(); expect(held.frame.type).toBe('output');
        // The ordinary output callback is in flight, so the query waits in the host queue.
        // Its DSR reply must describe the screen before the replacement, not an empty or
        // newer screen, and consuming these superseded bytes must not credit that replay.
        h.output(PTY_FRAME_TYPES.output, '\x1b[6n');
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        await h.drain(consume);
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect).map(frame => decoder.decode(frame!.payload))).toEqual(['\x1b[1;11R']);
        expect(h.credits()).toEqual([6, 5]);
        expect(h.pty.stats(PANE)?.unacked).toBe(0);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('preserves split queued queries through repeated resyncs while coalescing unused snapshots', async () => {
        vi.useRealTimers();
        const h = harness(), consume = await parserConsumer(h);
        h.attach(); h.output(PTY_FRAME_TYPES.replay, 'screen'); await h.drain(consume);
        h.output(PTY_FRAME_TYPES.output, 'text'); await tick();
        for (const part of ['\x1b[', '6', 'n']) h.output(PTY_FRAME_TYPES.output, part);
        for (const replay of ['obsolete snapshot', 'fresh']) {
            h.sockets.last().emit({ type: 'pty-resync', paneID: PANE, reason: 'flow-control-drop' });
            h.output(PTY_FRAME_TYPES.replay, replay);
        }
        await h.drain(consume);
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect).map(frame => decoder.decode(frame!.payload))).toEqual(['\x1b[1;11R']);
        expect(h.frames().filter(message => message.frame.type === 'replay').map(message => decoder.decode((message.frame as { data: Uint8Array }).data))).toEqual(['screen', 'fresh']);
        expect(h.credits()).toEqual([6, 5]);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('retains queued replay and mode checkpoints needed to answer live queries across generations', async () => {
        vi.useRealTimers();
        const h = harness(), consume = await parserConsumer(h);
        h.attach();
        const modes = { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'drag', mouseFormat: 'sgr', kittyKeyboardFlags: 7 };
        for (const replay of ['\x1b[3;5H', '\x1b[7;9H']) {
            h.output(PTY_FRAME_TYPES.replay, replay);
            h.sockets.last().emit({ type: 'pane-modes', paneID: PANE, modes });
            h.output(PTY_FRAME_TYPES.output, '\x1b[6n');
        }
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        await h.drain(async frame => {
            if (frame.type === 'replay' && decoder.decode(frame.data) !== 'fresh') {
                const delivery = h.lastFrame();
                h.scope.receive({ type: 'terminal-input', session: delivery.session, generation: delivery.generation,
                    sequence: delivery.sequence, response: true, direct: true, data: encoder.encode('obsolete replay reply') });
            }
            await consume(frame);
        });
        expect(h.wireFrames().filter(frame => frame?.type === PTY_FRAME_TYPES.inputDirect).map(frame => decoder.decode(frame!.payload))).toEqual(['\x1b[3;5R', '\x1b[7;9R']);
        const delivered = h.frames().map(message => message.frame);
        expect(delivered[0]?.type).toBe('presentation');
        for (const [index, frame] of delivered.entries()) if (frame.type === 'output') expect(delivered[index - 1]).toEqual({ type: 'modes', modes });
        expect(h.credits()).toEqual([5]);
        expect(h.pty.stats(PANE)?.unacked).toBe(0);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('rejects replies from a superseded replay callback while preserving its completion barrier', async () => {
        const h = harness({ focused: false, visible: false }); h.attach();
        h.output(PTY_FRAME_TYPES.replay, 'obsolete'); await tick(); h.ack(); await tick();
        const replay = h.lastFrame(); expect(replay.frame.type).toBe('replay');
        h.output(PTY_FRAME_TYPES.replay, 'fresh');
        h.scope.receive({ type: 'terminal-input', session: replay.session, generation: replay.generation,
            sequence: replay.sequence, response: true, direct: true, data: encoder.encode('\x1b[2;3R') });
        expect(h.wireFrames()).toEqual([]);
        expect(h.lastFrame()).toBe(replay);
        h.ack(replay); await h.drain();
        expect(h.credits()).toEqual([5]);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('rejects attachment confusion and ignores stale sessions after replacement', async () => {
        const h = harness();
        expect(() => h.scope.attach({ session: 'bad', cols: 0, rows: 24 })).toThrow('Invalid');
        h.attach(); expect(h.scope.attached).toBe(true);
        expect(() => h.attach('second')).toThrow('already attached');
        h.scope.receive({ type: 'terminal-detach', session: 'other' });
        expect(h.scope.attached).toBe(true);
        h.scope.receive({ type: 'terminal-detach', session: 'renderer-1' });
        expect(h.scope.attached).toBe(false);
        expect(() => h.attach()).toThrow('Invalid');
        h.attach('second');
        h.scope.receive({ type: 'terminal-input', session: 'renderer-1', data: encoder.encode('stale'), direct: false });
        h.scope.receive({ type: 'terminal-resize', session: 'renderer-1', cols: 10, rows: 5 });
        h.scope.receive({ type: 'terminal-detach', session: 'renderer-1' });
        expect(h.scope.attached).toBe(true);
        expect(h.wireFrames()).toEqual([]);
        expect(h.json('resize-pane')).toEqual([]);
        await h.drain();
    });

    it('ignores forged acknowledgements and falls back when consumption stalls', async () => {
        const h = harness(); h.attach(); await tick();
        const frame = h.lastFrame();
        h.scope.receive({ type: 'terminal-ack', session: frame.session, generation: frame.generation, sequence: frame.sequence + 1 });
        vi.advanceTimersByTime(999); expect(h.fail).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(h.fail).toHaveBeenCalledOnce();
        expect(h.scope.attached).toBe(false);
        expect(h.json('detach-pane')).toHaveLength(1);
        h.ack(frame); h.scope.dispose(); vi.advanceTimersByTime(5000);
        expect(h.fail).toHaveBeenCalledOnce();
    });

    it.each([
        { type: 'terminal-input', data: 'not bytes', direct: false },
        { type: 'terminal-input', data: new Uint8Array(TERMINAL_SCOPE_LIMITS.inputBytes + 1), direct: false },
        { type: 'terminal-resize', cols: NaN, rows: 30 },
        { type: 'terminal-resize', cols: 65536, rows: 30 },
        { type: 'terminal-metrics', cellHeight: Infinity },
    ])('fails malformed active renderer messages without writing them: $type', message => {
        const h = harness(); h.attach();
        h.scope.receive({ ...message, session: 'renderer-1' });
        expect(h.fail).toHaveBeenCalledOnce();
        expect(h.scope.attached).toBe(false);
        expect(h.wireFrames()).toEqual([]);
        expect(h.json('resize-pane')).toEqual([]);
    });

    it('fails an oversized snapshot and an excessive live backlog as whole streams', () => {
        const replay = harness(); replay.attach();
        replay.output(PTY_FRAME_TYPES.replay, new Uint8Array(TERMINAL_SCOPE_LIMITS.replayBytes + 1));
        expect(replay.fail).toHaveBeenCalledOnce();
        expect(replay.credits()).toEqual([]);
        const live = harness(); live.attach();
        live.output(PTY_FRAME_TYPES.replay, 'screen');
        live.output(PTY_FRAME_TYPES.output, new Uint8Array(TERMINAL_SCOPE_LIMITS.liveBytes + 1));
        expect(live.fail).toHaveBeenCalledOnce();
        expect(live.credits()).toEqual([]);
    });

    it('bounds tiny output frames as well as bytes', () => {
        const h = harness(); h.attach(); h.output(PTY_FRAME_TYPES.replay, 'screen');
        for (let index = 0; index < TERMINAL_SCOPE_LIMITS.frames; index += 1) h.output(PTY_FRAME_TYPES.output, 'x');
        expect(h.fail).toHaveBeenCalledOnce();
        expect(h.scope.attached).toBe(false);
    });

    it('bounds replay checkpoints retained behind a stalled callback', async () => {
        const h = harness(); h.attach(); await tick();
        const held = h.lastFrame();
        const replay = new Uint8Array(TERMINAL_SCOPE_LIMITS.replayBytes);
        for (let index = 0; index < 2; index++) {
            h.output(PTY_FRAME_TYPES.replay, replay);
            h.output(PTY_FRAME_TYPES.output, '\x1b[6n');
        }
        expect(h.fail).not.toHaveBeenCalled();
        expect(h.lastFrame()).toBe(held);
        h.output(PTY_FRAME_TYPES.replay, new Uint8Array(1));
        expect(h.fail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Terminal renderer replay backlog exceeded its limit.' }));
        expect(h.scope.attached).toBe(false);
        expect(h.credits()).toEqual([]);
    });

    it('restores the latest modes after replay even when supersession discards their queued update', async () => {
        const h = harness(); h.attach(); h.output(PTY_FRAME_TYPES.replay, 'old screen');
        await h.drain();
        h.output(PTY_FRAME_TYPES.output, 'held output');
        await tick();
        const held = h.lastFrame();
        const modes = { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'drag', mouseFormat: 'sgr', kittyKeyboardFlags: 7 };
        h.sockets.last().emit({ type: 'pane-modes', paneID: PANE, modes });
        h.sockets.last().emit({ type: 'pty-resync', paneID: PANE, reason: 'flow-control-drop' });
        h.output(PTY_FRAME_TYPES.replay, 'new screen');
        h.ack(held);
        await h.drain();
        expect(h.frames().slice(-2).map(({ frame }) => frame.type === 'replay' ? { ...frame, data: decoder.decode(frame.data) } : frame)).toEqual([
            { type: 'replay', data: 'new screen', grid: null }, { type: 'modes', modes }
        ]);
        expect(h.credits()).toEqual([10, 10]);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('forwards current modes and exit without turning an exit into a process operation', async () => {
        const h = harness(); h.attach(); h.output(PTY_FRAME_TYPES.replay, 'screen');
        const modes = { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'drag', mouseFormat: 'sgr', kittyKeyboardFlags: 7 };
        h.sockets.last().emit({ type: 'pane-modes', paneID: PANE, modes });
        h.sockets.last().emit({ type: 'pane-exit', paneID: PANE, exitCode: 0 });
        await h.drain();
        expect(h.frames().map(message => message.frame)).toContainEqual({ type: 'modes', modes });
        expect(h.frames().map(message => message.frame)).toContainEqual({ type: 'exit', exitCode: 0 });
        expect(h.json('command')).toEqual([]);
    });

    it('uses live selection replies and validates typed action results and metrics', async () => {
        const h = harness(); h.attach();
        h.scope.receive({ type: 'terminal-metrics', session: 'renderer-1', cellHeight: 19.5 });
        expect(h.scope.cellHeight).toBe(19.5);
        const first = h.scope.action({ type: 'selection' });
        const request = h.messages.at(-1)!;
        expect(request.type).toBe('terminal-action');
        h.scope.receive({ type: 'terminal-action-reply', session: 'wrong', id: '1', result: 'stale' });
        h.scope.receive({ type: 'terminal-action-reply', session: 'renderer-1', id: '1', result: 'selected now' });
        await expect(first).resolves.toBe('selected now');
        const second = h.scope.action({ type: 'selection' });
        h.scope.receive({ type: 'terminal-action-reply', session: 'renderer-1', id: '2', result: '' });
        await expect(second).resolves.toBe('');
        const key = h.scope.action({ type: 'dispatchKey', key: { key: 'ArrowLeft' } });
        h.scope.receive({ type: 'terminal-action-reply', session: 'renderer-1', id: '3', result: 'wrong type' });
        await expect(key).rejects.toThrow('Invalid terminal action result');
        const modifier = h.scope.action({ type: 'modifiers', ctrl: true, alt: false });
        h.scope.receive({ type: 'terminal-action-reply', session: 'renderer-1', id: '4', result: null });
        await expect(modifier).resolves.toBeNull();
    });

    it('bounds selection size, pending actions and their lifetime', async () => {
        const h = harness(); h.attach();
        const selection = h.scope.action({ type: 'selection' });
        h.scope.receive({ type: 'terminal-action-reply', session: 'renderer-1', id: '1', result: '界'.repeat(TERMINAL_SCOPE_LIMITS.selectionBytes / 3 + 1) });
        await expect(selection).rejects.toThrow('Invalid');
        const pending = Array.from({ length: TERMINAL_SCOPE_LIMITS.actions }, () => h.scope.action({ type: 'selection' }).catch(error => error as Error));
        await expect(h.scope.action({ type: 'selection' })).rejects.toThrow('Too many');
        vi.advanceTimersByTime(500);
        expect((await Promise.all(pending)).every(value => value instanceof Error && value.message.includes('timed out'))).toBe(true);
        const disposed = h.scope.action({ type: 'selection' });
        h.scope.dispose();
        await expect(disposed).rejects.toThrow('ended');
        expect(h.scope.cellHeight).toBe(16);
        expect(h.scope.receive({ type: 'unrelated' })).toBe(false);
    });

    it('disposes before deferred delivery and cannot affect a replacement renderer', async () => {
        const h = harness(); h.attach(); h.output(PTY_FRAME_TYPES.replay, 'screen');
        h.scope.dispose();
        const native = h.pty.subscribe(PANE, { onData: () => {} });
        h.scope.write('late');
        h.scope.receive({ type: 'terminal-resize', session: 'renderer-1', cols: 1, rows: 1 });
        await tick();
        expect(h.messages).toEqual([]);
        expect(h.json('detach-pane')).toHaveLength(1);
        expect(h.json('resize-pane')).toEqual([]);
        expect(h.fail).not.toHaveBeenCalled();
        native.unsubscribe();
    });
    it('states the daemon grid on the replay frame it belongs to, at no extra credit', async () => {
        const h = harness(); h.attach();
        h.grid(40, 12);
        h.output(PTY_FRAME_TYPES.replay, 'screen');
        await tick(); h.ack(); await tick();
        expect(h.lastFrame().frame).toEqual({ type: 'replay', data: expect.any(Uint8Array), grid: { cols: 40, rows: 12 } });
        expect(decoder.decode((h.lastFrame().frame as { data: Uint8Array }).data)).toBe('screen');
        expect(h.credits()).toEqual([]);
        h.ack(); await tick();
        // The grid rode that one delivery: its acknowledgement credits the bytes and nothing else.
        expect(h.credits()).toEqual([6]);
        // A daemon that states no grid says "keep the grid you are at", not 80x24.
        h.output(PTY_FRAME_TYPES.replay, 'older daemon');
        await tick(); h.ack(); await tick();
        expect(h.lastFrame().frame).toEqual({ type: 'replay', data: expect.any(Uint8Array), grid: null });
        h.ack(); await tick();
        expect(h.credits()).toEqual([6, 12]);
        expect(h.pty.stats(PANE)?.unacked).toBe(0);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('forces one PTY report when a visible view takes size control', async () => {
        const h = harness({ ownsSize: false }); h.attach();
        h.grid(40, 12); h.output(PTY_FRAME_TYPES.replay, 'owner screen'); await h.drain();
        expect(h.json('resize-pane')).toEqual([]);
        h.present({ ownsSize: true });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40, force: true }]);
        // Neither later presentation churn nor a later replay is another claim.
        h.present({ focused: false });
        h.output(PTY_FRAME_TYPES.replay, 'own screen'); await h.drain();
        expect(h.json('resize-pane')).toHaveLength(1);
        expect(h.frames().at(-1)?.frame).toMatchObject({ type: 'replay', grid: null });
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('holds a claim taken while hidden until the first reveal carries it', async () => {
        const h = harness({ focused: false, visible: false, ownsSize: false }); h.attach();
        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE }]);
        h.present({ ownsSize: true });
        expect(h.json('resize-pane')).toEqual([]);
        h.present({ focused: true, visible: true });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40, force: true }]);
        // The claim is spent: an ordinary hide/reveal cycle repeats nothing.
        h.present({ visible: false }); h.present({ visible: true });
        expect(h.json('resize-pane')).toHaveLength(1);
        await h.drain();
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('asks for one re-seed only when a replay landed at a grid this renderer is not at', async () => {
        const stale = harness(); stale.attach();
        stale.grid(40, 12); stale.output(PTY_FRAME_TYPES.replay, 'early'); await stale.drain();
        stale.present({ ownsSize: false });
        expect(stale.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40, force: true }]);
        stale.present({ focused: false });
        expect(stale.json('resize-pane')).toHaveLength(1);

        const matching = harness(); matching.attach();
        matching.grid(120, 40); matching.output(PTY_FRAME_TYPES.replay, 'own'); await matching.drain();
        matching.present({ ownsSize: false });
        expect(matching.json('resize-pane')).toEqual([]);

        const silent = harness(); silent.attach();
        silent.output(PTY_FRAME_TYPES.replay, 'own'); await silent.drain();
        silent.present({ ownsSize: false });
        expect(silent.json('resize-pane')).toEqual([]);
        for (const h of [stale, matching, silent]) expect(h.fail).not.toHaveBeenCalled();
    });

    it('keeps a hidden view from reporting geometry through either hand-off', async () => {
        const h = harness({ focused: false, visible: false }); h.attach();
        h.grid(40, 12); h.output(PTY_FRAME_TYPES.replay, 'owner screen'); await h.drain();
        for (const ownsSize of [false, true, false]) { h.present({ ownsSize }); await h.drain(); }
        expect(h.json('resize-pane')).toEqual([]);
        // Every hand-off still reaches the renderer; only the PTY report is withheld.
        expect(h.frames().filter(message => message.frame.type === 'presentation')
            .map(message => (message.frame as { value: { ownsSize: boolean } }).value.ownsSize).slice(-3)).toEqual([false, true, false]);
        // Revealed as a non-owner: the measurement is still reported, without the spent claim.
        h.present({ focused: true, visible: true });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40 }]);
        await h.drain();
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('spends one forced report when size control and a reveal arrive in the same update', async () => {
        const h = harness({ focused: false, visible: false, ownsSize: false }); h.attach();
        h.grid(40, 12); h.output(PTY_FRAME_TYPES.replay, 'owner screen'); await h.drain();
        h.present({ focused: true, visible: true, ownsSize: true });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40, force: true }]);
        h.present({ visible: false }); h.present({ visible: true });
        expect(h.json('resize-pane')).toHaveLength(1);
        await h.drain();
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('keeps the last stated grid across an unstated replay and forgets it with the attachment', async () => {
        const h = harness(); h.attach();
        h.grid(40, 12); h.output(PTY_FRAME_TYPES.replay, 'stated'); await h.drain();
        // A daemon that states nothing does not erase what the last snapshot was serialised at.
        h.output(PTY_FRAME_TYPES.replay, 'unstated'); await h.drain();
        h.present({ ownsSize: false });
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 120, rows: 40, force: true }]);
        // Detach clears both the stated grid and any pending claim: a new attachment starts clean.
        h.present({ ownsSize: true, visible: false });
        h.scope.receive({ type: 'terminal-detach', session: 'renderer-1' });
        h.scope.attach({ session: 'renderer-2', cols: 120, rows: 40 });
        h.present({ visible: true });
        expect(h.json('resize-pane').at(-1)).not.toHaveProperty('force');
        h.present({ ownsSize: false });
        expect(h.json('resize-pane').filter(message => message['force'] === true)).toHaveLength(1);
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('never reports geometry for an unattached or disposed renderer', () => {
        const h = harness({ ownsSize: false });
        h.present({ ownsSize: true });
        expect(h.json('resize-pane')).toEqual([]);
        h.attach(); h.scope.dispose();
        h.present({ ownsSize: false });
        expect(h.json('resize-pane')).toEqual([]);
        expect(h.fail).not.toHaveBeenCalled();
    });
});

describe('terminal presentation crossing the view boundary', () => {
    const pane = { paneID: PANE, ptyApi: { subscribe: vi.fn() } as unknown as TerminalPaneProps['ptyApi'], focused: true, visible: false };
    it('forwards size ownership, defaulting an omitted owner to this window', () => {
        expect(terminalPresentation(pane)).toMatchObject({ focused: true, visible: false, ownsSize: true, reveal: null });
        expect(terminalPresentation({ ...pane, ownsSize: false }).ownsSize).toBe(false);
        expect(terminalPresentation({ ...pane, ownsSize: true }).ownsSize).toBe(true);
        // Absent optional fields stay absent; ownsSize is always stated.
        expect(Object.keys(terminalPresentation(pane))).toContain('ownsSize');
        expect(Object.keys(terminalPresentation(pane))).not.toContain('fontSize');
    });
});
