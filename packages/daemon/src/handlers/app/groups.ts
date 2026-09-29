/**
 * `group-*` command handlers (socket-handlers.md §7).
 *
 * `group-list` / `group-set-repo` / `group-reorder` / `group-sort` are request/response;
 * `group-create` / `group-rename` / `group-delete` / `group-move` are fire-and-forget (an
 * unresolvable name is a silent no-op).
 *
 * The reorder/sort pair share one handler: both rewrite the group's `childOrder`, both preserve
 * ids whose workspace vanished at the TAIL of the stored order, and both reply with the LIVE
 * members only (§7.4 step 7).
 */

import { groupSidebarID } from '@kelpi/core/codec';
import { resolveGroupMember, resolveGroupStrict } from '@kelpi/core/resolve';
import type { GroupSetRepoMessage, WorkspaceColor } from '@kelpi/protocol';

import type { ReplyHandle } from '../../seams.js';
import {
    groupByID,
    resolveStateOf,
    workspaceByID,
    type DaemonState,
    type GroupSortKey,
    type WorkspaceGroup
} from '../../store/index.js';
import { forCommand, listedGroupIDs, refreshSyncGroup, uuidOut } from './common.js';
import { fail, ok, type AppContext, type AppDeps, type AppHandler } from './context.js';
import { groupRepo, repoRef, resolveRepo } from './repos.js';

/** Group child order filtered to live workspaces and deduped (§7.4 step 2). */
function liveMembers(state: DaemonState, group: WorkspaceGroup): string[] {
    const seen = new Set<string>();
    const members: string[] = [];
    for (const id of group.childOrder) {
        if (seen.has(id)) continue;
        if (workspaceByID(state, id) === null) continue;
        seen.add(id);
        members.push(id);
    }
    return members;
}

// ---------------------------------------------------------------------------
// group-list (§7.1)
// ---------------------------------------------------------------------------

function handleGroupList(ctx: AppContext, reply: ReplyHandle | null): void {
    if (reply === null) return;
    const state = ctx.store.getState();
    const groups = listedGroupIDs(state).flatMap((groupID) => {
        const group = groupByID(state, groupID);
        if (group === null) return [];
        const workspaces = group.childOrder.flatMap((memberID) => {
            const workspace = workspaceByID(state, memberID);
            return workspace === null ? [] : [{ id: uuidOut(workspace.id), name: workspace.name }];
        });
        const repo = groupRepo(state, group);
        return [
            {
                id: uuidOut(group.id),
                name: group.name,
                ...(group.color !== null ? { color: group.color } : {}),
                workspaces,
                // §7.1 / app-state-core.md §5.5: present only while the group has a default
                // repository, the same absence rule `color` follows, so a repo-less group's
                // entry is byte-identical to what it always was.
                ...(repo !== null ? { repo: repoRef(repo), create_worktree: group.createWorktree } : {})
            }
        ];
    });
    ok(reply, { groups });
}

// ---------------------------------------------------------------------------
// group-create / rename / delete (§7.2, §7.3 — fire-and-forget)
// ---------------------------------------------------------------------------

function handleGroupCreate(
    name: string,
    color: WorkspaceColor | undefined,
    ctx: AppContext,
    deps: AppDeps
): void {
    const trimmed = name.trim();
    // A blank group would render as empty header chrome and be unreachable by name.
    if (trimmed === '') return;
    const id = deps.uuid();
    ctx.store.dispatch({
        type: 'create-group',
        id,
        name: trimmed,
        now: deps.now(),
        // Icons are deliberately NOT settable over the wire (UI-only affordance).
        ...(color !== undefined ? { color } : {})
    });
    deps.scrollTarget(groupSidebarID(id));
    deps.persist();
}

function handleGroupRename(
    nameOrID: string,
    newName: string,
    ctx: AppContext,
    deps: AppDeps
): void {
    const group = resolveGroupStrict(resolveStateOf(ctx.store.getState()), nameOrID);
    if (group === null) return;
    ctx.store.dispatch({ type: 'rename-group', id: group.id, name: newName });
    deps.persist();
}

