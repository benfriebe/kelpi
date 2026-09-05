/**
 * The control transport: the newline-JSON `{"command":…}` protocol the existing `kelpi` CLI
 * and the agent hooks speak (wire-protocol.md §1–§4).
 *
 * Per connection: buffer bytes until `\n` (port note 2 — the Swift server reads 4096-byte
 * chunks without buffering and drops any line split across reads; we keep the framing and
 * fix the drop), decode each line independently, dispatch in wire order.
 *
 * Dispatch policy (§2.5, §3.1, PLAN "deliberate fixes"):
 *   - decoded + allowlisted command → real `ReplyHandle` (exactly one line, then EOF);
 *   - decoded + fire-and-forget → `dispatcher(msg, null)`, and the server never writes a
 *     byte on that connection;
 *   - rejected line whose `command` was readable AND allowlisted → `{"ok":false,"error":…}`
 *     + close (better than the Swift silent drop, and the CLI already handles it);
 *   - anything else (undecodable, unknown command, malformed fire-and-forget) → silent
 *     drop, connection left open.
 * The `session_id` dual-fire rides on `dispatchSequence`: the synthesized session-start is
 * dispatched **after** its primary message and never gets a reply handle (port note 7).
 */

import fs from 'node:fs';
import net, { type AddressInfo, type ListenOptions, type Server, type Socket } from 'node:net';
import path from 'node:path';

import { createLineBuffer, dispatchSequence, errorReply, isReplyCommand, parseWireLine, type SynthesizedSessionStart, type WireMessage } from '@kelpi/protocol';

import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { probeControlPing } from './probe.js';
import { createReplyHandle, type TransportReplyHandle } from './reply.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Mode for the unix socket file: same-UID only (port note 9 invites tightening it). */
const SOCKET_MODE = 0o600;

export interface ControlServerOptions {
    /** Unix domain socket path (production: `/tmp/kelpi.sock`, hardcoded in the CLI). */
    readonly socketPath: string;
    /** Optional TCP listener; `0` binds an ephemeral port (tests). */
    readonly tcpPort?: number | undefined;
    /** Loopback only — `127.0.0.1` by default; anything non-loopback is refused. */
    readonly tcpHost?: string | undefined;
    readonly dispatcher: ControlDispatcher;
    /** Per-line cap; keep it several MB (`web-exec --file`, big `pane-send`). */
    readonly maxLineLength?: number | undefined;
    /** Budget for the stale-socket `ping` probe before binding. */
    readonly staleProbeTimeoutMs?: number | undefined;
    /** Unix socket file mode; pass `null`-ish (undefined) to keep the default. */
    readonly socketMode?: number | undefined;
    /** Non-fatal transport problems (client EPIPE, handler throw, …). */
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

/**
 * What actually happened to the optional TCP listener (§SET-021 / §AGNT-005).
 *
 * The Swift app surfaced a failed bind as `tcpPortStartFailed` and painted "Port N is
 * unavailable" in red under Settings ▸ Network; here the same fact has to travel to a client in
 * another process, so it is a value rather than a log line. `null` on the server means "TCP was
 * never asked for", which is a different thing from "asked for and failed".
 */
export interface ControlTcpStatus {
    /** The port the config asked for. */
    readonly requested: number;
    /** The port actually listening (an ephemeral request resolves to the real one); null on failure. */
    readonly bound: number | null;
    /** The bind failure, ready to show a user; null when it bound. */
    readonly error: string | null;
    readonly host: string;
}

export interface ControlServer {
    /** Bind both listeners. Rejects if a live daemon already owns the socket path. */
    start(): Promise<void>;
    /** Close listeners, drop connections, unlink the socket if we bound it. */
    stop(): Promise<void>;
    /** Alias of `start()`. */
    listen(): Promise<void>;
    /** Alias of `stop()`. */
    close(): Promise<void>;
    /**
     * §AGNT-003: drop ONLY the TCP listener, leaving the Unix socket serving.
     *
     * The asymmetry is the point — a `tcp-port` change must never take the transport every
     * local `kelpi` command, hook and client depends on offline for the duration of a rebind.
     * Idempotent, and a no-op when TCP was never configured.
     *
     * Resolves as soon as the listening handle is down: connections already accepted on that
     * port are left to finish, exactly as the Swift's client dispatch sources are. It also
     * clears `tcpStatus` — after this call nothing was asked for, so `ping` stops reporting a
     * `tcp` block for a listener that is deliberately gone.
     */
    stopTCP(): Promise<void>;
    /**
     * §AGNT-005: bind (or re-bind) the TCP listener on `port`, live.
     *
     * `stopTCP` first, then bind, then report — the same order the Swift `tcpPortStartFailed`
     * path used. A failed bind leaves the daemon serving its Unix socket and records the error
     * on `tcpStatus`.
     *
     * `undefined` means "no TCP listener" and clears the status entirely rather than leaving a
     * stale one behind. **`0` is not that**: it is `net.listen`'s "any free port", the same
     * meaning `ControlServerOptions.tcpPort` gives it. The config file's `tcp-port = 0` means
     * *disabled*, so the caller that reads the config maps 0 → undefined — the translation
     * belongs where the config is understood, not in the transport.
     */
    startTCP(port: number | undefined): Promise<ControlTcpStatus | null>;
    readonly socketPath: string;
    /** The port the TCP listener actually bound (undefined when TCP is off OR failed). */
    readonly tcpPort: number | undefined;
    /** §SET-021: requested / bound / error, or null when no TCP listener was configured. */
    readonly tcpStatus: ControlTcpStatus | null;
    readonly connections: number;
    readonly running: boolean;
}

/** A live daemon answered `ping` on the socket path; starting would steal its socket. */
export class ControlSocketBusyError extends Error {
    readonly code = 'ECONTROLBUSY';
    readonly socketPath: string;
    readonly pid: number | undefined;

