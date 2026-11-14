/**
 * The remaining JSON TEXT columns: `workspace.labelsJSON`, `workspace_group.childOrderJSON`,
 * `pane.webTabsJSON` and `workspace.tabsJSON`. The first three are plain (untagged) Swift
 * `Codable` values, so decoding them is all-or-nothing: one bad element fails the whole array,
 * which then degrades to `[]` on the load path. `tabsJSON` is Kelpi's own and decodes per entry
 * (`parseWorkspaceTabsJSON`), so one bad tab costs that tab, not the others.
 */

import { isJSONObject, tryParseJSON } from './json.js';
import { encodePaneLayout, parsePaneLayout, type PaneLayout } from './pane-layout-json.js';
import { normalizeUUIDLoose, parseUUID } from './uuid.js';

export interface WebTab {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    /**
     * False while the host has no browser view for this tab and the daemon has not yet asked
     * for one (issue #76: the renderer died and the reducer refused to remove the pane's only
     * tab). Absent means live, which is what every tab that has never crashed looks like.
     *
     * **Runtime only.** `encodeWebTabsJSON` below writes `{id,url,title}` and `parseWebTab`
     * reads only those three, so the flag never reaches the database: a pane restored from
     * disk always starts with a live tab, because the host builds its view from scratch.
     */
    readonly live?: boolean | undefined;
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

/**
 * One entry of `workspace.tabsJSON` (persistence.md §2.1, workspace-feature.md §12): a tab's
 * id, its name (null = named after its focused pane), its un-zoomed tree in the
 * `layoutJSON` shape, its focused pane and whether it has been shown yet.
 */
export interface WorkspaceTabRecord {
    readonly id: string;
    readonly name: string | null;
    readonly layout: PaneLayout;
    readonly focusedPaneID: string | null;
    readonly seen: boolean;
}

export function parseWorkspaceTabRecord(value: unknown): WorkspaceTabRecord | null {
    if (!isJSONObject(value)) return null;
    const id = parseUUID(value['id']);
    if (id === null) return null;
    const name = value['name'];
    if (name !== null && name !== undefined && typeof name !== 'string') return null;
    const layout = parsePaneLayout(value['layout']);
    if (layout === null) return null;
    const focused = value['focusedPaneID'];
    const focusedPaneID = focused === null || focused === undefined ? null : parseUUID(focused);
    if (focused !== null && focused !== undefined && focusedPaneID === null) return null;
    return {
        id,
        name: typeof name === 'string' && name.length > 0 ? name : null,
        layout,
        focusedPaneID,
        seen: value['seen'] !== false
    };
}

/**
 * Per entry, unlike the Swift columns above (this one has no Swift counterpart to stay
 * byte-compatible with): an entry that does not decode is skipped, and the loader puts the panes
 * only it held into a recovered tab. One bad name must not cost every other tab its tree and
 * order. Null only when the column is absent or not an array.
 */
export function parseWorkspaceTabsJSON(text: string | null | undefined): WorkspaceTabRecord[] | null {
    const array = parseArrayJSON(text);
    if (array === null) return null;
    const result: WorkspaceTabRecord[] = [];
    for (const entry of array) {
        const tab = parseWorkspaceTabRecord(entry);
        if (tab !== null) result.push(tab);
    }
    return result;
}

export function encodeWorkspaceTabsJSON(tabs: readonly WorkspaceTabRecord[]): string {
    return JSON.stringify(
        tabs.map((tab) => ({
            id: normalizeUUIDLoose(tab.id),
            name: tab.name,
            layout: encodePaneLayout(tab.layout),
            focusedPaneID: tab.focusedPaneID === null ? null : normalizeUUIDLoose(tab.focusedPaneID),
            seen: tab.seen
        }))
    );
}
