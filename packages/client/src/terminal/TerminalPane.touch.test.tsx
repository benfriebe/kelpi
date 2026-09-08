/**
 * C3: the pane under a thumb (docs/MOBILE-PLAN.md §4).
 *
 * A separate file from `TerminalPane.test.tsx` and `TerminalPane.keyboard.test.tsx` for the reason
 * C2 gives in its own header: several lanes are editing this component in the same hours, and one
 * 1,800-line test file is a merge conflict per assertion.
 *
 * The gesture's arithmetic is `touch-scroll.test.ts`'s subject and the engine's scroll is
 * `renderer.scroll.test.ts`'s. What is left - and it is the part the owner's device round is
 * about - is the WIRING: that a drag reaches the renderer, that a touch reaches the PTY only when
 * an application asked for the mouse, that a long press ends in a Copy pill, and that a desktop
 * pane is the pane it has always been.
 */

import { act, cleanup, render } from '@testing-library/react';
import { useRef, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onClipboardOffer, resetClipboardOffersForTests, type ClipboardOffer } from '../state/clipboard';
import { PhoneKeyBar } from './PhoneKeyBar';
import { TerminalPane } from './TerminalPane';
import {
    createFakePhoneWindow,
    createFakePtyApi,
    createFakeRendererFactory,
    installFakeResizeObserver,
    type FakePhoneWindow,
    type FakeRenderer
} from './testing';
import { TERMINAL_SCROLL_ATTRIBUTE } from './touch-scroll';

/** The cell every phone test in this directory uses: 10x20 CSS px. */
const CELL = { width: 10, height: 20 };
const PANE = { width: 390, height: 844 };

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    vi.useFakeTimers();
    observers = installFakeResizeObserver();
    resetClipboardOffersForTests();
});

