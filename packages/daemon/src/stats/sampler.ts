/**
 * The system-stat sampler (APP-078…085, AGNT-107…112).
 *
 * `Nex/Features/StatusBar/StatusBarView.swift` runs this loop in the VIEW: a 2 s timer, a
 * `SystemStatsSampler` that never dispatches into TCA, and a 60-entry history ring per metric.
 * Here it runs in the daemon, for the reason `@kelpi/protocol`'s `ws/stats.ts` states: a browser
 * tab cannot read host counters, and two attached clients must not double-sample one machine.
 * Everything else about the loop is preserved exactly.
 *
 * The three rules that are easy to get wrong and are therefore load-bearing here:
 *
 *   1. **Rates are deltas, and the first sample has no baseline** → 0 (AGNT-109). Reporting a
 *      cumulative counter as a rate once at startup would spike the sparkline's auto-scale and
 *      flatten every real reading after it.
 *   2. **A counter DECREASE is a reset, not a wrap** → 0. macOS's per-interface counters are
 *      32-bit and an interface can disappear entirely; the Swift comment is explicit that a
 *      wrapping subtraction here produces a ~1.8e19 B/s spike.
 *   3. **Every metric records even while hidden** (AGNT-110), so enabling one in Settings shows
 *      a populated sparkline immediately rather than two minutes of nothing.
 *
 * Gating (AGNT-107 "skipped entirely when the stats toggle is off"): the loop only runs while
 * `enabled()` is true. The daemon composes that from the master setting AND "some client is
 * attached", which is the honest translation — the Swift gate was a view that did not exist
 * when no window did. Turning the gate off CLEARS the history, matching the Swift `@State`
 * dictionary that dies with the view; turning it on starts a fresh baseline, so the first
 * sample after a re-enable reports 0 rates rather than a two-minute-wide delta.
 */

import {
    SYSTEM_STATS_HISTORY,
    SYSTEM_STATS_INTERVAL_MS,
    SYSTEM_STAT_KINDS,
    ZERO_SYSTEM_STATS,
    systemStatScalar,
    type WsSystemStats
} from '@kelpi/protocol';

import { probeHost, readCpuTicks, readDiskSpace, readLoadAverage, type HostProbe } from './host.js';

export interface SystemStatsSnapshot {
    readonly stats: WsSystemStats;
    /** Per-metric history, oldest first, capped at `SYSTEM_STATS_HISTORY`. */
    readonly history: Readonly<Record<string, readonly number[]>>;
    readonly intervalMs: number;
}

export interface SystemStatsSampler {
    /** Take one sample and fold it into the history. Safe to call with the loop stopped. */
    sample(): Promise<SystemStatsSnapshot>;
    /** The last computed snapshot (zeroes + empty history before the first sample). */
    readonly snapshot: SystemStatsSnapshot;
    /**
     * Turn the loop on or off. Off stops the timer AND clears the history + baselines, so the
     * next enable starts clean rather than deltaing across the gap.
     */
    setEnabled(enabled: boolean): void;
    readonly enabled: boolean;
    /** Fires after every sample while enabled. Returns the unsubscribe. */
    subscribe(listener: (snapshot: SystemStatsSnapshot) => void): () => void;
    dispose(): void;
}

