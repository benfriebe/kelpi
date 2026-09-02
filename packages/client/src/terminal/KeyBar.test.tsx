/**
 * The phone key bar (C1, docs/MOBILE-PLAN.md §4).
 *
 * Two halves, and the first one is the reason the second one is allowed to be small.
 *
 * **The bytes are measured against the REAL engine.** The routing decision in MOBILE-PLAN.md §7
 * says a synthesized `KeyboardEvent` on the engine's own textarea is byte-identical to a physical
 * key; a test that asserts that against a fake proves nothing, because the fake has no encoder.
 * So this file opens the vendored ghostty-web (its WASM loads in Node perfectly well) over a stub
 * 2D context - the ONLY thing jsdom is missing - and reads the bytes off `renderer.onData`. What
 * comes out is libghostty's own key encoder, with DECCKM synced from the live VT, which is the
 * whole claim.
 *
 * The second half is the component: what renders, when, and what a tap does to the caret. That
 * runs on the fake renderer like every other pane test.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KEY_BAR_HEIGHT_PX, KEY_BAR_KEYS, KEY_BAR_KEY_SIZE_PX, withSticky } from './KeyBar';
import { TerminalPane } from './TerminalPane';
import { createTerminalRenderer } from './renderer';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

// ── the stub canvas ─────────────────────────────────────────────────────────────────
//
// jsdom throws "Not implemented: HTMLCanvasElement.prototype.getContext" without the optional
// `canvas` package, and that single hole is all that stops the engine opening here: the WASM
// initialises, the Terminal constructs, the input handler attaches and the encoder runs. A
// no-op context lets `open()` through so the KEY PATH can be measured. Nothing about painting is
// asserted here - the audit's terminal steps own pixels, and this file owns bytes.

let realGetContext: unknown;
let realRaf: unknown;
let realCaf: unknown;

function installStubCanvas(): void {
    const context = new Proxy({} as Record<string, unknown>, {
        get(target, property) {
            if (property in target) return target[property as string];
            if (property === 'measureText') {
                return () => ({ width: 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
            }
            if (property === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
            if (property === 'createLinearGradient') return () => ({ addColorStop: () => undefined });
            if (property === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
            return () => undefined;
        },
        set(target, property, value) {
            target[property as string] = value;
            return true;
        }
    });
    realGetContext = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = (): unknown => context;
    const global = globalThis as Record<string, unknown>;
    realRaf = global['requestAnimationFrame'];
    realCaf = global['cancelAnimationFrame'];
    global['requestAnimationFrame'] = (callback: FrameRequestCallback): number =>
        setTimeout(() => callback(0), 0) as unknown as number;
    global['cancelAnimationFrame'] = (handle: number): void => clearTimeout(handle);
}

function restoreCanvas(): void {
    (HTMLCanvasElement.prototype as unknown as Record<string, unknown>)['getContext'] = realGetContext;
    const global = globalThis as Record<string, unknown>;
    global['requestAnimationFrame'] = realRaf;
    global['cancelAnimationFrame'] = realCaf;
}

/** Bytes as hex pairs, so a failure reads like a wire dump instead of like mojibake. */
function hex(data: string): string {
    return [...new TextEncoder().encode(data)].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

const ESC = '';

describe('the key bar routes through the ENGINE: bytes off a real ghostty-web', () => {
    beforeAll(installStubCanvas);
    afterAll(restoreCanvas);

    let host: HTMLElement;
    let renderer: ReturnType<typeof createTerminalRenderer>;
    let out: string[];

    beforeEach(async () => {
        host = document.createElement('div');
        document.body.appendChild(host);
        renderer = createTerminalRenderer({ cols: 40, rows: 8 });
        await renderer.open(host);
        out = [];
        renderer.onData((data) => out.push(data));
    });

    afterEach(() => {
        renderer.dispose();
        host.remove();
    });

    /** Let the VT parse a mode change before the next key is encoded. */
    async function writeAndSettle(data: string): Promise<void> {
        renderer.write(data);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }

    it('opens the vendored engine and finds its hidden textarea to dispatch on', () => {
        expect(renderer.engine).toBe('ghostty');
        expect(host.querySelector('textarea')).not.toBeNull();
        expect(host.querySelector('canvas')).not.toBeNull();
    });

    /**
     * The byte table the brief asked for, in NORMAL mode.
     *
     * These are the legacy encodings ghostty produces for a physical key, and every one of them
     * comes out of the WASM encoder here without this repo writing a single escape sequence.
     */
    it.each([
        ['esc', { key: 'Escape', code: 'Escape' }, ESC],
        ['tab', { key: 'Tab', code: 'Tab' }, '\t'],
        ['up', { key: 'ArrowUp', code: 'ArrowUp' }, `${ESC}[A`],
        ['down', { key: 'ArrowDown', code: 'ArrowDown' }, `${ESC}[B`],
        ['right', { key: 'ArrowRight', code: 'ArrowRight' }, `${ESC}[C`],
        ['left', { key: 'ArrowLeft', code: 'ArrowLeft' }, `${ESC}[D`],
        ['home', { key: 'Home', code: 'Home' }, `${ESC}[H`],
        ['end', { key: 'End', code: 'End' }, `${ESC}[F`],
        ['minus', { key: '-', code: 'Minus' }, '-'],
        ['slash', { key: '/', code: 'Slash' }, '/'],
        ['pipe', { key: '|', code: 'Backslash', shiftKey: true }, '|'],
        ['ctrl+c', { key: 'c', code: 'KeyC', ctrlKey: true }, '']
    ])('%s encodes to the bytes a physical key produces', (_id, init, expected) => {
        expect(renderer.dispatchKey(init)).toBe(true);
        expect(hex(out.join(''))).toBe(hex(expected));
    });

    /** Ctrl+C is the interrupt the live step taps, and 0x03 is the only acceptable answer. */
    it('Ctrl+C is one byte, 0x03', () => {
        renderer.dispatchKey({ key: 'c', code: 'KeyC', ctrlKey: true });
        expect(out.join('')).toBe('');
        expect(hex(out.join(''))).toBe('03');
    });

    /**
     * APPLICATION CURSOR MODE, which is the whole reason the bar sends keys and not bytes.
     *
     * `ESC [ ? 1 h` is DECCKM. The engine syncs it into the encoder before every encode
     * (`input-handler.ts:436-439`), so the same tap that produced `CSI A` a moment ago produces
     * `SS3 A` now, and the bar never learns that either mode exists.
     */
    it('ArrowUp follows DECCKM: CSI A normally, SS3 A under application-cursor mode', async () => {
        renderer.dispatchKey({ key: 'ArrowUp', code: 'ArrowUp' });
        expect(hex(out.join(''))).toBe(hex(`${ESC}[A`));

        out.length = 0;
        await writeAndSettle(`${ESC}[?1h`);
        renderer.dispatchKey({ key: 'ArrowUp', code: 'ArrowUp' });
        expect(hex(out.join(''))).toBe(hex(`${ESC}OA`));

        out.length = 0;
        await writeAndSettle(`${ESC}[?1l`);
        renderer.dispatchKey({ key: 'ArrowUp', code: 'ArrowUp' });
        expect(hex(out.join(''))).toBe(hex(`${ESC}[A`));
    });

    it('every arrow follows DECCKM, not just Up', async () => {
        await writeAndSettle(`${ESC}[?1h`);
        for (const [code, letter] of [
            ['ArrowUp', 'A'],
            ['ArrowDown', 'B'],
            ['ArrowRight', 'C'],
            ['ArrowLeft', 'D']
        ] as const) {
            out.length = 0;
            renderer.dispatchKey({ key: code, code });
            expect(hex(out.join(''))).toBe(hex(`${ESC}O${letter}`));
        }
    });

    /**
     * IDENTICAL, not merely equivalent: the same `KeyboardEvent` raised by hand at the textarea -
     * which is what the browser does for a physical key - produces the same bytes.
     */
    it('produces exactly what a hand-raised event on the textarea produces', () => {
        const area = host.querySelector('textarea') as HTMLTextAreaElement;
        for (const key of KEY_BAR_KEYS) {
            if (key.init === undefined) continue;
            out.length = 0;
            renderer.dispatchKey(key.init);
            const viaBar = out.join('');

            out.length = 0;
            area.dispatchEvent(new KeyboardEvent('keydown', { ...key.init, bubbles: true, cancelable: true }));
            const viaDom = out.join('');

            expect(`${key.id}: ${hex(viaBar)}`).toBe(`${key.id}: ${hex(viaDom)}`);
            expect(viaBar.length).toBeGreaterThan(0);
        }
    });

    it('answers false rather than throwing once the renderer is gone', () => {
        renderer.dispose();
        expect(renderer.dispatchKey({ key: 'Escape', code: 'Escape' })).toBe(false);
    });
});

// ── the component ───────────────────────────────────────────────────────────────────

/** jsdom reports 0x0 for everything; the pane takes its box through this seam. */
function box(width: number, height: number): () => { width: number; height: number } {
    return () => ({ width, height });
}

let observers: ReturnType<typeof installFakeResizeObserver>;

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/**
 * `?form=phone` is E1's own test seam (`chrome/form-factor.ts` - the override wins outright), and
 * it is what the phone audit lane keeps in reserve. Using it here keeps these tests about the KEY
 * BAR rather than about media-query plumbing, which `form-factor.test.ts` already owns.
 */
function setFormFactor(value: 'phone' | 'desktop' | null): void {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete('form');
    else url.searchParams.set('form', value);
    window.history.replaceState(null, '', url.toString());
}

interface Harness {
    pty: ReturnType<typeof createFakePtyApi>;
    renderers: ReturnType<typeof createFakeRendererFactory>;
    root: HTMLElement;
    host: HTMLElement;
    /** Stands in for the engine's hidden input; the fake renderer has no DOM of its own. */
    area: HTMLTextAreaElement;
    bar: HTMLElement | null;
    key(id: string): HTMLButtonElement;
    rerender(props: { focused?: boolean; visible?: boolean }): Promise<void>;
    setKittyFlags(flags: number): void;
}

async function mountPane({ focused = true, visible = true } = {}): Promise<Harness> {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
    const element = (props: { focused: boolean; visible: boolean }): React.ReactElement => (
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused={props.focused}
            visible={props.visible}
            createRenderer={renderers.factory}
            measure={box(390, 600)}
        />
    );
    const view = render(element({ focused, visible }));
    await settle();
    const root = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
    const host = root.querySelector('[data-terminal-host]') as HTMLElement;
    const area = document.createElement('textarea');
    host.appendChild(area);
    area.focus();
    return {
        pty,
        renderers,
        root,
        host,
        area,
        get bar(): HTMLElement | null {
            return root.querySelector('[data-terminal-key-bar]');
        },
        key(id: string): HTMLButtonElement {
            const button = root.querySelector(`[data-terminal-key="${id}"]`);
            if (button === null) throw new Error(`no key bar button for ${id}`);
            return button as HTMLButtonElement;
        },
        async rerender(next): Promise<void> {
            view.rerender(element({ focused: next.focused ?? focused, visible: next.visible ?? visible }));
            await settle();
        },
        setKittyFlags(flags: number): void {
            act(() => {
                pty.last().modes({ kittyKeyboardFlags: flags });
            });
        }
    };
}

/** A tap: the pointer-down the bar suppresses, then the click the browser raises anyway. */
function tap(button: HTMLElement): void {
    act(() => {
        fireEvent.pointerDown(button);
        fireEvent.mouseDown(button);
        fireEvent.click(button);
    });
}

describe('KeyBar in a terminal pane', () => {
    beforeEach(() => {
        observers = installFakeResizeObserver();
        setFormFactor('phone');
    });

    afterEach(() => {
        cleanup();
        observers.restore();
        setFormFactor(null);
        vi.restoreAllMocks();
    });

    it('renders above the terminal on a phone, with the keys the brief names', async () => {
        const h = await mountPane();
        const bar = h.bar;
        expect(bar).not.toBeNull();
        expect(bar?.getAttribute('role')).toBe('toolbar');
        expect([...(bar?.querySelectorAll('[data-terminal-key]') ?? [])].map((el) => el.getAttribute('data-terminal-key'))).toEqual([
            'esc',
            'tab',
            'ctrl',
            'alt',
            'left',
            'down',
            'up',
            'right',
            'home',
            'end',
            'minus',
            'slash',
            'pipe',
            'paste',
            'hide-keyboard'
        ]);
        // Every key is named and tooltipped, the rule the audit already enforces on pane headers.
        for (const button of bar?.querySelectorAll('button') ?? []) {
            expect(button.getAttribute('aria-label')?.length ?? 0).toBeGreaterThan(0);
            expect(button.getAttribute('title')?.length ?? 0).toBeGreaterThan(0);
        }
    });

    it('gives every key a 44 px touch target and the bar a 45 px box', async () => {
        const h = await mountPane();
        expect(h.bar?.style.height).toBe(`${KEY_BAR_HEIGHT_PX}px`);
        expect(KEY_BAR_HEIGHT_PX).toBe(KEY_BAR_KEY_SIZE_PX + 1);
        for (const button of h.bar?.querySelectorAll('button') ?? []) {
            const style = (button as HTMLElement).style;
            expect(style.height).toBe(`${KEY_BAR_KEY_SIZE_PX}px`);
            expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(KEY_BAR_KEY_SIZE_PX);
        }
    });

    /**
     * IN-FLOW, not fixed (MOBILE-PLAN.md §7, "Keyboard inset ownership"). The host becomes a flex
     * child that may shrink, so the bar's 45 px come off the terminal through the resize path the
     * pane already has - and C2's software-keyboard inset composes with it without either lane
     * knowing about the other.
     */
    it('shrinks the terminal host instead of floating over it', async () => {
        const h = await mountPane();
        expect(h.root.className).toContain('flex-col');
        expect(h.host.className).toContain('flex-1');
        expect(h.host.className).toContain('min-h-0');
        expect(h.bar?.style.position).toBe('');
        expect(h.bar?.className).toContain('shrink-0');
    });

    it('AND NOT ON DESKTOP: the same pane renders exactly what it renders today', async () => {
        setFormFactor('desktop');
        const h = await mountPane();
        expect(h.bar).toBeNull();
        expect(h.root.className).toBe('relative h-full w-full overflow-hidden ');
        expect(h.host.className).toBe('h-full w-full');
    });

    it('does not render for an unfocused pane, and comes back when focus returns', async () => {
        const h = await mountPane({ focused: false });
        expect(h.bar).toBeNull();
        await h.rerender({ focused: true });
        expect(h.bar).not.toBeNull();
    });

    it('does not render for a pane that is off screen', async () => {
        const h = await mountPane({ visible: false });
        expect(h.bar).toBeNull();
    });

    it('sends a key through the renderer, as a keydown on the engine input', async () => {
        const h = await mountPane();
        const seen: { key: string; code: string }[] = [];
        h.host.addEventListener('keydown', (event) => seen.push({ key: event.key, code: event.code }));

        tap(h.key('esc'));
        tap(h.key('up'));
        tap(h.key('pipe'));

        expect(h.renderers.last().keys.map((init) => init.key)).toEqual(['Escape', 'ArrowUp', '|']);
        // …and each one really was an event on the engine's input, not a recorded intention.
        expect(seen).toEqual([
            { key: 'Escape', code: 'Escape' },
            { key: 'ArrowUp', code: 'ArrowUp' },
            { key: '|', code: 'Backslash' }
        ]);
    });

    /**
     * THE TAP MUST NOT TAKE THE CARET. A button that steals focus dismisses the software keyboard,
     * so the first tap on Esc would close the thing the bar exists to sit above.
     */
    it('leaves the caret on the engine textarea after a tap', async () => {
        const h = await mountPane();
        expect(document.activeElement).toBe(h.area);
        tap(h.key('esc'));
        expect(document.activeElement).toBe(h.area);
        tap(h.key('ctrl'));
        expect(document.activeElement).toBe(h.area);
    });

    /**
     * …and if the platform moves it anyway, the bar hands it straight back. A touch tap sets focus
     * from the tap GESTURE, which a cancelled pointer-down does not always reach, so the caret the
     * finger came down on is remembered and restored. Simulated here by focusing the button in
     * the middle of the tap, which is exactly what the recognizer does.
     */
    it('hands the caret back when the platform focuses the button anyway', async () => {
        const h = await mountPane();
        const esc = h.key('esc');
        act(() => {
            fireEvent.pointerDown(esc);
            esc.focus();
            fireEvent.click(esc);
        });
        expect(document.activeElement).toBe(h.area);
        expect(h.renderers.last().keys).toEqual([expect.objectContaining({ key: 'Escape' })]);
    });

    it('latches Ctrl, applies it to the next bar key, and releases', async () => {
        const h = await mountPane();
        const ctrl = h.key('ctrl');
        expect(ctrl.getAttribute('aria-pressed')).toBe('false');

        tap(ctrl);
        expect(ctrl.getAttribute('aria-pressed')).toBe('true');
        tap(h.key('esc'));
        expect(ctrl.getAttribute('aria-pressed')).toBe('false');

        const [escape, ...rest] = h.renderers.last().keys;
        expect(rest).toEqual([]);
        expect(escape?.ctrlKey).toBe(true);

        // …and the key after it is plain again.
        tap(h.key('esc'));
        expect(h.renderers.last().keys[1]?.ctrlKey).toBe(false);
    });

    /**
     * The case the live step taps: Ctrl from the bar, `c` from the SOFTWARE keyboard. The bar
     * intercepts the next keydown on the pane root, cancels it, and re-raises it with the
     * modifier - which is how a phone gets an interrupt at all.
     */
    it('applies a latched Ctrl to the next key typed on the software keyboard', async () => {
        const h = await mountPane();
        const seen: { key: string; ctrlKey: boolean }[] = [];
        h.host.addEventListener('keydown', (event) => seen.push({ key: event.key, ctrlKey: event.ctrlKey }));

        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
        });

        expect(h.renderers.last().keys).toEqual([
            expect.objectContaining({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: false })
        ]);
        // The raw key was cancelled, so the engine sees the modified one and only that one.
        expect(seen).toEqual([{ key: 'c', ctrlKey: true }]);
        expect(h.key('ctrl').getAttribute('aria-pressed')).toBe('false');

        // Spent: the next physical key is untouched and is not re-raised.
        h.renderers.last().keys.length = 0;
        act(() => {
            fireEvent.keyDown(h.area, { key: 'd', code: 'KeyD' });
        });
        expect(h.renderers.last().keys).toEqual([]);
    });

    /**
     * The duplicate the live run found on 2026-09-03: a keystroke whose keydown was consumed can
     * still raise a `beforeinput`, and the engine's own dedupe cannot recognise it (it compares
     * against the BYTES it emitted, `0x03`, not the letter). Without this the PTY got the
     * interrupt AND the letter - `interrupt-me^C` then `sh-3.2$ cprintf …`.
     */
    it('drops the beforeinput belonging to a keystroke it already consumed', async () => {
        const h = await mountPane();
        const inserted: (string | null)[] = [];
        h.area.addEventListener('beforeinput', (event) => inserted.push((event as InputEvent).data));

        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
            fireEvent(h.area, new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'c', inputType: 'insertText' }));
        });

        expect(inserted).toEqual([]);
        expect(h.renderers.last().keys).toEqual([expect.objectContaining({ key: 'c', ctrlKey: true })]);
    });

    it('leaves an unrelated beforeinput alone: plain typing is untouched', async () => {
        const h = await mountPane();
        const inserted: (string | null)[] = [];
        h.area.addEventListener('beforeinput', (event) => inserted.push((event as InputEvent).data));

        // Nothing latched: the keystroke goes straight to the engine, insertion and all.
        act(() => {
            fireEvent.keyDown(h.area, { key: 'x', code: 'KeyX' });
            fireEvent(h.area, new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'x', inputType: 'insertText' }));
        });
        expect(inserted).toEqual(['x']);

        // Latched and spent on `c`, then a DIFFERENT character arrives: also untouched.
        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
            fireEvent(h.area, new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'y', inputType: 'insertText' }));
        });
        expect(inserted).toEqual(['x', 'y']);
    });

    it('latches Alt the same way, and the two compose', async () => {
        const h = await mountPane();
        tap(h.key('ctrl'));
        tap(h.key('alt'));
        expect(h.key('alt').getAttribute('aria-pressed')).toBe('true');
        act(() => {
            fireEvent.keyDown(h.area, { key: 'x', code: 'KeyX' });
        });
        expect(h.renderers.last().keys).toEqual([
            expect.objectContaining({ key: 'x', ctrlKey: true, altKey: true })
        ]);
        expect(h.key('ctrl').getAttribute('aria-pressed')).toBe('false');
        expect(h.key('alt').getAttribute('aria-pressed')).toBe('false');
    });

    it('a second tap on a latched modifier unlatches it, and adds no listener to the pane', async () => {
        const h = await mountPane();
        tap(h.key('ctrl'));
        tap(h.key('ctrl'));
        expect(h.key('ctrl').getAttribute('aria-pressed')).toBe('false');
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
        });
        expect(h.renderers.last().keys).toEqual([]);
    });

    it('does not spend the latch on a modifier key held down on a hardware keyboard', async () => {
        const h = await mountPane();
        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
        });
        expect(h.key('ctrl').getAttribute('aria-pressed')).toBe('true');
        expect(h.renderers.last().keys).toEqual([]);
    });

    it('leaves a composing key to the IME', async () => {
        const h = await mountPane();
        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'Process', code: 'KeyA', keyCode: 229 });
        });
        expect(h.key('ctrl').getAttribute('aria-pressed')).toBe('true');
        expect(h.renderers.last().keys).toEqual([]);
    });

    it('hides the software keyboard by letting the caret go, and a tap on the terminal is the way back', async () => {
        const h = await mountPane();
        expect(document.activeElement).toBe(h.area);
        tap(h.key('hide-keyboard'));
        expect(document.activeElement).not.toBe(h.area);
        // The return path is the ENGINE's own: its canvas focuses the textarea on `touchend`
        // (`vendor/ghostty-web-patched/source/lib/terminal.ts:490-493`). Nothing in the bar or the
        // pane has to re-focus, which is why there is no "show keyboard" key.
        h.area.focus();
        expect(document.activeElement).toBe(h.area);
    });

    it('renders Paste disabled until C4 wires it up, and says so', async () => {
        const h = await mountPane();
        const paste = h.key('paste');
        expect(paste.getAttribute('aria-disabled')).toBe('true');
        expect(paste.disabled).toBe(true);
        expect(paste.getAttribute('title')).toContain('C4');
        tap(paste);
        expect(h.renderers.last().keys).toEqual([]);
    });

    /**
     * THE KITTY CASE (§TERM-030). Nothing in the bar knows the protocol exists: the key is raised
     * at the engine's input, the pane's own capture-phase interceptor on the host recognises it,
     * and `ESC [ 27 u` goes up the pane's PTY stream. A bar that encoded bytes itself would have
     * had to learn this - and would have got it wrong the moment the flags changed.
     */
    it('a bar key with the kitty protocol negotiated is encoded by the PANE, not by the bar', async () => {
        const h = await mountPane();
        h.setKittyFlags(1);
        const atEngine: string[] = [];
        h.area.addEventListener('keydown', (event) => atEngine.push(event.key));

        tap(h.key('esc'));

        expect(h.pty.last().input).toEqual(['[27u']);
        // …and the engine never saw it, which is what the capture-phase interception buys.
        expect(atEngine).toEqual([]);
        // The bar still just asked for a key: no escape sequence was assembled here.
        expect(h.renderers.last().keys).toEqual([expect.objectContaining({ key: 'Escape', code: 'Escape' })]);
    });

    it('a latched Ctrl reaches the kitty encoder too, with the modifier on it', async () => {
        const h = await mountPane();
        h.setKittyFlags(1);
        tap(h.key('ctrl'));
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
        });
        // `ESC [ 99 ; 5 u` - codepoint 99 (`c`), modifier 5 (ctrl+1). The re-raised event goes
        // through the pane's interceptor exactly as a physical Ctrl+C would.
        expect(h.pty.last().input).toEqual(['[99;5u']);
    });

    it('drops the latch when the bar goes away, so the next pane inherits nothing', async () => {
        const h = await mountPane();
        tap(h.key('ctrl'));
        await h.rerender({ focused: false });
        expect(h.bar).toBeNull();
        act(() => {
            fireEvent.keyDown(h.area, { key: 'c', code: 'KeyC' });
        });
        expect(h.renderers.last().keys).toEqual([]);
    });
});

describe('withSticky', () => {
    it('adds the latched modifiers and never takes a key’s own away', () => {
        expect(withSticky({ key: '|', code: 'Backslash', shiftKey: true }, { ctrl: true, alt: false })).toEqual({
            key: '|',
            code: 'Backslash',
            shiftKey: true,
            ctrlKey: true,
            altKey: false
        });
        expect(withSticky({ key: 'c', code: 'KeyC', ctrlKey: true }, { ctrl: false, alt: true })).toEqual({
            key: 'c',
            code: 'KeyC',
            ctrlKey: true,
            altKey: true
        });
    });
});
