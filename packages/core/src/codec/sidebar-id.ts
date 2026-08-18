/**
 * `appState["topLevelOrder"]` — a JSON array of Swift-Codable `SidebarID` enum values:
 *
 *   [{"workspace":{"_0":"<UUID>"}},{"group":{"_0":"<UUID>"}}]
 *
 * Order is the sidebar's top-level render order (workspaces and group headers interleaved).
 */

import { isJSONObject, singleCaseKey, tryParseJSON } from './json.js';
import { normalizeUUIDLoose, parseUUID } from './uuid.js';

export type SidebarID =
    | { readonly kind: 'workspace'; readonly id: string }
    | { readonly kind: 'group'; readonly id: string };

export function workspaceSidebarID(id: string): SidebarID {
    return { kind: 'workspace', id };
}

export function groupSidebarID(id: string): SidebarID {
    return { kind: 'group', id };
}

export function parseSidebarID(value: unknown): SidebarID | null {
    const tagged = singleCaseKey(value);
    if (tagged === null) return null;
    if (tagged.key !== 'workspace' && tagged.key !== 'group') return null;
    if (!isJSONObject(tagged.payload)) return null;
    const id = parseUUID(tagged.payload['_0']);
    if (id === null) return null;
    return { kind: tagged.key, id };
}

/** All-or-nothing, like decoding `[SidebarID]`: one bad entry fails the whole array. */
export function parseSidebarIDArray(value: unknown): SidebarID[] | null {
    if (!Array.isArray(value)) return null;
    const result: SidebarID[] = [];
    for (const entry of value) {
        const parsed = parseSidebarID(entry);
        if (parsed === null) return null;
        result.push(parsed);
    }
    return result;
}

export function parseTopLevelOrderJSON(text: string | null | undefined): SidebarID[] | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const parsed = tryParseJSON(text);
    if (!parsed.ok) return null;
    return parseSidebarIDArray(parsed.value);
}

/** Load path: undecodable / missing `topLevelOrder` degrades to `[]`. */
export function decodeTopLevelOrderJSON(text: string | null | undefined): SidebarID[] {
    return parseTopLevelOrderJSON(text) ?? [];
}

export function encodeSidebarID(entry: SidebarID): unknown {
    const payload = { _0: normalizeUUIDLoose(entry.id) };
    return entry.kind === 'workspace' ? { workspace: payload } : { group: payload };
}

export function encodeTopLevelOrderJSON(order: readonly SidebarID[]): string {
    return JSON.stringify(order.map(encodeSidebarID));
}
