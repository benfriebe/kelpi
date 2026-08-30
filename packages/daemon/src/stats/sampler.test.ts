/**
 * The system-stat sampler (APP-078…085, AGNT-107…112).
 *
 * The three rules that are easy to get subtly wrong, and each has cost somebody a debugging
 * session in the Swift original — the comments there say so:
 *
 *   1. a rate with no baseline is 0, not the cumulative counter;
 *   2. a counter that DECREASED is a reset → 0, not a wrap → ~1.8e19 B/s;
 *   3. every metric records even while hidden, so enabling a gauge shows a populated trace.
 *
 * The platform probe is injected, so all of this runs identically on any OS.
 */

import { SYSTEM_STAT_KINDS } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostProbe } from './host.js';
import { createSystemStatsSampler, pushHistory, rateBetween } from './sampler.js';

function probeOf(net: [number, number], io: [number, number], mem = 4_000_000_000): HostProbe {
    return {
        memUsedBytes: mem,
        memTotalBytes: 16_000_000_000,
        net: { down: net[0], up: net[1] },
        io: { read: io[0], write: io[1] }
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('rateBetween', () => {
    it('is the per-second delta', () => {
        expect(rateBetween(1000, 3000, 2)).toBe(1000);
    });

    // AGNT-109. A wrapping subtraction here is what produces the spike that auto-scales a
    // sparkline into a flat line for the rest of the session.
    it('treats a counter DECREASE as a reset, not a wrap', () => {
        expect(rateBetween(4_294_967_000, 12, 2)).toBe(0);
    });

    it('is 0 when no time passed, rather than dividing by zero', () => {
        expect(rateBetween(0, 1000, 0)).toBe(0);
        expect(rateBetween(0, 1000, -5)).toBe(0);
    });
});

describe('pushHistory', () => {
    it('appends oldest-first and caps by dropping from the front', () => {
        expect(pushHistory([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
        expect(pushHistory([], 1, 3)).toEqual([1]);
    });
});

describe('createSystemStatsSampler', () => {
    it('reports 0 rates on the first sample — there is no baseline yet', async () => {
        const sampler = createSystemStatsSampler({
            probe: () => Promise.resolve(probeOf([1_000_000, 500_000], [9_000_000, 8_000_000])),
            now: () => 0
        });
        const snapshot = await sampler.sample();
        expect(snapshot.stats.netDownBytesPerSec).toBe(0);
        expect(snapshot.stats.netUpBytesPerSec).toBe(0);
        expect(snapshot.stats.diskReadBytesPerSec).toBe(0);
        expect(snapshot.stats.diskWriteBytesPerSec).toBe(0);
        sampler.dispose();
    });

    it('deltas the second sample against the first, per second', async () => {
        let at = 0;
        let counters = probeOf([1_000_000, 500_000], [9_000_000, 8_000_000]);
        const sampler = createSystemStatsSampler({
            probe: () => Promise.resolve(counters),
            now: () => at
        });
        await sampler.sample();
        at = 2000; // 2 s later
        counters = probeOf([1_000_000 + 4000, 500_000 + 2000], [9_000_000 + 1000, 8_000_000 + 500]);
        const snapshot = await sampler.sample();
        expect(snapshot.stats.netDownBytesPerSec).toBe(2000);
        expect(snapshot.stats.netUpBytesPerSec).toBe(1000);
        expect(snapshot.stats.diskReadBytesPerSec).toBe(500);
        expect(snapshot.stats.diskWriteBytesPerSec).toBe(250);
        sampler.dispose();
    });

    it('turns an interface disappearing into 0, not a spike', async () => {
        let at = 0;
        let counters = probeOf([9_000_000_000, 500_000], [0, 0]);
        const sampler = createSystemStatsSampler({ probe: () => Promise.resolve(counters), now: () => at });
        await sampler.sample();
        at = 2000;
        counters = probeOf([12, 500_000], [0, 0]); // the big interface went away
        const snapshot = await sampler.sample();
        expect(snapshot.stats.netDownBytesPerSec).toBe(0);
        sampler.dispose();
    });

    // AGNT-110: hidden metrics still record, which is what makes a newly enabled gauge show a
    // populated sparkline instead of two minutes of nothing.
    it('records EVERY metric, whatever the user has enabled', async () => {
        const sampler = createSystemStatsSampler({
            probe: () => Promise.resolve(probeOf([1, 1], [1, 1])),
            now: () => 0
        });
        const snapshot = await sampler.sample();
        for (const kind of SYSTEM_STAT_KINDS) {
            expect(snapshot.history[kind]?.length).toBe(1);
        }
        sampler.dispose();
    });

    it('caps each metric’s history at the configured window', async () => {
        let at = 0;
        const sampler = createSystemStatsSampler({
            probe: () => Promise.resolve(probeOf([at, at], [at, at])),
            now: () => at,
            historyLength: 4
        });
        for (let index = 0; index < 10; index += 1) {
            at += 2000;
            await sampler.sample();
        }
        expect(sampler.snapshot.history['cpu']?.length).toBe(4);
        sampler.dispose();
    });

    it('carries the last memory reading forward when a probe cannot read it', async () => {
        let available = true;
        const sampler = createSystemStatsSampler({
            probe: () =>
                Promise.resolve({
                    memUsedBytes: available ? 4_000_000_000 : null,
                    memTotalBytes: 16_000_000_000,
                    net: null,
                    io: null
                }),
            now: () => 0
        });
        await sampler.sample();
        available = false;
        const snapshot = await sampler.sample();
        // Not 0: "the machine freed all its memory" is a worse lie than a stale number.
        expect(snapshot.stats.memUsedBytes).toBe(4_000_000_000);
        sampler.dispose();
    });

    // AGNT-107: the loop is the thing that is gated, not just the drawing.
    it('samples on a timer while enabled and stops dead when disabled', async () => {
        vi.useFakeTimers();
        const probe = vi.fn(() => Promise.resolve(probeOf([1, 1], [1, 1])));
        const seen: number[] = [];
        const sampler = createSystemStatsSampler({ probe, intervalMs: 2000 });
        sampler.subscribe((snapshot) => seen.push(snapshot.stats.memTotalBytes));

        expect(sampler.enabled).toBe(false);
        expect(probe).not.toHaveBeenCalled();

        sampler.setEnabled(true);
        // One immediate sample, so a gauge appears within a frame rather than after 2 s.
        await vi.advanceTimersByTimeAsync(0);
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(probe).toHaveBeenCalledTimes(2);

        sampler.setEnabled(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(seen.length).toBe(2);
        sampler.dispose();
    });

    it('clears the history and the baseline when the gate closes', async () => {
        vi.useFakeTimers();
        let counters = probeOf([1_000_000, 0], [0, 0]);
        const sampler = createSystemStatsSampler({ probe: () => Promise.resolve(counters), intervalMs: 2000 });
        sampler.setEnabled(true);
        await vi.advanceTimersByTimeAsync(4000);
        expect(sampler.snapshot.history['cpu']?.length).toBeGreaterThan(1);

        sampler.setEnabled(false);
        expect(sampler.snapshot.history['cpu']).toEqual([]);

        // Re-enabling starts a fresh baseline: the first sample after the gap must not delta
        // across it (that would report a two-minute-wide burst as a per-second rate).
        counters = probeOf([9_000_000, 0], [0, 0]);
        sampler.setEnabled(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(sampler.snapshot.stats.netDownBytesPerSec).toBe(0);
        sampler.dispose();
    });

    it('publishes nothing after dispose', async () => {
        vi.useFakeTimers();
        const seen: unknown[] = [];
        const sampler = createSystemStatsSampler({
            probe: () => Promise.resolve(probeOf([1, 1], [1, 1])),
            intervalMs: 2000
        });
        sampler.subscribe((snapshot) => seen.push(snapshot));
        sampler.setEnabled(true);
        await vi.advanceTimersByTimeAsync(0);
        const before = seen.length;
        sampler.dispose();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen.length).toBe(before);
    });
});
