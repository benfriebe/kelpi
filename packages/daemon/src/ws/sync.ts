/**
 * The state-sync half of the client socket (WP2.7).
 *
 * Per connection: `hello` → `welcome` → one `snapshot` → an ordered `delta` stream, plus
 * client→daemon commands (the control-protocol verbs), focus/visibility reports, and the
 * daemon→client notification fan-out.
 *
 * Design rules taken from PLAN.md / ARCHITECTURE.md:
 *   - **Clients are views.** They mirror `DaemonState` and apply `DomainEvent`s; no domain
 *     logic runs client-side, so the deltas are the store's own events (serialized by
 *     `./serialize.ts`, which strips the server-only fields).
 *   - **Active workspace is per client**, workspace focus is daemon-canonical: a
 *     `focus-report` moves the workspace's `focusedPaneID` (last report from any client
 *     wins) so `layout select main-*` and friends keep their CLI semantics, while each
 *     connection's own active workspace lives here and only nudges the daemon's persisted
 *     `lastActiveWorkspaceID`.
 *   - **Notifications are decided by the daemon and broadcast**; a client that has the
 *     pane focused and visible reports it, and that report suppresses delivery to that
 *     client (agent-lifecycle.md §7 + Port note 2: with nothing attached, "app active" is
 *     false, so headless operation still notifies).
 *   - **Commands** ride the same decode path as the control socket, dual-fire included, so
 *     a WS client and the `nex` CLI cannot drift.
 *   - **This is where authentication happens.** The `/ws` upgrade classifies a connection
 *     (authenticated / anonymous) but no longer refuses one, because a refused upgrade reaches
 *     a browser as an anonymous close 1006 that it can only retry. The handshake can instead
 *     answer `rejected` with a reason the user can act on, then close with a coded frame. An
 *     un-helloed connection is closed after `DEFAULT_HELLO_TIMEOUT_MS`, and nothing at all —
 *     JSON or binary — is accepted before `welcome`.
 */

import { randomUUID } from 'node:crypto';

import {
    WS_CLIENT_KINDS,
    WS_PROTOCOL_VERSION,
    decodeWireObject,
    dispatchSequence,
    errorReply,
    type JsonObject,
    type WsClientInfo,
    type WsClientKind,
    type WsRejectionCode,
    type WsRejectionReason
} from '@nex/protocol';

import type { ContentMode, ContentPaneState, ContentSubscription } from '../content/index.js';
import { dualFireMessage } from '../control/server.js';
import type { ControlDispatcher, DomainStore, ReplyHandle } from '../seams.js';
import { groupByID, workspaceByID, workspaceContainingVisiblePane } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/types.js';
import type { HostRegistration } from '../webpane/host.js';
import type { WebPaneService } from '../webpane/service.js';
import { serializeDomainEvents, serializeState } from './serialize.js';

export type NexDomainStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** WS close codes for the rejection reasons (4000-4999 is the app-defined range). */
export const WS_CLOSE_CODES = {
    protocolMismatch: 4001,
    unauthorized: 4003,
    serverError: 4500
} as const;

/**
 * How long a connection may sit open without completing a handshake before the daemon closes
 * it. The upgrade no longer authenticates (`ws/http.ts` `authorizeUpgrade`), so this bounds
 * what an anonymous socket can hold: a real client sends `hello` in the same tick it opens.
 */
export const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** The message a client sees when its hello carries no usable token. */
export const BAD_TOKEN_MESSAGE = "invalid or missing daemon token — open the client via 'nexd url'";

export interface SyncTransport {
    sendJson(message: JsonObject): void;
    close(code?: number, reason?: string): void;
}

/** What a connection's PTY streams need from the sync channel (see `./streams.ts`). */
export interface SyncPaneBridge {
    attach(paneID: string, size?: { cols: number; rows: number } | undefined): void | Promise<void>;
    detach(paneID: string): void;
    resize(paneID: string, cols: number, rows: number): void;
    close(): void;
}

export interface SyncSession {
    readonly clientID: string;
    /** True once the handshake succeeded (snapshot sent, deltas flowing). */
    readonly ready: boolean;
    readonly client: WsClientInfo | null;
    /** This connection's active workspace (per-client, PLAN decision). */
    readonly activeWorkspaceID: string | null;
    readonly focusedPaneID: string | null;
    readonly visiblePaneIDs: ReadonlySet<string>;
    readonly documentVisible: boolean;
    /** One text frame from the client. */
    handleMessage(raw: string): void;
    /** Peer went away (or we are shutting down): release everything this connection held. */
    close(): void;
}

