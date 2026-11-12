/**
 * Workspace / group name-or-id resolution.
 * Spec: docs/socket-handlers.md §2.1–2.3, §2.6; app-state-core.md §15.1.
 *
 * TWO workspace resolvers exist with different matching rules and both are load-bearing
 * for CLI compatibility - they are deliberately kept separate here.
 */

import { liftLeadingIconEmoji } from '../codec/emoji.js';
import { idsEqual, isUUIDToken, normalizeUUIDToken } from './ids.js';
import type { GroupScope, ResolvableGroup, ResolvableWorkspace, WorkspaceScope } from './types.js';

/**
 * The names a token can match, most literal first: the token itself, then the name it would
 * be STORED under when it starts with an emoji (`"🔥 auth"` is stored as `auth` with a 🔥
 * icon, `liftLeadingIconEmoji`). A caller tries them in order and stops at the first that
 * matches anything, so a row whose stored name really is `🔥 auth` (one made before the lift
 * existed, or with `keep_emoji`) always wins, and the name a workspace or group was created
 * with still finds it afterwards.
 */
function nameCandidates(token: string): readonly string[] {
    const lifted = liftLeadingIconEmoji(token);
    return lifted === null ? [token] : [token, lifted.name];
}

function rowsMatchingName<Row extends { readonly name: string }>(rows: readonly Row[], token: string): readonly Row[] {
    for (const name of nameCandidates(token)) {
        const matches = rows.filter((row) => row.name === name);
        if (matches.length > 0) return matches;
    }
    return [];
}

/**
 * Case-sensitive exact name matches, in state order. A token that matches nothing as typed is
 * tried again without its leading emoji (`nameCandidates`).
 */
export function workspacesMatchingName(
    state: WorkspaceScope,
    name: string
): readonly ResolvableWorkspace[] {
    return rowsMatchingName(state.workspaces, name);
}

/** Case-sensitive exact name matches, in state order, with the same leading-emoji fallback. */
export function groupsMatchingName(state: GroupScope, name: string): readonly ResolvableGroup[] {
    return rowsMatchingName(state.groups, name);
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
 * UUID → case-INSENSITIVE name FIRST match (no ambiguity guard; the token as typed, then
 * without its leading emoji) → exact slug match.
 */
export function resolveWorkspaceLenient(
    state: WorkspaceScope,
    target: string
): ResolvableWorkspace | null {
    if (isUUIDToken(target)) {
        const byID = state.workspaces.find((workspace) => idsEqual(workspace.id, target));
        if (byID !== undefined) return byID;
    }
    for (const name of nameCandidates(target)) {
        const folded = name.toLowerCase();
        const byName = state.workspaces.find((workspace) => workspace.name.toLowerCase() === folded);
        if (byName !== undefined) return byName;
    }
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
    const named = state.workspaces.filter((workspace) => members.includes(workspace.id));
    const matches = rowsMatchingName(named, token);
    return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}
