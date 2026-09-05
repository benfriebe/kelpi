/**
 * `pane-split` and `pane-create` (socket-handlers.md §4.1, §4.2).
 *
 * Both share the three-way routing table and the reply-before-effect ack with a PRE-MINTED
 * pane id: the acked id is threaded into the dispatch so the pane that appears really is the
 * one the CLI printed. Nothing awaits between the mint and the dispatch.
 *
 * The only differences: `pane-create` has no `direction` (always horizontal), its
 * `--workspace`-alone branch tolerates an empty workspace (routing to the create-first-pane
 * action, which is the case a split cannot serve), and its outside-caller error names
 * `create` instead of `split`.
 */

import { resolveWorkspaceStrict } from '@kelpi/core/resolve';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import { resolveStateOf, workspaceByID, type WorkspaceState } from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import {
    labelField,
    mintPaneID,
    nowMillis,
    refreshSyncGroup,
    resolveTarget,
    sendError,
    sendOK,
    spawnPaneIfShell
} from './support.js';

type CreationVerb = 'split' | 'create';

interface CreationRoute {
    readonly workspace: WorkspaceState;
    /** The pane to split; null only on the `pane-create` empty-workspace route. */
    readonly sourcePaneID: string | null;
}

type RouteResult = { readonly ok: true; readonly route: CreationRoute } | { readonly ok: false; readonly error: string };

/**
 * §4.1 routing precedence, identical for both verbs:
 *
 *   `--workspace` WITHOUT `--target` picks the destination workspace outright; it beats the
 *   caller's forwarded `KELPI_PANE_ID`, so a pane in workspace alpha can create into beta.
 *   Otherwise `--target`/`KELPI_PANE_ID` go through `resolvePaneTarget` (which scopes a label
 *   by `--workspace`). With none of the three the caller is outside Kelpi and gets a usage error.
 */
function routeCreation(
    ctx: PaneHandlerContext,
    fields: { pane_id?: string | undefined; target?: string | undefined; workspace?: string | undefined },
    verb: CreationVerb
): RouteResult {
    const state = ctx.store.getState();
    const filter = fields.workspace;

    if (fields.target === undefined && filter !== undefined) {
        const resolved = resolveWorkspaceStrict(resolveStateOf(state), filter);
        if (resolved === null) return { ok: false, error: `workspace not found: ${filter}` };
        const workspace = workspaceByID(state, resolved.id);
        // Defensive re-lookup (§4.1): the workspace could have gone away underneath us.
        if (workspace === null) return { ok: false, error: 'workspace not found' };
        const sourcePaneID = workspace.focusedPaneID ?? workspace.panes[0]?.id ?? null;
        if (verb === 'split' && sourcePaneID === null) {
            return {
                ok: false,
                error: `workspace '${workspace.name}' has no pane to split — use \`kelpi pane create --workspace ${filter}\``
            };
        }
        return { ok: true, route: { workspace, sourcePaneID } };
    }

    if (fields.target !== undefined || fields.pane_id !== undefined) {
        const resolution = resolveTarget(ctx, fields);
        if (!resolution.ok) return { ok: false, error: resolution.error };
        return {
            ok: true,
            route: { workspace: resolution.workspace, sourcePaneID: resolution.paneID }
        };
    }

    return {
        ok: false,
        error: `pane ${verb} requires --target or --workspace when called from outside a Kelpi pane`
    };
}

/** The shared ack: the pre-minted id, the destination workspace, and `--name` when given. */
function ackCreation(
    reply: ReplyHandle | null,
    newPaneID: string,
    workspace: WorkspaceState,
    name: string | undefined
): void {
    sendOK(reply, {
        pane_id: newPaneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(name)
    });
}

export const handlePaneSplit: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-split') return;
    const routed = routeCreation(ctx, msg, 'split');
    if (!routed.ok) {
        sendError(reply, routed.error);
        return;
    }
    const { workspace } = routed.route;
    const sourcePaneID = routed.route.sourcePaneID;
    /* c8 ignore next 5 -- unreachable: every `split` route either resolves a source or errors */
    if (sourcePaneID === null) {
        sendError(reply, 'workspace not found');
        return;
    }

    const newPaneID = mintPaneID(ctx);
    const now = nowMillis(ctx);
    const direction = msg.direction ?? 'horizontal';

    // The split-at-path action splits the FOCUSED pane, so focus moves first, and that focus
    // change is deliberately user-visible (§4.1 step 2).
    ctx.store.dispatch({ type: 'focus-pane', workspaceID: workspace.id, paneID: sourcePaneID });
    ackCreation(reply, newPaneID, workspace, msg.name);

    if (msg.path !== undefined) {
        ctx.store.dispatch({
            type: 'split-pane-at-path',
            workspaceID: workspace.id,
            paneID: newPaneID,
            path: msg.path,
            direction,
            label: msg.name ?? null,
            now
        });
    } else {
        ctx.store.dispatch({
            type: 'split-pane',
            workspaceID: workspace.id,
            paneID: newPaneID,
            direction,
            sourcePaneID,
            label: msg.name ?? null,
            now
        });
    }

    spawnPaneIfShell(ctx, workspace.id, newPaneID);
    refreshSyncGroup(ctx, workspace.id);
};

export const handlePaneCreate: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-create') return;
    const routed = routeCreation(ctx, msg, 'create');
    if (!routed.ok) {
        sendError(reply, routed.error);
        return;
    }
    const { workspace } = routed.route;

    const newPaneID = mintPaneID(ctx);
    const now = nowMillis(ctx);
    ackCreation(reply, newPaneID, workspace, msg.name);

    const sourcePaneID =
        routed.route.sourcePaneID ?? workspace.focusedPaneID ?? workspace.panes[0]?.id ?? null;

    if (sourcePaneID === null) {
        // EMPTY workspace: the create-first-pane route, carrying the acked id plus `--name`
        // and `--path` so the acked pane actually has them (§4.2 step 3).
        ctx.store.dispatch({
            type: 'create-pane',
            workspaceID: workspace.id,
            paneID: newPaneID,
            label: msg.name ?? null,
            workingDirectory: msg.path ?? null,
            now
        });
    } else {
        ctx.store.dispatch({
            type: 'focus-pane',
            workspaceID: workspace.id,
            paneID: sourcePaneID
        });
        if (msg.path !== undefined) {
            ctx.store.dispatch({
                type: 'split-pane-at-path',
                workspaceID: workspace.id,
                paneID: newPaneID,
                path: msg.path,
                direction: 'horizontal',
                label: msg.name ?? null,
                now
            });
        } else {
            ctx.store.dispatch({
                type: 'split-pane',
                workspaceID: workspace.id,
                paneID: newPaneID,
                direction: 'horizontal',
                sourcePaneID,
                label: msg.name ?? null,
                now
            });
        }
    }

    spawnPaneIfShell(ctx, workspace.id, newPaneID);
    refreshSyncGroup(ctx, workspace.id);
};
