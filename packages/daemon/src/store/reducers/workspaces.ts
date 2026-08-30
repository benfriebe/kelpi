/**
 * Workspace lifecycle, sidebar placement, labels, label presets and the repo registry.
 *
 * Spec: docs/current/app-state-core.md §3 (active workspace), §4 (workspace lifecycle),
 * §6 (labels + presets), §7 (repos); docs/current/workspace-feature.md §7.1 (metadata);
 * docs/current/socket-handlers.md §6.6 (`workspace label` + preset back-fill).
 */

import { groupSidebarID, workspaceSidebarID, type SidebarID } from '@kelpi/core/codec';
import { normalizedAssignment } from '@kelpi/core/env';
import { leaf } from '@kelpi/core/layout';
import { makeSlug, normalizeLabel } from '@kelpi/core/resolve';
import type {
    DaemonState,
    DomainAction,
    LabelPreset,
    WorkspaceGroup,
    WorkspaceState
} from '../types.js';
import { makeWorkspaceState } from '../types.js';
import { clampIndex, newPane, seconds, updateWorkspace } from './helpers.js';

// ---------------------------------------------------------------------------
// Sidebar plumbing
// ---------------------------------------------------------------------------

function sameEntry(a: SidebarID, b: SidebarID): boolean {
    return a.kind === b.kind && a.id === b.id;
}

function indexOfEntry(order: readonly SidebarID[], entry: SidebarID): number {
    return order.findIndex((candidate) => sameEntry(candidate, entry));
}

function groupOfWorkspace(state: DaemonState, workspaceID: string): WorkspaceGroup | null {
    return state.groups.find((group) => group.childOrder.includes(workspaceID)) ?? null;
}

/** §2.4 `sidebarAnchor`: the top-level entry a workspace "sits under". */
function sidebarAnchor(state: DaemonState, workspaceID: string | null): SidebarID | null {
    if (workspaceID === null) return null;
    const entry = workspaceSidebarID(workspaceID);
    if (indexOfEntry(state.topLevelOrder, entry) >= 0) return entry;
    const group = groupOfWorkspace(state, workspaceID);
    return group === null ? null : groupSidebarID(group.id);
}

function insertAfter(
    order: readonly SidebarID[],
    anchor: SidebarID | null,
    entry: SidebarID
): SidebarID[] {
    const next = [...order];
    if (anchor === null) {
        next.push(entry);
        return next;
    }
    const index = indexOfEntry(next, anchor);
    if (index < 0) next.push(entry);
    else next.splice(index + 1, 0, entry);
    return next;
}

function detachWorkspace(state: DaemonState, workspaceID: string): DaemonState {
    return {
        ...state,
        topLevelOrder: state.topLevelOrder.filter(
            (entry) => !(entry.kind === 'workspace' && entry.id === workspaceID)
        ),
        groups: state.groups.map((group) =>
            group.childOrder.includes(workspaceID)
                ? { ...group, childOrder: group.childOrder.filter((id) => id !== workspaceID) }
                : group
        )
    };
}

