/**
 * Row ↔ domain mapping for `PersistedSnapshot`.
 *
 * Spec: docs/current/persistence.md §2 (columns), §3 (JSON encodings), §5.4 (save-side field
 * mapping), §6.1 (read + decode), §6.3 (slug backfill), §9 items 5–8 (graceful degradation).
 *
 * Every encoded column goes through `@nex/core/codec` — the Swift-compatible codecs — and
 * nothing here hand-rolls an encoding: layout JSON (`_0`-keyed), SidebarID JSON, labels /
 * childOrder / webTabs arrays, uppercase UUIDs, epoch-SECONDS timestamps, `system:`/`emoji:`
 * icon strings. Writing `Date.now()` into a timestamp column would corrupt it by 1000×, so the
 * branded `EpochSeconds` type is the only way a number reaches one.
 *
 * Load is deliberately tolerant and row-scoped: a row with an unparseable UUID is skipped, an
 * unknown enum falls back (color→blue, type→shell, status→idle, agentKind→null, icon→null),
 * undecodable JSON degrades to empty, an empty slug is regenerated, and an empty
 * `topLevelOrder` is synthesized from workspace order. Nothing here throws on bad data — the
 * only hard failure is the DB itself being unreadable, which `persistence.ts` turns into
 * `load() === null` (without deleting the file).
 */

import {
    decodeChildOrderJSON,
    decodeLabelsJSON,
    decodePaneLayoutJSON,
    decodeTopLevelOrderJSON,
    encodeChildOrderJSON,
    encodeLabelsJSON,
    encodePaneLayoutJSON,
    encodeTopLevelOrderJSON,
    encodeWebTabsJSON,
    epochSecondsFromUnixMillis,
    epochSecondsFromUnixSeconds,
    epochSecondsToColumn,
    formatIconString,
    looksLikeUnixMillis,
    newUUID,
    normalizeUUIDLoose,
    parseIconString,
    parseUUID,
    parseWebTabsJSON,
    tryParseJSON,
    workspaceSidebarID,
    type IconRef,
    type SidebarID,
    type WebTab
} from '@nex/core/codec';
import { normalizedAssignment } from '@nex/core/env';
import {
    AGENT_KINDS,
    PANE_STATUSES,
    PANE_TYPES,
    type AgentKind,
    type PaneStatus,
    type PaneType
} from '@nex/core/layout';
import { makeSlug } from '@nex/core/resolve';
import { parseWorkspaceColor, WORKSPACE_COLORS, type WorkspaceColor } from '@nex/protocol';

import type {
    LabelColor,
    LabelPreset,
    PersistedGroup,
    PersistedPane,
    PersistedSnapshot,
    PersistedWorkspace,
    Repo,
    RepoAssociation
} from '../store/index.js';
import { PERSISTED_SNAPSHOT_VERSION } from '../store/index.js';
import type { SqlRow } from './adapter.js';

// ---------------------------------------------------------------------------
// Row shapes (§8)
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly layoutJSON: string;
    readonly focusedPaneID: string | null;
    readonly createdAt: number;
    readonly lastAccessedAt: number;
    readonly sortOrder: number;
    readonly slug: string;
    readonly labelsJSON: string;
    readonly icon: string | null;
    readonly profileName: string | null;
}

export interface PaneRow {
    readonly id: string;
    readonly workspaceID: string;
    readonly label: string | null;
    readonly type: string;
    readonly workingDirectory: string;
    readonly createdAt: number;
    readonly lastActivityAt: number;
    readonly agentSessionID: string | null;
    readonly status: string;
    readonly filePath: string | null;
    readonly content: string | null;
    readonly webURL: string | null;
    readonly webTabsJSON: string | null;
    readonly webActiveTabID: string | null;
    readonly webIsPrivate: number | null;
    readonly agentKind: string | null;
}

export interface RepoRow {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly remoteURL: string | null;
    readonly lastAccessedAt: number;
    readonly isAutoDiscovered: number;
}

export interface RepoAssociationRow {
    readonly id: string;
    readonly workspaceID: string;
    readonly repoID: string;
    readonly worktreePath: string;
    readonly branchName: string | null;
    readonly isAutoDetected: number;
}

export interface WorkspaceGroupRow {
    readonly id: string;
    readonly name: string;
    readonly color: string | null;
    readonly isCollapsed: number;
    readonly childOrderJSON: string;
    readonly createdAt: number;
    readonly sortOrder: number;
    readonly icon: string | null;
}

