/**
 * The `restart-pane-agent` channel behind the pane header's restart button.
 *
 * agent-lifecycle.md §6.2: restarting an agent means typing its resume command into the pane —
 * `claude --resume <id>` or `codex resume <id>`, picked by the pane's last-known `agentKind`.
 * That is the same shape the boot-time restore uses (`boot/resume.ts`), and it reuses the same
 * two guards for the same reason:
 *
 *   - **`resumeCommand` applies `isSafeSessionID`.** The id arrived over a local socket and is
 *     about to be typed into a shell, so an id outside the allowlist is refused rather than
 *     interpolated (persisted command injection).
 *   - **The PTY must be alive.** Writing to a pane whose process is gone would silently do
 *     nothing; the caller gets an error it can show instead.
 *
 * Deliberately NOT a store mutation: no status is forced, no session id is cleared. The agent's
 * own hooks report what happens next, exactly as they do for a resume at boot.
 */

import { displayAgentKind, resumeCommand } from '@nex/core/agent';

import type { DomainStore, PtyManager, TerminalInput } from '../seams.js';
import { findPaneAnywhere } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/types.js';
import type { AgentChannel, AgentRestartResult } from './sync.js';

export interface AgentChannelOptions {
    readonly store: DomainStore<DaemonState, DomainAction, DomainEvent>;
    /** Liveness only; the bytes go through `input`, which never mirrors to sync siblings. */
    readonly pty: Pick<PtyManager, 'has'>;
    readonly input: Pick<TerminalInput, 'sendText'>;
}

export function createAgentChannel(options: AgentChannelOptions): AgentChannel {
    return {
        restart(paneID: string): AgentRestartResult {
            const found = findPaneAnywhere(options.store.getState(), paneID);
            if (found === null) return { ok: false, error: `no pane matches '${paneID}'` };
            const pane = found.pane;
            if (pane.type !== 'shell') {
                return { ok: false, error: `pane '${paneID}' is a ${pane.type} pane, not a terminal` };
            }
            if (pane.agentSessionID === null) {
                return { ok: false, error: `pane '${paneID}' has no agent session to restart` };
            }
            const kind = displayAgentKind(pane.agentKind);
            const command = resumeCommand(kind, pane.agentSessionID);
            if (command === null) {
                return { ok: false, error: `pane '${paneID}' has an unsafe agent session id` };
            }
            if (!options.pty.has(paneID)) {
                return { ok: false, error: `pane '${paneID}' has no live terminal process` };
            }
            options.input.sendText(paneID, command, { bare: false });
            return { ok: true, paneID, workspaceID: found.workspaceID, agent: kind, command };
        }
    };
}
