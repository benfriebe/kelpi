/**
 * The status-bar metric formatters (APP-080, APP-084).
 *
 * **The divisor split is the point of this file.** Throughput RATES step units at 1000 and byte
 * TOTALS step at 1024, and that is not an inconsistency in the original: the rate formatter's
 * whole job is to stay inside ~6 characters so the footer slot never reflows, and switching at
 * 1000 is what stops a 4-digit value ever appearing. Totals live in the hover popover where
 * width is not scarce and use the conventional binary divisor. Anyone "fixing" one to match the
 * other breaks either the layout or the convention, so both are pinned here.
 */

import { ZERO_SYSTEM_STATS, type WsSystemStats } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import {
    SYSTEM_STAT_KINDS,
    compactStatLabel,
    detailStatLabel,
    formatBytes,
    formatRate,
    historyFootnote,
    sparklineRange,
    summarizeHistory,
    summaryStatValue,
    systemStatMeta,
    visibleStatKinds
} from './stats';

function stats(patch: Partial<WsSystemStats> = {}): WsSystemStats {
    return { ...ZERO_SYSTEM_STATS, ...patch };
}

describe('formatRate', () => {
    it('steps units at 1000 and stays inside six characters', () => {
        expect(formatRate(0)).toBe('0B/s');
        expect(formatRate(999)).toBe('999B/s');
        expect(formatRate(1000)).toBe('1.0K/s');
        expect(formatRate(1_400_000)).toBe('1.4M/s');
        expect(formatRate(999_000_000)).toBe('999M/s');
        expect(formatRate(1_500_000_000)).toBe('1.5G/s');
        for (const value of [0, 1, 999, 1000, 12_345, 999_000_000, 5e12, 9e14]) {
            expect(formatRate(value).length).toBeLessThanOrEqual(6);
        }
    });

    /**
     * The unit table stops at T, so above ~1000 TB/s the number grows a digit. That is the
     * Swift behaviour verbatim (`units` ends at `"T"`) and the spec says "~6 characters", not
     * "6": nobody's network moves a petabyte a second, and inventing a P unit for a case that
     * cannot happen would be a divergence for nothing.
     */
    it('grows past six characters only above the top unit, as in the original', () => {
        expect(formatRate(9e15)).toBe('9000T/s');
    });

    it('drops the decimal as the magnitude grows', () => {
        expect(formatRate(9_900)).toBe('9.9K/s');
        expect(formatRate(45_000)).toBe('45K/s');
        expect(formatRate(450_000)).toBe('450K/s');
    });

    it('never emits NaN for a bad input', () => {
        expect(formatRate(Number.NaN)).toBe('0B/s');
        expect(formatRate(-5)).toBe('0B/s');
    });
});

describe('formatBytes', () => {
    it('steps units at 1024 — the OTHER divisor', () => {
        expect(formatBytes(0)).toBe('0B');
        expect(formatBytes(1023)).toBe('1023B');
        expect(formatBytes(1024)).toBe('1.0K');
        // 1000 bytes is NOT a kilobyte here, which is exactly the difference from formatRate.
        expect(formatBytes(1000)).toBe('1000B');
        expect(formatBytes(4.1 * 1024 ** 3)).toBe('4.1G');
        expect(formatBytes(16 * 1024 ** 3)).toBe('16.0G');
    });
});

describe('compactStatLabel', () => {
    it('renders each kind the way the footer slot expects', () => {
        const sample = stats({
            cpuPercent: 42.6,
            memUsedBytes: 4 * 1024 ** 3,
            memTotalBytes: 16 * 1024 ** 3,
            loadAverage1m: 7.117,
            netDownBytesPerSec: 1_200_000,
            netUpBytesPerSec: 88_000,
            diskReadBytesPerSec: 500_000,
            diskWriteBytesPerSec: 250_000,
            diskUsedBytes: 300,
            diskTotalBytes: 1000
        });
        expect(compactStatLabel('cpu', sample)).toBe('43%');
        expect(compactStatLabel('memory', sample)).toBe('25%');
        expect(compactStatLabel('load', sample)).toBe('7.12');
        expect(compactStatLabel('network', sample)).toBe('1.3M/s');
        expect(compactStatLabel('diskIO', sample)).toBe('750K/s');
        expect(compactStatLabel('diskSpace', sample)).toBe('30%');
    });

    it('reads 0 % rather than NaN when a denominator is zero', () => {
        expect(compactStatLabel('memory', stats())).toBe('0%');
        expect(compactStatLabel('diskSpace', stats())).toBe('0%');
    });
});

