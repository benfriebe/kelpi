/**
 * The six table renderers (cli.md port note 17): pane list, workspace list, group list,
 * workspace tabs, web tabs, web cookies. Humans read these, and scripts occasionally parse them with
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

/**
 * `ID  LABEL  TYPE  WORKSPACE  STATUS  SESSION  CWD`: ID is the FULL uuid (issue #240). A TAB
 * column follows WORKSPACE only when some pane's workspace has more than one tab
 * (workspace-feature.md §12): the tab's number, `*` on the tab on screen, `-` in a workspace
 * with one tab. The table is unchanged for everyone with one tab per workspace, and under
 * `--no-header` it never appears: a script reading fields by position must not see STATUS move
 * because someone pressed ⌥⌘T (`--json` carries `tab_number` for a script that wants it).
 */
export function printPaneTable(panes: readonly JsonObject[], noHeader: boolean, home: string): void {
    const tabbed = !noHeader && panes.some((entry) => asInt(entry['tab_number']) !== undefined);
    const rows = panes.map((entry) => {
        const session = asString(entry['agent_session_id']) ?? '';
        const type = asString(entry['type']) ?? '';
        const tab = asInt(entry['tab_number']);
        return [
            asString(entry['id']) ?? '',
            asString(entry['label']) ?? '-',
            type.length === 0 ? '-' : type,
            asString(entry['workspace_name']) ?? '',
            ...(tabbed ? [tab === undefined ? '-' : `${String(tab)}${asBool(entry['is_active_tab']) === true ? '*' : ''}`] : []),
            asString(entry['status']) ?? '',
            session.length === 0 ? '-' : shortUUID(session),
            collapseHome(asString(entry['working_directory']) ?? '', home)
        ];
    });
    const headers = ['ID', 'LABEL', 'TYPE', 'WORKSPACE', ...(tabbed ? ['TAB'] : []), 'STATUS', 'SESSION', 'CWD'];
    renderRows(headers, rows, noHeader, headers.length);
}

/** `3d`, `5h`, `12m`, `40s`: how long ago an ISO timestamp was, in its largest whole unit. */
export function ageLabel(iso: string | undefined, nowMs: number): string {
    const then = iso === undefined ? Number.NaN : Date.parse(iso);
    if (!Number.isFinite(then)) return '-';
    const seconds = Math.max(0, Math.floor((nowMs - then) / 1000));
    if (seconds < 60) return `${String(seconds)}s`;
    if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m`;
    if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))}h`;
    return `${String(Math.floor(seconds / 86_400))}d`;
}

/** `1.4G`, `512M`, `-` for none. */
export function memoryLabel(bytes: number | undefined): string {
    if (bytes === undefined) return '-';
    const mib = bytes / 1_048_576;
    if (mib >= 1024) return `${(mib / 1024).toFixed(1)}G`;
    return `${String(bytes === 0 ? 0 : Math.max(1, Math.round(mib)))}M`;
}

const PORTS_SHOWN = 4;

/**
 * Names and folders come from other programs (a compose project, a container's labels), so a
 * control character in one must not reach the terminal as an escape sequence.
 */
