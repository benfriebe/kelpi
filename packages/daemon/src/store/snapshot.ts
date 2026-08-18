/**
 * The persisted projection of `DaemonState` plus the boot-time reset.
 *
 * Specs: docs/current/persistence.md §2 (schema), §6 (load path), §7 (persisted vs transient);
 * docs/current/app-state-core.md §12.3 (stateLoaded); docs/current/workspace-feature.md §1.9.
 *
 * `PersistedSnapshot` is deliberately DB-agnostic: it is the exact set of fields that survive a
 * restart, in domain shapes. WP2.6 maps it onto the SQLite rows (JSON columns via
 * `@nex/core/codec`), so the transient-reset rules live here and only here.
 *
 * Division of labour on boot: `fromSnapshot` restores what the DB holds verbatim (statuses and
 * session ids included), and `applyLoadReset` performs the capture-then-clear step — resume
 * tuples first, then session ids nulled and non-idle statuses reset to idle.
 */

import { captureResumeTuple, resetPaneAgentStateOnLoad, type ResumeTuple } from '@nex/core/agent';
import { workspaceSidebarID, type IconRef, type SidebarID, type WebTab } from '@nex/core/codec';
import {
    DEFAULT_MARKDOWN_FONT_SIZE,
    type AgentKind,
    type Pane,
    type PaneLayout,
    type PaneStatus,
    type PaneType
} from '@nex/core/layout';
import type { WorkspaceColor } from '@nex/protocol';
import type {
    DaemonState,
    LabelPreset,
    Repo,
    RepoAssociation,
    WebPaneState,
    WorkspaceGroup,
    WorkspaceState
} from './types.js';

/** Bumped only when the snapshot shape itself changes (independent of DB migrations). */
export const PERSISTED_SNAPSHOT_VERSION = 1;

export interface PersistedPane {
    readonly id: string;
    readonly label: string | null;
    readonly type: PaneType;
    readonly workingDirectory: string;
    /** Epoch seconds. */
    readonly createdAt: number;
    /** Epoch seconds. */
    readonly lastActivityAt: number;
    readonly agentSessionID: string | null;
    readonly agentKind: AgentKind | null;
    /** Written, but reset to idle by `applyLoadReset` on the next boot. */
    readonly status: PaneStatus;
    readonly filePath: string | null;
    readonly scratchpadContent: string | null;
    /** null for non-web panes AND for private web panes (tabs are withheld). */
    readonly webTabs: readonly WebTab[] | null;
    readonly webActiveTabID: string | null;
    readonly webIsPrivate: boolean;
}

export interface PersistedWorkspace {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly color: WorkspaceColor;
    readonly icon: IconRef | null;
    readonly profileName: string | null;
    /** The un-zoomed tree (a zoomed workspace persists `savedLayout`). */
    readonly layout: PaneLayout;
    readonly focusedPaneID: string | null;
    /** Epoch seconds. */
    readonly createdAt: number;
    /** Epoch seconds. */
    readonly lastAccessedAt: number;
    readonly labels: readonly string[];
    /** Visible panes only — parked panes are transient. */
    readonly panes: readonly PersistedPane[];
    readonly repoAssociations: readonly RepoAssociation[];
}

export interface PersistedGroup {
    readonly id: string;
    readonly name: string;
    readonly color: WorkspaceColor | null;
    readonly isCollapsed: boolean;
    readonly childOrder: readonly string[];
    /** Epoch seconds. */
    readonly createdAt: number;
    readonly icon: IconRef | null;
}

export interface PersistedSnapshot {
    readonly version: number;
    /** Order = the `sortOrder` column. */
    readonly workspaces: readonly PersistedWorkspace[];
    readonly groups: readonly PersistedGroup[];
    readonly topLevelOrder: readonly SidebarID[];
    readonly activeWorkspaceID: string | null;
    readonly repos: readonly Repo[];
    /** Stored beside the DB in the current app (settings JSON); carried here for one save path. */
    readonly labelPresets: readonly LabelPreset[];
}

