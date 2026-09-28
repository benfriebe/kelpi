/**
 * The terminal host: owns the PTYs so they outlive the daemon (`docs/terminal-host.md`).
 *
 * One process per run dir. It listens on a token-authenticated unix socket, and exactly one
 * daemon at a time is attached. Terminals it spawns stream to that daemon; everything else about
 * a terminal (the emulator, the stream hub, persistence) stays in the daemon. What the host adds
 * is continuity:
 *
 * - it keeps every terminal alive when the daemon goes away, cleanly (`detach` after a handoff)
 *   or not (the socket just closes);
 * - it retains recent output per terminal, addressed by offset (`RetentionRing`), so the next
 *   daemon can be sent exactly what it missed;
 * - after a `hold` or a `checkpoint` it never drops output the checkpoint does not cover: it
 *   pauses the PTY instead (§4).
 *
 * The PTYs themselves come from the same `PtySpawner` seam the daemon's manager uses, so the
 * host runs node-pty exactly as the daemon did.
 */

import { timingSafeEqual } from 'node:crypto';
import { statSync, unlinkSync } from 'node:fs';
import net from 'node:net';

import type { PtyProcessHandle, PtySpawner } from '../pty/types.js';
import {
    FrameDecoder,
    FrameType,
    HOST_PROTOCOL_VERSION,
    encodeBlob,
    encodeData,
    encodeJson,
    parseHello,
    parseKill,
    parseSpawn,
    parseTidFields,
    type Frame,
    type TerminalInfo,
    type WelcomeMessage
} from './protocol.js';
import { DEFAULT_RETENTION_BYTES, RetentionRing } from './retention.js';

/** How long an unauthenticated connection may stay open. */
export const DEFAULT_AUTH_TIMEOUT_MS = 2000;
/** With no terminals and no daemon for this long, the host exits. */
export const DEFAULT_IDLE_EXIT_MS = 5000;
/** A freshly launched host with nobody attached after this long exits. */
export const DEFAULT_FIRST_ATTACH_TIMEOUT_MS = 30_000;
/** SIGHUP → SIGKILL grace when the host shuts down. */
export const SHUTDOWN_KILL_GRACE_MS = 500;
/** Replayed output is sent in pieces no larger than this. */
const REPLAY_CHUNK_BYTES = 1024 * 1024;
/** With only exits no daemon has heard about yet, the host waits this long before exiting. */
export const UNREPORTED_EXIT_GRACE_MS = 10 * 60_000;
/** A daemon mid-handoff gets this long before a waiting successor supersedes it anyway. */
export const HANDOFF_WAIT_MS = 15_000;
/** How often the host checks that its socket file still exists. */
const SOCKET_CHECK_MS = 2000;
/**
 * How long a checkpoint may keep a PTY paused when no successor attaches. After that the pin is
 * dropped: the output keeps flowing (a dev server must not block forever on stdout), and a daemon
 * that attaches later gets the tail with a gap instead of an exact resume.
 */
export const PIN_TIMEOUT_MS = 60_000;

export interface TerminalHostServerOptions {
    readonly socketPath: string;
    readonly token: string;
    readonly spawner: PtySpawner;
    readonly hostVersion: string;
    readonly retentionBytes?: number;
    readonly authTimeoutMs?: number;
    readonly idleExitMs?: number;
    readonly firstAttachTimeoutMs?: number;
    readonly pinTimeoutMs?: number;
    /** Called once when the host should exit: idle, `shutdown`, or `close`. */
    readonly onExit?: (reason: string) => void;
    readonly log?: (line: string) => void;
}

interface HostTerminal {
    readonly tid: string;
    readonly key: string;
    readonly proc: PtyProcessHandle;
    cols: number;
    rows: number;
    readonly ring: RetentionRing;
    /** Output goes to the attached daemon as it arrives. */
    streaming: boolean;
    daemonPaused: boolean;
    retentionPaused: boolean;
    ptyPaused: boolean;
    checkpoint: { readonly offset: number; readonly blob: Uint8Array } | null;
    exited: { readonly code: number; readonly signal: number | null } | null;
}

