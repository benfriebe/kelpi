/**
 * Identifier helpers shared by the resolvers.
 * Specs: docs/current/app-state-core.md §1.2 (makeSlug), §6.1 (normalizeLabel),
 * docs/current/workspace-feature.md §3.1/§3.3, docs/current/wire-protocol.md §5.7
 * (UUID parsing = Foundation's `UUID(uuidString:)`).
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the token is a canonical 8-4-4-4-12 hex UUID (case-insensitive). */
export function isUUIDToken(value: string): boolean {
    return UUID_PATTERN.test(value);
}

/** Lowercased canonical form for comparison, or null when the token is not a UUID. */
export function normalizeUUIDToken(value: string): string | null {
    return UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Identity comparison with Foundation semantics: two UUID strings are equal when they
 * parse and agree case-insensitively. Non-UUID tokens fall back to exact equality so
 * callers can pass ids that were never UUIDs.
 */
export function idsEqual(a: string, b: string): boolean {
    const left = normalizeUUIDToken(a);
    if (left === null) return a === b;
    return left === normalizeUUIDToken(b);
}

/**
 * `makeSlug(name, id)`: lowercase, non-alphanumeric runs collapse to `-`, hyphens
 * trimmed, then the first 8 characters of the id (lowercased) as a uniqueness suffix.
 * An all-punctuation name yields the bare suffix.
 */
export function makeSlug(name: string, id: string): string {
    const base = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const suffix = id.slice(0, 8).toLowerCase();
    return base === '' ? suffix : `${base}-${suffix}`;
}

/** Max length of a workspace label after normalization. */
export const MAX_LABEL_LENGTH = 64;

/**
 * `normalizeLabel(raw)`: trim whitespace/newlines, truncate to 64. An empty result
 * means "ignore this label" - callers no-op rather than storing it.
 */
export function normalizeLabel(raw: string): string {
    const trimmed = raw.trim();
    return trimmed.length <= MAX_LABEL_LENGTH ? trimmed : trimmed.slice(0, MAX_LABEL_LENGTH);
}
