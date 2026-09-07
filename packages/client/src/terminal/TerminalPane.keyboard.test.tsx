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

import { DEFAULT_RESIZE_DEBOUNCE_MS, TerminalPane } from './TerminalPane';
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

/**
 * The host's box, modelled.
 *
 * jsdom has no layout, so the seam has to do the one piece of CSS this feature turns on: the pane
 * root's bottom padding (C6) comes off the host, because the host is either the flex child beside
 * the key bar or a `height: 100%` child of the root's content box. `innerHeight` is in it too, so
 * a test can shrink the LAYOUT viewport the way Android does and watch the box follow.
 */
function measureFor(win: FakePhoneWindow) {
    return (element: HTMLElement): { width: number; height: number } => {
        const root = element.closest('[data-pane-id]');
        const padding =
            root === null ? 0 : Number.parseFloat((root as HTMLElement).style.paddingBottom || '0');
        return {
            width: PANE.width,
            height: win.innerHeight - (Number.isFinite(padding) ? padding : 0)
        };
    };
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
            measure={measureFor(options.win)}
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

    /*
     * C6 (owner device round 4, 2026-09-07): "pass, but the pane shifts after the keyboard has
     * finished moving". Under C2 the inset was arithmetic on the measured height and the pane's
     * own box never moved, so everything the pane renders BELOW the terminal - the key bar - only
     * followed a keyboard when the BROWSER shrank the layout viewport, which Android Chrome did
     * intermittently and not at all on the first appearance after load (item A1). The box is the
     * pane's own business now, and these are the two halves of that: it follows every frame, and
     * the daemon still hears one message per transition.
     */
    it('moves its box on every frame of the animation, and the daemon hears none of them', async () => {
        const harness = await mountPane({ coarse: true });
        const root = harness.root();
        const before = harness.sent();
        expect(root.style.paddingBottom).toBe('');

        // 15 frames at ~16 ms, one `visualViewport` resize each, exactly as iOS animates. Read
        // back inside the same synchronous turn as the event: what is asserted is that the box
        // moved IN the frame that carried the number, so it can never be a frame behind.
        for (let frame = 1; frame <= 15; frame += 1) {
            const inset = (KEYBOARD_HEIGHT * frame) / 15;
            act(() => {
                harness.win.raiseKeyboard(inset, 1);
            });
            expect(root.style.paddingBottom).toBe(`${String(inset)}px`);
            expect(root.getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(String(inset));
            expect(harness.sent()).toBe(before);
        }

        // ...and then one message, for the geometry the box actually ended up with.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
        expect(root.style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);
    });

    it('gives the box back frame by frame on the way down too', async () => {
        const harness = await mountPane({ coarse: true });
        await raiseKeyboard(harness.win);
        const root = harness.root();
        const before = harness.sent();

        for (let frame = 14; frame >= 0; frame -= 1) {
            const inset = (KEYBOARD_HEIGHT * frame) / 15;
            act(() => {
                harness.win.raiseKeyboard(inset, 1);
            });
            expect(root.style.paddingBottom).toBe(inset === 0 ? '' : `${String(inset)}px`);
            expect(harness.sent()).toBe(before);
        }
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_DOWN });
    });

    /*
     * Item A1: "bar did not move with the keyboard at first; by B7 it was moving with it."
     * The FIRST transition a pane ever sees arrives while its start chain is still running, and
     * it has to land on the box like any other.
     */
    it('applies the very first keyboard after mount, before the start chain has settled', async () => {
        const win = createFakePhoneWindow();
        const harness = mount({ win });

        // No `settle()`: the keyboard arrives while the engine is still being built.
        await act(async () => {
            win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
        });
        const root = harness.root();
        expect(root.style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);
        expect(root.getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(String(KEYBOARD_HEIGHT));

        // ...and once everything has run, the pane is on the keyboard's rows, not the window's.
        await settle();
        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS * 2);
        });
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
        expect(root.getAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(String(ROWS_KEYBOARD_UP));
    });

    /*
     * The Android shape, which MOBILE-PLAN.md section 7 recorded as C2's known limit: the visual
     * viewport animates and then the LAYOUT viewport catches up in one step at the end, taking
     * `innerHeight` down by the same 300 px and putting `readSoftKeyboardInset` back to zero. C2
     * could not be right here - a settled VALUE of 300 subtracted from a window that had already
     * lost 300 is 300 px of terminal collapsed twice - and C6 is, because the box and the
     * measurement are read from the same DOM at the same instant.
     */
    it('survives the layout viewport catching up at the end, in exactly one message', async () => {
        const harness = await mountPane({ coarse: true });
        const root = harness.root();
        const before = harness.sent();

        await act(async () => {
            harness.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
        });
        expect(root.style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);

        await act(async () => {
            // Chrome resizes the window: `innerHeight` 844 -> 544 with the viewport already at
            // 544, so the keyboard the client can see goes to zero in the same frame.
            harness.win.shrinkWindow(KEYBOARD_HEIGHT);
            observers.trigger();
        });
        // The padding came off in that same frame, so the host is 544 px either way round and
        // nothing jumped.
        expect(root.style.paddingBottom).toBe('');
        expect(harness.sent()).toBe(before);

        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + DEFAULT_RESIZE_DEBOUNCE_MS);
        });
        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });

        // ...and back: the visual viewport runs ahead of the window, so the inset never leaves
        // zero and the whole transition is the ordinary ResizeObserver path.
        const raised = harness.sent();
        await act(async () => {
            harness.win.lowerKeyboard(15);
            harness.win.shrinkWindow(0);
            observers.trigger();
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + DEFAULT_RESIZE_DEBOUNCE_MS);
        });
        expect(harness.sent() - raised).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_DOWN });
    });

    /*
     * The same shape with the window resize LATE - more than a settle window after the last
     * animation frame, which is what a phone that has just loaded the page does.
     *
     * Measured on the base commit (2026-09-07): three messages and a visible collapse, 27 rows
     * then 12 then 27, because a settled inset of 300 was subtracted from a window that had
     * already lost the same 300. The box is read at measure time now, so there is one message and
     * nothing to collapse.
     */
    it('and when the layout viewport is late, which is what the base could not survive', async () => {
        const harness = await mountPane({ coarse: true });
        const before = harness.sent();

        await act(async () => {
            harness.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + 80);
        });
        // The settle has already fired against the box the pane made for itself.
        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });

        await act(async () => {
            harness.win.shrinkWindow(KEYBOARD_HEIGHT);
            observers.trigger();
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + DEFAULT_RESIZE_DEBOUNCE_MS);
        });

        // Nothing further to say: the window took the 300 px the padding was holding, so the host
        // is the same 544 px it already was.
        expect(harness.sent() - before).toBe(1);
        expect(harness.root().style.paddingBottom).toBe('');
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
        expect(harness.pty.last().resizes.map((size) => size.rows)).not.toContain(12);
    });

    /*
     * C7's shape: the LAYOUT viewport shrinks with the visual one on every frame, which is what
     * `interactive-widget=resizes-content` (`packages/client/index.html`) asks Chrome 108+ for.
     *
     * TWO facts here, and they are the two halves of "reconcile with C6".
     *
     * The first is that the pane takes no padding at all, on any frame. The keyboard the client
     * can SEE is `innerHeight - visualViewport.height`, which is zero throughout: the window the
     * pane is 100% of is already the space above the keyboard, and a padding on top of that would
     * be the keyboard subtracted twice. It falls out of the arithmetic rather than a mode check.
     *
     * The second is that the daemon still hears the animation exactly once. The frames arrive at
     * 16 ms and the transition runs for 240, so the ResizeObserver's debounce ceiling
     * (`RESIZE_MAX_WAIT_MS`, 100 ms, deliberately there so a divider drag republishes ~10x/s)
     * would republish two or three times through it. Measured on the base commit: three messages,
     * because C6 armed its settle window off the derived INSET and this transition never moves
     * one. The watcher compares the viewport's GEOMETRY now, so a keyboard that arrives as a
     * shorter window is still a keyboard in flight.
     */
    it('takes no padding when the layout viewport shrinks WITH the keyboard, in one message (C7)', async () => {
        const harness = await mountPane({ coarse: true });
        const root = harness.root();
        const before = harness.sent();
        const FRAMES = 15;

        for (let frame = 1; frame <= FRAMES; frame += 1) {
            await act(async () => {
                harness.win.raiseKeyboardResizingContent(Math.round((KEYBOARD_HEIGHT * frame) / FRAMES), 1);
                observers.trigger();
                await vi.advanceTimersByTimeAsync(16);
            });
            expect(root.style.paddingBottom).toBe('');
            expect(root.getAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe('0');
            expect(harness.sent()).toBe(before);
        }

        await act(async () => {
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + DEFAULT_RESIZE_DEBOUNCE_MS);
        });
        expect(harness.sent() - before).toBe(1);
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: ROWS_KEYBOARD_UP });
        expect(root.style.paddingBottom).toBe('');
    });

    /*
     * The other half of the owner's round-5 report: the browser SCROLLING the visual viewport to
     * keep the focused textarea in view, which is what Chrome does under its own default
     * (`resizes-visual`) and what iOS does whether or not it is asked. `chrome/keyboard-viewport.ts`
     * asks for the scroll back; this is what the pane does while the browser keeps it.
     */
    it('pads by what is LEFT of the keyboard when the browser scrolls the app (C7)', async () => {
        const harness = await mountPane({ coarse: true });
        await raiseKeyboard(harness.win);
        expect(harness.root().style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);
        const before = harness.sent();

        await act(async () => {
            harness.win.scrollViewportTo(120);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS + DEFAULT_RESIZE_DEBOUNCE_MS);
        });

        // 300 px of keyboard with 120 px of the app already scrolled past the bottom of the
        // layout viewport leaves 180 px of it still hidden, and the padding is that. The prompt
        // stays inside the band the person can see whether or not the guard gets the scroll back.
        expect(harness.root().style.paddingBottom).toBe('180px');
        expect(harness.sent() - before).toBe(1);
        // 664 px of host at a 20 px cell.
        expect(harness.pty.last().resizes.at(-1)).toEqual({ cols: COLS, rows: 33 });
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
        // the extra three on the phone are the keyboard watcher's own: the visual viewport's
        // resize and scroll, and (C7) the WINDOW's resize, which is how a keyboard arrives when
        // the browser gives it the layout viewport's pixels rather than the visual viewport's.
        expect(phone.win.listenerCount() - desktop.win.listenerCount()).toBe(3);
        expect(desktop.root().hasAttribute(KEYBOARD_INSET_ATTRIBUTE)).toBe(false);
        expect(desktop.root().hasAttribute(TERMINAL_ROWS_ATTRIBUTE)).toBe(false);
        expect(desktop.root().hasAttribute(TERMINAL_RESIZES_ATTRIBUTE)).toBe(false);
    });

    it('never grows a bottom padding, however far the visual viewport moves (C6)', async () => {
        const phone = await mountPane({ coarse: true });
        const desktop = await mountPane({ coarse: false });

        await act(async () => {
            desktop.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS * 2);
        });

        // The property is never written at all on a desktop, not written and then cleared: the
        // inline style is the same three declarations the pane has had since long before C2.
        expect(desktop.root().style.paddingBottom).toBe('');
        expect(desktop.root().getAttribute('style')).not.toContain('padding-bottom');
        // ...and the phone twin, on the same shaped window, does grow one.
        await act(async () => {
            phone.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS * 2);
        });
        expect(phone.root().style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);
    });

    it('takes the padding back off a pane that stops being a phone', async () => {
        const harness = await mountPane({ coarse: true });
        await raiseKeyboard(harness.win);
        expect(harness.root().style.paddingBottom).toBe(`${String(KEYBOARD_HEIGHT)}px`);

        // An iPad that gains a Bluetooth mouse: `(pointer: coarse)` flips with no remount.
        await act(async () => {
            harness.win.setPointer(false);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(harness.root().style.paddingBottom).toBe('');
        expect(harness.root().getAttribute('style')).not.toContain('padding-bottom');
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