interface Connection {
    readonly socket: net.Socket;
    readonly decoder: FrameDecoder;
    authed: boolean;
    /** Ended on purpose (`detach`, supersede, shutdown): not a crash. */
    retired: boolean;
    /** Between `hold` and `detach`: a successor waits rather than superseding it. */
    holding: boolean;
}

export class TerminalHostServer {
    private readonly server: net.Server;
    private readonly terminals = new Map<string, HostTerminal>();
    private readonly retentionBytes: number;
    private attached: Connection | null = null;
    /** A daemon that said hello while the attached one was handing off (§6). */
    private waiting: { connection: Connection; timer: NodeJS.Timeout } | null = null;
    private socketBackpressure = false;
    private socketCheck: NodeJS.Timeout | undefined;
    private pinTimer: NodeJS.Timeout | undefined;
    private idleTimer: NodeJS.Timeout | undefined;
    private firstAttachTimer: NodeJS.Timeout | undefined;
    private everAttached = false;
    private exiting = false;

    constructor(private readonly options: TerminalHostServerOptions) {
        this.retentionBytes = options.retentionBytes ?? DEFAULT_RETENTION_BYTES;
        this.server = net.createServer((socket) => this.accept(socket));
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.options.socketPath, () => {
                this.server.off('error', reject);
                resolve();
            });
        });
        this.firstAttachTimer = setTimeout(() => {
            if (!this.everAttached && this.liveCount() === 0) this.exit('nobody attached');
        }, this.options.firstAttachTimeoutMs ?? DEFAULT_FIRST_ATTACH_TIMEOUT_MS);
        this.firstAttachTimer.unref();
        // A run dir that is deleted (a test sandbox, a wiped state directory) takes its daemon's
        // socket with it; nothing could ever attach again, so the host must not linger.
        this.socketCheck = setInterval(() => {
            if (!socketFileExists(this.options.socketPath)) void this.shutdown('its socket file was removed');
        }, SOCKET_CHECK_MS);
        this.socketCheck.unref();
    }

    /** Live (not yet exited) terminals. */
    liveCount(): number {
        let count = 0;
        for (const terminal of this.terminals.values()) if (terminal.exited === null) count += 1;
        return count;
    }

    /** Hang up every terminal, stop listening, and report the exit. */
    async shutdown(reason = 'shutdown'): Promise<void> {
        if (this.exiting) return;
        const live = [...this.terminals.values()].filter((terminal) => terminal.exited === null);
        for (const terminal of live) terminal.proc.kill('SIGHUP');
        await new Promise<void>((resolve) => {
            const deadline = setTimeout(resolve, SHUTDOWN_KILL_GRACE_MS);
            deadline.unref();
            const check = setInterval(() => {
                if (live.every((terminal) => terminal.exited !== null)) {
                    clearInterval(check);
                    clearTimeout(deadline);
                    resolve();
                }
            }, 20);
            check.unref();
        });
        for (const terminal of live) if (terminal.exited === null) terminal.proc.kill('SIGKILL');
        this.exit(reason);
    }

    private exit(reason: string): void {
        if (this.exiting) return;
        this.exiting = true;
        clearTimeout(this.idleTimer);
        clearTimeout(this.firstAttachTimer);
        clearInterval(this.socketCheck);
        clearTimeout(this.pinTimer);
        if (this.waiting !== null) {
            clearTimeout(this.waiting.timer);
            this.waiting.connection.socket.destroy();
            this.waiting = null;
        }
        this.attached?.socket.destroy();
        this.server.close();
        try {
            unlinkSync(this.options.socketPath);
        } catch {
            // already gone
        }
        this.options.log?.(`exiting: ${reason}`);
        this.options.onExit?.(reason);
    }

    // ── connections ─────────────────────────────────────────────────────────────────

    private accept(socket: net.Socket): void {
        const connection: Connection = {
            socket,
            decoder: new FrameDecoder(),
            authed: false,
            retired: false,
            holding: false
        };
        const authTimer = setTimeout(() => {
            if (!connection.authed) socket.destroy();
        }, this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
        authTimer.unref();

        socket.on('data', (chunk: Buffer) => {
            let frames: Frame[];
            try {
                frames = connection.decoder.push(chunk);
            } catch (error) {
                this.options.log?.(`dropping a connection: ${String(error)}`);
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                if (socket.destroyed) return;
                // One frame that throws (a resize racing a PTY's close, say) must not drop the
                // frames decoded with it: keystrokes for other panes, a checkpoint, a detach.
                try {
                    if (!connection.authed) {
                        clearTimeout(authTimer);
                        this.handshake(connection, frame);
                    } else if (connection === this.attached) {
                        this.handle(frame);
                    }
                } catch (error) {
                    this.options.log?.(`a frame failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
        socket.on('drain', () => {
            if (connection === this.attached && this.socketBackpressure) {
                this.socketBackpressure = false;
                for (const terminal of this.terminals.values()) this.syncPause(terminal);
            }
        });
        socket.on('error', () => {
            // 'close' follows; a peer that vanished is handled there.
        });
        socket.on('close', () => {
            clearTimeout(authTimer);
            if (connection === this.attached) this.release(connection);
            if (this.waiting?.connection === connection) {
                clearTimeout(this.waiting.timer);
                this.waiting = null;
            }
        });
    }

    private handshake(connection: Connection, frame: Frame): void {
        const hello = frame.type === FrameType.hello && frame.kind === 'json' ? parseHello(frame.body) : null;
        const refuse = (reason: string): void => {
            connection.socket.end(encodeJson(FrameType.refused, { reason }));
        };
        if (hello === null) return refuse('expected hello');
        if (!tokenMatches(hello.token, this.options.token)) return refuse('bad token');
        if (hello.protocol !== HOST_PROTOCOL_VERSION) {
            return refuse(`protocol ${hello.protocol} is not ${HOST_PROTOCOL_VERSION}`);
        }
        connection.authed = true;
        if (hello.mode === 'probe') {
            connection.socket.end(encodeJson(FrameType.welcome, this.welcome()));
            return;
        }
        const previous = this.attached;
        if (previous !== null && previous.holding) {
            // The attached daemon is mid-handoff: let it finish checkpointing, then welcome this
            // one (`release` promotes it). A successor that arrives early must not cut the
            // handoff short, whoever launched it.
            if (this.waiting !== null) {
                clearTimeout(this.waiting.timer);
                this.waiting.connection.socket.destroy();
            }
            const timer = setTimeout(() => this.supersede(connection), HANDOFF_WAIT_MS);
            timer.unref();
            this.waiting = { connection, timer };
            return;
        }
        this.supersede(connection);
    }

    /** No successor came in time: let pinned output flow again (`PIN_TIMEOUT_MS`). */
    private dropPins(): void {
        if (this.attached !== null) return;
        for (const terminal of this.terminals.values()) {
            if (terminal.ring.pin === null) continue;
            terminal.ring.setPin(null);
            terminal.retentionPaused = false;
            this.syncPause(terminal);
        }
    }

    /** Make `connection` the attached daemon, retiring any current one. */
    private supersede(connection: Connection): void {
        if (this.waiting?.connection === connection) {
            clearTimeout(this.waiting.timer);
            this.waiting = null;
        }
        if (connection.socket.destroyed) return;
        const previous = this.attached;
        if (previous !== null) {
            previous.retired = true;
            previous.socket.end(encodeJson(FrameType.superseded, {}));
            this.release(previous);
        }
        this.attached = connection;
        this.everAttached = true;
        clearTimeout(this.idleTimer);
        clearTimeout(this.pinTimer);
        connection.socket.write(encodeJson(FrameType.welcome, this.welcome()));
    }

    /** The attached daemon went away, on purpose or not. Terminals stay; none stream. */
    private release(connection: Connection): void {
        if (this.attached !== connection) return;
        this.attached = null;
        this.socketBackpressure = false;
        for (const terminal of this.terminals.values()) {
            terminal.streaming = false;
            terminal.daemonPaused = false;
            // A `hold` pin with no checkpoint behind it (the daemon died mid-handoff, or could
            // not checkpoint this terminal) buys nothing: the next attach replays the tail with
            // a gap anyway. Drop it, so the PTY is never paused for it.
            if (terminal.checkpoint === null) terminal.ring.setPin(null);
            this.syncPause(terminal);
        }
        clearTimeout(this.pinTimer);
        this.pinTimer = setTimeout(() => this.dropPins(), this.options.pinTimeoutMs ?? PIN_TIMEOUT_MS);
        this.pinTimer.unref();
        if (!connection.retired) this.options.log?.('the daemon disconnected without a handoff');
        const waiting = this.waiting;
        if (waiting !== null) {
            this.supersede(waiting.connection);
            return;
        }
        this.scheduleIdleCheck();
    }

    private welcome(): WelcomeMessage {
        const terminals: TerminalInfo[] = [...this.terminals.values()].map((terminal) => ({
            tid: terminal.tid,
            key: terminal.key,
            pid: terminal.proc.pid,
            cols: terminal.cols,
            rows: terminal.rows,
            produced: terminal.ring.produced,
            checkpointOffset: terminal.checkpoint?.offset ?? null,
            exited: terminal.exited
        }));
        return { protocol: HOST_PROTOCOL_VERSION, hostVersion: this.options.hostVersion, pid: process.pid, terminals };
    }

    private send(bytes: Uint8Array): void {
        const connection = this.attached;
        if (connection === null || connection.socket.destroyed) return;
        if (!connection.socket.write(bytes) && !this.socketBackpressure) {
            this.socketBackpressure = true;
            for (const terminal of this.terminals.values()) this.syncPause(terminal);
        }
    }

    // ── daemon requests ─────────────────────────────────────────────────────────────

    private handle(frame: Frame): void {
        if (frame.kind === 'write') {
            const terminal = this.terminals.get(frame.tid);
            if (terminal !== undefined && terminal.exited === null) terminal.proc.write(frame.bytes);
            return;
        }
        if (frame.kind === 'blob') {
            if (frame.type === FrameType.checkpoint) this.checkpoint(frame.body, frame.blob);
            return;
        }
        if (frame.kind !== 'json') return;
        switch (frame.type) {
            case FrameType.spawn:
                return this.spawn(frame.body);
            case FrameType.resize: {
                const body = parseTidFields(frame.body, ['cols', 'rows']);
                const terminal = body === null ? undefined : this.terminals.get(body.tid);
                if (body === null || terminal === undefined || terminal.exited !== null) return;
                if (body.cols === 0 || body.rows === 0) return;
                terminal.cols = body.cols;
                terminal.rows = body.rows;
                terminal.proc.resize(body.cols, body.rows);
                return;
            }
            case FrameType.pause:
            case FrameType.resume: {
                const terminal = this.lookup(frame.body);
                if (terminal === undefined) return;
                terminal.daemonPaused = frame.type === FrameType.pause;
                this.syncPause(terminal);
                return;
            }
            case FrameType.kill: {
                const body = parseKill(frame.body);
                const terminal = body === null ? undefined : this.terminals.get(body.tid);
                if (body !== null && terminal !== undefined && terminal.exited === null) terminal.proc.kill(body.signal);
                return;
            }
            case FrameType.attach:
                return this.attach(frame.body);
            case FrameType.hold:
                return this.hold();
            case FrameType.forget: {
                // The daemon has no pane for this terminal: end it if it still runs, drop it now.
                const terminal = this.lookup(frame.body);
                if (terminal === undefined) return;
                this.terminals.delete(terminal.tid);
                if (terminal.exited === null) hangUp(terminal);
                this.scheduleIdleCheck();
                return;
            }
            case FrameType.detach: {
                const connection = this.attached;
                if (connection === null) return;
                connection.retired = true;
                connection.socket.end();
                this.release(connection);
                return;
            }
            case FrameType.shutdown:
                void this.shutdown('the daemon asked');
                return;
            default:
                return;
        }
    }

    private lookup(body: unknown): HostTerminal | undefined {
        const parsed = parseTidFields(body, []);
        return parsed === null ? undefined : this.terminals.get(parsed.tid);
    }

    private spawn(body: unknown): void {
        const request = parseSpawn(body);
        if (request === null) {
            const tid = typeof (body as { tid?: unknown })?.tid === 'string' ? (body as { tid: string }).tid : '';
            if (tid !== '') this.send(encodeJson(FrameType.spawnFailed, { tid, message: 'malformed spawn request' }));
            return;
        }
        if (this.terminals.has(request.tid)) {
            this.send(encodeJson(FrameType.spawnFailed, { tid: request.tid, message: 'terminal id already in use' }));
            return;
        }
        const attempt = (file: string): PtyProcessHandle =>
            this.options.spawner({
                file,
                args: request.args,
                cwd: request.cwd,
                env: request.env,
                cols: request.cols,
                rows: request.rows,
                name: request.name
            });
        let proc: PtyProcessHandle;
        let warning: string | undefined;
        try {
            proc = attempt(request.file);
        } catch (error) {
            if (request.fallbackFile === undefined || request.fallbackFile === request.file) {
                this.send(encodeJson(FrameType.spawnFailed, { tid: request.tid, message: messageOf(error) }));
                return;
            }
            warning = messageOf(error);
            try {
                proc = attempt(request.fallbackFile);
            } catch (fallbackError) {
                this.send(encodeJson(FrameType.spawnFailed, { tid: request.tid, message: messageOf(fallbackError) }));
                return;
            }
        }
        const terminal: HostTerminal = {
            tid: request.tid,
            key: request.key,
            proc,
            cols: request.cols,
            rows: request.rows,
            ring: new RetentionRing(this.retentionBytes),
            streaming: true,
            daemonPaused: false,
            retentionPaused: false,
            ptyPaused: false,
            checkpoint: null,
            exited: null
        };
        this.terminals.set(terminal.tid, terminal);
        clearTimeout(this.idleTimer);
        proc.onData((data) => this.output(terminal, data));
        proc.onExit((code, signal) => this.exited(terminal, code, signal ?? null));
        this.send(encodeJson(FrameType.spawned, { tid: terminal.tid, pid: proc.pid, ...(warning ? { warning } : {}) }));
    }

    /** Start streaming a terminal a previous daemon left behind, from its checkpoint (§7). */
    private attach(body: unknown): void {
        const terminal = this.lookup(body);
        if (terminal === undefined) {
            const tid = parseTidFields(body, [])?.tid;
            if (tid !== undefined) this.send(encodeJson(FrameType.exit, { tid, code: -1, signal: null }));
            return;
        }
        const checkpoint = terminal.checkpoint;
        const read = terminal.ring.readFrom(checkpoint?.offset ?? terminal.ring.start);
        this.send(
            encodeBlob(
                FrameType.attached,
                {
                    tid: terminal.tid,
                    checkpointOffset: checkpoint?.offset ?? null,
                    from: read.from,
                    gap: checkpoint === null || read.gap,
                    until: read.from + read.bytes.length,
                    cols: terminal.cols,
                    rows: terminal.rows
                },
                checkpoint?.blob ?? new Uint8Array(0)
            )
        );
        for (let at = 0; at < read.bytes.length; at += REPLAY_CHUNK_BYTES) {
            const piece = read.bytes.subarray(at, at + REPLAY_CHUNK_BYTES);
            this.send(encodeData(terminal.tid, read.from + at, piece));
        }
        terminal.checkpoint = null;
        terminal.ring.setPin(null);
        terminal.streaming = true;
        terminal.retentionPaused = false;
        this.syncPause(terminal);
        if (terminal.exited !== null) {
            this.send(encodeJson(FrameType.exit, { tid: terminal.tid, ...terminal.exited }));
            this.terminals.delete(terminal.tid);
        }
    }

    /** Stop streaming; keep every byte from here on until a checkpoint says otherwise (§6). */
    private hold(): void {
        if (this.attached !== null) this.attached.holding = true;
        for (const terminal of this.terminals.values()) {
            terminal.streaming = false;
            terminal.ring.setPin(terminal.ring.produced, false);
        }
        this.send(encodeJson(FrameType.held, {}));
    }

    private checkpoint(body: unknown, blob: Uint8Array): void {
        const parsed = parseTidFields(body, ['offset']);
        const terminal = parsed === null ? undefined : this.terminals.get(parsed.tid);
        if (parsed === null || terminal === undefined) return;
        terminal.checkpoint = { offset: parsed.offset, blob };
        terminal.ring.setPin(parsed.offset);
        this.syncPause(terminal);
    }

    // ── terminal events ─────────────────────────────────────────────────────────────

    private output(terminal: HostTerminal, data: Uint8Array): void {
        const offset = terminal.ring.append(data);
        if (terminal.streaming && this.attached !== null) {
            this.send(encodeData(terminal.tid, offset, data));
        } else if (terminal.ring.overPinnedCapacity && !terminal.retentionPaused) {
            terminal.retentionPaused = true;
            this.syncPause(terminal);
        }
    }

    private exited(terminal: HostTerminal, code: number, signal: number | null): void {
        terminal.exited = { code, signal };
        if (terminal.streaming && this.attached !== null) {
            this.send(encodeJson(FrameType.exit, { tid: terminal.tid, code, signal }));
            this.terminals.delete(terminal.tid);
        }
        this.scheduleIdleCheck();
    }

    /** Pause the PTY for any reason that applies; resume it when none does. */
    private syncPause(terminal: HostTerminal): void {
        if (terminal.exited !== null) return;
        if (!terminal.ring.overPinnedCapacity) terminal.retentionPaused = false;
        const pause =
            terminal.daemonPaused || terminal.retentionPaused || (terminal.streaming && this.socketBackpressure);
        if (pause === terminal.ptyPaused) return;
        terminal.ptyPaused = pause;
        if (pause) terminal.proc.pause?.();
        else terminal.proc.resume?.();
    }

    private scheduleIdleCheck(): void {
        clearTimeout(this.idleTimer);
        if (this.attached !== null || this.waiting !== null || this.liveCount() > 0 || this.exiting) return;
        // Exits no daemon has heard about keep the host around a while longer: the next daemon
        // needs them to close those panes instead of respawning them.
        const delay =
            this.terminals.size > 0
                ? UNREPORTED_EXIT_GRACE_MS
                : (this.options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS);
        this.idleTimer = setTimeout(() => {
            if (this.attached === null && this.liveCount() === 0) this.exit('idle');
        }, delay);
        this.idleTimer.unref();
    }
}

/** SIGHUP, then SIGKILL if the child ignored it (the terminal's exit handler records `exited`). */
function hangUp(terminal: HostTerminal): void {
    terminal.proc.kill('SIGHUP');
    setTimeout(() => {
        if (terminal.exited === null) terminal.proc.kill('SIGKILL');
    }, SHUTDOWN_KILL_GRACE_MS).unref();
}

function socketFileExists(socketPath: string): boolean {
    try {
        return statSync(socketPath).isSocket();
    } catch {
        return false;
    }
}

function tokenMatches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
