/**
 * Issue #79 — the renderer watchdog's two-strike rule.
 *
 * The whole point of the module is that it does NOT act on the first `unresponsive`: a workspace
 * switch that starts eight engines against multi-MB replays blocks the main thread past
 * Chromium's hang monitor as a matter of course, and tearing a window's native views apart every
 * time that happened would be a worse bug than the one it guards. So the rule is exercised on a
 * clock the test owns, and the effect is a spy.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    UNRESPONSIVE_PARK_REASON,
    UNRESPONSIVE_STRIKE_WINDOW_MS,
    createUnresponsiveWatchdog
} from './unresponsive.js';

function harness(startAt = 1_000_000) {
    let clock = startAt;
    const park = vi.fn(() => 3);
    const lines: string[] = [];
    const watchdog = createUnresponsiveWatchdog({
        now: () => clock,
        log: (message) => lines.push(message),
        park
    });
    return {
        watchdog,
        park,
        lines,
        advance: (ms: number) => {
            clock += ms;
        }
    };
}

describe('renderer unresponsive watchdog (#79)', () => {
    it('leaves the first hang alone: heavy work looks exactly like this', () => {
        const { watchdog, park, lines } = harness();
        expect(watchdog.unresponsive()).toBe(false);
        expect(park).not.toHaveBeenCalled();
        expect(lines[0]).toContain('strike 1');
        expect(lines[0]).toContain('nothing parked');
    });

    it('parks every view on a second hang inside the window', () => {
        const { watchdog, park, advance, lines } = harness();
        watchdog.unresponsive();
        advance(UNRESPONSIVE_STRIKE_WINDOW_MS - 1);
        expect(watchdog.unresponsive()).toBe(true);
        expect(park).toHaveBeenCalledTimes(1);
        expect(park).toHaveBeenCalledWith(UNRESPONSIVE_PARK_REASON);
        // The count comes from the park itself, so the line cannot claim more than happened.
        expect(lines.at(-1)).toContain('parked 3 web pane view');
        expect(lines.at(-1)).toContain(UNRESPONSIVE_PARK_REASON);
    });

    it('ages strikes out: two hangs far apart are two ordinary heavy moments', () => {
        const { watchdog, park, advance } = harness();
        watchdog.unresponsive();
        advance(UNRESPONSIVE_STRIKE_WINDOW_MS + 1);
        expect(watchdog.unresponsive()).toBe(false);
        expect(park).not.toHaveBeenCalled();
        expect(watchdog.strikes()).toHaveLength(1);

        // …and a third one right after the second still counts as the pair it is.
        advance(10);
        expect(watchdog.unresponsive()).toBe(true);
        expect(park).toHaveBeenCalledTimes(1);
    });

    it('reports how long the renderer was gone, and does not park on the way back', () => {
        const { watchdog, park, advance, lines } = harness();
        watchdog.unresponsive();
        advance(4_200);
        watchdog.responsive();
        expect(park).not.toHaveBeenCalled();
        expect(lines.at(-1)).toContain('responsive again after 4200ms');
        // The strike is still counting: recovering once does not buy a clean slate inside the
        // window, which is the whole difference between "slow" and "wedged".
        expect(lines.at(-1)).toContain('1 strike(s) still counting');
    });

    it('honours a custom window, so a caller can tighten or loosen the rule', () => {
        let clock = 0;
        const park = vi.fn();
        const watchdog = createUnresponsiveWatchdog({
            now: () => clock,
            log: () => {},
            park,
            windowMs: 5_000
        });
        watchdog.unresponsive();
        clock = 6_000;
        expect(watchdog.unresponsive()).toBe(false);
        clock = 7_000;
        expect(watchdog.unresponsive()).toBe(true);
    });

    it('still logs when the park reports no count (a shell with no web host yet)', () => {
        let clock = 0;
        const lines: string[] = [];
        const watchdog = createUnresponsiveWatchdog({
            now: () => clock,
            log: (message) => lines.push(message),
            park: () => undefined
        });
        watchdog.unresponsive();
        clock = 100;
        expect(watchdog.unresponsive()).toBe(true);
        expect(lines.at(-1)).toContain('parked every web pane view');
    });
});