function persistPane(pane: Pane, sidecar: WebPaneState | undefined): PersistedPane {
    const isWeb = pane.type === 'web';
    const isPrivate = isWeb ? (sidecar?.isPrivate ?? false) : false;
    // Private web panes persist the flag but never the tabs (§2.2 / §7.1): a restored private
    // pane comes back blank but still private.
    const webTabs = isWeb && sidecar !== undefined && !isPrivate ? sidecar.tabs : null;
    return {
        id: pane.id,
        label: pane.label,
        type: pane.type,
        workingDirectory: pane.workingDirectory,
        createdAt: pane.createdAt,
        lastActivityAt: pane.lastActivityAt,
        agentSessionID: pane.agentSessionID,
        agentKind: pane.agentKind,
        status: pane.status,
        filePath: pane.filePath,
        scratchpadContent: pane.scratchpadContent,
        webTabs,
        webActiveTabID: webTabs === null ? null : (sidecar?.activeTabID ?? null),
        webIsPrivate: isPrivate
    };
}

function persistWorkspace(workspace: WorkspaceState): PersistedWorkspace {
    return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        color: workspace.color,
        icon: workspace.icon,
        profileName: workspace.profileName,
        layout: workspace.savedLayout ?? workspace.layout,
        focusedPaneID: workspace.focusedPaneID,
        createdAt: workspace.createdAt,
        lastAccessedAt: workspace.lastAccessedAt,
        labels: [...workspace.labels],
        panes: workspace.panes.map((pane) => persistPane(pane, workspace.webPanes[pane.id])),
        repoAssociations: workspace.repoAssociations.map((assoc) => ({ ...assoc }))
    };
}

/** Everything that survives a restart; everything else is dropped (§7.2). */
export function toSnapshot(state: DaemonState): PersistedSnapshot {
    return {
        version: PERSISTED_SNAPSHOT_VERSION,
        workspaces: state.workspaces.map(persistWorkspace),
        groups: state.groups.map((group) => ({
            id: group.id,
            name: group.name,
            color: group.color,
            isCollapsed: group.isCollapsed,
            childOrder: [...group.childOrder],
            createdAt: group.createdAt,
            icon: group.icon
        })),
        topLevelOrder: [...state.topLevelOrder],
        activeWorkspaceID: state.lastActiveWorkspaceID,
        repos: state.repos.map((repo) => ({ ...repo })),
        labelPresets: state.labelPresets.map((preset) => ({ ...preset }))
    };
}

function restorePane(record: PersistedPane): Pane {
    return {
        id: record.id,
        label: record.label,
        type: record.type,
        title: null,
        workingDirectory: record.workingDirectory,
        gitBranch: null,
        status: record.status,
        filePath: record.filePath,
        // Derived on load: scratchpads restore into edit mode, everything else in view mode.
        isEditing: record.type === 'scratchpad',
        externalEditorCommand: null,
        scratchpadContent: record.scratchpadContent,
        agentSessionID: record.agentSessionID,
        agentKind: record.agentKind,
        markdownFontSize: DEFAULT_MARKDOWN_FONT_SIZE,
        parkedSourcePaneID: null,
        agentStartedAt: null,
        backgroundTaskCount: 0,
        createdAt: record.createdAt,
        lastActivityAt: record.lastActivityAt
    };
}

function restoreWebPanes(panes: readonly PersistedPane[]): Record<string, WebPaneState> {
    const sidecars: Record<string, WebPaneState> = {};
    for (const record of panes) {
        if (record.type !== 'web') continue;
        const tabs = record.webTabs ?? [];
        const activeTabID =
            record.webActiveTabID !== null && tabs.some((tab) => tab.id === record.webActiveTabID)
                ? record.webActiveTabID
                : (tabs[0]?.id ?? null);
        sidecars[record.id] = { tabs, activeTabID, isPrivate: record.webIsPrivate };
    }
    return sidecars;
}

export interface FromSnapshotOptions {
    /** Default cwd for panes created afterwards; environment, never persisted. */
    readonly homeDirectory: string;
}

/**
 * Rebuild state from the DB. Transient fields take their defaults; persisted statuses and
 * session ids are restored VERBATIM — clearing them is `applyLoadReset`'s job, which runs after
 * the resume tuples are captured (§6.2 steps 4–5).
 */
