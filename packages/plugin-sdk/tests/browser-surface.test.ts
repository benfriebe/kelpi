import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAction, BrowserAttachOptions, BrowserPresentation, ViewAPI } from '../index.js';

const visible: BrowserPresentation = { available: true, visible: true, focused: false };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function tick(): Promise<void> { for (let index = 0; index < 16; index++) await Promise.resolve(); }

function harness() {
    const events = new Map<string, Set<(...args: any[]) => void>>();
    const add = (name: string, callback: (...args: any[]) => void): void => { const callbacks = events.get(name) ?? new Set(); callbacks.add(callback); events.set(name, callbacks); };
    const remove = (name: string, callback: (...args: any[]) => void): void => { events.get(name)?.delete(callback); };
    const fire = (name: string, event: any = {}): void => { for (const callback of [...(events.get(name) ?? [])]) callback(event); };
    const document = { visibilityState: 'visible', activeElement: null as Element | null, documentElement: null as unknown as Element, addEventListener: add, removeEventListener: remove };
    class Element {
        ownerDocument = document;
        isConnected = true;
        isContentEditable = false;
        tagName = 'DIV';
        type = 'text';
        parentElement: Element | null = null;
        shadowRoot: { activeElement: Element | null } | null = null;
        rect = { x: 10, y: 30, width: 450, height: 250 };
        rectCount = 1;
        style = { setProperty: vi.fn() };
        computed = { display: 'block', visibility: 'visible', opacity: '1' };
        getBoundingClientRect(): typeof this.rect { return { ...this.rect }; }
        getClientRects(): unknown[] { return new Array(this.rectCount); }
        focus(): void { document.activeElement = this; fire('focusin'); }
        blur(): void { if (document.activeElement === this) { document.activeElement = null; fire('focusout'); } }
    }
    document.documentElement = new Element();
    const observers: Resize[] = [];
    class Resize {
        observe = vi.fn(); disconnect = vi.fn();
        constructor(readonly callback: () => void) { observers.push(this); }
    }
    let nextFrame = 0;
    const frames = new Map<number, () => void>();
    const frame = (): void => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); };
    const parent = { postMessage: vi.fn() };
    const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: (_event: any): void | Promise<void> => {} };
    const context = vm.createContext({
        __KELPI_VIEW__: { nonce: 'browser', visible: true, state: {}, stateVersion: 1, context: { daemonID: 'owner', paneID: 'pane' } },
        parent, TextEncoder, setTimeout, clearTimeout, console, document,
        HTMLElement: Element, ResizeObserver: Resize, innerWidth: 500, innerHeight: 400,
        getComputedStyle: (element: Element) => element.computed,
        requestAnimationFrame: (callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        addEventListener: add, removeEventListener: remove,
    });
    const shared = fs.readFileSync(new URL('../api.js', import.meta.url), 'utf8').replace(/^export /gm, '');
    vm.runInContext(`(()=>{${shared}\n${fs.readFileSync(new URL('../browser.js', import.meta.url), 'utf8')}})()`, context);
    const api = (context as typeof context & { kelpi: ViewAPI }).kelpi;
    const element = new Element(); element.parentElement = document.documentElement;
    const sent = (type: string): any[] => port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === type);
    const receive = (data: unknown): Promise<void> => Promise.resolve(port.onmessage({ data }));
    const connect = (): void => fire('message', { source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'browser' }, ports: [port] });
    const reply = (call: any, presentation = visible, error?: string): Promise<void> => receive({ type: 'reply', id: call.id, result: { session: call.args.session, presentation }, error });
    const presentation = (session: string, sequence: number, value: BrowserPresentation = visible): Promise<void> => receive({ type: 'browser-presentation', session, sequence, value });
    const action = (session: string, id: string, action: BrowserAction): Promise<void> => receive({ type: 'browser-action', session, id, action });
    const attach = async (options: Partial<BrowserAttachOptions> = {}) => {
        const attaching = api.browser.attach({ element: element as unknown as HTMLElement, onPresentation() {}, ...options });
        await tick(); const call = sent('call').at(-1)!; expect(call.method).toBe('browser.attach');
        await reply(call); const surface = await attaching; await tick(); return surface;
    };
    return { api, context, document, Element, element, observers, frames, frame, events, fire, port, sent, receive, connect, reply, presentation, action, attach };
}