export interface AppStateRow {
    readonly key: string;
    readonly value: string | null;
}

/**
 * `appState` keys. The first two are the Swift app's (§2.4); the rest are daemon-owned
 * singletons — the table is upsert-only and never cleared, so adding keys is forward- and
 * backward-compatible (an older reader ignores them, a newer one defaults them).
 */
export const APP_STATE_ACTIVE_WORKSPACE = 'activeWorkspaceID';
export const APP_STATE_TOP_LEVEL_ORDER = 'topLevelOrder';
/** Daemon-owned: the Mac app keeps label presets in UserDefaults, which the daemon has no access to. */
export const APP_STATE_LABEL_PRESETS = 'nexd.labelPresets';
/** Daemon-owned: `PersistedSnapshot.version`, independent of the DB migration ledger. */
export const APP_STATE_SNAPSHOT_VERSION = 'nexd.snapshotVersion';
/**
 * Daemon-owned, app-state-core.md §6.5 / §13: the one-shot legacy-label → preset marker. This
 * is the port's home for the Swift app's `settings.labelPresets.migrated` UserDefaults flag —
 * the same place the presets themselves live, because a daemon has no UserDefaults. A database
 * written before this key existed has NO row for it, which decodes as "never migrated".
 */
export const APP_STATE_LABEL_PRESETS_MIGRATED = 'nexd.labelPresetsMigrated';

// ---------------------------------------------------------------------------
// Column readers
// ---------------------------------------------------------------------------

function textColumn(row: SqlRow, key: string): string | null {
    const value = row[key];
    return typeof value === 'string' ? value : null;
}

function numberColumn(row: SqlRow, key: string): number | null {
    const value = row[key];
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return Number(value);
    return null;
}

/** SQLite BOOLEAN is an integer; NULL means "unset", which every caller reads as false. */
function boolColumn(row: SqlRow, key: string): boolean | null {
    const value = numberColumn(row, key);
    if (value === null) return null;
    return value !== 0;
}

/**
 * A DOUBLE timestamp column. Non-numeric / non-finite degrades to epoch 0 rather than failing
 * the row: the column is NOT NULL in the schema, so a bad value means a corrupted file, and
 * losing one timestamp beats losing the workspace. (Spec is silent here; §9.5's row-level
 * tolerance is the closest rule.)
 */
function timestampColumn(row: SqlRow, key: string): number {
    return numberColumn(row, key) ?? 0;
}

/** Empty strings are "absent" for optional text columns (the Swift app normalizes them away). */
function optionalText(row: SqlRow, key: string): string | null {
    const value = textColumn(row, key);
    return value === null || value.length === 0 ? null : value;
}

// ---------------------------------------------------------------------------
// Enum decoding (§9.6)
// ---------------------------------------------------------------------------

export const DEFAULT_WORKSPACE_COLOR: WorkspaceColor = 'blue';

/** Unknown / missing → blue (§2.1). */
export function decodeWorkspaceColor(raw: string | null): WorkspaceColor {
    return parseWorkspaceColor(raw ?? undefined) ?? DEFAULT_WORKSPACE_COLOR;
}

/** Group colors are nullable — an unknown raw value means "no tint" (§2.5). */
export function decodeGroupColor(raw: string | null): WorkspaceColor | null {
    return parseWorkspaceColor(raw ?? undefined) ?? null;
}

/** Unknown / missing → shell (§2.2). */
export function decodePaneType(raw: string | null): PaneType {
    return PANE_TYPES.find((value) => value === raw) ?? 'shell';
}

/** Unknown / missing → idle (§2.2). */
export function decodePaneStatus(raw: string | null): PaneStatus {
    return PANE_STATUSES.find((value) => value === raw) ?? 'idle';
}

