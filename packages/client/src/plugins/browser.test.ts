import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserSurfaceRect, createBrowserScope, BROWSER_SCOPE_LIMITS, type BrowserFrameBounds, type BrowserSurfaceState } from './browser';

const presentation = { available: true, visible: true, focused: true };
const rect = { x: 0, y: 30, w: 200, h: 100 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function fixture() {
    let frame: BrowserFrameBounds | null = { rect: { x: 100, y: 50, w: 200, h: 200 }, width: 200, height: 200, viewport: { width: 1000, height: 800 } };
    const send = vi.fn(), surface = vi.fn<(value: BrowserSurfaceState | null) => void>(), textFocus = vi.fn(), focusNative = vi.fn(), fail = vi.fn(), beforeAction = vi.fn();
    const scope = createBrowserScope({ presentation, frame: () => frame, send, surface, textFocus, focusNative, fail, beforeAction });
    return { scope, send, surface, textFocus, focusNative, fail, beforeAction, frame: (value: BrowserFrameBounds | null) => { frame = value; }, attach: (session = 'one') => scope.attach({ session, rect, visible: true }) };
}
afterEach(() => vi.useRealTimers());

describe('browser renderer scope', () => {
    it('clips local coordinates to the frame, applies scale, then clips to the window', () => {
        expect(browserSurfaceRect({ x: -50, y: -50, w: 400, h: 300 }, { rect: { x: 100, y: 50, w: 400, h: 200 }, width: 200, height: 100, viewport: { width: 450, height: 210 } })).toEqual({ x: 100, y: 50, w: 350, h: 160 });
    });
    it('remeasures host movement without trusting plugin target or window IDs', () => {
        const f = fixture(); f.attach();
        f.scope.receive({ type: 'browser-geometry', session: 'one', paneID: 'other', windowID: 'forged', rect, visible: true });
        expect(f.surface).toHaveBeenLastCalledWith({ rect: { x: 100, y: 80, w: 200, h: 100 }, visible: true, covered: false });
        f.frame({ rect: { x: 300, y: 60, w: 200, h: 200 }, width: 200, height: 200, viewport: { width: 1000, height: 800 } });
        f.scope.measure();
        expect(f.surface).toHaveBeenLastCalledWith({ rect: { x: 300, y: 90, w: 200, h: 100 }, visible: true, covered: false });
        f.scope.dispose();
    });
    it('retires detached handles and refuses their reuse', () => {
        const f = fixture(); f.attach(); f.scope.receive({ type: 'browser-detach', session: 'one' }); f.attach('two');
        const calls = f.surface.mock.calls.length;
        f.scope.receive({ type: 'browser-geometry', session: 'one', rect: { x: 0, y: 0, w: 1, h: 1 }, visible: true });
        f.scope.receive({ type: 'browser-focus', session: 'one' });
        expect(f.surface).toHaveBeenCalledTimes(calls); expect(f.focusNative).not.toHaveBeenCalled();
        f.scope.receive({ type: 'browser-detach', session: 'two' });
        expect(() => f.attach('one')).toThrow(/reused/); f.scope.dispose();
    });
    it('allows one active attachment and bounds the view lifetime', () => {
        const f = fixture(); f.attach(); expect(() => f.attach('two')).toThrow(/already/);
        f.scope.receive({ type: 'browser-detach', session: 'one' });
        for (let i = 1; i < BROWSER_SCOPE_LIMITS.attachments; i++) { f.attach(String(i)); f.scope.receive({ type: 'browser-detach', session: String(i) }); }
        expect(() => f.attach('last')).toThrow(/Invalid/); f.scope.dispose();
    });
    it('keeps a single presentation in flight and only its latest replacement', () => {
        const f = fixture(); f.attach();
        f.scope.update({ ...presentation, focused: false }); f.scope.update({ ...presentation, visible: false });
        expect(f.send).toHaveBeenCalledTimes(1);
        f.scope.receive({ type: 'browser-ack', session: 'one', sequence: 99 }); expect(f.send).toHaveBeenCalledTimes(1);
        f.scope.receive({ type: 'browser-ack', session: 'one', sequence: 1 });
        expect(f.send).toHaveBeenLastCalledWith({ type: 'browser-presentation', session: 'one', sequence: 2, value: { ...presentation, visible: false } });
        f.scope.dispose();
    });
    it('times out an unconsumed presentation and removes placement', () => {
        vi.useFakeTimers(); const f = fixture(); f.attach(); vi.advanceTimersByTime(BROWSER_SCOPE_LIMITS.frameTimeoutMs);
        expect(f.fail).toHaveBeenCalledOnce(); expect(f.scope.attached).toBe(false); expect(f.surface).toHaveBeenLastCalledWith(null);
    });
    it('ignores native focus when covered, hidden, outside the viewport or without a host', () => {
        const f = fixture(); f.attach();
        f.scope.receive({ type: 'browser-covered', session: 'one', covered: true }); f.scope.receive({ type: 'browser-focus', session: 'one' });
        expect(f.focusNative).not.toHaveBeenCalled();
        f.scope.receive({ type: 'browser-covered', session: 'one', covered: false }); f.scope.update({ ...presentation, visible: false }); f.scope.receive({ type: 'browser-focus', session: 'one' });
        f.scope.update({ ...presentation, available: false }); f.scope.receive({ type: 'browser-focus', session: 'one' });
        f.scope.update(presentation); f.frame(null); f.scope.receive({ type: 'browser-focus', session: 'one' });
        expect(f.focusNative).not.toHaveBeenCalled(); f.scope.dispose();
    });
    it('disposes geometry and text focus without destroying native state', () => {
        const f = fixture(); f.attach(); f.scope.receive({ type: 'browser-text-focus', session: 'one', editing: true });
        expect(f.textFocus).toHaveBeenLastCalledWith(true); f.scope.dispose(); f.scope.dispose();
        expect(f.textFocus).toHaveBeenLastCalledWith(false); expect(f.surface).toHaveBeenLastCalledWith(null);
        expect(f.focusNative).not.toHaveBeenCalled(); expect(() => f.attach()).toThrow(/disposed/);
    });
    it('waits for native focus release before invoking chrome actions', async () => {
        const f = fixture(), gate = deferred(); f.beforeAction.mockReturnValue(gate.promise); f.attach();
        const pending = f.scope.action({ type: 'focusAddress' }); await Promise.resolve();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false);
        gate.resolve(); await vi.waitFor(() => expect(f.send.mock.calls.some(([value]) => value.type === 'browser-action')).toBe(true));
        const message = f.send.mock.calls.find(([value]) => value.type === 'browser-action')?.[0]; expect(message).toBeDefined();
        f.scope.receive({ type: 'browser-action-reply', session: 'one', id: message.id, result: null }); await expect(pending).resolves.toBeNull(); f.scope.dispose();
    });
    it('does not deliver an action after its attachment was superseded', async () => {
        const f = fixture(), gate = deferred(); f.beforeAction.mockReturnValue(gate.promise); f.attach();
        const pending = f.scope.action({ type: 'showFind' }); const rejected = expect(pending).rejects.toThrow(/detached/); await Promise.resolve();
        f.scope.receive({ type: 'browser-detach', session: 'one' }); f.attach('two'); gate.resolve(); await rejected; await Promise.resolve();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false); f.scope.dispose();
    });
    it.each(['dispose', 'replace', 'hide', 'unfocus'] as const)('cancels native focus release before its microtask when the view will %s', async change => {
        const f = fixture(); f.attach();
        const pending = f.scope.action({ type: 'focusAddress' }); const rejected = expect(pending).rejects.toThrow(/detached|hidden|lost focus/);
        if (change === 'dispose') f.scope.dispose();
        else if (change === 'replace') { f.scope.receive({ type: 'browser-detach', session: 'one' }); f.attach('two'); }
        else f.scope.update({ ...presentation, ...(change === 'hide' ? { visible: false } : { focused: false }) });
        await rejected; await Promise.resolve(); await Promise.resolve();
        expect(f.beforeAction).not.toHaveBeenCalled();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false); f.scope.dispose();
    });
    it('cancels an awaited focus release when hidden and does not revive it on show', async () => {
        const f = fixture(), gate = deferred(); f.beforeAction.mockReturnValue(gate.promise); f.attach();
        const pending = f.scope.action({ type: 'showFind' }); const rejected = expect(pending).rejects.toThrow(/hidden/); await Promise.resolve();
        expect(f.beforeAction).toHaveBeenCalledOnce();
        f.scope.update({ ...presentation, visible: false }); await rejected;
        f.scope.update(presentation); gate.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false); f.scope.dispose();
    });
    it.each(['focus', 'focusAddress', 'showFind'] as const)('cancels %s while native blur awaits if another pane takes focus', async type => {
        const f = fixture(), gate = deferred(); f.beforeAction.mockReturnValue(gate.promise); f.attach();
        const pending = f.scope.action({ type }); const rejected = expect(pending).rejects.toThrow(/lost focus/); await Promise.resolve();
        expect(f.beforeAction).toHaveBeenCalledExactlyOnceWith({ type });
        f.scope.update({ ...presentation, focused: false }); await rejected;
        // Returning to this pane must not revive an earlier request whose native blur
        // happened to finish after the person had moved their caret elsewhere.
        f.scope.update(presentation); gate.resolve(); await Promise.resolve(); await Promise.resolve();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false); f.scope.dispose();
    });
    it('does not start new caret actions while this visible pane is unfocused', async () => {
        const f = fixture(); f.attach(); f.scope.update({ ...presentation, focused: false });
        for (const type of ['focus', 'focusAddress', 'showFind'] as const) await expect(f.scope.action({ type })).rejects.toThrow(/not focused/);
        expect(f.beforeAction).not.toHaveBeenCalled(); f.scope.dispose();
    });
    it('releases an already delivered action on hide and ignores its late reply', async () => {
        const f = fixture(); f.attach(); const pending = f.scope.action({ type: 'showFind' });
        const rejected = expect(pending).rejects.toThrow(/hidden/);
        await vi.waitFor(() => expect(f.send.mock.calls.some(([value]) => value.type === 'browser-action')).toBe(true));
        const action = f.send.mock.calls.find(([value]) => value.type === 'browser-action')![0];
        f.scope.update({ ...presentation, visible: false }); await rejected;
        f.scope.receive({ type: 'browser-action-reply', session: 'one', id: action.id, result: null });
        expect(f.fail).not.toHaveBeenCalled(); f.scope.dispose();
    });
    it('times out a queued action without starting its native side effect', async () => {
        vi.useFakeTimers(); const f = fixture(); f.attach();
        const pending = f.scope.action({ type: 'focusAddress' }); const rejected = expect(pending).rejects.toThrow(/timed out/);
        vi.advanceTimersByTime(BROWSER_SCOPE_LIMITS.actionTimeoutMs); await rejected; await Promise.resolve();
        expect(f.beforeAction).not.toHaveBeenCalled();
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false); f.scope.dispose();
    });
    it('derives the text marker from retained actual editing state when pane focus returns', () => {
        const f = fixture(); f.attach();
        f.scope.receive({ type: 'browser-text-focus', session: 'one', editing: true });
        expect(f.textFocus).toHaveBeenLastCalledWith(true);
        f.scope.update({ ...presentation, focused: false }); expect(f.textFocus).toHaveBeenLastCalledWith(false);
        f.scope.update(presentation); expect(f.textFocus).toHaveBeenLastCalledWith(true);
        f.scope.update({ ...presentation, visible: false }); expect(f.textFocus).toHaveBeenLastCalledWith(false);
        f.scope.update(presentation); expect(f.textFocus).toHaveBeenLastCalledWith(true);
        f.scope.update({ ...presentation, focused: false });
        f.scope.receive({ type: 'browser-text-focus', session: 'one', editing: false });
        f.scope.update(presentation); expect(f.textFocus).toHaveBeenLastCalledWith(false);
        f.scope.dispose();
    });
    it('rejects native release failures before sending an iframe action', async () => {
        const f = fixture(); f.beforeAction.mockRejectedValue(new Error('native blur refused')); f.attach();
        await expect(f.scope.action({ type: 'focusAddress' })).rejects.toThrow('native blur refused');
        expect(f.send.mock.calls.some(([message]) => message.type === 'browser-action')).toBe(false);
        expect(f.fail).not.toHaveBeenCalled(); f.scope.dispose();
    });
    it('ignores native focus failures from a retired session while reporting current failures', async () => {
        const f = fixture(); let failFocus!: (error: Error) => void;
        f.focusNative.mockImplementation(() => new Promise((_, reject) => { failFocus = reject; })); f.attach();
        f.scope.receive({ type: 'browser-focus', session: 'one' });
        f.scope.receive({ type: 'browser-detach', session: 'one' }); f.attach('two');
        failFocus(new Error('old host')); await Promise.resolve(); expect(f.fail).not.toHaveBeenCalled();
        f.focusNative.mockRejectedValue(new Error('current host'));
        f.scope.receive({ type: 'browser-focus', session: 'two' }); await Promise.resolve();
        expect(f.fail).toHaveBeenCalledExactlyOnceWith(new Error('current host')); f.scope.dispose();
    });
    it.each([NaN, Infinity, -1, 1_000_001])('rejects malformed geometry width %s', width => {
        const f = fixture(); expect(() => f.scope.attach({ session: 'one', rect: { ...rect, w: width }, visible: true })).toThrow(/rectangle/); f.scope.dispose();
    });
});
