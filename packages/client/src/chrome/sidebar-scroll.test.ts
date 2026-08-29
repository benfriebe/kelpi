/**
 * §WS-102's reveal arithmetic: the minimum scroll, the insets, the already-visible no-op, and
 * the 0.22s animation — all four checkable without a DOM, which is the reason they live in
 * `sidebar-scroll.ts` rather than inside the effect that calls them.
 */

import { describe, expect, it } from 'vitest';

import { animateScrollTop, revealScrollTop } from './sidebar-scroll';

describe('revealScrollTop', () => {
    const viewport = { scrollTop: 0, viewportHeight: 200 };

    it('no-ops when the row is already fully visible', () => {
        expect(revealScrollTop({ ...viewport, rowTop: 40, rowHeight: 30 })).toBeNull();
    });

    it('scrolls the MINIMUM amount to bring a row below the fold into view', () => {
        // A row at 210..240 in a 200-tall viewport needs exactly 40px, not "centre it".
        expect(revealScrollTop({ ...viewport, rowTop: 210, rowHeight: 30 })).toBe(40);
    });

    it('scrolls up by the minimum for a row above the fold', () => {
        expect(revealScrollTop({ scrollTop: 100, viewportHeight: 200, rowTop: 60, rowHeight: 30 })).toBe(60);
    });

    it('honours the top inset, so a revealed row is not flush against the content padding', () => {
        // The row is 4px below the scroll origin; with a 4px inset the reveal lands at 0, not 4.
        expect(
            revealScrollTop({ scrollTop: 100, viewportHeight: 200, rowTop: 4, rowHeight: 30, topInset: 4 })
        ).toBe(0);
        // …and a row that sits exactly under the inset is treated as hidden, not visible.
        expect(
            revealScrollTop({ scrollTop: 40, viewportHeight: 200, rowTop: 42, rowHeight: 30, topInset: 4 })
        ).toBe(38);
    });

    it('honours a bottom inset for anything overlaying the foot of the list', () => {
        expect(
            revealScrollTop({ ...viewport, rowTop: 160, rowHeight: 30, bottomInset: 20 })
        ).toBe(10);
    });

    it('aligns a row taller than the viewport to the top rather than to its bottom edge', () => {
        expect(revealScrollTop({ ...viewport, rowTop: 300, rowHeight: 400 })).toBe(300);
    });

    it('never asks for a negative scrollTop', () => {
        expect(revealScrollTop({ scrollTop: 10, viewportHeight: 200, rowTop: 0, rowHeight: 30, topInset: 40 })).toBe(0);
    });
});

