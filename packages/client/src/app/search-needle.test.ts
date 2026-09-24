/**
 * §TERM-116 — the terminal-search needle's 300 ms debounce for short needles.
 *
 * The clock is held still on both sides of the 300 ms rather than slept through: what is under
 * test is the state machine at the millisecond the Swift reducer names, not that the file
 * contains the number 300.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    SEARCH_DEBOUNCE_MS,
    createSearchNeedleScheduler,
    searchNeedleIsImmediate
} from './search-needle.js';

describe('searchNeedleIsImmediate', () => {
    it('defers 1 and 2 characters, runs 3 or more', () => {
        expect(searchNeedleIsImmediate('a')).toBe(false);
        expect(searchNeedleIsImmediate('ab')).toBe(false);
        expect(searchNeedleIsImmediate('abc')).toBe(true);
        expect(searchNeedleIsImmediate('abcd')).toBe(true);
    });

    it('runs the EMPTY needle immediately — clearing must not wait on a timer', () => {
        expect(searchNeedleIsImmediate('')).toBe(true);
    });
});

describe('the search-needle scheduler', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends a 3-character needle on the keystroke, with no timer at all', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        expect(scheduler.push('abc')).toBe(true);
        expect(sent).toEqual(['abc']);
        expect(scheduler.pending()).toBe(false);
    });

    it('holds a 1-character needle for exactly 300 ms', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        expect(scheduler.push('a')).toBe(false);
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
        expect(sent).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(sent).toEqual(['a']);
        expect(scheduler.pending()).toBe(false);
    });

    /**
     * The cost this exists to remove: typing `a`, `ab` used to be two socket round trips, each
     * one a full scan of up to 10 000 scrollback lines. Cancel-in-flight makes it one, and the
     * one that runs is the LAST needle typed, never an earlier prefix.
     */
    it('cancels in flight, so a burst of short needles costs ONE search', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        scheduler.push('a');
        vi.advanceTimersByTime(100);
        scheduler.push('ab');
        vi.advanceTimersByTime(100);
        scheduler.push('ab');
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        expect(sent).toEqual(['ab']);
    });

    it('a long needle typed after a short one cancels the short one’s timer', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        scheduler.push('a');
        scheduler.push('abc');
        expect(sent).toEqual(['abc']);
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
        expect(sent).toEqual(['abc']);
    });

    /**
     * The port's one deliberate divergence from the Swift, and the reason it is a divergence
     * worth making: Swift's empty branch is not `.cancellable`, so deleting the last character
     * of a one-character needle clears the highlight and then re-applies it ~300 ms later.
     */
    it('clearing the field beats a pending short needle instead of losing to it', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        scheduler.push('a');
        vi.advanceTimersByTime(50);
        scheduler.push('');
        expect(sent).toEqual(['']);
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
        expect(sent).toEqual(['']);
    });

    it('cancel() drops a pending needle (the bar closed)', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        scheduler.push('a');
        expect(scheduler.pending()).toBe(true);
        scheduler.cancel();
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
        expect(sent).toEqual([]);
        expect(scheduler.pending()).toBe(false);
    });

    /**
     * The case toggle's rule: a short needle still waiting out its 300 ms goes NOW rather than being
     * dropped, so the recount the toggle asks for is a count of what the user actually typed.
     */
    it('flush() sends a pending needle immediately, once, and says whether there was one', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        expect(scheduler.flush()).toBe(false);
        scheduler.push('ab');
        vi.advanceTimersByTime(100);
        expect(scheduler.flush()).toBe(true);
        expect(sent).toEqual(['ab']);
        expect(scheduler.pending()).toBe(false);
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
        expect(sent).toEqual(['ab']);
        expect(scheduler.flush()).toBe(false);
    });

    it('flush() has nothing to send after cancel() or after the timer fired', () => {
        const sent: string[] = [];
        const scheduler = createSearchNeedleScheduler({ send: (needle) => sent.push(needle) });
        scheduler.push('a');
        scheduler.cancel();
        expect(scheduler.flush()).toBe(false);
        scheduler.push('b');
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        expect(scheduler.flush()).toBe(false);
        expect(sent).toEqual(['b']);
    });

    /**
     * The needle a bar taking over is handed. It is the last one TYPED for as long as the daemon
     * may not have it - through the 300 ms and through the round trip - and the daemon's own from
     * the moment the last request carrying one is answered.
     */
    it('reports the needle in transit through the debounce and the round trip, then lets go', async () => {
        const answers: (() => void)[] = [];
        const seen: (string | null)[] = [];
        const scheduler = createSearchNeedleScheduler({
            send: () => new Promise<void>((resolve) => answers.push(resolve)),
            onTransit: (needle) => seen.push(needle)
        });
        expect(scheduler.inTransit()).toBeNull();
        scheduler.push('ab');
        expect(scheduler.inTransit()).toBe('ab');
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        expect(answers).toHaveLength(1);
        // Sent, and not answered yet: the daemon may still be counting the previous needle.
        expect(scheduler.inTransit()).toBe('ab');
        scheduler.push('abc');
        expect(scheduler.inTransit()).toBe('abc');
        answers[0]?.();
        await Promise.resolve();
        // One answer is not enough while a later request is still out.
        expect(scheduler.inTransit()).toBe('abc');
        answers[1]?.();
        await Promise.resolve();
        expect(scheduler.inTransit()).toBeNull();
        expect(seen).toEqual(['ab', 'abc', null]);
    });

    it('holds the needle in transit while a newer one waits out the debounce', async () => {
        const answers: (() => void)[] = [];
        const scheduler = createSearchNeedleScheduler({
            send: () => new Promise<void>((resolve) => answers.push(resolve))
        });
        scheduler.push('abc');
        scheduler.push('ab');
        answers[0]?.();
        await Promise.resolve();
        expect(scheduler.inTransit()).toBe('ab');
        vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        answers[1]?.();
        await Promise.resolve();
        expect(scheduler.inTransit()).toBeNull();
    });

    it('cancel() forgets the needle in transit, and a late answer from before it changes nothing', async () => {
        const answers: (() => void)[] = [];
        const scheduler = createSearchNeedleScheduler({
            send: () => new Promise<void>((resolve) => answers.push(resolve))
        });
        scheduler.push('abc');
        scheduler.cancel();
        expect(scheduler.inTransit()).toBeNull();
        // The next session's needle, still unanswered when the old answer finally lands.
        scheduler.push('xyz');
        answers[0]?.();
        await Promise.resolve();
        expect(scheduler.inTransit()).toBe('xyz');
        answers[1]?.();
        await Promise.resolve();
        expect(scheduler.inTransit()).toBeNull();
    });

    it('treats a send with no promise as answered on the spot', () => {
        const scheduler = createSearchNeedleScheduler({ send: () => undefined });
        scheduler.push('abc');
        expect(scheduler.inTransit()).toBeNull();
        scheduler.push('a');
        expect(scheduler.inTransit()).toBe('a');
        expect(scheduler.flush()).toBe(true);
        expect(scheduler.inTransit()).toBeNull();
    });

    it('takes its timer seam, so a host can supply its own clock', () => {
        const sent: string[] = [];
        const scheduled: number[] = [];
        const fired: (() => void)[] = [];
        const scheduler = createSearchNeedleScheduler({
            send: (needle) => sent.push(needle),
            setTimer: (fn, ms) => {
                scheduled.push(ms);
                fired.push(fn);
                return 1;
            },
            clearTimer: () => {
                fired.length = 0;
            }
        });
        scheduler.push('ab');
        expect(scheduled).toEqual([SEARCH_DEBOUNCE_MS]);
        fired[0]?.();
        expect(sent).toEqual(['ab']);
    });
});
