import { describe, expect, it } from 'vitest';

import {
    dateFromEpochSeconds,
    epochSecondsFromDate,
    epochSecondsFromUnixMillis,
    epochSecondsFromUnixSeconds,
    epochSecondsToColumn,
    formatWireTimestamp,
    formatWireTimestampFromDate,
    looksLikeUnixMillis,
    nowEpochSeconds,
    parseEpochSecondsColumn,
    parseWireTimestamp,
    unixMillisFromEpochSeconds
} from './timestamps.js';

describe('epoch seconds constructors', () => {
    it('converts millis → seconds (the DB column unit)', () => {
        expect(epochSecondsToColumn(epochSecondsFromUnixMillis(1_755_500_000_123))).toBeCloseTo(1_755_500_000.123, 6);
        expect(epochSecondsToColumn(nowEpochSeconds(() => 1_755_500_000_000))).toBe(1_755_500_000);
        expect(epochSecondsToColumn(epochSecondsFromDate(new Date('2026-08-18T01:02:03Z')))).toBe(
            Date.UTC(2026, 7, 18, 1, 2, 3) / 1000
        );
    });

    it('rejects a millisecond value handed to the seconds constructor (the 1000x corruption)', () => {
        expect(() => epochSecondsFromUnixSeconds(1_755_500_000_123)).toThrow(RangeError);
        expect(() => epochSecondsFromUnixSeconds(Date.now())).toThrow(/milliseconds/);
        expect(epochSecondsToColumn(epochSecondsFromUnixSeconds(1_755_500_000.5))).toBe(1_755_500_000.5);
    });

    it('rejects non-finite input', () => {
        expect(() => epochSecondsFromUnixSeconds(Number.NaN)).toThrow(RangeError);
        expect(() => epochSecondsFromUnixMillis(Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(() => epochSecondsFromDate(new Date('nope'))).toThrow(RangeError);
    });

    it('flags millisecond-magnitude values', () => {
        expect(looksLikeUnixMillis(1_755_500_000_123)).toBe(true);
        expect(looksLikeUnixMillis(1_755_500_000)).toBe(false);
        expect(looksLikeUnixMillis(Number.NaN)).toBe(false);
    });

    it('round-trips through Date', () => {
        const seconds = epochSecondsFromUnixMillis(1_755_500_000_123);
        expect(dateFromEpochSeconds(seconds).toISOString()).toBe('2025-08-18T06:53:20.123Z');
        expect(unixMillisFromEpochSeconds(seconds)).toBe(1_755_500_000_123);
    });
});

describe('parseEpochSecondsColumn', () => {
    it('accepts finite numbers only', () => {
        expect(parseEpochSecondsColumn(1_778_541_556.089_057_9)).toBeCloseTo(1_778_541_556.089_057_9, 6);
        expect(parseEpochSecondsColumn('1778541556.0890579')).toBeNull();
        expect(parseEpochSecondsColumn(null)).toBeNull();
        expect(parseEpochSecondsColumn(Number.NaN)).toBeNull();
    });
});

describe('wire timestamps', () => {
    it('formats ISO 8601 UTC at seconds precision (never milliseconds)', () => {
        const seconds = epochSecondsFromUnixMillis(Date.UTC(2026, 7, 18, 1, 2, 3, 456));
        expect(formatWireTimestamp(seconds)).toBe('2026-08-18T01:02:03Z');
        expect(formatWireTimestampFromDate(new Date('2026-08-18T09:05:12.999Z'))).toBe('2026-08-18T09:05:12Z');
    });

    it('truncates sub-second precision rather than rounding', () => {
        expect(formatWireTimestamp(epochSecondsFromUnixMillis(1_755_500_000_999))).toBe('2025-08-18T06:53:20Z');
    });

    it('parses the wire shape back to seconds', () => {
        const parsed = parseWireTimestamp('2026-08-18T01:02:03Z');
        expect(parsed).not.toBeNull();
        expect(parsed === null ? null : formatWireTimestamp(parsed)).toBe('2026-08-18T01:02:03Z');
        expect(parseWireTimestamp('2026-08-18T01:02:03.123Z')).not.toBeNull();
    });

    it('rejects non-UTC / non-ISO strings', () => {
        expect(parseWireTimestamp('2026-08-18 01:02:03')).toBeNull();
        expect(parseWireTimestamp('2026-08-18T01:02:03+10:00')).toBeNull();
        expect(parseWireTimestamp(1_755_500_000)).toBeNull();
        expect(parseWireTimestamp(null)).toBeNull();
    });
});
