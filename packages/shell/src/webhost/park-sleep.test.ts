/**
 * Issue #466's timing rule (`./park-sleep.ts`): a tab that was on screen gives its GPU memory
 * back once it has been parked, unused, for the delay; a placement or a verb wakes it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createParkSleep, PARKED_TAB_SLEEP_MS, parkedTabSleepDelay, type ParkWakeReason } from './park-sleep.js';

function harness(delayMs = PARKED_TAB_SLEEP_MS) {
    const calls: string[] = [];
    const errors: string[] = [];
    let dozeThrows = false;
    let wakeThrows = false;
    const sleep = createParkSleep(
        {
            doze: () => {
                if (dozeThrows) throw new Error('doze failed');
                calls.push('doze');
            },
            wake: (reason: ParkWakeReason) => {
                if (wakeThrows) throw new Error('wake failed');
                calls.push(`wake:${reason}`);
            },
            onError: (_error, context) => {
                errors.push(context);
            }
        },
        { delayMs }
    );
    return {
        sleep,
        calls,
        errors,
        failDoze: (value: boolean) => {
            dozeThrows = value;
        },
        failWake: (value: boolean) => {
            wakeThrows = value;
        }
    };
}

describe('createParkSleep', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('puts a tab that was on screen to sleep once it has been parked for the delay', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS - 1);
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(['doze']);
        expect(sleep.asleep).toBe(true);
        // Once is enough: nothing re-dozes a tab that is already asleep.
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 5);
        expect(calls).toEqual(['doze']);
    });

    it('never touches a tab that has never been on screen, used or not', () => {
        // Waking one would SHOW it: setBackgroundThrottling calls WasShown on a hidden view.
        const { sleep, calls } = harness();
        sleep.parked();
        const release = sleep.use();
        release();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 3);
        expect(calls).toEqual([]);
        expect(sleep.asleep).toBe(false);
    });

    it('a placement inside the delay keeps the tab awake (a menu, a quick workspace flip)', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS / 2);
        sleep.placed();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 2);
        expect(calls).toEqual([]);
    });

    it('a placement wakes a sleeping tab, and the next park starts the delay again', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        sleep.placed();
        expect(calls).toEqual(['doze', 'wake:placed']);
        expect(sleep.asleep).toBe(false);
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        expect(calls).toEqual(['doze', 'wake:placed', 'doze']);
    });

    it('a placement of a tab that is awake wakes nothing', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        sleep.placed();
        expect(calls).toEqual([]);
    });

    it('an embedded tab never sleeps, however long it is used or left', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.use()();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 10);
        expect(calls).toEqual([]);
    });

    it('a verb wakes a sleeping tab, and it sleeps again once nothing has used it for the delay', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        const release = sleep.use();
        expect(calls).toEqual(['doze', 'wake:used']);
        // A long `wait`: the tab stays awake for as long as the verb runs.
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 3);
        expect(calls).toEqual(['doze', 'wake:used']);
        release();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS - 1);
        expect(calls).toEqual(['doze', 'wake:used']);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(['doze', 'wake:used', 'doze']);
    });

    it('verbs in a row keep a parked tab awake, and the delay counts from the last one', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS - 10);
        sleep.use()();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS - 10);
        sleep.use()();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS - 1);
        expect(calls).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(calls).toEqual(['doze']);
    });

    it('overlapping verbs keep the tab awake until the last one finishes', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        const first = sleep.use();
        const second = sleep.use();
        first();
        // Releasing twice must not count as the second verb finishing.
        first();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 2);
        expect(calls).toEqual([]);
        second();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        expect(calls).toEqual(['doze']);
    });

    it('a verb that finishes after the tab was placed does not put it to sleep', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        const release = sleep.use();
        sleep.placed();
        release();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 2);
        expect(calls).toEqual([]);
    });

    it('a doze that throws leaves the tab awake and tries again after the next park', () => {
        const h = harness();
        h.sleep.placed();
        h.sleep.parked();
        h.failDoze(true);
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        expect(h.sleep.asleep).toBe(false);
        expect(h.errors).toEqual(['park-sleep-doze']);
        h.failDoze(false);
        h.sleep.placed();
        expect(h.calls).toEqual([]);
        h.sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        expect(h.calls).toEqual(['doze']);
    });

    it('a wake that throws still counts the tab as awake, so it can be put to sleep again', () => {
        const h = harness();
        h.sleep.placed();
        h.sleep.parked();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        h.failWake(true);
        h.sleep.use()();
        expect(h.sleep.asleep).toBe(false);
        expect(h.errors).toEqual(['park-sleep-wake (used)']);
        h.failWake(false);
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS);
        expect(h.calls).toEqual(['doze', 'doze']);
    });

    it('dispose cancels a pending sleep and ignores everything after it', () => {
        const { sleep, calls } = harness();
        sleep.placed();
        sleep.parked();
        sleep.dispose();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 2);
        sleep.placed();
        sleep.parked();
        sleep.use()();
        vi.advanceTimersByTime(PARKED_TAB_SLEEP_MS * 2);
        expect(calls).toEqual([]);
    });
});

describe('parkedTabSleepDelay', () => {
    it('is a minute unless the smoke asks for less', () => {
        expect(parkedTabSleepDelay({})).toBe(PARKED_TAB_SLEEP_MS);
        expect(PARKED_TAB_SLEEP_MS).toBe(60_000);
        expect(parkedTabSleepDelay({ KELPI_WEB_TAB_SLEEP_MS: '1500' })).toBe(1500);
    });

    it('ignores anything that is not a positive whole number of milliseconds', () => {
        for (const raw of ['', '0', '-5', '1.5', 'soon', ' 100']) {
            expect(parkedTabSleepDelay({ KELPI_WEB_TAB_SLEEP_MS: raw })).toBe(PARKED_TAB_SLEEP_MS);
        }
    });
});
