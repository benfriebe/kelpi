/**
 * Client-side `ping` probe over the control protocol (wire-protocol.md §6.8).
 *
 * Two callers: the stale-socket check before binding a unix socket (port note 10 — the
 * Swift app unlinks unconditionally and therefore steals the socket from a live instance;
 * the daemon refuses to start instead), and the lifecycle "is a daemon already running on
 * this run dir?" probe.
 *
 * Anything that answers with a JSON object counts as alive: a wedged handler that replies
 * `{"ok":false,…}` still owns the socket, and stealing it would break the running instance.
 */

import net from 'node:net';

import { createLineBuffer } from '@kelpi/protocol';

export type ControlProbeTarget = { readonly socketPath: string } | { readonly port: number; readonly host?: string | undefined };

/**
 * The `persistence` block of a `ping` reply, decoded.
 *
 * Absent from an older daemon (and from the Swift app), which is why `degraded` is only ever
 * true when the daemon actually said so — "no information" must not read as "broken".
 */
export interface ControlPingPersistence {
    readonly ok: boolean;
    readonly degraded: boolean;
    readonly path?: string | undefined;
    readonly error?: string | undefined;
    readonly errno?: string | undefined;
    readonly failedSaves?: number | undefined;
}

export interface ControlPingProbe {
    /** Something is listening and answered the ping with a JSON object. */
    readonly alive: boolean;
    /** The raw reply object, when one arrived. */
    readonly reply?: Record<string, unknown> | undefined;
    readonly pid?: number | undefined;
    readonly version?: string | undefined;
    readonly build?: string | undefined;
    /** Is the daemon's state actually reaching disk? Undefined = it did not say. */
    readonly persistence?: ControlPingPersistence | undefined;
    /** Did the optional TCP listener bind? Undefined = no TCP listener was configured. */
    readonly tcp?: ControlPingTcp | undefined;
    /** The CLI-compat socket is degraded (another Kelpi owns it). Undefined = serving. */
    readonly compat?: ControlPingCompat | undefined;
    /** The `NEX_SOCKET` the daemon injects into pane envs. Undefined = it did not say. */
    readonly paneRoute?: string | undefined;
    /** Why the probe concluded "not alive" (`ENOENT`, `ECONNREFUSED`, `timeout`, …). */
    readonly reason?: string | undefined;
}

/**
 * The `compat` block of a `ping` reply: the CLI-compat socket failed to bind — typically the
 * Swift app owning `/tmp/nex.sock` — while the daemon serves on via its run-dir socket and
 * pane-route TCP. A degraded compat socket is not a degraded daemon, but `kelpid status` must
 * say where plain-terminal commands are actually going.
 */
export interface ControlPingCompat {
    readonly path: string;
    readonly error: string;
}

