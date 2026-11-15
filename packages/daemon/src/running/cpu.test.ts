import { describe, expect, it } from 'vitest';

import { CPU_BASELINE_MAX_AGE_MS, createCpuSampler } from './cpu.js';
import type { ProcessRow } from './types.js';

function row(pid: number, cpuSeconds: number, startedAt = 1_000): ProcessRow {
    return { pid, ppid: 1, pgid: pid, tpgid: 0, rssBytes: 0, cpuSeconds, startedAt, args: 'node' };
}

describe('createCpuSampler', () => {
    it('has no rates until there is a baseline, then a percent of one core', () => {
        const sampler = createCpuSampler();
        expect(sampler.sample([row(10, 5)], 0)).toBeNull();
        // 2 s of CPU over 10 s: 20%. A busy server on several threads passes 100.
        expect(sampler.sample([row(10, 7), row(11, 0)], 10_000)?.get(10)).toBeCloseTo(20);
        expect(sampler.sample([row(10, 22)], 20_000)?.get(10)).toBeCloseTo(150);
    });

    it('counts all of a new process, and a reused pid as new', () => {
        const sampler = createCpuSampler();
        sampler.sample([row(10, 50, 1_000)], 1_000_000);
        // Started (epoch seconds) after the baseline at 1,000,000 ms.
        const rates = sampler.sample([row(10, 1, 1_005), row(12, 3, 1_002)], 1_010_000);
        expect(rates?.get(10)).toBeCloseTo(10);
        expect(rates?.get(12)).toBeCloseTo(30);
    });

    it("never squeezes a long-running process's lifetime into one window when the baseline missed it", () => {
        const sampler = createCpuSampler();
        // Process 7 was up all along but its line did not parse at the baseline.
        sampler.sample([row(10, 0, 1)], 1_000_000);
        const rates = sampler.sample([row(10, 1, 1), row(7, 3_600, 1)], 1_010_000);
        expect(rates?.has(7)).toBe(false);
        expect(rates?.get(10)).toBeCloseTo(10);
    });

    it('treats an old baseline, or a failed ps, as none', () => {
        const sampler = createCpuSampler();
        sampler.sample([row(10, 5)], 0);
        expect(sampler.sample([row(10, 6)], CPU_BASELINE_MAX_AGE_MS + 1)).toBeNull();
        expect(sampler.sample(null, CPU_BASELINE_MAX_AGE_MS + 10_000)).toBeNull();
        expect(sampler.sample([row(10, 7)], CPU_BASELINE_MAX_AGE_MS + 20_000)).toBeNull();
    });

    it('answers the earlier rates for scans under a second apart, keeping the earlier baseline', () => {
        const sampler = createCpuSampler();
        sampler.sample([row(10, 0)], 0);
        const first = sampler.sample([row(10, 1)], 10_000);
        expect(sampler.sample([row(10, 9)], 10_400)).toBe(first);
        expect(sampler.sample([row(10, 3)], 20_000)?.get(10)).toBeCloseTo(20);
    });
});
