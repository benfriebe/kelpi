/**
 * The host probes behind a scan: one `ps`, one `lsof` for listening sockets, one `lsof` for the
 * working directories of the processes that matter, and the Docker Engine API.
 *
 * Shell-outs, not a native helper: the stack allows one native dependency (node-pty), the way
 * `stats/host.ts` and `pty/process-cwd.ts` already work (docs/running-services.md §4, D4). On
 * 15 Nov 2026, on a Mac with 1,600 processes: `ps` 66 ms, the listen `lsof` 85 ms, the cwd
 * `lsof` 70 ms, the containers call 20 ms.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PS_COLUMNS, parseDockerContainers, parseLsofCwd, parseLsofListen, parsePsTable } from './parse.js';
import type { ContainerRow, ListenSocket, ProcessRow } from './types.js';

/** Longest any one probe may take before the scan reports it as unavailable. */
export const PROBE_TIMEOUT_MS = 3_000;

export interface RunningProbes {
    processTable(): Promise<ProcessRow[]>;
    listeners(): Promise<Map<number, ListenSocket[]>>;
    cwds(pids: readonly number[]): Promise<Map<number, string>>;
    /** Null when there is no Docker engine to ask (not installed, or not running). */
    containers(): Promise<ContainerRow[] | null>;
    pathExists(path: string): boolean;
    /** The path with symlinks resolved, or the path itself when it cannot be resolved. */
    realpath(path: string): string;
}

/** A probe that cannot run at all, as opposed to one that found nothing. */
export class ProbeUnavailableError extends Error {}

const PS = '/bin/ps';
const LSOF_PATHS = ['/usr/sbin/lsof', '/usr/bin/lsof'];

function resolveLsof(): string {
    return LSOF_PATHS.find((path) => existsSync(path)) ?? 'lsof';
}

interface RunOptions {
    readonly timeoutMs: number;
    readonly env: NodeJS.ProcessEnv;
    /**
     * `lsof` exits 1 both when it found nothing (empty output) and when one of several pids had
     * gone (the rest of its answer on stdout): for it, a plain exit 1 is an answer. Any other
     * failure, and any failure of `ps`, is an error, so a probe never looks empty when it broke.
     */
    readonly exitOneIsAnswer: boolean;
}

function run(file: string, args: readonly string[], options: RunOptions): Promise<string> {
    const name = file.split('/').pop() ?? file;
    return new Promise((resolve, reject) => {
        execFile(
            file,
            [...args],
            {
                encoding: 'utf8',
                timeout: options.timeoutMs,
                // A probe that ignores SIGTERM must not hold the scan (and every caller) open.
                killSignal: 'SIGKILL',
                maxBuffer: 16 * 1024 * 1024,
                env: options.env
            },
            (error, stdout, stderr) => {
                if (error === null) {
                    resolve(stdout);
                    return;
                }
                // execFile's error: `code` is the exit status (a number) or a system error name.
                const failure = error as { code?: unknown; killed?: boolean };
                if (failure.code === 'ENOENT') {
                    reject(new ProbeUnavailableError(`${name} not found`));
                    return;
                }
                // Killed (timeout) or cut off (maxBuffer): what was read is a partial table.
                if (failure.killed === true || failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
                    reject(new Error(`${name} did not finish`));
                    return;
                }
                if (options.exitOneIsAnswer && failure.code === 1) {
                    resolve(stdout);
                    return;
                }
                const detail = stderr.trim().split('\n')[0] ?? '';
                reject(new Error(`${name} failed${detail === '' ? '' : `: ${detail}`}`));
            }
        );
    });
}

/** Linux marks the working directory of a process whose folder was removed. */
const DELETED_SUFFIX = ' (deleted)';

export interface HostProbeOptions {
    readonly platform?: NodeJS.Platform | undefined;
    readonly home?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly timeoutMs?: number | undefined;
}