/** Strict: an unknown string is null, not `claude` (§6.1). */
export function decodeAgentKind(raw: string | null): AgentKind | null {
    return AGENT_KINDS.find((value) => value === raw) ?? null;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Value for a DOUBLE timestamp column, in epoch SECONDS.
 *
 * The snapshot already carries seconds, so this is normally the identity — but a
 * millisecond-magnitude number here would silently corrupt the column by 1000× and break every
 * future read, so such a value is converted rather than written (defensive: the only way a
 * caller can produce one is a bug, and rejecting it would take down the whole save).
 */
export function toEpochSecondsColumn(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (looksLikeUnixMillis(value)) return epochSecondsToColumn(epochSecondsFromUnixMillis(value));
    return epochSecondsToColumn(epochSecondsFromUnixSeconds(value));
}

// ---------------------------------------------------------------------------
// Label presets (daemon-owned appState key)
// ---------------------------------------------------------------------------

function encodeLabelColor(color: LabelColor): unknown {
    return color.kind === 'named' ? { kind: 'named', color: color.color } : { kind: 'custom', hex: color.hex };
}

function decodeLabelColor(value: unknown): LabelColor | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const source = value as Record<string, unknown>;
    if (source['kind'] === 'named') {
        const color = WORKSPACE_COLORS.find((candidate) => candidate === source['color']);
        return color === undefined ? null : { kind: 'named', color };
    }
    if (source['kind'] === 'custom') {
        const hex = source['hex'];
        return typeof hex === 'string' ? { kind: 'custom', hex } : null;
    }
    return null;
}

export function encodeLabelPresetsJSON(presets: readonly LabelPreset[]): string {
    return JSON.stringify(
        presets.map((preset) => ({
            name: preset.name,
            color: encodeLabelColor(preset.color),
            textColor: preset.textColor === null ? null : encodeLabelColor(preset.textColor)
        }))
    );
}

/** Malformed entries are skipped; an undecodable blob degrades to `[]`. */
export function decodeLabelPresetsJSON(text: string | null): LabelPreset[] {
    if (text === null || text.length === 0) return [];
    const parsed = tryParseJSON(text);
    if (!parsed.ok || !Array.isArray(parsed.value)) return [];
    const presets: LabelPreset[] = [];
    for (const entry of parsed.value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
        const source = entry as Record<string, unknown>;
        const name = source['name'];
        if (typeof name !== 'string' || name.length === 0) continue;
        const color = decodeLabelColor(source['color']);
        if (color === null) continue;
        const textColor = source['textColor'] === null ? null : decodeLabelColor(source['textColor']);
        presets.push({ name, color, textColor });
    }
    return presets;
}

/**
 * A boolean `appState` singleton. Absent (a database written before the key existed), empty or
 * unrecognised all read as `false` — for a one-shot marker, "I cannot tell" must mean "not yet
 * done", because running an idempotent back-fill twice is cheap and skipping it is not.
 * `'1'`/`'true'`/`'yes'` (case-insensitive) are true; the writer only ever emits `'1'`/`'0'`.
 */
export function decodeAppStateFlag(text: string | null): boolean {
    if (text === null) return false;
    const value = text.trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}

// ---------------------------------------------------------------------------
// Encode: snapshot → rows (§5.3 / §5.4)
// ---------------------------------------------------------------------------

function iconColumn(icon: IconRef | null): string | null {
    return icon === null ? null : formatIconString(icon);
}

export function encodeWorkspaceRow(workspace: PersistedWorkspace, sortOrder: number): WorkspaceRow {
    const id = normalizeUUIDLoose(workspace.id);
    const slug = workspace.slug.length > 0 ? workspace.slug : makeSlug(workspace.name, id);
    return {
        id,
        name: workspace.name,
        color: workspace.color,
        layoutJSON: encodePaneLayoutJSON(workspace.layout),
        focusedPaneID: workspace.focusedPaneID === null ? null : normalizeUUIDLoose(workspace.focusedPaneID),
        createdAt: toEpochSecondsColumn(workspace.createdAt),
        lastAccessedAt: toEpochSecondsColumn(workspace.lastAccessedAt),
        sortOrder,
        slug,
        labelsJSON: encodeLabelsJSON(workspace.labels),
        icon: iconColumn(workspace.icon),
        // §2.1: "default" / empty never reach the DB — null IS the default-profile baseline.
        profileName: normalizedAssignment(workspace.profileName)
    };
}

/** The tab whose URL goes into the legacy `webURL` column: the active one, else the first. */
function activeWebTab(tabs: readonly WebTab[], activeTabID: string | null): WebTab | null {
    if (activeTabID !== null) {
        const match = tabs.find((tab) => tab.id === activeTabID || parseUUID(tab.id) === parseUUID(activeTabID));
        if (match !== undefined) return match;
    }
    return tabs[0] ?? null;
}