export interface SyncHubOptions {
    readonly store: NexDomainStore;
    /** Where client `command` messages go — the same dispatcher the control socket uses. */
    readonly dispatcher: ControlDispatcher;
    readonly daemon: { readonly version: string; readonly build: string; readonly pid?: number | undefined };
    /** Defaults to the protocol's compiled-in version. */
    readonly protocolVersion?: number | undefined;
    /** M5 content panes; absent = the `content-*` verbs answer "not available". */
    readonly content?: ContentChannel | undefined;
    /**
     * M6 web panes. This is where the Electron shell claims the host role and where its RPC
     * replies + console/page events arrive, so it MUST be the same service instance the
     * `web-*` command handlers got. Absent = no connection can become a host.
     */
    readonly webPanes?: WebPaneChannel | undefined;
    /**
     * The token check. The upgrade no longer refuses a bad token (it cannot say why to a
     * browser), so for an anonymous connection this IS the gate. Absent = accept whatever
     * upgraded (a tokenless / `allowAnonymous` daemon).
     */
    readonly validateToken?: ((token: string) => boolean) | undefined;
    /** Handshake deadline; defaults to `DEFAULT_HELLO_TIMEOUT_MS`. `0` disables it. */
    readonly helloTimeoutMs?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly newClientID?: (() => string) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface SyncPresence {
    readonly clients: number;
    /** Clients whose document is visible — the port's "app is active" (agent-lifecycle §7). */
    readonly visibleClients: number;
    readonly anyVisible: boolean;
}

export interface SessionOptions {
    /**
     * True when the HTTP upgrade already presented a valid token (`?token=` or a bearer
     * header). Such a connection may omit the token from its `hello` — which is what the
     * Electron shell's status and web-host sockets would do if they ever stopped sending one.
     * Default false: the hello must authenticate itself.
     */
    readonly authenticated?: boolean | undefined;
}

export interface SyncHub {
    createSession(
        transport: SyncTransport,
        panes?: SyncPaneBridge | undefined,
        options?: SessionOptions | undefined
    ): SyncSession;
    /** The `HandlerContext.broadcast` seam: fan a daemon event out to attached clients. */
    broadcast(event: Record<string, unknown>): void;
    readonly sessions: readonly SyncSession[];
    /** Deltas emitted so far; the anchor a snapshot is taken at. */
    readonly seq: number;
    presence(): SyncPresence;
    /** True when some visible client shows that pane as its focused pane (§7 suppression). */
    isPaneAttended(workspaceID: string, paneID: string): boolean;
    close(): void;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function count(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseClientInfo(value: unknown): WsClientInfo {
    const fallback: WsClientInfo = { kind: 'browser' };
    if (!isRecord(value)) return fallback;
    const kind = value['kind'];
    const known = WS_CLIENT_KINDS.includes(kind as WsClientKind) ? (kind as WsClientKind) : 'browser';
    const name = text(value['name']);
    const version = text(value['version']);
    const rawCapabilities = value['capabilities'];
    const capabilities = Array.isArray(rawCapabilities)
        ? rawCapabilities.filter((entry): entry is string => typeof entry === 'string')
        : undefined;
    return {
        kind: known,
        ...(name !== undefined ? { name } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(capabilities !== undefined ? { capabilities } : {})
    };
}

// ── WS-only commands (WP3.6) ────────────────────────────────────────────────────────

/**
 * Store mutations the GUI needs that the **control protocol has no verb for** — the CLI never
 * grew one because they are direct-manipulation gestures (a zoom button, a disclosure triangle,
 * an inline rename field).
 *
 * They are deliberately NOT added to `@nex/protocol`'s `WIRE_COMMANDS`: a new CLI verb is a
 * compatibility surface we would owe the Swift CLI forever, and `nex` has no way to send these.
 * So they are handled here, *before* `decodeWireObject` (which would reject an unknown command),
 * and each one simply dispatches the store action that already exists. Field names follow the
 * wire's snake_case convention so a client speaks one dialect for both kinds of command.
 *
 *   toggle-zoom          `pane_id`                       → focus-pane (if needed) + toggle-zoom
 *   set-group-collapsed  `group_id`, `collapsed`         → set-group-collapsed
 *   rename-workspace     `workspace_id`, `name`          → rename-workspace
 */
export const WS_ONLY_COMMANDS = ['toggle-zoom', 'set-group-collapsed', 'rename-workspace'] as const;
export type WsOnlyCommand = (typeof WS_ONLY_COMMANDS)[number];

export function isWsOnlyCommand(command: string): command is WsOnlyCommand {
    return (WS_ONLY_COMMANDS as readonly string[]).includes(command);
}

function failure(error: string): JsonObject {
    return { ok: false, error };
}

/**
 * Executes one WS-only command against the store and returns the reply object. Pure routing +
 * dispatch: every mutation is an existing `DomainAction`, so the delta stream, persistence and
 * the CLI's view of the world all stay identical to a GUI-driven change.
 */
export function handleWsOnlyCommand(
    store: NexDomainStore,
    command: WsOnlyCommand,
    payload: Record<string, unknown>
): JsonObject {
    const state = store.getState();

    if (command === 'toggle-zoom') {
        const paneID = text(payload['pane_id']);
        if (paneID === undefined) return failure('toggle-zoom requires pane_id');
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace === null) return failure(`no pane matches '${paneID}'`);
        // The reducer zooms the workspace's FOCUSED pane, so a zoom raised on another pane has
        // to move focus first — which is what clicking that pane's zoom button does anyway.
        if (workspace.zoomedPaneID === null && workspace.focusedPaneID !== paneID) {
            store.dispatch({ type: 'focus-pane', workspaceID: workspace.id, paneID });
        }
        store.dispatch({ type: 'toggle-zoom', workspaceID: workspace.id });
        const after = workspaceByID(store.getState(), workspace.id);
        return {
            ok: true,
            pane_id: paneID,
            workspace_id: workspace.id,
            zoomed_pane_id: after?.zoomedPaneID ?? null
        };
    }

    if (command === 'set-group-collapsed') {
        const groupID = text(payload['group_id']);
        if (groupID === undefined) return failure('set-group-collapsed requires group_id');
        if (groupByID(state, groupID) === null) return failure(`no group matches '${groupID}'`);
        const collapsed = payload['collapsed'] === true;
        store.dispatch({ type: 'set-group-collapsed', id: groupID, collapsed });
        return { ok: true, group_id: groupID, collapsed };
    }

    const workspaceID = text(payload['workspace_id']);
    if (workspaceID === undefined) return failure('rename-workspace requires workspace_id');
    const name = typeof payload['name'] === 'string' ? payload['name'].trim() : '';
    if (name.length === 0) return failure('rename-workspace requires a non-empty name');
    if (workspaceByID(state, workspaceID) === null) return failure(`no workspace matches '${workspaceID}'`);
    store.dispatch({ type: 'rename-workspace', id: workspaceID, name });
    return { ok: true, workspace_id: workspaceID, name };
}

// ── content-pane commands (M5) ──────────────────────────────────────────────────────

/**
 * The content-pane verbs. Same reasoning as `WS_ONLY_COMMANDS` (no CLI equivalent, so they are
 * matched before `decodeWireObject`), with one difference: they are **asynchronous** — reading a
 * file or running `git diff` cannot answer inside the message handler — so they answer through
 * `command-reply` when the promise settles rather than returning a reply object.
 *
 *   content-subscribe    `pane_id`          → `{ok, pane_id, state}` + `content-updated` events
 *   content-unsubscribe  `pane_id`          → `{ok, pane_id}` (stops this client's events)
 *   markdown-set-mode    `pane_id`, `mode`  → `{ok, pane_id, state}` ("view" | "edit")
 *   content-set-text     `pane_id`, `text`  → `{ok, pane_id, state}` (the edit buffer)
 *   diff-refresh         `pane_id`          → `{ok, pane_id, state}` (re-runs git)
 *   markdown-save        `pane_id`          → `{ok, pane_id, state}` (flush the debounce)
 *
 * `content-updated` (`{type, paneID, state}`) goes ONLY to sessions subscribed to that pane.
 */
export const CONTENT_COMMANDS = [
    'content-subscribe',
    'content-unsubscribe',
    'markdown-set-mode',
    'content-set-text',
    'diff-refresh',
    'markdown-save'
] as const;
export type ContentCommand = (typeof CONTENT_COMMANDS)[number];

export function isContentCommand(command: string): command is ContentCommand {
    return (CONTENT_COMMANDS as readonly string[]).includes(command);
}

/** The message type carrying a content change to a subscribed client. */
export const CONTENT_UPDATED_MESSAGE = 'content-updated';

/** The slice of `ContentService` the sync hub uses (so tests can stub it). */
export interface ContentChannel {
    subscribe(
        paneID: string,
        listener: (state: ContentPaneState) => void
    ): Promise<ContentSubscription>;
    setMode(paneID: string, mode: ContentMode): Promise<ContentPaneState>;
    setText(paneID: string, text: string): Promise<ContentPaneState>;
    save(paneID: string): Promise<ContentPaneState>;
    refresh(paneID: string): Promise<ContentPaneState>;
}

// ── web panes (M6) ──────────────────────────────────────────────────────────────────

/**
 * The web-pane host channel and the client-side console subscription.
 *
 * Two different roles share this socket type:
 *   - a **host** (the Electron shell) sends `host-register`, then answers `host-rpc` with
 *     `host-rpc-reply` and pushes `host-event`s (console lines, URL/title changes, picked
 *     elements). Exactly one host is active; a second registration takes over and the previous
 *     host is told with `host-revoked`. Dropping the connection releases the slot.
 *   - any **client** (the web UI) can subscribe to a pane's console with
 *     `web-console-subscribe` and receive `web-console-line` messages — the WS twin of the
 *     control socket's `nex web console --follow`, reading the same daemon ring buffer.
 *
 * Contract for the host side: `daemon/src/webpane/HOST_PROTOCOL.md`.
 */
export type WebPaneChannel = Pick<
    WebPaneService,
    'registerHost' | 'settleHostReply' | 'handleHostEvent' | 'subscribeConsole' | 'console'
>;

export const WEB_COMMANDS = ['web-console-subscribe', 'web-console-unsubscribe'] as const;
export type WebCommand = (typeof WEB_COMMANDS)[number];

export function isWebCommand(command: string): command is WebCommand {
    return (WEB_COMMANDS as readonly string[]).includes(command);
}

/** The message type carrying one streamed console line to a subscribed client. */
export const WEB_CONSOLE_LINE_MESSAGE = 'web-console-line';

/** Capability token a `hello` can carry to claim the host role without a second message. */
export const WEB_HOST_CAPABILITY = 'web-pane-host';

/** A `ReplyHandle` whose lines ride the WS channel as `command-reply` messages. */
class WsReplyHandle implements ReplyHandle {
    private sends = 0;
    private dead = false;
    private callbacks: (() => void)[] = [];

    constructor(
        private readonly transport: SyncTransport,
        private readonly id: string,
        private readonly release: (handle: WsReplyHandle) => void
    ) {}

    send(payload: Record<string, unknown>): void {
        if (this.dead) return;
        this.sends += 1;
        this.transport.sendJson({
            type: 'command-reply',
            id: this.id,
            reply: payload as JsonObject
        });
    }

    close(): void {
        if (this.dead) return;
        // A handler that answers nothing would hang the client's RPC; the control socket can
        // afford silence (EOF ends the read) but a multiplexed socket cannot.
        if (this.sends === 0) this.send({ ...errorReply('daemon produced no reply') });
        this.finish();
    }

    get closed(): boolean {
        return this.dead;
    }

    onDisconnect(callback: () => void): void {
        if (this.dead) {
            callback();
            return;
        }
        this.callbacks.push(callback);
    }

    /** Peer vanished: fire the disconnect callbacks without writing anything. */
    peerGone(): void {
        this.finish();
    }

    private finish(): void {
        if (this.dead) return;
        this.dead = true;
        const pending = this.callbacks;
        this.callbacks = [];
        for (const callback of pending) callback();
        this.release(this);
    }
}

export function createSyncHub(options: SyncHubOptions): SyncHub {
    const { store, dispatcher } = options;
    const protocolVersion = options.protocolVersion ?? WS_PROTOCOL_VERSION;
    const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const now = options.now ?? (() => Date.now());
    const newClientID = options.newClientID ?? (() => randomUUID());
    const sessions = new Set<SessionImpl>();
    let seq = 0;
    let closed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    class SessionImpl implements SyncSession {
        readonly clientID = newClientID();
        ready = false;
        client: WsClientInfo | null = null;
        activeWorkspaceID: string | null = null;
        focusedPaneID: string | null = null;
        visiblePaneIDs: ReadonlySet<string> = new Set<string>();
        documentVisible = false;
        private disposed = false;
        private readonly handles = new Set<WsReplyHandle>();
        /** paneID → this connection's content subscription (events go nowhere else). */
        private readonly contentSubs = new Map<string, ContentSubscription>();
        /** Bumped on every subscribe/unsubscribe so an in-flight subscribe can be voided. */
        private readonly contentEpoch = new Map<string, number>();
        /** Set while THIS connection holds the web-pane host role (M6). */
        private hostRegistration: HostRegistration | null = null;
        /** paneID → unsubscribe for this connection's console streams. */
        private readonly consoleSubs = new Map<string, () => void>();
        /** Fires when the connection has held a socket open without ever saying hello. */
        private helloTimer: ReturnType<typeof setTimeout> | null = null;

        constructor(
            private readonly transport: SyncTransport,
            private readonly panes: SyncPaneBridge | undefined,
            /** The upgrade presented a valid token; see `SessionOptions`. */
            private readonly upgradeAuthenticated: boolean
        ) {
            if (helloTimeoutMs > 0) {
                this.helloTimer = setTimeout(() => {
                    this.helloTimer = null;
                    if (this.disposed || this.ready) return;
                    this.reject(
                        'server-error',
                        `no hello within ${String(helloTimeoutMs)}ms`,
                        'hello-timeout'
                    );
                }, helloTimeoutMs);
                // Never hold the daemon's event loop open for an idle stranger.
                this.helloTimer.unref?.();
            }
        }

        private clearHelloTimer(): void {
            if (this.helloTimer === null) return;
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }

        handleMessage(raw: string): void {
            if (this.disposed) return;
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                report(new Error('client sent a non-JSON text frame'), 'ws-parse');
                return;
            }
            if (!isRecord(parsed)) return;
            const type = parsed['type'];
            if (typeof type !== 'string') return;

            if (!this.ready) {
                // Nothing is accepted before the handshake (protocol `ws/messages.ts`) — and
                // since the upgrade may have let an anonymous socket through, "nothing" is
                // now load-bearing rather than merely tidy. Binary frames are refused by the
                // same rule, gated where they arrive (`ws/server.ts`).
                if (type !== 'hello') {
                    this.reject('server-error', 'expected hello as the first message', 'expected-hello');
                    return;
                }
                this.hello(parsed);
                return;
            }

            switch (type) {
                case 'hello':
                    // A second hello is a confused client; ignore rather than resnapshot.
                    return;
                case 'attach-pane':
                    this.attachPane(parsed);
                    return;
                case 'detach-pane': {
                    const paneID = text(parsed['paneID']);
                    if (paneID !== undefined) this.panes?.detach(paneID);
                    return;
                }
                case 'resize-pane': {
                    const paneID = text(parsed['paneID']);
                    const cols = count(parsed['cols']);
                    const rows = count(parsed['rows']);
                    if (paneID === undefined || cols === undefined || rows === undefined) return;
                    this.panes?.resize(paneID, cols, rows);
                    return;
                }
                case 'focus-report':
                    this.focusReport(parsed);
                    return;
                case 'visibility-report':
                    this.visibilityReport(parsed);
                    return;
                case 'command':
                    this.command(parsed);
                    return;
                case 'ping': {
                    const id = text(parsed['id']);
                    this.send({ type: 'pong', id: id ?? '' });
                    return;
                }
                case 'host-register':
                    this.registerHost(text(parsed['name']));
                    return;
                case 'host-unregister':
                    this.releaseHost();
                    return;
                case 'host-rpc-reply': {
                    const id = text(parsed['id']);
                    const payload = parsed['reply'];
                    // Only the connection that currently holds the role may answer RPCs; a
                    // superseded host's late reply must not settle its successor's call.
                    if (id === undefined || !isRecord(payload) || this.hostRegistration === null) return;
                    options.webPanes?.settleHostReply(id, payload as JsonObject);
                    return;
                }
                case 'host-event': {
                    if (this.hostRegistration === null) return;
                    const event = text(parsed['event']);
                    const paneID = text(parsed['paneID']);
                    const payload = parsed['payload'];
                    if (event === undefined || paneID === undefined) return;
                    options.webPanes?.handleHostEvent({
                        event,
                        paneID,
                        ...(text(parsed['tabID']) !== undefined ? { tabID: text(parsed['tabID']) } : {}),
                        payload: isRecord(payload) ? payload : {}
                    });
                    return;
                }
                default:
                    // Forward compatibility: unknown message types are ignored, not fatal.
                    return;
            }
        }

        close(): void {
            if (this.disposed) return;
            this.disposed = true;
            this.ready = false;
            this.clearHelloTimer();
            for (const handle of [...this.handles]) handle.peerGone();
            this.handles.clear();
            // A dropped connection must not leave the daemon watching a file for nobody.
            for (const subscription of this.contentSubs.values()) {
                try {
                    subscription.unsubscribe();
                } catch (error) {
                    report(error, 'content-unsubscribe');
                }
            }
            this.contentSubs.clear();
            this.contentEpoch.clear();
            // A dropped host must free the slot (a later shell can then take over) and every
            // console follower must stop writing into a socket that is gone.
            this.releaseHost();
            for (const unsubscribe of this.consoleSubs.values()) {
                try {
                    unsubscribe();
                } catch (error) {
                    report(error, 'web-console-unsubscribe');
                }
            }
            this.consoleSubs.clear();
            this.panes?.close();
            sessions.delete(this);
        }

        // ── web-pane host (M6) ──────────────────────────────────────────────

        private registerHost(name: string | undefined): void {
            const channel = options.webPanes;
            if (channel === undefined) return;
            // Re-registering on the same connection is idempotent from the caller's side: the
            // old registration is released first, so the registry never leaks a stale slot.
            this.releaseHost();
            try {
                this.hostRegistration = channel.registerHost(
                    {
                        sendJson: (message) => {
                            // The registry revokes by writing to the OUTGOING host's transport;
                            // seeing that frame is how this session learns it lost the role and
                            // must stop being trusted for replies and events.
                            if (message['type'] === 'host-revoked') this.hostRegistration = null;
                            this.send(message);
                        }
                    },
                    name === undefined ? {} : { name }
                );
            } catch (error) {
                report(error, 'host-register');
            }
        }

        private releaseHost(): void {
            const registration = this.hostRegistration;
            this.hostRegistration = null;
            if (registration === null) return;
            try {
                registration.release('unregistered');
            } catch (error) {
                report(error, 'host-unregister');
            }
        }

        /** True while this connection holds the host role (tests / diagnostics). */
        get isWebPaneHost(): boolean {
            return this.hostRegistration !== null;
        }

        // ── handshake ───────────────────────────────────────────────────────────────

        private hello(message: Record<string, unknown>): void {
            const version = count(message['protocolVersion']);
            if (version !== protocolVersion) {
                this.reject(
                    'protocol-mismatch',
                    `daemon speaks client protocol v${protocolVersion}, client speaks v${version ?? 'unknown'}`,
                    'protocol-mismatch'
                );
                return;
            }

            // Where authentication actually happens now. Three cases:
            //   - no `validateToken`: the daemon has no token (dev / `allowAnonymous`);
            //   - the hello carries a token: it must be the right one, whatever the upgrade
            //     said — an authenticated upgrade must not launder a bogus hello token;
            //   - the hello carries none: allowed only when the UPGRADE authenticated, which
            //     is the bearer-header path both Electron shell sockets use.
            const token = typeof message['token'] === 'string' ? message['token'] : '';
            if (options.validateToken !== undefined) {
                const exempt = this.upgradeAuthenticated && token.length === 0;
                if (!exempt && !options.validateToken(token)) {
                    this.reject('unauthorized', BAD_TOKEN_MESSAGE, 'bad-token');
                    return;
                }
            }

            this.clearHelloTimer();
            this.client = parseClientInfo(message['client']);

            this.send({
                type: 'welcome',
                protocolVersion,
                clientID: this.clientID,
                daemon: {
                    version: options.daemon.version,
                    build: options.daemon.build,
                    pid: options.daemon.pid ?? process.pid
                }
            });

            // `resumeFromSeq` is accepted by the protocol but cannot be served safely yet:
            // `seq` is per daemon PROCESS, so a client resuming across a daemon restart
            // would splice deltas onto a mirror of the previous daemon's state. Until the
            // handshake carries an instance id (WP3.1), say so and send a snapshot.
            if (message['resumeFromSeq'] !== undefined && message['resumeFromSeq'] !== null) {
                this.send({ type: 'resync-required', reason: 'seq-gap' });
            }
            this.snapshot();
            // Deltas only start flowing once the snapshot they extend has been written, so
            // the client can never see delta N before the snapshot anchored at N.
            this.ready = true;

            // Sugar for the Electron shell: claiming the host role in the handshake saves a
            // round-trip and removes the window where the daemon has a client but no host.
            if (this.client?.capabilities?.includes(WEB_HOST_CAPABILITY) === true) {
                this.registerHost(this.client.name);
            }
        }

        private snapshot(): void {
            this.send({ type: 'snapshot', seq, state: serializeState(store.getState()) });
        }

        /**
         * Say no, in words, then close cleanly. Both halves matter: the `rejected` frame is the
         * only channel that can explain a refusal to a browser, and the coded close (4000-4999,
         * the app-defined range) is what stops the client reading the drop as an abnormal 1006
         * and retrying forever.
         */
        private reject(code: WsRejectionCode, message: string, reason?: WsRejectionReason): void {
            this.send({
                type: 'rejected',
                code,
                message,
                protocolVersion,
                ...(reason !== undefined ? { reason } : {})
            });
            const closeCode =
                code === 'protocol-mismatch'
                    ? WS_CLOSE_CODES.protocolMismatch
                    : code === 'unauthorized'
                      ? WS_CLOSE_CODES.unauthorized
                      : WS_CLOSE_CODES.serverError;
            this.transport.close(closeCode, reason ?? code);
            this.close();
        }

        // ── reports ─────────────────────────────────────────────────────────────────

        private focusReport(message: Record<string, unknown>): void {
            const workspaceID = text(message['workspaceID']);
            if (workspaceID === undefined) return;
            const rawPane = message['paneID'];
            const paneID = typeof rawPane === 'string' && rawPane.length > 0 ? rawPane : null;

            this.focusedPaneID = paneID;
            this.setActiveWorkspace(workspaceID);

            const workspace = workspaceByID(store.getState(), workspaceID);
            if (workspace === null || workspace.focusedPaneID === paneID) return;
            // Focus is daemon-canonical: the last report from any client wins.
            store.dispatch({ type: 'focus-pane', workspaceID, paneID });
        }

        private visibilityReport(message: Record<string, unknown>): void {
            const workspaceID = text(message['workspaceID']);
            const raw = message['visiblePaneIDs'];
            const visible = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
            this.visiblePaneIDs = new Set(visible);
            this.documentVisible = message['documentVisible'] === true;
            // A backgrounded tab must not claim the active workspace back from a visible one.
            if (workspaceID !== undefined && this.documentVisible) this.setActiveWorkspace(workspaceID);
        }

        private setActiveWorkspace(workspaceID: string): void {
            if (this.activeWorkspaceID === workspaceID) return;
            this.activeWorkspaceID = workspaceID;
            const state = store.getState();
            if (state.lastActiveWorkspaceID === workspaceID) return;
            if (workspaceByID(state, workspaceID) === null) return;
            // The daemon keeps the last-active workspace so a fresh client restores where
            // the user left off (PLAN.md); the per-client value above is the live one.
            store.dispatch({ type: 'set-active-workspace', id: workspaceID, now: now() });
        }

        // ── commands ────────────────────────────────────────────────────────────────

        private attachPane(message: Record<string, unknown>): void {
            const paneID = text(message['paneID']);
            if (paneID === undefined || this.panes === undefined) return;
            const cols = count(message['cols']);
            const rows = count(message['rows']);
            const size = cols !== undefined && rows !== undefined ? { cols, rows } : undefined;
            try {
                const result = this.panes.attach(paneID, size);
                if (result instanceof Promise) result.catch((error: unknown) => report(error, `attach-pane ${paneID}`));
            } catch (error) {
                report(error, `attach-pane ${paneID}`);
            }
        }

        private command(message: Record<string, unknown>): void {
            const id = text(message['id']);
            if (id === undefined) return;
            const payload = message['payload'];

            // WS-only verbs are matched before the wire decode, which would reject them as
            // unknown commands (they are deliberately not part of the CLI's vocabulary).
            if (isRecord(payload)) {
                const name = text(payload['command']);
                if (name !== undefined && isContentCommand(name)) {
                    this.contentCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isWebCommand(name)) {
                    this.webCommand(id, name, payload);
                    return;
                }
                if (name !== undefined && isWsOnlyCommand(name)) {
                    let reply: JsonObject;
                    try {
                        reply = handleWsOnlyCommand(store, name, payload);
                    } catch (error) {
                        report(error, `ws-command ${name}`);
                        reply = { ...errorReply('handler failed') };
                    }
                    this.send({ type: 'command-reply', id, reply });
                    return;
                }
            }

            const decoded = decodeWireObject(payload);

            if (!decoded.ok) {
                // Deliberate divergence from the control socket's silent drop (PLAN.md
                // "deliberate fixes"): a WS command is an RPC and must always settle.
                this.send({ type: 'command-reply', id, reply: { ...errorReply(decoded.detail) } });
                return;
            }

            let answered = false;
            for (const item of dispatchSequence(decoded)) {
                const wire = item.kind === 'message' ? item.message : dualFireMessage(item.event);
                let handle: WsReplyHandle | null = null;
                if (item.reply && !answered) {
                    answered = true;
                    handle = new WsReplyHandle(this.transport, id, (h) => this.handles.delete(h));
                    this.handles.add(handle);
                }
                try {
                    dispatcher(wire, handle);
                } catch (error) {
                    report(error, `ws-command ${wire.command}`);
                    if (handle !== null && !handle.closed) {
                        handle.send({ ...errorReply('handler failed') });
                        handle.close();
                    }
                }
            }

            // Fire-and-forget verbs get an acknowledgement so the client's promise settles.
            if (!answered) this.send({ type: 'command-reply', id, reply: { ok: true } });
        }

        // ── content panes (M5) ──────────────────────────────────────────────────────

        private contentReply(id: string, reply: JsonObject): void {
            this.send({ type: 'command-reply', id, reply });
        }

        /** Release this pane's subscription (if any) and return the new epoch. */
        private dropContentSub(paneID: string): number {
            this.contentSubs.get(paneID)?.unsubscribe();
            this.contentSubs.delete(paneID);
            const epoch = (this.contentEpoch.get(paneID) ?? 0) + 1;
            this.contentEpoch.set(paneID, epoch);
            return epoch;
        }

        private contentCommand(id: string, command: ContentCommand, payload: Record<string, unknown>): void {
            const content = options.content;
            if (content === undefined) {
                this.contentReply(id, failure('content panes are not available'));
                return;
            }
            const paneID = text(payload['pane_id']);
            if (paneID === undefined) {
                this.contentReply(id, failure(`${command} requires pane_id`));
                return;
            }

            if (command === 'content-unsubscribe') {
                this.dropContentSub(paneID);
                this.contentReply(id, { ok: true, pane_id: paneID });
                return;
            }

            const settle = (promise: Promise<ContentPaneState>): void => {
                promise.then(
                    (state) => {
                        this.contentReply(id, {
                            ok: true,
                            pane_id: paneID,
                            state: state as unknown as JsonObject
                        });
                    },
                    (error: unknown) => {
                        this.contentReply(id, failure(toError(error).message));
                    }
                );
            };

            switch (command) {
                case 'content-subscribe': {
                    // Re-subscribing replaces the old handle so a client that lost track of its
                    // subscription cannot end up with two event streams for one pane.
                    const epoch = this.dropContentSub(paneID);
                    content
                        .subscribe(paneID, (state) => {
                            this.send({
                                type: CONTENT_UPDATED_MESSAGE,
                                paneID,
                                state: state as unknown as JsonObject
                            });
                        })
                        .then(
                            (subscription) => {
                                // Voided while the load was in flight (closed, unsubscribed, or
                                // superseded by a newer subscribe): release it, answer honestly.
                                if (this.disposed || this.contentEpoch.get(paneID) !== epoch) {
                                    subscription.unsubscribe();
                                    this.contentReply(id, failure('subscription was cancelled'));
                                    return;
                                }
                                this.contentSubs.set(paneID, subscription);
                                this.contentReply(id, {
                                    ok: true,
                                    pane_id: paneID,
                                    state: subscription.state as unknown as JsonObject
                                });
                            },
                            (error: unknown) => {
                                this.contentReply(id, failure(toError(error).message));
                            }
                        );
                    return;
                }
                case 'markdown-set-mode': {
                    const mode = text(payload['mode']);
                    if (mode !== 'view' && mode !== 'edit') {
                        this.contentReply(id, failure("markdown-set-mode requires mode 'view' or 'edit'"));
                        return;
                    }
                    settle(content.setMode(paneID, mode));
                    return;
                }
                case 'content-set-text': {
                    const value = payload['text'];
                    if (typeof value !== 'string') {
                        this.contentReply(id, failure('content-set-text requires text'));
                        return;
                    }
                    settle(content.setText(paneID, value));
                    return;
                }
                case 'diff-refresh':
                    settle(content.refresh(paneID));
                    return;
                default:
                    settle(content.save(paneID));
                    return;
            }
        }

        // ── web-pane console subscriptions (M6) ─────────────────────────────

        /**
         * `web-console-subscribe` is the WS twin of `nex web console --follow`: the reply is
         * the same catch-up drain object, and every later line arrives as its own
         * `web-console-line` message. Both readers share one ring buffer per pane, so a drop
         * notice is delivered to whoever consumes it first (web-pane.md §9.3).
         */
        private webCommand(id: string, command: WebCommand, payload: Record<string, unknown>): void {
            const channel = options.webPanes;
            if (channel === undefined) {
                this.send({ type: 'command-reply', id, reply: failure('web panes are not available') });
                return;
            }
            const paneID = text(payload['pane_id']);
            if (paneID === undefined) {
                this.send({
                    type: 'command-reply',
                    id,
                    reply: failure(`${command} requires pane_id`)
                });
                return;
            }

            const drop = (): void => {
                this.consoleSubs.get(paneID)?.();
                this.consoleSubs.delete(paneID);
            };

            if (command === 'web-console-unsubscribe') {
                drop();
                this.send({ type: 'command-reply', id, reply: { ok: true, pane_id: paneID } });
                return;
            }

            // Re-subscribing replaces the old handle so a client that lost track of its
            // subscription cannot end up with two streams for one pane.
            drop();
            const since = count(payload['since']);
            const level = text(payload['level']);
            const drain = channel.console.drain(paneID, {
                ...(since !== undefined ? { since } : {}),
                ...(level !== undefined ? { level } : {}),
                ...(payload['clear'] === true ? { clear: true } : {})
            });
            const unsubscribe = channel.subscribeConsole(paneID, {
                push: (line) => {
                    this.send({ type: WEB_CONSOLE_LINE_MESSAGE, paneID, line });
                },
                end: () => {
                    drop();
                }
            });
            this.consoleSubs.set(paneID, unsubscribe);
            this.send({
                type: 'command-reply',
                id,
                reply: {
                    ok: true,
                    pane_id: paneID,
                    lines: drain.lines,
                    next_since: drain.next_since,
                    dropped: drain.dropped,
                    follow: true
                }
            });
        }

        // ── output ──────────────────────────────────────────────────────────────────

        send(message: JsonObject): void {
            if (this.disposed) return;
            try {
                this.transport.sendJson(message);
            } catch (error) {
                report(error, 'ws-send');
            }
        }

        /** Daemon shutdown: say goodbye, then release the connection's resources. */
        shutdown(): void {
            if (this.disposed) return;
            try {
                this.transport.close(1001, 'daemon shutting down');
            } catch (error) {
                report(error, 'ws-close');
            }
            this.close();
        }

        /** Suppression rule for pane notifications (agent-lifecycle.md §7.1/§7.4). */
        attends(workspaceID: string, paneID: string): boolean {
            if (!this.ready || !this.documentVisible) return false;
            if (this.activeWorkspaceID !== workspaceID) return false;
            if (this.focusedPaneID !== paneID) return false;
            // An empty visibility set means the client never reported one; trust focus.
            return this.visiblePaneIDs.size === 0 || this.visiblePaneIDs.has(paneID);
        }
    }

    const unsubscribe = store.subscribe((events) => {
        if (closed || events.length === 0) return;
        seq += 1;
        const message: JsonObject = { type: 'delta', seq, events: serializeDomainEvents(events) };
        for (const session of sessions) {
            if (session.ready) session.send(message);
        }
    });

    return {
        createSession(transport, panes, sessionOptions) {
            const session = new SessionImpl(transport, panes, sessionOptions?.authenticated === true);
            if (closed) {
                transport.close(WS_CLOSE_CODES.serverError, 'shutting down');
                // Disposes the handshake deadline too: a session nobody registered must not
                // keep a timer alive waiting for a hello it will never accept.
                session.close();
                return session;
            }
            sessions.add(session);
            return session;
        },
        broadcast(event) {
            if (closed) return;
            const type = typeof event['type'] === 'string' ? (event['type'] as string) : 'notification';
            const message = { ...event, type } as JsonObject;
            const workspaceID = typeof event['workspaceID'] === 'string' ? (event['workspaceID'] as string) : undefined;
            const paneID = typeof event['paneID'] === 'string' ? (event['paneID'] as string) : undefined;
            const suppressible = type === 'notification' && workspaceID !== undefined && paneID !== undefined;
            for (const session of sessions) {
                if (!session.ready) continue;
                if (suppressible && session.attends(workspaceID, paneID)) continue;
                session.send(message);
            }
        },
        get sessions() {
            return [...sessions];
        },
        get seq() {
            return seq;
        },
        presence() {
            let visibleClients = 0;
            for (const session of sessions) {
                if (session.ready && session.documentVisible) visibleClients += 1;
            }
            return { clients: sessions.size, visibleClients, anyVisible: visibleClients > 0 };
        },
        isPaneAttended(workspaceID, paneID) {
            for (const session of sessions) {
                if (session.attends(workspaceID, paneID)) return true;
            }
            return false;
        },
        close() {
            if (closed) return;
            closed = true;
            unsubscribe();
            for (const session of [...sessions]) session.shutdown();
            sessions.clear();
        }
    };
}