function expandGroup(state: DaemonState, groupID: string): DaemonState {
    return {
        ...state,
        groups: state.groups.map((group) =>
            group.id === groupID && group.isCollapsed ? { ...group, isCollapsed: false } : group
        )
    };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function createWorkspace(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'create-workspace' }>
): DaemonState {
    const createdAt = seconds(action.now);
    const pane = newPane({
        id: action.paneID,
        workingDirectory:
            action.workingDirectory !== undefined && action.workingDirectory !== ''
                ? action.workingDirectory
                : state.homeDirectory,
        nowMillis: action.now
    });
    const workspace = makeWorkspaceState({
        id: action.id,
        name: action.name,
        slug: makeSlug(action.name, action.id),
        color: action.color ?? 'blue',
        createdAt,
        profileName: normalizedAssignment(action.profileName ?? null),
        labels: action.labels ?? [],
        panes: [pane],
        layout: leaf(pane.id),
        focusedPaneID: pane.id,
        repoAssociations: action.repoAssociations ?? []
    });

    const previousActiveID = state.lastActiveWorkspaceID;
    const placement = action.placement ?? 'end-of-list';
    let next: DaemonState = { ...state, workspaces: [...state.workspaces, workspace] };

    const group =
        action.groupID === undefined
            ? null
            : (next.groups.find((candidate) => candidate.id === action.groupID) ?? null);

    if (group !== null) {
        const anchorIndex =
            placement === 'near-selection' && previousActiveID !== null
                ? group.childOrder.indexOf(previousActiveID)
                : -1;
        const childOrder = [...group.childOrder];
        if (anchorIndex < 0) childOrder.push(workspace.id);
        else childOrder.splice(anchorIndex + 1, 0, workspace.id);
        next = {
            ...next,
            groups: next.groups.map((candidate) =>
                candidate.id === group.id
                    ? { ...candidate, childOrder, isCollapsed: false }
                    : candidate
            )
        };
    } else {
        const entry = workspaceSidebarID(workspace.id);
        next = {
            ...next,
            topLevelOrder:
                placement === 'near-selection'
                    ? insertAfter(next.topLevelOrder, sidebarAnchor(next, previousActiveID), entry)
                    : [...next.topLevelOrder, entry]
        };
    }

    return { ...next, lastActiveWorkspaceID: workspace.id };
}

function deleteWorkspaces(state: DaemonState, ids: readonly string[]): DaemonState {
    const removing = new Set(ids.filter((id) => state.workspaces.some((w) => w.id === id)));
    if (removing.size === 0) return state;

    const workspaces = state.workspaces.filter((workspace) => !removing.has(workspace.id));
    const topLevelOrder = state.topLevelOrder.filter(
        (entry) => !(entry.kind === 'workspace' && removing.has(entry.id))
    );
    const groups = state.groups.map((group) => {
        const childOrder = group.childOrder.filter((id) => !removing.has(id));
        return childOrder.length === group.childOrder.length ? group : { ...group, childOrder };
    });

    let lastActiveWorkspaceID = state.lastActiveWorkspaceID;
    if (lastActiveWorkspaceID !== null && removing.has(lastActiveWorkspaceID)) {
        // §4.3 step 3: the survivor with the greatest lastAccessedAt inherits.
        let successor: WorkspaceState | null = null;
        for (const workspace of workspaces) {
            if (successor === null || workspace.lastAccessedAt > successor.lastAccessedAt) {
                successor = workspace;
            }
        }
        lastActiveWorkspaceID = successor?.id ?? null;
    }

    return { ...state, workspaces, topLevelOrder, groups, lastActiveWorkspaceID };
}

function moveWorkspace(state: DaemonState, id: string, toIndex: number): DaemonState {
    // §4.6: bounds are evaluated BEFORE removal, against the pre-move order.
    const entry = workspaceSidebarID(id);
    const currentIndex = indexOfEntry(state.topLevelOrder, entry);
    if (currentIndex < 0) return state;
    if (toIndex === currentIndex) return state;
    if (toIndex < 0 || toIndex >= state.topLevelOrder.length) return state;

    const order = [...state.topLevelOrder];
    order.splice(currentIndex, 1);
    order.splice(Math.min(toIndex, order.length), 0, entry);

    // Legacy nicety: mirror the move into the flat array so it roughly tracks visual order.
    const flatIndex = state.workspaces.findIndex((workspace) => workspace.id === id);
    let workspaces = state.workspaces;
    if (flatIndex >= 0) {
        const next = [...state.workspaces];
        const [moved] = next.splice(flatIndex, 1);
        if (moved !== undefined) next.splice(Math.min(toIndex, next.length), 0, moved);
        workspaces = next;
    }
    return { ...state, topLevelOrder: order, workspaces };
}

