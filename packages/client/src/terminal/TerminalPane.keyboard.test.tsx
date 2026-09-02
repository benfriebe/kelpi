/**
 * C2: the terminal under a software keyboard (docs/MOBILE-PLAN.md §4).
 *
 * A separate file from `TerminalPane.test.tsx` on purpose: C1 is building the key bar in the same
 * component at the same time, and two lanes editing one 1,600-line test file is a merge conflict
 * per assertion. Everything here is phone-gated, so every case has its "and not on desktop" twin.
 *
 * Every count below is a DELTA across the transition, never an absolute. A pane's mount is
 * several forced syncs of the same geometry (the engine's `open()`, the visibility effect's
 * `setTimeout(0)`, the fonts-ready hook), which is what it was before C2 and is not this task's
 * to change; what C2 owns is how many messages ONE keyboard transition costs on top of that.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from './TerminalPane';
import {
    KEYBOARD_INSET_ATTRIBUTE,
    PHONE_KEYBOARD_SETTLE_MS,
    TERMINAL_RESIZES_ATTRIBUTE,
    TERMINAL_ROWS_ATTRIBUTE
} from './keyboard-inset';
import {
    createFakePhoneWindow,
    createFakePtyApi,
    createFakeRendererFactory,
    installFakeResizeObserver,
    type FakePhoneWindow
} from './testing';

/** The phone the plan names, and the fake cell the renderer reports: 10x20 CSS px. */
const PANE = { width: 390, height: 844 };
const CELL = { width: 10, height: 20 };
const COLS = 39;
/** 844 / 20 with the keyboard down; (844 - 300) / 20 with it up. */
const ROWS_KEYBOARD_DOWN = 42;
const ROWS_KEYBOARD_UP = 27;
const KEYBOARD_HEIGHT = 300;

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    vi.useFakeTimers();
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.useRealTimers();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

function measure(): { width: number; height: number } {
    return { ...PANE };
}

interface Harness {
    readonly win: FakePhoneWindow;
    readonly renderers: ReturnType<typeof createFakeRendererFactory>;
    readonly pty: ReturnType<typeof createFakePtyApi>;
    root(): HTMLElement;
    /** `resize` messages on the pane's stream so far. */
    sent(): number;
}

function mount(options: {
    win: FakePhoneWindow;
    autoFocusOnOpen?: boolean;
}): Omit<Harness, 'win'> & { container: HTMLElement } {
    const renderers = createFakeRendererFactory({
        cell: CELL,
        ...(options.autoFocusOnOpen === true ? { autoFocusOnOpen: true } : {})
    });
    const pty = createFakePtyApi();
    const view = render(
        <TerminalPane
            paneID="pane-kb"
            ptyApi={pty}
            focused
            visible
            createRenderer={renderers.factory}
            measure={measure}
            formFactorWindow={options.win}
        />
    );
    return {
        renderers,
        pty,
        container: view.container,
        root(): HTMLElement {
            const node = view.container.querySelector('[data-pane-id="pane-kb"]');
            if (node === null) throw new Error('the pane did not render');
            return node as HTMLElement;
        },
        sent(): number {
            return pty.last().resizes.length;
        }
    };
}

/** Mount a live pane and run its whole start chain to rest. */
async function mountPane(options: { coarse: boolean; autoFocusOnOpen?: boolean }): Promise<Harness> {
    const win = createFakePhoneWindow({ coarse: options.coarse });
    const harness = mount({ win, ...(options.autoFocusOnOpen === true ? { autoFocusOnOpen: true } : {}) });
    await settle();
    // The visibility effect's `setTimeout(0)` re-measure, and the engine's own delayed backup
    // focus when `autoFocusOnOpen` is on.
    await act(async () => {
        await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS * 2);
    });
    return { win, ...harness };
}

/** Raise the keyboard over 15 animation frames and let the settle window elapse. */
async function raiseKeyboard(win: FakePhoneWindow): Promise<void> {
    await act(async () => {
        win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
        await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
    });
}

async function lowerKeyboard(win: FakePhoneWindow): Promise<void> {
    await act(async () => {
        win.lowerKeyboard(15);
        await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
    });
}

