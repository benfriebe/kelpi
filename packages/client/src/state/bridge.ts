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
 * `connectStore` is the minimal wiring; `createKelpiRuntime` assembles the whole client-side
 * stack (connection + command RPC + PTY streams + store + notifications) with the report
 * ordering the port requires, and is what assembly should call.
 */

import type { WsRejectedMessage } from '@kelpi/protocol';

import { forgetStoredToken, type StorageLike } from '../app/config';
import { CommandClient, KelpiConnection, PtyClient, type KelpiConnectionOptions } from '../connection';
import { readShellWindowID } from '../webpane/shell-window';
import { activationAppliesHere, parseShellActivation } from './activation';
import { createClipboardWriteHandler, type ClipboardWriteHandlerOptions } from './clipboard';
import { createNotificationManager, type NotificationManager } from './notifications';
import { useKelpiStore, type KelpiStoreApi } from './store';

/**
 * A rejection that says "your token is wrong", in either dialect: the typed `reason` a current
 * daemon sends, or the bare `unauthorized` code an older one does.
 */
export function isTokenRejection(message: WsRejectedMessage): boolean {
    return message.reason === 'bad-token' || message.code === 'unauthorized';
}

export interface StoreBridgeOptions {
    readonly store: KelpiStoreApi;
    readonly connection: KelpiConnection;
    /** Optional: renders daemon notifications (Web Notifications + toast fallback). */
    readonly notifications?: NotificationManager | null | undefined;
    /** Dock-bounce equivalent (WP3.6 owns the favicon/title treatment). */
    readonly onAttention?: ((target: { paneID: string; workspaceID: string }) => void) | undefined;
    /**
     * Where the remembered `?token=` lives. Defaults to `localStorage`; pass `null` to keep the
     * bridge out of storage entirely (tests, private mode).
     */
    readonly tokenStorage?: StorageLike | null | undefined;
    /**
     * §AGNT-056: which shell window this client is the page of (`?shellWindow=`), so a scoped
     * `shell-activation` can be told apart from another window's. Defaults to the live URL;
     * tests pass it explicitly rather than rewriting `location`.
     */
    readonly shellWindowID?: string | null | undefined;
    /**
     * §TERM-046: the seams `./clipboard.ts` takes for the OSC 52 clipboard write (the writer,
     * the log). Omitted in production — it defaults to `navigator.clipboard` and `console.info`
     * — and supplied by tests, which have neither.
     */
    readonly clipboard?: Omit<ClipboardWriteHandlerOptions, 'shellWindowID'> | undefined;
}