describe('animateScrollTop', () => {
    /** A hand-cranked clock and frame queue: the animation is checked mid-flight, not just at rest. */
    function harness() {
        const frames: ((time: number) => void)[] = [];
        let clock = 0;
        return {
            element: { scrollTop: 0 },
            raf: (callback: (time: number) => void): unknown => {
                frames.push(callback);
                return frames.length;
            },
            now: (): number => clock,
            advance(ms: number): void {
                clock += ms;
                const due = frames.splice(0, frames.length);
                for (const frame of due) frame(clock);
            },
            pending: (): number => frames.length
        };
    }

    it('moves scrollTop over the named duration and lands exactly on the target', () => {
        const h = harness();
        animateScrollTop(h.element, 200, { durationMs: 220, now: h.now, raf: h.raf, timer: null });

        h.advance(0);
        expect(h.element.scrollTop).toBe(0);

        // Mid-flight: strictly between the two ends, which is the whole claim.
        h.advance(110);
        expect(h.element.scrollTop).toBeGreaterThan(0);
        expect(h.element.scrollTop).toBeLessThan(200);

        h.advance(110);
        expect(h.element.scrollTop).toBe(200);
        // And it stops asking for frames once it has landed.
        h.advance(16);
        expect(h.pending()).toBe(0);
    });

    it('decelerates — more than half the distance is covered in the first half', () => {
        const h = harness();
        animateScrollTop(h.element, 100, { durationMs: 220, now: h.now, raf: h.raf, timer: null });
        h.advance(0);
        h.advance(110);
        expect(h.element.scrollTop).toBeGreaterThan(50);
    });

    it('cancels cleanly, leaving scrollTop wherever it had got to', () => {
        const h = harness();
        const cancel = animateScrollTop(h.element, 200, { durationMs: 220, now: h.now, raf: h.raf, timer: null });
        h.advance(0);
        h.advance(55);
        const at = h.element.scrollTop;
        cancel();
        h.advance(200);
        expect(h.element.scrollTop).toBe(at);
    });

    /**
     * The settle guard. Frames are not guaranteed — a renderer stops delivering them for
     * reasons the page cannot see — and a reveal that dies short of its target has failed the
     * one thing §WS-102 asks for.
     */
    it('lands on the target even if the frames simply stop coming', () => {
        const h = harness();
        const timers: { fn: () => void; ms: number }[] = [];
        animateScrollTop(h.element, 200, {
            durationMs: 220,
            now: h.now,
            raf: h.raf,
            timer: (fn, ms) => {
                timers.push({ fn, ms });
                return timers.length;
            }
        });
        h.advance(0);
        h.advance(150);
        expect(h.element.scrollTop).toBeLessThan(200);
        // …and now nothing more is delivered. The guard fires just past the duration.
        expect(timers[0]?.ms).toBe(260);
        timers[0]?.fn();
        expect(h.element.scrollTop).toBe(200);
    });

    it('the guard is idempotent, and a cancel beats it', () => {
        const h = harness();
        const timers: (() => void)[] = [];
        const cancel = animateScrollTop(h.element, 200, {
            durationMs: 220,
            now: h.now,
            raf: h.raf,
            timer: (fn) => timers.push(fn)
        });
        h.advance(0);
        h.advance(300); // the frames finish it first
        expect(h.element.scrollTop).toBe(200);
        timers[0]?.();
        expect(h.element.scrollTop).toBe(200);

        const other = harness();
        const late: (() => void)[] = [];
        const stop = animateScrollTop(other.element, 200, {
            durationMs: 220,
            now: other.now,
            raf: other.raf,
            timer: (fn) => late.push(fn)
        });
        other.advance(0);
        other.advance(60);
        const at = other.element.scrollTop;
        stop();
        late[0]?.();
        expect(other.element.scrollTop).toBe(at);
        void cancel;
    });

    /**
     * §N34: the destination is a promise about a ROW, and rows move.
     *
     * The live case is the group header the reveal is measured against at 36 px, which mounts
     * its inline rename field a commit later and becomes 38 — after the reveal has been
     * computed, consumed and forgotten. These three cover the seam: a target that moves while
     * the animation runs, one that moves after it has landed, and the bound on how long the
     * reveal is willing to keep looking.
     */
    it('lands on the destination as it is when it LANDS, not as it was when it started', () => {
        const h = harness();
        let want = 200;
        animateScrollTop(h.element, want, {
            durationMs: 220,
            now: h.now,
            raf: h.raf,
            timer: null,
            retarget: () => want
        });
        h.advance(0);
        h.advance(110);
        // The row grew under the reveal (the rename field mounted): 2px further down.
        want = 202;
        h.advance(110);
        expect(h.element.scrollTop).toBe(202);
    });

    it('keeps honouring the destination through the settle window, then stops', () => {
        const h = harness();
        let want = 200;
        animateScrollTop(h.element, want, {
            durationMs: 220,
            now: h.now,
            raf: h.raf,
            timer: null,
            retarget: () => want,
            settleMs: 400
        });
        h.advance(0);
        h.advance(220);
        expect(h.element.scrollTop).toBe(200);
        // A commit AFTER the reveal moved the row. The historical one-shot never looked again.
        want = 223;
        h.advance(16);
        expect(h.element.scrollTop).toBe(223);
        // …and once the window is spent the reveal lets go, whatever moves next.
        h.advance(400);
        want = 900;
        h.advance(16);
        expect(h.element.scrollTop).toBe(223);
        expect(h.pending()).toBe(0);
    });

    it('a cancel ends the settle watch too — the caller can hand the list back', () => {
        const h = harness();
        let want = 200;
        const cancel = animateScrollTop(h.element, want, {
            durationMs: 220,
            now: h.now,
            raf: h.raf,
            timer: null,
            retarget: () => want,
            settleMs: 400
        });
        h.advance(0);
        h.advance(220);
        expect(h.element.scrollTop).toBe(200);
        cancel();
        want = 400;
        h.advance(16);
        expect(h.element.scrollTop).toBe(200);
        expect(h.pending()).toBe(0);
    });

    it('assigns immediately with no frames available (jsdom) or a zero duration', () => {
        const frames = globalThis.requestAnimationFrame;
        // @ts-expect-error — deliberately modelling an environment that has no frames at all.
        delete globalThis.requestAnimationFrame;
        const bare = { scrollTop: 0 };
        try {
            animateScrollTop(bare, 120, { durationMs: 220, now: () => 0, timer: null });
        } finally {
            globalThis.requestAnimationFrame = frames;
        }
        expect(bare.scrollTop).toBe(120);

        const instant = { scrollTop: 0 };
        const h = harness();
        animateScrollTop(instant, 90, { durationMs: 0, now: h.now, raf: h.raf, timer: null });
        expect(instant.scrollTop).toBe(90);
        expect(h.pending()).toBe(0);
    });
});