describe('detailStatLabel', () => {
    it('is the verbose breakdown the popover shows', () => {
        const sample = stats({
            memUsedBytes: 4.1 * 1024 ** 3,
            memTotalBytes: 16 * 1024 ** 3,
            netDownBytesPerSec: 1_200_000,
            netUpBytesPerSec: 88_000,
            diskReadBytesPerSec: 1000,
            diskWriteBytesPerSec: 2000,
            loadAverage1m: 1.5
        });
        expect(detailStatLabel('memory', sample)).toBe('4.1G / 16.0G');
        expect(detailStatLabel('network', sample)).toBe('↓ 1.2M/s   ↑ 88K/s');
        expect(detailStatLabel('diskIO', sample)).toBe('R 1.0K/s   W 2.0K/s');
        expect(detailStatLabel('load', sample)).toBe('1.50 (1-min)');
    });
});

describe('the metric table', () => {
    it('covers every kind, with the Swift slot widths', () => {
        for (const kind of SYSTEM_STAT_KINDS) {
            expect(systemStatMeta(kind)).not.toBeNull();
        }
        expect(systemStatMeta('cpu')?.labelWidth).toBe(44);
        expect(systemStatMeta('load')?.labelWidth).toBe(50);
        expect(systemStatMeta('network')?.labelWidth).toBe(60);
        expect(systemStatMeta('gpu')).toBeNull();
    });

    it('marks exactly the bounded metrics as percentages', () => {
        expect(SYSTEM_STAT_KINDS.filter((kind) => systemStatMeta(kind)?.isPercentage === true)).toEqual([
            'cpu',
            'memory',
            'diskSpace'
        ]);
    });
});

describe('visibleStatKinds', () => {
    it('is the enabled set in CANONICAL order, not the caller’s', () => {
        expect(visibleStatKinds(true, ['diskSpace', 'cpu', 'network'])).toEqual(['cpu', 'network', 'diskSpace']);
    });

    it('is empty when the master toggle is off, whatever is enabled', () => {
        expect(visibleStatKinds(false, ['cpu', 'memory'])).toEqual([]);
    });

    it('drops ids it does not know', () => {
        expect(visibleStatKinds(true, ['cpu', 'gpu'])).toEqual(['cpu']);
    });
});

describe('sparklineRange', () => {
    // APP-082: a quiet CPU must LOOK quiet, so percentage metrics are pinned to 0…100 rather
    // than stretched to fill the box.
    it('pins percentage metrics to 100 and auto-scales the rest', () => {
        expect(sparklineRange(true, [1, 2, 3])).toBe(100);
        expect(sparklineRange(false, [1, 2, 3])).toBe(3);
    });

    it('never returns zero, so a flat all-zero trace cannot divide by it', () => {
        expect(sparklineRange(false, [0, 0, 0])).toBeGreaterThan(0);
        expect(sparklineRange(false, [])).toBeGreaterThan(0);
    });
});

describe('summarizeHistory', () => {
    it('is now/min/max/avg over the retained window', () => {
        expect(summarizeHistory([10, 30, 20])).toEqual({ now: 20, min: 10, max: 30, avg: 20, count: 3 });
    });

    it('is all-zero for an empty window rather than Infinity', () => {
        expect(summarizeHistory([])).toEqual({ now: 0, min: 0, max: 0, avg: 0, count: 0 });
    });
});

describe('summaryStatValue', () => {
    it('formats each kind the way its gauge does', () => {
        expect(summaryStatValue('cpu', 42.6)).toBe('43%');
        expect(summaryStatValue('load', 1.234)).toBe('1.23');
        expect(summaryStatValue('network', 1_400_000)).toBe('1.4M/s');
    });
});

describe('historyFootnote', () => {
    // Derived from the daemon's own cadence, so changing the interval cannot make it lie.
    it('derives the seconds from the interval', () => {
        expect(historyFootnote(60, 2000)).toBe('last 60 samples · ~120s');
        expect(historyFootnote(30, 1000)).toBe('last 30 samples · ~30s');
    });
});
