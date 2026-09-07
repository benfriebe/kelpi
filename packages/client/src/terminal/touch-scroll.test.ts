/**
 * C3's gesture machine (docs/MOBILE-PLAN.md §4).
 *
 * Everything here is arithmetic, so everything here is driven with numbers: a fake clock, a fake
 * frame loop and a fake timer, and a host that models the engines' clamp (0 is the live bottom,
 * `cap` is the top of the scrollback). No DOM, no engine, no React - the pane's wiring is
 * `TerminalPane.touch.test.tsx`'s subject and the engine's scroll is `renderer.scroll.test.ts`'s.
 */

import { describe, expect, it } from 'vitest';

import {
    LONG_PRESS_MS,
    MOMENTUM_MIN_VELOCITY,
    TOUCH_SLOP_PX,
    createTouchScroll,
    type TouchEventLike,
    type TouchPointLike
} from './touch-scroll';

/** The cell the phone tests use everywhere else: 10x20 CSS px. */
const CELL = 20;

function at(y: number, x = 100): TouchPointLike {
    return { clientX: x, clientY: y };
}

/** A one-finger event; `changedTouches` carries the point even when `touches` is empty (the end). */
function one(point: TouchPointLike, { down = true } = {}): TouchEventLike {
    return { touches: down ? [point] : [], changedTouches: [point] };
}

function two(a: TouchPointLike, b: TouchPointLike): TouchEventLike {
    return { touches: [a, b], changedTouches: [a, b] };
}

interface Harness {
    readonly scroller: ReturnType<typeof createTouchScroll>;
    /** Every `scrollLines` delta, in the ENGINE's sign. */
    readonly deltas: number[];
    readonly presses: TouchPointLike[];
    offset(): number;
    /** Advance the clock; run the pending frame if one is due. */
    tick(ms: number): void;
    /** Advance the clock without running a frame - what a finger resting does. */
    wait(ms: number): void;
    /** Fire the long-press timer if it is armed and due. */
    hold(ms: number): void;
    frames(): number;
}

function harness({ cell = CELL, cap = 1_000, offset = 0 } = {}): Harness {
    let time = 0;
    let viewport = offset;
    let pendingFrame: ((now: number) => void) | null = null;
    let pendingTimer: { at: number; callback: () => void } | null = null;
    let frameCount = 0;
    const deltas: number[] = [];
    const presses: TouchPointLike[] = [];

    const scroller = createTouchScroll(
        {
            scrollLines: (delta) => {
                deltas.push(delta);
                // The engines' own clamp: 0 is the live bottom, `cap` the top of the scrollback.
                viewport = Math.max(0, Math.min(cap, viewport - delta));
            },
            scrollOffset: () => viewport,
            cellHeight: () => cell,
            onLongPress: (point) => presses.push(point)
        },
        {
            now: () => time,
            frame: (frame) => {
                pendingFrame = frame;
                return () => {
                    pendingFrame = null;
                };
            },
            timer: (callback, ms) => {
                pendingTimer = { at: time + ms, callback };
                return () => {
                    pendingTimer = null;
                };
            }
        }
    );

    return {
        scroller,
        deltas,
        presses,
        offset: () => viewport,
        frames: () => frameCount,
        wait(ms: number): void {
            time += ms;
        },
        tick(ms: number): void {
            time += ms;
            const frame = pendingFrame;
            pendingFrame = null;
            if (frame !== null) {
                frameCount += 1;
                frame(time);
            }
        },
        hold(ms: number): void {
            time += ms;
            const timer = pendingTimer;
            if (timer !== null && timer.at <= time) {
                pendingTimer = null;
                timer.callback();
            }
        }
    };
}

describe('the touch gesture: a drag scrolls the scrollback', () => {
    it('does nothing inside the touch slop, and does not take the event off the engine', () => {
        const h = harness();
        expect(h.scroller.start(one(at(400)))).toBe(false);
        // 8 px is the slop itself, so it is still a press: a hand that wobbles is not a scroll.
        expect(h.scroller.move(one(at(400 + TOUCH_SLOP_PX)))).toBe(false);
        expect(h.deltas).toEqual([]);
        expect(h.scroller.gesture).toBe('press');
    });

    it('a finger DOWN the glass goes BACK through history, in whole lines, keeping the remainder', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        // Past the slop on the first move: 12 px is 0 whole lines at a 20 px cell.
        expect(h.scroller.move(one(at(412)))).toBe(true);
        expect(h.deltas).toEqual([]);
        // 24 px accumulated: one line, and the 4 px remainder is KEPT rather than dropped.
        h.scroller.move(one(at(424)));
        expect(h.deltas).toEqual([-1]);
        // 4 + 12 = 16 px: still short of the next line.
        h.scroller.move(one(at(436)));
        expect(h.deltas).toEqual([-1]);
        // 16 + 12 = 28: the second line, and the machine has spent 40 of the 48 px dragged.
        h.scroller.move(one(at(448)));
        expect(h.deltas).toEqual([-1, -1]);
        expect(h.offset()).toBe(2);
    });

    it('and a finger UP the glass comes back toward the live bottom', () => {
        const h = harness({ offset: 10 });
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(360)));
        // The engine's sign, positive = toward the bottom (`TerminalRenderer.scrollLines`).
        expect(h.deltas).toEqual([2]);
        expect(h.offset()).toBe(8);
    });

    it('scrolls nothing while the engine has no cell to divide by', () => {
        const h = harness({ cell: 0 });
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(300)));
        expect(h.deltas).toEqual([]);
    });

    it('a second finger ends the gesture: pinch does nothing', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(460)));
        expect(h.deltas).toEqual([-3]);
        expect(h.scroller.move(two(at(460), at(500)))).toBe(false);
        expect(h.scroller.gesture).toBe('none');
        // …and a gesture that STARTS with two contacts never becomes one.
        expect(h.scroller.start(two(at(400), at(500)))).toBe(false);
        expect(h.scroller.move(two(at(460), at(600)))).toBe(false);
        expect(h.deltas).toEqual([-3]);
    });
});

