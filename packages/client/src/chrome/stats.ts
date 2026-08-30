/**
 * The status-bar metrics: display metadata + the two formatters (APP-080, APP-081, APP-084).
 *
 * Ported from `SystemStatKind` and `SystemStatsFormat` in
 * `Nex/Services/SystemStatsService.swift`. The daemon samples (`@kelpi/protocol` `ws/stats.ts`);
 * everything about how a number READS is here, because it is a rendering decision.
 *
 * **The divisor split is the thing to not get wrong** (APP-084): throughput RATES step units at
 * **1000** and byte TOTALS step at **1024**. That is not an oversight in the original — the
 * rate formatter's job is to stay inside ~6 characters ("0B/s", "1.4M/s", "999M/s") so the
 * footer slot never reflows, and switching at 1000 is what keeps a 4-digit value from ever
 * appearing. Totals live in the hover popover where width is not scarce, so they use the
 * conventional binary divisor. Both are reproduced here exactly, decimals-dropping rule
 * included.
 */

import { SYSTEM_STAT_KINDS, type SystemStatKind, type WsSystemStats } from '@kelpi/protocol';

import type { ChromeIconName } from './icons';

export type { SystemStatKind };
export { SYSTEM_STAT_KINDS };

export interface SystemStatMeta {
    readonly kind: SystemStatKind;
    readonly displayName: string;
    readonly icon: ChromeIconName;
    /** Bounded 0–100 metrics scale their sparkline to a fixed 0…100; the rest auto-scale. */
    readonly isPercentage: boolean;
    /**
     * Fixed width (px) for the icon+value cluster. The cluster is right-aligned in this slot so
     * the value abuts its sparkline and the slack falls before the icon — the value's right
     * edge (and everything after it) stays static as the number changes width (APP-081).
     */
    readonly labelWidth: number;
}

/** `SystemStatKind`'s metadata table, in canonical order. */
export const SYSTEM_STAT_META: Readonly<Record<SystemStatKind, SystemStatMeta>> = {
    cpu: { kind: 'cpu', displayName: 'CPU', icon: 'cpu', isPercentage: true, labelWidth: 44 },
    memory: { kind: 'memory', displayName: 'Memory', icon: 'memory', isPercentage: true, labelWidth: 44 },
    load: { kind: 'load', displayName: 'Load average', icon: 'gauge', isPercentage: false, labelWidth: 50 },
    network: { kind: 'network', displayName: 'Network', icon: 'network', isPercentage: false, labelWidth: 60 },
    diskIO: { kind: 'diskIO', displayName: 'Disk I/O', icon: 'diskio', isPercentage: false, labelWidth: 60 },
    diskSpace: { kind: 'diskSpace', displayName: 'Disk space', icon: 'drive', isPercentage: true, labelWidth: 44 }
};

export function systemStatMeta(kind: string): SystemStatMeta | null {
    return (SYSTEM_STAT_META as Record<string, SystemStatMeta | undefined>)[kind] ?? null;
}

function percent(used: number, total: number): number {
    if (!Number.isFinite(total) || total <= 0) return 0;
    return (used / total) * 100;
}

/**
 * `SystemStatsFormat.bytes` — **1024** divisor. `0` stays `"0B"`; anything above the first
 * step carries one decimal (`"4.1G"`).
 */
export function formatBytes(value: number): string {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let magnitude = Number.isFinite(value) ? Math.max(0, value) : 0;
    let index = 0;
    while (magnitude >= 1024 && index < units.length - 1) {
        magnitude /= 1024;
        index += 1;
    }
    return index === 0
        ? `${String(Math.trunc(magnitude))}${units[index] as string}`
        : `${magnitude.toFixed(1)}${units[index] as string}`;
}

/**
 * `SystemStatsFormat.rate` — **1000** divisor, bounded to ~6 characters, dropping decimals as
 * the magnitude grows: bytes and ≥100 round to an integer, ≥10 rounds to an integer, and only
 * the 0…10 band keeps one decimal.
 */
export function formatRate(bytesPerSec: number): string {
    const units = ['B', 'K', 'M', 'G', 'T'];
    let magnitude = Number.isFinite(bytesPerSec) ? Math.max(0, bytesPerSec) : 0;
    let index = 0;
    while (magnitude >= 1000 && index < units.length - 1) {
        magnitude /= 1000;
        index += 1;
    }
    const number =
        index === 0 || magnitude >= 100
            ? String(Math.round(magnitude))
            : magnitude >= 10
              ? String(Math.round(magnitude))
              : magnitude.toFixed(1);
    return `${number}${units[index] as string}/s`;
}

