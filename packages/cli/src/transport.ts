/**
 * The control-socket transport (cli.md §5) — one JSON line out, read-until-EOF back.
 *
 * Transport selection is `KELPI_SOCKET`: absent (or anything not starting with `tcp:`) is the
 * Unix socket `/tmp/kelpi.sock`; `tcp:<host>:<port>` is TCP to a 127.0.0.1-bound listener. A
 * malformed `tcp:` value falls back to the Unix path SILENTLY — that is the shipped behavior
 * and scripts depend on it not being an error. `/tmp/nex.sock` is the Swift app's and is never
 * dialed: the two apps run side by side, and `kelpid import` is the bridge between them.
 *
 * Failures are classified into `TransportFailure` and stashed in a module global that
 * `printTransportFailure` renders as an `Error:`/`Warning:` + `Repair:` pair. The global is
 * reset at the start of every send so a chained call (doctor's ping, then `ps`; a bulk
 * `workspace delete`) can never surface a stale diagnostic.
 *
 * Three shapes of send:
 *   - fire-and-forget: write, flush, close, exit 0 even when the write never landed;
 *   - request/response: write, then read until EOF with an inactivity timeout that is treated
 *     exactly like Swift's `SO_RCVTIMEO` firing — return what arrived, which the caller reads
 *     as "no reply" and renders as the upgrade-required message;
 *   - streaming (`web console --follow`): no timeout at all, one callback per line, and a
 *     SIGINT that closes the socket so the daemon releases the held reply handle.
 */

import net from 'node:net';
import os from 'node:os';
import util from 'node:util';

import { replyTimeoutSeconds, silentRequested } from './env.js';
import { errLine, exit } from './io.js';
import type { JsonObject } from './json.js';

export const UNIX_SOCKET_PATH = '/tmp/kelpi.sock';

export type Transport = { readonly kind: 'unix'; readonly path: string } | { readonly kind: 'tcp'; readonly host: string; readonly port: number };

export function resolveTransport(env: NodeJS.ProcessEnv): Transport {
    const raw = env['KELPI_SOCKET'];
    if (raw !== undefined && raw.startsWith('tcp:')) {
        const rest = raw.slice(4);
        const colon = rest.indexOf(':');
        if (colon > 0) {
            const host = rest.slice(0, colon);
            const portText = rest.slice(colon + 1);
            if (/^\d+$/.test(portText)) {
                const port = Number.parseInt(portText, 10);
                if (port >= 0 && port <= 65535) return { kind: 'tcp', host, port };
            }
        }
    }
    return { kind: 'unix', path: UNIX_SOCKET_PATH };
}

let transport: Transport = resolveTransport(process.env);

export function setTransport(next: Transport): void {
    transport = next;
}

export function currentTransport(): Transport {
    return transport;
}

// ── failure classification ──────────────────────────────────────────────────────────

export type TransportFailure =
    | { readonly kind: 'unixSocketMissing'; readonly path: string }
    | { readonly kind: 'unixConnectRefused'; readonly path: string }
    | { readonly kind: 'unixConnectFailed'; readonly path: string; readonly errno: number; readonly message: string }
    | { readonly kind: 'tcpResolveFailed'; readonly host: string }
    | { readonly kind: 'tcpConnectFailed'; readonly host: string; readonly port: number; readonly errno: number; readonly message: string }
    | { readonly kind: 'createSocketFailed'; readonly errno: number; readonly message: string }
    | { readonly kind: 'emptyReply'; readonly command: string };

let lastTransportFailure: TransportFailure | null = null;

export function setLastTransportFailure(failure: TransportFailure | null): void {
    lastTransportFailure = failure;
}

export function takeLastTransportFailure(): TransportFailure | null {
    return lastTransportFailure;
}

/** errno name → the positive number and the strerror-ish text the message quotes. */
function errnoNumber(code: string | undefined): number {
    const table = os.constants.errno as unknown as Record<string, number | undefined>;
    return code !== undefined ? (table[code] ?? 0) : 0;
}

