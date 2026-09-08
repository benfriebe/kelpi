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
    /** #123 - every `reportWheel`, in order: the lines and where the finger was. */
    readonly wheels: { lines: number; point: TouchPointLike }[];
    /** #123 - every `reportClick`, in order. */
    readonly clicks: TouchPointLike[];
    offset(): number;
    /** Advance the clock; run the pending frame if one is due. */
    tick(ms: number): void;
    /** Advance the clock without running a frame - what a finger resting does. */
    wait(ms: number): void;
    /** Fire the long-press timer if it is armed and due. */
    hold(ms: number): void;
    frames(): number;
    /** Turn mouse reporting on or off between (or during) gestures - the latch's subject. */
    report(on: boolean): void;
}

function harness({ cell = CELL, cap = 1_000, offset = 0, reporting = false } = {}): Harness {
    let time = 0;
    let viewport = offset;
    let reports = reporting;
    let pendingFrame: ((now: number) => void) | null = null;
    let pendingTimer: { at: number; callback: () => void } | null = null;
    let frameCount = 0;
    const deltas: number[] = [];
    const presses: TouchPointLike[] = [];
    const wheels: { lines: number; point: TouchPointLike }[] = [];
    const clicks: TouchPointLike[] = [];

    const scroller = createTouchScroll(
        {
            scrollLines: (delta) => {
                deltas.push(delta);
                // The engines' own clamp: 0 is the live bottom, `cap` the top of the scrollback.
                viewport = Math.max(0, Math.min(cap, viewport - delta));
            },
            scrollOffset: () => viewport,
            cellHeight: () => cell,
            onLongPress: (point) => presses.push(point),
            reportsMouse: () => reports,
            reportWheel: (lines, point) => wheels.push({ lines, point }),
            reportClick: (point) => clicks.push(point)
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
        wheels,
        clicks,
        offset: () => viewport,
        frames: () => frameCount,
        report(on: boolean): void {
            reports = on;
        },
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

/**
 * #123 - the same machine over an application that reports the mouse.
 *
 * The owner's report is one sentence: on a Claude Code tab, "scrolling down ... can scroll into
 * the lower part of the TUI and open the menus", which is its task line being clicked. Measured on
 * the base by `phone-touch-mouse-reporting`, a 200 px drag ending on the bottom row of a 50-row
 * grid put this on the wire:
 *
 *     ^[[<0;24;16M  ^[[<32;24;18M ... ^[[<32;24;50M  ^[[<0;24;50m
 *     |- press       |- 12 motion reports             |- release, on the LAST ROW
 *
 * A press with a release is a click. Everything below is the rule that replaced it, in the sign
 * and the units this machine speaks; the bytes those turn into are `mouse.ts`'s subject and the
 * wiring between them is `TerminalPane.touch.test.tsx`'s.
 */
describe('the touch gesture over an application that reports the mouse (#123)', () => {
    it('a drag DOWN the glass is wheel reports at the finger, and never a press or a release', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(460, 120)));
        expect(h.scroller.end(one(at(460, 120), { down: false }))).toBe(true);

        // 60 px over a 20 px cell: three lines back through history, which is three wheel-UP
        // detents (the engine's negative sign, the same one `scrollLines` takes).
        expect(h.wheels).toEqual([{ lines: -3, point: { clientX: 120, clientY: 460 } }]);
        expect(h.clicks).toEqual([]);
        // …and NOT the pane's own viewport: the application is painting that screen.
        expect(h.deltas).toEqual([]);
        expect(h.offset()).toBe(0);
    });

    it('a drag UP the glass is the other direction, still with no click', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(460)));
        h.scroller.move(one(at(400)));
        h.scroller.end(one(at(400), { down: false }));
        expect(h.wheels).toEqual([{ lines: 3, point: { clientX: 100, clientY: 400 } }]);
        expect(h.clicks).toEqual([]);
    });

    it('THE OWNER-S GESTURE: a drag that ends deep down the glass reports nothing at its end', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(100)));
        // Down to the bottom rows in four moves, the way a thumb runs out of glass.
        for (const y of [200, 400, 600, 800]) h.scroller.move(one(at(y)));
        h.scroller.end(one(at(800), { down: false }));

        expect(h.wheels.map((wheel) => wheel.lines)).toEqual([-5, -10, -10, -10]);
        // The whole fix, in one assertion: the end of a drag is not a click on the bottom row.
        expect(h.clicks).toEqual([]);
    });

    it('a TAP is the one gesture reported as a click, at the point it started', () => {
        const h = harness({ reporting: true });
        // Consumed from the first event: `preventDefault` on `touchstart` is what suppresses the
        // browser's compatibility mouse events, which would otherwise be reported as a SECOND
        // press and release by the pane's own mouse listeners.
        expect(h.scroller.start(one(at(400)))).toBe(true);
        h.wait(60);
        expect(h.scroller.end(one(at(400), { down: false }))).toBe(true);
        expect(h.clicks).toEqual([{ clientX: 100, clientY: 400 }]);
        expect(h.wheels).toEqual([]);
    });

    it('a wobble inside the slop is still a tap, and the click is at the ORIGIN', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400, 100)));
        // Inside the slop, but across a cell boundary: a click whose press and release named
        // different cells would read as a one-cell drag rather than a click.
        h.scroller.move(one(at(400 + TOUCH_SLOP_PX, 100)));
        h.scroller.end(one(at(400 + TOUCH_SLOP_PX, 100), { down: false }));
        expect(h.clicks).toEqual([{ clientX: 100, clientY: 400 }]);
    });

    it('a LONG PRESS is the application-s press, not C3-s word selection', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400)));
        h.hold(LONG_PRESS_MS);
        // No timer was ever armed: the application asked for the press, so there is no second
        // meaning for the same contact and no Copy pill to raise.
        expect(h.presses).toEqual([]);
        expect(h.scroller.pressed).toBe(false);
        h.scroller.end(one(at(400), { down: false }));
        // It reaches the application as the same click a shorter tap does.
        expect(h.clicks).toEqual([{ clientX: 100, clientY: 400 }]);
    });

    it('the momentum tail reports while it moves and reports NOTHING at rest', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(200)));
        h.tick(16);
        h.scroller.move(one(at(300)));
        h.tick(16);
        h.scroller.move(one(at(400)));
        h.scroller.end(one(at(400), { down: false }));
        expect(h.scroller.gesture).toBe('momentum');

        const duringDrag = h.wheels.length;
        for (let frame = 0; frame < 200 && h.scroller.gesture === 'momentum'; frame += 1) h.tick(16);
        expect(h.scroller.gesture).toBe('none');
        expect(h.wheels.length).toBeGreaterThan(duringDrag);
        // Every report is a wheel; a tail that ended in a release would be the defect again.
        expect(h.clicks).toEqual([]);

        // AT REST: more frames, and nothing more on the wire.
        const settled = h.wheels.length;
        for (let frame = 0; frame < 60; frame += 1) h.tick(16);
        expect(h.wheels.length).toBe(settled);
    });

    it('the tail is not clamped by a scrollback it is not scrolling', () => {
        // An application has no end for a fling to run past, so the reporting tail may only end on
        // its own decay. A host whose viewport CANNOT move (cap 0) would stop C3's tail on its
        // first frame; this one has to keep reporting.
        const h = harness({ reporting: true, cap: 0 });
        h.scroller.start(one(at(200)));
        h.tick(16);
        h.scroller.move(one(at(300)));
        h.tick(16);
        h.scroller.move(one(at(400)));
        h.scroller.end(one(at(400), { down: false }));
        for (let frame = 0; frame < 200 && h.scroller.gesture === 'momentum'; frame += 1) h.tick(16);
        expect(h.wheels.length).toBeGreaterThan(2);
    });

    it('the mode is LATCHED at the gesture-s start, tail included', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(200)));
        h.tick(16);
        h.scroller.move(one(at(300)));
        h.tick(16);
        h.scroller.move(one(at(400)));
        h.scroller.end(one(at(400), { down: false }));
        // The application drops mouse reporting mid-flick. The tail it is already receiving must
        // not turn into a scroll of the pane's own viewport underneath it.
        h.report(false);
        for (let frame = 0; frame < 200 && h.scroller.gesture === 'momentum'; frame += 1) h.tick(16);
        expect(h.deltas).toEqual([]);
        expect(h.offset()).toBe(0);

        // …and the NEXT gesture is in the mode that is live when it starts.
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(460)));
        h.scroller.end(one(at(460), { down: false }));
        expect(h.deltas).toEqual([-3]);
    });

    it('the reverse latch: a gesture that began with nothing asking stays C3-s', () => {
        const h = harness();
        h.scroller.start(one(at(400)));
        h.report(true);
        h.scroller.move(one(at(460)));
        h.scroller.end(one(at(460), { down: false }));
        // A tail that started as a viewport scroll must not start writing bytes halfway through.
        expect(h.wheels).toEqual([]);
        expect(h.clicks).toEqual([]);
        expect(h.deltas).toEqual([-3]);
    });

    it('a cancel mid-drag strands nothing: no click, no release, no bytes at all', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(460)));
        const beforeCancel = h.wheels.length;
        h.scroller.cancel();
        expect(h.clicks).toEqual([]);
        expect(h.wheels).toHaveLength(beforeCancel);
        expect(h.scroller.gesture).toBe('none');
    });

    it('a second finger ends the gesture without a click, and is still taken off the engine', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400)));
        h.scroller.move(one(at(460)));
        // Consumed, because reporting is on and the engine must not turn the contact into a
        // selection either way - but nothing is sent for it.
        expect(h.scroller.move(two(at(460), at(300)))).toBe(true);
        expect(h.clicks).toEqual([]);
        expect(h.scroller.gesture).toBe('none');
    });
});

describe('#123 - a contact this machine never recognised reports nothing', () => {
    it('a two-finger start followed straight by an end reports no click at a stale origin', () => {
        const h = harness({ reporting: true });
        // A real gesture first, so `originX`/`originY` hold a point from it.
        h.scroller.start(one(at(400)));
        h.scroller.end(one(at(400), { down: false }));
        expect(h.clicks).toEqual([{ clientX: 100, clientY: 400 }]);

        // …then a two-finger contact, which is not a gesture this terminal has. It is still
        // consumed (reporting is on, so the engine must not select either way) and it reports
        // NOTHING - a click at the previous gesture's point would be a click nobody made.
        expect(h.scroller.start(two(at(600), at(700)))).toBe(true);
        expect(h.scroller.end(one(at(600), { down: false }))).toBe(false);
        expect(h.clicks).toEqual([{ clientX: 100, clientY: 400 }]);
    });

    it('an end after a cancel reports nothing either', () => {
        const h = harness({ reporting: true });
        h.scroller.start(one(at(400)));
        h.scroller.cancel();
        expect(h.scroller.end(one(at(400), { down: false }))).toBe(false);
        expect(h.clicks).toEqual([]);
    });
});
