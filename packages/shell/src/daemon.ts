/**
 * Discover-or-spawn the daemon (ARCHITECTURE.md "Daemon lifecycle").
 *
 * The shell is a *client* of the daemon, not its owner. On launch it looks in the run dir
 * (`~/Library/Application Support/nexd/run`, or `NEXD_RUN_DIR`) for a daemon speaking this
 * protocol version; if one answers `ping` the shell simply adopts it — including a daemon
 * started by the `nex` CLI, by a previous run of the shell, or by a completely different
 * client. Only when nothing answers does it spawn one, **detached**, so the daemon outlives
 * the app that started it.
 *
 * The inverse rule is the one that matters most and is enforced by omission: nothing in this
 * module (or anywhere else in the shell) ever stops the daemon. Quitting the app leaves every
 * session running; that is the entire point of the architecture.
 *
 * Everything about the run dir — versioned paths, the 0600 token, the pid record, the liveness
 * probe, the detached spawn — is the daemon package's own lifecycle code (`@nex/daemon/
 * lifecycle`), so the shell cannot drift from the daemon's idea of where things live.
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { readPortFile } from '@nex/daemon/boot/port';
import {
    probeDaemon,
    readPidRecord,
    resolveRunPaths,
    readToken,
    spawnDetached,
    type RunPaths
} from '@nex/daemon/lifecycle';

import { log, warn } from './log.js';

/** Where `nexd` lives, when it is not in the default dev/packaged locations. */
export const ENTRY_ENV = 'NEXD_ENTRY';
/** The Node binary used to run the daemon script. */
export const NODE_ENV_VAR = 'NEXD_NODE';
/** Append the detached daemon's output here (handed straight to `spawnDetached`). */
export const LOG_FILE_ENV = 'NEXD_LOG_FILE';

export const DEFAULT_READY_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 750;
const POLL_INTERVAL_MS = 150;

export interface DaemonLocation {
    /** The run-dir paths this shell is talking to (socket/token/pid, protocol-versioned). */
    readonly paths: RunPaths;
    /** Loopback only — the shell never points at the tailnet URL (research/stack.md §1). */
    readonly url: string;
    readonly port: number;
    readonly token: string;
    readonly pid: number | undefined;
    /** True when this shell had to start the daemon. */
    readonly spawned: boolean;
}

export interface EnsureDaemonOptions {
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** The shell's own directory (`app.getAppPath()`); anchors the dev entry lookup. */
    readonly appDir?: string | undefined;
    /** `process.resourcesPath` in a packaged app; anchors the bundled entry lookup. */
    readonly resourcesPath?: string | undefined;
    readonly timeoutMs?: number | undefined;
    /** Injected by tests. */
    readonly now?: (() => number) | undefined;
}

