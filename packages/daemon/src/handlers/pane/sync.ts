/**
 * `pane-sync` (`on|off|toggle|status`) and `pane-sync-exclude` (socket-handlers.md §4.13–14).
 *
 * Workspace scope here is deliberately NOT `resolvePaneTarget`: an explicit `--workspace`
 * wins, otherwise the caller's pane is located with the PARKED-INCLUSIVE lookup (a parked
 * shell still belongs to a workspace).
 *
 * PLAN.md deliberate fix: the reply is computed from POST-mutation state rather than the
 * Swift app's predicted snapshot. The two differ only in the corner case the spec calls out
 * (exclusions staged while sync was off, then `sync on`), where the prediction reports
 * exclusions the reducer has already cleared, i.e. the prediction lies.
 */

import { resolveWorkspaceStrict } from '@nex/core/resolve';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import {
    resolveStateOf,
    syncedPaneIDs,
    visiblePane,
    workspaceByID,
    workspaceContainingPane,
    type WorkspaceState
} from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import { labelField, refreshSyncGroup, resolveTarget, sendError, sendOK } from './support.js';

const SYNC_SCOPE_ERROR = 'pane sync requires --workspace or NEX_PANE_ID';

/** The shape shared by `status`, `on/off/toggle` and `exclude/include`. */
function syncSnapshot(workspace: WorkspaceState): Record<string, unknown> {
    const excluded = [...workspace.syncInputExcluded]
        .sort()
        .flatMap((paneID) => {
            // An excluded id with no live pane is skipped (a closed pane leaves the set behind).
            const pane = visiblePane(workspace, paneID);
            if (pane === null) return [];
            return [{ id: paneID, ...labelField(pane.label) }];
        });
    return {
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        active: workspace.isSyncInputActive,
        synced_pane_ids: [...syncedPaneIDs(workspace)].sort(),
        excluded
    };
}

export const handlePaneSync: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-sync') return;
    const state = ctx.store.getState();

    let workspace: WorkspaceState | null;
    if (msg.workspace !== undefined) {
        const resolved = resolveWorkspaceStrict(resolveStateOf(state), msg.workspace);
        workspace = resolved === null ? null : workspaceByID(state, resolved.id);
        if (workspace === null) {
            sendError(reply, `workspace not found: ${msg.workspace}`);
            return;
        }
    } else if (msg.pane_id !== undefined) {
        workspace = workspaceContainingPane(state, msg.pane_id);
        if (workspace === null) {
            sendError(reply, SYNC_SCOPE_ERROR);
            return;
        }
    } else {
        sendError(reply, SYNC_SCOPE_ERROR);
        return;
    }

    const action = msg.action.toLowerCase();
    if (action === 'status') {
        sendOK(reply, syncSnapshot(workspace));
        return;
    }

    let nextActive: boolean;
    if (action === 'on') nextActive = true;
    else if (action === 'off') nextActive = false;
    else if (action === 'toggle') nextActive = !workspace.isSyncInputActive;
    else {
        sendError(reply, `unknown sync action '${action}' (valid: on, off, toggle, status)`);
        return;
    }

    ctx.store.dispatch({
        type: 'set-sync-input-active',
        workspaceID: workspace.id,
        active: nextActive
    });
    replyWithCurrentSync(ctx, reply, workspace.id);
};

export const handlePaneSyncExclude: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-sync-exclude') return;
    // Same scoping as `pane send`: UUID targets are global, labels need a workspace scope.
    const resolution = resolveTarget(ctx, {
        pane_id: msg.pane_id,
        target: msg.target,
        workspace: msg.workspace
    });
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }

    ctx.store.dispatch({
        type: 'set-sync-input-excluded',
        workspaceID: resolution.workspace.id,
        paneID: resolution.paneID,
        excluded: msg.excluded
    });
    replyWithCurrentSync(ctx, reply, resolution.workspace.id);
};

function replyWithCurrentSync(
    ctx: PaneHandlerContext,
    reply: ReplyHandle | null,
    workspaceID: string
): void {
    const workspace = workspaceByID(ctx.store.getState(), workspaceID);
    /* c8 ignore next 4 -- the workspace was resolved microseconds ago on the same tick */
    if (workspace === null) {
        sendError(reply, 'workspace not found');
        return;
    }
    sendOK(reply, syncSnapshot(workspace));
    refreshSyncGroup(ctx, workspaceID);
}
