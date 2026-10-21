/**
 * `pane-send`, `pane-send-key` and `pane-capture` (socket-handlers.md §4.5–§4.7).
 *
 * `send` / `send-key` ack after RESOLUTION but before DELIVERY, so the CLI learns the resolved
 * pane id even if the write races a close. `send-key` validates the key name BEFORE resolving,
 * so an unknown key never touches a pane, and answers with a structured error rather than
 * dropping the message. `capture` is the one pane command with an async read.
 *
 * Screen revision (#390): `capture` reports the pane's revision with the text it read, and a
 * `send` / `send-key` carrying `if_revision` writes only while the revision is still that one.
 * The comparison and the write share one synchronous turn, and the capture flushed before
 * reading text and revision together, so any byte fed after the capture's read refuses the send.
 */

import { parseNamedKey, unknownNamedKeyError } from '@kelpi/protocol';

import type { CommandHandler, ReplyHandle } from '../../seams.js';
import type { ScreenCursor } from '../../term/service.js';
import { isKeystroke } from '../../pty/input.js';
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
    const guard = checkRevision(ctx, paneID, msg.if_revision);
    if (!guard.ok) {
        sendError(reply, 'screen changed', { code: 'SCREEN_CHANGED', revision: guard.revision });
        return;
    }

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        bare: msg.bare,
        ...guard.ack,
        ...labelField(pane.label)
    });

    // `--bare` writes the text alone; otherwise Enter follows as a separate keystroke
    // (outside any bracketed-paste envelope) so a TUI treats it as a real submit.
    ctx.input.sendText(paneID, msg.text, { bare: msg.bare });
};

export const handlePaneSendKey: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-send-key') return;
    // Validation FIRST (§4.6): an unknown key must never resolve (or touch) a pane. Besides the
    // named keys, one printable character is a key too: the phone's quick replies answer an
    // agent's menu with its hotkey, which `pane-send` would deliver as a paste.
    const named = parseNamedKey(msg.key);
    const keystroke = named === undefined && isKeystroke(msg.key) ? msg.key : undefined;
    if (named === undefined && keystroke === undefined) {
        sendError(reply, unknownNamedKeyError(msg.key));
        return;
    }

    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;
    const guard = checkRevision(ctx, paneID, msg.if_revision);
    if (!guard.ok) {
        sendError(reply, 'screen changed', { code: 'SCREEN_CHANGED', revision: guard.revision });
        return;
    }

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        key: named ?? keystroke,
        ...guard.ack,
        ...labelField(pane.label)
    });

    if (named !== undefined) ctx.input.sendNamedKey(paneID, named);
    else if (keystroke !== undefined) ctx.input.sendKeystroke(paneID, keystroke);
};

type RevisionGuard =
    | { readonly ok: true; readonly ack: { revision?: number } }
    | { readonly ok: false; readonly revision: number };

/**
 * `if_revision` against the pane's revision right now. Absent passes with nothing to add to the
 * ack, so an unguarded send replies exactly as it always has; a match adds `revision`, which is
 * how a caller tells a daemon that checked from one that ignored the field.
 */
function checkRevision(ctx: PaneHandlerContext, paneID: string, expected: number | undefined): RevisionGuard {
    if (expected === undefined) return { ok: true, ack: {} };
    const revision = ctx.term.revision?.(paneID) ?? 0;
    return revision === expected ? { ok: true, ack: { revision } } : { ok: false, revision };
}

export const handlePaneCapture: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-capture') return;
    // A pure read: without a handle there is nothing to do and nothing to drop.
    if (reply === null) return;

    // 1. `lines` guard runs before resolution (raw socket clients can send anything).
    if (msg.lines !== undefined && msg.lines <= 0) {
        sendError(reply, `lines must be a positive integer (got ${msg.lines})`);
        return;
    }
    // ...and so does `settle_ms` (#390). Above the cap is not an error: the service clamps it.
    if (msg.settle_ms !== undefined && msg.settle_ms <= 0) {
        sendError(reply, `settle_ms must be a positive integer (got ${msg.settle_ms})`);
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
        lines: msg.lines,
        settleMs: msg.settle_ms
    });
};

interface CaptureRequest {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly workspaceName: string;
    readonly label: string | null;
    readonly scrollback: boolean;
    readonly lines: number | undefined;
    readonly settleMs: number | undefined;
}

/**
 * The async half: wait for the pane to settle when asked, flush the pane's pending VT writes and
 * read the viewport (or the whole buffer with `--scrollback`) with its revision and cursor in the
 * same turn (`readScreen`), then tail it. A pane that vanished mid-read is the one race §4.7
 * names explicitly.
 */
async function readCapture(
    ctx: PaneHandlerContext,
    reply: ReplyHandle,
    request: CaptureRequest
): Promise<void> {
    const { term } = ctx;
    const opts = { scrollback: request.scrollback };
    let settled: boolean | undefined;
    let text: string;
    let revision: number;
    let cursor: ScreenCursor | null;
    try {
        if (request.settleMs !== undefined) {
            settled = term.settle === undefined ? true : await term.settle(request.paneID, request.settleMs);
        }
        if (typeof term.readScreen === 'function') {
            // The flush's last "queue empty" check and the read share one turn: a byte fed after
            // the flush cannot be counted in the revision without being in the text.
            ({ text, revision, cursor } = await term.readScreen(request.paneID, opts));
        } else {
            // Seams without `readScreen`: a feed in the hop after the flush can still be counted
            // and not shown, which only the real service's `readScreen` closes.
            if (typeof term.flush === 'function') {
                await term.flush(request.paneID);
                text = term.capture(request.paneID, opts);
            } else {
                text =
                    typeof term.captureAsync === 'function'
                        ? await term.captureAsync(request.paneID, opts)
                        : term.capture(request.paneID, opts);
            }
            revision = term.revision?.(request.paneID) ?? 0;
            cursor = term.screenCursor?.(request.paneID) ?? null;
        }
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
        revision,
        cursor: { row: cursor?.row ?? 0, col: cursor?.col ?? 0 },
        alt_screen: cursor?.alternate ?? false,
        ...(settled === undefined ? {} : { settled }),
        ...labelField(request.label)
    });
}

function capturePaneGone(ctx: PaneHandlerContext, paneID: string): boolean {
    return workspaceOfVisiblePane(ctx.store.getState(), paneID) === null;
}
