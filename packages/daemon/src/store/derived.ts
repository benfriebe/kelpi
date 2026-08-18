/**
 * Derived reads over `DaemonState` — no mutation, no IO.
 *
 * Specs: docs/current/app-state-core.md §2.2 (visibleWorkspaceOrder), §9.4 (summaries),
 * §15 (resolution helpers); docs/current/workspace-feature.md §1.10 (syncedPaneIDs,
 * activeAgentCount), §3.6 (pane lookup across lanes).
 */

import { isActiveAgentStatus } from '@nex/core/agent';
import type { ResolveState } from '@nex/core/resolve';
import { allPaneIDs, type Pane } from '@nex/core/layout';
import { WORKSPACE_COLORS, type WorkspaceColor } from '@nex/protocol';
import type { DaemonState, PaneLane, WorkspaceGroup, WorkspaceState } from './types.js';

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function workspaceByID(state: DaemonState, id: string): WorkspaceState | null {
    return state.workspaces.find((workspace) => workspace.id === id) ?? null;
}

export function groupByID(state: DaemonState, id: string): WorkspaceGroup | null {
    return state.groups.find((group) => group.id === id) ?? null;
}

/** Visible lane only — the lane user commands (send/split/close/…) address. */
export function visiblePane(workspace: WorkspaceState, paneID: string): Pane | null {
    return workspace.panes.find((pane) => pane.id === paneID) ?? null;
}

/** Visible pane first, else parked (§3.6): lifecycle events reach both lanes. */
export function paneAnywhere(workspace: WorkspaceState, paneID: string): Pane | null {
    return visiblePane(workspace, paneID) ?? workspace.parkedPanes.find((p) => p.id === paneID) ?? null;
}

export interface PaneLocation {
    readonly workspaceID: string;
    readonly lane: PaneLane;
    readonly index: number;
    readonly pane: Pane;
}

/** paneID -> location, both lanes. Rebuild per read; state is small and this stays honest. */
export function buildPaneIndex(state: DaemonState): Map<string, PaneLocation> {
    const index = new Map<string, PaneLocation>();
    for (const workspace of state.workspaces) {
        workspace.panes.forEach((pane, i) => {
            index.set(pane.id, { workspaceID: workspace.id, lane: 'visible', index: i, pane });
        });
        workspace.parkedPanes.forEach((pane, i) => {
            index.set(pane.id, { workspaceID: workspace.id, lane: 'parked', index: i, pane });
        });
    }
    return index;
}

export function findPaneAnywhere(state: DaemonState, paneID: string): PaneLocation | null {
    for (const workspace of state.workspaces) {
        const visibleIndex = workspace.panes.findIndex((pane) => pane.id === paneID);
        if (visibleIndex >= 0) {
            const pane = workspace.panes[visibleIndex] as Pane;
            return { workspaceID: workspace.id, lane: 'visible', index: visibleIndex, pane };
        }
        const parkedIndex = workspace.parkedPanes.findIndex((pane) => pane.id === paneID);
        if (parkedIndex >= 0) {
            const pane = workspace.parkedPanes[parkedIndex] as Pane;
            return { workspaceID: workspace.id, lane: 'parked', index: parkedIndex, pane };
        }
    }
    return null;
}

/** Lifecycle routing (§15.3): searches visible AND parked panes. */
export function workspaceContainingPane(state: DaemonState, paneID: string): WorkspaceState | null {
    const location = findPaneAnywhere(state, paneID);
    return location === null ? null : workspaceByID(state, location.workspaceID);
}

/** User-command routing: visible lane only. */
export function workspaceContainingVisiblePane(
    state: DaemonState,
    paneID: string
): WorkspaceState | null {
    return state.workspaces.find((w) => w.panes.some((pane) => pane.id === paneID)) ?? null;
}

/** The projection @nex/core/resolve consumes (parked panes flagged, never addressable). */
export function resolveStateOf(state: DaemonState): ResolveState {
    const panes: ResolveState['panes'] = state.workspaces.flatMap((workspace) => [
        ...workspace.panes.map((pane) => ({
            id: pane.id,
            label: pane.label,
            workspaceID: workspace.id
        })),
        ...workspace.parkedPanes.map((pane) => ({
            id: pane.id,
            label: pane.label,
            workspaceID: workspace.id,
            parked: true
        }))
    ]);
    return {
        workspaces: state.workspaces.map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
            slug: workspace.slug
        })),
        panes,
        groups: state.groups.map((group) => ({ id: group.id, name: group.name }))
    };
}

// ---------------------------------------------------------------------------
// Sidebar order
// ---------------------------------------------------------------------------

/**
 * Workspaces the user can actually see, in render order (§2.2). Members of a COLLAPSED group
 * are excluded (the CLI `workspace list` deliberately differs and lists them).
 */
