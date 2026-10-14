/**
 * Reads over the store. Two rules:
 *
 *   1. **Reuse the daemon's derived helpers.** Sidebar order, the sync broadcast group and the
 *      agent summaries are already exact functions in `@kelpi/daemon/store` (`derived.ts`), and
 *      the client must show what the daemon would answer — so they are called, not re-derived.
 *   2. **Array/object results are memoized on the state they are derived from.** zustand v5
 *      subscribes through `useSyncExternalStore`, which loops forever if a selector mints a new
 *      reference on every call; caching per `DaemonState` identity makes these safe to use
 *      directly in components, since the mirror is replaced only when it actually changes.
 */

import {
    activeAgentCount,
    activeAgentSummary,
    chromeStatusSummary,
    groupByID,
    groupIDForWorkspace,
    layoutPaneOrder,
    paneAnywhere,
    sidebarWorkspaceOrder,
    syncedPaneIDs,
    visibleWorkspaceOrder,
    workspaceByID,
    type DaemonState,
    type Pane,
    type PaneLayout,
    type WorkspaceGroup,
    type WorkspaceState
} from '@kelpi/daemon/store';

import type { ConnectionStatus } from '../connection';
import type { KelpiState, Toast } from './store';

function memoOnState<T>(compute: (state: DaemonState) => T): (state: DaemonState) => T {
    const cache = new WeakMap<DaemonState, T>();
    return (state: DaemonState): T => {
        const hit = cache.get(state);
        if (hit !== undefined) return hit;
        const value = compute(state);
        cache.set(state, value);
        return value;
    };
}

// ── plumbing ────────────────────────────────────────────────────────────────────────

export function selectDaemonState(state: KelpiState): DaemonState {
    return state.daemon.state;
}

export function selectConnectionStatus(state: KelpiState): ConnectionStatus {
    return state.ui.connection;
}

export function selectIsReady(state: KelpiState): boolean {
    return state.ui.connection === 'connected' && state.daemon.hasSnapshot;
}

export function selectToasts(state: KelpiState): readonly Toast[] {
    return state.ui.toasts;
}

// ── sidebar ─────────────────────────────────────────────────────────────────────────

/** app-state-core.md §2.9: parent id → its live nested workspaces, in render order. */
export type NestedWorkspaces = ReadonlyMap<string, readonly WorkspaceState[]>;

export type SidebarEntry =
    | {
          readonly kind: 'workspace';
          readonly workspace: WorkspaceState;
          readonly nested?: NestedWorkspaces | undefined;
      }
    | {
          readonly kind: 'group';
          readonly group: WorkspaceGroup;
          readonly workspaces: readonly WorkspaceState[];
          readonly nested?: NestedWorkspaces | undefined;
      };

/** The `nested` map for these parents, or undefined when none of them has a live child. */
function nestedOf(
    parents: readonly WorkspaceState[],
    byID: ReadonlyMap<string, WorkspaceState>
): NestedWorkspaces | undefined {
    let nested: Map<string, readonly WorkspaceState[]> | undefined;
    for (const parent of parents) {
        // `?? []`: a hand-built mirror (or one predating §2.9) may carry no `childOrder`.
        const children = ((parent.childOrder as readonly string[] | undefined) ?? [])
            .map((id) => byID.get(id))
            .filter((workspace): workspace is WorkspaceState => workspace !== undefined);
        if (children.length === 0) continue;
        nested ??= new Map();
        nested.set(parent.id, children);
    }
    return nested;
}

const sidebarEntries = memoOnState((state): readonly SidebarEntry[] => {
    const byID = new Map(state.workspaces.map((workspace) => [workspace.id, workspace]));
    const entries: SidebarEntry[] = [];
    for (const entry of state.topLevelOrder) {
        if (entry.kind === 'workspace') {
            const workspace = byID.get(entry.id);
            if (workspace === undefined) continue;
            const nested = nestedOf([workspace], byID);
            entries.push(nested === undefined ? { kind: 'workspace', workspace } : { kind: 'workspace', workspace, nested });
            continue;
        }
        const group = groupByID(state, entry.id);
        if (group === null) continue;
        const workspaces = group.childOrder
            .map((id) => byID.get(id))
            .filter((workspace): workspace is WorkspaceState => workspace !== undefined);
        const nested = nestedOf(workspaces, byID);
        entries.push(
            nested === undefined ? { kind: 'group', group, workspaces } : { kind: 'group', group, workspaces, nested }
        );
    }
    return entries;
});

