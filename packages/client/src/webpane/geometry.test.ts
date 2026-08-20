/**
 * The geometry reporter's three rules: drop echoes, deliver appear/disappear now, throttle
 * movement with a trailing edge.
 *
 * Every one of them is about cost or correctness at the far end — each report crosses a socket
 * and moves a real OS-level browser view — so the timing is driven with an injected clock and
 * scheduler rather than real timers.
 */

import { describe, expect, it } from 'vitest';

import { createGeometryReporter, type GeometryReport } from './geometry';
import {
    readShellWindowID,
    readWindowTransparent,
    SHELL_WINDOW_PARAM,
    WINDOW_TRANSPARENT_PARAM
} from './shell-window';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';

function harness(throttleMs = 100) {
    const sent: GeometryReport[] = [];
    let clock = 1000;
    const timers: { at: number; run: () => void }[] = [];
    const reporter = createGeometryReporter({
        send: (report) => sent.push(report),
        throttleMs,
        now: () => clock,
        schedule: (callback, ms) => {
            const entry = { at: clock + ms, run: callback };
            timers.push(entry);
            return entry;
        },
        cancel: (handle) => {
            const index = timers.indexOf(handle as { at: number; run: () => void });
            if (index >= 0) timers.splice(index, 1);
        }
    });
    return {
        reporter,
        sent,
        /** Advance the clock and fire everything due. */
        advance(ms: number) {
            clock += ms;
            for (const entry of [...timers]) {
                if (entry.at > clock) continue;
                timers.splice(timers.indexOf(entry), 1);
                entry.run();
            }
        },
        get timerCount() {
            return timers.length;
        }
    };
}

function report(overrides: Partial<GeometryReport> = {}): GeometryReport {
    return {
        paneID: PANE,
        tabID: 'T1',
        rect: { x: 0, y: 24, w: 800, h: 600 },
        visible: true,
        devicePixelRatio: 2,
        ...overrides
    };
}

describe('geometry reporter', () => {
    it('sends the first report immediately — the view should appear when the pane does', () => {
        const h = harness();
        h.reporter.report(report());
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0]).toMatchObject({ paneID: PANE, visible: true });
    });

    it('drops an identical repeat (the grid re-renders every pane on any change)', () => {
        const h = harness();
        h.reporter.report(report());
        h.reporter.report(report());
        h.reporter.report(report());
        expect(h.sent).toHaveLength(1);
        expect(h.timerCount).toBe(0);
    });

    it('throttles movement and always delivers the final position', () => {
        const h = harness(100);
        h.reporter.report(report());
        // A drag: three frames inside the window.
        h.reporter.report(report({ rect: { x: 0, y: 24, w: 700, h: 600 } }));
        h.reporter.report(report({ rect: { x: 0, y: 24, w: 600, h: 600 } }));
        h.reporter.report(report({ rect: { x: 0, y: 24, w: 500, h: 600 } }));
        expect(h.sent).toHaveLength(1);
        expect(h.reporter.pending).toEqual([PANE]);

        h.advance(100);
        expect(h.sent).toHaveLength(2);
        // Only the newest survives — intermediate frames of a drag are worth dropping.
        expect(h.sent[1]?.rect.w).toBe(500);
        expect(h.reporter.pending).toEqual([]);
    });

    it('sends again immediately once the window has passed', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.advance(150);
        h.reporter.report(report({ rect: { x: 10, y: 24, w: 800, h: 600 } }));
        expect(h.sent).toHaveLength(2);
        expect(h.timerCount).toBe(0);
    });

    it('never delays a hide: a stale page must not sit over the new workspace', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.reporter.report(report({ rect: { x: 0, y: 24, w: 400, h: 600 } })); // queued
        h.reporter.report(report({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } }));
        expect(h.sent).toHaveLength(2);
        expect(h.sent[1]?.visible).toBe(false);
        // The queued movement is dropped: it describes a pane that is no longer on screen.
        h.advance(500);
        expect(h.sent).toHaveLength(2);
    });

    it('re-shows immediately after a hide', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.reporter.report(report({ visible: false }));
        h.reporter.report(report());
        expect(h.sent.map((entry) => entry.visible)).toEqual([true, false, true]);
    });

    it('hide() takes the view back and forgets the pane', () => {
        const h = harness();
        h.reporter.report(report());
        h.reporter.hide(PANE);
        expect(h.sent).toHaveLength(2);
        expect(h.sent[1]).toMatchObject({ paneID: PANE, visible: false });

        // Idempotent: a second hide has nothing to take back.
        h.reporter.hide(PANE);
        expect(h.sent).toHaveLength(2);

        // …and the pane reports afresh when it comes back (no dedupe against the old value).
        h.reporter.report(report());
        expect(h.sent).toHaveLength(3);
    });

    it('treats a tab switch as a change, so the right view gets placed', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.advance(200);
        h.reporter.report(report({ tabID: 'T2' }));
        expect(h.sent).toHaveLength(2);
        expect(h.sent[1]?.tabID).toBe('T2');
    });

    it('tracks panes independently', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.reporter.report(report({ paneID: 'OTHER' }));
        expect(h.sent).toHaveLength(2);
    });

    it('dispose stops pending sends (the socket is going away)', () => {
        const h = harness(100);
        h.reporter.report(report());
        h.reporter.report(report({ rect: { x: 5, y: 24, w: 800, h: 600 } }));
        h.reporter.dispose();
        h.advance(500);
        expect(h.sent).toHaveLength(1);
        h.reporter.report(report({ rect: { x: 9, y: 24, w: 800, h: 600 } }));
        expect(h.sent).toHaveLength(1);
    });
});

describe('readShellWindowID', () => {
    it('reads the shell marker the Electron window appends', () => {
        expect(readShellWindowID(`?token=abc&${SHELL_WINDOW_PARAM}=WIN-1`)).toBe('WIN-1');
    });

    it('is null in an ordinary browser', () => {
        expect(readShellWindowID('')).toBeNull();
        expect(readShellWindowID('?token=abc')).toBeNull();
        expect(readShellWindowID(`?${SHELL_WINDOW_PARAM}=`)).toBeNull();
        expect(readShellWindowID(`?${SHELL_WINDOW_PARAM}=%20%20`)).toBeNull();
    });
});

// APP-012 / SET-049: only the shell knows whether the frame around the page is transparent
// (Electron fixes it at window creation), so it says so on the URL. A browser tab must NOT
// paint an rgba window fill — there it would composite over white.
describe('readWindowTransparent', () => {
    it('is true only when the shell marked the window transparent', () => {
        expect(readWindowTransparent(`?${WINDOW_TRANSPARENT_PARAM}=1`)).toBe(true);
        expect(readWindowTransparent(`?${SHELL_WINDOW_PARAM}=WIN-1&${WINDOW_TRANSPARENT_PARAM}=true`)).toBe(
            true
        );
    });

    it('is false for a browser tab, an opaque shell window, and junk', () => {
        expect(readWindowTransparent('')).toBe(false);
        expect(readWindowTransparent(`?${SHELL_WINDOW_PARAM}=WIN-1`)).toBe(false);
        expect(readWindowTransparent(`?${WINDOW_TRANSPARENT_PARAM}=0`)).toBe(false);
        expect(readWindowTransparent(`?${WINDOW_TRANSPARENT_PARAM}=maybe`)).toBe(false);
    });
});
