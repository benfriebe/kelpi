/**
 * C9: ONE key bar for the window, at the bottom of the content area (docs/MOBILE-PLAN.md §4, §7).
 *
 * The owner's report, on a real Android phone (2026-09-08): *"the phone button bar renders only
 * inside a single pane; when the panes are split the bar renders only in the active pane, instead
 * of across the bottom."* C1 mounted the bar inside `TerminalPane`, so it was a piece of one pane's
 * box. This file is the jsdom half of the repair: WHERE the bar is, WHICH pane it acts on, and what
 * the software keyboard does to the box it and the pane grid share.
 *
 * What it deliberately does not re-measure is the bar's own behaviour - the keys, the latch, the
 * Android shapes, Paste, the Copy pill, C8's label. Those are `KeyBar.test.tsx`'s, against the real
 * vendored engine, and they are unchanged by C9: the bar is the same component, mounted somewhere
 * else and pointed at a pane it is told about.
 *
 * jsdom has no layout, so "spans the row" and "sits above the keyboard" are pinned here as the
 * box's own arithmetic (the row's padding, the bar's `bottom`) and measured as real rects by the
 * `phone-key-bar-split` audit step, which splits a real pane in a real Chromium.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KEY_BAR_HEIGHT_PX } from './KeyBar';
import {
    PHONE_CONTENT_AREA_ATTR,
    PHONE_KEYBOARD_INSET_ATTR,
    PHONE_KEY_BAR_SLOT_ATTR,
    PhoneKeyBar
} from './PhoneKeyBar';
import { ENGINE_AUTOFOCUS_WINDOW_MS, TerminalPane } from './TerminalPane';
import { PHONE_KEYBOARD_SETTLE_MS } from './keyboard-inset';
import {
    createFakePhoneWindow,
    createFakePtyApi,
    createFakeRendererFactory,
    installFakeResizeObserver,
    type FakePaneStream,
    type FakePhoneWindow,
    type FakeRenderer
} from './testing';

const CELL = { width: 10, height: 20 };
const WINDOW = { width: 390, height: 844 };
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
 * A pane's height, modelled: the window minus whatever the CONTENT ROW has taken off itself.
 *
 * jsdom has no layout, so the seam has to do the one piece of CSS C9 turns on - the row's bottom
 * padding, which is the bar's 45 px plus the keyboard's inset, and which every pane in the grid
 * loses because the grid is what fills the row. Both panes here are full-height siblings, so both
 * lose all of it; a stacked split would divide it, which is a layout fact and therefore the live
 * step's (`phone-key-bar-split`).
 */
function paneHeight(element: HTMLElement, win: FakePhoneWindow): number {
    const row = element.closest(`[${PHONE_CONTENT_AREA_ATTR}]`) as HTMLElement | null;
    const padding = row === null ? 0 : Number.parseFloat(row.style.paddingBottom || '0');
    return win.innerHeight - (Number.isFinite(padding) ? padding : 0);
}

interface Pane {
    readonly id: string;
    /** A terminal pane, or a stand-in for a pane type that has no terminal renderer at all. */
    readonly terminal?: boolean | undefined;
    readonly focused?: boolean | undefined;
    readonly visible?: boolean | undefined;
}

interface Harness {
    readonly win: FakePhoneWindow;
    readonly container: HTMLElement;
    row(): HTMLElement;
    bar(): HTMLElement | null;
    slot(): HTMLElement | null;
    key(id: string): HTMLButtonElement;
    root(paneID: string): HTMLElement;
    host(paneID: string): HTMLElement;
    renderer(paneID: string): FakeRenderer;
    /** The pane's PTY stream, which is what the daemon actually heard. */
    stream(paneID: string): FakePaneStream;
    /** The row's padding in px, which is the bar's height plus whatever the keyboard has taken. */
    padding(): number;
    rerender(panes: Pane[]): Promise<void>;
}

/**
 * The app's shape: the content row, with the pane grid in it and C9's bar hanging off its bottom
 * edge (`App.tsx`). `focusedPaneID` is what the app passes; the bar decides for itself whether that
 * pane is a terminal it can act on.
 */
