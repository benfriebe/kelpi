/**
 * `group-*` command handlers (socket-handlers.md §7).
 *
 * `group-list` / `group-reorder` / `group-sort` are request/response; `group-create` /
 * `group-rename` / `group-delete` are fire-and-forget (an unresolvable name is a silent no-op).
 *
 * The reorder/sort pair share one handler: both rewrite the group's `childOrder`, both preserve
 * ids whose workspace vanished at the TAIL of the stored order, and both reply with the LIVE
 * members only (§7.4 step 7).
 */

import { groupSidebarID } from '@kelpi/core/codec';
import { resolveGroupMember, resolveGroupStrict } from '@kelpi/core/resolve';
import type { WorkspaceColor } from '@kelpi/protocol';

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
        return [
            {
                id: uuidOut(group.id),
                name: group.name,
                ...(group.color !== null ? { color: group.color } : {}),
                workspaces
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
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const resolved = resolveGroupStrict(resolveStateOf(state), nameOrID);
    if (resolved === null) return;
    const group = groupByID(state, resolved.id);
    if (group === null) return;

    if (cascade) {
        // Cascade destroys the member workspaces' surfaces too (app-state-core §5.4).
        for (const memberID of group.childOrder) {
            const workspace = workspaceByID(state, memberID);
            if (workspace === null) continue;
            for (const pane of [...workspace.panes, ...workspace.parkedPanes]) {
                deps.killPane(pane.id, ctx);
            }
        }
    }
    ctx.store.dispatch({ type: 'delete-group', id: group.id, cascade });
    if (cascade) for (const memberID of group.childOrder) refreshSyncGroup(ctx, memberID);
    deps.persist();
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
        forCommand('group-delete', (msg, ctx) => {
            handleGroupDelete(msg.name, msg.cascade, ctx, deps);
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
