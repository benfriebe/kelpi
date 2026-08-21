/**
 * `NexConnection` — the client half of the client-sync socket (WP3.1).
 *
 * One WebSocket carries both channels the daemon serves (`packages/daemon/src/ws/server.ts`):
 * text frames are the JSON protocol (`@nex/protocol` `ws/messages.ts`) and binary frames are
 * multiplexed PTY traffic (`ws/pty.ts`). This module owns the socket itself — handshake,
 * framing, liveness, reconnection — and nothing else: it never parses domain state (that is
 * `state/store.ts`), never mints command ids (`./commands.ts`), and never buffers terminal
 * bytes (`./pty.ts`). Everything above it subscribes to typed events.
 *
 * Behaviour that is a deliberate contract with the daemon:
 *
 *   - **Hello first, always.** The daemon accepts nothing before `hello`
 *     (`ws/sync.ts` `handleMessage`), so anything sent before `welcome` is queued and flushed
 *     once the handshake settles.
 *   - **No `resumeFromSeq`.** `seq` is per daemon PROCESS; the daemon answers a resume attempt
 *     with `resync-required` and a fresh snapshot anyway (`ws/sync.ts` `hello`). We therefore
 *     always take the snapshot, and a reconnect REPLACES the mirror rather than splicing.
 *   - **Rejections are terminal for auth/version.** `protocol-mismatch` / `unauthorized` stop
 *     the reconnect loop (retrying a bad token is a hot loop against a refusal); `server-error`
 *     keeps retrying. The daemon upgrades an unauthenticated socket on purpose so this path is
 *     reachable at all: a refused UPGRADE reaches a browser as `onerror` + close 1006, which is
 *     indistinguishable from a dropped network and gets retried forever.
 *   - **Heartbeat** rides the protocol's own `ping`/`pong` pair, not a WS control frame, so a
 *     wedged daemon reader (not just a dead socket) is detected too.
 */

import {
    WS_PANE_MODES_MESSAGE,
    WS_PROTOCOL_VERSION,
    decodePtyFrame,
    type JsonObject,
    type PtyFrame,
    type WsClientInfo,
    type WsClientMessage,
    type WsCommandReplyMessage,
    type WsDeltaMessage,
    type WsNotificationMessage,
    type WsPaneExitMessage,
    type WsPaneModesMessage,
    type WsRejectedMessage,
    type WsResyncRequiredMessage,
    type WsSnapshotMessage,
    type WsWelcomeMessage
} from '@nex/protocol';

// ── transport seam ──────────────────────────────────────────────────────────────────

export interface SocketCloseLike {
    readonly code?: number;
    readonly reason?: string;
    readonly wasClean?: boolean;
}

export interface SocketMessageLike {
    readonly data: unknown;
}

