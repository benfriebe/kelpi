/**
 * `pane-close` and `pane-name` (socket-handlers.md §4.3, §4.4).
 *
 * Neither guards on running agents: closing a pane with a live agent is allowed (only
 * `workspace-delete` has the active-agent refusal). The close ack is sent before the pane
 * actually goes away; the close action itself owns layout removal, focus fallback and the
 * parked-pane un-park branch.
 */

import type { CommandHandler } from '../../seams.js';
import type { PaneHandlerContext } from './context.js';
import {
    labelField,
    refreshSyncGroup,
    resolveTarget,
    sendError,
    sendOK
} from './support.js';

export const handlePaneClose: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-close') return;
    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(pane.label)
    });

    ctx.store.dispatch({ type: 'close-pane', workspaceID: workspace.id, paneID });
    // Surface teardown: killing is idempotent and never serializes (SIGHUP → grace → SIGKILL),
    // and a non-terminal pane has neither a PTY nor terminal state to release.
    ctx.pty.kill(paneID);
    ctx.term.dispose(paneID);
    refreshSyncGroup(ctx, workspace.id);
};

export const handlePaneName: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-name') return;
    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, workspace } = resolution;
    // An empty name CLEARS the label. (The wire decoder rejects an empty `name` today, so this
    // branch is only reachable from a hand-rolled client, but keep it: it is the Swift semantic.)
    const newLabel = msg.name === '' ? null : msg.name;

    ctx.store.dispatch({
        type: 'set-pane-label',
        workspaceID: workspace.id,
        paneID,
        label: newLabel
    });

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(newLabel)
    });
};
