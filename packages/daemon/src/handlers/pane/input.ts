/**
 * `pane-send`, `pane-send-key` and `pane-capture` (socket-handlers.md §4.5–§4.7).
 *
 * `send` / `send-key` ack after RESOLUTION but before DELIVERY, so the CLI learns the resolved
 * pane id even if the write races a close. `send-key` validates the key name BEFORE resolving,
 * so an unknown key never touches a pane, and answers with a structured error rather than
 * dropping the message. `capture` is the one pane command with an async read.
 */

import { parseNamedKey, unknownNamedKeyError } from '@nex/protocol';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import type { PaneHandlerContext } from './context.js';
import {
    labelField,
    resolveTarget,
    sendError,
    sendOK,
    tailLines,
    workspaceOfVisiblePane
} from './support.js';

export const handlePaneSend: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-send') return;
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
        bare: msg.bare,
        ...labelField(pane.label)
    });

    // `--bare` writes the text alone; otherwise Enter follows as a separate keystroke
    // (outside any bracketed-paste envelope) so a TUI treats it as a real submit.
    ctx.input.sendText(paneID, msg.text, { bare: msg.bare });
};

export const handlePaneSendKey: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-send-key') return;
    // Validation FIRST (§4.6): an unknown key must never resolve (or touch) a pane.
    const named = parseNamedKey(msg.key);
    if (named === undefined) {
        sendError(reply, unknownNamedKeyError(msg.key));
        return;
    }

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
        key: named,
        ...labelField(pane.label)
    });

    ctx.input.sendNamedKey(paneID, named);
};

export const handlePaneCapture: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-capture') return;
    // A pure read: without a handle there is nothing to do and nothing to drop.
    if (reply === null) return;

    // 1. `lines` guard runs before resolution (raw socket clients can send anything).
    if (msg.lines !== undefined && msg.lines <= 0) {
        sendError(reply, `lines must be a positive integer (got ${msg.lines})`);
        return;
    }
    // 2–3. Resolve, then the defensive pane lookup.
    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;
    // 4. Only shell panes own a terminal; the raw pane type is part of the message.
    if (pane.type !== 'shell') {
        sendError(reply, `pane is not a terminal (type: ${pane.type})`);
        return;
    }

    // 5. A pane whose first spawn is still waiting for a client's geometry has no server-side
    // terminal yet, and a capture is a demand for one: run that spawn now rather than
    // answering with an empty screen (`pty/spawn-gate.ts`). A no-op for every other pane.
    ctx.spawn?.flushSpawn?.(paneID);

    void readCapture(ctx, reply, {
        paneID,
        workspaceID: workspace.id,
        workspaceName: workspace.name,
        label: pane.label,
        scrollback: msg.scrollback,
        lines: msg.lines
    });
};

interface CaptureRequest {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly workspaceName: string;
    readonly label: string | null;
    readonly scrollback: boolean;
    readonly lines: number | undefined;
}

/**
 * The async half: flush the pane's pending VT writes, read the viewport (or the whole buffer
 * with `--scrollback`), then tail it. A pane that vanished mid-read is the one race §4.7 names
 * explicitly.
 */
async function readCapture(
    ctx: PaneHandlerContext,
    reply: ReplyHandle,
    request: CaptureRequest
): Promise<void> {
    const { term } = ctx;
    let text: string;
    try {
        text =
            typeof term.captureAsync === 'function'
                ? await term.captureAsync(request.paneID, { scrollback: request.scrollback })
                : term.capture(request.paneID, { scrollback: request.scrollback });
    } catch (error) {
        // A read that throws is either the surface-died race (§4.7's named error) or an
        // emulator fault; either way the client must get a line, or it waits for an EOF that
        // never comes.
        sendError(
            reply,
            capturePaneGone(ctx, request.paneID)
                ? 'pane closed during capture'
                : `pane capture failed: ${String(error)}`
        );
        return;
    }

    if (capturePaneGone(ctx, request.paneID)) {
        sendError(reply, 'pane closed during capture');
        return;
    }

    const tailed = request.lines === undefined ? text : tailLines(text, request.lines);
    sendOK(reply, {
        pane_id: request.paneID,
        workspace_id: request.workspaceID,
        workspace_name: request.workspaceName,
        text: tailed,
        ...labelField(request.label)
    });
}

function capturePaneGone(ctx: PaneHandlerContext, paneID: string): boolean {
    return workspaceOfVisiblePane(ctx.store.getState(), paneID) === null;
}