export function encodePaneRow(pane: PersistedPane, workspaceID: string): PaneRow {
    const isWeb = pane.type === 'web';
    const isPrivate = isWeb && pane.webIsPrivate;
    // Private web panes write NULL for every tab column: the flag survives, the contents do
    // not (§5.4 / §9.10). Non-web panes write NULL for all four.
    const tabs = isWeb && !isPrivate ? (pane.webTabs ?? []) : [];
    const active = activeWebTab(tabs, pane.webActiveTabID);
    return {
        id: normalizeUUIDLoose(pane.id),
        workspaceID: normalizeUUIDLoose(workspaceID),
        label: pane.label,
        type: pane.type,
        workingDirectory: pane.workingDirectory,
        createdAt: toEpochSecondsColumn(pane.createdAt),
        lastActivityAt: toEpochSecondsColumn(pane.lastActivityAt),
        agentSessionID: pane.agentSessionID,
        status: pane.status,
        filePath: pane.filePath,
        content: pane.scratchpadContent,
        webURL: active === null ? null : active.url,
        webTabsJSON: tabs.length === 0 ? null : encodeWebTabsJSON(tabs),
        webActiveTabID: active === null ? null : normalizeUUIDLoose(active.id),
        webIsPrivate: isWeb ? (isPrivate ? 1 : 0) : null,
        agentKind: pane.agentKind
    };
}

export function encodeRepoRow(repo: Repo): RepoRow {
    return {
        id: normalizeUUIDLoose(repo.id),
        path: repo.path,
        name: repo.name,
        remoteURL: repo.remoteURL,
        lastAccessedAt: toEpochSecondsColumn(repo.lastAccessedAt),
        isAutoDiscovered: repo.isAutoDiscovered ? 1 : 0
    };
}

export function encodeRepoAssociationRow(
    association: RepoAssociation,
    workspaceID: string
): RepoAssociationRow {
    return {
        id: normalizeUUIDLoose(association.id),
        workspaceID: normalizeUUIDLoose(workspaceID),
        repoID: normalizeUUIDLoose(association.repoID),
        worktreePath: association.worktreePath,
        branchName: association.branchName,
        isAutoDetected: association.isAutoDetected ? 1 : 0
    };
}

export function encodeGroupRow(group: PersistedGroup, sortOrder: number): WorkspaceGroupRow {
    return {
        id: normalizeUUIDLoose(group.id),
        name: group.name,
        color: group.color,
        isCollapsed: group.isCollapsed ? 1 : 0,
        childOrderJSON: encodeChildOrderJSON(group.childOrder),
        createdAt: toEpochSecondsColumn(group.createdAt),
        sortOrder,
        icon: iconColumn(group.icon)
    };
}

export function encodeAppStateRows(snapshot: PersistedSnapshot): AppStateRow[] {
    return [
        {
            key: APP_STATE_ACTIVE_WORKSPACE,
            value: snapshot.activeWorkspaceID === null ? null : normalizeUUIDLoose(snapshot.activeWorkspaceID)
        },
        { key: APP_STATE_TOP_LEVEL_ORDER, value: encodeTopLevelOrderJSON(snapshot.topLevelOrder) },
        { key: APP_STATE_LABEL_PRESETS, value: encodeLabelPresetsJSON(snapshot.labelPresets) },
        { key: APP_STATE_SNAPSHOT_VERSION, value: String(snapshot.version) },
        // '1' / '0' rather than 'true' / 'false': the column is TEXT and the decoder is
        // deliberately permissive, but the writer only ever emits one form.
        {
            key: APP_STATE_LABEL_PRESETS_MIGRATED,
            value: snapshot.labelPresetsMigrated === true ? '1' : '0'
        }
    ];
}

export interface SnapshotRows {
    readonly workspaces: readonly WorkspaceRow[];
    readonly panes: readonly PaneRow[];
    readonly repos: readonly RepoRow[];
    readonly repoAssociations: readonly RepoAssociationRow[];
    readonly groups: readonly WorkspaceGroupRow[];
    readonly appState: readonly AppStateRow[];
}

/**
 * The full row set of one save. `sortOrder` is the index in the snapshot's arrays (§5.3).
 *
 * Rows that SQLite would reject are dropped rather than allowed to abort the transaction — a
 * single bad row would otherwise take the whole save down and freeze persistence at the
 * previous snapshot *permanently* (every later save carries the same row). Dropped:
 *   - duplicate primary keys, first occurrence winning
 *   - duplicate `repo.path`, the schema's only value constraint (§9.4)
 *   - repo associations pointing at a repo that is not in the registry (FK violation)
 */