function ContentRow(props: {
    panes: Pane[];
    win: FakePhoneWindow;
    pty: ReturnType<typeof createFakePtyApi>;
    renderers: ReturnType<typeof createFakeRendererFactory>;
}): ReactElement {
    const row = useRef<HTMLDivElement | null>(null);
    const focused = props.panes.find((pane) => pane.focused === true) ?? null;
    return (
        <div ref={row} className="relative flex min-h-0 flex-1">
            {props.panes.map((pane) =>
                pane.terminal === false ? (
                    // A web pane, a markdown pane, a placeholder: something with a pane id and no
                    // terminal renderer, which is exactly what the registry answers null for.
                    <div key={pane.id} data-pane-id={pane.id} />
                ) : (
                    <TerminalPane
                        key={pane.id}
                        paneID={pane.id}
                        ptyApi={props.pty}
                        focused={pane.focused === true}
                        visible={pane.visible !== false}
                        createRenderer={props.renderers.factory}
                        measure={(element) => ({ width: WINDOW.width, height: paneHeight(element, props.win) })}
                        formFactorWindow={props.win}
                    />
                )
            )}
            <PhoneKeyBar
                paneID={focused?.id ?? null}
                contentRow={row}
                formFactorWindow={props.win}
                measure={(element) => ({
                    width: WINDOW.width,
                    height: props.win.innerHeight - Number.parseFloat(element.style.paddingBottom || '0')
                })}
            />
        </div>
    );
}

async function mount(panes: Pane[], { coarse = true } = {}): Promise<Harness> {
    const win = createFakePhoneWindow({ ...WINDOW, coarse });
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: CELL });
    const element = (next: Pane[]): ReactElement => (
        <ContentRow panes={next} win={win} pty={pty} renderers={renderers} />
    );
    const view = render(element(panes));
    await settle();
    await act(async () => {
        await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
    });
    const harness: Harness = {
        win,
        container: view.container,
        row(): HTMLElement {
            return view.container.firstElementChild as HTMLElement;
        },
        bar(): HTMLElement | null {
            return view.container.querySelector('[data-terminal-key-bar]');
        },
        slot(): HTMLElement | null {
            return view.container.querySelector(`[${PHONE_KEY_BAR_SLOT_ATTR}]`);
        },
        key(id: string): HTMLButtonElement {
            const button = view.container.querySelector(`[data-terminal-key="${id}"]`);
            if (button === null) throw new Error(`no key bar button for ${id}`);
            return button as HTMLButtonElement;
        },
        root(paneID: string): HTMLElement {
            return view.container.querySelector(`[data-pane-id="${paneID}"]`) as HTMLElement;
        },
        host(paneID: string): HTMLElement {
            return harness.root(paneID).querySelector('[data-terminal-host]') as HTMLElement;
        },
        renderer(paneID: string): FakeRenderer {
            const index = panes.filter((pane) => pane.terminal !== false).findIndex((pane) => pane.id === paneID);
            const renderer = renderers.instances[index];
            if (renderer === undefined) throw new Error(`no renderer for ${paneID}`);
            return renderer;
        },
        stream(paneID: string): FakePaneStream {
            const stream = pty.streams.findLast((entry) => entry.paneID === paneID);
            if (stream === undefined) throw new Error(`no stream for ${paneID}`);
            return stream;
        },
        padding(): number {
            return Number.parseFloat(harness.row().style.paddingBottom || '0');
        },
        async rerender(next: Pane[]): Promise<void> {
            view.rerender(element(next));
            await settle();
        }
    };
    return harness;
}

/** A tap: the pointer-down the bar suppresses, then the click the browser raises anyway. */
function tap(button: HTMLElement): void {
    act(() => {
        fireEvent.pointerDown(button);
        fireEvent.mouseDown(button);
        fireEvent.click(button);
    });
}

describe('the window has ONE key bar', () => {
    it('mounts it once, at the bottom of the content row, however many panes there are', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);

        expect(h.container.querySelectorAll('[data-terminal-key-bar]')).toHaveLength(1);
        // …and it is not inside either pane, which is the whole of the owner's report.
        expect(h.root('left').querySelector('[data-terminal-key-bar]')).toBeNull();
        expect(h.root('right').querySelector('[data-terminal-key-bar]')).toBeNull();
        // It is the row's last child, spanning its bottom edge.
        const slot = h.slot() as HTMLElement;
        expect(h.row().lastElementChild).toBe(slot);
        expect(slot.className).toContain('absolute');
        expect(slot.className).toContain('right-0');
        expect(slot.className).toContain('left-0');
        expect(slot.className).toContain('bottom-0');
        expect(slot.contains(h.bar())).toBe(true);
    });

    /**
     * NOTHING IS DRAWN OVER A TERMINAL. The bar is out of flow, so the room it takes is the row's
     * own padding: 45 px of it, which every pane in the grid loses through the `ResizeObserver` it
     * already has. The live step measures the rects; this pins the arithmetic.
     */
    it('makes room for itself in the row, so the grid ends where the bar starts', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        expect(h.padding()).toBe(KEY_BAR_HEIGHT_PX);
        expect(h.row().hasAttribute(PHONE_CONTENT_AREA_ATTR)).toBe(true);
        expect(h.row().getAttribute(PHONE_KEYBOARD_INSET_ATTR)).toBe('0');
    });

    it('AND NOT ON DESKTOP: no bar, no marker, no padding, nothing on the row at all', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }], { coarse: false });
        expect(h.bar()).toBeNull();
        expect(h.slot()).toBeNull();
        expect(h.row().hasAttribute(PHONE_CONTENT_AREA_ATTR)).toBe(false);
        expect(h.row().hasAttribute(PHONE_KEYBOARD_INSET_ATTR)).toBe(false);
        expect(h.row().getAttribute('style')).toBeNull();
    });
});

