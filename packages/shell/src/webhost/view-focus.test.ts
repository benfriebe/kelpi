/**
 * §N29's discriminator: is this `focus` event the user's click, or something else?
 *
 * The gate is the whole correctness argument of the fix. Admit too much and the ring is yanked
 * around by machinery — a navigation committing (which fires `focus` TWICE, and fires on every
 * pane's first load), or WEB-043's own keyboard handoff. Admit too little and the defect stands.
 * The measured facts behind each rule are in the module header; this pins the behaviour.
 */

import { describe, expect, it } from 'vitest';

import {
    NAVIGATION_COMMIT_GRACE_MS,
    PROGRAMMATIC_FOCUS_WINDOW_MS,
    createViewFocusGate,
    type ViewFocusGate
} from './view-focus.js';

/** A fake clock + timer queue, so the two windows are exercised without waiting for them. */
function harness(): {
    readonly gate: ViewFocusGate;
    readonly reports: number[];
    advance: (ms: number) => void;
} {
    let clock = 1_000;
    const reports: number[] = [];
    const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
    const gate = createViewFocusGate({
        report: () => reports.push(clock),
        now: () => clock,
        schedule: (run, ms) => {
            const entry = { at: clock + ms, run, cancelled: false };
            timers.push(entry);
            return () => {
                entry.cancelled = true;
            };
        }
    });
    return {
        gate,
        reports,
        advance(ms) {
            clock += ms;
            for (const timer of [...timers]) {
                if (timer.cancelled || timer.at > clock) continue;
                timer.cancelled = true;
                timer.run();
            }
        }
    };
}

describe('view focus gate', () => {
    it('reports a focus event on an idle page: nothing else could have done it', () => {
        const h = harness();
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toHaveLength(1);
    });

    it('suppresses the event its own claim fires synchronously (WEB-043 must not echo)', () => {
        const h = harness();
        h.gate.claim(() => {
            // Electron delivers `focus` INSIDE `contents.focus()` — measured at 0.075 ms.
            h.gate.focusEvent({ loading: false });
        });
        expect(h.reports).toEqual([]);
    });

    it('suppresses a claim delivered LATE, in case a future build posts the event', () => {
        const h = harness();
        h.gate.claim(() => undefined);
        h.advance(PROGRAMMATIC_FOCUS_WINDOW_MS - 1);
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toEqual([]);
    });

    it('lets the claim window expire: a redundant focus() fires nothing, so it must not linger', () => {
        const h = harness();
        h.gate.claim(() => undefined);
        h.advance(PROGRAMMATIC_FOCUS_WINDOW_MS + 1);
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toHaveLength(1);
    });

    it('rearms after the claim throws — a failed focus must not disable the gate for good', () => {
        const h = harness();
        expect(() =>
            h.gate.claim(() => {
                throw new Error('the view is gone');
            })
        ).toThrow('the view is gone');
        h.advance(PROGRAMMATIC_FOCUS_WINDOW_MS + 1);
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toHaveLength(1);
    });

    describe('a navigation taking the keyboard (the two events every commit fires)', () => {
        it('is dropped: the commit lands within a few ms and cancels it', () => {
            const h = harness();
            // Measured: two `focus` events, ~1-3 ms before `did-navigate`, `isLoading()` true.
            h.gate.focusEvent({ loading: true });
            h.gate.focusEvent({ loading: true });
            h.advance(3);
            h.gate.navigationCommitted();
            h.advance(NAVIGATION_COMMIT_GRACE_MS * 2);
            expect(h.reports).toEqual([]);
        });

        it('does not swallow the click that STARTS a navigation (a link click)', () => {
            const h = harness();
            // The press precedes the navigation it triggers, so the page is not loading yet —
            // this is the ordinary path and it reports at once.
            h.gate.focusEvent({ loading: false });
            h.gate.navigationCommitted();
            expect(h.reports).toHaveLength(1);
        });

        it('still reports a click that lands on a page which happens to be loading', () => {
            const h = harness();
            h.gate.focusEvent({ loading: true });
            expect(h.reports).toEqual([]);
            // No commit explains it, so after the grace it is what it looked like: the user.
            h.advance(NAVIGATION_COMMIT_GRACE_MS + 1);
            expect(h.reports).toHaveLength(1);
        });

        it('holds only the newest event, so a burst cannot report twice', () => {
            const h = harness();
            h.gate.focusEvent({ loading: true });
            h.advance(2);
            h.gate.focusEvent({ loading: true });
            h.advance(NAVIGATION_COMMIT_GRACE_MS + 1);
            expect(h.reports).toHaveLength(1);
        });

        it('drops a held event when the shell then claims focus itself', () => {
            const h = harness();
            h.gate.focusEvent({ loading: true });
            h.gate.claim(() => undefined);
            h.advance(NAVIGATION_COMMIT_GRACE_MS + 1);
            expect(h.reports).toEqual([]);
        });

        it('ignores a commit with nothing held', () => {
            const h = harness();
            expect(() => h.gate.navigationCommitted()).not.toThrow();
            expect(h.reports).toEqual([]);
        });
    });

    it('reports nothing once disposed — a held event must not fire into a dead tab', () => {
        const h = harness();
        h.gate.focusEvent({ loading: true });
        h.gate.dispose();
        h.advance(NAVIGATION_COMMIT_GRACE_MS + 1);
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toEqual([]);
    });

    it('re-arms on every claim, so a run of programmatic focuses is all suppressed', () => {
        const h = harness();
        for (let index = 0; index < 5; index += 1) {
            h.gate.claim(() => {
                h.gate.focusEvent({ loading: false });
            });
            h.advance(1_000);
        }
        expect(h.reports).toEqual([]);
        h.gate.focusEvent({ loading: false });
        expect(h.reports).toHaveLength(1);
    });
});
