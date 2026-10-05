/**
 * `pane-font-size`: a terminal pane's own text size (config-keybindings.md §7.6).
 *
 * The size lives on the pane in daemon state, not in the client, so every viewer of the pane
 * draws it the same size (they share one PTY, whose cols/rows follow the cell size) and a
 * kelpi-to-kelpi session can set it like any other pane field. `reset` drops the pane's own
 * size; the pane then follows the daemon-wide ghostty `font-size` again.
 *
 * The client owns the arithmetic: it knows the default the pane is following and the size it
 * last asked for while a held-down chord's earlier steps are still in flight, so the wire
 * carries a finished size rather than a step.
 */

import { isTerminalPane, isUsingExternalEditor } from '@kelpi/core/layout';

import type { CommandHandler } from '../../seams.js';
import type { PaneHandlerContext } from './context.js';
import { labelField, resolveTarget, sendError, sendOK } from './support.js';

export const handlePaneFontSize: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-font-size') return;
    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;
    // A shell, or a markdown pane while an external `$EDITOR` runs in it: what renders a terminal.
    if (!isTerminalPane(pane) && !isUsingExternalEditor(pane)) {
        sendError(reply, `pane ${paneID} is not a terminal pane`);
        return;
    }

    const size = msg.reset ? null : (msg.size ?? null);
    ctx.store.dispatch({ type: 'set-terminal-font-size', workspaceID: workspace.id, paneID, size });

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(pane.label),
        font_size: size
    });
};
