/**
 * The daemon's side of the terminal host (`docs/terminal-host.md` §5).
 *
 * `connectTerminalHost` authenticates and returns a client whose `spawner` plugs into the PTY
 * manager in place of `nodePtySpawner`: every handle it returns is a `PtyProcessHandle` whose
 * calls become frames and whose output arrives from the host. `attach` adopts a terminal a
 * previous daemon left running. `hold` / `checkpoint` / `detach` are the handoff (§6).
 *
 * Output or an exit that arrives before the consumer registers its listener is queued and
 * delivered on registration: an adopted terminal's backlog follows its `attached` reply
 * immediately, and the daemon restores the saved screen before it subscribes.
 *
 * A connection that closes unexpectedly is reported through `onLost` with the ids of every live
 * handle, and those handles do NOT emit exits: a host crash must not close panes (§8.2).
 */

import { randomUUID } from 'node:crypto';
import net from 'node:net';

import type { PtyProcessHandle, PtySpawner, PtySpawnRequest } from '../pty/types.js';
import {
    FrameDecoder,
    FrameType,
    HOST_PROTOCOL_VERSION,
    encodeBlob,
    encodeJson,
    encodeWrite,
    parseAttached,
    parseExit,
    parseWelcome,
    type AttachedMessage,
    type Frame,
    type HelloMode,
    type WelcomeMessage
} from './protocol.js';

export const DEFAULT_CONNECT_TIMEOUT_MS = 3000;
/** How long `hold` and `attach` wait for their reply. */
export const DEFAULT_REPLY_TIMEOUT_MS = 5000;

export interface ConnectTerminalHostOptions {
    readonly socketPath: string;
    readonly token: string;
    readonly mode?: HelloMode;
    readonly timeoutMs?: number;
    /** A spawn fell back to its fallback shell, or failed outright. */
    readonly onSpawnProblem?: (key: string, message: string) => void;
}

export type LostReason = 'crash' | 'superseded';

type DataListener = (data: Uint8Array) => void;
type ExitListener = (exitCode: number, signal: number | undefined) => void;

/** One terminal on the host, as the PTY manager sees it. */
export class HostPtyHandle implements PtyProcessHandle {
    private pidValue: number;
    private dataListener: DataListener | undefined;
    private exitListener: ExitListener | undefined;
    private queuedData: Uint8Array[] = [];
    private queuedExit: { code: number; signal: number | undefined } | undefined;
    private exitedFlag = false;
    /** Offset just past the last byte delivered: what a checkpoint of this terminal names. */
    received: number;

    constructor(
        private readonly client: TerminalHostClient,
        readonly tid: string,
        readonly key: string,
        pid: number,
        from: number
    ) {
        this.pidValue = pid;
        this.received = from;
    }

    get pid(): number {
        return this.pidValue;
    }

    get exited(): boolean {
        return this.exitedFlag;
    }

    write(data: string | Uint8Array): void {
        this.client.sendWrite(this.tid, typeof data === 'string' ? new TextEncoder().encode(data) : data);
    }

    resize(cols: number, rows: number): void {
        this.client.sendJson(FrameType.resize, { tid: this.tid, cols, rows });
    }

    pause(): void {
        this.client.sendJson(FrameType.pause, { tid: this.tid });
    }

    resume(): void {
        this.client.sendJson(FrameType.resume, { tid: this.tid });
    }

    kill(signal?: string): void {
        this.client.sendJson(FrameType.kill, { tid: this.tid, ...(signal !== undefined ? { signal } : {}) });
    }

    onData(listener: DataListener): void {
        this.dataListener = listener;
        const queued = this.queuedData;
        this.queuedData = [];
        for (const chunk of queued) listener(chunk);
    }

    onExit(listener: ExitListener): void {
        this.exitListener = listener;
        const queued = this.queuedExit;
        this.queuedExit = undefined;
        if (queued !== undefined) listener(queued.code, queued.signal);
    }

    /** @internal */
    spawned(pid: number): void {
        this.pidValue = pid;
    }