function errnoMessage(code: string | undefined): string {
    const number = errnoNumber(code);
    const entry = util.getSystemErrorMap().get(-number) ?? util.getSystemErrorMap().get(number);
    const text = entry?.[1] ?? code ?? 'unknown error';
    return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** (error line, repair line) for a failure, attributed to `command`. */
export function describeTransportFailure(failure: TransportFailure, command: string): readonly [string, string] {
    switch (failure.kind) {
        case 'unixSocketMissing':
            return [
                `${command}: cannot reach Kelpi — socket ${failure.path} does not exist.`,
                'Is Kelpi running? Launch the app, then retry. If Kelpi is running but using TCP, set KELPI_SOCKET=tcp:<host>:<port>.'
            ];
        case 'unixConnectRefused':
            return [
                `${command}: socket ${failure.path} exists but connect was refused — Kelpi is not listening (likely stale socket from a previous crash).`,
                `Restart Kelpi (panes and workspaces are persisted to ~/Library/Application Support/kelpid/kelpi.db so they will be restored). If the file remains after Kelpi quits, remove it with \`rm ${failure.path}\`.`
            ];
        case 'unixConnectFailed':
            return [
                `${command}: connect to ${failure.path} failed (errno ${String(failure.errno)}: ${failure.message}).`,
                'Run `kelpi doctor` for full IPC diagnostics.'
            ];
        case 'tcpResolveFailed':
            return [
                `${command}: cannot resolve host "${failure.host}" (from KELPI_SOCKET).`,
                'Check the hostname in KELPI_SOCKET. From a dev container the usual value is `tcp:host.docker.internal:<port>`.'
            ];
        case 'tcpConnectFailed':
            return [
                `${command}: TCP connect to ${failure.host}:${String(failure.port)} failed (errno ${String(failure.errno)}: ${failure.message}).`,
                `Confirm Kelpi has \`tcp-port = ${String(failure.port)}\` set in ~/.config/kelpi/config and is running. If you're tunneling, check the SSH reverse tunnel is up.`
            ];
        case 'createSocketFailed':
            return [
                `${command}: socket(2) failed (errno ${String(failure.errno)}: ${failure.message}).`,
                'Process-level failure — check for FD exhaustion. Run `kelpi doctor` for diagnostics.'
            ];
        case 'emptyReply':
            return [
                `${command}: no response from Kelpi for \`${failure.command}\` (connected, then peer closed before replying).`,
                'Likely an older Kelpi that doesn\'t recognise the command, or the app is wedged. Run `kelpi doctor` to confirm. Restart Kelpi if the doctor reports the app pid is responsive but commands hang.'
            ];
    }
}

/** Two stderr lines: `<Error|Warning>: <line>` then `Repair: <repair>`. */
export function printTransportFailure(command: string, options: { readonly fireAndForget?: boolean } = {}): void {
    const failure = lastTransportFailure;
    if (failure === null) {
        errLine(`${command}: transport failure (no diagnostic captured).`);
        return;
    }
    const [line, repair] = describeTransportFailure(failure, command);
    errLine(`${options.fireAndForget === true ? 'Warning' : 'Error'}: ${line}`);
    errLine(`Repair: ${repair}`);
}

/** `kelpi event …` sets this so hooks never spam a user's terminal (cli.md §5.6). */
let suppressFireAndForgetWarnings = false;

export function setSuppressFireAndForgetWarnings(value: boolean): void {
    suppressFireAndForgetWarnings = value;
}

/** Warn (unless suppressed) and exit **0** — a hook must never fail. */
export function handleFireAndForgetTransportFailure(command: string): never {
    if (!suppressFireAndForgetWarnings && !silentRequested()) {
        printTransportFailure(command, { fireAndForget: true });
    }
    return exit(0);
}

// ── connecting ──────────────────────────────────────────────────────────────────────

interface ConnectOutcome {
    readonly socket?: net.Socket;
    readonly failure?: TransportFailure;
}

function classifyConnectError(error: NodeJS.ErrnoException): TransportFailure {
    const code = error.code;
    if (transport.kind === 'unix') {
        if (code === 'ENOENT') return { kind: 'unixSocketMissing', path: transport.path };
        if (code === 'ECONNREFUSED') return { kind: 'unixConnectRefused', path: transport.path };
        if (code === 'EMFILE' || code === 'ENFILE') {
            return { kind: 'createSocketFailed', errno: errnoNumber(code), message: errnoMessage(code) };
        }
        return { kind: 'unixConnectFailed', path: transport.path, errno: errnoNumber(code), message: errnoMessage(code) };
    }
    const isResolve = error.syscall === 'getaddrinfo' || code === 'ENOTFOUND' || (code !== undefined && code.startsWith('EAI_'));
    if (isResolve) return { kind: 'tcpResolveFailed', host: transport.host };
    if (code === 'EMFILE' || code === 'ENFILE') {
        return { kind: 'createSocketFailed', errno: errnoNumber(code), message: errnoMessage(code) };
    }
    return {
        kind: 'tcpConnectFailed',
        host: transport.host,
        port: transport.port,
        errno: errnoNumber(code),
        message: errnoMessage(code)
    };
}

async function connect(): Promise<ConnectOutcome> {
    return new Promise<ConnectOutcome>((resolve) => {
        const socket =
            transport.kind === 'unix'
                ? net.createConnection({ path: transport.path })
                : net.createConnection({ host: transport.host, port: transport.port, family: 4 });
        const onError = (error: NodeJS.ErrnoException): void => {
            socket.destroy();
            resolve({ failure: classifyConnectError(error) });
        };
        socket.once('error', onError);
        socket.once('connect', () => {
            socket.removeListener('error', onError);
            resolve({ socket });
        });
    });
}

function encode(payload: JsonObject): string {
    return `${JSON.stringify(payload)}\n`;
}

// ── fire and forget ─────────────────────────────────────────────────────────────────

/**
 * Write one line and close. Any transport failure prints a `Warning:` (unless suppressed)
 * and exits 0 — never a non-zero code, never a hang.
 */
export async function sendJSON(payload: JsonObject, commandLabel = 'kelpi'): Promise<void> {
    lastTransportFailure = null;
    const outcome = await connect();
    if (outcome.socket === undefined) {
        lastTransportFailure = outcome.failure ?? null;
        handleFireAndForgetTransportFailure(commandLabel);
    }
    const socket = outcome.socket;
    await new Promise<void>((resolve) => {
        let settled = false;
        const done = (): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve();
        };
        socket.once('error', done);
        // `end(data, cb)` flushes the line to the kernel before the FIN — the Node equivalent
        // of Swift's `send()` immediately followed by `close(fd)`.
        socket.end(encode(payload), () => {
            done();
        });
    });
}

