/**
 * The one place the socket and the store are wired together.
 *
 * Keeping it here (rather than inside either module) means the store stays a pure data
 * container that tests can drive by hand, and the connection stays reusable by anything that
 * is not React. Assembly calls this once, at startup.
 *
 * The interesting rule is the **seq gap**: the delta stream is ordered, and a gap means the
 * mirror can no longer be trusted. The daemon has no "please resend" verb — a fresh connection
 * is the resync mechanism (`ws/sync.ts` refuses `resumeFromSeq` because `seq` is per daemon
 * process) — so a rejected batch redials, and the snapshot that follows REPLACES the mirror.
 *
 * `connectStore` is the minimal wiring; `createNexRuntime` assembles the whole client-side
 * stack (connection + command RPC + PTY streams + store + notifications) with the report
 * ordering the port requires, and is what assembly should call.
 */

import { CommandClient, NexConnection, PtyClient, type NexConnectionOptions } from '../connection';
import { createNotificationManager, type NotificationManager } from './notifications';
import { useNexStore, type NexStoreApi } from './store';

export interface StoreBridgeOptions {
    readonly store: NexStoreApi;
    readonly connection: NexConnection;
    /** Optional: renders daemon notifications (Web Notifications + toast fallback). */
    readonly notifications?: NotificationManager | null | undefined;
    /** Dock-bounce equivalent (WP3.6 owns the favicon/title treatment). */
    readonly onAttention?: ((target: { paneID: string; workspaceID: string }) => void) | undefined;
}

/** Subscribe the store to a connection. Returns the unsubscribe. */
export function connectStore(options: StoreBridgeOptions): () => void {
    const { store, connection } = options;
    const offs: (() => void)[] = [];

    offs.push(
        connection.on('status', (status) => {
            store.getState().setConnectionStatus(status, status === 'connected' ? null : undefined);
        })
    );

    offs.push(
        connection.on('welcome', (message) => {
            store.getState().setDaemonIdentity(message.clientID, message.daemon);
        })
    );

    offs.push(
        connection.on('snapshot', (message) => {
            store.getState().applySnapshot(message.seq, message.state);
        })
    );

    offs.push(
        connection.on('delta', (message) => {
            const applied = store.getState().applyDelta(message.seq, message.events);
            if (applied) return;
            // Out of order: only a fresh snapshot can repair the mirror.
            if (store.getState().daemon.hasSnapshot) connection.resync('delta seq gap');
        })
    );

    offs.push(
        connection.on('resync-required', () => {
            // The daemon says it cannot serve deltas from our position; a snapshot follows.
            store.getState().markDesynced();
        })
    );

    offs.push(
        connection.on('notification', (message) => {
            options.notifications?.handle(message);
        })
    );

    offs.push(
        connection.on('attention', (message) => {
            options.onAttention?.({ paneID: message.paneID, workspaceID: message.workspaceID });
        })
    );

    offs.push(
        connection.on('error', (error) => {
            const state = store.getState();
            state.setConnectionStatus(state.ui.connection, error.message);
        })
    );

    return () => {
        for (const off of offs) off();
        offs.length = 0;
    };
}

// ── the assembled runtime ───────────────────────────────────────────────────────────

export interface NexRuntimeOptions extends NexConnectionOptions {
    /** Defaults to the app-wide store; pass one for tests or a second surface. */
    readonly store?: NexStoreApi | undefined;
    readonly notifications?: NotificationManager | null | undefined;
    readonly onAttention?: ((target: { paneID: string; workspaceID: string }) => void) | undefined;
}

export interface NexRuntime {
    readonly store: NexStoreApi;
    readonly connection: NexConnection;
    readonly commands: CommandClient;
    readonly pty: PtyClient;
    readonly notifications: NotificationManager | null;
    connect(): void;
    /**
     * Move this client to a workspace: store first, then the daemon report. The daemon treats
     * the report as this connection's active workspace and nudges its persisted last-active.
     */
    activateWorkspace(workspaceID: string, visiblePaneIDs?: readonly string[]): void;
    /** Focus a pane: local echo (so the ring moves now) + the canonical report. */
    focusPane(workspaceID: string, paneID: string | null): void;
    /** Which panes this client renders right now (drives suppression + PTY fan-out). */
    reportVisiblePanes(workspaceID: string, visiblePaneIDs: readonly string[]): void;
    setDocumentVisible(visible: boolean): void;
    dispose(): void;
}

/**
 * Connection + command RPC + PTY streams + store, wired the one way that is correct. Assembly
 * calls this once; everything else takes what it needs off the returned object.
 */
export function createNexRuntime(options: NexRuntimeOptions = {}): NexRuntime {
    const store: NexStoreApi = options.store ?? useNexStore;
    const connection = new NexConnection(options);
    const commands = new CommandClient(connection);
    const pty = new PtyClient(connection);

    const notifications =
        options.notifications === null
            ? null
            : (options.notifications ??
              createNotificationManager({
                  onToast: (toast) => store.getState().pushToast(toast),
                  onDismissToast: (id) => store.getState().dismissToast(id),
                  onOpen: (target) => {
                      // §8.5: activate the workspace, focus the pane LAST, or a focus
                      // restoration race can revert the selection.
                      runtime.activateWorkspace(target.workspaceID);
                      runtime.focusPane(target.workspaceID, target.paneID);
                  }
              }));

    const disposeBridge = connectStore({
        store,
        connection,
        notifications,
        ...(options.onAttention !== undefined ? { onAttention: options.onAttention } : {})
    });

    const visiblePanesFor = (workspaceID: string): readonly string[] => {
        const workspace = store.getState().daemon.state.workspaces.find((entry) => entry.id === workspaceID);
        return workspace?.panes.map((pane) => pane.id) ?? [];
    };

    const runtime: NexRuntime = {
        store,
        connection,
        commands,
        pty,
        notifications,

        connect(): void {
            connection.connect();
        },

        activateWorkspace(workspaceID, visiblePaneIDs): void {
            store.getState().setActiveWorkspace(workspaceID);
            commands.setActiveWorkspaceReport(workspaceID, {
                visiblePaneIDs: visiblePaneIDs ?? visiblePanesFor(workspaceID),
                documentVisible: store.getState().ui.documentVisible
            });
        },

        focusPane(workspaceID, paneID): void {
            store.getState().setFocusEcho(workspaceID, paneID);
            commands.reportFocus(workspaceID, paneID);
            // Visiting a pane acknowledges its notification (agent-lifecycle §7.5 removal).
            if (paneID !== null) notifications?.clear(paneID);
        },

        reportVisiblePanes(workspaceID, visiblePaneIDs): void {
            commands.reportVisibility(workspaceID, visiblePaneIDs, store.getState().ui.documentVisible);
        },

        setDocumentVisible(visible): void {
            store.getState().setDocumentVisible(visible);
            const workspaceID = store.getState().ui.activeWorkspaceID;
            if (workspaceID === null) return;
            commands.reportVisibility(workspaceID, visiblePanesFor(workspaceID), visible);
        },

        dispose(): void {
            // Order matters: detach panes while the socket is still open, close it so the
            // store records the final status, and only then stop mirroring.
            pty.dispose();
            commands.dispose();
            connection.close();
            disposeBridge();
        }
    };

    return runtime;
}
