/**
 * Issue #467's timing rule (`./idle-discard.ts`): a tab nobody has shown or driven for the delay
 * is offered for discarding; being on screen or a verb in flight keeps it loaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdleDiscard, DEFAULT_DISCARD_MINUTES, discardDelay } from './idle-discard.js';

const DELAY = 10_000;

function harness(options: { delayMs?: number | null; accept?: boolean } = {}) {
    let accept = options.accept ?? true;
    let throws = false;
    const offers: number[] = [];
    const errors: string[] = [];
    const idle = createIdleDiscard(
        {
            discard: () => {
                if (throws) throw new Error('discard failed');
                offers.push(Date.now());
                return accept;
            },
            onError: (_error, context) => {
                errors.push(context);
            }
        },
        { delayMs: options.delayMs === undefined ? DELAY : options.delayMs }
    );
    return {
        idle,
        offers,
        errors,
        setAccept: (value: boolean) => {
            accept = value;
        },
        setThrows: (value: boolean) => {
            throws = value;
        }
    };
}

describe('createIdleDiscard', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('offers a tab that was never on screen once it has existed for the delay', () => {
        // The launch case: every workspace's tabs are built at once and most are never shown.
        const { offers } = harness();
        vi.advanceTimersByTime(DELAY - 1);
        expect(offers).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(1);
    });

    it('never offers a tab while it is on screen, and counts from the park', () => {
        const { idle, offers } = harness();
        idle.placed();
        vi.advanceTimersByTime(DELAY * 10);
        expect(offers).toHaveLength(0);
        idle.parked();
        vi.advanceTimersByTime(DELAY - 1);
        expect(offers).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(1);
    });

    it('a verb keeps the tab loaded while it runs and for the delay after it', () => {
        const { idle, offers } = harness();
        vi.advanceTimersByTime(DELAY - 10);
        const release = idle.use();
        // A long `wait`.
        vi.advanceTimersByTime(DELAY * 3);
        expect(offers).toHaveLength(0);
        release();
        vi.advanceTimersByTime(DELAY - 1);
        expect(offers).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(1);
    });

    it('overlapping verbs keep it loaded until the last one finishes, and a double release counts once', () => {
        const { idle, offers } = harness();
        const first = idle.use();
        const second = idle.use();
        first();
        first();
        vi.advanceTimersByTime(DELAY * 2);
        expect(offers).toHaveLength(0);
        second();
        vi.advanceTimersByTime(DELAY);
        expect(offers).toHaveLength(1);
    });

    it('a verb that finishes while the tab is on screen does not start the count', () => {
        const { idle, offers } = harness();
        const release = idle.use();
        idle.placed();
        release();
        vi.advanceTimersByTime(DELAY * 2);
        expect(offers).toHaveLength(0);
    });

    it('a refused offer is made again after another full delay, not on every tick', () => {
        const { offers } = harness({ accept: false });
        vi.advanceTimersByTime(DELAY);
        expect(offers).toHaveLength(1);
        vi.advanceTimersByTime(DELAY - 1);
        expect(offers).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(2);
    });

    it('an accepted offer waits for the tab: nothing more until restart says the page stayed', () => {
        const { idle, offers } = harness();
        vi.advanceTimersByTime(DELAY);
        expect(offers).toHaveLength(1);
        vi.advanceTimersByTime(DELAY * 5);
        expect(offers).toHaveLength(1);
        idle.restart();
        vi.advanceTimersByTime(DELAY);
        expect(offers).toHaveLength(2);
    });

    it('an offer that throws is reported and made again later', () => {
        const h = harness();
        h.setThrows(true);
        vi.advanceTimersByTime(DELAY);
        expect(h.errors).toEqual(['idle-discard']);
        h.setThrows(false);
        vi.advanceTimersByTime(DELAY);
        expect(h.offers).toHaveLength(1);
    });

    it('off means no offer at all, and turning it on starts the count from then', () => {
        const { idle, offers } = harness({ delayMs: null });
        vi.advanceTimersByTime(DELAY * 100);
        expect(offers).toHaveLength(0);
        idle.setDelay(DELAY);
        vi.advanceTimersByTime(DELAY - 1);
        expect(offers).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(1);
    });

    it('a new delay restarts the count, and turning it off cancels a pending offer', () => {
        const { idle, offers } = harness();
        vi.advanceTimersByTime(DELAY - 10);
        idle.setDelay(DELAY * 2);
        vi.advanceTimersByTime(DELAY * 2 - 1);
        expect(offers).toHaveLength(0);
        vi.advanceTimersByTime(1);
        expect(offers).toHaveLength(1);
        idle.restart();
        idle.setDelay(null);
        vi.advanceTimersByTime(DELAY * 10);
        expect(offers).toHaveLength(1);
    });

    it('dispose cancels a pending offer and ignores everything after it', () => {
        const { idle, offers } = harness();
        idle.dispose();
        idle.parked();
        idle.use()();
        idle.setDelay(DELAY);
        idle.restart();
        vi.advanceTimersByTime(DELAY * 3);
        expect(offers).toHaveLength(0);
    });
});

describe('discardDelay', () => {
    it('is the setting in minutes, an hour by default', () => {
        expect(DEFAULT_DISCARD_MINUTES).toBe(60);
        expect(discardDelay(DEFAULT_DISCARD_MINUTES, {})).toBe(3_600_000);
        expect(discardDelay(15, {})).toBe(900_000);
    });

    it('is off for 0 or anything that is not a positive number', () => {
        for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(discardDelay(minutes, {})).toBeNull();
        }
    });

    it('takes the smoke override in milliseconds, but never turns a disabled setting on', () => {
        expect(discardDelay(60, { KELPI_WEB_TAB_DISCARD_MS: '2000' })).toBe(2000);
        expect(discardDelay(0, { KELPI_WEB_TAB_DISCARD_MS: '2000' })).toBeNull();
        for (const raw of ['', '0', '-1', '1.5', 'soon']) {
            expect(discardDelay(60, { KELPI_WEB_TAB_DISCARD_MS: raw })).toBe(3_600_000);
        }
    });
});
