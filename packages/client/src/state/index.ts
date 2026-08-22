/**
 * Client state: the daemon mirror + this client's UI state, plus the reads over them.
 *
 *   `store.ts`         — the zustand store (daemon slice, ui slice) and wire hydration
 *   `selectors.ts`     — reads, reusing the daemon's own derived helpers
 *   `notifications.ts` — Web Notifications + toast fallback with `nex-<paneID>` identity
 *   `bridge.ts`        — subscribes the store to a `NexConnection`, and `createNexRuntime`,
 *                        the assembled connection + commands + PTY + store object
 *   `activation.ts`    — §AGNT-056's "is anybody looking?", from the shell's relayed
 *                        `shell-activation` plus the document's own visibility
 *   `clipboard.ts`     — §TERM-046's client end: a daemon `clipboard-write` (an OSC 52 the
 *                        `clipboard-write` setting allowed) onto THIS machine's clipboard
 */

export {
    SHELL_ACTIVATION_MESSAGE,
    activationAppliesHere,
    isAppActive,
    parseShellActivation,
    type ShellActivationReport
} from './activation';

export {
    CLIPBOARD_WRITE_MESSAGE,
    createClipboardWriteHandler,
    parseClipboardWrite,
    type ClipboardWriteHandlerOptions,
    type ClipboardWriteOutcome,
    type ClipboardWriteRequest
} from './clipboard';

export {
    DOMAIN_EVENT_KINDS,
    MAX_TOASTS,
    createNexStore,
    emptyDaemonState,
    hydrateDomainEvents,
    hydrateSettings,
    hydrateSnapshotState,
    nexStateCreator,
    recentlyClosedCount,
    useNexStore,
    type DaemonInfo,
    type DaemonSlice,
    type FocusEcho,
    type NexActions,
    type NexState,
    type NexStoreApi,
    type SettingsSlice,
    type Toast,
    type UiSlice
} from './store';

export {
    selectActiveLayout,
    selectActivePaneOrder,
    selectActivePanes,
    selectActiveWorkspace,
    selectActiveWorkspaceID,
    selectAgentSummary,
    selectConnectionStatus,
    selectDaemonState,
    selectFilteredSidebarEntries,
    selectFocusedPaneID,
    selectGroupForWorkspace,
    selectIsReady,
    selectPane,
    selectSidebarEntries,
    selectSidebarWorkspaceIDs,
    selectSyncedPaneIDs,
    selectToasts,
    selectVisibleWorkspaceIDs,
    selectVisibleWorkspaces,
    selectWorkspace,
    selectWorkspaceAgentCount,
    selectZoomedPaneID,
    type AgentSummary,
    type SidebarEntry
} from './selectors';

export {
    browserNotificationApi,
    createNotificationManager,
    dedupeKeyForPane,
    type NotificationApi,
    type NotificationInit,
    type NotificationLike,
    type NotificationManager,
    type NotificationManagerOptions,
    type NotificationPermissionState,
    type NotificationTarget
} from './notifications';

export {
    connectStore,
    createNexRuntime,
    isTokenRejection,
    type NexRuntime,
    type NexRuntimeOptions,
    type StoreBridgeOptions
} from './bridge';