export function snapshotToRows(snapshot: PersistedSnapshot): SnapshotRows {
    const repos: RepoRow[] = [];
    const seenRepoIDs = new Set<string>();
    const seenRepoPaths = new Set<string>();
    for (const repo of snapshot.repos) {
        const row = encodeRepoRow(repo);
        if (seenRepoIDs.has(row.id) || seenRepoPaths.has(row.path)) continue;
        seenRepoIDs.add(row.id);
        seenRepoPaths.add(row.path);
        repos.push(row);
    }

    const workspaces: WorkspaceRow[] = [];
    const panes: PaneRow[] = [];
    const repoAssociations: RepoAssociationRow[] = [];
    const seenWorkspaces = new Set<string>();
    const seenPanes = new Set<string>();
    const seenAssociations = new Set<string>();

    for (const workspace of snapshot.workspaces) {
        const row = encodeWorkspaceRow(workspace, workspaces.length);
        if (seenWorkspaces.has(row.id)) continue;
        seenWorkspaces.add(row.id);
        workspaces.push(row);

        for (const pane of workspace.panes) {
            const paneRow = encodePaneRow(pane, row.id);
            if (seenPanes.has(paneRow.id)) continue;
            seenPanes.add(paneRow.id);
            panes.push(paneRow);
        }
        for (const association of workspace.repoAssociations) {
            const associationRow = encodeRepoAssociationRow(association, row.id);
            if (seenAssociations.has(associationRow.id)) continue;
            if (!seenRepoIDs.has(associationRow.repoID)) continue;
            seenAssociations.add(associationRow.id);
            repoAssociations.push(associationRow);
        }
    }

    const groups: WorkspaceGroupRow[] = [];
    const seenGroups = new Set<string>();
    for (const group of snapshot.groups) {
        const row = encodeGroupRow(group, groups.length);
        if (seenGroups.has(row.id)) continue;
        seenGroups.add(row.id);
        groups.push(row);
    }

    return { workspaces, panes, repos, repoAssociations, groups, appState: encodeAppStateRows(snapshot) };
}

// ---------------------------------------------------------------------------
// Decode: rows → snapshot (§6.1)
// ---------------------------------------------------------------------------

/** A workspace row minus its panes/associations, which are joined in `snapshotFromRows`. */
export interface DecodedWorkspaceScalars {
    readonly id: string;
    readonly sortOrder: number;
    readonly workspace: Omit<PersistedWorkspace, 'panes' | 'repoAssociations'>;
}

/** null = skip this row (unparseable id, §9.5). */
export function decodeWorkspaceRow(row: SqlRow): DecodedWorkspaceScalars | null {
    const id = parseUUID(textColumn(row, 'id'));
    if (id === null) return null;

    const name = textColumn(row, 'name') ?? '';
    const storedSlug = textColumn(row, 'slug') ?? '';
    return {
        id,
        sortOrder: numberColumn(row, 'sortOrder') ?? 0,
        workspace: {
            id,
            name,
            // §6.3: the v3 default is '' — regenerate rather than persisting an empty slug.
            slug: storedSlug.length > 0 ? storedSlug : makeSlug(name, id),
            color: decodeWorkspaceColor(textColumn(row, 'color')),
            icon: parseIconString(textColumn(row, 'icon')),
            // A hand-written "default" row means the same thing as NULL (§2.1).
            profileName: normalizedAssignment(optionalText(row, 'profileName')),
            layout: decodePaneLayoutJSON(textColumn(row, 'layoutJSON')),
            focusedPaneID: parseUUID(textColumn(row, 'focusedPaneID')),
            createdAt: timestampColumn(row, 'createdAt'),
            lastAccessedAt: timestampColumn(row, 'lastAccessedAt'),
            labels: decodeLabelsJSON(textColumn(row, 'labelsJSON'))
        }
    };
}

export interface DecodedPaneRow {
    readonly workspaceID: string;
    readonly pane: PersistedPane;
}

/**
 * Web sidecar reconstruction (§6.1):
 *   1. `webTabsJSON` decodes non-empty → use it,
 *   2. else non-empty `webURL` → one synthesized tab (pre-v13 rows),
 *   3. else no tabs (blank pane — also the restored form of a private pane).
 */
