/** Public surface of the agent lifecycle module (WP1.4). */

export type {
    AgentEvent,
    AgentEventEffects,
    AgentEventResult,
    AgentKind,
    PaneAgentState,
    PaneKind,
    PaneStatus,
    PendingNotification,
    NotificationSource
} from './types.js';
export {
    DEFAULT_ERROR_MESSAGE,
    ERROR_NOTIFICATION_TITLE,
    WAITING_NOTIFICATION_BODY,
    initialPaneAgentState
} from './types.js';
export { reduceAgentEvent } from './machine.js';
export type { AgentEventContext } from './machine.js';
export {
    agentKindFromWire,
    captureResumeTuple,
    displayAgentKind,
    isActiveAgentStatus,
    isSafeSessionID,
    resetPaneAgentStateOnLoad,
    resumeCommand,
    MAX_SESSION_ID_LENGTH,
    RESUME_SETTLE_DELAY_MS
} from './session.js';
export type { ResumeTuple } from './session.js';
export { notificationDecision } from './notifications.js';
export type { NotificationContext, NotificationDecision } from './notifications.js';
