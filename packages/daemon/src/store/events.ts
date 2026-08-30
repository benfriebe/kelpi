/**
 * Mutation → delta events, and the inverse (replay onto a mirror).
 *
 * The store derives events by diffing the pre/post state with entity-scoped ownership, so an
 * event batch is a complete description of the dispatch: replaying it onto a mirror copy of the
 * previous state produces exactly the new state (see `events.test.ts`). That property is the
 * foundation of the WS state sync (WP2.7): snapshot once, then stream batches.
 *
 * Ownership (disjoint, so a field is never described by two event kinds):
 *   workspace-upserted → workspace meta (name/slug/color/icon/profile/labels/repoAssociations/
 *                        recentlyClosed/webPanes/search/timestamps)
 *   layout-changed     → layout + zoomedPaneID + savedLayout + currentLayoutIndex
 *   focus-changed      → focusedPaneID + focusHistory
 *   sync-changed       → isSyncInputActive + syncInputExcluded (+ derived syncedPaneIDs)
 *   pane-upserted/-removed → the two pane lanes and their order
 *   group upserts+removals, order-changed, active-workspace-changed, label-presets-changed,
 *   repos-changed → the app level
 *
 * `agent-status-changed` is the one deliberately REDUNDANT event: it restates fields already
 * carried by `pane-upserted` so notification/indicator consumers can subscribe narrowly.
 */

import type { Pane } from '@kelpi/core/layout';
import { syncedPaneIDs } from './derived.js';
import type {
    DaemonState,
    DomainEvent,
    PaneLane,
    WorkspaceEnvelope,
    WorkspaceGroup,
    WorkspaceState
} from './types.js';

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function envelopeOf(workspace: WorkspaceState): WorkspaceEnvelope {
    return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        color: workspace.color,
        icon: workspace.icon,
        profileName: workspace.profileName,
        repoAssociations: workspace.repoAssociations,
        recentlyClosedPanes: workspace.recentlyClosedPanes,
        webPanes: workspace.webPanes,
        searchingPaneID: workspace.searchingPaneID,
        searchNeedle: workspace.searchNeedle,
        searchTotal: workspace.searchTotal,
        searchSelected: workspace.searchSelected,
        createdAt: workspace.createdAt,
        lastAccessedAt: workspace.lastAccessedAt,
        labels: workspace.labels
    };
}

function envelopeChanged(before: WorkspaceState, after: WorkspaceState): boolean {
    return (
        before.name !== after.name ||
        before.slug !== after.slug ||
        before.color !== after.color ||
        before.icon !== after.icon ||
        before.profileName !== after.profileName ||
        before.repoAssociations !== after.repoAssociations ||
        before.recentlyClosedPanes !== after.recentlyClosedPanes ||
        before.webPanes !== after.webPanes ||
        before.searchingPaneID !== after.searchingPaneID ||
        before.searchNeedle !== after.searchNeedle ||
        before.searchTotal !== after.searchTotal ||
        before.searchSelected !== after.searchSelected ||
        before.createdAt !== after.createdAt ||
        before.lastAccessedAt !== after.lastAccessedAt ||
        before.labels !== after.labels
    );
}

function layoutChanged(before: WorkspaceState, after: WorkspaceState): boolean {
    return (
        before.layout !== after.layout ||
        before.zoomedPaneID !== after.zoomedPaneID ||
        before.savedLayout !== after.savedLayout ||
        before.currentLayoutIndex !== after.currentLayoutIndex
    );
}

function focusChanged(before: WorkspaceState, after: WorkspaceState): boolean {
    return (
        before.focusedPaneID !== after.focusedPaneID || before.focusHistory !== after.focusHistory
    );
}

function shellPaneIDs(workspace: WorkspaceState): string[] {
    return workspace.panes.filter((pane) => pane.type === 'shell').map((pane) => pane.id);
}

function syncChanged(before: WorkspaceState, after: WorkspaceState): boolean {
    if (before.isSyncInputActive !== after.isSyncInputActive) return true;
    if (before.syncInputExcluded !== after.syncInputExcluded) return true;
    // §7.15 automatic refresh: while sync is active, the derived group also changes when the
    // shell-pane set does (new panes join, closed panes drop, the ">= 2" rule can collapse it).
    if (!after.isSyncInputActive) return false;
    return !idsEqual(shellPaneIDs(before), shellPaneIDs(after));
}

function layoutEvent(workspace: WorkspaceState): DomainEvent {
    return {
        kind: 'layout-changed',
        workspaceID: workspace.id,
        layout: workspace.layout,
        zoomedPaneID: workspace.zoomedPaneID,
        savedLayout: workspace.savedLayout,
        currentLayoutIndex: workspace.currentLayoutIndex
    };
}

