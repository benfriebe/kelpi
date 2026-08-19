/**
 * The five table renderers (cli.md port note 17): pane list, workspace list, group list,
 * web tabs, web cookies. Humans read these, and scripts occasionally parse them with
 * `--no-header`, so column order, the `first8…last4` short id, the `-` placeholders, the `●`
 * active marker and the unpadded last column are all contract.
 *
 * Widths are counted in code points (`[...s].length`), the closest JS equivalent of Swift's
 * grapheme-cluster `String.count`; that keeps `●` and `…` one column wide.
 */

import { asArray, asBool, asInt, asObjectArray, asString, asStringArray, type JsonObject } from './json.js';
import { printLine } from './io.js';

function width(value: string): number {
    return [...value].length;
}

function pad(value: string, target: number): string {
    const size = width(value);
    return size >= target ? value : value + ' '.repeat(target - size);
}

function clip(value: string, limit: number): string {
    const chars = [...value];
    return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : value;
}

/** `first8…last4`, only when there is enough to shorten. */
export function shortUUID(value: string): string {
    const chars = [...value];
    if (chars.length < 12) return value;
    return `${chars.slice(0, 8).join('')}…${chars.slice(-4).join('')}`;
}

/** `$HOME`-prefixed paths render as `~/…`. */
export function collapseHome(cwd: string, home: string): string {
    if (home.length > 0 && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
    return cwd;
}

function renderRows(headers: readonly string[], rows: readonly (readonly string[])[], noHeader: boolean, measured: number): void {
    const widths = headers.map((header) => (noHeader ? 0 : width(header)));
    for (const row of rows) {
        for (let index = 0; index < measured; index += 1) {
            widths[index] = Math.max(widths[index] ?? 0, width(row[index] ?? ''));
        }
    }
    const line = (cells: readonly string[]): string => {
        const parts: string[] = [];
        for (let index = 0; index < cells.length; index += 1) {
            const cell = cells[index] ?? '';
            // The last column is never padded, so no row ends in trailing whitespace.
            parts.push(index === cells.length - 1 ? cell : pad(cell, widths[index] ?? 0));
        }
        return parts.join('  ');
    };
    if (!noHeader) printLine(line(headers));
    for (const row of rows) printLine(line(row));
}

/** `ID  LABEL  TYPE  WORKSPACE  STATUS  SESSION  CWD` — ID is the FULL uuid (issue #240). */
export function printPaneTable(panes: readonly JsonObject[], noHeader: boolean, home: string): void {
    const rows = panes.map((entry) => {
        const session = asString(entry['agent_session_id']) ?? '';
        const type = asString(entry['type']) ?? '';
        return [
            asString(entry['id']) ?? '',
            asString(entry['label']) ?? '-',
            type.length === 0 ? '-' : type,
            asString(entry['workspace_name']) ?? '',
            asString(entry['status']) ?? '',
            session.length === 0 ? '-' : shortUUID(session),
            collapseHome(asString(entry['working_directory']) ?? '', home)
        ];
    });
    renderRows(['ID', 'LABEL', 'TYPE', 'WORKSPACE', 'STATUS', 'SESSION', 'CWD'], rows, noHeader, 7);
}

/** `ID  NAME  GROUP  PANES  ACTIVE  LABELS` — LABELS is last, so it never sets a width. */
export function printWorkspaceTable(workspaces: readonly JsonObject[], noHeader: boolean): void {
    const rows = workspaces.map((entry) => {
        const labels = asStringArray(entry['labels']) ?? [];
        return [
            shortUUID(asString(entry['id']) ?? ''),
            asString(entry['name']) ?? '',
            asString(entry['group_name']) ?? '-',
            String(asInt(entry['pane_count']) ?? 0),
            asBool(entry['is_active']) === true ? '●' : '-',
            labels.length === 0 ? '-' : labels.join(',')
        ];
    });
    // Only the first five columns participate in width computation (Swift parity).
    renderRows(['ID', 'NAME', 'GROUP', 'PANES', 'ACTIVE', 'LABELS'], rows, noHeader, 5);
}

/** `ID  NAME  COLOR  WORKSPACES` — members render as `name (short-id)`. */
export function printGroupTable(groups: readonly JsonObject[], noHeader: boolean): void {
    const rows = groups.map((entry) => {
        const members = asObjectArray(entry['workspaces']).map((member) => {
            const id = shortUUID(asString(member['id']) ?? '');
            const name = asString(member['name']) ?? '';
            return name.length === 0 ? id : `${name} (${id})`;
        });
        const memberText = members.join(', ');
        return [
            shortUUID(asString(entry['id']) ?? ''),
            asString(entry['name']) ?? '',
            asString(entry['color']) ?? '-',
            memberText.length === 0 ? '-' : memberText
        ];
    });
    renderRows(['ID', 'NAME', 'COLOR', 'WORKSPACES'], rows, noHeader, 3);
}

/** `IDX  A  TITLE  URL` — fixed widths (not data-driven), `*` marks the active tab. */
export function printTabsTable(tabs: readonly JsonObject[], noHeader: boolean): void {
    if (!noHeader) printLine('IDX  A  TITLE                    URL');
    for (const tab of tabs) {
        const index = asInt(tab['index']) ?? 0;
        const active = asBool(tab['active']) === true ? '*' : ' ';
        const title = clip(asString(tab['title']) ?? '', 24);
        const url = asString(tab['url']) ?? '';
        printLine(`${pad(String(index), 3)}  ${active}  ${pad(title, 24)}  ${url}`);
    }
}

/** `DOMAIN  NAME  VALUE`, sorted by (domain, name), each field clipped. */
export function printCookiesTable(cookies: readonly JsonObject[]): void {
    printLine('DOMAIN                     NAME                 VALUE');
    const sorted = [...cookies].sort((left, right) => {
        const leftDomain = asString(left['domain']) ?? '';
        const rightDomain = asString(right['domain']) ?? '';
        if (leftDomain !== rightDomain) return leftDomain < rightDomain ? -1 : 1;
        const leftName = asString(left['name']) ?? '';
        const rightName = asString(right['name']) ?? '';
        if (leftName === rightName) return 0;
        return leftName < rightName ? -1 : 1;
    });
    for (const cookie of sorted) {
        const domain = clip(asString(cookie['domain']) ?? '', 24);
        const name = clip(asString(cookie['name']) ?? '', 20);
        const value = clip(asString(cookie['value']) ?? '', 40);
        printLine(`${pad(domain, 26)}  ${pad(name, 20)}  ${value}`);
    }
}

/** Shared by the list verbs: the array under `key`, element-wise cast. */
export function replyArray(reply: JsonObject, key: string): JsonObject[] {
    return asObjectArray(asArray(reply[key]) ?? []);
}