afterEach(() => {
    cleanup();
    observers.restore();
    resetClipboardOffersForTests();
    vi.useRealTimers();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

interface Harness {
    readonly win: FakePhoneWindow;
    readonly pty: ReturnType<typeof createFakePtyApi>;
    /** The content row, where C4's Copy pill lives now that the key bar is the window's (C9). */
    readonly row: HTMLElement;
    readonly root: HTMLElement;
    readonly host: HTMLElement;
    /** A stand-in for the engine's own canvas: below the host, where both engines put theirs. */
    readonly engine: HTMLElement;
    readonly engineEvents: string[];
    renderer(): FakeRenderer;
}

async function mountPane({ coarse = true } = {}): Promise<Harness> {
    const win = createFakePhoneWindow({ ...PANE, coarse });
    const renderers = createFakeRendererFactory({ cell: CELL });
    const pty = createFakePtyApi();
    /*
     * The app's shape: the content row, with the pane in it and the window's one key bar hanging
     * off its bottom edge (C9). The bar is here because C4's Copy pill is the bar's surface, and a
     * long press is the gesture that raises it.
     */
    function Row(): ReactElement {
        const row = useRef<HTMLDivElement | null>(null);
        return (
            <div ref={row} className="relative flex min-h-0 flex-1">
                <TerminalPane
                    paneID="pane-touch"
                    ptyApi={pty}
                    focused
                    visible
                    createRenderer={renderers.factory}
                    measure={() => ({ width: PANE.width, height: PANE.height })}
                    formFactorWindow={win}
                />
                <PhoneKeyBar paneID="pane-touch" contentRow={row} formFactorWindow={win} />
            </div>
        );
    }
    const view = render(<Row />);
    await settle();
    const row = view.container.firstElementChild as HTMLElement;
    const root = view.container.querySelector('[data-pane-id="pane-touch"]') as HTMLElement;
    const host = root.querySelector('[data-terminal-host]') as HTMLElement;
    const engine = document.createElement('div');
    const engineEvents: string[] = [];
    for (const type of ['touchstart', 'touchmove', 'touchend']) {
        engine.addEventListener(type, () => engineEvents.push(type));
    }
    host.appendChild(engine);
    return { win, pty, row, root, host, engine, engineEvents, renderer: () => renderers.last() };
}

/**
 * One touch frame, dispatched at the engine stand-in so it travels the host's capture listeners
 * exactly as a real one does.
 *
 * Built by hand rather than through `fireEvent.touchStart`: jsdom has no `TouchEvent` constructor,
 * and what the pane reads is only `touches` / `changedTouches`.
 */
function touch(
    target: HTMLElement,
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    points: { clientX: number; clientY: number }[]
): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const list = type === 'touchend' || type === 'touchcancel' ? [] : points;
    Object.defineProperty(event, 'touches', { value: list });
    Object.defineProperty(event, 'changedTouches', { value: points });
    act(() => {
        target.dispatchEvent(event);
    });
    return event;
}

const finger = (y: number, x = 120): { clientX: number; clientY: number } => ({ clientX: x, clientY: y });

describe('a phone pane scrolls its scrollback under a finger', () => {
    it('turns a drag into whole lines on the RENDERER, and sends nothing to the PTY', async () => {
        const h = await mountPane();
        touch(h.engine, 'touchstart', [finger(400)]);
        // 60 px down a 20 px cell: three lines BACK through history (the engine's negative).
        touch(h.engine, 'touchmove', [finger(460)]);
        touch(h.engine, 'touchend', [finger(460)]);

        expect(h.renderer().scrolls).toEqual([-3]);
        expect(h.renderer().scrollOffset()).toBe(3);
        // THE SPIKE'S RULE: with no application asking for the mouse, a touch is pure gesture.
        expect(h.pty.last().input).toEqual([]);
        expect(h.pty.last().directInput).toEqual([]);
    });

    it('publishes how far back it is, and follows the engine when output snaps it home', async () => {
        const h = await mountPane();
        expect(h.root.getAttribute(TERMINAL_SCROLL_ATTRIBUTE)).toBe('0');
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(500)]);
        touch(h.engine, 'touchend', [finger(500)]);
        expect(h.root.getAttribute(TERMINAL_SCROLL_ATTRIBUTE)).toBe('5');

        // The constraint the plan names: the next chunk of output puts the viewport back at the
        // bottom, and the attribute must say so rather than report the last drag.
        act(() => {
            h.renderer().write('a line of output\r\n');
        });
        expect(h.root.getAttribute(TERMINAL_SCROLL_ATTRIBUTE)).toBe('0');
    });

    it('keeps the drag off the ENGINE, and leaves a plain tap to it', async () => {
        const h = await mountPane();
        touch(h.engine, 'touchstart', [finger(400)]);
        const move = touch(h.engine, 'touchmove', [finger(460)]);
        const end = touch(h.engine, 'touchend', [finger(460)]);
        // Consumed in the capture phase, so the engine's canvas listeners never run: its own
        // `touchend` focuses the hidden textarea, which on a phone raises the software keyboard -
        // reading your scrollback must not do that.
        expect(move.defaultPrevented).toBe(true);
        expect(end.defaultPrevented).toBe(true);
        // The `touchstart` is deliberately let through: a contact that has not moved yet may still
        // turn out to be a tap, and nothing the engine does on a `touchstart` is destructive. The
        // two that decide the gesture are the ones taken away.
        expect(h.engineEvents).toEqual(['touchstart']);

        // A TAP is a different gesture and belongs to the engine, because its `touchend` focus is
        // the only way a phone gets its keyboard back.
        const tapStart = touch(h.engine, 'touchstart', [finger(400)]);
        const tapEnd = touch(h.engine, 'touchend', [finger(400)]);
        expect(tapStart.defaultPrevented).toBe(false);
        expect(tapEnd.defaultPrevented).toBe(false);
        expect(h.engineEvents).toEqual(['touchstart', 'touchstart', 'touchend']);
    });

    it('scrolls for a drag DOWN and comes back for a drag UP', async () => {
        const h = await mountPane();
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(600)]);
        touch(h.engine, 'touchend', [finger(600)]);
        expect(h.renderer().scrollOffset()).toBe(10);

        touch(h.engine, 'touchstart', [finger(600)]);
        touch(h.engine, 'touchmove', [finger(520)]);
        touch(h.engine, 'touchend', [finger(520)]);
        expect(h.renderer().scrollOffset()).toBe(6);
    });
});