/** The sidebar's render tree: top-level workspaces and groups, in daemon order. */
export function selectSidebarEntries(state: KelpiState): readonly SidebarEntry[] {
    return sidebarEntries(state.daemon.state);
}

const visibleOrder = memoOnState((state) => visibleWorkspaceOrder(state));
const sidebarOrder = memoOnState((state) => sidebarWorkspaceOrder(state));

/** Sidebar order EXCLUDING collapsed groups' members — what ⌘1..9 indexes into (§2.2). */
export function selectVisibleWorkspaceIDs(state: KelpiState): readonly string[] {
    return visibleOrder(state.daemon.state);
}

/** Sidebar order INCLUDING collapsed groups' members (what `workspace list` walks). */
export function selectSidebarWorkspaceIDs(state: KelpiState): readonly string[] {
    return sidebarOrder(state.daemon.state);
}

const visibleWorkspaces = memoOnState((state): readonly WorkspaceState[] =>
    visibleWorkspaceOrder(state)
        .map((id) => workspaceByID(state, id))
        .filter((workspace): workspace is WorkspaceState => workspace !== null)
);

export function selectVisibleWorkspaces(state: KelpiState): readonly WorkspaceState[] {
    return visibleWorkspaces(state.daemon.state);
}

/**
 * §2.6: name OR any label, exactly the chrome's `workspaceMatchesFilter`. It also matched the
 * slug once, which the sidebar's own filter never did: a parent kept only because a child's
 * slug matched then rendered nothing at all.
 */
function matchesFilter(workspace: WorkspaceState, needle: string): boolean {
    if (workspace.name.toLowerCase().includes(needle)) return true;
    return workspace.labels.some((label) => label.toLowerCase().includes(needle));
}

/**
 * §2.9: the matching children of each parent, and the parents that must stay because they or a
 * child match. A parent kept only for its children still renders (the sidebar's filtered list
 * re-checks every row), so a matching child keeps the path to it.
 */
function filterNested(
    nested: NestedWorkspaces | undefined,
    needle: string
): { readonly nested: NestedWorkspaces | undefined; readonly parents: ReadonlySet<string> } {
    if (nested === undefined) return { nested: undefined, parents: new Set() };
    const kept = new Map<string, readonly WorkspaceState[]>();
    for (const [parentID, children] of nested) {
        const matching = children.filter((workspace) => matchesFilter(workspace, needle));
        if (matching.length > 0) kept.set(parentID, matching);
    }
    return { nested: kept.size === 0 ? undefined : kept, parents: new Set(kept.keys()) };
}

/**
 * Sidebar entries narrowed by the UI filter; a group survives if any member matches, and a
 * workspace survives if it or one of its nested workspaces matches (§2.9).
 */
export function selectFilteredSidebarEntries(state: KelpiState): readonly SidebarEntry[] {
    const needle = state.ui.sidebarFilter.trim().toLowerCase();
    const entries = selectSidebarEntries(state);
    if (needle.length === 0) return entries;
    const filtered: SidebarEntry[] = [];
    for (const entry of entries) {
        const { nested, parents } = filterNested(entry.nested, needle);
        if (entry.kind === 'workspace') {
            if (matchesFilter(entry.workspace, needle) || parents.has(entry.workspace.id)) {
                filtered.push(
                    nested === undefined
                        ? { kind: 'workspace', workspace: entry.workspace }
                        : { kind: 'workspace', workspace: entry.workspace, nested }
                );
            }
            continue;
        }
        const workspaces = entry.workspaces.filter(
            (workspace) => matchesFilter(workspace, needle) || parents.has(workspace.id)
        );
        if (workspaces.length > 0 || entry.group.name.toLowerCase().includes(needle)) {
            filtered.push(
                nested === undefined
                    ? { kind: 'group', group: entry.group, workspaces }
                    : { kind: 'group', group: entry.group, workspaces, nested }
            );
        }
    }
    return filtered;
}

