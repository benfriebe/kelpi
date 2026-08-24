/**
 * Detached spawn + liveness probe (ARCHITECTURE.md "Daemon lifecycle").
 *
 * The daemon is started on demand by the app or the CLI and must **outlive its spawner**:
 * `detached: true` puts it in its own process group so the parent's exit (or ^C in the
 * spawning terminal) never signals it, `stdio: 'ignore'` drops the inherited descriptors
 * so the parent's pipes can close, and `unref()` lets the parent's event loop exit.
 *
 * It is not a launchd service: its lifetime is the login session plus explicit stop.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    probeControlPing,
    type ControlPingCompat,
    type ControlPingPersistence,
    type ControlPingProbe,
    type ControlPingTcp
} from '../control/probe.js';
import { isProcessAlive, readPidRecord, type PidRecord, type RunPaths } from './rundir.js';

/** Entries with these extensions are run through the Node binary, not exec'd directly. */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts']);

export interface SpawnDetachedOptions {
    readonly cwd?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Interpreter for script entries; defaults to the current Node binary. */
    readonly execPath?: string | undefined;
    /** Append stdout+stderr here instead of discarding them (daemon debugging). */
    readonly logFile?: string | undefined;
}

export interface DetachedProcess {
    readonly pid: number;
    readonly command: string;
    readonly args: readonly string[];
}

/** Spawn `entry` in its own process group, fully detached from this process. */
export function spawnDetached(entry: string, args: readonly string[] = [], options: SpawnDetachedOptions = {}): DetachedProcess {
    const isScript = SCRIPT_EXTENSIONS.has(path.extname(entry).toLowerCase());
    const command = isScript ? (options.execPath ?? process.execPath) : entry;
    const argv = isScript ? [entry, ...args] : [...args];

    let logFd: number | undefined;
    if (options.logFile !== undefined) {
        fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
        logFd = fs.openSync(options.logFile, 'a');
    }

    const child = spawn(command, argv, {
        detached: true,
        stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.env !== undefined ? { env: options.env } : {})
    });

    // The child holds its own copy of the descriptors from here on.
    if (logFd !== undefined) fs.closeSync(logFd);

    // Never keep the parent's loop alive, and never let a child error crash the spawner.
    child.on('error', () => undefined);
    child.unref();

    const pid = child.pid;
    if (pid === undefined) throw new Error(`failed to spawn detached process: ${command}`);
    return { pid, command, args: argv };
}

export interface DaemonProbeOptions {
    readonly timeoutMs?: number | undefined;
}

export interface DaemonProbe {
    /** A daemon answered `ping` on the run dir's socket. */
    readonly alive: boolean;
    readonly pid?: number | undefined;
    readonly version?: string | undefined;
    readonly build?: string | undefined;
    /** The `.pid` record, when readable (present even when the process is gone). */
    readonly record?: PidRecord | undefined;
    /** True when a record names a process that no longer exists. */
    readonly stalePidRecord: boolean;
    /**
     * The daemon's own answer to "is my state reaching disk?". Undefined when it did not say
     * (an older daemon) — which is not the same as healthy, and must never be printed as such.
     */
    readonly persistence?: ControlPingPersistence | undefined;
    /**
     * §SET-021: did the optional TCP control listener bind? Undefined when none was configured
     * (or the daemon predates the field) — which must never read as "it bound".
     */
    readonly tcp?: ControlPingTcp | undefined;
    /** The CLI-compat socket is degraded (another Nex owns it). Undefined = serving. */
    readonly compat?: ControlPingCompat | undefined;
    /** The `NEX_SOCKET` the daemon injects into pane envs. Undefined = it did not say. */
    readonly paneRoute?: string | undefined;
    readonly reason?: string | undefined;
}

/**
 * Ask the run dir whether a daemon is there. The socket answering `ping` is authoritative;
 * the `.pid` record is advisory (it can outlive a crash).
 */
export async function probeDaemon(paths: RunPaths, options: DaemonProbeOptions = {}): Promise<DaemonProbe> {
    const record = readPidRecord(paths);
    const ping: ControlPingProbe = await probeControlPing(
        { socketPath: paths.socket },
        options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}
    );
    const pid = ping.pid ?? record?.pid;
    return {
        alive: ping.alive,
        ...(pid !== undefined ? { pid } : {}),
        ...(ping.version !== undefined ? { version: ping.version } : {}),
        ...(ping.build !== undefined ? { build: ping.build } : {}),
        ...(record !== undefined ? { record } : {}),
        stalePidRecord: record !== undefined && !isProcessAlive(record.pid),
        ...(ping.persistence !== undefined ? { persistence: ping.persistence } : {}),
        ...(ping.tcp !== undefined ? { tcp: ping.tcp } : {}),
        ...(ping.compat !== undefined ? { compat: ping.compat } : {}),
        ...(ping.paneRoute !== undefined ? { paneRoute: ping.paneRoute } : {}),
        ...(ping.reason !== undefined ? { reason: ping.reason } : {})
    };
}

/** Convenience wrapper: is a daemon serving this run dir right now? */
export async function isDaemonAlive(paths: RunPaths, options: DaemonProbeOptions = {}): Promise<boolean> {
    const probe = await probeDaemon(paths, options);
    return probe.alive;
}
