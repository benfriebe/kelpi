import { describe, expect, it } from 'vitest';

import { CONTAINER_STATS_MAX_AGE_MS, containerMemory, createContainerStats } from './container-stats.js';

const A = 'aaaaaaaaaaaa';
/** Docker's own clock, in its `read` stamps. */
const T0 = Date.parse('2026-11-15T12:00:00Z');
const B = 'bbbbbbbbbbbb';

function reply(totalNs: number, readMs: number, usage = 100 * 1_048_576, inactive = 20 * 1_048_576) {
    return {
        read: new Date(readMs).toISOString(),
        memory_stats: { usage, stats: { inactive_file: inactive } },
        cpu_stats: { cpu_usage: { total_usage: totalNs } }
    };
}

describe('containerMemory', () => {
    it("is docker stats' figure: usage less the inactive page cache, on cgroup v2 and v1", () => {
        expect(containerMemory(reply(0, 0))).toBe(80 * 1_048_576);
        expect(containerMemory({ memory_stats: { usage: 50, stats: { total_inactive_file: 10 } } })).toBe(40);
        // A cache figure past usage is not subtracted; no memory stats is no figure.
        expect(containerMemory({ memory_stats: { usage: 50, stats: { inactive_file: 90 } } })).toBe(50);
        expect(containerMemory({})).toBeNull();
    });
});

describe('createContainerStats', () => {
    function rig() {
        let clock = 0;
        const answers = new Map<string, unknown>();
        const asked: string[] = [];
        const stats = createContainerStats({
            fetch: (path) => {
                asked.push(path);
                const id = /\/containers\/(\w+)\//.exec(path)?.[1] ?? '';
                const answer = answers.get(id);
                return answer instanceof Error || answer === undefined ? Promise.reject(answer ?? new Error('no such container')) : Promise.resolve(answer);
            },
            now: () => clock
        });
        return {
            stats,
            asked,
            answers,
            advance: (ms: number) => {
                clock += ms;
            }
        };
    }

    it('has memory at once and CPU from the second refresh, from the replies own read stamps', async () => {
        const r = rig();
        r.answers.set(A, reply(1_000_000_000, T0));
        await r.stats.refresh([A]);
        expect(r.stats.get(A)).toEqual({ rssBytes: 80 * 1_048_576, cpuPercent: null });
        r.advance(10_000);
        // 2 s of CPU over 10 s by Docker's clock: 20% of one core.
        r.answers.set(A, reply(3_000_000_000, T0 + 10_000));
        await r.stats.refresh([A]);
        expect(r.stats.get(A)?.cpuPercent).toBeCloseTo(20);
        expect(r.asked[0]).toBe(`/containers/${A}/stats?stream=false&one-shot=true`);
    });

    it('starts a restarted container over, keeps a silent one until its numbers go stale', async () => {
        const r = rig();
        r.answers.set(A, reply(9_000_000_000, T0));
        await r.stats.refresh([A]);
        r.advance(10_000);
        r.answers.set(A, reply(1_000_000_000, T0 + 10_000));
        await r.stats.refresh([A]);
        expect(r.stats.get(A)?.cpuPercent).toBeNull();
        r.answers.set(A, new Error('timed out'));
        r.advance(10_000);
        await r.stats.refresh([A]);
        expect(r.stats.get(A)?.rssBytes).toBe(80 * 1_048_576);
        r.advance(CONTAINER_STATS_MAX_AGE_MS);
        expect(r.stats.get(A)).toBeNull();
    });

    it("never takes a rate across Docker's clock and the daemon's", async () => {
        const r = rig();
        r.answers.set(A, reply(1_000_000_000, T0));
        await r.stats.refresh([A]);
        r.advance(10_000);
        // No `read` stamp this time: the daemon's clock, which may not match Docker's.
        r.answers.set(A, { ...reply(3_000_000_000, T0), read: undefined });
        await r.stats.refresh([A]);
        expect(r.stats.get(A)?.cpuPercent).toBeNull();
    });

    it('asks only about container ids, never a path', async () => {
        const r = rig();
        r.answers.set(B, reply(0, 0));
        await r.stats.refresh(['../../secrets', B, B]);
        expect(r.asked).toEqual([`/containers/${B}/stats?stream=false&one-shot=true`]);
    });

    it('stops asking once the budget is spent', async () => {
        let clock = 0;
        const asked: string[] = [];
        const stats = createContainerStats({
            fetch: (path) => {
                asked.push(path);
                clock += 1_000;
                return Promise.resolve(reply(0, clock));
            },
            now: () => clock,
            budgetMs: 2_500
        });
        await stats.refresh(Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(12, 'a')));
        // Eight workers start at once; each answer moves the clock a second, past the budget.
        expect(asked.length).toBeLessThan(30);
    });
});
