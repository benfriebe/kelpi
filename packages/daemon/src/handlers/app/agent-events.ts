/**
 * `agent.event` (#387, agent-lifecycle.md §7.7): one plugin event per agent hook line.
 *
 * The payload is built from the wire message plus the pane's state right AFTER the store applied
 * it, so a plugin that reads `panes.list` on receipt sees the same status and session unless a
 * later line has changed the pane since. It is not a daemon broadcast (never
 * `daemon.agent-event`): it goes out through `AppDeps.emitAgentEvent` and rides the
 * `plugin-event` frame every window session receives, like every plugin event, and only plugin
 * backends and views consume it.
 *
 * A hook line can dispatch twice: its primary message, then the §4.2 dual-fire session-start.
 * The primary's event is built as soon as it applies and held until that dual-fire has applied,
 * or until the next microtask when the line has none. A dual-fire rebuilds the held event from
 * the state it left and publishes nothing of its own. That keeps it at one event per `kelpi
 * event` call, and its `sessionID` / `agent` already carry what the dual-fire bound (a missed
 * SessionStart, a codex `stop` on a pane last seen as claude). A later line in the same socket
 * chunk (a `pane-close`, say) cannot change or drop it, and a later line's dual-fire (a `ping`
 * carrying the pane's `session_id`) is not its line's, so the held event goes out as built first.
 */

import type {
    AgentErrorMessage,
    AgentNotificationMessage,
    AgentStartMessage,
    AgentStopMessage,
    SessionEndMessage,
    SessionStartMessage,
    WireMessage
} from '@kelpi/protocol';

import { findPaneAnywhere, workspaceByID, type AgentKind, type DaemonState, type PaneStatus } from '../../store/index.js';

/** The wire verb the hook arrived as. A string union so a later verb is one more member. */
export type AgentHookEventType = 'start' | 'stop' | 'notification' | 'error' | 'session-start' | 'session-end' | 'permission-request';

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
    /** `error`: the wire `message`. `permission-request`: a deny's message, when the provider gave one. */
    readonly message?: string;
    readonly lastAssistantMessage?: string;
    readonly lastAssistantMessageTruncated?: true;
    readonly transcriptPath?: string;
    /** Only when > 0, as on the wire. */
    readonly backgroundTasks?: number;
    readonly toolName?: string;
    /** `permission-request` only (#388): the decision the daemon answered with. */
    readonly behavior?: 'allow' | 'deny' | 'abstain';
    /** `permission-request` only: the provider that was asked; absent when none could be. */
    readonly provider?: string;
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

/** What one `permission-request` decision adds to the pane's fields (#388). */
export interface PermissionRequestFields {
    readonly toolName: string;
    readonly behavior: 'allow' | 'deny' | 'abstain';
    readonly provider?: string;
    readonly message?: string;
}

/**
 * #388: the event for one permission decision against `state`; null once the pane or its
 * workspace is gone. The verb changes no pane state, so `status` is simply the pane's now.
 * `toolInput` never rides: a plugin that needs it is the provider.
 */
export function permissionRequestEvent(
    paneID: string,
    state: DaemonState,
    fields: PermissionRequestFields
): AgentHookEvent | null {
    const location = findPaneAnywhere(state, paneID);
    if (location === null) return null;
    const workspace = workspaceByID(state, location.workspaceID);
    if (workspace === null) return null;
    const { pane } = location;
    return {
        type: 'permission-request',
        paneID: pane.id,
        workspaceID: workspace.id,
        agent: pane.agentKind ?? 'claude',
        ...(pane.agentSessionID !== null ? { sessionID: pane.agentSessionID } : {}),
        status: pane.status,
        toolName: fields.toolName,
        behavior: fields.behavior,
        ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
        ...(fields.message !== undefined ? { message: fields.message } : {}),
        ...(workspace.muted ? { muted: true } : {})
    };
}

export interface AgentHookQueue {
    /** Build `message`'s event from `state` now and hold it until `complete` or the next microtask. */
    hold(message: AgentHookMessage, state: DaemonState): void;
    /** True when the held event is `message`'s, the primary a dual-fire was synthesized from. */
    holds(message: WireMessage | undefined): boolean;
    /** The line's dual-fire applied: rebuild the held event from `state`, then publish it. */
    complete(state: DaemonState): void;
    /** Publish the held event now, if any. */
    flush(): void;
}

/** One held event at most: a dual-fire always runs synchronously right after its primary. */
export function createAgentHookQueue(emit: (event: AgentHookEvent) => void): AgentHookQueue {
    let held: { readonly message: AgentHookMessage; readonly event: AgentHookEvent } | null = null;
    const flush = (): void => {
        const pending = held;
        held = null;
        if (pending !== null) emit(pending.event);
    };
    return {
        hold(message, state) {
            flush();
            const event = agentHookEvent(message, state);
            if (event === null) return;
            held = { message, event };
            queueMicrotask(flush);
        },
        holds(message) {
            return held !== null && held.message === message;
        },
        complete(state) {
            if (held !== null) held = { ...held, event: agentHookEvent(held.message, state) ?? held.event };
            flush();
        },
        flush
    };
}