export function selectGroupForWorkspace(state: KelpiState, workspaceID: string): WorkspaceGroup | null {
    const groupID = groupIDForWorkspace(state.daemon.state, workspaceID);
    return groupID === null ? null : groupByID(state.daemon.state, groupID);
}

// ── active workspace ────────────────────────────────────────────────────────────────

/** This client's active workspace, falling back to the daemon's persisted last-active. */
export function selectActiveWorkspaceID(state: KelpiState): string | null {
    return state.ui.activeWorkspaceID ?? state.daemon.state.lastActiveWorkspaceID;
}

export function selectActiveWorkspace(state: KelpiState): WorkspaceState | null {
    const id = selectActiveWorkspaceID(state);
    return id === null ? null : workspaceByID(state.daemon.state, id);
}

export function selectWorkspace(state: KelpiState, workspaceID: string): WorkspaceState | null {
    return workspaceByID(state.daemon.state, workspaceID);
}

export function selectActivePanes(state: KelpiState): readonly Pane[] {
    return selectActiveWorkspace(state)?.panes ?? EMPTY_PANES;
}

export function selectActiveLayout(state: KelpiState): PaneLayout | null {
    return selectActiveWorkspace(state)?.layout ?? null;
}

/** Layout-order pane ids of the active workspace (focus cycling, palette ordering). */
export function selectActivePaneOrder(state: KelpiState): readonly string[] {
    const workspace = selectActiveWorkspace(state);
    return workspace === null ? EMPTY_IDS : layoutPaneOrder(workspace);
}

/**
 * The focused pane as the UI should draw it: the local echo wins for the active workspace
 * (the daemon's confirmation is a round trip away), otherwise the mirrored value.
 */
export function selectFocusedPaneID(state: KelpiState): string | null {
    const workspace = selectActiveWorkspace(state);
    if (workspace === null) return null;
    const echo = state.ui.focusEcho;
    if (echo !== null && echo.workspaceID === workspace.id) return echo.paneID;
    return workspace.focusedPaneID;
}

export function selectPane(state: KelpiState, paneID: string): Pane | null {
    for (const workspace of state.daemon.state.workspaces) {
        const pane = paneAnywhere(workspace, paneID);
        if (pane !== null) return pane;
    }
    return null;
}

export function selectZoomedPaneID(state: KelpiState): string | null {
    return selectActiveWorkspace(state)?.zoomedPaneID ?? null;
}

/** The tmux-style broadcast group for a workspace (empty when sync is off / <2 shells). */
export function selectSyncedPaneIDs(state: KelpiState, workspaceID: string): readonly string[] {
    const workspace = workspaceByID(state.daemon.state, workspaceID);
    return workspace === null ? EMPTY_IDS : syncedPaneIDs(workspace);
}

// ── agent summaries ─────────────────────────────────────────────────────────────────

export interface AgentSummary {
    /** Visible panes, by status (the footer's right-hand counts, §9.4). */
    readonly running: number;
    /** Waiting panes in unmuted workspaces: the count that asks for attention. */
    readonly waiting: number;
    /** Waiting panes in muted workspaces (agent-lifecycle §7.6), counted apart. */
    readonly muted: number;
    /** Idle panes that still carry a session id — resumable but not attached. */
    readonly inactive: number;
    /** Non-idle panes INCLUDING parked ones (the quit/delete guards' count). */
    readonly agentCount: number;
    readonly workspaceCount: number;
}

const agentSummary = memoOnState((state): AgentSummary => {
    const chrome = chromeStatusSummary(state);
    const active = activeAgentSummary(state);
    return {
        running: chrome.running,
        waiting: chrome.waiting,
        muted: chrome.muted,
        inactive: chrome.inactive,
        agentCount: active.agentCount,
        workspaceCount: active.workspaceCount
    };
});

export function selectAgentSummary(state: KelpiState): AgentSummary {
    return agentSummary(state.daemon.state);
}

/** Non-idle panes in one workspace (the sidebar's agent dot). */
export function selectWorkspaceAgentCount(state: KelpiState, workspaceID: string): number {
    const workspace = workspaceByID(state.daemon.state, workspaceID);
    return workspace === null ? 0 : activeAgentCount(workspace);
}

const EMPTY_PANES: readonly Pane[] = [];
const EMPTY_IDS: readonly string[] = [];