/** Decode `ping`'s additive `compat` block; undefined when absent or malformed. */
export function readCompatStatus(reply: Record<string, unknown>): ControlPingCompat | undefined {
    const raw = reply['compat'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const source = raw as Record<string, unknown>;
    const path = readString(source, 'path');
    const error = readString(source, 'error');
    if (path === undefined || error === undefined) return undefined;
    return { path, error };
}

/**
 * The `tcp` block of a `ping` reply, decoded (§SET-021 / §AGNT-005).
 *
 * Absent when the daemon configured no TCP listener at all — a different fact from "asked for
 * one and it failed to bind", and the two must never print the same way.
 */
export interface ControlPingTcp {
    /** The port `tcp-port` asked for. */
    readonly requested: number;
    readonly host?: string | undefined;
    /** The port actually listening; undefined when the bind failed. */
    readonly bound?: number | undefined;
    /** The bind failure, verbatim; undefined when it bound. */
    readonly error?: string | undefined;
}

/** Decode `ping`'s additive `tcp` block; undefined when absent or malformed. */
export function readTcpStatus(reply: Record<string, unknown>): ControlPingTcp | undefined {
    const raw = reply['tcp'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const source = raw as Record<string, unknown>;
    const requested = readNumber(source, 'requested');
    if (requested === undefined) return undefined;
    const bound = readNumber(source, 'bound');
    const host = readString(source, 'host');
    const error = readString(source, 'error');
    return {
        requested,
        ...(host !== undefined ? { host } : {}),
        ...(bound !== undefined ? { bound } : {}),
        ...(error !== undefined ? { error } : {})
    };
}

/** Decode `ping`'s additive `persistence` block; undefined when absent or malformed. */
export function readPersistenceHealth(reply: Record<string, unknown>): ControlPingPersistence | undefined {
    const raw = reply['persistence'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
    const source = raw as Record<string, unknown>;
    const degraded = source['degraded'] === true;
    const okField = source['ok'];
    return {
        ok: typeof okField === 'boolean' ? okField : !degraded,
        degraded,
        ...(readString(source, 'path') !== undefined ? { path: readString(source, 'path') } : {}),
        ...(readString(source, 'error') !== undefined ? { error: readString(source, 'error') } : {}),
        ...(readString(source, 'errno') !== undefined ? { errno: readString(source, 'errno') } : {}),
        ...(readNumber(source, 'failed_saves') !== undefined
            ? { failedSaves: readNumber(source, 'failed_saves') }
            : {})
    };
}

export interface ControlProbeOptions {
    /** Total budget for connect + reply. Default 1000ms — this runs on the boot path. */
    readonly timeoutMs?: number | undefined;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 1000;

const PING_LINE = '{"command":"ping"}\n';

function readString(source: Record<string, unknown>, key: string): string | undefined {
    const value = source[key];
    return typeof value === 'string' ? value : undefined;
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Connect, send one `ping`, resolve with whatever came back. Never rejects. */
export function probeControlPing(target: ControlProbeTarget, options: ControlProbeOptions = {}): Promise<ControlPingProbe> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    return new Promise<ControlPingProbe>((resolve) => {
        const socket =
            'socketPath' in target
                ? net.connect({ path: target.socketPath })
                : net.connect({ port: target.port, host: target.host ?? '127.0.0.1' });
        const buffer = createLineBuffer();
        let settled = false;

        const finish = (result: ControlPingProbe): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(result);
        };

        const timer = setTimeout(() => finish({ alive: false, reason: 'timeout' }), timeoutMs);
        timer.unref?.();

        socket.on('connect', () => {
            try {
                socket.write(PING_LINE);
            } catch (error) {
                finish({ alive: false, reason: error instanceof Error ? error.message : 'write-failed' });
            }
        });

        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch {
                    finish({ alive: false, reason: 'unparseable-reply' });
                    return;
                }
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                    finish({ alive: false, reason: 'unexpected-reply' });
                    return;
                }
                const reply = parsed as Record<string, unknown>;
                const pid = readNumber(reply, 'pid');
                const version = readString(reply, 'version');
                const build = readString(reply, 'build');
                const persistence = readPersistenceHealth(reply);
                const tcp = readTcpStatus(reply);
                const compat = readCompatStatus(reply);
                const paneRoute = readString(reply, 'pane_route');
                finish({
                    alive: true,
                    reply,
                    ...(pid !== undefined ? { pid } : {}),
                    ...(version !== undefined ? { version } : {}),
                    ...(build !== undefined ? { build } : {}),
                    ...(persistence !== undefined ? { persistence } : {}),
                    ...(tcp !== undefined ? { tcp } : {}),
                    ...(compat !== undefined ? { compat } : {}),
                    ...(paneRoute !== undefined ? { paneRoute } : {})
                });
                return;
            }
        });

        socket.on('error', (error: NodeJS.ErrnoException) => {
            finish({ alive: false, reason: error.code ?? error.message });
        });

        socket.on('close', () => {
            // Accepted then hung up without answering: someone is listening but it is not
            // speaking this protocol (or it is mid-shutdown) — treat the socket as stale.
            finish({ alive: false, reason: 'closed-without-reply' });
        });
    });
}
