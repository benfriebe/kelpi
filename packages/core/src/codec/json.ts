/**
 * Shared helpers for decoding the JSON blobs Swift's `Codable` wrote into TEXT columns.
 * Decoders here are deliberately strict (they mirror `JSONDecoder`'s all-or-nothing
 * behaviour); the tolerant "fallback" wrappers live next to each column's codec.
 */

export type JSONObject = { readonly [key: string]: unknown };

export type JSONParseResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

export function isJSONObject(value: unknown): value is JSONObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function tryParseJSON(text: string): JSONParseResult {
    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return { ok: false };
    }
}

/**
 * Swift's synthesized enum decoder requires the outer object to carry EXACTLY one key,
 * which must name a known case. Extra keys are a decode error, not something to ignore.
 * (Keys INSIDE a case payload are ignored, matching keyed-container decoding.)
 */
export function singleCaseKey(value: unknown): { readonly key: string; readonly payload: unknown } | null {
    if (!isJSONObject(value)) return null;
    const keys = Object.keys(value);
    if (keys.length !== 1) return null;
    const key = keys[0];
    if (key === undefined) return null;
    return { key, payload: value[key] };
}
