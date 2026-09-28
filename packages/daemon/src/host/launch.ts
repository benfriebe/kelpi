/**
 * Finding, launching and adopting the terminal host (`docs/terminal-host.md` §2, §9).
 *
 * The host's run-dir files sit next to the daemon's: `host-v<H>.{sock,token,pid}`. They
 * have the same shape as the daemon's `RunPaths`, so the token helpers are shared. Only a daemon
 * launches a host, and only when none answers on the socket.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { spawnDetached } from '../lifecycle/detach.js';
import { RUN_DIR_MODE, RUN_FILE_MODE, ensureToken, isProcessAlive, type RunPaths } from '../lifecycle/rundir.js';
import { connectTerminalHost, type ConnectTerminalHostOptions, type TerminalHostClient } from './client.js';
import { HOST_PROTOCOL_VERSION } from './protocol.js';
import { HANDOFF_WAIT_MS } from './server.js';

/** How long a launch waits for the new host to answer. */
export const HOST_LAUNCH_TIMEOUT_MS = 5000;

/**
 * `host-v<H>.{sock,token,pid}` in the run dir. Short on purpose: a sandbox run dir already sits
 * near macOS's 104-byte socket-path limit.
 */
export function resolveHostPaths(runDir: string, protocol: number = HOST_PROTOCOL_VERSION): RunPaths {
    const stem = path.join(runDir, `host-v${protocol}`);
    return { dir: runDir, protocol, socket: `${stem}.sock`, token: `${stem}.token`, pid: `${stem}.pid` };
}

/** What a host writes about itself once it is listening. */
export interface HostPidRecord {
    readonly pid: number;
    readonly protocol: number;
    readonly startedAt: string;
    readonly version: string;
    /** The directory its entry was launched from (a per-version copy when packaged, §9). */
    readonly runtimeDir: string;
}

export function writeHostPidRecord(paths: RunPaths, record: HostPidRecord): void {
    fs.mkdirSync(paths.dir, { recursive: true, mode: RUN_DIR_MODE });
    const temporary = `${paths.pid}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: RUN_FILE_MODE });
    fs.renameSync(temporary, paths.pid);
}

export function readHostPidRecord(paths: RunPaths): HostPidRecord | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(paths.pid, 'utf8')) as Partial<HostPidRecord>;
        if (typeof parsed.pid !== 'number' || typeof parsed.runtimeDir !== 'string') return undefined;
        return parsed as HostPidRecord;
    } catch {
        return undefined;
    }
}

/** Remove the pid record, but only if it is still ours (a successor may have replaced it). */
export function clearHostPidRecord(paths: RunPaths, pid: number = process.pid): void {
    if (readHostPidRecord(paths)?.pid !== pid) return;
    try {
        fs.unlinkSync(paths.pid);
    } catch {
        // already gone
    }
}

/** The pid of the host recorded for this run dir, if that process is still alive. */
export function liveHostPid(paths: RunPaths): number | undefined {
    const record = readHostPidRecord(paths);
    return record !== undefined && isProcessAlive(record.pid) ? record.pid : undefined;
}

/** Whether anything accepts a connection on `socketPath` (a live host, whatever its protocol). */
export function hostAnswers(socketPath: string, timeoutMs = 1000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection(socketPath);
        const done = (answered: boolean): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve(answered);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/**
 * The pid of a host that is really running on this run dir's socket, or undefined. A pid record
 * alone is not enough to signal: a host that died hard leaves its record behind, and the pid may
 * belong to an unrelated process by now.
 */
export async function verifiedHostPid(paths: RunPaths): Promise<number | undefined> {
    const pid = liveHostPid(paths);
    return pid !== undefined && (await hostAnswers(paths.socket)) ? pid : undefined;
}

/** SIGTERM a host (it hangs up its terminals first) and wait up to `timeoutMs` for it to go. */
export async function endHost(pid: number, timeoutMs = 3000): Promise<void> {
    try {
        process.kill(pid, 'SIGTERM');
    } catch {
        return;
    }
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

export interface EnsureTerminalHostOptions {
    readonly runDir: string;
    /** The host entry script (`terminal-host.js`). */
    readonly entry: string;
    /** The Node binary that runs it (the daemon's own `process.execPath`). */
    readonly execPath?: string;
    readonly logFile?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onSpawnProblem?: ConnectTerminalHostOptions['onSpawnProblem'];
    readonly timeoutMs?: number;
}

export interface EnsuredTerminalHost {
    readonly client: TerminalHostClient;
    /** False when an existing host was adopted. */
    readonly launched: boolean;
}

/** Attach to this run dir's host, launching one first if none answers. */
export async function ensureTerminalHost(options: EnsureTerminalHostOptions): Promise<EnsuredTerminalHost> {
    const paths = resolveHostPaths(options.runDir);
    fs.mkdirSync(paths.dir, { recursive: true, mode: RUN_DIR_MODE });
    const token = ensureToken(paths);
    const connect = (timeoutMs?: number): Promise<TerminalHostClient> =>
        connectTerminalHost({
            socketPath: paths.socket,
            token,
            mode: 'attach',
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            ...(options.onSpawnProblem !== undefined ? { onSpawnProblem: options.onSpawnProblem } : {})
        });

    // A live host may be holding our hello while another daemon finishes its handoff, which can
    // take a while with many terminals; give it that long before deciding anything.
    const recorded = await verifiedHostPid(paths);
    try {
        return { client: await connect(recorded !== undefined ? HANDOFF_WAIT_MS + 2000 : undefined), launched: false };
    } catch {
        // Nothing answering: launch one below.
    }
    if (recorded !== undefined && liveHostPid(paths) === recorded) {
        // It runs but will not take us. Running PTYs beside it would put a second copy of every
        // shell (and every resumed agent) next to its own, so it is ended instead.
        await endHost(recorded);
    }

    spawnDetached(options.entry, ['--run-dir', options.runDir], {
        ...(options.execPath !== undefined ? { execPath: options.execPath } : {}),
        ...(options.logFile !== undefined ? { logFile: options.logFile } : {}),
        // The host needs no environment of its own: every spawn carries a fully resolved env.
        env: options.env ?? minimalHostEnv(process.env),
        // It outlives worktrees: never pin a directory that may be deleted or unmounted.
        cwd: '/'
    });

    const deadline = Date.now() + (options.timeoutMs ?? HOST_LAUNCH_TIMEOUT_MS);
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            return { client: await connect(500), launched: true };
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
    throw new Error(`the terminal host did not start: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Just what Node and node-pty need to run; shells get their env from each spawn request. */
export function minimalHostEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const keep = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'KELPID_TERMINAL_HOST_LOG'];
    const out: NodeJS.ProcessEnv = {};
    for (const key of keep) if (env[key] !== undefined) out[key] = env[key];
    return out;
}