function focusEvent(workspace: WorkspaceState): DomainEvent {
    return {
        kind: 'focus-changed',
        workspaceID: workspace.id,
        focusedPaneID: workspace.focusedPaneID,
        focusHistory: workspace.focusHistory
    };
}

function syncEvent(workspace: WorkspaceState): DomainEvent {
    return {
        kind: 'sync-changed',
        workspaceID: workspace.id,
        isSyncInputActive: workspace.isSyncInputActive,
        syncInputExcluded: workspace.syncInputExcluded,
        syncedPaneIDs: syncedPaneIDs(workspace)
    };
}

function agentEvent(workspaceID: string, pane: Pane): DomainEvent {
    return {
        kind: 'agent-status-changed',
        workspaceID,
        paneID: pane.id,
        status: pane.status,
        agentSessionID: pane.agentSessionID,
        agentKind: pane.agentKind,
        agentStartedAt: pane.agentStartedAt,
        backgroundTaskCount: pane.backgroundTaskCount
    };
}

function agentFieldsChanged(before: Pane, after: Pane): boolean {
    return (
        before.status !== after.status ||
        before.agentSessionID !== after.agentSessionID ||
        before.agentKind !== after.agentKind ||
        before.agentStartedAt !== after.agentStartedAt ||
        before.backgroundTaskCount !== after.backgroundTaskCount
    );
}

interface PaneSlot {
    readonly lane: PaneLane;
    readonly index: number;
    readonly pane: Pane;
}

function paneSlots(workspace: WorkspaceState): Map<string, PaneSlot> {
    const slots = new Map<string, PaneSlot>();
    workspace.panes.forEach((pane, index) => slots.set(pane.id, { lane: 'visible', index, pane }));
    workspace.parkedPanes.forEach((pane, index) =>
        slots.set(pane.id, { lane: 'parked', index, pane })
    );
    return slots;
}