function decodeWebColumns(
    row: SqlRow,
    type: PaneType,
    newTabID: () => string
): Pick<PersistedPane, 'webTabs' | 'webActiveTabID' | 'webIsPrivate'> {
    if (type !== 'web') return { webTabs: null, webActiveTabID: null, webIsPrivate: false };

    const isPrivate = boolColumn(row, 'webIsPrivate') ?? false;
    if (isPrivate) return { webTabs: null, webActiveTabID: null, webIsPrivate: true };

    const decoded = parseWebTabsJSON(textColumn(row, 'webTabsJSON')) ?? [];
    let tabs: WebTab[] = decoded;
    if (tabs.length === 0) {
        const legacyURL = optionalText(row, 'webURL');
        if (legacyURL !== null) tabs = [{ id: newTabID(), url: legacyURL, title: '' }];
    }

    const storedActive = parseUUID(textColumn(row, 'webActiveTabID'));
    const activeTabID =
        storedActive !== null && tabs.some((tab) => tab.id === storedActive)
            ? storedActive
            : (tabs[0]?.id ?? null);

    return { webTabs: tabs, webActiveTabID: activeTabID, webIsPrivate: false };
}

export interface DecodePaneOptions {
    /** Injectable so tests get deterministic ids for pre-v13 `webURL` rows. */
    readonly newTabID?: (() => string) | undefined;
}

/** null = skip this row (unparseable pane id or workspace id, §9.5). */
export function decodePaneRow(row: SqlRow, options: DecodePaneOptions = {}): DecodedPaneRow | null {
    const id = parseUUID(textColumn(row, 'id'));
    if (id === null) return null;
    const workspaceID = parseUUID(textColumn(row, 'workspaceID'));
    if (workspaceID === null) return null;

    const type = decodePaneType(textColumn(row, 'type'));
    const web = decodeWebColumns(row, type, options.newTabID ?? (() => newUUID()));

    return {
        workspaceID,
        pane: {
            id,
            label: optionalText(row, 'label'),
            type,
            workingDirectory: textColumn(row, 'workingDirectory') ?? '',
            createdAt: timestampColumn(row, 'createdAt'),
            lastActivityAt: timestampColumn(row, 'lastActivityAt'),
            agentSessionID: optionalText(row, 'agentSessionID'),
            agentKind: decodeAgentKind(textColumn(row, 'agentKind')),
            status: decodePaneStatus(textColumn(row, 'status')),
            filePath: optionalText(row, 'filePath'),
            scratchpadContent: textColumn(row, 'content'),
            ...web
        }
    };
}

export function decodeRepoRow(row: SqlRow): Repo | null {
    const id = parseUUID(textColumn(row, 'id'));
    if (id === null) return null;
    return {
        id,
        path: textColumn(row, 'path') ?? '',
        name: textColumn(row, 'name') ?? '',
        remoteURL: optionalText(row, 'remoteURL'),
        lastAccessedAt: timestampColumn(row, 'lastAccessedAt'),
        isAutoDiscovered: boolColumn(row, 'isAutoDiscovered') ?? false
    };
}

export interface DecodedRepoAssociationRow {
    readonly workspaceID: string;
    readonly association: RepoAssociation;
}

/** null = skip (unparseable association id, workspace id or repo id, §6.1). */
export function decodeRepoAssociationRow(row: SqlRow): DecodedRepoAssociationRow | null {
    const id = parseUUID(textColumn(row, 'id'));
    if (id === null) return null;
    const workspaceID = parseUUID(textColumn(row, 'workspaceID'));
    if (workspaceID === null) return null;
    const repoID = parseUUID(textColumn(row, 'repoID'));
    if (repoID === null) return null;
    return {
        workspaceID,
        association: {
            id,
            repoID,
            worktreePath: textColumn(row, 'worktreePath') ?? '',
            branchName: optionalText(row, 'branchName'),
            isAutoDetected: boolColumn(row, 'isAutoDetected') ?? false
        }
    };
}

export interface DecodedGroupRow {
    readonly sortOrder: number;
    readonly group: PersistedGroup;
}

/** null = skip this row (unparseable id, §9.5). */
export function decodeGroupRow(row: SqlRow): DecodedGroupRow | null {
    const id = parseUUID(textColumn(row, 'id'));
    if (id === null) return null;
    return {
        sortOrder: numberColumn(row, 'sortOrder') ?? 0,
        group: {
            id,
            name: textColumn(row, 'name') ?? '',
            color: decodeGroupColor(textColumn(row, 'color')),
            isCollapsed: boolColumn(row, 'isCollapsed') ?? false,
            childOrder: decodeChildOrderJSON(textColumn(row, 'childOrderJSON')),
            createdAt: timestampColumn(row, 'createdAt'),
            icon: parseIconString(textColumn(row, 'icon'))
        }
    };
}