describe('a phone pane selects a word on a long press', () => {
    it('selects it, mirrors the length, and offers it to the Copy pill', async () => {
        const h = await mountPane();
        h.renderer().wordAtPoint = 'ripgrep';
        const offers: ClipboardOffer[] = [];
        const off = onClipboardOffer((offer) => offers.push(offer));

        touch(h.engine, 'touchstart', [finger(400)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });

        expect(h.renderer().wordPresses).toEqual([{ clientX: 120, clientY: 400 }]);
        // §TERM-034's mirror, which is also what the audit reads.
        expect(h.root.getAttribute('data-terminal-selection')).toBe('7');
        // C4's pill, reused: the press cannot write the clipboard itself (no transient
        // activation), so the offer is what puts a tap on the screen that can.
        expect(offers).toEqual([{ paneID: 'pane-touch', text: 'ripgrep', bytes: 7 }]);
        expect(h.row.querySelector('[data-terminal-copy-pill]')).not.toBeNull();
        // And still nothing on the wire.
        expect(h.pty.last().input).toEqual([]);
        expect(h.pty.last().directInput).toEqual([]);
        off();
    });

    it('offers nothing for a press on blank space', async () => {
        const h = await mountPane();
        const offers: ClipboardOffer[] = [];
        const off = onClipboardOffer((offer) => offers.push(offer));
        touch(h.engine, 'touchstart', [finger(400)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(h.renderer().wordPresses).toHaveLength(1);
        expect(offers).toEqual([]);
        expect(h.row.querySelector('[data-terminal-copy-pill]')).toBeNull();
        off();
    });

    it('does not fire for a drag, and the next contact drops the highlight', async () => {
        const h = await mountPane();
        h.renderer().wordAtPoint = 'ripgrep';
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(460)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(h.renderer().wordPresses).toEqual([]);

        // A press that DID select, and then a new contact: the engine's `clearSelection()` fires
        // no change event (#81), so the pane has to mirror the clear itself.
        touch(h.engine, 'touchstart', [finger(300)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(h.root.getAttribute('data-terminal-selection')).toBe('7');
        touch(h.engine, 'touchstart', [finger(300)]);
        expect(h.renderer().selection()).toBe('');
        expect(h.root.getAttribute('data-terminal-selection')).toBe('0');
    });
});

/**
 * #123 - the same pane, over an application that reports the mouse.
 *
 * This describe block used to pin the defect. It asserted that a touchstart, a touchmove and a
 * touchend became a press, a motion report and a release of button 0 - which is a CLICK, and on
 * the owner's phone it was a click on Claude Code's task line at the bottom of the pane. The
 * measurement is in `touch-scroll.ts`'s header and in `phone-touch-mouse-reporting`; what is left
 * here is the WIRING, which is this file's subject: that the gesture machine now owns the contact
 * in both modes, and that the bytes it earns are the ones the mouse reporter already encodes.
 */
describe('a phone pane under an application that asked for the mouse (#123)', () => {
    /** Turn on what Claude Code turns on: 1002 (motion while a button is down) in SGR. */
    const asksForTheMouse = (h: Harness): void => {
        act(() => {
            h.pty.last().modes({ mouseTracking: 'drag', mouseFormat: 'sgr' });
        });
    };

    it('a DRAG is wheel reports at the finger, and never a press or a release', async () => {
        const h = await mountPane();
        asksForTheMouse(h);

        touch(h.engine, 'touchstart', [finger(61, 45)]);
        touch(h.engine, 'touchmove', [finger(81, 85)]);
        touch(h.engine, 'touchend', [finger(81, 85)]);

        // 20 px down a 20 px cell: ONE line back through history, which is one SGR button-64
        // (wheel up) report at the cell under the finger. Not a press, not a motion report, and
        // above all not a release - the release is what a TUI reads as the click.
        expect(h.pty.last().directInput).toEqual(['\x1b[<64;9;5M']);
        expect(h.pty.last().input).toEqual([]);
        // The pane scrolled no scrollback of its own: the application is painting that screen.
        expect(h.renderer().scrolls).toEqual([]);
        expect(h.renderer().scrollOffset()).toBe(0);
        // …and every event of the gesture was taken off the engine, exactly as before: the
        // `touchstart` too, because `preventDefault` there is what suppresses the browser's
        // compatibility mouse events, which the pane's own `mousedown`/`mouseup` listeners would
        // otherwise report as the press and release this change exists to stop sending.
        expect(h.engineEvents).toEqual([]);
    });

    it('dragging the other way is the other wheel button', async () => {
        const h = await mountPane();
        asksForTheMouse(h);
        touch(h.engine, 'touchstart', [finger(81, 45)]);
        touch(h.engine, 'touchmove', [finger(61, 85)]);
        touch(h.engine, 'touchend', [finger(61, 85)]);
        expect(h.pty.last().directInput).toEqual(['\x1b[<65;9;4M']);
    });

    it('THE OWNER S GESTURE: a drag that ends on the bottom rows sends no click there', async () => {
        const h = await mountPane();
        asksForTheMouse(h);

        // Down the whole pane, the way a thumb runs out of glass on a 844 px phone.
        touch(h.engine, 'touchstart', [finger(61, 45)]);
        touch(h.engine, 'touchmove', [finger(400, 45)]);
        touch(h.engine, 'touchmove', [finger(800, 45)]);
        touch(h.engine, 'touchend', [finger(800, 45)]);

        const trail = h.pty.last().directInput;
        expect(trail.length).toBeGreaterThan(0);
        // Every byte on the wire is a wheel report. On the base this trail ended
        // `\x1b[<0;5;40m` - a release of button 0 on the pane's bottom row.
        expect(trail.every((report) => /^\x1b\[<6[4-7];\d+;\d+M$/.test(report))).toBe(true);
        expect(trail.some((report) => report.endsWith('m'))).toBe(false);
    });

    it('a TAP is the one gesture reported as a click', async () => {
        const h = await mountPane();
        asksForTheMouse(h);
        touch(h.engine, 'touchstart', [finger(61, 45)]);
        touch(h.engine, 'touchend', [finger(61, 45)]);
        // A press and a release at the same cell: what an application that turned mouse reporting
        // on asked to be told about.
        expect(h.pty.last().directInput).toEqual(['\x1b[<0;5;4M', '\x1b[<0;5;4m']);
        expect(h.renderer().scrolls).toEqual([]);
    });

    it('a LONG PRESS is the application s press: no word selection, no Copy pill', async () => {
        const h = await mountPane();
        h.renderer().wordAtPoint = 'ripgrep';
        const offers: ClipboardOffer[] = [];
        const off = onClipboardOffer((offer) => offers.push(offer));
        asksForTheMouse(h);

        touch(h.engine, 'touchstart', [finger(61, 45)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        // C3's timer was never armed: an application that reports the mouse asked for the press,
        // and a contact cannot mean two things at once.
        expect(h.renderer().wordPresses).toEqual([]);
        expect(offers).toEqual([]);
        expect(h.row.querySelector('[data-terminal-copy-pill]')).toBeNull();

        touch(h.engine, 'touchend', [finger(61, 45)]);
        // It reaches the application as the same click a shorter tap does.
        expect(h.pty.last().directInput).toEqual(['\x1b[<0;5;4M', '\x1b[<0;5;4m']);
        off();
    });

    it('a touchcancel mid-drag strands nothing on the wire', async () => {
        const h = await mountPane();
        asksForTheMouse(h);
        touch(h.engine, 'touchstart', [finger(61, 45)]);
        touch(h.engine, 'touchmove', [finger(81, 45)]);
        const during = h.pty.last().directInput.length;
        touch(h.engine, 'touchcancel', [finger(81, 45)]);
        // No release for a press that was never sent - and none invented for the cancel either.
        expect(h.pty.last().directInput).toHaveLength(during);
    });

    it('and goes back to scrolling the moment the application stops asking', async () => {
        const h = await mountPane();
        asksForTheMouse(h);
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(460)]);
        touch(h.engine, 'touchend', [finger(460)]);
        expect(h.renderer().scrolls).toEqual([]);

        act(() => {
            h.pty.last().modes({ mouseTracking: 'none', mouseFormat: 'sgr' });
        });
        const before = h.pty.last().directInput.length;
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(460)]);
        touch(h.engine, 'touchend', [finger(460)]);
        expect(h.renderer().scrolls).toEqual([-3]);
        expect(h.pty.last().directInput).toHaveLength(before);
    });

    it('the mode is latched at the gesture s start: a mid-gesture change does not split it', async () => {
        const h = await mountPane();
        asksForTheMouse(h);
        touch(h.engine, 'touchstart', [finger(61, 45)]);
        // The application drops reporting with the finger still down. The rest of THIS gesture is
        // still its own - a contact must not be half a wheel and half a viewport scroll, and a
        // drag that started over a TUI must not suddenly start moving the scrollback the TUI is
        // painting over.
        act(() => {
            h.pty.last().modes({ mouseTracking: 'none', mouseFormat: 'sgr' });
        });
        touch(h.engine, 'touchmove', [finger(81, 85)]);
        touch(h.engine, 'touchend', [finger(81, 85)]);
        expect(h.renderer().scrolls).toEqual([]);
        expect(h.renderer().scrollOffset()).toBe(0);
        // The wheel still goes to the reporter, and the reporter is the authority on the wire: it
        // declines to encode for a mode nothing is asking for any more, which is the same answer
        // a real mouse gets when a TUI turns reporting off under its drag.
        expect(h.pty.last().directInput).toEqual([]);

        // The NEXT gesture is in the mode that is live when it starts, and scrolls again.
        touch(h.engine, 'touchstart', [finger(400)]);
        touch(h.engine, 'touchmove', [finger(460)]);
        touch(h.engine, 'touchend', [finger(460)]);
        expect(h.renderer().scrolls).toEqual([-3]);
    });
});

describe('AND NOT ON DESKTOP', () => {
    it('has no touch listener, no scroll attribute and the markup it has always had', async () => {
        // The same 390x844 window; a FINE pointer is what makes it a desktop, which is the
        // form-factor rule's own "a narrow window is still a desktop" case.
        const h = await mountPane({ coarse: false });

        touch(h.engine, 'touchstart', [finger(400)]);
        const move = touch(h.engine, 'touchmove', [finger(600)]);
        touch(h.engine, 'touchend', [finger(600)]);

        expect(h.renderer().scrolls).toEqual([]);
        expect(h.renderer().scrollOffset()).toBe(0);
        // Nothing was consumed, so every event reached the engine exactly as it does today.
        expect(move.defaultPrevented).toBe(false);
        expect(h.engineEvents).toEqual(['touchstart', 'touchmove', 'touchend']);
        expect(h.root.hasAttribute(TERMINAL_SCROLL_ATTRIBUTE)).toBe(false);
        // …and the tree is the one C1 pinned: no class, no attribute, no extra node.
        expect(h.root.className).toBe('relative h-full w-full overflow-hidden ');
        expect(h.host.className).toBe('h-full w-full');
    });

    it('and a long press on a desktop selects nothing and offers nothing', async () => {
        const h = await mountPane({ coarse: false });
        h.renderer().wordAtPoint = 'ripgrep';
        const offers: ClipboardOffer[] = [];
        const off = onClipboardOffer((offer) => offers.push(offer));
        touch(h.engine, 'touchstart', [finger(400)]);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
        });
        expect(h.renderer().wordPresses).toEqual([]);
        expect(offers).toEqual([]);
        off();
    });
});