    /** @internal Deliver bytes at `offset`, skipping any already delivered. */
    deliver(offset: number, bytes: Uint8Array): void {
        const end = offset + bytes.length;
        if (end <= this.received) return;
        const fresh = offset < this.received ? bytes.subarray(this.received - offset) : bytes;
        this.received = end;
        if (this.dataListener !== undefined) this.dataListener(fresh);
        else this.queuedData.push(fresh);
    }

    /** @internal */
    exit(code: number, signal: number | undefined): void {
        if (this.exitedFlag) return;
        this.exitedFlag = true;
        if (this.exitListener !== undefined) this.exitListener(code, signal);
        else this.queuedExit = { code, signal };
    }
}

export interface AttachResult {
    readonly handle: HostPtyHandle;
    readonly attached: AttachedMessage;
    /** The checkpoint blob, empty when there is none. */
    readonly blob: Uint8Array;
}

interface Waiter<T> {
    resolve(value: T): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
}

export class TerminalHostClient {
    private readonly handles = new Map<string, HostPtyHandle>();
    private readonly attachWaiters = new Map<string, Waiter<AttachResult>>();
    private holdWaiter: Waiter<void> | undefined;
    private lostListeners: ((tids: string[], reason: LostReason) => void)[] = [];
    private closedOnPurpose = false;
    private superseded = false;
    private closed = false;

    /** @internal Use `connectTerminalHost`. */
    constructor(
        private readonly socket: net.Socket,
        private readonly decoder: FrameDecoder,
        readonly welcome: WelcomeMessage,
        private readonly options: ConnectTerminalHostOptions
    ) {
        socket.on('data', (chunk: Buffer) => this.receive(chunk));
        socket.on('error', () => {
            // 'close' follows.
        });
        socket.on('close', () => this.onClose());
    }