export interface LoadedRows {
    readonly workspaces: readonly SqlRow[];
    /** All pane rows, any order; grouped by `workspaceID`, preserving row order per workspace. */
    readonly panes: readonly SqlRow[];
    readonly repos: readonly SqlRow[];
    readonly repoAssociations: readonly SqlRow[];
    readonly groups: readonly SqlRow[];
    readonly appState: readonly SqlRow[];
}

function appStateMap(rows: readonly SqlRow[]): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const row of rows) {
        const key = textColumn(row, 'key');
        if (key === null) continue;
        map.set(key, textColumn(row, 'value'));
    }
    return map;
}

/**
 * Assemble a `PersistedSnapshot` from raw rows. Pure — every degradation rule is exercisable
 * without a database.
 */
export function snapshotFromRows(rows: LoadedRows, options: DecodePaneOptions = {}): PersistedSnapshot {
    const decodedWorkspaces = rows.workspaces
        .map((row) => decodeWorkspaceRow(row))
        .filter((entry): entry is DecodedWorkspaceScalars => entry !== null)
        .map((entry, index) => ({ entry, index }))
        // Load orders by sortOrder (§6.1); ties keep row order.
        .sort((a, b) => a.entry.sortOrder - b.entry.sortOrder || a.index - b.index)
        .map(({ entry }) => entry);

    const panesByWorkspace = new Map<string, PersistedPane[]>();
    for (const row of rows.panes) {
        const decoded = decodePaneRow(row, options);
        if (decoded === null) continue;
        const bucket = panesByWorkspace.get(decoded.workspaceID);
        if (bucket === undefined) panesByWorkspace.set(decoded.workspaceID, [decoded.pane]);
        else bucket.push(decoded.pane);
    }

    const associationsByWorkspace = new Map<string, RepoAssociation[]>();
    for (const row of rows.repoAssociations) {
        const decoded = decodeRepoAssociationRow(row);
        if (decoded === null) continue;
        const bucket = associationsByWorkspace.get(decoded.workspaceID);
        if (bucket === undefined) associationsByWorkspace.set(decoded.workspaceID, [decoded.association]);
        else bucket.push(decoded.association);
    }

    const workspaces: PersistedWorkspace[] = decodedWorkspaces.map(({ id, workspace }) => ({
        ...workspace,
        panes: panesByWorkspace.get(id) ?? [],
        repoAssociations: associationsByWorkspace.get(id) ?? []
    }));

    const groups: PersistedGroup[] = rows.groups
        .map((row) => decodeGroupRow(row))
        .filter((entry): entry is DecodedGroupRow => entry !== null)
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => a.entry.sortOrder - b.entry.sortOrder || a.index - b.index)
        .map(({ entry }) => entry.group);

    const repos: Repo[] = [];
    for (const row of rows.repos) {
        const repo = decodeRepoRow(row);
        if (repo !== null) repos.push(repo);
    }

    const state = appStateMap(rows.appState);
    const storedOrder = decodeTopLevelOrderJSON(state.get(APP_STATE_TOP_LEVEL_ORDER) ?? null);
    // §6.2 step 3: an empty order is a pre-groups DB — synthesize it from workspace order.
    const topLevelOrder: SidebarID[] =
        storedOrder.length > 0 ? storedOrder : workspaces.map((workspace) => workspaceSidebarID(workspace.id));

    const versionText = state.get(APP_STATE_SNAPSHOT_VERSION) ?? null;
    const parsedVersion = versionText === null ? Number.NaN : Number(versionText);
    const version = Number.isFinite(parsedVersion) ? parsedVersion : PERSISTED_SNAPSHOT_VERSION;

    return {
        version,
        workspaces,
        groups,
        topLevelOrder,
        activeWorkspaceID: parseUUID(state.get(APP_STATE_ACTIVE_WORKSPACE) ?? null),
        repos,
        labelPresets: decodeLabelPresetsJSON(state.get(APP_STATE_LABEL_PRESETS) ?? null),
        labelPresetsMigrated: decodeAppStateFlag(state.get(APP_STATE_LABEL_PRESETS_MIGRATED) ?? null)
    };
}