export function visibleWorkspaceOrder(state: DaemonState): string[] {
    const known = new Set(state.workspaces.map((workspace) => workspace.id));
    const result: string[] = [];
    for (const entry of state.topLevelOrder) {
        if (entry.kind === 'workspace') {
            if (known.has(entry.id)) result.push(entry.id);
            continue;
        }
        const group = groupByID(state, entry.id);
        if (group === null || group.isCollapsed) continue;
        for (const childID of group.childOrder) {
            if (known.has(childID)) result.push(childID);
        }
    }
    return result;
}

/** Sidebar order including collapsed group members — what `workspace list` walks. */
export function sidebarWorkspaceOrder(state: DaemonState): string[] {
    const known = new Set(state.workspaces.map((workspace) => workspace.id));
    const result: string[] = [];
    for (const entry of state.topLevelOrder) {
        if (entry.kind === 'workspace') {
            if (known.has(entry.id)) result.push(entry.id);
            continue;
        }
        const group = groupByID(state, entry.id);
        if (group === null) continue;
        for (const childID of group.childOrder) {
            if (known.has(childID)) result.push(childID);
        }
    }
    return result;
}

/** The group a workspace belongs to, or null when it lives at top level (§2.4). */
export function groupIDForWorkspace(state: DaemonState, workspaceID: string): string | null {
    return state.groups.find((group) => group.childOrder.includes(workspaceID))?.id ?? null;
}

// ---------------------------------------------------------------------------
// Sync input
// ---------------------------------------------------------------------------

/**
 * The broadcast group RIGHT NOW (§1.10): shell panes only, minus the excluded set, and only
 * when at least two qualify (a lone terminal must never "sync" to itself). Non-shell panes are
 * excluded even when they host a terminal surface (markdown in $EDITOR mode).
 */
export function syncedPaneIDs(workspace: WorkspaceState): string[] {
    if (!workspace.isSyncInputActive) return [];
    const excluded = new Set(workspace.syncInputExcluded);
    const candidates = workspace.panes
        .filter((pane) => pane.type === 'shell' && !excluded.has(pane.id))
        .map((pane) => pane.id);
    return candidates.length >= 2 ? candidates : [];
}

export function syncedPaneIDSet(workspace: WorkspaceState): Set<string> {
    return new Set(syncedPaneIDs(workspace));
}

// ---------------------------------------------------------------------------
// Agent summaries (delete / quit guards)
// ---------------------------------------------------------------------------

/** Panes (visible AND parked) whose status is not idle (§1.10). */
export function activeAgentCount(workspace: WorkspaceState): number {
    return [...workspace.panes, ...workspace.parkedPanes].filter((pane) =>
        isActiveAgentStatus(pane.status)
    ).length;
}

export interface ActiveAgentSummary {
    readonly agentCount: number;
    readonly workspaceCount: number;
}

/** Quit-dialog / bulk-guard summary (§9.4): parked panes included. */
export function activeAgentSummary(state: DaemonState): ActiveAgentSummary {
    let agentCount = 0;
    let workspaceCount = 0;
    for (const workspace of state.workspaces) {
        const count = activeAgentCount(workspace);
        if (count > 0) {
            agentCount += count;
            workspaceCount += 1;
        }
    }
    return { agentCount, workspaceCount };
}

export interface ChromeStatusSummary {
    readonly running: number;
    readonly waiting: number;
    /** Idle panes that still carry a session id — a resumable-but-idle agent. */
    readonly inactive: number;
}

/** Status-footer counts over VISIBLE panes only (§9.4). */
export function chromeStatusSummary(state: DaemonState): ChromeStatusSummary {
    let running = 0;
    let waiting = 0;
    let inactive = 0;
    for (const workspace of state.workspaces) {
        for (const pane of workspace.panes) {
            if (pane.status === 'running') running += 1;
            else if (pane.status === 'waitingForInput') waiting += 1;
            else if (pane.agentSessionID !== null) inactive += 1;
        }
    }
    return { running, waiting, inactive };
}

/** Pane ids in layout order (focus cycling, command palette, predefined rebuilds). */
export function layoutPaneOrder(workspace: WorkspaceState): string[] {
    return allPaneIDs(workspace.layout);
}

/**
 * A uniformly random color excluding the trailing workspace's, so an appended workspace is
 * visually distinct from its sidebar neighbour (§1.3). Randomness is injected so handlers stay
 * testable; the reducers never call this (color arrives on the action).
 */
export function nextRandomColor(
    state: DaemonState,
    random: () => number = Math.random
): WorkspaceColor {
    const last = state.workspaces[state.workspaces.length - 1]?.color;
    const pool = WORKSPACE_COLORS.filter((color) => color !== last);
    if (pool.length === 0) return 'blue';
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] ?? 'blue';
}