function printable(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/**
 * `kelpi ps`: `WORKSPACE  SERVICE  PORTS  UP  MEM  STARTED BY  NOTE`. NOTE is last, so it never
 * sets a width: the folder a service runs in when it is not its workspace's own, a deleted
 * folder, a port reachable from other machines.
 */
export function printServicesTable(services: readonly JsonObject[], noHeader: boolean, home: string, nowMs: number): void {
    const rows = services.map((entry) => {
        const category = asString(entry['category']);
        const workspace =
            asString(entry['workspace_name']) ??
            (category === 'unattached' ? '(no workspace)' : category === 'outside' ? '(outside Kelpi)' : '-');
        const ports = asObjectArray(entry['ports']);
        const shown = ports.slice(0, PORTS_SHOWN).map((port) => String(asInt(port['port']) ?? ''));
        const portText = ports.length === 0 ? '-' : `${shown.join(' ')}${ports.length > PORTS_SHOWN ? ` +${String(ports.length - PORTS_SHOWN)}` : ''}`;
        const agent = asString(entry['agent']);
        const startedBy = asString(entry['started_by']);
        const by =
            category === 'agent'
                ? 'agent'
                : agent !== undefined
                  ? agent
                  : startedBy === 'pane'
                    ? asBool(entry['foreground']) === true
                        ? 'pane (foreground)'
                        : 'pane'
                    : startedBy === 'compose'
                      ? 'compose'
                      : '-';
        const notes: string[] = [];
        const directory = asString(entry['directory']);
        const owner = asString(entry['workspace_id']);
        if (directory !== undefined && owner === undefined) {
            notes.push(`in ${collapseHome(directory, home)}${asBool(entry['directory_missing']) === true ? ' (deleted)' : ''}`);
        } else if (directory !== undefined && asString(entry['directory_workspace_id']) !== owner) {
            notes.push(`runs in ${collapseHome(directory, home)}`);
        }
        if (ports.some((port) => asBool(port['exposed']) === true)) notes.push('reachable on network');
        const cells = [
            clip(printable(workspace), 24),
            clip(printable(asString(entry['name']) ?? ''), 32),
            portText,
            ageLabel(asString(entry['started_at']), nowMs),
            memoryLabel(asInt(entry['rss_bytes'])),
            by
        ];
        // No NOTE: STARTED BY ends the row, unpadded, so the line has no trailing whitespace.
        return notes.length === 0 ? cells : [...cells, printable(notes.join('; '))];
    });
    renderRows(['WORKSPACE', 'SERVICE', 'PORTS', 'UP', 'MEM', 'STARTED BY', 'NOTE'], rows, noHeader, 6);
}

/**
 * `ID  NAME  GROUP  PANES  ACTIVE  LABELS`: LABELS is last, so it never sets a width. A PARENT
 * column follows GROUP only when some workspace is nested (app-state-core.md §2.9), and a TABS
 * column follows PANES only when some workspace has more than one tab (workspace-feature.md
 * §12), so the table is unchanged for everyone who never nests one or opens a second tab. TABS,
 * like TAB in `pane list`, is left out under `--no-header`, so a positional parser's columns
 * never change with the UI (`--json` has `tab_count`).
 */
export function printWorkspaceTable(workspaces: readonly JsonObject[], noHeader: boolean): void {
    const nesting = workspaces.some((entry) => asString(entry['parent_name']) !== undefined);
    const tabbed = !noHeader && workspaces.some((entry) => (asInt(entry['tab_count']) ?? 1) > 1);
    const rows = workspaces.map((entry) => {
        const labels = asStringArray(entry['labels']) ?? [];
        return [
            shortUUID(asString(entry['id']) ?? ''),
            asString(entry['name']) ?? '',
            asString(entry['group_name']) ?? '-',
            ...(nesting ? [asString(entry['parent_name']) ?? '-'] : []),
            String(asInt(entry['pane_count']) ?? 0),
            // A workspace with one tab carries no count (`tab_count` is elided).
            ...(tabbed ? [String(asInt(entry['tab_count']) ?? 1)] : []),
            asBool(entry['is_active']) === true ? '●' : '-',
            labels.length === 0 ? '-' : labels.join(',')
        ];
    });
    // Only the columns before LABELS participate in width computation (Swift parity).
    const headers = ['ID', 'NAME', 'GROUP', ...(nesting ? ['PARENT'] : []), 'PANES', ...(tabbed ? ['TABS'] : []), 'ACTIVE', 'LABELS'];
    renderRows(headers, rows, noHeader, headers.length - 1);
}

/**
 * `kelpi tab list` (workspace-feature.md §12): `TAB  ACTIVE  TITLE  PANES  STATUS  ID`, the
 * number first because it is what `kelpi tab select 2` and ⌥⌘2 take. ID is the FULL uuid and
 * last, so it never sets a width. With `--all` a WORKSPACE column leads.
 */
export function printWorkspaceTabTable(tabs: readonly JsonObject[], noHeader: boolean, withWorkspace: boolean): void {
    const rows = tabs.map((entry) => [
        ...(withWorkspace ? [asString(entry['workspace_name']) ?? ''] : []),
        String(asInt(entry['number']) ?? 0),
        asBool(entry['is_active']) === true ? '●' : '-',
        asString(entry['title']) ?? '',
        String(asInt(entry['pane_count']) ?? 0),
        asString(entry['status']) ?? '',
        asString(entry['id']) ?? ''
    ]);
    const headers = [...(withWorkspace ? ['WORKSPACE'] : []), 'TAB', 'ACTIVE', 'TITLE', 'PANES', 'STATUS', 'ID'];
    renderRows(headers, rows, noHeader, headers.length - 1);
}

/**
 * `ID  NAME  COLOR  REPO  WORKSPACES`: members render as `name (short-id)`. REPO is the
 * group's default repository by name (app-state-core.md §5.5), marked `+worktree` when new
 * workspaces create a worktree from latest main; `-` when it has none.
 */
export function printGroupTable(groups: readonly JsonObject[], noHeader: boolean): void {
    const rows = groups.map((entry) => {
        const members = asObjectArray(entry['workspaces']).map((member) => {
            const id = shortUUID(asString(member['id']) ?? '');
            const name = asString(member['name']) ?? '';
            const label = name.length === 0 ? id : `${name} (${id})`;
            // app-state-core.md §2.9: a member's nested workspace, listed right after its parent.
            const parent = asString(member['parent_name']);
            return parent === undefined ? label : `${label} under ${parent}`;
        });
        const memberText = members.join(', ');
        const repo = entry['repo'];
        const repoName =
            typeof repo === 'object' && repo !== null && !Array.isArray(repo) ? asString(repo['name']) : undefined;
        const repoText =
            repoName === undefined ? '-' : `${repoName}${asBool(entry['create_worktree']) === true ? ' +worktree' : ''}`;
        return [
            shortUUID(asString(entry['id']) ?? ''),
            asString(entry['name']) ?? '',
            asString(entry['color']) ?? '-',
            repoText,
            memberText.length === 0 ? '-' : memberText
        ];
    });
    renderRows(['ID', 'NAME', 'COLOR', 'REPO', 'WORKSPACES'], rows, noHeader, 4);
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