function idsEqual(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Pane diff for one workspace. Removals are emitted BEFORE upserts so a mirror that splices by
 * index converges (an upsert index always refers to the post-removal array).
 */
function diffPanes(
    before: WorkspaceState | null,
    after: WorkspaceState,
    into: DomainEvent[]
): void {
    const previous = before === null ? new Map<string, PaneSlot>() : paneSlots(before);
    const surviving = new Set<string>([
        ...after.panes.map((pane) => pane.id),
        ...after.parkedPanes.map((pane) => pane.id)
    ]);

    for (const [paneID] of previous) {
        if (!surviving.has(paneID)) {
            into.push({ kind: 'pane-removed', workspaceID: after.id, paneID });
        }
    }

    // Panes that changed LANE are emitted before the rest: a mirror inserts by index, so the
    // departing pane has to leave its old lane before the remaining indices make sense.
    const laneMoves: DomainEvent[] = [];
    const upserts: DomainEvent[] = [];
    const agentEvents: DomainEvent[] = [];
    const emitLane = (lane: PaneLane, panes: readonly Pane[]): void => {
        // Order is "stable" when the panes that stayed in this lane keep their relative order;
        // then only genuinely changed panes need an event and index churn stays off the wire.
        const laneIDs = new Set(panes.map((pane) => pane.id));
        const survivorsBefore =
            before === null
                ? []
                : (lane === 'visible' ? before.panes : before.parkedPanes)
                      .filter((pane) => laneIDs.has(pane.id))
                      .map((pane) => pane.id);
        const survivorsAfter = panes
            .filter((pane) => previous.get(pane.id)?.lane === lane)
            .map((pane) => pane.id);
        const stable = idsEqual(survivorsBefore, survivorsAfter);

        panes.forEach((pane, index) => {
            const slot = previous.get(pane.id);
            const unchanged =
                stable && slot !== undefined && slot.lane === lane && slot.pane === pane;
            if (!unchanged) {
                const event: DomainEvent = {
                    kind: 'pane-upserted',
                    workspaceID: after.id,
                    paneID: pane.id,
                    lane,
                    index,
                    pane
                };
                if (slot !== undefined && slot.lane !== lane) laneMoves.push(event);
                else upserts.push(event);
            }
            if (slot === undefined || agentFieldsChanged(slot.pane, pane)) {
                agentEvents.push(agentEvent(after.id, pane));
            }
        });
    };

    emitLane('visible', after.panes);
    emitLane('parked', after.parkedPanes);
    into.push(...laneMoves, ...upserts, ...agentEvents);
}

function groupChanged(before: WorkspaceGroup, after: WorkspaceGroup): boolean {
    return (
        before.name !== after.name ||
        before.color !== after.color ||
        before.isCollapsed !== after.isCollapsed ||
        before.childOrder !== after.childOrder ||
        before.createdAt !== after.createdAt ||
        before.icon !== after.icon
    );
}

/** The complete delta between two states, in apply order. */
export function deriveEvents(previous: DaemonState, next: DaemonState): DomainEvent[] {
    if (previous === next) return [];
    const events: DomainEvent[] = [];

    const previousWorkspaces = new Map(previous.workspaces.map((w) => [w.id, w]));
    const nextWorkspaces = new Map(next.workspaces.map((w) => [w.id, w]));
    for (const workspace of previous.workspaces) {
        if (!nextWorkspaces.has(workspace.id)) {
            events.push({ kind: 'workspace-removed', id: workspace.id });
        }
    }

    const previousGroups = new Map(previous.groups.map((g) => [g.id, g]));
    const nextGroups = new Map(next.groups.map((g) => [g.id, g]));
    for (const group of previous.groups) {
        if (!nextGroups.has(group.id)) events.push({ kind: 'group-removed', id: group.id });
    }

    for (const workspace of next.workspaces) {
        const before = previousWorkspaces.get(workspace.id) ?? null;
        if (before === workspace) continue;
        if (before === null || envelopeChanged(before, workspace)) {
            events.push({
                kind: 'workspace-upserted',
                id: workspace.id,
                workspace: envelopeOf(workspace)
            });
        }
        diffPanes(before, workspace, events);
        if (before === null || layoutChanged(before, workspace)) events.push(layoutEvent(workspace));
        if (before === null || focusChanged(before, workspace)) events.push(focusEvent(workspace));
        if (before === null || syncChanged(before, workspace)) events.push(syncEvent(workspace));
    }

    next.groups.forEach((group, index) => {
        const before = previousGroups.get(group.id);
        const positionChanged = previous.groups[index]?.id !== group.id;
        if (before === undefined || groupChanged(before, group) || positionChanged) {
            events.push({ kind: 'group-upserted', id: group.id, index, group });
        }
    });

    const previousOrder = previous.workspaces.map((w) => w.id);
    const nextOrder = next.workspaces.map((w) => w.id);
    const previousGroupOrder = previous.groups.map((g) => g.id);
    const nextGroupOrder = next.groups.map((g) => g.id);
    if (
        !idsEqual(previousOrder, nextOrder) ||
        !idsEqual(previousGroupOrder, nextGroupOrder) ||
        previous.topLevelOrder !== next.topLevelOrder
    ) {
        events.push({
            kind: 'order-changed',
            workspaceOrder: nextOrder,
            groupOrder: nextGroupOrder,
            topLevelOrder: next.topLevelOrder
        });
    }

    if (previous.lastActiveWorkspaceID !== next.lastActiveWorkspaceID) {
        events.push({
            kind: 'active-workspace-changed',
            workspaceID: next.lastActiveWorkspaceID
        });
    }
    if (previous.labelPresets !== next.labelPresets) {
        events.push({ kind: 'label-presets-changed', presets: next.labelPresets });
    }
    if (previous.repos !== next.repos) {
        events.push({ kind: 'repos-changed', repos: next.repos });
    }

    return events;
}

// ---------------------------------------------------------------------------
// Replay (mirror)
// ---------------------------------------------------------------------------

function withWorkspace(
    state: DaemonState,
    workspaceID: string,
    update: (workspace: WorkspaceState) => WorkspaceState
): DaemonState {
    let touched = false;
    const workspaces = state.workspaces.map((workspace) => {
        if (workspace.id !== workspaceID) return workspace;
        touched = true;
        return update(workspace);
    });
    return touched ? { ...state, workspaces } : state;
}

function skeletonWorkspace(envelope: WorkspaceEnvelope): WorkspaceState {
    return {
        ...envelope,
        panes: [],
        parkedPanes: [],
        layout: { kind: 'empty' },
        focusedPaneID: null,
        focusHistory: [],
        zoomedPaneID: null,
        savedLayout: null,
        currentLayoutIndex: null,
        isSyncInputActive: false,
        syncInputExcluded: []
    };
}

function removePaneEverywhere(state: DaemonState, paneID: string): DaemonState {
    return {
        ...state,
        workspaces: state.workspaces.map((workspace) => {
            const panes = workspace.panes.filter((pane) => pane.id !== paneID);
            const parkedPanes = workspace.parkedPanes.filter((pane) => pane.id !== paneID);
            if (panes.length === workspace.panes.length && parkedPanes.length === workspace.parkedPanes.length) {
                return workspace;
            }
            return { ...workspace, panes, parkedPanes };
        })
    };
}

function insertAt<T>(items: readonly T[], item: T, index: number): T[] {
    const next = [...items];
    next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
    return next;
}

function reorderByIDs<T extends { readonly id: string }>(
    items: readonly T[],
    order: readonly string[]
): T[] {
    const byID = new Map(items.map((item) => [item.id, item]));
    const ordered: T[] = [];
    for (const id of order) {
        const item = byID.get(id);
        if (item !== undefined) {
            ordered.push(item);
            byID.delete(id);
        }
    }
    // Anything the order forgot keeps its relative position at the tail (never dropped).
    for (const item of items) if (byID.has(item.id)) ordered.push(item);
    return ordered;
}

/** Apply one delta event to a mirror state. Unknown targets are tolerated (no-op). */
export function applyDomainEvent(state: DaemonState, event: DomainEvent): DaemonState {
    switch (event.kind) {
        case 'workspace-upserted': {
            const exists = state.workspaces.some((workspace) => workspace.id === event.id);
            if (!exists) {
                return { ...state, workspaces: [...state.workspaces, skeletonWorkspace(event.workspace)] };
            }
            return withWorkspace(state, event.id, (workspace) => ({
                ...workspace,
                ...event.workspace
            }));
        }
        case 'workspace-removed':
            return {
                ...state,
                workspaces: state.workspaces.filter((workspace) => workspace.id !== event.id)
            };
        case 'pane-upserted': {
            const detached = removePaneEverywhere(state, event.paneID);
            return withWorkspace(detached, event.workspaceID, (workspace) =>
                event.lane === 'visible'
                    ? { ...workspace, panes: insertAt(workspace.panes, event.pane, event.index) }
                    : {
                          ...workspace,
                          parkedPanes: insertAt(workspace.parkedPanes, event.pane, event.index)
                      }
            );
        }
        case 'pane-removed':
            return withWorkspace(state, event.workspaceID, (workspace) => ({
                ...workspace,
                panes: workspace.panes.filter((pane) => pane.id !== event.paneID),
                parkedPanes: workspace.parkedPanes.filter((pane) => pane.id !== event.paneID)
            }));
        case 'layout-changed':
            return withWorkspace(state, event.workspaceID, (workspace) => ({
                ...workspace,
                layout: event.layout,
                zoomedPaneID: event.zoomedPaneID,
                savedLayout: event.savedLayout,
                currentLayoutIndex: event.currentLayoutIndex
            }));
        case 'focus-changed':
            return withWorkspace(state, event.workspaceID, (workspace) => ({
                ...workspace,
                focusedPaneID: event.focusedPaneID,
                focusHistory: event.focusHistory
            }));
        case 'sync-changed':
            return withWorkspace(state, event.workspaceID, (workspace) => ({
                ...workspace,
                isSyncInputActive: event.isSyncInputActive,
                syncInputExcluded: event.syncInputExcluded
            }));
        case 'agent-status-changed':
            // Redundant with pane-upserted; applying it keeps narrow subscribers consistent.
            return withWorkspace(state, event.workspaceID, (workspace) => {
                const patch = (pane: Pane): Pane =>
                    pane.id === event.paneID
                        ? {
                              ...pane,
                              status: event.status,
                              agentSessionID: event.agentSessionID,
                              agentKind: event.agentKind,
                              agentStartedAt: event.agentStartedAt,
                              backgroundTaskCount: event.backgroundTaskCount
                          }
                        : pane;
                return {
                    ...workspace,
                    panes: workspace.panes.map(patch),
                    parkedPanes: workspace.parkedPanes.map(patch)
                };
            });
        case 'group-upserted': {
            const without = state.groups.filter((group) => group.id !== event.id);
            return { ...state, groups: insertAt(without, event.group, event.index) };
        }
        case 'group-removed':
            return { ...state, groups: state.groups.filter((group) => group.id !== event.id) };
        case 'order-changed':
            return {
                ...state,
                workspaces: reorderByIDs(state.workspaces, event.workspaceOrder),
                groups: reorderByIDs(state.groups, event.groupOrder),
                topLevelOrder: event.topLevelOrder
            };
        case 'active-workspace-changed':
            return { ...state, lastActiveWorkspaceID: event.workspaceID };
        case 'label-presets-changed':
            return { ...state, labelPresets: event.presets };
        case 'repos-changed':
            return { ...state, repos: event.repos };
    }
}

export function applyDomainEvents(
    state: DaemonState,
    events: readonly DomainEvent[]
): DaemonState {
    return events.reduce(applyDomainEvent, state);
}