    /**
     * A `PtySpawner` whose terminals live on the host. Each terminal is keyed by the request's
     * pane id (a fresh id when there is none), and `fallbackFile` is tried when the requested
     * shell fails to start, unless it is the same file.
     */
    createSpawner(fallbackFile?: string): PtySpawner {
        return (request: PtySpawnRequest) =>
            this.spawn(
                request,
                request.key ?? randomUUID(),
                fallbackFile !== undefined && fallbackFile !== request.file ? fallbackFile : undefined
            );
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Spawn a terminal for `key` (the pane id). Failures surface as an exit of -1. */
    spawn(request: PtySpawnRequest, key: string, fallbackFile?: string): HostPtyHandle {
        const tid = randomUUID();
        const handle = new HostPtyHandle(this, tid, key, 0, 0);
        this.handles.set(tid, handle);
        this.sendJson(FrameType.spawn, {
            tid,
            key,
            file: request.file,
            args: request.args,
            cwd: request.cwd,
            env: request.env,
            cols: request.cols,
            rows: request.rows,
            name: request.name,
            ...(fallbackFile !== undefined ? { fallbackFile } : {})
        });
        if (this.closed) handle.exit(-1, undefined);
        return handle;
    }

    /** Adopt a terminal a previous daemon left on the host (§7). */
    attach(tid: string, key: string): Promise<AttachResult> {
        return new Promise<AttachResult>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('the terminal host connection is closed'));
                return;
            }
            const timer = setTimeout(() => {
                this.attachWaiters.delete(tid);
                reject(new Error(`the terminal host did not answer attach for ${key}`));
            }, DEFAULT_REPLY_TIMEOUT_MS);
            this.attachWaiters.set(tid, {
                resolve,
                reject,
                timer
            });
            // Registered before the reply so the backlog that follows it has somewhere to go.
            this.handles.set(tid, new HostPtyHandle(this, tid, key, this.pidOf(tid), 0));
            this.sendJson(FrameType.attach, { tid });
        });
    }

    /** Stop the host streaming; resolves once every in-flight byte has been delivered (§6). */
    hold(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.closed) {
                reject(new Error('the terminal host connection is closed'));
                return;
            }
            const timer = setTimeout(() => {
                this.holdWaiter = undefined;
                reject(new Error('the terminal host did not answer hold'));
            }, DEFAULT_REPLY_TIMEOUT_MS);
            this.holdWaiter = { resolve, reject, timer };
            this.sendJson(FrameType.hold, {});
        });
    }

    checkpoint(tid: string, offset: number, blob: Uint8Array): void {
        this.send(encodeBlob(FrameType.checkpoint, { tid, offset }, blob));
    }

    /**
     * The daemon has no pane for this terminal: the host hangs it up if it still runs and drops
     * it. Also how an exit recorded while no daemon was attached is acknowledged.
     */
    forget(tid: string): void {
        this.sendJson(FrameType.forget, { tid });
    }

    /** Hand every terminal to the next daemon and disconnect. */
    async detach(): Promise<void> {
        this.closedOnPurpose = true;
        this.sendJson(FrameType.detach, { reason: 'handoff' });
        await this.end();
    }

    /** Kill every terminal on the host and let it exit. */
    async shutdown(): Promise<void> {
        this.closedOnPurpose = true;
        this.sendJson(FrameType.shutdown, {});
        await this.end();
    }

    /** Disconnect without a handoff (tests, and a daemon abandoning a host). */
    close(): void {
        this.closedOnPurpose = true;
        this.socket.destroy();
    }

    /**
     * The connection closed without `detach`, `shutdown` or `close`: the host died (`'crash'`),
     * or another daemon attached in our place (`'superseded'`). `tids` are the live handles,
     * which emit no exits.
     */
    onLost(listener: (tids: string[], reason: LostReason) => void): void {
        this.lostListeners.push(listener);
    }

    handle(tid: string): HostPtyHandle | undefined {
        return this.handles.get(tid);
    }

    /** @internal */
    sendJson(type: (typeof FrameType)[keyof typeof FrameType], body: unknown): void {
        this.send(encodeJson(type, body));
    }

    /** @internal */
    sendWrite(tid: string, bytes: Uint8Array): void {
        this.send(encodeWrite(tid, bytes));
    }

    private send(bytes: Uint8Array): void {
        if (this.closed || this.socket.destroyed) return;
        this.socket.write(bytes);
    }

    private end(): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.closed) {
                resolve();
                return;
            }
            this.socket.once('close', () => resolve());
            this.socket.end();
            setTimeout(() => {
                this.socket.destroy();
            }, 1000).unref();
        });
    }

    private pidOf(tid: string): number {
        return this.welcome.terminals.find((terminal) => terminal.tid === tid)?.pid ?? 0;
    }

    private receive(chunk: Buffer): void {
        let frames: Frame[];
        try {
            frames = this.decoder.push(chunk);
        } catch {
            this.socket.destroy();
            return;
        }
        for (const frame of frames) this.ingest(frame);
    }

    /** @internal Handle one decoded frame (also the frames that arrived with the welcome). */
    ingest(frame: Frame): void {
        if (frame.kind === 'data') {
            this.handles.get(frame.tid)?.deliver(frame.offset, frame.bytes);
            return;
        }
        if (frame.kind === 'blob') {
            if (frame.type !== FrameType.attached) return;
            const attached = parseAttached(frame.body);
            const waiter = attached === null ? undefined : this.attachWaiters.get(attached.tid);
            const handle = attached === null ? undefined : this.handles.get(attached.tid);
            if (attached === null || waiter === undefined || handle === undefined) return;
            this.attachWaiters.delete(attached.tid);
            clearTimeout(waiter.timer);
            handle.received = attached.from;
            waiter.resolve({ handle, attached, blob: frame.blob });
            return;
        }
        if (frame.kind !== 'json') return;
        const body = frame.body as Record<string, unknown>;
        switch (frame.type) {
            case FrameType.spawned: {
                const handle = typeof body['tid'] === 'string' ? this.handles.get(body['tid']) : undefined;
                if (handle !== undefined && typeof body['pid'] === 'number') handle.spawned(body['pid']);
                if (handle !== undefined && typeof body['warning'] === 'string') {
                    this.options.onSpawnProblem?.(handle.key, body['warning']);
                }
                return;
            }
            case FrameType.spawnFailed: {
                const handle = typeof body['tid'] === 'string' ? this.handles.get(body['tid']) : undefined;
                if (handle === undefined) return;
                this.options.onSpawnProblem?.(handle.key, String(body['message'] ?? 'spawn failed'));
                this.handles.delete(handle.tid);
                handle.exit(-1, undefined);
                return;
            }
            case FrameType.exit: {
                const exit = parseExit(body);
                const handle = exit === null ? undefined : this.handles.get(exit.tid);
                if (exit === null || handle === undefined) return;
                this.handles.delete(exit.tid);
                const waiter = this.attachWaiters.get(exit.tid);
                if (waiter !== undefined) {
                    // attach for a terminal the host no longer has
                    this.attachWaiters.delete(exit.tid);
                    clearTimeout(waiter.timer);
                    waiter.reject(new Error('the terminal is gone'));
                }
                handle.exit(exit.code, exit.signal ?? undefined);
                return;
            }
            case FrameType.held: {
                const waiter = this.holdWaiter;
                this.holdWaiter = undefined;
                if (waiter !== undefined) {
                    clearTimeout(waiter.timer);
                    waiter.resolve();
                }
                return;
            }
            case FrameType.superseded:
                this.superseded = true;
                return;
            default:
                return;
        }
    }

    private onClose(): void {
        if (this.closed) return;
        this.closed = true;
        const error = new Error('the terminal host connection closed');
        for (const waiter of this.attachWaiters.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.attachWaiters.clear();
        if (this.holdWaiter !== undefined) {
            clearTimeout(this.holdWaiter.timer);
            this.holdWaiter.reject(error);
            this.holdWaiter = undefined;
        }
        if (this.closedOnPurpose) return;
        const live = [...this.handles.values()].filter((handle) => !handle.exited).map((handle) => handle.tid);
        const reason: LostReason = this.superseded ? 'superseded' : 'crash';
        for (const listener of this.lostListeners) listener(live, reason);
    }
}