function moveWorkspacesToGroup(
    state: DaemonState,
    ids: readonly string[],
    groupID: string | null,
    index: number | null | undefined,
    expandOnDrop: boolean
): DaemonState {
    if (groupID !== null && !state.groups.some((group) => group.id === groupID)) return state;
    const moving = ids.filter((id) => state.workspaces.some((workspace) => workspace.id === id));
    if (moving.length === 0) return state;

    // Single pass: detach every id from every parent, then insert the block at the target.
    const movingSet = new Set(moving);
    let next: DaemonState = {
        ...state,
        topLevelOrder: state.topLevelOrder.filter(
            (entry) => !(entry.kind === 'workspace' && movingSet.has(entry.id))
        ),
        groups: state.groups.map((group) => {
            const childOrder = group.childOrder.filter((id) => !movingSet.has(id));
            return childOrder.length === group.childOrder.length ? group : { ...group, childOrder };
        })
    };

    if (groupID === null) {
        const order = [...next.topLevelOrder];
        const at = index === null || index === undefined ? order.length : clampIndex(index, order.length);
        order.splice(at, 0, ...moving.map((id) => workspaceSidebarID(id)));
        return { ...next, topLevelOrder: order };
    }

    next = {
        ...next,
        groups: next.groups.map((group) => {
            if (group.id !== groupID) return group;
            const childOrder = [...group.childOrder];
            const at =
                index === null || index === undefined
                    ? childOrder.length
                    : clampIndex(index, childOrder.length);
            childOrder.splice(at, 0, ...moving);
            const collapsed = expandOnDrop ? false : group.isCollapsed;
            return { ...group, childOrder, isCollapsed: collapsed };
        })
    };
    return next;
}

// ---------------------------------------------------------------------------
// Labels + presets
// ---------------------------------------------------------------------------

function addPreset(presets: readonly LabelPreset[], name: string): readonly LabelPreset[] {
    // §6.4: empty or case-sensitive duplicate is a silent no-op, so the CLI back-fill is safe
    // to call opportunistically and never overwrites a user's chosen color.
    if (name === '') return presets;
    if (presets.some((preset) => preset.name === name)) return presets;
    return [...presets, { name, color: { kind: 'named', color: 'gray' }, textColor: null }];
}

