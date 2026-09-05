/**
 * Workspace / group name-or-id resolution.
 * Spec: docs/socket-handlers.md §2.1–2.3, §2.6; app-state-core.md §15.1.
 *
 * TWO workspace resolvers exist with different matching rules and both are load-bearing
 * for CLI compatibility - they are deliberately kept separate here.
 */

import { idsEqual, isUUIDToken, normalizeUUIDToken } from './ids.js';
import type { GroupScope, ResolvableGroup, ResolvableWorkspace, WorkspaceScope } from './types.js';

/** Case-sensitive exact name matches, in state order. */
export function workspacesMatchingName(
    state: WorkspaceScope,
    name: string
): readonly ResolvableWorkspace[] {
    return state.workspaces.filter((workspace) => workspace.name === name);
}

/** Case-sensitive exact name matches, in state order. */
export function groupsMatchingName(state: GroupScope, name: string): readonly ResolvableGroup[] {
    return state.groups.filter((group) => group.name === name);
}

/**
 * Strict resolver (§2.1): a UUID that matches an id always wins; otherwise the token
 * must be a UNIQUE case-sensitive name. Zero and 2+ matches both return null - callers
 * that must distinguish "missing" from "ambiguous" re-check with
 * `workspacesMatchingName` (only `workspace-delete` does).
 */
export function resolveWorkspaceStrict(
    state: WorkspaceScope,
    nameOrID: string
): ResolvableWorkspace | null {
    if (isUUIDToken(nameOrID)) {
        const byID = state.workspaces.find((workspace) => idsEqual(workspace.id, nameOrID));
        if (byID !== undefined) return byID;
        // A UUID token that matches no id falls through to the name match, so a
        // workspace literally *named* a UUID stays reachable.
    }
    const matches = workspacesMatchingName(state, nameOrID);
    return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** Strict resolver for groups (§2.2) - identical contract. */
export function resolveGroupStrict(state: GroupScope, nameOrID: string): ResolvableGroup | null {
    if (isUUIDToken(nameOrID)) {
        const byID = state.groups.find((group) => idsEqual(group.id, nameOrID));
        if (byID !== undefined) return byID;
    }
    const matches = groupsMatchingName(state, nameOrID);
    return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Lenient resolver (§2.3), used only by `pane-move-to-workspace` and the graft scope:
 * UUID → case-INSENSITIVE name FIRST match (no ambiguity guard) → exact slug match.
 */
export function resolveWorkspaceLenient(
    state: WorkspaceScope,
    target: string
): ResolvableWorkspace | null {
    if (isUUIDToken(target)) {
        const byID = state.workspaces.find((workspace) => idsEqual(workspace.id, target));
        if (byID !== undefined) return byID;
    }
    const folded = target.toLowerCase();
    const byName = state.workspaces.find((workspace) => workspace.name.toLowerCase() === folded);
    if (byName !== undefined) return byName;
    return state.workspaces.find((workspace) => workspace.slug === target) ?? null;
}

/**
 * `resolveGroupMember(token, members)` (§2.6): a group-reorder token is either a member
 * UUID or a name unique among the group's members. Returns the member id.
 */
export function resolveGroupMember(
    state: WorkspaceScope,
    token: string,
    members: readonly string[]
): string | null {
    const asUUID = normalizeUUIDToken(token);
    if (asUUID !== null) {
        const member = members.find((id) => idsEqual(id, token));
        if (member !== undefined) return member;
    }
    const matches = members.filter((id) => {
        const workspace = state.workspaces.find((candidate) => candidate.id === id);
        return workspace !== undefined && workspace.name === token;
    });
    return matches.length === 1 ? (matches[0] ?? null) : null;
}