/**
 * Connect and authenticate. Rejects when nothing answers, the host refuses, or it does not
 * welcome us within the timeout. `mode: 'probe'` only reads the welcome and disconnects.
 */
export function connectTerminalHost(options: ConnectTerminalHostOptions): Promise<TerminalHostClient> {
    return new Promise<TerminalHostClient>((resolve, reject) => {
        const socket = net.createConnection(options.socketPath);
        const decoder = new FrameDecoder();
        let settled = false;
        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };
        const timer = setTimeout(
            () => fail(new Error('the terminal host did not answer in time')),
            options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
        );
        socket.once('error', (error) => fail(error));
        socket.once('close', () => fail(new Error('the terminal host closed the connection')));
        socket.once('connect', () => {
            socket.write(
                encodeJson(FrameType.hello, {
                    protocol: HOST_PROTOCOL_VERSION,
                    token: options.token,
                    mode: options.mode ?? 'attach'
                })
            );
        });
        const onData = (chunk: Buffer): void => {
            let frames: Frame[];
            try {
                frames = decoder.push(chunk);
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            const first = frames[0];
            if (first === undefined) return;
            if (first.type === FrameType.refused && first.kind === 'json') {
                const reason = (first.body as { reason?: unknown }).reason;
                fail(new Error(`the terminal host refused the connection: ${String(reason)}`));
                return;
            }
            const welcome = first.type === FrameType.welcome && first.kind === 'json' ? parseWelcome(first.body) : null;
            if (welcome === null) {
                fail(new Error('the terminal host sent no welcome'));
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.off('data', onData);
            socket.removeAllListeners('error');
            socket.removeAllListeners('close');
            const client = new TerminalHostClient(socket, decoder, welcome, options);
            // Frames that arrived with the welcome belong to the client now.
            for (const frame of frames.slice(1)) client.ingest(frame);
            resolve(client);
        };
        socket.on('data', onData);
    });
}