export class DaemonUnavailableError extends Error {
    constructor(
        message: string,
        readonly repair: string
    ) {
        super(message);
        this.name = 'DaemonUnavailableError';
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function isExecutableFile(candidate: string): boolean {
    try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// ── locating the daemon ─────────────────────────────────────────────────────────────

export interface EntryLookup {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly appDir?: string | undefined;
    readonly resourcesPath?: string | undefined;
}

/**
 * Candidate `nexd` entry scripts, in priority order:
 *
 *   1. `NEXD_ENTRY` — the same override the daemon's own CLI honours (tests, odd layouts).
 *   2. `<appDir>/../daemon/dist/nexd.js` — the dev workspace: the shell package sits beside
 *      the daemon package, and `pnpm --filter @nex/daemon build` writes that bundle.
 *   3. `<resourcesPath>/daemon/nexd.js` — **the packaging hook**. When the shell is packaged
 *      the daemon bundle is copied into `Contents/Resources/daemon/` (with its `node_modules/
 *      node-pty` beside it, since that stays external to the bundle). Nothing produces this
 *      layout yet; the path is fixed here so packaging (M8) only has to place the files.
 */
export function daemonEntryCandidates(lookup: EntryLookup = {}): readonly string[] {
    const env = lookup.env ?? process.env;
    const override = env[ENTRY_ENV]?.trim();
    if (override !== undefined && override.length > 0) return [path.resolve(override)];

    const candidates: string[] = [];
    if (lookup.appDir !== undefined && lookup.appDir.length > 0) {
        candidates.push(path.resolve(lookup.appDir, '..', 'daemon', 'dist', 'nexd.js'));
    }
    if (lookup.resourcesPath !== undefined && lookup.resourcesPath.length > 0) {
        candidates.push(path.resolve(lookup.resourcesPath, 'daemon', 'nexd.js'));
    }
    return candidates;
}

/** The first candidate that exists, or undefined. */
export function resolveDaemonEntry(lookup: EntryLookup = {}): string | undefined {
    return daemonEntryCandidates(lookup).find((candidate) => existsSync(candidate));
}

/**
 * The Node binary that runs the daemon.
 *
 * `process.execPath` is the ELECTRON binary in the main process, and launching the daemon
 * through it would need `ELECTRON_RUN_AS_NODE`, which research/stack.md explicitly rules out
 * (it conflicts with the fuse hardening and couples daemon lifetime to the app bundle). So:
 * an explicit override, then a Node shipped inside the app bundle, then `node` off PATH.
 * Outside Electron (tests, `node dist/main.js`) the current interpreter is already correct.
 */
export function resolveNodeBinary(lookup: EntryLookup = {}): string | undefined {
    const env = lookup.env ?? process.env;
    const override = env[NODE_ENV_VAR]?.trim();
    if (override !== undefined && override.length > 0) return override;

    if (lookup.resourcesPath !== undefined && lookup.resourcesPath.length > 0) {
        const bundled = path.join(lookup.resourcesPath, 'node');
        if (isExecutableFile(bundled)) return bundled;
    }

    if (process.versions.electron === undefined) return process.execPath;

    const pathEntries = (env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
    for (const entry of pathEntries) {
        const candidate = path.join(entry, 'node');
        if (isExecutableFile(candidate)) return candidate;
    }
    return undefined;
}

// ── readiness ───────────────────────────────────────────────────────────────────────

/** The HTTP port the daemon recorded: the pid record first, then the port file. */
export function readHttpPort(paths: RunPaths): number | undefined {
    return readPidRecord(paths)?.http_port ?? readPortFile(paths);
}

export function daemonUrl(port: number): string {
    return `http://127.0.0.1:${String(port)}`;
}

/** The URL the BrowserWindow loads: the client reads `?token=` and drops it from history. */
export function clientUrl(location: Pick<DaemonLocation, 'url' | 'token'>): string {
    return `${location.url}/?token=${encodeURIComponent(location.token)}`;
}

async function httpHealthy(port: number): Promise<boolean> {
    try {
        const response = await fetch(`${daemonUrl(port)}/healthz`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * A daemon is usable to the shell only when all three of these agree: the control socket
 * answers `ping`, the run dir names an HTTP port, and that port serves `/healthz`. Checking
 * only the first would hand the window a URL that is not listening yet.
 */
async function readyLocation(paths: RunPaths, spawned: boolean): Promise<DaemonLocation | undefined> {
    const probe = await probeDaemon(paths, { timeoutMs: PROBE_TIMEOUT_MS });
    if (!probe.alive) return undefined;
    const port = readHttpPort(paths);
    if (port === undefined) return undefined;
    if (!(await httpHealthy(port))) return undefined;
    const token = readToken(paths);
    if (token === undefined) return undefined;
    return {
        paths,
        url: daemonUrl(port),
        port,
        token,
        pid: probe.pid,
        spawned
    };
}

// ── the entry point ─────────────────────────────────────────────────────────────────

/**
 * Adopt the running daemon, or start one and wait for it.
 *
 * Throws `DaemonUnavailableError` with a repair hint when there is nothing to adopt and
 * nothing to spawn (no entry script, no Node), or when a spawned daemon never came up —
 * `./main.ts` turns that into an error dialog instead of a blank window.
 */
export async function ensureDaemon(options: EnsureDaemonOptions = {}): Promise<DaemonLocation> {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const paths = resolveRunPaths({ env });

    const existing = await readyLocation(paths, false);
    if (existing !== undefined) {
        log(`daemon discovered pid=${String(existing.pid ?? 0)} ${existing.url} (run dir ${paths.dir})`);
        return existing;
    }

    const lookup: EntryLookup = {
        env,
        ...(options.appDir !== undefined ? { appDir: options.appDir } : {}),
        ...(options.resourcesPath !== undefined ? { resourcesPath: options.resourcesPath } : {})
    };
    const entry = resolveDaemonEntry(lookup);
    if (entry === undefined) {
        throw new DaemonUnavailableError(
            'No nexd daemon is running and no daemon bundle was found to start one.',
            `Build it with \`pnpm --filter @nex/daemon build\`, or set ${ENTRY_ENV} to the daemon entry script. Looked at: ${daemonEntryCandidates(lookup).join(', ') || '(no candidates)'}`
        );
    }
    const nodeBinary = resolveNodeBinary(lookup);
    if (nodeBinary === undefined) {
        throw new DaemonUnavailableError(
            'No Node binary was found to run the nexd daemon.',
            `Install Node 24+ (so \`node\` is on PATH), or set ${NODE_ENV_VAR} to a Node binary.`
        );
    }

    const logFile = env[LOG_FILE_ENV]?.trim();
    // `start --foreground` is what `nexd start` itself execs after detaching; going straight
    // to it skips a redundant process hop and gives us the daemon's real pid.
    const child = spawnDetached(entry, ['start', '--foreground'], {
        env,
        execPath: nodeBinary,
        ...(logFile !== undefined && logFile.length > 0 ? { logFile } : {})
    });
    log(`daemon spawned pid=${String(child.pid)} entry=${entry} node=${nodeBinary}`);

    const deadline = now() + timeoutMs;
    for (;;) {
        const location = await readyLocation(paths, true);
        if (location !== undefined) {
            log(`daemon ready pid=${String(location.pid ?? child.pid)} ${location.url}`);
            return location;
        }
        if (now() >= deadline) break;
        await sleep(POLL_INTERVAL_MS);
    }

    throw new DaemonUnavailableError(
        `The daemon did not become ready within ${String(timeoutMs)}ms (spawned pid ${String(child.pid)}).`,
        `Run \`${nodeBinary} ${entry} start --foreground\` in a terminal to see why, or set ${LOG_FILE_ENV} and relaunch.`
    );
}

/**
 * Re-check an adopted daemon, e.g. after the status socket has been failing. Returns the
 * refreshed location, or undefined when it is gone (the tray then offers "Start Daemon").
 */
export async function probeExisting(env: NodeJS.ProcessEnv = process.env): Promise<DaemonLocation | undefined> {
    const paths = resolveRunPaths({ env });
    const location = await readyLocation(paths, false);
    if (location === undefined) warn(`no daemon answering in ${paths.dir}`);
    return location;
}