export interface SystemStatsSamplerOptions {
    readonly intervalMs?: number | undefined;
    readonly historyLength?: number | undefined;
    readonly home?: string | undefined;
    /** Test seam: replaces the platform probe entirely. */
    readonly probe?: (() => Promise<HostProbe>) | undefined;
    /** Test seam: monotonic-ish clock in ms. */
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

/**
 * `previous >= next` → reset → 0. Otherwise the per-second delta.
 *
 * `elapsedSeconds <= 0` also yields 0: two samples in the same millisecond would divide by
 * zero, and a clock that went backwards is not a measurement.
 */
export function rateBetween(previous: number, next: number, elapsedSeconds: number): number {
    if (elapsedSeconds <= 0) return 0;
    if (!Number.isFinite(previous) || !Number.isFinite(next)) return 0;
    if (next < previous) return 0;
    return (next - previous) / elapsedSeconds;
}

/** Append + cap, oldest first. Returns a new array (the snapshot is handed to clients). */
export function pushHistory(series: readonly number[], value: number, cap: number): number[] {
    const next = [...series, value];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

function emptyHistory(): Record<string, number[]> {
    const history: Record<string, number[]> = {};
    for (const kind of SYSTEM_STAT_KINDS) history[kind] = [];
    return history;
}

export function createSystemStatsSampler(
    options: SystemStatsSamplerOptions = {}
): SystemStatsSampler {
    const intervalMs = options.intervalMs ?? SYSTEM_STATS_INTERVAL_MS;
    const cap = options.historyLength ?? SYSTEM_STATS_HISTORY;
    const now = options.now ?? (() => Date.now());
    const probe = options.probe ?? (() => probeHost());
    const listeners = new Set<(snapshot: SystemStatsSnapshot) => void>();

    let history = emptyHistory();
    let current: SystemStatsSnapshot = { stats: ZERO_SYSTEM_STATS, history, intervalMs };
    let enabled = false;
    let disposed = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight = false;

    // Baselines for the delta metrics. `null` = "no baseline yet" → this sample reports 0.
    let previousCpu: { busy: number; total: number } | null = null;
    let previousNet: { down: number; up: number } | null = null;
    let previousIo: { read: number; write: number } | null = null;
    let previousTime: number | null = null;
    // Memory is a LEVEL, not a rate: an unavailable probe carries the last known value forward
    // rather than reporting 0 %, which would read as "the machine freed all its memory".
    let lastMemUsed = 0;

    const resetBaselines = (): void => {
        previousCpu = null;
        previousNet = null;
        previousIo = null;
        previousTime = null;
        history = emptyHistory();
        current = { stats: ZERO_SYSTEM_STATS, history, intervalMs };
    };

    const emit = (snapshot: SystemStatsSnapshot): void => {
        for (const listener of [...listeners]) {
            try {
                listener(snapshot);
            } catch (error) {
                options.onError?.(error instanceof Error ? error : new Error(String(error)), 'stats listener');
            }
        }
    };

    const takeSample = async (): Promise<SystemStatsSnapshot> => {
        const at = now();
        const elapsedSeconds = previousTime === null ? 0 : Math.max(0, (at - previousTime) / 1000);
        previousTime = at;

        // CPU: the tick delta, which is a ratio and therefore does not need the wall clock.
        const ticks = readCpuTicks();
        let cpuPercent = 0;
        if (previousCpu !== null) {
            const busy = ticks.busy - previousCpu.busy;
            const total = ticks.total - previousCpu.total;
            if (total > 0 && busy >= 0) cpuPercent = Math.min(100, Math.max(0, (busy / total) * 100));
        }
        previousCpu = ticks;

        const host = await probe();
        if (host.memUsedBytes !== null) lastMemUsed = host.memUsedBytes;

        let netDown = 0;
        let netUp = 0;
        if (host.net !== null) {
            if (previousNet !== null) {
                netDown = rateBetween(previousNet.down, host.net.down, elapsedSeconds);
                netUp = rateBetween(previousNet.up, host.net.up, elapsedSeconds);
            }
            previousNet = { down: host.net.down, up: host.net.up };
        }

        let diskRead = 0;
        let diskWrite = 0;
        if (host.io !== null) {
            if (previousIo !== null) {
                diskRead = rateBetween(previousIo.read, host.io.read, elapsedSeconds);
                diskWrite = rateBetween(previousIo.write, host.io.write, elapsedSeconds);
            }
            previousIo = { read: host.io.read, write: host.io.write };
        }

        const space = readDiskSpace(options.home);
        const stats: WsSystemStats = {
            cpuPercent,
            memUsedBytes: lastMemUsed,
            memTotalBytes: host.memTotalBytes,
            loadAverage1m: readLoadAverage(),
            netDownBytesPerSec: netDown,
            netUpBytesPerSec: netUp,
            diskReadBytesPerSec: diskRead,
            diskWriteBytesPerSec: diskWrite,
            diskUsedBytes: space.used,
            diskTotalBytes: space.total
        };

        // AGNT-110: every metric records, enabled or not, so a newly shown gauge already has
        // a trace. The client decides which of the six to draw.
        const next: Record<string, number[]> = {};
        for (const kind of SYSTEM_STAT_KINDS) {
            next[kind] = pushHistory(history[kind] ?? [], systemStatScalar(kind, stats), cap);
        }
        history = next;
        current = { stats, history, intervalMs };
        return current;
    };

    const tick = (): void => {
        if (disposed || !enabled || inFlight) return;
        inFlight = true;
        takeSample()
            .then((snapshot) => {
                // A `setEnabled(false)` that landed mid-probe must not publish the sample it
                // raced: the history was cleared under it and the numbers describe a window
                // nobody is watching.
                if (!disposed && enabled) emit(snapshot);
            })
            .catch((error: unknown) => {
                options.onError?.(error instanceof Error ? error : new Error(String(error)), 'stats sample');
            })
            .finally(() => {
                inFlight = false;
            });
    };

    return {
        get snapshot() {
            return current;
        },
        get enabled() {
            return enabled;
        },

        async sample() {
            return takeSample();
        },

        setEnabled(next) {
            if (disposed || next === enabled) return;
            enabled = next;
            if (!next) {
                if (timer !== null) clearInterval(timer);
                timer = null;
                resetBaselines();
                return;
            }
            resetBaselines();
            timer = setInterval(tick, intervalMs);
            timer.unref?.();
            // One immediate sample so the first gauge appears within a frame rather than after
            // a full interval (the Swift view's `.onAppear { recordSample() }`). It reports 0
            // rates by construction — there is no baseline yet — which is rule 1, not a bug.
            tick();
        },

        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            enabled = false;
            if (timer !== null) clearInterval(timer);
            timer = null;
            listeners.clear();
        }
    };
}