describe('the bar acts on the pane that holds the caret', () => {
    it('sends a key to the FOCUSED pane and to no other', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);

        tap(h.key('esc'));

        expect(h.renderer('left').keys.map((init) => init.key)).toEqual(['Escape']);
        expect(h.renderer('right').keys).toEqual([]);
    });

    it('re-aims when the caret moves to the other pane, in one commit', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        tap(h.key('esc'));

        await h.rerender([{ id: 'left' }, { id: 'right', focused: true }]);
        tap(h.key('up'));

        expect(h.renderer('left').keys.map((init) => init.key)).toEqual(['Escape']);
        expect(h.renderer('right').keys.map((init) => init.key)).toEqual(['ArrowUp']);
    });

    /**
     * …and so does the sticky-modifier INTERCEPTOR, which is the half a re-render alone would not
     * move: it is a capture listener bound to a pane ROOT (`KeyBar.tsx`'s header - above the host,
     * so it runs before the kitty interceptor and the engine's own), and the host hands the bar a
     * new `captureRoot` when the target changes so the two effects rebind.
     */
    it('latches Ctrl onto a key typed in the newly focused pane, not the old one', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        await h.rerender([{ id: 'left' }, { id: 'right', focused: true }]);

        tap(h.key('ctrl'));
        // The phone's own keyboard types into the pane that has the caret.
        act(() => {
            fireEvent.keyDown(h.host('right'), { key: 'c', code: 'KeyC' });
        });

        expect(h.renderer('right').keys.at(-1)).toMatchObject({ key: 'c', code: 'KeyC', ctrlKey: true });
        expect(h.renderer('left').keys).toEqual([]);
        // The old root is no longer listened to: a keydown there is nobody's business.
        act(() => {
            fireEvent.keyDown(h.host('left'), { key: 'x', code: 'KeyX' });
        });
        expect(h.renderer('left').keys).toEqual([]);
    });

    it('shows nothing when the focused pane is not a terminal', async () => {
        const h = await mount([{ id: 'web', terminal: false, focused: true }, { id: 'shell' }]);
        expect(h.bar()).toBeNull();
        // …and the row makes no room for a bar that is not there.
        expect(h.padding()).toBe(0);
    });

    it('shows nothing when nothing is focused, and comes back when a terminal is', async () => {
        const h = await mount([{ id: 'left' }, { id: 'right' }]);
        expect(h.bar()).toBeNull();

        await h.rerender([{ id: 'left', focused: true }, { id: 'right' }]);
        expect(h.bar()).not.toBeNull();
        expect(h.padding()).toBe(KEY_BAR_HEIGHT_PX);
    });

    it('shows nothing for a focused pane that is off screen (a sibling is zoomed)', async () => {
        const h = await mount([{ id: 'left', focused: true, visible: false }, { id: 'right' }]);
        expect(h.bar()).toBeNull();
    });

    /**
     * THE BAR NEVER FOCUSES ANYTHING EXCEPT THROUGH SHOW (device round 3), and the one focus it
     * may cause goes to the pane that holds the caret rather than to whichever pane was focused
     * when the bar was built.
     */
    it('puts the caret back on the FOCUSED pane when Show is tapped', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        const area = document.createElement('textarea');
        h.host('right').appendChild(area);
        await h.rerender([{ id: 'left' }, { id: 'right', focused: true }]);

        // The label reads Show: no keyboard is taking viewport space (C8).
        expect(h.key('hide-keyboard').textContent).toBe('Show');
        tap(h.key('hide-keyboard'));

        expect(h.host('right').contains(document.activeElement)).toBe(true);
    });
});

