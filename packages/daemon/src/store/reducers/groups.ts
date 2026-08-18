/**
 * Group lifecycle: create (with the exact anchor math), rename/color/icon, collapse, delete
 * (promote or cascade), top-level move, and child-order reorder/sort.
 *
 * Spec: docs/current/app-state-core.md §5; docs/current/socket-handlers.md §7.4
 * (`group-reorder` / `group-sort` semantics, including the dangling-id preservation rule).
 */

import { groupSidebarID, workspaceSidebarID, type SidebarID } from '@nex/core/codec';
import type { DaemonState, DomainAction, GroupSortKey, WorkspaceState } from '../types.js';
import { clampIndex, seconds } from './helpers.js';
import { indexOfEntry, sameEntry, sidebarAnchor } from './workspaces.js';

function updateGroup(
    state: DaemonState,
    groupID: string,
    update: (group: DaemonState['groups'][number]) => DaemonState['groups'][number]
): DaemonState {
    const index = state.groups.findIndex((group) => group.id === groupID);
    if (index < 0) return state;
    const current = state.groups[index];
    if (current === undefined) return state;
    const next = update(current);
    if (next === current) return state;
    const groups = [...state.groups];
    groups[index] = next;
    return { ...state, groups };
}

function createGroup(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'create-group' }>
): DaemonState {
    const name = action.name.trim();
    if (name === '') return state;

    const seen = new Set<string>();
    const validInitial: string[] = [];
    for (const id of action.initialWorkspaceIDs ?? []) {
        if (seen.has(id)) continue;
        if (!state.workspaces.some((workspace) => workspace.id === id)) continue;
        seen.add(id);
        validInitial.push(id);
    }

    // §5.1 step 3: an explicit anchor wins; otherwise placement decides.
    const placement = action.placement ?? 'end-of-list';
    const anchor: SidebarID | null =
        action.insertAfter !== undefined && action.insertAfter !== null
            ? action.insertAfter
            : placement === 'near-selection'
              ? (sidebarAnchor(state, validInitial[0] ?? null) ??
                sidebarAnchor(state, state.lastActiveWorkspaceID))
              : null;

    // §5.1 step 4: capture the anchor's position BEFORE detaching anything.
    const anchorIndexBefore = anchor === null ? null : indexOfEntry(state.topLevelOrder, anchor);
    const anchorWillBeDetached =
        anchor !== null && anchor.kind === 'workspace' && validInitial.includes(anchor.id);
    const removedBeforeAnchor =
        anchorIndexBefore === null || anchorIndexBefore < 0
            ? 0
            : state.topLevelOrder.filter(
                  (entry, index) =>
                      index < anchorIndexBefore &&
                      entry.kind === 'workspace' &&
                      validInitial.includes(entry.id)
              ).length;

    const group = {
        id: action.id,
        name,
        color: action.color ?? null,
        isCollapsed: false,
        childOrder: validInitial,
        createdAt: seconds(action.now),
        icon: null
    };

    // §5.1 step 6: detach every member from its previous parent.
    const memberSet = new Set(validInitial);
    const groups = [
        ...state.groups.map((candidate) => {
            const childOrder = candidate.childOrder.filter((id) => !memberSet.has(id));
            return childOrder.length === candidate.childOrder.length
                ? candidate
                : { ...candidate, childOrder };
        }),
        group
    ];
    const order = state.topLevelOrder.filter(
        (entry) => !(entry.kind === 'workspace' && memberSet.has(entry.id))
    );

    const entry = groupSidebarID(group.id);
    if (anchorIndexBefore === null || anchorIndexBefore < 0) {
        order.push(entry);
    } else {
        const adjusted = anchorIndexBefore - removedBeforeAnchor;
        // The anchor's own vacated slot becomes the group's slot when it was detached.
        const target = anchorWillBeDetached ? adjusted : adjusted + 1;
        order.splice(clampIndex(target, order.length), 0, entry);
    }

    return { ...state, groups, topLevelOrder: order };
}

function deleteGroup(state: DaemonState, groupID: string, cascade: boolean): DaemonState {
    const group = state.groups.find((candidate) => candidate.id === groupID);
    if (group === undefined) return state;

    const entry = groupSidebarID(groupID);
    const groupIndex = indexOfEntry(state.topLevelOrder, entry);
    const order = state.topLevelOrder.filter((candidate) => !sameEntry(candidate, entry));
    const groups = state.groups.filter((candidate) => candidate.id !== groupID);

    if (cascade) {
        const doomed = new Set(group.childOrder);
        const workspaces = state.workspaces.filter((workspace) => !doomed.has(workspace.id));
        let lastActiveWorkspaceID = state.lastActiveWorkspaceID;
        if (lastActiveWorkspaceID !== null && doomed.has(lastActiveWorkspaceID)) {
            let successor: WorkspaceState | null = null;
            for (const workspace of workspaces) {
                if (successor === null || workspace.lastAccessedAt > successor.lastAccessedAt) {
                    successor = workspace;
                }
            }
            lastActiveWorkspaceID = successor?.id ?? null;
        }
        return {
            ...state,
            workspaces,
            groups: groups.map((candidate) => {
                const childOrder = candidate.childOrder.filter((id) => !doomed.has(id));
                return childOrder.length === candidate.childOrder.length
                    ? candidate
                    : { ...candidate, childOrder };
            }),
            topLevelOrder: order.filter(
                (candidate) => !(candidate.kind === 'workspace' && doomed.has(candidate.id))
            ),
            lastActiveWorkspaceID
        };
    }

    // Children promote to top level, in child order, at the group's former slot.
    const promoted = group.childOrder
        .filter((id) => state.workspaces.some((workspace) => workspace.id === id))
        .map((id) => workspaceSidebarID(id));
    if (groupIndex < 0) order.push(...promoted);
    else order.splice(clampIndex(groupIndex, order.length), 0, ...promoted);
    return { ...state, groups, topLevelOrder: order };
}