// ── request / response ──────────────────────────────────────────────────────────────

export interface ReadOptions {
    /** Seconds; defaults to `KELPI_REPLY_TIMEOUT` or 5. */
    readonly timeoutSeconds?: number | undefined;
}

/**
 * Send and read to EOF. `null` means transport failure (the caller prints the categorized
 * error and exits 1); an EMPTY string means "connected, sent, nothing came back", which each
 * caller renders in its own way (`pane send` treats it as success, everything else as
 * "this Kelpi is too old").
 */
export async function sendJSONAndReadReply(payload: JsonObject, options: ReadOptions = {}): Promise<string | null> {
    lastTransportFailure = null;
    const outcome = await connect();
    if (outcome.socket === undefined) {
        lastTransportFailure = outcome.failure ?? null;
        return null;
    }
    const socket = outcome.socket;
    const timeoutMs = (options.timeoutSeconds ?? replyTimeoutSeconds()) * 1000;
    const wireCommand = typeof payload['command'] === 'string' ? payload['command'] : 'kelpi';

    const reply = await new Promise<string | null>((resolve) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (value: string | null): void => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(value);
        };
        const accumulated = (): string => Buffer.concat(chunks).toString('utf8');

        // `setTimeout` is inactivity-based, exactly like SO_RCVTIMEO: it restarts on every
        // chunk, and firing yields whatever arrived so far (Swift's EAGAIN branch).
        socket.setTimeout(timeoutMs, () => {
            finish(accumulated());
        });
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        socket.on('end', () => {
            finish(accumulated());
        });
        socket.on('close', () => {
            finish(accumulated());
        });
        socket.on('error', () => {
            // A read error before any byte is Swift's `nil` return; after bytes, the partial
            // buffer is what the caller gets.
            finish(chunks.length === 0 ? null : accumulated());
        });
        socket.write(encode(payload));
    });

    if (reply === null) {
        lastTransportFailure = { kind: 'emptyReply', command: wireCommand };
    }
    return reply;
}

// ── streaming (`web console --follow`) ──────────────────────────────────────────────

export type StreamOutcome = 'closed' | 'interrupted' | 'failed';

/**
 * Send once, then hand every newline-delimited line to `onLine` until the server closes or
 * the user hits Ctrl-C. No read timeout: a live stream may idle for hours between events.
 * SIGINT closes the socket (so the daemon's disconnect callback releases the subscriber slot)
 * and reports `interrupted`, which the caller turns into exit 130.
 */
export async function streamJSON(payload: JsonObject, onLine: (line: string) => void): Promise<StreamOutcome> {
    lastTransportFailure = null;
    const outcome = await connect();
    if (outcome.socket === undefined) {
        lastTransportFailure = outcome.failure ?? null;
        return 'failed';
    }
    const socket = outcome.socket;

    return new Promise<StreamOutcome>((resolve, reject) => {
        let pending = '';
        let interrupted = false;
        let settled = false;
        // A line callback may `exit()` (an `ok:false` drain does). Throwing out of a socket
        // event handler would be an uncaught exception; carry it out of the promise instead.
        let thrown: unknown = null;

        const onSignal = (): void => {
            interrupted = true;
            process.removeListener('SIGINT', onSignal);
            socket.destroy();
        };
        process.on('SIGINT', onSignal);

        const finish = (): void => {
            if (settled) return;
            settled = true;
            process.removeListener('SIGINT', onSignal);
            socket.destroy();
            if (thrown !== null) {
                reject(thrown as Error);
                return;
            }
            resolve(interrupted ? 'interrupted' : 'closed');
        };

        socket.on('data', (chunk: Buffer) => {
            pending += chunk.toString('utf8');
            for (;;) {
                const index = pending.indexOf('\n');
                if (index < 0) break;
                const line = pending.slice(0, index);
                pending = pending.slice(index + 1);
                try {
                    onLine(line);
                } catch (error) {
                    thrown = error;
                    finish();
                    return;
                }
            }
        });
        socket.on('end', finish);
        socket.on('close', finish);
        socket.on('error', finish);
        socket.write(encode(payload));
    });
}