/**
 * C9 round 9 (owner device, 2026-09-08): "clicking between panes causes the keyboard to briefly
 * hide and show."
 *
 * The mechanism is two focus events with a gesture-length gap between them: the browser's own
 * focus move for a tap parks the caret on nothing (a canvas is not focusable), and the engine's
 * `touchend` puts it back. jsdom moves no focus for a pointer event of its own, so what is pinned
 * here is the half that IS this component's: that the caret is on the tapped pane's engine input
 * SYNCHRONOUSLY, inside the gesture's first event, and that the event is cancelled - which is what
 * takes the browser's own move (and the flicker) away. The ordering a real browser produces is
 * `phone-key-bar-split`'s, where the focus trail is recorded around a real touch.
 */
describe('a tap hands the caret between terminals without letting it touch the body (C9 round 9)', () => {
    /** C7's mode, as `main.tsx` binds it on a phone: the signal the hand-over is gated on. */
    function keyboard(mode: 'none' | 'resizes-visual'): void {
        document.documentElement.dataset['keyboardViewport'] = mode;
    }

    afterEach(() => {
        delete document.documentElement.dataset['keyboardViewport'];
    });

    /** Two panes, each with a stand-in for the engine's hidden input inside its host. */
    async function twoPanes(): Promise<{ h: Harness; left: HTMLTextAreaElement; right: HTMLTextAreaElement }> {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        // Past §N35's engine-autofocus window (`ENGINE_AUTOFOCUS_WINDOW_MS`), which for its own
        // bounded 250 ms answers ANY focus landing in an unfocused pane's host by handing it back -
        // the engine's own `touchend` grab has exactly the same exposure, and neither is what this
        // block is about.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ENGINE_AUTOFOCUS_WINDOW_MS * 2);
        });
        const inputs = ['left', 'right'].map((id) => {
            const area = document.createElement('textarea');
            h.host(id).appendChild(area);
            return area;
        });
        return { h, left: inputs[0] as HTMLTextAreaElement, right: inputs[1] as HTMLTextAreaElement };
    }

    it('moves the caret from the other pane\'s engine in the same task, and cancels the tap', async () => {
        const { h, left, right } = await twoPanes();
        keyboard('resizes-visual');
        left.focus();
        const trail: string[] = [];
        const record = (event: FocusEvent): void => {
            const target = event.target as HTMLElement | null;
            const pane = target?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? 'body';
            trail.push(`${event.type}:${target === document.body ? 'body' : pane}`);
        };
        document.addEventListener('focusin', record as EventListener, true);
        document.addEventListener('focusout', record as EventListener, true);

        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        act(() => {
            h.host('right').dispatchEvent(event);
        });

        document.removeEventListener('focusin', record as EventListener, true);
        document.removeEventListener('focusout', record as EventListener, true);
        // Synchronously, in the task the gesture opened: no settle, no touchend, no frame.
        expect(document.activeElement).toBe(right);
        // …and the browser's own focus move for this gesture is cancelled, which is the half that
        // stops the caret passing through nothing on a real phone.
        expect(event.defaultPrevented).toBe(true);
        // The caret left one engine for the other, and touched nothing in between.
        expect(trail).toEqual(['focusout:left', 'focusin:right']);
    });

    it('cancels the touchstart of the same gesture too, whichever event the engine acts on', async () => {
        const { h, left, right } = await twoPanes();
        keyboard('resizes-visual');
        left.focus();

        const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
        const touch = new Event('touchstart', { bubbles: true, cancelable: true });
        act(() => {
            h.host('right').dispatchEvent(pointer);
            h.host('right').dispatchEvent(touch);
        });

        expect(document.activeElement).toBe(right);
        expect(pointer.defaultPrevented).toBe(true);
        expect(touch.defaultPrevented).toBe(true);
    });

    it('leaves a tap alone when the keyboard is DOWN, so the engine still raises it (C5)', async () => {
        const { h, left, right } = await twoPanes();
        keyboard('none');
        left.focus();

        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        act(() => {
            h.host('right').dispatchEvent(event);
        });

        // Nothing was taken and nothing was cancelled: the tap keeps the path it has today, where
        // the engine's own `touchend` focuses its textarea and the person gets the keyboard back.
        expect(document.activeElement).toBe(left);
        expect(event.defaultPrevented).toBe(false);
    });

    it('leaves a tap alone when the caret is on nothing: this is a hand-OVER, not a claim', async () => {
        const { h, right } = await twoPanes();
        keyboard('resizes-visual');
        (document.activeElement as HTMLElement | null)?.blur();
        expect(document.activeElement).toBe(document.body);

        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        act(() => {
            h.host('right').dispatchEvent(event);
        });

        expect(document.activeElement).toBe(document.body);
        expect(event.defaultPrevented).toBe(false);
        expect(right.ownerDocument.activeElement).not.toBe(right);
    });

    it('leaves a tap on the pane that ALREADY holds the caret alone', async () => {
        const { h, left } = await twoPanes();
        keyboard('resizes-visual');
        left.focus();

        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        act(() => {
            h.host('left').dispatchEvent(event);
        });

        expect(document.activeElement).toBe(left);
        expect(event.defaultPrevented).toBe(false);
    });

    it('AND NOT ON DESKTOP: the same gesture on the same panes moves nothing', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }], { coarse: false });
        const left = document.createElement('textarea');
        h.host('left').appendChild(left);
        keyboard('resizes-visual');
        left.focus();

        const event = new Event('pointerdown', { bubbles: true, cancelable: true });
        act(() => {
            h.host('right').dispatchEvent(event);
        });

        expect(document.activeElement).toBe(left);
        expect(event.defaultPrevented).toBe(false);
    });
});

