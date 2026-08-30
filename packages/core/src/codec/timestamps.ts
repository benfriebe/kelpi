/**
 * Two timestamp representations exist in this system and they must never be mixed:
 *
 *  - DB columns (`createdAt`, `lastAccessedAt`, `lastActivityAt`, …) hold Unix epoch
 *    **SECONDS** as a float. Writing `Date.now()` there corrupts every timestamp by 1000x.
 *  - Wire replies (`pane list`, `workspace list`, graft) hold ISO 8601 UTC at SECONDS
 *    precision: `YYYY-MM-DDThh:mm:ssZ` — no milliseconds.
 *
 * `EpochSeconds` is branded so a raw millisecond number cannot reach a DB column: the only
 * ways to obtain one are the named converters below, and the seconds constructor rejects
 * millisecond-magnitude input outright.
 */

export type EpochSeconds = number & { readonly __brand: 'kelpi.EpochSeconds' };

/**
 * Any |value| at or above this in SECONDS lands past the year 5138 — in practice it is a
 * millisecond value that leaked into a seconds slot.
 */
const MILLISECOND_MAGNITUDE = 1e11;

export function looksLikeUnixMillis(value: number): boolean {
    return Number.isFinite(value) && Math.abs(value) >= MILLISECOND_MAGNITUDE;
}

/** Epoch seconds from a value already known to be in seconds; rejects millisecond input. */
export function epochSecondsFromUnixSeconds(seconds: number): EpochSeconds {
    if (!Number.isFinite(seconds)) {
        throw new RangeError(`epoch seconds must be finite (got ${String(seconds)})`);
    }
    if (looksLikeUnixMillis(seconds)) {
        throw new RangeError(
            `${String(seconds)} looks like Unix milliseconds, not seconds; use epochSecondsFromUnixMillis`
        );
    }
    return seconds as EpochSeconds;
}

export function epochSecondsFromUnixMillis(millis: number): EpochSeconds {
    if (!Number.isFinite(millis)) {
        throw new RangeError(`epoch millis must be finite (got ${String(millis)})`);
    }
    return (millis / 1000) as EpochSeconds;
}

export function epochSecondsFromDate(date: Date): EpochSeconds {
    const millis = date.getTime();
    if (!Number.isFinite(millis)) {
        throw new RangeError('cannot convert an invalid Date to epoch seconds');
    }
    return (millis / 1000) as EpochSeconds;
}

/** `clock` returns Unix MILLISECONDS (e.g. `Date.now`); injectable for deterministic tests. */
export function nowEpochSeconds(clock: () => number = Date.now): EpochSeconds {
    return epochSecondsFromUnixMillis(clock());
}

export function unixMillisFromEpochSeconds(seconds: EpochSeconds): number {
    return seconds * 1000;
}

export function dateFromEpochSeconds(seconds: EpochSeconds): Date {
    return new Date(unixMillisFromEpochSeconds(seconds));
}

/** Value to write into a REAL/DOUBLE column. */
export function epochSecondsToColumn(seconds: EpochSeconds): number {
    return seconds;
}

/**
 * Reads a REAL/DOUBLE timestamp column. Non-numeric / non-finite values decode to null
 * (row-level tolerance, matching the Swift loader); millisecond-magnitude values are
 * returned as-is so a corrupt DB degrades rather than crashes — use `looksLikeUnixMillis`
 * to detect them.
 */
export function parseEpochSecondsColumn(value: unknown): EpochSeconds | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value as EpochSeconds;
}

const WIRE_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** ISO 8601 UTC, seconds precision (`YYYY-MM-DDThh:mm:ssZ`) — the shape every reply uses. */
export function formatWireTimestamp(seconds: EpochSeconds): string {
    const millis = unixMillisFromEpochSeconds(seconds);
    if (!Number.isFinite(millis)) {
        throw new RangeError('cannot format a non-finite timestamp');
    }
    return new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function formatWireTimestampFromDate(date: Date): string {
    return formatWireTimestamp(epochSecondsFromDate(date));
}

/**
 * Parses the wire shape back to epoch seconds. Fractional seconds are accepted on input
 * (other producers emit them) but never written by `formatWireTimestamp`.
 */
export function parseWireTimestamp(text: unknown): EpochSeconds | null {
    if (typeof text !== 'string' || !WIRE_TIMESTAMP_PATTERN.test(text)) return null;
    const millis = Date.parse(text);
    if (!Number.isFinite(millis)) return null;
    return epochSecondsFromUnixMillis(millis);
}