export function createHostProbes(options: HostProbeOptions = {}): RunningProbes {
    const platform = options.platform ?? process.platform;
    const home = options.home ?? homedir();
    const env = options.env ?? process.env;
    const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    const lsof = resolveLsof();
    // `lstart` in UTC (parsePsTable reads it as UTC); `C` keeps `ps` and `lsof` output parseable.
    const psOptions: RunOptions = { timeoutMs, env: { ...env, LC_ALL: 'C', TZ: 'UTC' }, exitOneIsAnswer: false };
    const lsofOptions: RunOptions = { timeoutMs, env: { ...env, LC_ALL: 'C' }, exitOneIsAnswer: true };

    return {
        async processTable() {
            if (platform === 'win32') throw new ProbeUnavailableError('process scanning is not supported on Windows');
            // `-A` selects every process on both macOS (`-ax`) and Linux procps (`-e`).
            return parsePsTable(await run(existsSync(PS) ? PS : 'ps', ['-A', '-o', PS_COLUMNS], psOptions));
        },
        async listeners() {
            if (platform === 'win32') throw new ProbeUnavailableError('port scanning is not supported on Windows');
            return parseLsofListen(await run(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], lsofOptions));
        },
        async cwds(pids) {
            if (pids.length === 0) return new Map();
            if (platform === 'linux') {
                const entries = await Promise.all(
                    pids.map(async (pid) => {
                        try {
                            const link = await readlink(`/proc/${String(pid)}/cwd`);
                            return [pid, link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link] as const;
                        } catch {
                            return null;
                        }
                    })
                );
                return new Map(entries.filter((entry): entry is readonly [number, string] => entry !== null));
            }
            return parseLsofCwd(await run(lsof, ['-a', '-d', 'cwd', '-F', 'pn', '-p', pids.join(',')], lsofOptions));
        },
        async containers() {
            const socket = dockerSocketPath(env, home);
            if (socket === null) return null;
            try {
                return parseDockerContainers(await getJSON(socket, '/containers/json', timeoutMs));
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code;
                // A socket file with no engine behind it is Docker not running, not a failure.
                if (code === 'ECONNREFUSED' || code === 'ENOENT') return null;
                throw error;
            }
        },
        pathExists(path) {
            return existsSync(path);
        },
        realpath(path) {
            try {
                // `native`: the case the file system stores, the way `lsof` reports a folder.
                return realpathSync.native(path);
            } catch {
                return path;
            }
        }
    };
}

function unixSocket(host: string | undefined): string | null {
    if (host === undefined || !host.startsWith('unix://')) return null;
    return host.slice('unix://'.length);
}

/**
 * The Docker engine's socket the way the `docker` CLI finds it: `DOCKER_HOST`, then the current
 * context (`~/.docker/config.json` → `contexts/meta/<sha256(name)>/meta.json`), then the usual
 * places Docker Desktop, OrbStack, Colima and Rancher Desktop put it. Only unix sockets: a TCP
 * engine is someone else's machine. Null when none exists.
 */
export function dockerSocketPath(env: NodeJS.ProcessEnv, home: string, exists: (path: string) => boolean = existsSync): string | null {
    const fromEnv = env['DOCKER_HOST'];
    if (fromEnv !== undefined && fromEnv !== '') {
        const socket = unixSocket(fromEnv);
        return socket !== null && exists(socket) ? socket : null;
    }
    try {
        const config = JSON.parse(readFileSync(join(home, '.docker', 'config.json'), 'utf8')) as { currentContext?: unknown };
        const name = config.currentContext;
        if (typeof name === 'string' && name !== '' && name !== 'default') {
            const digest = createHash('sha256').update(name).digest('hex');
            const meta = JSON.parse(readFileSync(join(home, '.docker', 'contexts', 'meta', digest, 'meta.json'), 'utf8')) as {
                Endpoints?: { docker?: { Host?: unknown } };
            };
            const host = meta.Endpoints?.docker?.Host;
            const socket = typeof host === 'string' ? unixSocket(host) : null;
            // The context the user chose is the engine `docker` talks to: when its socket is gone
            // (that engine is stopped) or it is remote, there is no engine to list, even if
            // another engine's socket is lying around.
            return socket !== null && exists(socket) ? socket : null;
        }
    } catch {
        // No config or no context: fall through to the usual places.
    }
    const candidates = [
        '/var/run/docker.sock',
        join(home, '.docker', 'run', 'docker.sock'),
        join(home, '.orbstack', 'run', 'docker.sock'),
        join(home, '.colima', 'default', 'docker.sock'),
        join(home, '.rd', 'docker.sock')
    ];
    return candidates.find((path) => exists(path)) ?? null;
}

function getJSON(socketPath: string, path: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, path, method: 'GET', timeout: timeoutMs, headers: { Host: 'docker' } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                if ((res.statusCode ?? 0) >= 400) {
                    reject(new Error(`HTTP ${String(res.statusCode)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch {
                    reject(new Error('unreadable reply'));
                }
            });
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}
