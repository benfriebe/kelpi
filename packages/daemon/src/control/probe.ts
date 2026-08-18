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

import { createLineBuffer } from '@nex/protocol';

export type ControlProbeTarget = { readonly socketPath: string } | { readonly port: number; readonly host?: string | undefined };

export interface ControlPingProbe {
    /** Something is listening and answered the ping with a JSON object. */
    readonly alive: boolean;
    /** The raw reply object, when one arrived. */
    readonly reply?: Record<string, unknown> | undefined;
    readonly pid?: number | undefined;
    readonly version?: string | undefined;
    readonly build?: string | undefined;
    /** Why the probe concluded "not alive" (`ENOENT`, `ECONNREFUSED`, `timeout`, …). */
    readonly reason?: string | undefined;
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
                finish({
                    alive: true,
                    reply,
                    ...(pid !== undefined ? { pid } : {}),
                    ...(version !== undefined ? { version } : {}),
                    ...(build !== undefined ? { build } : {})
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