function applyLabels(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'workspace-labels' }>
): DaemonState {
    const workspace = state.workspaces.find((candidate) => candidate.id === action.id);
    if (workspace === undefined) return state;

    const values = action.values.map(normalizeLabel).filter((value) => value !== '');
    let labels: readonly string[] = workspace.labels;
    let introduced: readonly string[] = [];

    switch (action.op) {
        case 'set': {
            if (values.length === 0) return state; // never silently wipe (handler errors)
            const deduped: string[] = [];
            for (const value of values) if (!deduped.includes(value)) deduped.push(value);
            labels = deduped;
            introduced = deduped;
            break;
        }
        case 'add': {
            if (values.length === 0) return state;
            const next = [...workspace.labels];
            for (const value of values) if (!next.includes(value)) next.push(value);
            labels = next;
            introduced = values;
            break;
        }
        case 'remove': {
            if (values.length === 0) return state;
            labels = workspace.labels.filter((label) => !values.includes(label));
            break;
        }
        case 'clear':
            labels = [];
            break;
    }

    let next = updateWorkspace(state, action.id, (target) => ({ ...target, labels }));
    if (action.backfillPresets !== false) {
        let presets = next.labelPresets;
        for (const label of introduced) presets = addPreset(presets, label);
        if (presets !== next.labelPresets) next = { ...next, labelPresets: presets };
    }
    return next;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function reduceWorkspaceAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'create-workspace':
            return createWorkspace(state, action);
        case 'delete-workspace':
            return deleteWorkspaces(state, [action.id]);
        case 'delete-workspaces':
            return deleteWorkspaces(state, action.ids);
        case 'rename-workspace':
            // §7.1: the slug is recomputed on rename (the app-state doc's "generated once" note
            // describes creation; the reducer spec's rename recomputes — see notes).
            return updateWorkspace(state, action.id, (workspace) => ({
                ...workspace,
                name: action.name,
                slug: makeSlug(action.name, workspace.id)
            }));
        case 'set-workspace-color':
            return updateWorkspace(state, action.id, (workspace) => ({
                ...workspace,
                color: action.color
            }));
        case 'set-workspace-icon':
            return updateWorkspace(state, action.id, (workspace) => ({
                ...workspace,
                icon: action.icon
            }));
        case 'set-workspace-profile':
            return updateWorkspace(state, action.id, (workspace) => ({
                ...workspace,
                profileName: normalizedAssignment(action.profileName)
            }));
        case 'workspace-labels':
            return applyLabels(state, action);
        case 'set-active-workspace': {
            if (!state.workspaces.some((workspace) => workspace.id === action.id)) return state;
            let next = updateWorkspace(state, action.id, (workspace) => ({
                ...workspace,
                lastAccessedAt: seconds(action.now)
            }));
            // Navigating to a member of a collapsed group expands it (§3.1 step 3).
            const group = groupOfWorkspace(next, action.id);
            if (group !== null && group.isCollapsed) next = expandGroup(next, group.id);
            return { ...next, lastActiveWorkspaceID: action.id };
        }
        case 'move-workspace':
            return moveWorkspace(state, action.id, action.toIndex);
        case 'move-workspace-to-group': {
            if (!state.workspaces.some((workspace) => workspace.id === action.id)) return state;
            return moveWorkspacesToGroup(
                state,
                [action.id],
                action.groupID,
                action.index,
                action.expandOnDrop ?? true
            );
        }
        case 'move-workspaces-to-group':
            // The bulk path always expands a collapsed target group (no setting check).
            return moveWorkspacesToGroup(state, action.ids, action.groupID, action.index, true);
        case 'set-bulk-color': {
            let next = state;
            for (const id of action.ids) {
                next = updateWorkspace(next, id, (workspace) => ({
                    ...workspace,
                    color: action.color
                }));
            }
            return next;
        }
        case 'set-bulk-label': {
            const label = normalizeLabel(action.label);
            if (label === '') return state;
            let next = state;
            for (const id of action.ids) {
                next = updateWorkspace(next, id, (workspace) => {
                    if (action.apply) {
                        if (workspace.labels.includes(label)) return workspace;
                        return { ...workspace, labels: [...workspace.labels, label] };
                    }
                    if (!workspace.labels.includes(label)) return workspace;
                    return {
                        ...workspace,
                        labels: workspace.labels.filter((candidate) => candidate !== label)
                    };
                });
            }
            // GUI bulk-apply deliberately does NOT back-fill a preset (§2.8).
            return next;
        }

        // ── label presets (§6.4) ──────────────────────────────────────────
        case 'add-label-preset': {
            const name = normalizeLabel(action.name);
            if (name === '' || state.labelPresets.some((preset) => preset.name === name)) {
                return state;
            }
            return {
                ...state,
                labelPresets: [...state.labelPresets, { name, color: action.color, textColor: null }]
            };
        }
        case 'update-label-preset': {
            const name = normalizeLabel(action.name);
            if (name === '') return state;
            if (!state.labelPresets.some((preset) => preset.name === action.id)) return state;
            // Renaming into a DIFFERENT preset's name is refused; a self-collision recolor is fine.
            if (state.labelPresets.some((preset) => preset.name === name && preset.name !== action.id)) {
                return state;
            }
            return {
                ...state,
                labelPresets: state.labelPresets.map((preset) =>
                    preset.name === action.id ? { ...preset, name, color: action.color } : preset
                )
            };
        }
        case 'set-label-preset-text-color': {
            if (!state.labelPresets.some((preset) => preset.name === action.id)) return state;
            return {
                ...state,
                labelPresets: state.labelPresets.map((preset) =>
                    preset.name === action.id ? { ...preset, textColor: action.textColor } : preset
                )
            };
        }
        case 'remove-label-preset': {
            const labelPresets = state.labelPresets.filter((preset) => preset.name !== action.id);
            // Removing a preset never touches any workspace's labels (§6.4).
            return labelPresets.length === state.labelPresets.length
                ? state
                : { ...state, labelPresets };
        }
        case 'move-label-preset': {
            const { from, to } = action;
            if (from < 0 || from >= state.labelPresets.length) return state;
            if (to < 0 || to >= state.labelPresets.length || from === to) return state;
            const labelPresets = [...state.labelPresets];
            const [moved] = labelPresets.splice(from, 1);
            if (moved === undefined) return state;
            labelPresets.splice(to, 0, moved);
            return { ...state, labelPresets };
        }
        case 'set-label-presets':
            return { ...state, labelPresets: [...action.presets] };
        case 'set-label-presets-migrated':
            // §6.5: one-shot and one-way. Already-set returns the identical object, so the
            // store notifies nobody and the debounced save is not woken for a no-op.
            return state.labelPresetsMigrated ? state : { ...state, labelPresetsMigrated: true };

        // ── repo registry / associations ──────────────────────────────────
        case 'add-repo':
            if (state.repos.some((repo) => repo.id === action.repo.id || repo.path === action.repo.path)) {
                return state;
            }
            return { ...state, repos: [...state.repos, action.repo] };
        case 'remove-repo': {
            const repos = state.repos.filter((repo) => repo.id !== action.id);
            if (repos.length === state.repos.length) return state;
            return {
                ...state,
                repos,
                workspaces: state.workspaces.map((workspace) => {
                    const associations = workspace.repoAssociations.filter(
                        (assoc) => assoc.repoID !== action.id
                    );
                    return associations.length === workspace.repoAssociations.length
                        ? workspace
                        : { ...workspace, repoAssociations: associations };
                })
            };
        }
        case 'rename-repo':
            return {
                ...state,
                repos: state.repos.map((repo) =>
                    repo.id === action.id ? { ...repo, name: action.name } : repo
                )
            };
        case 'set-repo-remote-url':
            return {
                ...state,
                repos: state.repos.map((repo) =>
                    repo.id === action.id ? { ...repo, remoteURL: action.remoteURL } : repo
                )
            };
        // §GIT-068: promote an auto-discovered repo to manual so the auto-unlink GC (§GIT-081)
        // stops treating it as disposable.
        case 'set-repo-auto-discovered':
            return {
                ...state,
                repos: state.repos.map((repo) =>
                    repo.id === action.id
                        ? { ...repo, isAutoDiscovered: action.isAutoDiscovered }
                        : repo
                )
            };
        case 'add-repo-association':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                workspace.repoAssociations.some((assoc) => assoc.id === action.association.id)
                    ? workspace
                    : {
                          ...workspace,
                          repoAssociations: [...workspace.repoAssociations, action.association]
                      }
            );
        case 'remove-repo-association':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                const repoAssociations = workspace.repoAssociations.filter(
                    (assoc) => assoc.id !== action.associationID
                );
                return repoAssociations.length === workspace.repoAssociations.length
                    ? workspace
                    : { ...workspace, repoAssociations };
            });
        case 'set-repo-association-branch':
            return updateWorkspace(state, action.workspaceID, (workspace) => ({
                ...workspace,
                repoAssociations: workspace.repoAssociations.map((assoc) =>
                    assoc.id === action.associationID
                        ? { ...assoc, branchName: action.branchName }
                        : assoc
                )
            }));
        default:
            return state;
    }
}

export { detachWorkspace, indexOfEntry, sameEntry, sidebarAnchor };