/** `SystemStatKind.compactLabel` — what the footer shows beside the icon. */
export function compactStatLabel(kind: SystemStatKind, stats: WsSystemStats): string {
    switch (kind) {
        case 'cpu':
            return `${String(Math.round(stats.cpuPercent))}%`;
        case 'memory':
            return `${String(Math.round(percent(stats.memUsedBytes, stats.memTotalBytes)))}%`;
        case 'load':
            return stats.loadAverage1m.toFixed(2);
        case 'network':
            return formatRate(stats.netDownBytesPerSec + stats.netUpBytesPerSec);
        case 'diskIO':
            return formatRate(stats.diskReadBytesPerSec + stats.diskWriteBytesPerSec);
        case 'diskSpace':
            return `${String(Math.round(percent(stats.diskUsedBytes, stats.diskTotalBytes)))}%`;
        default:
            return '';
    }
}

/** `SystemStatKind.detailLabel` — the hover popover's verbose breakdown. */
export function detailStatLabel(kind: SystemStatKind, stats: WsSystemStats): string {
    switch (kind) {
        case 'cpu':
            return `${String(Math.round(stats.cpuPercent))}% busy`;
        case 'memory':
            return `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)}`;
        case 'load':
            return `${stats.loadAverage1m.toFixed(2)} (1-min)`;
        case 'network':
            return `↓ ${formatRate(stats.netDownBytesPerSec)}   ↑ ${formatRate(stats.netUpBytesPerSec)}`;
        case 'diskIO':
            return `R ${formatRate(stats.diskReadBytesPerSec)}   W ${formatRate(stats.diskWriteBytesPerSec)}`;
        case 'diskSpace':
            return `${formatBytes(stats.diskUsedBytes)} / ${formatBytes(stats.diskTotalBytes)}`;
        default:
            return '';
    }
}

/** `StatDetailPopover.formatted` — the now/min/max/avg summary numbers. */
export function summaryStatValue(kind: SystemStatKind, value: number): string {
    switch (kind) {
        case 'cpu':
        case 'memory':
        case 'diskSpace':
            return `${String(Math.round(value))}%`;
        case 'load':
            return value.toFixed(2);
        default:
            return formatRate(value);
    }
}

export interface HistorySummary {
    readonly now: number;
    readonly min: number;
    readonly max: number;
    readonly avg: number;
    readonly count: number;
}

/** The popover's four numbers over the retained window (an empty window reads all-zero). */
export function summarizeHistory(history: readonly number[]): HistorySummary {
    if (history.length === 0) return { now: 0, min: 0, max: 0, avg: 0, count: 0 };
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (const value of history) {
        if (value < min) min = value;
        if (value > max) max = value;
        sum += value;
    }
    return {
        now: history[history.length - 1] as number,
        min,
        max,
        avg: sum / history.length,
        count: history.length
    };
}

/**
 * The footnote under the popover graph: `"last N samples · ~Ns"`. The seconds figure is derived
 * from the daemon's own cadence rather than hard-coded, so changing the interval cannot make
 * the label lie.
 */
export function historyFootnote(count: number, intervalMs: number): string {
    const seconds = Math.round((count * intervalMs) / 1000);
    return `last ${String(count)} samples · ~${String(seconds)}s`;
}

/**
 * The sparkline's y-range (`Sparkline.body`): percentage metrics are pinned to 0…100 so a quiet
 * CPU reads as a quiet CPU rather than being stretched to fill the box; everything else
 * auto-scales to the window max so a flat non-zero trace still reads.
 */
export function sparklineRange(isPercentage: boolean, values: readonly number[]): number {
    if (isPercentage) return 100;
    return Math.max(...values, 0.0001);
}

/** The enabled metrics, in canonical order, gated by the master toggle (`enabledStatKinds`). */
export function visibleStatKinds(
    showSystemStats: boolean,
    enabled: readonly string[]
): readonly SystemStatKind[] {
    if (!showSystemStats) return [];
    const wanted = new Set(enabled);
    return SYSTEM_STAT_KINDS.filter((kind) => wanted.has(kind));
}