/** Subscribe the store to a connection. Returns the unsubscribe. */
export function connectStore(options: StoreBridgeOptions): () => void {
    const { store, connection } = options;
    const shellWindowID = options.shellWindowID === undefined ? readShellWindowID() : options.shellWindowID;
    // §TERM-046. Built once, because the shell-vs-browser decision is fixed for this page's life.
    const clipboardWrite = createClipboardWriteHandler({ ...(options.clipboard ?? {}), shellWindowID });
    const offs: (() => void)[] = [];

    offs.push(
        connection.on('status', (status) => {
            store.getState().setConnectionStatus(status, status === 'connected' ? null : undefined);
        })
    );

    offs.push(
        connection.on('welcome', (message) => {
            // §SET-021: `transport` rides the handshake beside `settings`. It is what the
            // listeners actually DID, which only the daemon knows and the config file cannot say.
            store.getState().setDaemonIdentity(message.clientID, message.daemon, message.transport ?? null);
            // M8: settings ride the handshake (see `@kelpi/protocol` `ws/settings.ts`), so they
            // are in the store before the first snapshot renders — no light/dark flash, no
            // window where the key dispatcher is running on the shipped defaults.
            store.getState().applySettings(message.settings);
        })
    );

    offs.push(
        // `settings-changed` has no dedicated connection event: it is a fire-and-forget
        // broadcast with no ordering relationship to anything, and `message` already carries
        // every decoded frame. Subscribing here keeps the socket layer unaware of settings.
        connection.on('message', (message) => {
            if (message['type'] !== 'settings-changed') return;
            store.getState().applySettings(message['settings']);
        })
    );

    offs.push(
        // §AGNT-005's live re-bind: the daemon moved (or dropped) a listener while we were
        // attached. Its own message rather than a field on `settings-changed` because the two
        // say different things — the file's request vs what the listener actually did — and
        // Settings ▸ Network shows the second one.
        connection.on('message', (message) => {
            if (message['type'] !== 'transport-changed') return;
            const state = store.getState();
            state.setDaemonIdentity(
                state.daemon.clientID,
                state.daemon.info,
                (message['transport'] ?? null) as never
            );
        })
    );

    offs.push(
        // §SET-200/§SET-201: `hotkey-status` — the Electron shell's registrar, reporting through
        // the daemon. Its own message rather than a settings field for the same reason
        // `transport-changed` is: the config file says which chord was ASKED for; this says what
        // the OS did with it. A browser with no shell attached never sees one, and shows no
        // warning, which is correct — nothing tried to register anything.
        connection.on('message', (message) => {
            if (message['type'] !== 'hotkey-status') return;
            store.getState().applyHotkeyStatus(message);
        })
    );

    offs.push(
        // §AGNT-056: `shell-activation` — the Electron shell's window became (or stopped being)
        // the active one, relayed because the shell and this page are different processes. It
        // gates the pane grid's 600 ms status clear, so a badge raised while the user was in
        // another app is still there when they come back — and clears shortly after they do.
        // Scoped by window id: a second shell window losing focus says nothing about this one,
        // and a browser (no `?shellWindow=`) ignores every targeted report and keeps running off
        // `document.visibilitychange` alone.
        connection.on('message', (message) => {
            const report = parseShellActivation(message);
            if (report === null || !activationAppliesHere(report, shellWindowID)) return;
            store.getState().setAppActive(report.active);
        })
    );

    offs.push(
        /*
         * §TERM-046: `clipboard-write` — a program in a pane put text on the clipboard with
         * OSC 52 and the daemon's gate allowed it. Subscribed here for the same reason
         * `settings-changed` and `system-stats` are: a fire-and-forget broadcast with no
         * ordering relationship to the snapshot/delta stream.
         *
         * Note there is no store write. The clipboard is not application state — it is the
         * user's machine — and mirroring it would put a copied password in a React store.
         */
        connection.on('message', clipboardWrite)
    );

    offs.push(
        // `system-stats` (APP-078): the daemon's 2 s sampler, subscribed here for exactly the
        // reason above — a fire-and-forget broadcast with no ordering relationship to the
        // snapshot/delta stream, and the socket layer has no business knowing about gauges.
        connection.on('message', (message) => {
            if (message['type'] !== 'system-stats') return;
            store.getState().applySystemStats(message);
        })
    );

    offs.push(
        // `persistence-degraded`: the daemon is running, but its state is NOT reaching disk.
        // This is the one warning that must not live only in a log file — the failure it
        // reports stays invisible until a restart throws a day of workspaces away. The toast
        // has no timer (it stays until dismissed) and a fixed id, so a repeat broadcast
        // replaces it rather than stacking.
        connection.on('message', (message) => {
            if (message['type'] !== 'persistence-degraded') return;
            const target = typeof message['path'] === 'string' ? message['path'] : 'the database';
            const detail = typeof message['error'] === 'string' ? message['error'] : 'unknown error';
            store.getState().pushToast({
                id: 'persistence-degraded',
                kind: 'agent-error',
                title: 'Changes are not being saved',
                body: `${target}: ${detail}. Anything created now is lost on restart.`,
                paneID: null,
                workspaceID: null,
                createdAt: Date.now()
            });
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
        connection.on('rejected', (message) => {
            // `socket.ts` treats anything but a server error as fatal and stops retrying, so
            // only those get the terminal status here — a retryable refusal would otherwise
            // flash "rejected" before the reconnect flips it back. Either way the daemon's own
            // words become the connection error, and a token it refuses is forgotten so a
            // stale one cannot wedge the KELPIT visit as well.
            const state = store.getState();
            const terminal = message.code !== 'server-error';
            state.setConnectionStatus(terminal ? 'rejected' : state.ui.connection, message.message);
            if (isTokenRejection(message)) forgetStoredToken(options.tokenStorage);
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

export interface KelpiRuntimeOptions extends KelpiConnectionOptions {
    /** Defaults to the app-wide store; pass one for tests or a second surface. */
    readonly store?: KelpiStoreApi | undefined;
    readonly notifications?: NotificationManager | null | undefined;
    readonly onAttention?: ((target: { paneID: string; workspaceID: string }) => void) | undefined;
    /** Where the remembered token lives (see `StoreBridgeOptions.tokenStorage`). */
    readonly tokenStorage?: StorageLike | null | undefined;
    /** §AGNT-056: see `StoreBridgeOptions.shellWindowID`. */
    readonly shellWindowID?: string | null | undefined;
    /** §TERM-046: see `StoreBridgeOptions.clipboard`. */
    readonly clipboard?: StoreBridgeOptions['clipboard'];
}

export interface KelpiRuntime {
    readonly store: KelpiStoreApi;
    readonly connection: KelpiConnection;
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
export function createKelpiRuntime(options: KelpiRuntimeOptions = {}): KelpiRuntime {
    const store: KelpiStoreApi = options.store ?? useKelpiStore;
    const connection = new KelpiConnection(options);
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
        ...(options.onAttention !== undefined ? { onAttention: options.onAttention } : {}),
        ...(options.tokenStorage !== undefined ? { tokenStorage: options.tokenStorage } : {}),
        ...(options.shellWindowID !== undefined ? { shellWindowID: options.shellWindowID } : {}),
        ...(options.clipboard !== undefined ? { clipboard: options.clipboard } : {})
    });

    const visiblePanesFor = (workspaceID: string): readonly string[] => {
        const workspace = store.getState().daemon.state.workspaces.find((entry) => entry.id === workspaceID);
        return workspace?.panes.map((pane) => pane.id) ?? [];
    };

    const runtime: KelpiRuntime = {
        store,
        connection,
        commands,
        pty,
        notifications,

        connect(): void {
            connection.connect();
        },

        /**
         * Activation is an ASSERTION, not a diff: the report goes out even when this client
         * was already showing that workspace.
         *
         * Clicking the row you are already on used to be a total no-op — the store
         * short-circuits an unchanged id and the visibility report deduped against its own
         * last payload — so there was no way to tell the daemon "no, THIS one" after
         * something else (a CLI `workspace create`) moved its answer. `force` is what makes
         * the click an idempotent re-assert (run-B L3).
         */
        activateWorkspace(workspaceID, visiblePaneIDs): void {
            store.getState().setActiveWorkspace(workspaceID);
            commands.setActiveWorkspaceReport(workspaceID, {
                visiblePaneIDs: visiblePaneIDs ?? visiblePanesFor(workspaceID),
                documentVisible: store.getState().ui.documentVisible,
                force: true
            });
        },

        focusPane(workspaceID, paneID): void {
            store.getState().setFocusEcho(workspaceID, paneID);
            /*
             * §N35 — the report's own dedupe remembers what this CLIENT last SENT, and that
             * stops being the truth the moment anything else moves focus: a split (the daemon
             * focuses the pane it made), the CLI, or a second client. A click back onto the
             * pane this client last reported was then swallowed as a duplicate, and the daemon
             * kept a focus nobody was in.
             *
             * Invisible in the window, because the echo draws the ring where the user clicked
             * (`setFocusEcho` above), and `echoSurvives` keeps it until the DAEMON's value
             * changes — which is exactly what never happened. What it costs is everything that
             * reads the daemon's answer instead of this window's: `kelpi pane list --json`'s
             * `is_focused`, a second client, and above all a RELOAD, which restores the
             * daemon's focused pane and so came back on a pane the user had left.
             *
             * Measured: click pane A in a two-pane workspace made by ⌘D, and six seconds later
             * `ring=A daemon=B` (`docs/audit/n34-n35-reveal-focus/`).
             *
             * So the report is forced whenever the daemon's own value disagrees with what this
             * gesture means. When it already agrees the dedupe still stands and nothing is
             * sent twice.
             */
            const known = store
                .getState()
                .daemon.state.workspaces.find((workspace) => workspace.id === workspaceID)?.focusedPaneID;
            commands.reportFocus(workspaceID, paneID, known === paneID ? {} : { force: true });
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