describe('browser native surface bridge', () => {
    it('waits for the private channel and measures only its actual frame-local element', async () => {
        const h = harness(), observed = vi.fn();
        h.element.rect = { x: -20, y: 25, width: 580, height: 440 };
        const attaching = h.api.browser.attach({ element: h.element as unknown as HTMLElement, onPresentation: observed });
        await tick(); expect(h.sent('call')).toEqual([]); h.connect(); await tick();
        const call = h.sent('call')[0];
        expect(call).toMatchObject({ method: 'browser.attach', args: { session: 'browser-1', rect: { x: 0, y: 25, w: 500, h: 375 }, visible: true } });
        expect(Object.keys(call.args).sort()).toEqual(['rect', 'session', 'visible']);
        await h.presentation(call.args.session, 1, { ...visible, focused: true });
        await h.reply(call); const surface = await attaching; await tick();
        expect(observed).toHaveBeenCalledExactlyOnceWith({ ...visible, focused: true });
        expect(Object.isFrozen(observed.mock.calls[0]![0])).toBe(true);
        expect(Object.isFrozen(surface)).toBe(true);
        expect(h.api.browser).toHaveProperty('watch'); expect(h.api.browser).toHaveProperty('navigate');
        surface.dispose();
    });

    it('tracks position, viewport, context and CSS visibility without duplicate geometry traffic', async () => {
        const h = harness(); h.connect(); const surface = await h.attach();
        h.frame(); h.observers[0]!.callback(); h.fire('scroll'); expect(h.sent('browser-geometry')).toEqual([]);
        h.element.rect.x = 35; h.frame();
        expect(h.sent('browser-geometry').at(-1)).toMatchObject({ session: surface.id, rect: { x: 35, y: 30, w: 450, h: 250 }, visible: true });
        h.context.innerWidth = 300; h.fire('resize');
        expect(h.sent('browser-geometry').at(-1).rect.w).toBe(265);
        await h.receive({ type: 'context', value: { visible: false } }); expect(h.sent('browser-geometry').at(-1).visible).toBe(false);
        await h.receive({ type: 'context', value: { visible: true } }); expect(h.sent('browser-geometry').at(-1).visible).toBe(true);
        h.document.documentElement.computed.opacity = '0'; h.frame(); expect(h.sent('browser-geometry').at(-1).visible).toBe(false);
        h.document.documentElement.computed.opacity = '1'; h.element.computed.visibility = 'hidden'; h.frame();
        expect(h.sent('browser-geometry')).toHaveLength(5);
        h.element.computed.visibility = 'visible'; h.element.isConnected = false; h.frame(); expect(h.sent('browser-geometry')).toHaveLength(5);
        h.element.isConnected = true; h.frame(); expect(h.sent('browser-geometry').at(-1).visible).toBe(true);
        h.document.visibilityState = 'hidden'; h.fire('visibilitychange'); expect(h.sent('browser-geometry').at(-1).visible).toBe(false);
        surface.dispose();
    });

    it('covers the native slot, suppresses hidden focus and releases text editing before page focus', async () => {
        const h = harness(); h.connect(); const surface = await h.attach();
        expect(h.sent('browser-text-focus')).toEqual([{ type: 'browser-text-focus', session: surface.id, editing: false }]);
        const input = new h.Element(); input.tagName = 'INPUT'; input.focus();
        expect(h.sent('browser-text-focus').at(-1).editing).toBe(true);
        surface.setCovered(true); surface.setCovered(true); surface.focus();
        expect(h.sent('browser-covered')).toHaveLength(1); expect(h.sent('browser-focus')).toEqual([]);
        expect(h.document.activeElement).toBe(input);
        surface.setCovered(false); surface.focus(); await tick();
        expect(h.document.activeElement).toBeNull();
        expect(h.sent('browser-text-focus').at(-1).editing).toBe(false);
        const messages = h.port.postMessage.mock.calls.map(([message]) => message.type);
        expect(messages.lastIndexOf('browser-text-focus')).toBeLessThan(messages.lastIndexOf('browser-focus'));
        expect(h.sent('browser-focus')).toEqual([{ type: 'browser-focus', session: surface.id }]);
        await h.receive({ type: 'context', value: { visible: false } }); surface.focus(); expect(h.sent('browser-focus')).toHaveLength(1);
        expect(() => surface.setCovered(1 as any)).toThrow('boolean'); surface.dispose();
    });

    it('reports nested contenteditable focus without classifying checkboxes as text editing', async () => {
        const h = harness(); h.connect(); const surface = await h.attach();
        const wrapper = new h.Element(), input = new h.Element(); input.isContentEditable = true;
        wrapper.shadowRoot = { activeElement: input }; wrapper.focus();
        expect(h.sent('browser-text-focus').at(-1).editing).toBe(true);
        const checkbox = new h.Element(); checkbox.tagName = 'INPUT'; checkbox.type = 'checkbox'; checkbox.focus();
        expect(h.sent('browser-text-focus').at(-1).editing).toBe(false); surface.dispose();
    });

    it('retains the plugin text caret when native presentation is unavailable or hidden', async () => {
        const h = harness(); h.connect(); const surface = await h.attach();
        const input = new h.Element(); input.tagName = 'INPUT'; input.focus();
        await h.presentation(surface.id, 1, { ...visible, available: false, reason: 'Page belongs to another window.' });
        surface.focus();
        expect(h.document.activeElement).toBe(input); expect(h.sent('browser-focus')).toEqual([]);
        // Host visibility can arrive ahead of the general context update. Neither
        // order should clear the author's input before a native request is rejected.
        await h.presentation(surface.id, 2, { ...visible, visible: false });
        surface.focus();
        expect(h.document.activeElement).toBe(input); expect(h.sent('browser-focus')).toEqual([]);
        await h.presentation(surface.id, 3, visible); surface.focus();
        expect(h.document.activeElement).toBeNull(); expect(h.sent('browser-focus')).toHaveLength(1);
        surface.dispose();
    });

    it('preserves native text-editing chords inside browser chrome before default prevention', async () => {
        const h = harness(); h.connect();
        await h.receive({ type: 'context', value: { chords: ['8/ArrowLeft', '8/ArrowRight', '12/BracketLeft', '12/BracketRight', '8/KeyL'] } });
        const surface = await h.attach();
        const input = new h.Element(); input.tagName = 'INPUT'; input.focus();
        const key = (code: string, shiftKey = false) => {
            const event = { code, key: code, metaKey: true, ctrlKey: false, altKey: false, shiftKey, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
            h.fire('keydown', event); return event;
        };
        for (const [code, shift] of [['ArrowLeft', false], ['ArrowRight', false], ['BracketLeft', true], ['BracketRight', true]] as const) {
            expect(key(code, shift).preventDefault).not.toHaveBeenCalled();
        }
        expect(h.sent('key')).toEqual([]);
        expect(key('KeyL').preventDefault).toHaveBeenCalledOnce();
        input.blur(); await tick(); expect(key('ArrowLeft').preventDefault).toHaveBeenCalledOnce();
        input.focus(); surface.dispose(); expect(key('ArrowLeft').preventDefault).toHaveBeenCalledOnce();
    });

    it('serializes presentation consumers, coalesces a latest value, and acknowledges after consumption', async () => {
        const h = harness(); h.connect(); const held = deferred(), observed: boolean[] = [];
        let busy = 0, maximum = 0;
        const surface = await h.attach({ onPresentation: async value => {
            maximum = Math.max(maximum, ++busy); observed.push(value.focused);
            if (observed.length === 1) await held.promise; busy--;
        } });
        const first = h.presentation(surface.id, 1, { ...visible, focused: true });
        const second = h.presentation(surface.id, 2, { ...visible, visible: false }); await tick();
        expect(observed).toEqual([false]); expect(h.sent('browser-ack')).toEqual([]);
        held.resolve(); await Promise.all([first, second]);
        expect(observed).toEqual([false, false]); expect(maximum).toBe(1);
        expect(h.sent('browser-ack').map(message => message.sequence)).toEqual([1, 2]);
        await h.presentation(surface.id, 1); expect(observed).toHaveLength(2); surface.dispose();
    });

    it('fails the view on invalid presentation or rejected consumption', async () => {
        const h = harness(); h.connect(); const surface = await h.attach({ onPresentation: value => { if (value.focused) throw new Error('render failed'); } });
        await h.presentation(surface.id, 1, { ...visible, focused: true }); await tick();
        expect(h.sent('view-error')).toEqual([{ type: 'view-error', message: 'render failed' }]);
        expect(h.sent('browser-detach')).toHaveLength(1); expect(h.sent('browser-ack')).toEqual([]);
        const replacement = await h.attach();
        await h.presentation(replacement.id, 1, { ...visible, available: 'yes' } as any); await tick();
        expect(h.sent('view-error').at(-1).message).toContain('Invalid browser presentation');
        const third = await h.attach();
        await h.receive({ type: 'browser-presentation', session: third.id, sequence: 0, value: visible }); await tick();
        expect(h.sent('view-error').at(-1).message).toContain('sequence');
    });

    it('replies to bounded actions and keeps individual action failures separate from view failure', async () => {
        const h = harness(); h.connect(); const observed = vi.fn(async (action: BrowserAction) => { if (action.type === 'showFind') throw new Error('find unavailable'); });
        const surface = await h.attach({ onAction: observed });
        await h.action(surface.id, 'address', { type: 'focusAddress' }); await h.action(surface.id, 'find', { type: 'showFind' });
        expect(h.sent('browser-action-reply')).toEqual([
            { type: 'browser-action-reply', session: surface.id, id: 'address', result: null },
            { type: 'browser-action-reply', session: surface.id, id: 'find', result: null, error: 'find unavailable' },
        ]);
        await h.action(surface.id, 'invalid', { type: 'closePane' } as any);
        expect(h.sent('browser-action-reply').at(-1).error).toContain('Unsupported'); expect(h.sent('view-error')).toEqual([]);
        surface.dispose();
        const held = deferred(); const blocked = await h.attach({ onAction: () => held.promise });
        const actions = Array.from({ length: 17 }, (_, index) => h.action(blocked.id, String(index), { type: 'focus' })); await tick();
        expect(h.sent('browser-action-reply').at(-1)).toMatchObject({ id: '16', error: 'Too many pending browser actions.' });
        blocked.dispose(); await Promise.all(actions); held.resolve();
    });

    it('makes disposed sessions inert and cancels hung callbacks and all measurement resources', async () => {
        const h = harness(); h.connect(); const held = deferred();
        const surface = await h.attach({ onPresentation: () => held.promise, onAction: () => held.promise });
        const update = h.presentation(surface.id, 1); const action = h.action(surface.id, 'wait', { type: 'focus' }); await tick();
        surface.dispose(); surface.dispose(); await Promise.all([update, action]);
        expect(h.observers[0]!.disconnect).toHaveBeenCalledOnce(); expect(h.frames.size).toBe(0);
        expect(h.events.get('scroll')?.size).toBe(0); expect(h.events.get('resize')?.size).toBe(0);
        expect(() => surface.focus()).toThrow('disposed'); expect(() => surface.setCovered(true)).toThrow('disposed');
        expect(h.sent('browser-detach')).toHaveLength(1); expect(h.sent('browser-ack')).toEqual([]); expect(h.sent('browser-action-reply')).toEqual([]);
        const observed = vi.fn(); const next = await h.attach({ onPresentation: observed });
        await h.presentation(surface.id, 2, { ...visible, focused: true }); await h.action(surface.id, 'old', { type: 'showFind' });
        expect(observed).toHaveBeenCalledOnce(); expect(next.id).not.toBe(surface.id); next.dispose(); held.resolve();
    });

    it('allows one attaching surface and cancels setup before connect or the reply', async () => {
        const h = harness();
        const options = { element: h.element as unknown as HTMLElement, onPresentation() {} };
        const attaching = h.api.browser.attach(options).catch(error => error);
        await expect(h.api.browser.attach(options)).rejects.toThrow('already has');
        h.fire('pagehide'); expect((await attaching).message).toContain('disposed');
        h.connect(); await tick(); expect(h.sent('call')).toEqual([]);
        await expect(h.api.browser.attach(options)).rejects.toThrow('view disposal');
        const next = harness(); next.connect();
        const pending = next.api.browser.attach({ ...options, element: next.element as unknown as HTMLElement }).catch(error => error); await tick();
        next.fire('pagehide'); expect((await pending).message).toContain('disposed');
        expect(next.sent('browser-detach')).toHaveLength(1); expect(next.frames.size).toBe(0);
    });

    it('rejects foreign/fake elements, invalid bounds and malformed attachment replies', async () => {
        const h = harness(); h.connect(); const options = { element: h.element as unknown as HTMLElement, onPresentation() {} };
        for (const value of [null, {}, { ...options, element: {} }, { ...options, onPresentation: 1 }, { ...options, onAction: 1 }]) await expect(h.api.browser.attach(value as any)).rejects.toThrow();
        const foreign = new h.Element(); foreign.ownerDocument = {} as any;
        await expect(h.api.browser.attach({ ...options, element: foreign as unknown as HTMLElement })).rejects.toThrow('from this view');
        h.element.rect.width = Infinity; await expect(h.api.browser.attach(options)).rejects.toThrow('bounds');
        h.element.rect.width = 400;
        const pending = h.api.browser.attach(options); await tick(); const call = h.sent('call').at(-1);
        await h.receive({ type: 'reply', id: call.id, result: { session: 'forged', presentation: visible } });
        await expect(pending).rejects.toThrow('attachment reply');
        const surface = await h.attach(); h.element.rect.x = NaN; h.frame(); await tick();
        expect(h.sent('view-error').at(-1).message).toContain('bounds'); expect(() => surface.focus()).toThrow('disposed');
    });

    it('never reuses a surface ID and bounds attachment churn within one iframe', async () => {
        const h = harness(); h.connect(); const ids = new Set<string>();
        for (let index = 0; index < 128; index++) { const surface = await h.attach(); ids.add(surface.id); surface.dispose(); }
        expect(ids.size).toBe(128);
        await expect(h.api.browser.attach({ element: h.element as unknown as HTMLElement, onPresentation() {} })).rejects.toThrow('Too many browser attachments');
        expect(h.frames.size).toBe(0);
    });
});
