/**
 * UUID handling matching Foundation's `UUID(uuidString:)` / `UUID.uuidString`:
 * parse the canonical 8-4-4-4-12 hex form case-insensitively, emit UPPERCASE.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUUIDString(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Canonical uppercase form, or null when `value` is not a well-formed UUID string. */
export function parseUUID(value: unknown): string | null {
    if (!isUUIDString(value)) return null;
    return value.toUpperCase();
}

/** Uppercases a well-formed UUID and leaves anything else untouched (write path: never throws). */
export function normalizeUUIDLoose(value: string): string {
    return parseUUID(value) ?? value;
}

/** Case-insensitive identity comparison; both sides must be well-formed. */
export function uuidEquals(a: unknown, b: unknown): boolean {
    const left = parseUUID(a);
    if (left === null) return false;
    return left === parseUUID(b);
}

function defaultUUIDSource(): string {
    const source = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (typeof source?.randomUUID !== 'function') {
        throw new Error('crypto.randomUUID is unavailable; pass an explicit generator to newUUID');
    }
    return source.randomUUID();
}

/**
 * Generates a canonical uppercase UUID. `source` is injectable so pure callers (and tests)
 * can supply a deterministic generator.
 */
export function newUUID(source: () => string = defaultUUIDSource): string {
    const generated = parseUUID(source());
    if (generated === null) {
        throw new Error('UUID generator returned a value that is not a canonical UUID string');
    }
    return generated;
}