/** The slice of `WebSocket` this module uses; fakes implement it directly (`./testing.ts`). */
export interface SocketLike {
    binaryType: string;
    readonly readyState: number;
    send(data: string | ArrayBufferLike | ArrayBufferView): void;
    close(code?: number, reason?: string): void;
    onopen: ((event: unknown) => void) | null;
    onclose: ((event: SocketCloseLike) => void) | null;
    onerror: ((event: unknown) => void) | null;
    onmessage: ((event: SocketMessageLike) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export const SOCKET_OPEN = 1;

interface WebSocketCtor {
    new (url: string): unknown;
}

export function defaultSocketFactory(url: string): SocketLike {
    const ctor = (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (ctor === undefined) throw new Error('this environment has no WebSocket implementation');
    return new ctor(url) as unknown as SocketLike;
}

// ── events ──────────────────────────────────────────────────────────────────────────

export type ConnectionStatus =
    /** Never connected, or `close()` has not been followed by a `connect()`. */
    | 'idle'
    /** Socket opening / handshake in flight. */
    | 'connecting'
    /** `welcome` received; commands and frames flow. */
    | 'connected'
    /** Dropped, waiting out the backoff before the next attempt. */
    | 'reconnecting'
    /** `close()` was called: no further reconnects. */
    | 'closed'
    /** The daemon refused the handshake for a reason retrying cannot fix. */
    | 'rejected';

/** Daemon → client JSON that `@nex/protocol` does not declare (see `ws/streams.ts`). */
export interface PtyResyncMessage {
    readonly type: 'pty-resync';
    readonly paneID: string;
    readonly reason: string;
}

/** Companion to a notification: the shell should request user attention (dock bounce). */
export interface AttentionMessage {
    readonly type: 'attention-request';
    readonly paneID: string;
    readonly workspaceID: string;
}

export interface ConnectionError {
    readonly context: string;
    readonly message: string;
    readonly cause?: unknown;
}

export interface ConnectionEvents {
    status: ConnectionStatus;
    welcome: WsWelcomeMessage;
    snapshot: WsSnapshotMessage;
    delta: WsDeltaMessage;
    'command-reply': WsCommandReplyMessage;
    notification: WsNotificationMessage;
    attention: AttentionMessage;
    'pane-exit': WsPaneExitMessage;
    /** A pane's VT modes changed (§TERM-037: the client encodes DEC mouse reports itself). */
    'pane-modes': WsPaneModesMessage;
    'resync-required': WsResyncRequiredMessage;
    'pty-resync': PtyResyncMessage;
    rejected: WsRejectedMessage;
    /** Every decoded JSON message, including ones with no dedicated event. */
    message: JsonObject;
    /** Every decoded binary PTY frame. */
    frame: PtyFrame;
    error: ConnectionError;
}

export type ConnectionEventName = keyof ConnectionEvents;
export type ConnectionListener<K extends ConnectionEventName> = (payload: ConnectionEvents[K]) => void;

// ── options ─────────────────────────────────────────────────────────────────────────

export interface BackoffOptions {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly factor?: number;
    /** Fractional jitter applied symmetrically (0.2 = ±20%). */
    readonly jitter?: number;
}

export interface NexConnectionOptions {
    /** Daemon base URL, WS URL, or path. Defaults to the page's own origin + `/ws`. */
    readonly url?: string | undefined;
    /** The run dir's `.token`; rides as `?token=` (browsers cannot set headers on WS). */
    readonly token?: string | undefined;
    readonly client?: WsClientInfo | undefined;
    readonly socketFactory?: SocketFactory | undefined;
    readonly protocolVersion?: number | undefined;
    /** 0 disables the heartbeat entirely. */
    readonly heartbeatIntervalMs?: number | undefined;
    readonly heartbeatTimeoutMs?: number | undefined;
    readonly backoff?: BackoffOptions | undefined;
    readonly random?: (() => number) | undefined;
    readonly now?: (() => number) | undefined;
    /** Max queued messages/frames while the handshake is in flight (oldest dropped). */
    readonly maxQueued?: number | undefined;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_QUEUED = 256;

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
    initialMs: 500,
    maxMs: 15_000,
    factor: 2,
    jitter: 0.2
};

export const DEFAULT_WS_PATH = '/ws';

/**
 * Normalize whatever the caller has (an origin, a full ws URL, a bare path, nothing) into the
 * daemon's `/ws` endpoint, with the token attached as a query parameter.
 */
export function resolveWsUrl(base?: string, token?: string): string {
    const location = (globalThis as { location?: { href?: string; protocol?: string; host?: string } }).location;
    const fallbackOrigin =
        location?.protocol !== undefined && location.host !== undefined
            ? `${location.protocol}//${location.host}`
            : 'http://localhost';
    const raw = base !== undefined && base.trim().length > 0 ? base.trim() : DEFAULT_WS_PATH;

    let url: URL;
    try {
        url = new URL(raw, location?.href ?? fallbackOrigin);
    } catch {
        url = new URL(DEFAULT_WS_PATH, fallbackOrigin);
    }

    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';

    if (url.pathname === '' || url.pathname === '/') url.pathname = DEFAULT_WS_PATH;
    if (token !== undefined && token.length > 0) url.searchParams.set('token', token);
    return url.toString();
}

/** `?token=…` off the page URL — how a browser client is handed the daemon token. */
export function tokenFromLocation(search?: string): string | undefined {
    const raw =
        search ?? (globalThis as { location?: { search?: string } }).location?.search ?? '';
    if (raw.length === 0) return undefined;
    const value = new URLSearchParams(raw).get('token');
    return value !== null && value.length > 0 ? value : undefined;
}

// ── implementation ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class NexConnection {
    private readonly options: NexConnectionOptions;
    private readonly socketFactory: SocketFactory;
    private readonly backoff: Required<BackoffOptions>;
    private readonly listeners = new Map<ConnectionEventName, Set<(payload: never) => void>>();

    private socket: SocketLike | null = null;
    private currentStatus: ConnectionStatus = 'idle';
    private ready = false;
    private stopped = true;
    private fatal = false;
    private attempt = 0;
    private url: string;
    private token: string;

    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private lastActivityAt = 0;
    private pingSentAt: number | null = null;
    private pingCounter = 0;

    private readonly queuedJson: string[] = [];
    private readonly queuedFrames: Uint8Array[] = [];

    private welcomeMessage: WsWelcomeMessage | null = null;

    constructor(options: NexConnectionOptions = {}) {
        this.options = options;
        this.socketFactory = options.socketFactory ?? defaultSocketFactory;
        this.backoff = { ...DEFAULT_BACKOFF, ...(options.backoff ?? {}) };
        this.token = options.token ?? '';
        this.url = resolveWsUrl(options.url, this.token);
    }

    // ── public surface ──────────────────────────────────────────────────────────────

    get status(): ConnectionStatus {
        return this.currentStatus;
    }

    get isConnected(): boolean {
        return this.ready;
    }

    get clientID(): string | null {
        return this.welcomeMessage?.clientID ?? null;
    }

    get daemon(): WsWelcomeMessage['daemon'] | null {
        return this.welcomeMessage?.daemon ?? null;
    }

    /** The URL the next attempt will dial (token included). */
    get target(): string {
        return this.url;
    }

    on<K extends ConnectionEventName>(event: K, listener: ConnectionListener<K>): () => void {
        const set = this.listeners.get(event) ?? new Set<(payload: never) => void>();
        set.add(listener as (payload: never) => void);
        this.listeners.set(event, set);
        return () => {
            set.delete(listener as (payload: never) => void);
        };
    }

    /** Idempotent: a second call while connecting/connected is a no-op. */
    connect(url?: string, token?: string): void {
        if (token !== undefined) this.token = token;
        if (url !== undefined || token !== undefined) {
            this.url = resolveWsUrl(url ?? this.options.url, this.token);
        }
        this.stopped = false;
        this.fatal = false;
        if (this.socket !== null) return;
        this.clearReconnectTimer();
        this.open();
    }

    /** Clean shutdown: no reconnect, queues dropped. */
    close(code = 1000, reason = 'client closed'): void {
        this.stopped = true;
        this.clearReconnectTimer();
        this.stopHeartbeat();
        this.queuedJson.length = 0;
        this.queuedFrames.length = 0;
        const socket = this.socket;
        this.socket = null;
        this.ready = false;
        if (socket !== null) {
            this.detach(socket);
            try {
                socket.close(code, reason);
            } catch {
                // The socket is already gone; nothing left to do.
            }
        }
        this.setStatus('closed');
    }

    /**
     * Drop and redial immediately — the only way to recover a delta-stream gap, since the
     * daemon has no client→server resync request (a fresh connection re-snapshots).
     */
    resync(reason = 'client requested resync'): void {
        if (this.stopped) return;
        this.attempt = 0;
        const socket = this.socket;
        this.ready = false;
        this.stopHeartbeat();
        if (socket !== null) {
            this.detach(socket);
            this.socket = null;
            try {
                socket.close(4000, reason);
            } catch {
                // Already closed.
            }
        }
        this.clearReconnectTimer();
        this.setStatus('reconnecting');
        this.open();
    }

    /** Queued until the handshake settles; `false` means "not on the wire yet". */
    send(message: WsClientMessage): boolean {
        const payload = JSON.stringify(message);
        if (this.ready && this.socket !== null && this.socket.readyState === SOCKET_OPEN) {
            try {
                this.socket.send(payload);
                return true;
            } catch (error) {
                this.emitError('ws-send', error);
                return false;
            }
        }
        this.pushQueue(this.queuedJson, payload);
        return false;
    }

    /** Binary PTY frame (already encoded by `./pty.ts`). */
    sendFrame(frame: Uint8Array): boolean {
        if (this.ready && this.socket !== null && this.socket.readyState === SOCKET_OPEN) {
            try {
                this.socket.send(frame);
                return true;
            } catch (error) {
                this.emitError('ws-send-frame', error);
                return false;
            }
        }
        this.pushQueue(this.queuedFrames, frame);
        return false;
    }

    // ── socket lifecycle ────────────────────────────────────────────────────────────

    private open(): void {
        this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
        let socket: SocketLike;
        try {
            socket = this.socketFactory(this.url);
        } catch (error) {
            this.emitError('ws-open', error);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;
        try {
            socket.binaryType = 'arraybuffer';
        } catch {
            // Some fakes expose it read-only; the message handler copes with Blob anyway.
        }
        socket.onopen = () => this.handleOpen(socket);
        socket.onclose = (event) => this.handleClose(socket, event);
        socket.onerror = (event) => {
            this.emitError('ws-error', event);
        };
        socket.onmessage = (event) => this.handleMessage(event.data);
    }

    private detach(socket: SocketLike): void {
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
    }

    private handleOpen(socket: SocketLike): void {
        if (socket !== this.socket) return;
        // Status stays whatever `open()` set (`connecting` on a first dial, `reconnecting` on a
        // redial) until `welcome` proves the daemon is actually talking to us.
        this.lastActivityAt = this.nowMs();
        const hello: WsClientMessage = {
            type: 'hello',
            protocolVersion: this.options.protocolVersion ?? WS_PROTOCOL_VERSION,
            token: this.token,
            client: this.options.client ?? { kind: 'browser', name: 'nex-web' }
        };
        try {
            socket.send(JSON.stringify(hello));
        } catch (error) {
            this.emitError('ws-hello', error);
        }
    }

    private handleClose(socket: SocketLike, event: SocketCloseLike): void {
        if (socket !== this.socket) return;
        this.detach(socket);
        this.socket = null;
        this.ready = false;
        this.stopHeartbeat();
        // `fatal` is checked first: a rejection sets `stopped` too, and "rejected" is the more
        // useful thing to show the user than "closed".
        if (this.fatal) {
            this.setStatus('rejected');
            return;
        }
        if (this.stopped) {
            this.setStatus('closed');
            return;
        }
        if (event.code !== undefined && event.code !== 1000 && event.code !== 4000) {
            this.emitError('ws-close', new Error(`socket closed (${event.code})`));
        }
        this.scheduleReconnect();
    }

    private handleMessage(data: unknown): void {
        this.lastActivityAt = this.nowMs();
        if (typeof data === 'string') {
            this.handleText(data);
            return;
        }
        if (data instanceof ArrayBuffer) {
            this.handleBinary(new Uint8Array(data));
            return;
        }
        if (ArrayBuffer.isView(data)) {
            const view = data as ArrayBufferView;
            this.handleBinary(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
            return;
        }
        const blob = data as { arrayBuffer?: () => Promise<ArrayBuffer> };
        if (typeof blob?.arrayBuffer === 'function') {
            void blob
                .arrayBuffer()
                .then((buffer) => this.handleBinary(new Uint8Array(buffer)))
                .catch((error: unknown) => this.emitError('ws-blob', error));
            return;
        }
        this.emitError('ws-message', new Error('unsupported WebSocket payload'));
    }

    private handleBinary(bytes: Uint8Array): void {
        const frame = decodePtyFrame(bytes);
        // A truncated or unknown frame type is ignored (forward compatibility), matching the
        // daemon's own decode contract.
        if (frame === undefined) return;
        this.emit('frame', frame);
    }

    private handleText(raw: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            this.emitError('ws-parse', error);
            return;
        }
        if (!isRecord(parsed)) return;
        const message = parsed as JsonObject;
        const type = text(message['type']);
        if (type === undefined) return;

        switch (type) {
            case 'welcome':
                this.handleWelcome(message as unknown as WsWelcomeMessage);
                break;
            case 'rejected':
                this.handleRejected(message as unknown as WsRejectedMessage);
                break;
            case 'snapshot':
                this.emit('snapshot', message as unknown as WsSnapshotMessage);
                break;
            case 'delta':
                this.emit('delta', message as unknown as WsDeltaMessage);
                break;
            case 'command-reply':
                this.emit('command-reply', message as unknown as WsCommandReplyMessage);
                break;
            case 'notification':
                this.emit('notification', message as unknown as WsNotificationMessage);
                break;
            case 'attention-request':
                this.emit('attention', message as unknown as AttentionMessage);
                break;
            case 'pane-exit':
                this.emit('pane-exit', message as unknown as WsPaneExitMessage);
                break;
            case WS_PANE_MODES_MESSAGE:
                this.emit('pane-modes', message as unknown as WsPaneModesMessage);
                break;
            case 'resync-required':
                this.emit('resync-required', message as unknown as WsResyncRequiredMessage);
                break;
            case 'pty-resync':
                this.emit('pty-resync', message as unknown as PtyResyncMessage);
                break;
            case 'pong':
                this.pingSentAt = null;
                break;
            default:
                // Unknown types are forwarded raw and never fatal.
                break;
        }
        this.emit('message', message);
    }

    private handleWelcome(message: WsWelcomeMessage): void {
        this.welcomeMessage = message;
        this.ready = true;
        this.attempt = 0;
        this.pingSentAt = null;
        this.startHeartbeat();
        // Status first, so subscribers (the PTY client's re-attach) get their frames onto the
        // wire ahead of whatever was queued during the handshake.
        this.setStatus('connected');
        this.emit('welcome', message);
        this.flushQueues();
    }

    private handleRejected(message: WsRejectedMessage): void {
        // Retrying a bad token or a version mismatch is a hot loop against a refusal; only a
        // transient server error is worth another dial.
        this.fatal = message.code !== 'server-error';
        this.emit('rejected', message);
        // The daemon's sentence, unadorned: it is written to be shown to a person (e.g. "open
        // the client via 'nexd url'"), and a `code:` prefix only gets in the way of that.
        this.emitError('ws-rejected', new Error(message.message));
        if (this.fatal) {
            this.stopped = true;
            this.setStatus('rejected');
        }
    }

    // ── queues, heartbeat, backoff ──────────────────────────────────────────────────

    private pushQueue<T>(queue: T[], item: T): void {
        const max = this.options.maxQueued ?? DEFAULT_MAX_QUEUED;
        queue.push(item);
        while (queue.length > max) queue.shift();
    }

    private flushQueues(): void {
        const socket = this.socket;
        if (socket === null || socket.readyState !== SOCKET_OPEN) return;
        const json = this.queuedJson.splice(0, this.queuedJson.length);
        const frames = this.queuedFrames.splice(0, this.queuedFrames.length);
        for (const payload of json) {
            try {
                socket.send(payload);
            } catch (error) {
                this.emitError('ws-flush', error);
            }
        }
        for (const frame of frames) {
            try {
                socket.send(frame);
            } catch (error) {
                this.emitError('ws-flush-frame', error);
            }
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        if (interval <= 0) return;
        this.heartbeatTimer = setInterval(() => this.heartbeatTick(), interval);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer === null) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        this.pingSentAt = null;
    }

    private heartbeatTick(): void {
        if (!this.ready) return;
        const now = this.nowMs();
        const timeout = this.options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
        if (this.pingSentAt !== null) {
            if (now - this.pingSentAt >= timeout) {
                this.emitError('heartbeat', new Error('daemon did not answer ping'));
                this.resync('heartbeat timeout');
            }
            return;
        }
        const interval = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
        if (now - this.lastActivityAt < interval) return;
        this.pingSentAt = now;
        this.pingCounter += 1;
        this.send({ type: 'ping', id: `hb-${this.pingCounter}` });
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.fatal || this.reconnectTimer !== null) return;
        this.setStatus('reconnecting');
        const delay = this.nextDelay();
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.stopped || this.fatal) return;
            this.open();
        }, delay);
    }

    /** Exponential with symmetric jitter; the attempt counter resets on `welcome`. */
    nextDelay(): number {
        const { initialMs, maxMs, factor, jitter } = this.backoff;
        const base = Math.min(maxMs, initialMs * Math.pow(factor, this.attempt));
        this.attempt += 1;
        if (jitter <= 0) return Math.round(base);
        const random = this.options.random ?? Math.random;
        const spread = base * jitter;
        return Math.max(0, Math.round(base - spread + random() * spread * 2));
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer === null) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private nowMs(): number {
        return (this.options.now ?? Date.now)();
    }

    private setStatus(status: ConnectionStatus): void {
        if (this.currentStatus === status) return;
        this.currentStatus = status;
        this.emit('status', status);
    }

    private emitError(context: string, cause: unknown): void {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.emit('error', { context, message, cause });
    }

    private emit<K extends ConnectionEventName>(event: K, payload: ConnectionEvents[K]): void {
        const set = this.listeners.get(event);
        if (set === undefined) return;
        for (const listener of [...set]) {
            try {
                (listener as ConnectionListener<K>)(payload);
            } catch {
                // A subscriber's failure must never take the socket down with it.
            }
        }
    }
}

export function createConnection(options: NexConnectionOptions = {}): NexConnection {
    return new NexConnection(options);
}
