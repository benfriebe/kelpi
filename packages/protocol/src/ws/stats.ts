/**
 * System-stat samples over the client socket (APP-078…085, AGNT-107…112).
 *
 * **The one architectural change from the Swift app, and it is forced.** There, sampling is a
 * *view-layer* helper (`SystemStatsSampler`, polled by `StatusBarView` on a 2 s timer, never
 * dispatching into TCA) because the view and the machine are the same process. Here they are
 * not: a browser tab cannot call `host_statistics`, and a second attached client must not
 * double-sample the same host. So the DAEMON samples — once, on the same 2 s cadence, keeping
 * the same 60-entry (~2 min) history — and broadcasts. Every client renders the same numbers.
 *
 * What survives verbatim from `Nex/Services/SystemStatsService.swift`:
 *
 *   - the six metrics and their canonical order;
 *   - **rate metrics are deltas between successive samples**: the first sample reports 0 (no
 *     baseline) and any counter DECREASE is a reset → 0, never a wrapped ~1.8e19 B/s spike
 *     that would auto-scale a sparkline into a flat line (AGNT-109);
 *   - the 1000-vs-1024 split: throughput rates step units at **1000** (`SystemStatsFormat.rate`)
 *     while byte TOTALS step at **1024** (`SystemStatsFormat.bytes`). Both formatters live
 *     client-side (`chrome/stats.ts`) so this module stays pure numbers;
 *   - every metric is sampled and retained even while hidden, so enabling one shows a
 *     populated sparkline immediately (AGNT-110).
 */

/** One point-in-time sample. Field-for-field the Swift `SystemStats` struct. */
export interface WsSystemStats {
    /** Aggregate busy percentage across all cores, 0…100. */
    readonly cpuPercent: number;
    readonly memUsedBytes: number;
    readonly memTotalBytes: number;
    /** 1-minute load average. */
    readonly loadAverage1m: number;
    /** Bytes/sec since the previous sample (0 on the first). */
    readonly netDownBytesPerSec: number;
    readonly netUpBytesPerSec: number;
    readonly diskReadBytesPerSec: number;
    readonly diskWriteBytesPerSec: number;
    readonly diskUsedBytes: number;
    readonly diskTotalBytes: number;
}

export const ZERO_SYSTEM_STATS: WsSystemStats = {
    cpuPercent: 0,
    memUsedBytes: 0,
    memTotalBytes: 0,
    loadAverage1m: 0,
    netDownBytesPerSec: 0,
    netUpBytesPerSec: 0,
    diskReadBytesPerSec: 0,
    diskWriteBytesPerSec: 0,
    diskUsedBytes: 0,
    diskTotalBytes: 0
};

/**
 * The broadcast. It carries the current sample AND the whole retained history per metric,
 * because a client that attaches mid-session must not have to wait two minutes for a
 * sparkline the daemon already has (and a reconnect must not reset one).
 *
 * `history` is keyed by `SystemStatKind`; each array is oldest-first, capped at
 * `SYSTEM_STATS_HISTORY`. `intervalMs` lets the hover popover's "~Ns" footnote be derived
 * rather than hard-coded, so changing the cadence cannot make the label lie.
 */
export interface WsSystemStatsMessage {
    readonly type: 'system-stats';
    readonly stats: WsSystemStats;
    readonly history: Readonly<Record<string, readonly number[]>>;
    readonly intervalMs: number;
}

export const WS_SYSTEM_STATS_MESSAGE = 'system-stats';

/** `StatusBarView.swift:33` — ~2 minutes at the 2 s cadence. */
export const SYSTEM_STATS_HISTORY = 60;

/** `StatusBarView.swift:67` — `Timer.publish(every: 2)`. */
export const SYSTEM_STATS_INTERVAL_MS = 2000;

/** The scalar a metric contributes to its history ring (`SystemStatKind.scalar`). */
export function systemStatScalar(kind: string, stats: WsSystemStats): number {
    switch (kind) {
        case 'cpu':
            return stats.cpuPercent;
        case 'memory':
            return percentOf(stats.memUsedBytes, stats.memTotalBytes);
        case 'load':
            return stats.loadAverage1m;
        case 'network':
            return stats.netDownBytesPerSec + stats.netUpBytesPerSec;
        case 'diskIO':
            return stats.diskReadBytesPerSec + stats.diskWriteBytesPerSec;
        case 'diskSpace':
            return percentOf(stats.diskUsedBytes, stats.diskTotalBytes);
        default:
            return 0;
    }
}

/** `SystemStats.memPercent` / `.diskPercent`: 0 when the denominator is 0, never NaN. */
export function percentOf(used: number, total: number): number {
    if (!Number.isFinite(total) || total <= 0) return 0;
    return (used / total) * 100;
}
