import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
// @ts-expect-error The SDK-only example is plain JavaScript, consumed by esbuild.
import { consumeTerminalFrame, createInputRouter, gridFromMetrics, keyEventInit, revealLocation, stickyKey, stickyText } from '../../../../examples/plugins/terminal-lab/ui/helpers.js';
// @ts-expect-error The example deliberately has no imports from the application.
import { mountTerminalLab } from '../../../../examples/plugins/terminal-lab/ui/renderer.js';
// @ts-expect-error Private xterm details are isolated in the plain JavaScript adapter.
import { applyXtermModes, bindXtermMouse } from '../../../../examples/plugins/terminal-lab/ui/xterm-adapter.js';

describe('Terminal Lab input and replay rules', () => {
    it.each([
        ['Escape', undefined, 27], ['ArrowUp', undefined, 38], ['ArrowDown', undefined, 40], ['ArrowLeft', undefined, 37], ['ArrowRight', undefined, 39],
        ['Backspace', undefined, 8], ['Enter', undefined, 13], ['Tab', undefined, 9], ['Home', undefined, 36], ['End', undefined, 35],
        ['Insert', undefined, 45], ['Delete', undefined, 46], ['PageUp', undefined, 33], ['PageDown', undefined, 34], ['F1', undefined, 112], ['F12', undefined, 123],
        ['c', 'KeyC', 67], ['c', undefined, 67], ['@', 'Digit2', 50], ['?', 'Slash', 191], [' ', 'Space', 32], ['Unidentified', undefined, 0]
    ])('provides xterm keyCode for %s (%s)', (key, code, expected) => {
        expect(keyEventInit({ key, code, ctrlKey: true })).toMatchObject({ key, keyCode: expected, which: expected, ctrlKey: true, bubbles: true, cancelable: true });
    });

    it('applies armed modifiers to one real key while leaving IME, dead keys, and modifier keys alone', () => {
        const modifiers = { ctrl: true, alt: false };
        expect(stickyKey({ key: 'c', code: 'KeyC', altKey: true }, modifiers)).toMatchObject({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true });
        expect(stickyKey({ key: 'c' }, { ctrl: false, alt: false })).toBeNull();
        for (const key of ['Dead', 'Process', 'Unidentified', 'AltGraph', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) expect(stickyKey({ key }, modifiers)).toBeNull();
        expect(stickyKey({ key: 'c', isComposing: true }, modifiers)).toBeNull();
        expect(stickyKey({ key: 'c', keyCode: 229 }, modifiers)).toBeNull();
        expect(stickyKey({ key: 'c' }, modifiers, true)).toBeNull();
        expect(modifiers).toEqual({ ctrl: true, alt: false });
    });

    it('uses cancellable phone beforeinput only for a single committed character, preserving composition and paste', () => {
        const event = { data: 'c', inputType: 'insertText', cancelable: true };
        const modifiers = { ctrl: true, alt: false };
        expect(stickyText(event, modifiers)).toMatchObject({ key: 'c', ctrlKey: true });
        for (const override of [{ cancelable: false }, { isComposing: true }, { inputType: 'insertCompositionText' }, { inputType: 'insertFromPaste' }, { data: null }, { data: 'text' }]) expect(stickyText({ ...event, ...override }, modifiers)).toBeNull();
        expect(stickyText(event, modifiers, true)).toBeNull();
    });

    it('routes by input origin rather than bytes, including async IME, mouse reports, query replies and lookalike pastes', async () => {
        const emit = vi.fn(), router = createInputRouter(emit);
        router.data('\x1b[1;1R');
        expect(emit).toHaveBeenLastCalledWith('\x1b[1;1R', true, true);
        router.run('keyboard', () => { router.userInput(); router.data('\x1b[<0;1;1M'); });
        expect(emit).toHaveBeenLastCalledWith('\x1b[<0;1;1M', false, false);
        router.mark('mouse'); router.userInput(); router.data('\x1b[<0;1;1M');
        expect(emit).toHaveBeenLastCalledWith('\x1b[<0;1;1M', true, false);
        await Promise.resolve();
        // CompositionHelper emits after compositionend has finished dispatching.
        router.userInput(); router.data('日本語');
        expect(emit).toHaveBeenLastCalledWith('日本語', false, false);
        router.data('\x1b[?1;2c');
        expect(emit).toHaveBeenLastCalledWith('\x1b[?1;2c', true, true);
        router.run('release', () => { router.userInput(); router.data('\x1b[97;1:3u'); });
        expect(emit).toHaveBeenLastCalledWith('\x1b[97;1:3u', true, false);
        router.mark('keyboard'); router.userInput(); router.binary('\x1b[M\x80');
        expect(emit).toHaveBeenLastCalledWith(new Uint8Array([27, 91, 77, 128]), true, false);
        await Promise.resolve(); router.data('reply');
        expect(emit).toHaveBeenLastCalledWith('reply', true, true);
    });

    it('restores nested routing scopes even if the emulator rejects a pasted input', () => {
        const emit = vi.fn(), router = createInputRouter(emit);
        expect(() => router.run('keyboard', () => { router.run('mouse', () => router.data('mouse')); throw new Error('paste failed'); })).toThrow('paste failed');
        router.data('query');
        expect(emit.mock.calls).toEqual([['mouse', true, false], ['query', true, true]]);
    });

    it('waits for parser cancellation, reset, and the complete authoritative replay before resolving output credit', async () => {
        const order: unknown[] = [], release: (() => void)[] = [];
        const terminal = { reset: () => order.push('reset') };
        const write = (data: Uint8Array) => { order.push(data); return new Promise<void>(resolve => release.push(resolve)); };
        const bytes = new Uint8Array([0x1b, 0x5b, 0x48]);
        let complete = false;
        const replay = consumeTerminalFrame(terminal, { type: 'replay', data: bytes }, write).then(() => { complete = true; });
        expect(order).toEqual([new Uint8Array([0x18, 0x1b, 0x63])]); expect(complete).toBe(false);
        release.shift()!(); await Promise.resolve();
        expect(order).toEqual([new Uint8Array([0x18, 0x1b, 0x63]), 'reset', bytes]); expect(complete).toBe(false);
        release.shift()!(); await replay; expect(complete).toBe(true);
        const append = consumeTerminalFrame(terminal, { type: 'output', data: new Uint8Array([65]) }, write);
        expect(order.at(-1)).toEqual(new Uint8Array([65])); release.shift()!(); await append;
        expect(order.filter(value => value === 'reset')).toHaveLength(1);
    });

    it.each([
        new TextEncoder().encode('\x1b]0;unfinished title'), new TextEncoder().encode('\x1b[2'),
        new TextEncoder().encode('\x1bP1;2qpartial payload'), new Uint8Array([0xf0, 0x9f])
    ])('replaces a real xterm parser with pending control or UTF-8 bytes (%j)', async partial => {
        const require = createRequire(path.resolve('packages/daemon/package.json'));
        const { Terminal } = require('@xterm/headless');
        const terminal = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
        const write = (data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
        try {
            await write(new TextEncoder().encode('old output'));
            await consumeTerminalFrame(terminal, { type: 'output', data: partial }, write);
            await consumeTerminalFrame(terminal, { type: 'replay', data: new TextEncoder().encode('authoritative 🦎') }, write);
            expect(terminal.buffer.active.getLine(0).translateToString(true)).toBe('authoritative 🦎');
            const live = new TextEncoder().encode(' café');
            await consumeTerminalFrame(terminal, { type: 'output', data: live.subarray(0, live.length - 1) }, write);
            await consumeTerminalFrame(terminal, { type: 'output', data: live.subarray(live.length - 1) }, write);
            expect(terminal.buffer.active.getLine(0).translateToString(true)).toBe('authoritative 🦎 café');
        } finally { terminal.dispose(); }
    });

    it('restores real xterm input modes after a replay that omits them and keeps SGR press/release bytes', async () => {
        const require = createRequire(path.resolve('packages/daemon/package.json'));
        const { Terminal } = require('@xterm/headless');
        const terminal = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
        const write = (data: Uint8Array) => new Promise<void>(resolve => terminal.write(data, resolve));
        const modes = { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'vt200', mouseFormat: 'sgr' };
        const data: string[] = [], binary: string[] = [];
        const emit = vi.fn(), router = createInputRouter(emit), mouseBinding = bindXtermMouse(terminal, router);
        terminal._core.coreService.onUserInput(() => router.userInput());
        terminal.onData((value: string) => { data.push(value); router.data(value); }); terminal.onBinary((value: string) => binary.push(value));
        try {
            await write(new TextEncoder().encode('\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h'));
            // Screen snapshots need not serialize the original mouse encoding.
            await consumeTerminalFrame(terminal, { type: 'replay', data: new TextEncoder().encode('\x1bcapplication screen') }, write, () => applyXtermModes(terminal, modes));
            expect(terminal.modes).toMatchObject({ applicationCursorKeysMode: true, bracketedPasteMode: true, mouseTrackingMode: 'vt200' });
            const mouse = terminal._core.coreMouseService;
            for (const action of [1, 0]) mouse.triggerMouseEvent({ col: 2, row: 1, x: 24, y: 32, button: 0, action });
            expect(data).toEqual(['\x1b[<0;3;2M', '\x1b[<0;3;2m']); expect(binary).toEqual([]);
            expect(emit.mock.calls).toEqual(data.map(value => [value, true, false]));
            await write(new TextEncoder().encode('\x1b[6n'));
            expect(emit).toHaveBeenLastCalledWith(expect.stringMatching(/^\x1b\[\d+;\d+R$/), true, true);
            applyXtermModes(terminal, { ...modes, applicationCursorKeys: false, bracketedPaste: false, mouseTracking: 'none' });
            expect(terminal.modes).toMatchObject({ applicationCursorKeysMode: false, bracketedPasteMode: false, mouseTrackingMode: 'none' });
            expect(mouse.triggerMouseEvent({ col: 2, row: 1, x: 24, y: 32, button: 0, action: 1 })).toBe(false);
        } finally { mouseBinding.dispose(); terminal.dispose(); }
    });

    it('applies mode metadata without disturbing a real parser waiting for the rest of a CSI', async () => {
        const require = createRequire(path.resolve('packages/daemon/package.json'));
        const { Terminal } = require('@xterm/headless');
        const terminal = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
        const write = (value: string) => new Promise<void>(resolve => terminal.write(value, resolve));
        try {
            await write('\x1b[');
            applyXtermModes(terminal, { applicationCursorKeys: true, bracketedPaste: true, mouseTracking: 'drag', mouseFormat: 'sgr' });
            await write('31mred');
            const line = terminal.buffer.active.getLine(0);
            expect(line.translateToString(true)).toBe('red'); expect(line.getCell(0).getFgColor()).toBe(1);
            expect(terminal.modes).toMatchObject({ applicationCursorKeysMode: true, bracketedPasteMode: true, mouseTrackingMode: 'drag' });
        } finally { terminal.dispose(); }
    });

    it.each(['utf8', 'urxvt'])('does not silently emit legacy mouse reports for unsupported %s encoding', format => {
        const require = createRequire(path.resolve('packages/daemon/package.json'));
        const { Terminal } = require('@xterm/headless');
        const terminal = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
        const data = vi.fn(), binary = vi.fn(); terminal.onData(data); terminal.onBinary(binary);
        try {
            applyXtermModes(terminal, { mouseTracking: 'vt200', mouseFormat: format });
            expect(terminal._core.coreMouseService.triggerMouseEvent({ col: 2, row: 1, x: 24, y: 32, button: 0, action: 1 })).toBe(false);
            expect(data).not.toHaveBeenCalled(); expect(binary).not.toHaveBeenCalled();
        } finally { terminal.dispose(); }
    });

    it('fits only measurable cells and anchors daemon search positions to the bottom of this renderer’s buffer', () => {
        expect(gridFromMetrics(800, 480, { width: 8, height: 16 }, 6, 4)).toEqual({ cols: 96, rows: 29, cellHeight: 16 });
        for (const cell of [null, { width: 0, height: 16 }, { width: 8, height: NaN }]) expect(gridFromMetrics(800, 480, cell)).toBeNull();
        expect(gridFromMetrics(0, 480, { width: 8, height: 16 })).toBeNull();
        expect(gridFromMetrics(1, 1, { width: 8, height: 16 })).toBeNull();
        expect(revealLocation(150, 24, { linesFromBottom: 10, col: 4, length: 6 })).toEqual({ line: 140, top: 126, col: 4, length: 6 });
        expect(revealLocation(150, 24, { linesFromBottom: 200, col: 4, length: 6 })).toBeNull();
    });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    vi.unstubAllGlobals(); document.body.innerHTML = ''; delete document.body.dataset.ready; delete document.body.dataset.mirror;
});

async function fixture(phone = false, visible = true, engineCapture: boolean | 'xterm' = false) {
    vi.stubGlobal('matchMedia', () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }));
    const observe = vi.fn(), disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect; });
    const root = document.createElement('main'); root.tabIndex = -1; document.body.append(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 480 } as DOMRect);
    const area = document.createElement('textarea');
    let onData = (_data: string) => {}, onUserInput = () => {}, onContext = (_value: { visible: boolean }) => {}, onScroll = () => {};
    const disposable = { dispose: vi.fn() }, writes: Uint8Array[] = [];
    const terminal = {
        cols: 80, rows: 24, textarea: area, options: {} as Record<string, unknown>,
        _core: { coreService: { decPrivateModes: { applicationCursorKeys: false, bracketedPasteMode: false }, onUserInput: (fn: () => void) => { onUserInput = fn; return disposable; } }, coreMouseService: { activeProtocol: 'NONE', activeEncoding: 'DEFAULT', triggerMouseEvent: (report: string) => { onUserInput(); onData(report); return true; } }, _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
        buffer: { active: { baseY: 126, viewportY: 126, length: 150 } },
        open: (target: HTMLElement) => {
            target.append(area);
            // xterm installs its own textarea capture handlers during open().
            if (engineCapture === 'xterm') {
                const require = createRequire(path.resolve('packages/client/package.json'));
                // Keyboard encoding uses the installed browser engine. Supply only the DOM
                // and composition hooks normally installed by open(); jsdom cannot paint it.
                const canvas = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
                const { Terminal } = require('@xterm/xterm');
                canvas.mockRestore();
                const keyboard = new Terminal({ macOptionIsMeta: true });
                const core = keyboard._core;
                core.element = target; core.textarea = area;
                core._compositionHelper = { keydown: () => true };
                core.coreService.onUserInput(() => onUserInput());
                keyboard.onData((data: string) => onData(data));
                area.addEventListener('keydown', event => core._keyDown(event), true);
                area.addEventListener('keypress', event => core._keyPress(event), true);
                area.addEventListener('input', event => core._inputEvent(event), true);
                cleanups.push(() => keyboard.dispose());
            } else if (engineCapture) area.addEventListener('keydown', event => {
                if (event.isComposing || event.keyCode === 229 || event.keyCode !== 67) return;
                onUserInput(); onData(event.ctrlKey ? '\x03' : event.altKey ? '\x1bc' : 'c');
                event.preventDefault();
            }, true);
        },
        onData: (fn: (data: string) => void) => { onData = fn; return disposable; }, onBinary: () => disposable,
        onScroll: (fn: () => void) => { onScroll = fn; return disposable; },
        write: (data: Uint8Array, callback: () => void) => { writes.push(data); callback(); }, reset: vi.fn(),
        resize: vi.fn((cols: number, rows: number) => { terminal.cols = cols; terminal.rows = rows; }),
        focus: vi.fn(() => area.focus()), blur: vi.fn(() => area.blur()), getSelection: vi.fn(() => 'selected text'),
        paste: vi.fn((text: string) => { onUserInput(); onData(`\x1b[200~${text}\x1b[201~`); }),
        scrollToLine: vi.fn(), select: vi.fn(), dispose: vi.fn()
    };
    const session = { id: 'terminal-session', write: vi.fn(), writeDirect: vi.fn(), resize: vi.fn(), setCellHeight: vi.fn(), dispose: vi.fn() };
    let callbacks: { onFrame: (frame: unknown) => Promise<void>; onAction: (action: unknown) => unknown };
    const api = { ready: Promise.resolve(), visible, state: {}, setState: vi.fn(async () => {}), onContext: (callback: typeof onContext) => { onContext = callback; return () => {}; }, terminal: {
        attach: vi.fn(async (options: typeof callbacks) => {
            callbacks = options;
            await options.onFrame({ type: 'presentation', value: { focused: true, visible } });
            await options.onFrame({ type: 'replay', data: new Uint8Array([65]) });
            return session;
        })
    } };
    const diagnostics = await mountTerminalLab(terminal, api, root);
    cleanups.push(diagnostics.dispose);
    return { terminal, session, root, area, api, diagnostics, callbacks: callbacks!, observe, disconnect, writes,
        protocol: (data: string) => onData(data), userInput: (data: string) => { onUserInput(); onData(data); }, context: (value: { visible: boolean }) => onContext(value),
        scroll: () => onScroll() };
}

