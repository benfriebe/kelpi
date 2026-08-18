/**
 * `workspace.layoutJSON` — Swift's synthesized `Codable` encoding of the `PaneLayout` enum:
 *
 *   {"leaf":{"_0":"<UUID>"}}
 *   {"empty":{}}
 *   {"split":{"_0":"horizontal","ratio":0.5,"first":<layout>,"second":<layout>}}
 *
 * The outer object names the case; the unlabeled associated value is keyed `_0`. UUIDs are
 * written uppercase and parsed case-insensitively. Object key order is not load-bearing.
 */

import { isJSONObject, singleCaseKey, tryParseJSON } from './json.js';
import { normalizeUUIDLoose, parseUUID } from './uuid.js';

export type SplitDirection = 'horizontal' | 'vertical';

export type PaneLayout =
    | { readonly kind: 'empty' }
    | { readonly kind: 'leaf'; readonly paneID: string }
    | {
          readonly kind: 'split';
          readonly direction: SplitDirection;
          readonly ratio: number;
          readonly first: PaneLayout;
          readonly second: PaneLayout;
      };

export const emptyLayout: PaneLayout = { kind: 'empty' };

export function leafLayout(paneID: string): PaneLayout {
    return { kind: 'leaf', paneID };
}

export function splitLayout(
    direction: SplitDirection,
    ratio: number,
    first: PaneLayout,
    second: PaneLayout
): PaneLayout {
    return { kind: 'split', direction, ratio, first, second };
}

function parseSplitDirection(value: unknown): SplitDirection | null {
    return value === 'horizontal' || value === 'vertical' ? value : null;
}

/** Strict decode of an already-parsed JSON value; null on any shape violation. */
export function parsePaneLayout(value: unknown): PaneLayout | null {
    const tagged = singleCaseKey(value);
    if (tagged === null) return null;

    switch (tagged.key) {
        case 'empty':
            // Swift's synthesized decoder returns a payload-free case without reading the
            // associated value, so anything under "empty" decodes.
            return emptyLayout;

        case 'leaf': {
            if (!isJSONObject(tagged.payload)) return null;
            const paneID = parseUUID(tagged.payload['_0']);
            if (paneID === null) return null;
            return { kind: 'leaf', paneID };
        }

        case 'split': {
            if (!isJSONObject(tagged.payload)) return null;
            const direction = parseSplitDirection(tagged.payload['_0']);
            if (direction === null) return null;
            const ratio = tagged.payload['ratio'];
            if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
            const first = parsePaneLayout(tagged.payload['first']);
            if (first === null) return null;
            const second = parsePaneLayout(tagged.payload['second']);
            if (second === null) return null;
            return { kind: 'split', direction, ratio, first, second };
        }

        default:
            return null;
    }
}

/** Strict decode of the column text; null when the column is absent or undecodable. */
export function parsePaneLayoutJSON(text: string | null | undefined): PaneLayout | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const parsed = tryParseJSON(text);
    if (!parsed.ok) return null;
    return parsePaneLayout(parsed.value);
}

/** Load path: any decode failure (and a missing/empty column) degrades to `empty`. */
export function decodePaneLayoutJSON(text: string | null | undefined): PaneLayout {
    return parsePaneLayoutJSON(text) ?? emptyLayout;
}

/** JSON value in the Swift shape (uppercase UUIDs); feed to `JSON.stringify`. */
export function encodePaneLayout(layout: PaneLayout): unknown {
    switch (layout.kind) {
        case 'empty':
            return { empty: {} };
        case 'leaf':
            return { leaf: { _0: normalizeUUIDLoose(layout.paneID) } };
        case 'split':
            return {
                split: {
                    _0: layout.direction,
                    ratio: layout.ratio,
                    first: encodePaneLayout(layout.first),
                    second: encodePaneLayout(layout.second)
                }
            };
    }
}

export function encodePaneLayoutJSON(layout: PaneLayout): string {
    return JSON.stringify(encodePaneLayout(layout));
}