describe('the touch gesture: the flick keeps going', () => {
    /** A flick: five 20 px steps, one every 10 ms - 2 px/ms, an unremarkable thumb. */
    function flick(h: Harness): void {
        h.scroller.start(one(at(400)));
        for (let step = 1; step <= 5; step += 1) {
            h.wait(10);
            h.scroller.move(one(at(400 + step * 20)));
        }
        h.wait(10);
        h.scroller.end(one(at(500), { down: false }));
    }

    it('keeps scrolling after the finger is up, and stops on its own', () => {
        const h = harness();
        flick(h);
        const draggedTo = h.offset();
        expect(draggedTo).toBe(5);
        expect(h.scroller.gesture).toBe('momentum');

        // The tail, one 16 ms frame at a time. It must still be moving after the first few…
        for (let frame = 0; frame < 3; frame += 1) h.tick(16);
        const early = h.offset();
        expect(early).toBeGreaterThan(draggedTo);

        // …and it must STOP, rather than run until something else interrupts it.
        for (let frame = 0; frame < 200 && h.scroller.gesture === 'momentum'; frame += 1) h.tick(16);
        expect(h.scroller.gesture).toBe('none');
        const settled = h.offset();
        expect(settled).toBeGreaterThan(early);
        // A 2 px/ms flick decays with a 325 ms time constant, so the tail is worth about
        // `v * decay / cell` lines: 2 * 325 / 20 = 32. Measured here: the tail carries the
        // viewport well past the 5 lines the drag itself moved, and lands inside that budget.
        expect(settled - draggedTo).toBeGreaterThan(10);
        expect(settled - draggedTo).toBeLessThanOrEqual(33);
        // Nothing keeps ticking once it is over.
        const after = h.frames();
        h.tick(16);
        expect(h.frames()).toBe(after);
    });

    it('a finger that STOPPED before it lifted leaves no momentum', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.wait(10);
        h.scroller.move(one(at(460)));
        // Held still for 200 ms: the velocity window has nothing but the resting samples in it.
        h.wait(200);
        h.scroller.move(one(at(460)));
        h.wait(10);
        expect(h.scroller.end(one(at(460), { down: false }))).toBe(true);
        expect(h.scroller.gesture).toBe('none');
        const settled = h.offset();
        h.tick(16);
        expect(h.offset()).toBe(settled);
    });

    it('stops at the end of the scrollback instead of spending a second of frames on a clamp', () => {
        // Two lines of history, and a flick that would carry forty.
        const h = harness({ cap: 2 });
        flick(h);
        expect(h.offset()).toBe(2);
        let frames = 0;
        while (h.scroller.gesture === 'momentum' && frames < 200) {
            h.tick(16);
            frames += 1;
        }
        expect(h.scroller.gesture).toBe('none');
        expect(h.offset()).toBe(2);
        // The give-away number: a tail that ignored the clamp would run the ~90 frames it takes
        // to decay below MOMENTUM_MIN_VELOCITY from 2 px/ms.
        expect(frames).toBeLessThan(10);
        expect(MOMENTUM_MIN_VELOCITY).toBeLessThan(0.1);
    });

    it('a new contact stops the tail where it is', () => {
        const h = harness();
        flick(h);
        h.tick(16);
        const caught = h.offset();
        h.scroller.start(one(at(300)));
        expect(h.scroller.gesture).toBe('press');
        h.tick(16);
        expect(h.offset()).toBe(caught);
    });
});

describe('the touch gesture: the long press', () => {
    it('fires once the contact has stayed put, and the release is the machine s to keep', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.hold(LONG_PRESS_MS);
        expect(h.presses).toEqual([{ clientX: 100, clientY: 400 }]);
        expect(h.scroller.pressed).toBe(true);
        // Consumed, so the engine's own `touchend` never runs: it would focus the textarea (and
        // raise the keyboard) over the word the press just selected.
        expect(h.scroller.end(one(at(400), { down: false }))).toBe(true);
        expect(h.scroller.pressed).toBe(false);
    });

    it('does not fire once the finger has moved, and a plain tap is left to the ENGINE', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(300)));
        h.hold(LONG_PRESS_MS);
        expect(h.presses).toEqual([]);

        // A tap: down, up, nothing in between, well inside the threshold.
        h.scroller.start(one(at(400)));
        h.wait(60);
        // NOT consumed: that `touchend` is how a phone raises its software keyboard, because the
        // engine's canvas listener focuses the hidden textarea on it.
        expect(h.scroller.end(one(at(400), { down: false }))).toBe(false);
        expect(h.presses).toEqual([]);
    });

    it('a cancel takes the armed press with it', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.scroller.cancel();
        h.hold(LONG_PRESS_MS);
        expect(h.presses).toEqual([]);
        expect(h.scroller.gesture).toBe('none');
    });
});
