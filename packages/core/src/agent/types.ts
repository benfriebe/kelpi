/**
 * Agent state model.
 * Spec: docs/agent-lifecycle.md §1, workspace-feature.md §7.10.
 */

/** Serialized verbatim (DB `status` column and `pane list --json`'s `status`). */
export type PaneStatus = 'idle' | 'running' | 'waitingForInput';

export type AgentKind = 'claude' | 'codex';

/** Status is a shell-pane-only concept; the manual override guards on this. */
export type PaneKind = 'shell' | 'markdown' | 'scratchpad' | 'diff' | 'web';

export interface PaneAgentState {
    readonly status: PaneStatus;
    /** Persisted; cleared on load after resume tuples are captured. */
    readonly agentSessionID: string | null;
    /** Persisted; NEVER cleared on load - last-known display value. */
    readonly agentKind: AgentKind | null;
    /**
     * Persisted; the EFFECTIVE profile name (`KELPI_PROFILE`, e.g. `"default"` / `"work"`)
     * the session was launched under, reported by the `kelpi event` hook. Null = unknown
     * (legacy CLI / pre-upgrade row), which resume treats as "use the workspace's profile".
     * Never cleared on load, and a session-start without profile info keeps the previous one
     * (same PTY, same environment). Unlike `agentKind` it is NOT display state: it exists to
     * rebuild the resume environment, so a matching session-end clears it beside the id — a
     * profile with no session to resume must not pin the pane's next spawn
     * (agent-lifecycle.md §6.3).
     */
    readonly agentProfileName: string | null;
    /** Transient wall-clock start (epoch ms) of the current run; powers the elapsed badge. */
    readonly agentStartedAt: number | null;
    /** Transient count of in-flight background shells/subagents (issues #215/#220). */
    readonly backgroundTaskCount: number;
}

export const initialPaneAgentState: PaneAgentState = {
    status: 'idle',
    agentSessionID: null,
    agentKind: null,
    agentProfileName: null,
    agentStartedAt: null,
    backgroundTaskCount: 0
};

export type AgentEvent =
    | { readonly type: 'agentStarted'; readonly agent: AgentKind }
    | { readonly type: 'agentStopped'; readonly backgroundTaskCount: number }
    | { readonly type: 'agentError'; readonly message?: string | undefined }
    | {
          readonly type: 'notification';
          readonly title: string;
          readonly body: string;
          readonly backgroundTaskCount: number;
      }
    | {
          readonly type: 'sessionStarted';
          readonly sessionID: string;
          readonly agent: AgentKind;
          /**
           * The `KELPI_PROFILE` value the hook observed in the agent's own environment.
           * Absent/empty = an older CLI that does not report it; the last-known value is kept.
           */
          readonly profileName?: string | undefined;
      }
    | { readonly type: 'sessionEnded'; readonly sessionID: string }
    | { readonly type: 'setPaneStatus'; readonly status: PaneStatus }
    | { readonly type: 'clearPaneStatus' };

export type NotificationSource = 'stop' | 'agentNotification' | 'error' | 'osc';

/**
 * A notification the daemon may post; whether it actually fires is
 * `notificationDecision(source, ctx)` (client focus/visibility lives outside this module).
 * `title === null` means "use the pane title, falling back to the workspace name".
 */
export interface PendingNotification {
    readonly source: Exclude<NotificationSource, 'osc'>;
    readonly title: string | null;
    readonly body: string;
}

export interface AgentEventEffects {
    /** False when the event was a no-op (guarded manual override, non-matching session end). */
    readonly changed: boolean;
    readonly persist: boolean;
    /** `sessionEnded` persists immediately rather than on the debounce (issue #178). */
    readonly persistImmediately: boolean;
    readonly refreshIndicators: boolean;
    /** Post-event `backgroundTaskCount > 0` - the #215/#220 suppression flag. */
    readonly hasBackgroundWork: boolean;
    readonly notification: PendingNotification | null;
    /** Focus acknowledgment withdraws the pane's delivered desktop notification. */
    readonly removeDeliveredNotification: boolean;
}

export interface AgentEventResult {
    readonly state: PaneAgentState;
    readonly effects: AgentEventEffects;
}

/** Body of the synthetic "the agent stopped and nobody is watching" notification. */
export const WAITING_NOTIFICATION_BODY = 'Agent is waiting for input';

/** Title of the always-posted error notification. */
export const ERROR_NOTIFICATION_TITLE = 'Agent Error';

/** Wire default for `error`'s `message` field. */
export const DEFAULT_ERROR_MESSAGE = 'Unknown error';