export function fromSnapshot(
    snapshot: PersistedSnapshot,
    options: FromSnapshotOptions
): DaemonState {
    const workspaces: WorkspaceState[] = (snapshot.workspaces ?? []).map((record) => {
        const panes = (record.panes ?? []).map(restorePane);
        return {
            id: record.id,
            name: record.name,
            slug: record.slug,
            color: record.color,
            icon: record.icon,
            profileName: record.profileName,
            panes,
            parkedPanes: [],
            layout: record.layout,
            focusedPaneID: record.focusedPaneID,
            focusHistory: [],
            repoAssociations: record.repoAssociations ?? [],
            recentlyClosedPanes: [],
            webPanes: restoreWebPanes(record.panes ?? []),
            zoomedPaneID: null,
            savedLayout: null,
            searchingPaneID: null,
            searchNeedle: '',
            searchTotal: null,
            searchSelected: null,
            currentLayoutIndex: null,
            createdAt: record.createdAt,
            lastAccessedAt: record.lastAccessedAt,
            labels: record.labels ?? [],
            isSyncInputActive: false,
            syncInputExcluded: []
        } satisfies WorkspaceState;
    });

    const groups: WorkspaceGroup[] = (snapshot.groups ?? []).map((record) => ({
        id: record.id,
        name: record.name,
        color: record.color,
        isCollapsed: record.isCollapsed,
        childOrder: record.childOrder ?? [],
        createdAt: record.createdAt,
        icon: record.icon
    }));

    // Legacy synthesis: a DB predating groups has no top-level order (§2.1 / §6.2 step 3).
    const loadedOrder = snapshot.topLevelOrder ?? [];
    const topLevelOrder =
        loadedOrder.length > 0
            ? [...loadedOrder]
            : workspaces.map((workspace) => workspaceSidebarID(workspace.id));

    const activeID = snapshot.activeWorkspaceID;
    const lastActiveWorkspaceID =
        activeID !== null && activeID !== undefined && workspaces.some((w) => w.id === activeID)
            ? activeID
            : (workspaces[0]?.id ?? null);

    return {
        workspaces,
        groups,
        topLevelOrder,
        lastActiveWorkspaceID,
        repos: snapshot.repos ?? [],
        labelPresets: snapshot.labelPresets ?? [],
        homeDirectory: options.homeDirectory
    };
}

export interface LoadResetResult {
    readonly state: DaemonState;
    /** Captured BEFORE clearing; boot spawns PTYs, settles ~2 s, then types the resume. */
    readonly resumeTuples: readonly ResumeTuple[];
}

/**
 * Boot step: capture resume tuples from every pane holding a session id, then clear the id and
 * reset any non-idle status to idle (a status describes a live PTY, which never survives a
 * restart — a persisted `running` would falsely trip the quit dialog). `agentKind` is
 * deliberately preserved: it is a last-known display value and the tuples already captured it.
 */
export function applyLoadReset(state: DaemonState): LoadResetResult {
    const resumeTuples: ResumeTuple[] = [];
    let anyChanged = false;

    const resetLane = (panes: readonly Pane[]): readonly Pane[] => {
        let laneChanged = false;
        const next = panes.map((pane) => {
            const tuple = captureResumeTuple(pane.id, pane);
            if (tuple !== null) resumeTuples.push(tuple);
            const reset = resetPaneAgentStateOnLoad(pane);
            if (
                reset.status === pane.status &&
                reset.agentSessionID === pane.agentSessionID &&
                reset.agentStartedAt === pane.agentStartedAt &&
                reset.backgroundTaskCount === pane.backgroundTaskCount
            ) {
                return pane;
            }
            laneChanged = true;
            return { ...pane, ...reset };
        });
        if (!laneChanged) return panes;
        anyChanged = true;
        return next;
    };

    const workspaces = state.workspaces.map((workspace) => {
        const panes = resetLane(workspace.panes);
        const parkedPanes = resetLane(workspace.parkedPanes);
        if (panes === workspace.panes && parkedPanes === workspace.parkedPanes) return workspace;
        return { ...workspace, panes, parkedPanes };
    });

    return {
        state: anyChanged ? { ...state, workspaces } : state,
        resumeTuples
    };
}
