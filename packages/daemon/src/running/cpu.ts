/**
 * CPU per process from `ps`'s cumulative CPU time (docs/running-services.md §4, phase 4): the
 * change between two scans over the wall time between them, as a percent of one core (Activity
 * Monitor's figure; a busy multi-threaded process passes 100).
 *
 * A baseline older than `CPU_BASELINE_MAX_AGE_MS` is no baseline: with no window open the daemon
 * scans only when asked, and an hours-long average would read as now. A process with no sample
 * in the baseline counts all its CPU time only if it started after the baseline was taken (it is
 * new); one that started before and is missing (a `ps` line that did not parse) has no rate, never
 * a lifetime's CPU squeezed into ten seconds. A `ps` that failed leaves no baseline. Two scans
 * under `CPU_MIN_INTERVAL_MS` apart answer the earlier rates and keep the earlier baseline, so a
 * burst of scans cannot divide by almost nothing.
 */

import type { ProcessRow } from './types.js';

export const CPU_BASELINE_MAX_AGE_MS = 120_000;
export const CPU_MIN_INTERVAL_MS = 1_000;
/** `lstart` has whole seconds: a process started this close before the baseline may be new. */
const START_SLACK_MS = 2_000;

export interface CpuSampler {
    /**
     * Rates by pid for this `ps` (null when it failed), taken at `at` (epoch ms, when `ps` ran).
     * Null when there is no usable baseline yet.
     */
    sample(processes: readonly ProcessRow[] | null, at: number): ReadonlyMap<number, number> | null;
}

export function createCpuSampler(): CpuSampler {
    let baseline: { readonly at: number; readonly cpu: ReadonlyMap<string, number> } | null = null;
    let rates: ReadonlyMap<number, number> | null = null;
    const key = (row: ProcessRow): string => `${String(row.pid)}:${String(row.startedAt)}`;

    return {
        sample(processes, at) {
            if (processes === null) {
                baseline = null;
                rates = null;
                return null;
            }
            const cpu = new Map<string, number>();
            for (const row of processes) if (row.cpuSeconds !== undefined) cpu.set(key(row), row.cpuSeconds);
            const previous = baseline;
            if (previous !== null && at - previous.at < CPU_MIN_INTERVAL_MS) return rates;
            baseline = { at, cpu };
            if (previous === null || at - previous.at > CPU_BASELINE_MAX_AGE_MS) {
                rates = null;
                return null;
            }
            const seconds = (at - previous.at) / 1000;
            const next = new Map<number, number>();
            for (const row of processes) {
                if (row.cpuSeconds === undefined) continue;
                const before = previous.cpu.get(key(row));
                if (before === undefined && row.startedAt * 1000 < previous.at - START_SLACK_MS) continue;
                // New since the baseline: everything it has used, it used in this window.
                const used = Math.max(0, row.cpuSeconds - (before ?? 0));
                next.set(row.pid, (used / seconds) * 100);
            }
            rates = next;
            return next;
        }
    };
}