function moveGroup(state: DaemonState, groupID: string, toIndex: number): DaemonState {
    const entry = groupSidebarID(groupID);
    const currentIndex = indexOfEntry(state.topLevelOrder, entry);
    if (currentIndex < 0) return state;
    if (toIndex === currentIndex) return state;
    if (toIndex < 0 || toIndex >= state.topLevelOrder.length) return state;
    const order = [...state.topLevelOrder];
    order.splice(currentIndex, 1);
    order.splice(Math.min(toIndex, order.length), 0, entry);
    return { ...state, topLevelOrder: order };
}

interface MemberPartition {
    /** Live members, deduped, in stored order. */
    readonly live: readonly string[];
    /** Ids in the stored order whose workspace vanished (or duplicates): kept at the tail. */
    readonly dangling: readonly string[];
}

function partitionMembers(state: DaemonState, childOrder: readonly string[]): MemberPartition {
    const live: string[] = [];
    const dangling: string[] = [];
    const seen = new Set<string>();
    for (const id of childOrder) {
        const exists = state.workspaces.some((workspace) => workspace.id === id);
        if (exists && !seen.has(id)) {
            seen.add(id);
            live.push(id);
        } else {
            dangling.push(id);
        }
    }
    return { live, dangling };
}

function reorderGroup(
    state: DaemonState,
    groupID: string,
    explicitOrder: readonly string[]
): DaemonState {
    const group = state.groups.find((candidate) => candidate.id === groupID);
    if (group === undefined) return state;
    const { live, dangling } = partitionMembers(state, group.childOrder);

    const ordered: string[] = [];
    for (const id of explicitOrder) {
        if (!live.includes(id)) return state; // not a member -> the handler errors, we no-op
        if (ordered.includes(id)) return state; // listed twice -> same
        ordered.push(id);
    }
    // Members omitted from the order keep their prior relative order at the tail.
    const tail = live.filter((id) => !ordered.includes(id));
    return updateGroup(state, groupID, (candidate) => ({
        ...candidate,
        childOrder: [...ordered, ...tail, ...dangling]
    }));
}

function sortKeyFor(workspace: WorkspaceState, key: GroupSortKey): string | number {
    switch (key) {
        case 'name':
            return workspace.name.toLowerCase();
        case 'last-activity': {
            let latest = Number.NEGATIVE_INFINITY;
            for (const pane of workspace.panes) latest = Math.max(latest, pane.lastActivityAt);
            return latest;
        }
        case 'last-accessed':
            return workspace.lastAccessedAt;
    }
}

function sortGroup(
    state: DaemonState,
    groupID: string,
    key: GroupSortKey,
    descending: boolean
): DaemonState {
    const group = state.groups.find((candidate) => candidate.id === groupID);
    if (group === undefined) return state;
    const { live, dangling } = partitionMembers(state, group.childOrder);

    const decorated = live.map((id, index) => {
        const workspace = state.workspaces.find((candidate) => candidate.id === id) as WorkspaceState;
        return { id, index, key: sortKeyFor(workspace, key) };
    });
    decorated.sort((a, b) => {
        let comparison: number;
        if (typeof a.key === 'string' && typeof b.key === 'string') {
            comparison = a.key.localeCompare(b.key);
        } else {
            comparison = (a.key as number) - (b.key as number);
        }
        // `descending` inverts the KEY comparison, not the array: ties keep their prior order.
        if (descending) comparison = -comparison;
        return comparison !== 0 ? comparison : a.index - b.index;
    });

    return updateGroup(state, groupID, (candidate) => ({
        ...candidate,
        childOrder: [...decorated.map((entry) => entry.id), ...dangling]
    }));
}

export function reduceGroupAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'create-group':
            return createGroup(state, action);
        case 'rename-group': {
            const name = action.name.trim();
            if (name === '') return state;
            return updateGroup(state, action.id, (group) => ({ ...group, name }));
        }
        case 'set-group-color':
            return updateGroup(state, action.id, (group) => ({ ...group, color: action.color }));
        case 'set-group-icon':
            return updateGroup(state, action.id, (group) => ({ ...group, icon: action.icon }));
        case 'toggle-group-collapse':
            return updateGroup(state, action.id, (group) => ({
                ...group,
                isCollapsed: !group.isCollapsed
            }));
        case 'set-group-collapsed':
            return updateGroup(state, action.id, (group) => ({
                ...group,
                isCollapsed: action.collapsed
            }));
        case 'delete-group':
            return deleteGroup(state, action.id, action.cascade);
        case 'move-group':
            return moveGroup(state, action.id, action.toIndex);
        case 'reorder-group':
            return reorderGroup(state, action.id, action.order);
        case 'sort-group':
            return sortGroup(state, action.id, action.by, action.descending ?? false);
        default:
            return state;
    }
}