describe('Terminal Lab presentation and public SDK actions', () => {
    it.each([
        ['c', { ctrl: true, alt: false }, '\x03'],
        ['[', { ctrl: true, alt: false }, '\x1b'],
        ['\\', { ctrl: true, alt: false }, '\x1c'],
        [']', { ctrl: true, alt: false }, '\x1d'],
        ['_', { ctrl: true, alt: false }, '\x1f'],
        ['@', { ctrl: true, alt: false }, '\x00'],
        ['/', { ctrl: false, alt: true }, '\x1b/'],
        ['?', { ctrl: false, alt: true }, '\x1b?'],
        ['|', { ctrl: false, alt: true }, '\x1b|'],
        ['@', { ctrl: false, alt: true }, '\x1b@'],
        ['x', { ctrl: false, alt: true }, '\x1bx'],
        ['X', { ctrl: false, alt: true }, '\x1bX']
    ])('encodes phone beforeinput %s with %j through the pinned xterm keyboard', async (data, modifiers, expected) => {
        const h = await fixture(true, true, 'xterm');
        h.callbacks.onAction({ type: 'modifiers', ...modifiers });
        const input = new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true, cancelable: true });
        h.area.dispatchEvent(input);
        expect(input.defaultPrevented).toBe(true);
        expect(h.session.write.mock.calls).toEqual([[expected]]);
        expect(h.session.writeDirect).not.toHaveBeenCalled();
        expect(h.diagnostics.modifiers).toEqual({ ctrl: false, alt: false });
        h.area.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', bubbles: true }));
        expect(h.session.write.mock.calls).toEqual([[expected], ['x']]);
    });

    it.each(['é', '🐙', '日本語', ';'])('preserves phone text %s when xterm cannot encode its armed Control modifier', async data => {
        const h = await fixture(true, true, 'xterm');
        h.callbacks.onAction({ type: 'modifiers', ctrl: true, alt: false });
        const input = new InputEvent('beforeinput', { data, inputType: 'insertText', bubbles: true, cancelable: true });
        h.area.dispatchEvent(input);
        expect(input.defaultPrevented).toBe(false);
        expect(h.session.write).not.toHaveBeenCalled();
        h.area.dispatchEvent(new InputEvent('input', { data, inputType: 'insertText', bubbles: true }));
        expect(h.session.write.mock.calls).toEqual([[data]]);
    });

    it('maps a software-keyboard keydown without a code and leaves physical key positions intact', async () => {
        const h = await fixture(true, true, 'xterm');
        for (const init of [{ key: 'X' }, { key: '?', code: 'Slash', shiftKey: true }]) {
            h.callbacks.onAction({ type: 'modifiers', ctrl: false, alt: true });
            const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
            h.area.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        }
        expect(h.session.write.mock.calls).toEqual([['\x1bX'], ['\x1b?']]);
    });

    it('keeps SGR mouse reports direct across a native listener microtask checkpoint without capturing later parser replies', async () => {
        const h = await fixture();
        h.root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        // Native dispatch may run microtasks between document capture and xterm's
        // target handler. A synchronous JS dispatchEvent stack alone misses this.
        await Promise.resolve();
        const reports = ['\x1b[<0;9;5M', '\x1b[<0;9;5m'];
        for (const report of reports) expect(h.terminal._core.coreMouseService.triggerMouseEvent(report)).toBe(true);
        expect(h.session.write).not.toHaveBeenCalled();
        expect(h.session.writeDirect.mock.calls).toEqual(reports.map(report => [report, undefined]));
        h.terminal.write = (_data, callback) => { h.protocol('\x1b[1;1R'); callback(); };
        await h.callbacks.onFrame({ type: 'output', data: new Uint8Array([27, 91, 54, 110]) });
        expect(h.session.writeDirect).toHaveBeenLastCalledWith('\x1b[1;1R', { response: true });
        h.callbacks.onAction({ type: 'paste', text: reports[0] });
        expect(h.session.write).toHaveBeenLastCalledWith(`\x1b[200~${reports[0]}\x1b[201~`);
    });

    it.each([
        [{ ctrl: true, alt: false }, '\x03'], [{ ctrl: false, alt: true }, '\x1bc']
    ])('intercepts an armed phone modifier before xterm’s earlier textarea capture handler (%j)', async (modifiers, expected) => {
        const h = await fixture(true, true, true);
        h.callbacks.onAction({ type: 'modifiers', ...modifiers });
        const key = () => new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', keyCode: 67, bubbles: true, cancelable: true });
        const modified = key(); h.area.dispatchEvent(modified);
        expect(modified.defaultPrevented).toBe(true);
        expect(h.session.write.mock.calls).toEqual([[expected]]);
        expect(h.diagnostics.modifiers).toEqual({ ctrl: false, alt: false });
        h.area.dispatchEvent(key());
        expect(h.session.write.mock.calls).toEqual([[expected], ['c']]);
        expect(h.session.writeDirect).not.toHaveBeenCalled();
    });

    it('never steals caret ownership on presentation refreshes and reads live selection', async () => {
        const h = await fixture();
        expect(document.body.dataset.ready).toBe('true');
        expect(h.terminal.focus).not.toHaveBeenCalled();
        expect(h.callbacks.onAction({ type: 'selection' })).toBe('selected text');
        h.callbacks.onAction({ type: 'focus' }); expect(h.terminal.focus).toHaveBeenCalledTimes(1);
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: true, visible: true, fontSize: 15, paddingX: 6, paddingY: 4, accessibilityName: 'Build output', theme: { foreground: '#abc' } } });
        expect(h.terminal.focus).toHaveBeenCalledTimes(1);
        expect(h.area.getAttribute('aria-label')).toBe('Build output');
        expect(h.terminal.options).toMatchObject({ fontSize: 15, theme: { foreground: '#abc' } });
        expect(h.session.resize).toHaveBeenLastCalledWith(96, 29);
    });

    it('uses an explicit phone keyboard action and keeps logical focus from raising it', async () => {
        const h = await fixture(true);
        expect(h.area.inputMode).toBe('none');
        h.callbacks.onAction({ type: 'focus' });
        expect(h.terminal.focus).not.toHaveBeenCalled(); expect(document.activeElement).toBe(h.root);
        h.callbacks.onAction({ type: 'showKeyboard' });
        expect(h.area.inputMode).toBe('text'); expect(document.activeElement).toBe(h.area);
        h.callbacks.onAction({ type: 'hideKeyboard' });
        expect(h.area.inputMode).toBe('none'); expect(document.activeElement).toBe(h.root);
    });

    it('attaches while hidden without claiming measured geometry, then fits and observes only when visible', async () => {
        const h = await fixture(false, false);
        expect(h.api.terminal.attach).toHaveBeenCalledWith(expect.objectContaining({ cols: 80, rows: 24 }));
        expect(h.session.resize).not.toHaveBeenCalled(); expect(h.session.setCellHeight).not.toHaveBeenCalled(); expect(h.observe).not.toHaveBeenCalled();
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: false, visible: true } });
        expect(h.observe).toHaveBeenCalledTimes(1); expect(h.session.resize).toHaveBeenCalled(); expect(h.session.setCellHeight).toHaveBeenCalledWith(16);
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: false, visible: false } });
        expect(h.disconnect).toHaveBeenCalledTimes(1);
        const count = h.session.resize.mock.calls.length; h.diagnostics.fit(); expect(h.session.resize).toHaveBeenCalledTimes(count);
    });

    it('reapplies repeated search reveals by sequence, preserves negotiated modes, and pastes through the emulator', async () => {
        const h = await fixture();
        const presentation = { focused: true, visible: true, reveal: { linesFromBottom: 10, col: 2, length: 4, seq: 1 } };
        await h.callbacks.onFrame({ type: 'presentation', value: presentation });
        await h.callbacks.onFrame({ type: 'presentation', value: presentation });
        expect(h.terminal.select).toHaveBeenCalledTimes(1);
        await h.callbacks.onFrame({ type: 'presentation', value: { ...presentation, reveal: { ...presentation.reveal, seq: 2 } } });
        expect(h.terminal.select).toHaveBeenCalledTimes(2); expect(h.diagnostics.revealCount).toBe(2);
        const modes = { bracketedPaste: true, applicationCursorKeys: true, kittyKeyboardFlags: 3 };
        await h.callbacks.onFrame({ type: 'modes', modes }); expect(h.diagnostics.modes).toEqual(modes);
        expect(h.callbacks.onAction({ type: 'paste', text: '\x1b[<0;1;1M' })).toBe(true);
        expect(h.session.write).toHaveBeenLastCalledWith('\x1b[200~\x1b[<0;1;1M\x1b[201~');
        expect(h.session.writeDirect).not.toHaveBeenCalled();
    });

    it('applies streamed modes immediately and restores the latest modes during and after a later replay', async () => {
        const h = await fixture(), core = h.terminal._core, release: (() => void)[] = [];
        const modes = { bracketedPaste: true, applicationCursorKeys: true, mouseTracking: 'any', mouseFormat: 'sgr-pixels' };
        await h.callbacks.onFrame({ type: 'modes', modes });
        expect(core.coreMouseService).toMatchObject({ activeProtocol: 'ANY', activeEncoding: 'SGR_PIXELS' });
        h.terminal.reset.mockImplementation(() => {
            core.coreService.decPrivateModes = { applicationCursorKeys: false, bracketedPasteMode: false };
            core.coreMouseService.activeProtocol = 'NONE'; core.coreMouseService.activeEncoding = 'DEFAULT';
        });
        h.terminal.write = (_data, callback) => { release.push(callback); };
        const replay = h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]) });
        release.shift()!(); await Promise.resolve();
        expect(core.coreService.decPrivateModes).toEqual({ applicationCursorKeys: true, bracketedPasteMode: true });
        expect(core.coreMouseService).toMatchObject({ activeProtocol: 'ANY', activeEncoding: 'SGR_PIXELS' });
        // The replay itself may contain another reset; no new mode frame follows.
        h.terminal.reset(); release.shift()!(); await replay;
        expect(core.coreMouseService).toMatchObject({ activeProtocol: 'ANY', activeEncoding: 'SGR_PIXELS' });
        expect(core.coreService.decPrivateModes).toEqual({ applicationCursorKeys: true, bracketedPasteMode: true });
    });

    it('preserves keyboard and IME input during a replay while suppressing replay replies and scopes live protocol responses to output consumption', async () => {
        const h = await fixture(), release: (() => void)[] = [];
        h.terminal.write = (_data, callback) => { release.push(callback); };
        const replay = h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]) });
        h.callbacks.onAction({ type: 'paste', text: 'typed during replay' });
        h.userInput('日本語'); h.protocol('\x1b[1;1R');
        expect(h.session.write.mock.calls).toEqual([['\x1b[200~typed during replay\x1b[201~'], ['日本語']]);
        expect(h.session.writeDirect).not.toHaveBeenCalled();
        release.shift()!(); await Promise.resolve(); release.shift()!(); await replay;
        h.terminal.write = (_data, callback) => { h.protocol('\x1b[1;1R'); callback(); };
        await h.callbacks.onFrame({ type: 'output', data: new Uint8Array([27, 91, 54, 110]) });
        expect(h.session.writeDirect).toHaveBeenLastCalledWith('\x1b[1;1R', { response: true });
        h.protocol('\x1b[I');
        expect(h.session.writeDirect).toHaveBeenLastCalledWith('\x1b[I', undefined);
    });

    it('dispatches real key events with xterm keyCode and consumes phone modifiers once without intercepting composition', async () => {
        const h = await fixture(true), seen: KeyboardEvent[] = [];
        h.area.addEventListener('keydown', event => {
            seen.push(event);
            if (event.keyCode === 13) { h.userInput('\r'); event.preventDefault(); }
            if (event.keyCode === 67 && event.ctrlKey) { h.userInput('\x03'); event.preventDefault(); }
        });
        expect(h.callbacks.onAction({ type: 'dispatchKey', key: { key: 'Enter' } })).toBe(true);
        expect(seen.at(-1)?.keyCode).toBe(13); expect(h.session.write).toHaveBeenLastCalledWith('\r');
        h.callbacks.onAction({ type: 'modifiers', ctrl: true, alt: false });
        h.area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        h.area.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
        expect(h.diagnostics.modifiers.ctrl).toBe(true);
        h.area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        h.area.dispatchEvent(new InputEvent('beforeinput', { data: 'c', inputType: 'insertText', bubbles: true, cancelable: true }));
        expect(h.session.write).toHaveBeenLastCalledWith('\x03'); expect(seen.at(-1)?.keyCode).toBe(67);
        expect(h.diagnostics.modifiers).toEqual({ ctrl: false, alt: false });
        const count = h.session.write.mock.calls.length;
        h.area.dispatchEvent(new InputEvent('beforeinput', { data: 'c', inputType: 'insertText', bubbles: true, cancelable: true }));
        expect(h.session.write).toHaveBeenCalledTimes(count);
    });
});

