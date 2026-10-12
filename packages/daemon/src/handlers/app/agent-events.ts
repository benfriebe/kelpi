/**
 * `agent.event` (#387, agent-lifecycle.md §7.7): one plugin event per agent hook line.
 *
 * The payload is built from the wire message plus the pane's state AFTER the store applied it,
 * so a plugin that reads `panes.list` on receipt sees the same status and session. It reaches
 * plugin backends and views only (`AppDeps.emitAgentEvent`), never a window session as a
 * daemon broadcast.
 *
 * A hook line can dispatch twice: its primary message, then the §4.2 dual-fire session-start.
 * The primary's event therefore waits until that dual-fire has applied, or until the next
 * microtask when the line has none, and the dual-fire publishes nothing of its own. That keeps
 * it at one event per `kelpi event` call, and its `sessionID` / `agent` already carry what the
 * dual-fire bound (a missed SessionStart, a codex `stop` on a pane last seen as claude).
 */

import type {
    AgentErrorMessage,
    AgentNotificationMessage,
    AgentStartMessage,
    AgentStopMessage,
    SessionEndMessage,
    SessionStartMessage
} from '@kelpi/protocol';

import { findPaneAnywhere, workspaceByID, type AgentKind, type DaemonState, type PaneStatus } from '../../store/index.js';

/** The wire verb the hook arrived as. A string union so a later verb is one more member. */
export type AgentHookEventType = 'start' | 'stop' | 'notification' | 'error' | 'session-start' | 'session-end';

export type AgentHookMessage =
    | AgentStartMessage
    | AgentStopMessage
    | AgentNotificationMessage
    | AgentErrorMessage
    | SessionStartMessage
    | SessionEndMessage;

/** Optional keys are present only when the wire message carried them (`muted` only when true). */
export interface AgentHookEvent {
    readonly type: AgentHookEventType;
    readonly paneID: string;
    readonly workspaceID: string;
    /** The pane's agent kind after the event; `claude` (the wire default) when none is recorded. */
    readonly agent: AgentKind;
    /** The session the pane is bound to after the event. */
    readonly sessionID?: string;
    /** The pane's status after the store applied the event. */
    readonly status: PaneStatus;
    readonly notificationType?: string;
    readonly title?: string;
    readonly body?: string;
    /** `error` only: the wire `message`. */
    readonly message?: string;
    readonly lastAssistantMessage?: string;
    readonly lastAssistantMessageTruncated?: true;
    readonly transcriptPath?: string;
    /** Only when > 0, as on the wire. */
    readonly backgroundTasks?: number;
    readonly toolName?: string;
    /** The pane's workspace is muted (agent-lifecycle.md §7.6). */
    readonly muted?: true;
}

/** The fields one verb contributes beyond the pane's own state. */
function hookFields(message: AgentHookMessage): Partial<AgentHookEvent> {
    switch (message.command) {
        case 'stop':
            return {
                ...(message.last_assistant_message !== undefined
                    ? { lastAssistantMessage: message.last_assistant_message }
                    : {}),
                ...(message.last_assistant_message_truncated === true
                    ? { lastAssistantMessageTruncated: true }
                    : {}),
                ...(message.transcript_path !== undefined ? { transcriptPath: message.transcript_path } : {}),
                ...(message.background_tasks > 0 ? { backgroundTasks: message.background_tasks } : {})
            };
        case 'notification':
            return {
                ...(message.notification_type !== undefined
                    ? { notificationType: message.notification_type }
                    : {}),
                // The decoder defaults an absent title/body (`Agent`, empty), so both always ride.
                title: message.title,
                body: message.body,
                ...(message.transcript_path !== undefined ? { transcriptPath: message.transcript_path } : {}),
                ...(message.background_tasks > 0 ? { backgroundTasks: message.background_tasks } : {}),
                ...(message.tool_name !== undefined ? { toolName: message.tool_name } : {})
            };
        case 'error':
            return { message: message.message };
        case 'session-start':
            return message.transcript_path !== undefined ? { transcriptPath: message.transcript_path } : {};
        case 'start':
        case 'session-end':
            return {};
    }
}

/** The event for `message` against `state`; null once the pane or its workspace is gone. */
export function agentHookEvent(message: AgentHookMessage, state: DaemonState): AgentHookEvent | null {
    const location = findPaneAnywhere(state, message.pane_id);
    if (location === null) return null;
    const workspace = workspaceByID(state, location.workspaceID);
    if (workspace === null) return null;
    const { pane } = location;
    return {
        type: message.command,
        paneID: pane.id,
        workspaceID: workspace.id,
        agent: pane.agentKind ?? 'claude',
        ...(pane.agentSessionID !== null ? { sessionID: pane.agentSessionID } : {}),
        status: pane.status,
        ...hookFields(message),
        ...(workspace.muted ? { muted: true } : {})
    };
}

export interface AgentHookQueue {
    /** Hold `build` until the line's dual-fire has applied (`flush`) or the next microtask. */
    defer(build: () => AgentHookEvent | null): void;
    /** Publish the held event now, if any. */
    flush(): void;
}

/** One held event at most: a dual-fire always runs synchronously right after its primary. */
export function createAgentHookQueue(emit: (event: AgentHookEvent) => void): AgentHookQueue {
    let pending: (() => AgentHookEvent | null) | null = null;
    const flush = (): void => {
        const build = pending;
        pending = null;
        const event = build?.() ?? null;
        if (event !== null) emit(event);
    };
    return {
        defer(build) {
            flush();
            pending = build;
            queueMicrotask(flush);
        },
        flush
    };
}