function handleGroupDelete(
    nameOrID: string,
    cascade: boolean,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const resolved = resolveGroupStrict(resolveStateOf(state), nameOrID);
    if (resolved === null) return;
    const group = groupByID(state, resolved.id);
    if (group === null) return;

    if (cascade) {
        // Cascade destroys the member workspaces' surfaces too (app-state-core §5.4).
        const paneIDs = liveMembers(state, group).flatMap(memberID => {
            const workspace = workspaceByID(state, memberID)!;
            return [...workspace.panes, ...workspace.parkedPanes].map(pane => pane.id);
        });
        // Validate every member before tearing down any surface. A save refusal must
        // leave the entire group usable, including members preceding the failed file.
        try { ctx.prepareDocumentClose?.(paneIDs); }
        catch (error) { fail(reply, error instanceof Error ? error.message : String(error)); return; }
        for (const paneID of paneIDs) deps.killPane(paneID, ctx);
    }
    ctx.store.dispatch({ type: 'delete-group', id: group.id, cascade });
    if (cascade) for (const memberID of group.childOrder) refreshSyncGroup(ctx, memberID);
    deps.persist();
}

// ---------------------------------------------------------------------------
// group-move (§7.5, fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * The sidebar's header drag: the group's own slot in `topLevelOrder`, which `group-reorder`
 * (a group's `childOrder`) has no way to express. Fire-and-forget like `workspace-move`, so an
 * unresolvable group or an out-of-range slot is a silent no-op: the reducer clamps nothing and
 * simply returns the state untouched, and the client's shadow order then reverts on the next
 * broadcast, which is the honest answer to a stale drag.
 */
function handleGroupMove(
    nameOrID: string,
    index: number,
    ctx: AppContext,
    deps: AppDeps
): void {
    const group = resolveGroupStrict(resolveStateOf(ctx.store.getState()), nameOrID);
    if (group === null) return;
    ctx.store.dispatch({ type: 'move-group', id: group.id, toIndex: index });
    deps.persist();
}

// ---------------------------------------------------------------------------
// group-set-repo (§7.6)
// ---------------------------------------------------------------------------

function replyWithGroupRepo(ctx: AppContext, reply: ReplyHandle | null, groupID: string): void {
    const state = ctx.store.getState();
    const group = groupByID(state, groupID);
    if (group === null) {
        fail(reply, `no group matches '${groupID}'`);
        return;
    }
    const repo = groupRepo(state, group);
    ok(reply, {
        group_id: uuidOut(group.id),
        group_name: group.name,
        repo: repo === null ? null : repoRef(repo),
        create_worktree: group.createWorktree
    });
}

/**
 * app-state-core.md §5.5: a group's default repository and its worktree switch.
 *
 * Request/response, unlike the rest of the group family's setters, because it can fail in ways
 * the caller has to hear about: the path is not a repository, or the switch was asked for on a
 * group with no repository to branch from. `repo` is a PATH (the CLI's natural argument, and the
 * registry row's own identity), registered when the registry lacks it; `clear` drops the repo
 * and the switch with it; `create_worktree` alone flips the switch on the current repo.
 */
function handleGroupSetRepo(
    msg: GroupSetRepoMessage,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const resolved = resolveGroupStrict(resolveStateOf(state), msg.name);
    const group = resolved === null ? null : groupByID(state, resolved.id);
    if (group === null) {
        fail(reply, `no group matches '${msg.name}'`);
        return;
    }

    if (msg.clear) {
        ctx.store.dispatch({ type: 'set-group-repo', id: group.id, repoID: null });
        deps.persist();
        replyWithGroupRepo(ctx, reply, group.id);
        return;
    }

    const repoPath = msg.repo;
    if (repoPath === undefined) {
        // The switch alone. It acts on the group's repository, so there has to be one.
        if (group.repoID === null && msg.create_worktree === true) {
            fail(
                reply,
                `group '${group.name}' has no repository to create worktrees from: set one first (kelpi group set-repo <group> <path>)`
            );
            return;
        }
        ctx.store.dispatch({
            type: 'set-group-repo',
            id: group.id,
            repoID: group.repoID,
            ...(msg.create_worktree !== undefined ? { createWorktree: msg.create_worktree } : {})
        });
        deps.persist();
        replyWithGroupRepo(ctx, reply, group.id);
        return;
    }

    void resolveRepo(ctx, deps, repoPath)
        .then((resolution) => {
            if (!resolution.ok) {
                fail(reply, resolution.error);
                return;
            }
            // The group can have gone while git answered; a registration that already landed
            // is kept (it is a real repository the user named), but nothing points at it.
            if (groupByID(ctx.store.getState(), group.id) === null) {
                deps.persist();
                fail(reply, `no group matches '${msg.name}'`);
                return;
            }
            ctx.store.dispatch({
                type: 'set-group-repo',
                id: group.id,
                repoID: resolution.repo.id,
                ...(msg.create_worktree !== undefined ? { createWorktree: msg.create_worktree } : {})
            });
            deps.persist();
            replyWithGroupRepo(ctx, reply, group.id);
        })
        .catch((error: unknown) => {
            fail(reply, error instanceof Error ? error.message : String(error));
        });
}

// ---------------------------------------------------------------------------
// group-reorder / group-sort (§7.4)
// ---------------------------------------------------------------------------

const SORT_KEYS: Readonly<Record<string, GroupSortKey>> = {
    name: 'name',
    'last-activity': 'last-activity',
    last_activity: 'last-activity',
    'last-accessed': 'last-accessed',
    last_accessed: 'last-accessed',
    'last-modified': 'last-accessed',
    last_modified: 'last-accessed'
};

function replyWithOrder(
    ctx: AppContext,
    reply: ReplyHandle | null,
    groupID: string,
    fallbackName: string
): void {
    const state = ctx.store.getState();
    const group = groupByID(state, groupID);
    ok(reply, {
        group_id: uuidOut(groupID),
        group_name: group?.name ?? fallbackName,
        order: group === null ? [] : liveMembers(state, group).map(uuidOut)
    });
}

function handleGroupReorder(
    nameOrID: string,
    explicitOrder: readonly string[] | null,
    sort: { readonly by: string; readonly descending: boolean } | null,
    ctx: AppContext,
    reply: ReplyHandle | null,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const scope = resolveStateOf(state);
    const resolved = resolveGroupStrict(scope, nameOrID);
    if (resolved === null) {
        fail(reply, `no group matches '${nameOrID}'`);
        return;
    }
    const group = groupByID(state, resolved.id);
    if (group === null) {
        fail(reply, `no group matches '${nameOrID}'`);
        return;
    }
    const members = liveMembers(state, group);

    if (explicitOrder !== null && explicitOrder.length > 0) {
        const ordered: string[] = [];
        for (const token of explicitOrder) {
            const memberID = resolveGroupMember(scope, token, members);
            if (memberID === null) {
                fail(reply, `'${token}' is not a workspace in group '${group.name}'`);
                return;
            }
            if (ordered.includes(memberID)) {
                fail(reply, `workspace '${token}' listed more than once`);
                return;
            }
            ordered.push(memberID);
        }
        ctx.store.dispatch({ type: 'reorder-group', id: group.id, order: ordered });
        deps.persist();
        replyWithOrder(ctx, reply, group.id, group.name);
        return;
    }

    if (sort !== null) {
        const key = SORT_KEYS[sort.by.toLowerCase()];
        if (key === undefined) {
            fail(reply, `unknown sort key '${sort.by}' (use name|last-activity|last-accessed)`);
            return;
        }
        ctx.store.dispatch({
            type: 'sort-group',
            id: group.id,
            by: key,
            descending: sort.descending
        });
        deps.persist();
        replyWithOrder(ctx, reply, group.id, group.name);
        return;
    }

    fail(reply, 'no order or sort key given');
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function groupHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('group-list', (_msg, ctx, reply) => {
            handleGroupList(ctx, reply);
        }),
        forCommand('group-create', (msg, ctx) => {
            handleGroupCreate(msg.name, msg.color, ctx, deps);
        }),
        forCommand('group-rename', (msg, ctx) => {
            handleGroupRename(msg.name, msg.new_name, ctx, deps);
        }),
        forCommand('group-delete', (msg, ctx, reply) => {
            handleGroupDelete(msg.name, msg.cascade, ctx, reply, deps);
        }),
        forCommand('group-move', (msg, ctx) => {
            handleGroupMove(msg.name, msg.index, ctx, deps);
        }),
        forCommand('group-set-repo', (msg, ctx, reply) => {
            handleGroupSetRepo(msg, ctx, reply, deps);
        }),
        forCommand('group-reorder', (msg, ctx, reply) => {
            handleGroupReorder(msg.name, msg.order, null, ctx, reply, deps);
        }),
        forCommand('group-sort', (msg, ctx, reply) => {
            handleGroupReorder(
                msg.name,
                null,
                { by: msg.by, descending: msg.descending },
                ctx,
                reply,
                deps
            );
        })
    ];
}