    constructor(socketPath: string, pid?: number | undefined) {
        super(
            `control socket ${socketPath} is already owned by a live daemon${pid !== undefined ? ` (pid ${pid})` : ''}`
        );
        this.name = 'ControlSocketBusyError';
        this.socketPath = socketPath;
        this.pid = pid;
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/** The synthesized dual-fire event as the `session-start` message the core already handles. */
export function dualFireMessage(event: SynthesizedSessionStart): WireMessage {
    return {
        command: 'session-start',
        pane_id: event.pane_id,
        session_id: event.session_id,
        agent: event.agent,
        ...(event.profile !== undefined ? { profile: event.profile } : {})
    };
}

export interface WireLineDispatch {
    readonly dispatcher: ControlDispatcher;
    /** Allocates a reply handle bound to the requesting connection. */
    readonly allocateReply: () => ReplyHandle;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

/**
 * The whole per-line policy, transport-free so it can be tested (and reused by a future
 * transport) without a socket.
 */
export function dispatchWireLine(line: string, deps: WireLineDispatch): void {
    const decoded = parseWireLine(line);

    if (!decoded.ok) {
        // Never answer an undecodable line (we cannot know whether the sender is reading)
        // and never answer a fire-and-forget command (§9 port note 3).
        if (decoded.command === undefined || !isReplyCommand(decoded.command)) return;
        const handle = deps.allocateReply();
        handle.send({ ...errorReply(decoded.detail) });
        handle.close();
        return;
    }

    for (const item of dispatchSequence(decoded)) {
        const message = item.kind === 'message' ? item.message : dualFireMessage(item.event);
        const reply = item.reply ? deps.allocateReply() : null;
        try {
            deps.dispatcher(message, reply);
        } catch (error) {
            deps.onError?.(toError(error), `dispatch ${message.command}`);
        }
    }
}

interface ControlConnection {
    readonly socket: Socket;
    readonly handles: Set<TransportReplyHandle>;
}

function listenAsync(server: Server, options: ListenOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.removeListener('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.removeListener('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options);
    });
}

function closeAsync(server: Server | undefined): Promise<void> {
    if (server === undefined || !server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

/**
 * Drop a LISTENER without waiting for the connections it is already serving (§AGNT-003).
 *
 * `net.Server.close()` closes the listening handle synchronously but fires its callback only
 * once every live connection has ended — so awaiting it is awaiting the CLIENTS, not the
 * listener. That is the right thing for `stop()` (which destroys the connections first) and
 * exactly the wrong thing for `stopTCP()`: one dev-container agent holding an idle TCP
 * connection would hang the teardown, and with it the `startTCP` re-bind that begins with it.
 * The Swift `stopTCP()` cancels the accept source and closes the listening fd, leaving the
 * client sources alone; this is that, in Node's vocabulary.
 *
 * `setImmediate` rather than a bare resolve: libuv finishes closing the handle in the current
 * loop's closing phase, so one turn later the port is genuinely refusing connections.
 */
function closeListenerAsync(server: Server | undefined): Promise<void> {
    if (server === undefined || !server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => {
        server.close(() => undefined);
        setImmediate(resolve);
    });
}

export function createControlServer(options: ControlServerOptions): ControlServer {
    const { socketPath, dispatcher } = options;
    const tcpHost = options.tcpHost ?? '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(tcpHost)) {
        throw new Error(`control TCP listener is loopback-only; refusing host '${tcpHost}'`);
    }

    const connections = new Set<ControlConnection>();
    let unixServer: Server | undefined;
    let tcpServer: Server | undefined;
    let boundUnixPath: string | undefined;
    let boundTcpPort: number | undefined;
    /** §SET-021: the last bind failure, kept so a client can be told why TCP is not listening. */
    let tcpBindError: string | null = null;
    let running = false;
    let starting: Promise<void> | undefined;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    const handleConnection = (socket: Socket): void => {
        socket.setNoDelay(true);
        const buffer = createLineBuffer(options.maxLineLength !== undefined ? { maxLineLength: options.maxLineLength } : {});
        const connection: ControlConnection = { socket, handles: new Set<TransportReplyHandle>() };
        connections.add(connection);

        const allocateReply = (): ReplyHandle => {
            const handle = createReplyHandle(socket, {
                onWriteError: (error) => report(error, 'reply-write')
            });
            connection.handles.add(handle);
            return handle;
        };

        socket.on('data', (chunk: Buffer) => {
            let lines: string[];
            try {
                lines = buffer.push(chunk);
            } catch (error) {
                report(error, 'line-buffer');
                return;
            }
            for (const line of lines) {
                dispatchWireLine(line, {
                    dispatcher,
                    allocateReply,
                    onError: (error, context) => report(error, context)
                });
            }
        });

        // EPIPE on a vanished client, ECONNRESET on a ^C — never fatal (§2.1, port note 13).
        socket.on('error', (error) => report(error, 'connection'));

        socket.on('close', () => {
            connections.delete(connection);
            buffer.reset();
            for (const handle of connection.handles) handle.peerGone();
            connection.handles.clear();
        });
    };

    const prepareUnixPath = async (): Promise<void> => {
        const directory = path.dirname(socketPath);
        if (directory.length > 0) fs.mkdirSync(directory, { recursive: true });

        let exists = true;
        try {
            fs.lstatSync(socketPath);
        } catch {
            exists = false;
        }
        if (!exists) return;

        const probe = await probeControlPing(
            { socketPath },
            options.staleProbeTimeoutMs !== undefined ? { timeoutMs: options.staleProbeTimeoutMs } : {}
        );
        if (probe.alive) throw new ControlSocketBusyError(socketPath, probe.pid);

        try {
            fs.unlinkSync(socketPath);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT') throw error;
        }
    };

    /**
     * The port TCP was last ASKED for — `undefined` means "no TCP listener".
     *
     * A mutable field rather than `options.tcpPort` because §AGNT-005's live re-bind changes the
     * answer while the daemon runs, and `tcpStatus` has to report the current request, not the
     * one boot happened to start with.
     */
    let requestedTcpPort: number | undefined = options.tcpPort;

    /**
     * Bind the TCP listener, or record why it could not be bound (§SET-021 / §AGNT-005).
     *
     * A port already in use is NOT fatal. It used to tear the Unix socket down and abort
     * `start()`, which meant one `tcp-port = 19400` left over from a dev container took the
     * whole daemon with it — every `kelpi` command, every hook, every client. The Swift app kept
     * serving its Unix socket and raised `tcpPortStartFailed` for the Settings pane to show, and
     * so does this: the failure is recorded on `tcpStatus`, `ping` reports it, `kelpid status`
     * prints it, and Settings ▸ Network says which port is unavailable and why.
     */
    const bindTcp = async (port: number | undefined): Promise<void> => {
        requestedTcpPort = port;
        tcpBindError = null;
        boundTcpPort = undefined;
        if (port === undefined) return;
        const tcp = net.createServer(handleConnection);
        tcp.on('error', (error) => report(error, 'tcp-listener'));
        try {
            await listenAsync(tcp, { host: tcpHost, port });
            tcpServer = tcp;
            const address = tcp.address();
            boundTcpPort =
                typeof address === 'object' && address !== null ? (address as AddressInfo).port : port;
        } catch (error) {
            tcpBindError = toError(error).message;
            report(error, 'tcp-listener');
            try {
                await closeAsync(tcp);
            } catch {
                // Never listened; nothing to close.
            }
        }
    };

    const start = async (): Promise<void> => {
        if (running) return;
        if (starting !== undefined) return starting;

        starting = (async () => {
            await prepareUnixPath();

            const unix = net.createServer(handleConnection);
            unix.on('error', (error) => report(error, 'unix-listener'));
            await listenAsync(unix, { path: socketPath });
            unixServer = unix;
            boundUnixPath = socketPath;
            try {
                fs.chmodSync(socketPath, options.socketMode ?? SOCKET_MODE);
            } catch (error) {
                report(error, 'socket-chmod');
            }

            await bindTcp(requestedTcpPort);

            running = true;
        })();

        try {
            await starting;
        } finally {
            starting = undefined;
        }
    };

    const stop = async (): Promise<void> => {
        running = false;
        for (const connection of [...connections]) connection.socket.destroy();
        connections.clear();
        await closeAsync(unixServer);
        await closeAsync(tcpServer);
        unixServer = undefined;
        tcpServer = undefined;
        boundTcpPort = undefined;
        tcpBindError = null;
        requestedTcpPort = options.tcpPort;
        // Only unlink a socket file this instance actually bound (§1.1).
        if (boundUnixPath !== undefined) {
            try {
                fs.unlinkSync(boundUnixPath);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') report(error, 'socket-unlink');
            }
            boundUnixPath = undefined;
        }
    };

    return {
        start,
        stop,
        listen: start,
        close: stop,
        socketPath,
        get tcpPort() {
            return boundTcpPort;
        },
        async stopTCP() {
            // §AGNT-003: ONLY the TCP listener. The unix socket, the connections it is serving
            // and the socket file are all untouched — that asymmetry is the whole point.
            //
            // Three details that are the difference between "closes" and "tears down
            // independently":
            //   - `closeListenerAsync`, so a live TCP client cannot hold the teardown (and
            //     therefore a `startTCP` re-bind) hostage;
            //   - the connections already accepted on that port keep being served, as the
            //     Swift's client sources do — this drops the door, not the people through it;
            //   - the REQUEST is cleared too, so `tcpStatus` (and `ping`'s `controlTransport`)
            //     stop advertising a port nothing is listening on. `startTCP(undefined)` means
            //     the same thing and already reports it the same way; a listener that was
            //     deliberately stopped is "no TCP listener", not "asked for and silently
            //     failed".
            const current = tcpServer;
            tcpServer = undefined;
            boundTcpPort = undefined;
            tcpBindError = null;
            requestedTcpPort = undefined;
            await closeListenerAsync(current);
        },
        async startTCP(port) {
            await this.stopTCP();
            await bindTcp(port);
            return this.tcpStatus;
        },
        get tcpStatus(): ControlTcpStatus | null {
            if (requestedTcpPort === undefined) return null;
            return {
                requested: requestedTcpPort,
                bound: boundTcpPort ?? null,
                error: tcpBindError,
                host: tcpHost
            };
        },
        get connections() {
            return connections.size;
        },
        get running() {
            return running;
        }
    };
}
