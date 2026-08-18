/**
 * The remaining JSON TEXT columns: `workspace.labelsJSON`, `workspace_group.childOrderJSON`
 * and `pane.webTabsJSON`. Each is a plain (untagged) Swift `Codable` value, so decoding is
 * all-or-nothing — one bad element fails the whole array, which then degrades to `[]` on the
 * load path.
 */

import { isJSONObject, tryParseJSON } from './json.js';
import { normalizeUUIDLoose, parseUUID } from './uuid.js';

export interface WebTab {
    readonly id: string;
    readonly url: string;
    readonly title: string;
}

function parseArrayJSON(text: string | null | undefined): unknown[] | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    const parsed = tryParseJSON(text);
    if (!parsed.ok || !Array.isArray(parsed.value)) return null;
    return parsed.value;
}

/** `[String]` — strict: a non-string element fails the array. */
export function parseStringArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const result: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') return null;
        result.push(entry);
    }
    return result;
}

export function parseLabelsJSON(text: string | null | undefined): string[] | null {
    const array = parseArrayJSON(text);
    if (array === null) return null;
    return parseStringArray(array);
}

/** Load path: undecodable `labelsJSON` degrades to `[]`. */
export function decodeLabelsJSON(text: string | null | undefined): string[] {
    return parseLabelsJSON(text) ?? [];
}

export function encodeLabelsJSON(labels: readonly string[]): string {
    return JSON.stringify(labels);
}

/** `[UUID]` — strict: a malformed UUID fails the array (Swift decodes elements as `UUID`). */
export function parseUUIDArray(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const result: string[] = [];
    for (const entry of value) {
        const id = parseUUID(entry);
        if (id === null) return null;
        result.push(id);
    }
    return result;
}

export function parseChildOrderJSON(text: string | null | undefined): string[] | null {
    const array = parseArrayJSON(text);
    if (array === null) return null;
    return parseUUIDArray(array);
}

/** Load path: undecodable `childOrderJSON` degrades to `[]`. */
export function decodeChildOrderJSON(text: string | null | undefined): string[] {
    return parseChildOrderJSON(text) ?? [];
}

export function encodeChildOrderJSON(ids: readonly string[]): string {
    return JSON.stringify(ids.map(normalizeUUIDLoose));
}

export function parseWebTab(value: unknown): WebTab | null {
    if (!isJSONObject(value)) return null;
    const id = parseUUID(value['id']);
    if (id === null) return null;
    const url = value['url'];
    const title = value['title'];
    if (typeof url !== 'string' || typeof title !== 'string') return null;
    return { id, url, title };
}

export function parseWebTabArray(value: unknown): WebTab[] | null {
    if (!Array.isArray(value)) return null;
    const result: WebTab[] = [];
    for (const entry of value) {
        const tab = parseWebTab(entry);
        if (tab === null) return null;
        result.push(tab);
    }
    return result;
}

export function parseWebTabsJSON(text: string | null | undefined): WebTab[] | null {
    const array = parseArrayJSON(text);
    if (array === null) return null;
    return parseWebTabArray(array);
}

/** Load path: NULL / empty / undecodable `webTabsJSON` degrades to `[]` (blank web pane). */
export function decodeWebTabsJSON(text: string | null | undefined): WebTab[] {
    return parseWebTabsJSON(text) ?? [];
}

export function encodeWebTabsJSON(tabs: readonly WebTab[]): string {
    return JSON.stringify(
        tabs.map((tab) => ({ id: normalizeUUIDLoose(tab.id), url: tab.url, title: tab.title }))
    );
}
