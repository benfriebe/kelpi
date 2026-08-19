/**
 * JSON in, JSON out — and the four output shapes scripts depend on (cli.md port note 19).
 *
 * Swift renders `--json` with `JSONSerialization`'s `.sortedKeys` (and `.prettyPrinted` for
 * the web envelope dump), which sorts keys at EVERY level. `stableStringify` reproduces that:
 * anything that reaches stdout as JSON goes through it, so a diff of two CLI runs is a diff of
 * the data, never of key order.
 *
 * The typed getters mirror Swift's `as?` casts: a field of the wrong type reads as absent, so
 * one malformed value in a reply can never crash the renderer.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function sortValue(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value !== null && typeof value === 'object') {
        const sorted: JsonObject = {};
        for (const key of Object.keys(value).sort()) {
            const inner = value[key];
            if (inner === undefined) continue;
            sorted[key] = sortValue(inner);
        }
        return sorted;
    }
    return value;
}

/** Compact, deep-key-sorted — the `--json` workhorse. */
export function stableStringify(value: JsonValue): string {
    return JSON.stringify(sortValue(value));
}

/** Multi-line, deep-key-sorted — the web-envelope dump (`decodeWebReply` with `--json`). */
export function prettyStringify(value: JsonValue): string {
    return JSON.stringify(sortValue(value), null, 2);
}

/** Parse a JSON **object**; anything else (array, scalar, garbage) reads as `null`. */
export function parseJsonObject(text: string): JsonObject | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as JsonObject;
}

export function asString(value: JsonValue | undefined): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function asBool(value: JsonValue | undefined): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

/** Swift's `as? Int` — a fractional double does not read as an Int. */
export function asInt(value: JsonValue | undefined): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export function asArray(value: JsonValue | undefined): JsonValue[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

/** `as? [[String: Any]]` — element-wise, so one malformed entry does not hide its siblings. */
export function asObjectArray(value: JsonValue | undefined): JsonObject[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (entry): entry is JsonObject => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    );
}

/** `as? [String]` — Swift's cast fails wholesale when any element is not a string. */
export function asStringArray(value: JsonValue | undefined): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((entry) => typeof entry === 'string')) return undefined;
    return value as string[];
}