/**
 * Owner-grid mirroring. A client that does not size the process receives bytes composed for
 * somebody else's grid, including a replay the serializer wrote with no newline between a
 * soft-wrapped row and its continuation. The measured box is 800x480 with an 8x16 cell and a
 * 14-pixel scrollbar gutter, so this view's OWN grid is 98x30 throughout.
 */
describe('Terminal Lab owner-grid mirroring', () => {
    const owner = (visible = true) => ({ focused: true, visible, ownsSize: false });

    it('resizes the emulator to the stated grid before the replay bytes are written', async () => {
        const h = await fixture();
        const order: string[] = [];
        h.terminal.resize.mockImplementation((cols: number, rows: number) => { order.push(`resize ${String(cols)}x${String(rows)}`); h.terminal.cols = cols; h.terminal.rows = rows; });
        h.terminal.reset.mockImplementation(() => order.push('reset'));
        h.terminal.write = (data: Uint8Array, callback: () => void) => { order.push(`write ${String(data.length)}`); callback(); };
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65, 66]), grid: { cols: 40, rows: 12 } });
        // The in-band cancel/reset must land on an emulator that is already the owner's shape.
        expect(order).toEqual(['resize 40x12', 'write 3', 'reset', 'write 2']);
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        expect(document.body.dataset.mirror).toBe('40x12');
        expect(h.diagnostics.mirror).toEqual({ cols: 40, rows: 12 });
    });

    it('ignores a stated grid for sizing while this view owns the process size', async () => {
        const h = await fixture();
        for (const value of [{ focused: true, visible: true, ownsSize: true }, { focused: true, visible: true }]) {
            await h.callbacks.onFrame({ type: 'presentation', value });
            const resizes = h.terminal.resize.mock.calls.length;
            await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
            expect(h.terminal.resize).toHaveBeenCalledTimes(resizes);
            expect([h.terminal.cols, h.terminal.rows]).toEqual([98, 30]);
            expect(document.body.dataset.mirror).toBeUndefined();
            expect(h.diagnostics.mirror).toBeNull();
        }
    });

    it('leaves the emulator alone when a non-owner replay states no grid', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        const resizes = h.terminal.resize.mock.calls.length;
        // `null` is a daemon that states none, and an absent field is a host that predates it.
        for (const frame of [{ type: 'replay', data: new Uint8Array([65]), grid: null }, { type: 'replay', data: new Uint8Array([65]) }]) {
            await h.callbacks.onFrame(frame);
            expect(h.terminal.resize).toHaveBeenCalledTimes(resizes);
            expect([h.terminal.cols, h.terminal.rows]).toEqual([98, 30]);
            expect(document.body.dataset.mirror).toBeUndefined();
            expect(h.diagnostics.mirror).toBeNull();
        }
    });

    it('keeps measuring and reporting its own box while mirroring, never the mirrored grid', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        h.session.resize.mockClear();
        vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 240 } as DOMRect);
        h.diagnostics.fit();
        expect(h.session.resize.mock.calls).toEqual([[48, 15]]);
        expect(h.diagnostics.measured).toMatchObject({ cols: 48, rows: 15 });
        // The emulator stays at the owner's grid: the report is a measurement, not the mirror.
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        expect(document.body.dataset.mirror).toBe('40x12');
    });

    it('returns the emulator to its own measurement when size control comes back, without reporting again', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        expect(h.terminal.cols).toBe(40);
        h.session.resize.mockClear();
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: true, visible: true, ownsSize: true } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([98, 30]);
        expect(document.body.dataset.mirror).toBeUndefined();
        expect(h.diagnostics.mirror).toBeNull();
        // The host issues the forced size claim for this transition; the renderer must not spam.
        expect(h.session.resize).not.toHaveBeenCalled();
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([98, 30]);
    });

    it('keeps the mirror when the box is remeasured mid-replay, and still reports the new measurement', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        h.session.resize.mockClear();
        const release: (() => void)[] = [];
        h.terminal.write = (_data: Uint8Array, callback: () => void) => { release.push(callback); };
        const replay = h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([66]), grid: { cols: 52, rows: 18 } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([52, 18]);
        // The observer fires between the replay's awaits: a drag, or the window settling.
        vi.spyOn(h.root, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 240 } as DOMRect);
        h.diagnostics.fit();
        expect([h.terminal.cols, h.terminal.rows]).toEqual([52, 18]);
        expect(h.session.resize.mock.calls).toEqual([[48, 15]]);
        release.shift()!(); await Promise.resolve(); release.shift()!(); await replay;
        expect([h.terminal.cols, h.terminal.rows]).toEqual([52, 18]);
        expect(document.body.dataset.mirror).toBe('52x18');
        expect(h.diagnostics.measured).toMatchObject({ cols: 48, rows: 15 });
    });

    it('un-mirrors a view that attached hidden and has no measurement to go back to', async () => {
        const h = await fixture(false, false);
        await h.callbacks.onFrame({ type: 'presentation', value: owner(false) });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: false, visible: false, ownsSize: true } });
        expect(h.diagnostics.mirror).toBeNull();
        expect(document.body.dataset.mirror).toBeUndefined();
        // Nothing to move the emulator to, and a hidden view still reports nothing. It renders the
        // owner's replay at its attach grid until its first real measurement.
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        expect(h.session.resize).not.toHaveBeenCalled();
        await h.callbacks.onFrame({ type: 'presentation', value: { focused: false, visible: true, ownsSize: true } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([98, 30]);
        expect(h.session.resize.mock.calls).toEqual([[98, 30]]);
    });

    it('reads the scroll position before the mirror resize moves the buffer', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        // Ten lines above the bottom when the replay arrives.
        h.terminal.buffer.active.viewportY = 116;
        // A real emulator reflows on a grid change, so the resize moves the base line under us.
        h.terminal.resize.mockImplementation((cols: number, rows: number) => {
            h.terminal.cols = cols; h.terminal.rows = rows; h.terminal.buffer.active.baseY = 130;
        });
        h.terminal.scrollToLine.mockClear();
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        // 130 - 10: the offset is the one measured BEFORE the resize, applied to the new base.
        expect(h.terminal.scrollToLine).toHaveBeenCalledWith(120);
    });

    it('does not save a scroll position armed by the mirror resize itself', async () => {
        const h = await fixture();
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        h.api.setState.mockClear();
        // A real emulator moves its viewport when the row count changes, which fires onScroll.
        h.terminal.resize.mockImplementation((cols: number, rows: number) => {
            h.terminal.cols = cols; h.terminal.rows = rows; h.scroll();
        });
        vi.useFakeTimers();
        try {
            await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
            vi.advanceTimersByTime(400);
            // The position belongs to the screen being replaced, so it must never be persisted.
            expect(h.api.setState).not.toHaveBeenCalled();
            // A scroll of the new screen still saves, so the guard is the replay and not the mirror.
            h.scroll(); vi.advanceTimersByTime(400);
            expect(h.api.setState).toHaveBeenCalledTimes(1);
        } finally { vi.useRealTimers(); }
    });

    it('mirrors a replay that reaches a hidden view without ever reporting a grid', async () => {
        const h = await fixture(false, false);
        expect(h.session.resize).not.toHaveBeenCalled();
        await h.callbacks.onFrame({ type: 'presentation', value: owner(false) });
        await h.callbacks.onFrame({ type: 'replay', data: new Uint8Array([65]), grid: { cols: 40, rows: 12 } });
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        expect(document.body.dataset.mirror).toBe('40x12');
        expect(h.session.resize).not.toHaveBeenCalled();
        expect(h.session.setCellHeight).not.toHaveBeenCalled();
        // Revealed while still a non-owner: the measurement is reported, the mirror stands.
        await h.callbacks.onFrame({ type: 'presentation', value: owner() });
        expect(h.session.resize.mock.calls).toEqual([[98, 30]]);
        expect(h.session.setCellHeight).toHaveBeenCalledWith(16);
        expect([h.terminal.cols, h.terminal.rows]).toEqual([40, 12]);
        expect(h.diagnostics.mirror).toEqual({ cols: 40, rows: 12 });
    });
});
