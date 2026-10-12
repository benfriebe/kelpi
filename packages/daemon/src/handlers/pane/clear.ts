/**
 * `pane-clear`: a terminal pane's screen and scrollback, cleared (⌘K, `clear_screen`).
 *
 * The clearing is `term/clear-screen.ts`'s, composed by boot: it has to read the daemon's own
 * emulator, ask the OS whether the shell is at its prompt and write into the pane's output
 * stream, none of which a handler reaches on its own. This is the guard chain and the reply.
 *
 * `cleared: false` is an answer, not an error: on the alternate screen the clear deliberately
 * does nothing (a full-screen app owns the grid, as in Ghostty). The window does not normally
 * ask then (`client/src/app/clear-screen.ts`); this covers a renderer that could not tell.
 */

import { isTerminalPane, isUsingExternalEditor } from '@kelpi/core/layout';

import type { CommandHandler } from '../../seams.js';
import type { PaneHandlerContext } from './context.js';
import { labelField, resolveTarget, sendError, sendOK } from './support.js';

export const handlePaneClear: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-clear') return;
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
    const clear = ctx.clearScreen;
    if (clear === undefined) {
        sendError(reply, 'clearing a pane is not available on this daemon');
        return;
    }

    const answer = {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(pane.label)
    };
    void clear(paneID).then(
        (outcome) => {
            sendOK(reply, outcome.cleared ? { ...answer, cleared: true } : { ...answer, cleared: false, reason: outcome.reason });
        },
        (error: unknown) => {
            sendError(reply, `pane clear failed: ${String(error)}`);
        }
    );
};
