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
    summarizeAgentPanes,
    describeAgentSummary,
    workspaceAgentDeleteWarning,
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
export type { ResumeTuple, WorkspaceAgentSummary } from './session.js';
export { notificationDecision } from './notifications.js';
export type { NotificationContext, NotificationDecision } from './notifications.js';
// Starting an agent in a new workspace (wire-protocol.md §6.3): commands, quoting, the prompt
// rules, the timings and the readiness seam the daemon's launcher calls.
export {
    AGENT_PROMPT_MAX_BYTES,
    AGENT_READY_MAX_WAIT_MS,
    AGENT_READY_STABLE_MS,
    AGENT_READY_TIMEOUT_MS,
    AGENT_SHELL_READY_CAP_MS,
    AGENT_SHELL_SETTLE_MS,
    CLAUDE_TRUST_DIALOG_TEXT,
    CODEX_COMPOSER_GLYPH,
    CODEX_TRUST_DIALOG_TEXT,
    DEFAULT_AGENT_COMMANDS,
    PROMPT_FILE_TTL_MS,
    SEND_MODE_SHELLS,
    agentLaunchCommand,
    agentShellReadySignal,
    defaultAgentReadiness,
    normalizeAgentPrompt,
    sendModeCommandLine,
    shellBasename,
    shellSingleQuote,
    shellSupportsSendMode
} from './launch.js';
export type {
    AgentLaunchModeName,
    AgentLaunchModes,
    AgentPromptNormalization,
    AgentReadiness,
    AgentReadinessAbandonReason,
    AgentReadinessResult,
    AgentReadinessSignals,
    AgentReadinessWait,
    AgentShellReadySignal,
    SendModeShell
} from './launch.js';