describe('the software keyboard moves the box the bar and the grid share', () => {
    it('takes the keyboard out of the row and rides it, frame by frame', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        const slot = h.slot() as HTMLElement;
        expect(slot.style.bottom).toBe('0px');

        // 15 frames at ~16 ms, one `visualViewport` resize each, exactly as iOS animates. Read
        // back inside the same synchronous turn as the event: the box moved IN the frame that
        // carried the number, so it can never be a frame behind (C6, owner device round 4).
        for (let frame = 1; frame <= 15; frame += 1) {
            const inset = (KEYBOARD_HEIGHT * frame) / 15;
            act(() => {
                h.win.raiseKeyboard(inset, 1);
            });
            expect(h.padding()).toBe(KEY_BAR_HEIGHT_PX + inset);
            expect(h.row().getAttribute(PHONE_KEYBOARD_INSET_ATTR)).toBe(String(inset));
            expect(slot.style.bottom).toBe(`${String(inset)}px`);
        }

        // …and gives it back the same way.
        await act(async () => {
            h.win.lowerKeyboard(15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });
        expect(h.padding()).toBe(KEY_BAR_HEIGHT_PX);
        expect(slot.style.bottom).toBe('0px');
    });

    /**
     * BOTH panes shrink, and each tells the daemon ONCE (the settle rule, which stays the pane's).
     *
     * This is the arithmetic C9 also fixes: with each pane padding itself, two panes took 300 px
     * of terminal EACH for one 300 px keyboard. The window takes the keyboard's pixels once - both
     * panes here are full-height, so both lose the same 300, and a stacked split would divide them.
     */
    it('shrinks every pane in the grid, one resize each on the DAEMON', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        const before = { left: h.stream('left').resizes.length, right: h.stream('right').resizes.length };

        await act(async () => {
            h.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });

        // 844 - 45 of bar - 300 of keyboard = 499 px at a 20 px cell.
        expect(h.stream('left').resizes.at(-1)).toEqual({ cols: 39, rows: 24 });
        expect(h.stream('right').resizes.at(-1)).toEqual({ cols: 39, rows: 24 });
        // Fifteen viewport events, one message per pane: the settle rule is still each pane's.
        expect(h.win.viewportEvents()).toBe(15);
        expect(h.stream('left').resizes.length - before.left).toBe(1);
        expect(h.stream('right').resizes.length - before.right).toBe(1);
        // …and the count each pane publishes for the audit agrees with its own stream.
        for (const id of ['left', 'right']) {
            expect(h.root(id).getAttribute('data-terminal-resizes')).toBe(String(h.stream(id).resizes.length));
        }
    });

    it('publishes the same inset on every pane as the row applied', async () => {
        const h = await mount([{ id: 'left', focused: true }, { id: 'right' }]);
        await act(async () => {
            h.win.raiseKeyboard(KEYBOARD_HEIGHT, 15);
            await vi.advanceTimersByTimeAsync(PHONE_KEYBOARD_SETTLE_MS);
        });

        expect(h.row().getAttribute(PHONE_KEYBOARD_INSET_ATTR)).toBe(String(KEYBOARD_HEIGHT));
        for (const id of ['left', 'right']) {
            expect(h.root(id).getAttribute('data-terminal-keyboard-inset')).toBe(String(KEYBOARD_HEIGHT));
        }
    });
});
