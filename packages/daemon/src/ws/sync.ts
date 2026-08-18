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
    type WsRejectionCode
} from '@nex/protocol';

import { dualFireMessage } from '../control/server.js';
import type { ControlDispatcher, DomainStore, ReplyHandle } from '../seams.js';
import { groupByID, workspaceByID, workspaceContainingVisiblePane } from '../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/types.js';
import { serializeDomainEvents, serializeState } from './serialize.js';

export type NexDomainStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** WS close codes for the rejection reasons (4000-4999 is the app-defined range). */
export const WS_CLOSE_CODES = {
    protocolMismatch: 4001,
    unauthorized: 4003,
    serverError: 4500
} as const;

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
    /** Second token check, after the HTTP upgrade gate. Absent = accept whatever upgraded. */
    readonly validateToken?: ((token: string) => boolean) | undefined;
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

export interface SyncHub {
    createSession(transport: SyncTransport, panes?: SyncPaneBridge | undefined): SyncSession;
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
    return {
        kind: known,
        ...(name !== undefined ? { name } : {}),
        ...(version !== undefined ? { version } : {})
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

        constructor(
            private readonly transport: SyncTransport,
            private readonly panes: SyncPaneBridge | undefined
        ) {}

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
                // Nothing is accepted before the handshake (protocol `ws/messages.ts`).
                if (type !== 'hello') {
                    this.reject('server-error', 'expected hello as the first message');
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
                default:
                    // Forward compatibility: unknown message types are ignored, not fatal.
                    return;
            }
        }

        close(): void {
            if (this.disposed) return;
            this.disposed = true;
            this.ready = false;
            for (const handle of [...this.handles]) handle.peerGone();
            this.handles.clear();
            this.panes?.close();
            sessions.delete(this);
        }

        // ── handshake ───────────────────────────────────────────────────────────────

        private hello(message: Record<string, unknown>): void {
            const version = count(message['protocolVersion']);
            if (version !== protocolVersion) {
                this.reject(
                    'protocol-mismatch',
                    `daemon speaks client protocol v${protocolVersion}, client speaks v${version ?? 'unknown'}`
                );
                return;
            }

            const token = typeof message['token'] === 'string' ? message['token'] : '';
            if (options.validateToken !== undefined && !options.validateToken(token)) {
                this.reject('unauthorized', 'token rejected');
                return;
            }

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
        }

        private snapshot(): void {
            this.send({ type: 'snapshot', seq, state: serializeState(store.getState()) });
        }

        private reject(code: WsRejectionCode, message: string): void {
            this.send({ type: 'rejected', code, message, protocolVersion });
            const closeCode =
                code === 'protocol-mismatch'
                    ? WS_CLOSE_CODES.protocolMismatch
                    : code === 'unauthorized'
                      ? WS_CLOSE_CODES.unauthorized
                      : WS_CLOSE_CODES.serverError;
            this.transport.close(closeCode, code);
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
        createSession(transport, panes) {
            const session = new SessionImpl(transport, panes);
            if (closed) {
                transport.close(WS_CLOSE_CODES.serverError, 'shutting down');
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
