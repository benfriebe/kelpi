/**
 * §TERM-046 — what the daemon does with a parsed OSC 52.
 *
 * The sibling of `./osc-notifications.ts`, and deliberately shaped the same way: a factory that
 * takes its state reads and its broadcast as dependencies, so the decision can be exercised
 * without standing a daemon up, and so it is not a closure buried in `compose.ts` where nothing
 * can reach it. `term/osc52.ts` decides what a sequence *is*; this decides what happens to it.
 *
 * Four outcomes, and every one of them logs:
 *
 *   - **a write, with `clipboard-write` on** → broadcast to every attached client, which is the
 *     bridge: the PTY is on the daemon's machine, the clipboard is on the client's
 *     (terminal-surface.md §12's port note). Logged with the pane id and the byte count —
 *     **never the content**, which is the whole point of carrying `bytes` on the message.
 *   - **a write, with `clipboard-write` off (the default)** → dropped, with one line that names
 *     the setting. A silent drop here is indistinguishable from a broken pipe, and the first
 *     thing anyone does when a copy "doesn't work" is look at the log.
 *   - **a read (`OSC 52 ; c ; ?`)** → refused, always, with no reply. There is no setting that
 *     turns this on. Note what is NOT here: no PTY write, no `reply`, no sink of any kind that
 *     could carry bytes back to the program that asked. The refusal is structural — this module
 *     has no way to answer even if it wanted to.
 *   - **anything else** (a selection this port does not honour, a payload over the cap, garbage
 *     base64, a malformed sequence) → dropped with the reason.
 *
 * The gate is read through a CALLBACK rather than captured, which is the live-apply path: the
 * value is taken at the moment the sequence arrives, so a Settings toggle (or a hand edit of
 * `~/.config/kelpi/config`) governs the very next OSC 52 with no restart, exactly as
 * `auto-detect-repos` does for the repo watcher.
 */

import { findPaneAnywhere, workspaceByID, type DaemonState } from '../../store/index.js';
import type { Osc52Request } from '../../term/index.js';

export interface ClipboardWriteSinkDeps {
    readonly getState: () => DaemonState;
    /** The `clipboard-write` setting, read LIVE (see the header) — never captured. */
    readonly enabled: () => boolean;
    readonly broadcast: (message: Record<string, unknown>) => void;
    /** The daemon's log line. Given the pane id and a size, never the text. */
    readonly log: (message: string) => void;
}

export type ClipboardWriteSink = (paneID: string, request: Osc52Request) => void;

/** The config key, spelled once so the log line and the setting cannot drift apart. */
export const CLIPBOARD_WRITE_SETTING = 'clipboard-write';

/** Why a sequence was dropped, in words a log reader can act on. */
const IGNORE_REASONS: Record<string, string> = {
    malformed: 'malformed sequence (expected `OSC 52 ; <selection> ; <base64>`)',
    selection: 'unsupported selection (only the clipboard selection is honoured)',
    'not-base64': 'payload is not base64',
    'too-large': 'payload over the size cap',
    empty: 'empty payload (a clipboard CLEAR, which kelpi declines)'
};

export function createClipboardWriteSink(deps: ClipboardWriteSinkDeps): ClipboardWriteSink {
    return (paneID, request) => {
        if (request.kind === 'read') {
            // The one line this whole item exists for. No reply is sent — not here, not
            // anywhere: a terminal that answers hands the developer's clipboard to whatever is
            // running in the pane, which in this architecture can be an agent or a shell on
            // another machine.
            deps.log(
                `clipboard: OSC 52 READ refused for pane ${paneID} (selection ${describeSelection(request.selection)}) — kelpi never answers a clipboard read`
            );
            return;
        }
        if (request.kind === 'ignored') {
            deps.log(
                `clipboard: OSC 52 from pane ${paneID} ignored — ${IGNORE_REASONS[request.reason] ?? request.reason}` +
                    ` (selection ${describeSelection(request.selection)}, ${String(request.encodedLength)} encoded bytes)`
            );
            return;
        }

        if (!deps.enabled()) {
            deps.log(
                `clipboard: OSC 52 write from pane ${paneID} dropped (${String(request.bytes)} bytes) — set \`${CLIPBOARD_WRITE_SETTING} = true\` in the kelpi config, or turn on Settings ▸ Workspaces ▸ “Let programs write the clipboard”, to allow it`
            );
            return;
        }

        // Routing is the notification path's, parked panes included: a pane in a BACKGROUND
        // workspace can copy, because a `pane send` into it is a perfectly ordinary thing to do
        // and the copy is no less legitimate for the window being elsewhere.
        const state = deps.getState();
        const location = findPaneAnywhere(state, paneID);
        if (location === null) {
            deps.log(`clipboard: OSC 52 write from unknown pane ${paneID} dropped`);
            return;
        }
        const workspace = workspaceByID(state, location.workspaceID);
        if (workspace === null) {
            deps.log(`clipboard: OSC 52 write from pane ${paneID} dropped (no workspace)`);
            return;
        }

        deps.broadcast({
            type: 'clipboard-write',
            paneID,
            workspaceID: workspace.id,
            text: request.text,
            bytes: request.bytes
        });
        deps.log(`clipboard: OSC 52 write from pane ${paneID} → ${String(request.bytes)} bytes to attached clients`);
    };
}

/** `''` is the omitted selection field, which ghostty reads as the clipboard. */
function describeSelection(selection: string): string {
    return selection === '' ? '(default)' : `'${selection}'`;
}