describe('TerminalPane: the software keyboard (C2)', () => {
    it('shrinks the terminal by the inset and tells the daemon exactly ONCE', async () => {
        const harness = await mountPane({ coarse: true });
        const stream = harness.pty.last();
        expect(stream.resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_DOWN });
        const before = harness.sent();

        await raiseKeyboard(harness.win);

        // Fifteen `visualViewport` resize events; ONE message on the pane's stream. That is the
        // whole of C2's second clause: the daemon must not see the animation.
        expect(harness.win.viewportEvents()).toBe(15);
        expect(harness.sent() - before).toBe(1);
        expect(stream.resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
        // And the engine was told the same thing, so the canvas shrinks with the PTY.
        expect(harness.renderers.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
    });

    it('restores the rows on dismiss, also in exactly one message', async () => {
        const harness = await mountPane({ coarse: true });
        await raiseKeyboard(harness.win);
        const before = harness.sent();

        await lowerKeyboard(harness.win);

        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_DOWN });
    });

    it('says nothing at all while the keyboard is still animating', async () => {
        const harness = await mountPane({ coarse: true });
        const before = harness.sent();

        await act(async () => {
            harness.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS - 20);
        });
        expect(harness.sent()).toBe(before);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(40);
        });
        expect(harness.sent() - before).toBe(1);
    });

    it('does not move the columns: a keyboard takes height, never width', async () => {
        const harness = await mountPane({ coarse: true });
        await raiseKeyboard(harness.win);
        await lowerKeyboard(harness.win);
        const cols = new Set(harness.pty.last().resizes.map((size) => size.cols));
        expect([...cols]).toEqual([COLS]);
    });

    it('publishes the inset, the rows and the resize count for the audit', async () => {
        const harness = await mountPane({ coarse: true });
        expect(harness.root().getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe('0');
        expect(harness.root().getAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(String(ROWS_KEYBOARD_DOWN));
        const before = Number(harness.root().getAttribute(TERMINAL_RESIZES_ATTRIBUTE));

        await raiseKeyboard(harness.win);

        expect(harness.root().getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(String(KEYBOARD_HEIGHT));
        expect(harness.root().getAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(String(ROWS_KEYBOARD_UP));
        // The counter is what the audit reads, so it has to agree with the stream exactly.
        expect(Number(harness.root().getAttribute(TERMINAL_RESIZES_ATTRIBUTE))).toBe(before + 1);
        expect(Number(harness.root().getAttribute(TERMINAL_RESIZES_ATTRIBUTE))).toBe(harness.sent());
    });

    it('takes a keyboard that is already up WITHOUT waiting for a settle window', async () => {
        const win = createFakePhoneWindow();
        win.raiseKeyboard(KEYBOARD_HEIGHT, 1);
        const harness = mount({ win });
        await settle();

        // No timer has been advanced past the pane's own start chain: the source seeds itself
        // from the viewport at construction, so the pane lands on the keyboard's rows straight
        // away rather than a settle window later.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });

        const before = harness.sent();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS * 4);
        });
        expect(harness.sent()).toBe(before);
    });

    it('sets the software-keyboard attributes on the engine textarea', async () => {
        const harness = await mountPane({ coarse: true, autoFocusOnOpen: true });
        const area = harness.root().querySelector('textarea');
        expect(area).not.toBeNull();
        expect(area?.getAttribute('autocapitalize')).toBe('off');
        expect(area?.getAttribute('autocorrect')).toBe('off');
        expect(area?.getAttribute('spellcheck')).toBe('false');
        expect(area?.getAttribute('inputmode')).toBe('text');
        expect(area?.getAttribute('enterkeyhint')).toBe('send');
    });

    it('takes back only what it added when the pane stops being a phone', async () => {
        const harness = await mountPane({ coarse: true, autoFocusOnOpen: true });
        // An iPad that gains a Bluetooth mouse: `(pointer: coarse)` flips with no remount.
        await act(async () => {
            harness.win.setPointer(false);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });

        const area = harness.root().querySelector('textarea');
        expect(area?.hasAttribute('inputmode')).toBe(false);
        expect(area?.hasAttribute('enterkeyhint')).toBe(false);
        // The engine's own three are the engine's; the phone program does not remove them.
        expect(area?.getAttribute('autocapitalize')).toBe('off');
        expect(harness.renderers.last().textInputAttributes.at(-1)).toEqual({
            inputmode: null,
            enterkeyhint: null
        });
        // …and the published attributes go with the form factor.
        expect(harness.root().hasAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(false);
        expect(harness.root().hasAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(false);
        expect(harness.root().hasAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe(false);
    });
});

describe('TerminalPane: and NOT on a desktop', () => {
    it('ignores a visual viewport that shrinks under a fine pointer', async () => {
        // Same 390x844 window, same visual-viewport events; a fine pointer makes it a desktop,
        // which is the rule `chrome/form-factor.ts` exists to state.
        const harness = await mountPane({ coarse: false });
        const before = harness.sent();
        const last = harness.pty.last().resizes.at(-1);

        await raiseKeyboard(harness.win);
        await lowerKeyboard(harness.win);

        expect(harness.win.viewportEvents()).toBe(30);
        expect(harness.sent()).toBe(before);
        expect(harness.pty.last().resizes.at(-1)).toEqual(last);
        expect(last).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_DOWN });
    });

    it('builds no keyboard subscription at all, and publishes no phone attributes', async () => {
        const phone = await mountPane({ coarse: true });
        const desktop = await mountPane({ coarse: false });

        // Both panes watch the window for a form-factor change (they must, to notice a phone);
        // the extra two listeners on the phone are the keyboard source's resize and scroll.
        expect(phone.win.listenerCount() - desktop.win.listenerCount()).toBe(2);
        expect(desktop.root().hasAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(false);
        expect(desktop.root().hasAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(false);
        expect(desktop.root().hasAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe(false);
    });

    it('never touches the engine textarea', async () => {
        const harness = await mountPane({ coarse: false, autoFocusOnOpen: true });
        expect(harness.renderers.last().textInputAttributes).toEqual([]);
        const area = harness.root().querySelector('textarea');
        expect(area).not.toBeNull();
        expect(area?.hasAttribute('inputmode')).toBe(false);
        expect(area?.hasAttribute('enterkeyhint')).toBe(false);
    });

    it('sends the same resize messages for a window resize as it did before C2', async () => {
        const harness = await mountPane({ coarse: false });
        const before = [...harness.pty.last().resizes];

        // The desktop path, unchanged: a `ResizeObserver` burst through the pane's own debounce.
        await act(async () => {
            for (let index = 0; index < 12; index += 1) observers.trigger();
            await vi.advanceTimersByTimeAsync(200);
        });

        // Nothing measured differently, so nothing was sent: the debounce coalesces the burst and
        // the unchanged-geometry short circuit swallows the one sync it fires.
        expect(harness.pty.last().resizes).toEqual(before);
        expect(harness.win.viewportEvents()).toBe(0);
    });
});
