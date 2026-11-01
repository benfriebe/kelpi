/**
 * Starting an agent in a new workspace's first pane (docs/agent-lifecycle.md §6.5): the launcher
 * that waits for the shell, types the launch line and delivers or prefills the prompt, and the
 * prompt files a create writes before anything else happens.
 */

export {
    AGENT_DIALOG_POLL_MS,
    AGENT_FIRST_OUTPUT_TIMEOUT_MS,
    AGENT_FOREGROUND_POLL_MS,
    AGENT_FOREGROUND_REUSE_MS,
    DEFAULT_AGENT_LAUNCH_TIMINGS,
    INERT_AGENT_LAUNCHER,
    createAgentLaunchDelivery,
    createAgentLauncher,
    isTypedInput
} from './launcher.js';
export type {
    AgentLaunchAbandonReason,
    AgentLaunchDeliver,
    AgentLaunchDeliveryOptions,
    AgentLaunchRequest,
    AgentLaunchStart,
    AgentLaunchTimings,
    AgentLauncher,
    AgentLauncherOptions,
    AgentLauncherTerminal
} from './launcher.js';
export { PROMPTS_DIRECTORY_NAME, createPromptFileStore } from './prompt-files.js';
export type { PromptFileStore, PromptFileStoreOptions } from './prompt-files.js';
