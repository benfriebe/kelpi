/**
 * Discover-or-spawn the daemon (ARCHITECTURE.md "Daemon lifecycle").
 *
 * The shell is a *client* of the daemon, not its owner. On launch it looks in the run dir
 * (`~/Library/Application Support/nexd/run`, or `KELPID_RUN_DIR`) for a daemon speaking this
 * protocol version; if one answers `ping` the shell simply adopts it — including a daemon
 * started by the `kelpi` CLI, by a previous run of the shell, or by a completely different
 * client. Only when nothing answers does it spawn one, **detached**, so the daemon outlives
 * the app that started it.
 *
 * The inverse rule is the one that matters most and is enforced by omission: nothing in this
 * module (or anywhere else in the shell) ever stops the daemon. Quitting the app leaves every
 * session running; that is the entire point of the architecture. The one thing it does to a
 * running daemon is a handoff after an update (`daemonReplacement`): the old daemon passes its
 * terminals to the terminal host and exits, and the new one adopts them, so no session ends.
 *
 * Everything about the run dir — versioned paths, the 0600 token, the pid record, the liveness
 * probe, the detached spawn — is the daemon package's own lifecycle code (`@kelpi/daemon/
 * lifecycle`), so the shell cannot drift from the daemon's idea of where things live.
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { readPortFile } from '@kelpi/daemon/boot/port';
import {
    isProcessAlive,
    probeDaemon,
    readPidRecord,
    resolveRunPaths,
    readToken,
    spawnDetached,
    type RunPaths
} from '@kelpi/daemon/lifecycle';

import { log, warn } from './log.js';
import { compareVersions } from './updater.js';
import {
    hasClientBuild,
    hasCliPayload,
    packagedClientDir,
    packagedCliDir,
    packagedDaemonEntry,
    packagedNodeBinary
} from './resources.js';

/** Where `kelpid` lives, when it is not in the default dev/packaged locations. */
export const ENTRY_ENV = 'KELPID_ENTRY';
/** The Node binary used to run the daemon script. */
export const NODE_ENV_VAR = 'KELPID_NODE';
/** Append the detached daemon's output here (handed straight to `spawnDetached`). */
export const LOG_FILE_ENV = 'KELPID_LOG_FILE';
/** The daemon's own name for "the directory holding the built web client" (`ws/http.ts`). */
export const CLIENT_DIR_ENV = 'KELPID_CLIENT_DIR';
/** The daemon's name for "the directory holding the bundled `kelpi` CLI" (`boot/compose.ts`). */
export const HELPERS_DIR_ENV = 'KELPID_HELPERS_DIR';
/** The version the daemon reports in `ping` (`boot/version.ts`); a packaged app stamps its own. */
export const DAEMON_VERSION_ENV = 'KELPID_VERSION';

export const DEFAULT_READY_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 750;
const POLL_INTERVAL_MS = 150;
/** How long an outdated daemon may take to hand its terminals over and exit (as `kelpid restart`). */
export const HANDOFF_TIMEOUT_MS = 30_000;

export interface DaemonLocation {
    /** The run-dir paths this shell is talking to (socket/token/pid, protocol-versioned). */
    readonly paths: RunPaths;
    /** Loopback only — the shell never points at the tailnet URL (research/stack.md §1). */
    readonly url: string;
    readonly port: number;
    readonly token: string;
    readonly pid: number | undefined;
    /** What the daemon's `ping` reported, when it said. */
    readonly version?: string | undefined;
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
    /**
     * `app.getVersion()` in a packaged app, undefined in a development run. A daemon this shell
     * starts reports it, and a running daemon older than it is handed off to a new one
     * (`daemonReplacement`), which is how an installed update reaches the daemon.
     */
    readonly appVersion?: string | undefined;
    /**
     * #314: where a daemon this shell starts writes its output when `KELPID_LOG_FILE` does not say.
     * Without one the packaged daemon's stdout and stderr went to /dev/null, so nothing it said
     * about a failure could be read afterwards.
     */
    readonly defaultLogFile?: string | undefined;
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
 * Candidate `kelpid` entry scripts, in priority order:
 *
 *   1. `KELPID_ENTRY` — the same override the daemon's own CLI honours (tests, odd layouts).
 *   2. `<appDir>/../daemon/dist/kelpid.js` — the dev workspace: the shell package sits beside
 *      the daemon package, and `pnpm --filter @kelpi/daemon build` writes that bundle.
 *   3. `<resourcesPath>/daemon/kelpid.js` — **the packaged app**. `forge.config.cjs` stages the
 *      daemon payload (the bundle plus its `node_modules/node-pty`, which stays external to
 *      the bundle because it is native) into `Contents/Resources/daemon/`, deliberately
 *      OUTSIDE `app.asar`: `node` cannot execute a file inside an archive, and `dlopen` cannot
 *      load `pty.node` from one either. `./resources.ts` owns that layout.
 */
export function daemonEntryCandidates(lookup: EntryLookup = {}): readonly string[] {
    const env = lookup.env ?? process.env;
    const override = env[ENTRY_ENV]?.trim();
    if (override !== undefined && override.length > 0) return [path.resolve(override)];

    const candidates: string[] = [];
    if (lookup.appDir !== undefined && lookup.appDir.length > 0) {
        candidates.push(path.resolve(lookup.appDir, '..', 'daemon', 'dist', 'kelpid.js'));
    }
    if (lookup.resourcesPath !== undefined && lookup.resourcesPath.length > 0) {
        candidates.push(path.resolve(packagedDaemonEntry(lookup.resourcesPath)));
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
        const bundled = packagedNodeBinary(lookup.resourcesPath);
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

/**
 * The environment a daemon spawned by THIS shell inherits.
 *
 * One addition, and only in a packaged app: `KELPID_CLIENT_DIR` pointing at
 * `Contents/Resources/client`. The daemon serves the web UI, and its own resolution of that
 * directory is env-only (`ws/http.ts` `resolveClientDistDir`) — deliberately, because the
 * daemon has no idea it is living inside an app bundle and `process.resourcesPath` is an
 * Electron concept. So the side that *does* know tells it, at spawn time, which keeps the
 * daemon free of packaging knowledge and keeps a headless `kelpid` (installed from npm, running
 * on a server) using its own rules.
 *
 * An explicit `KELPID_CLIENT_DIR` always wins — that is how a developer points a packaged app at
 * a `vite build` output — and a Resources directory without an `index.html` is ignored rather
 * than passed on, since the daemon's "client not built" page is a better answer than a
 * configured-but-empty directory.
 *
 * Note the scope: this applies to a daemon **this shell starts**. A daemon that was already
 * running (started by the CLI, or by a dev build) is adopted as-is, so it keeps whatever client
 * directory it was started with; one started by an older release is handed off instead
 * (`daemonReplacement`), which is how an update's new client reaches the window.
 */
export function daemonSpawnEnv(env: NodeJS.ProcessEnv, lookup: EntryLookup = {}, appVersion?: string): NodeJS.ProcessEnv {
    let result = env;
    // The daemon's compiled-in version names its source tree, not the release: a packaged app
    // stamps its own, so `ping` says which app started it and the next update can tell it is old.
    const existingVersion = env[DAEMON_VERSION_ENV]?.trim();
    if ((existingVersion === undefined || existingVersion.length === 0) && appVersion !== undefined && appVersion.length > 0) {
        result = { ...result, [DAEMON_VERSION_ENV]: appVersion };
    }
    const resourcesPath = lookup.resourcesPath;
    const existingClient = env[CLIENT_DIR_ENV]?.trim();
    if (
        (existingClient === undefined || existingClient.length === 0) &&
        resourcesPath !== undefined &&
        resourcesPath.length > 0
    ) {
        const bundled = packagedClientDir(resourcesPath);
        if (hasClientBuild(bundled)) result = { ...result, [CLIENT_DIR_ENV]: bundled };
    }
    // Same shape for the bundled CLI: the daemon prepends this directory to the PATH every pane
    // starts with, so a pane can always find a `kelpi`. The pane's login shell may put another
    // one first (`KELPID_HELPERS_DIR` in `@kelpi/daemon` boot/compose.ts says why that is safe).
    const existingHelpers = env[HELPERS_DIR_ENV]?.trim();
    if (
        (existingHelpers === undefined || existingHelpers.length === 0) &&
        resourcesPath !== undefined &&
        resourcesPath.length > 0 &&
        hasCliPayload(resourcesPath)
    ) {
        result = { ...result, [HELPERS_DIR_ENV]: packagedCliDir(resourcesPath) };
    }
    return result;
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
        ...(probe.version !== undefined ? { version: probe.version } : {}),
        spawned
    };
}

// ── after an update ─────────────────────────────────────────────────────────────────

export type DaemonReplacement =
    | { readonly action: 'adopt' }
    | { readonly action: 'handoff'; readonly reason: string }
    | { readonly action: 'keep'; readonly reason: string };

/**
 * What to do with a running daemon, given the app's version (#272). An update relaunches the app
 * into a new version while the old daemon keeps running, so a daemon **older** than the app is
 * replaced: it hands its terminals to the terminal host and exits, and the daemon this app then
 * starts adopts them (docs/terminal-host.md). A daemon from before the terminal host cannot hand
 * over, and stopping it would end every shell, so it is kept and the log says how to restart it.
 * A daemon as new as the app, or newer (started by a later build), is adopted as it is.
 */
export function daemonReplacement(
    daemonVersion: string | undefined,
    appVersion: string | undefined,
    canHandOff: boolean
): DaemonReplacement {
    if (daemonVersion === undefined || appVersion === undefined) return { action: 'adopt' };
    if (compareVersions(daemonVersion, appVersion) >= 0) return { action: 'adopt' };
    const reason = `the daemon is ${daemonVersion} and the app is ${appVersion}`;
    if (!canHandOff) {
        return { action: 'keep', reason: `${reason}, but it cannot hand its terminals over; run \`kelpid restart\` to update it (its shells end)` };
    }
    return { action: 'handoff', reason };
}

/** SIGUSR2 the daemon (a handoff, not a stop) and wait for it to exit. False if it never did. */
async function handOffDaemon(pid: number, now: () => number, timeoutMs: number): Promise<boolean> {
    try {
        process.kill(pid, 'SIGUSR2');
    } catch (error) {
        warn(`daemon handoff: could not signal pid=${String(pid)}: ${error instanceof Error ? error.message : String(error)}`);
        return !isProcessAlive(pid);
    }
    const deadline = now() + timeoutMs;
    while (isProcessAlive(pid)) {
        if (now() >= deadline) return false;
        await sleep(POLL_INTERVAL_MS);
    }
    return true;
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
        log(
            `daemon discovered pid=${String(existing.pid ?? 0)} version=${existing.version ?? 'unknown'} ${existing.url} (run dir ${paths.dir})`
        );
        const replacement = daemonReplacement(existing.version, options.appVersion, readPidRecord(paths)?.handoff === true);
        if (replacement.action === 'adopt' || existing.pid === undefined) return existing;
        if (replacement.action === 'keep') {
            warn(`daemon outdated: ${replacement.reason}`);
            return existing;
        }
        log(`daemon handoff: ${replacement.reason}; handing pid=${String(existing.pid)} over to a new daemon`);
        if (!(await handOffDaemon(existing.pid, now, HANDOFF_TIMEOUT_MS))) {
            warn(`daemon handoff: pid=${String(existing.pid)} did not exit within ${String(HANDOFF_TIMEOUT_MS)}ms; adopting it as it is`);
            return (await readyLocation(paths, false)) ?? existing;
        }
        log(`daemon handoff: pid=${String(existing.pid)} handed over; starting ${options.appVersion ?? ''}`);
    }

    const lookup: EntryLookup = {
        env,
        ...(options.appDir !== undefined ? { appDir: options.appDir } : {}),
        ...(options.resourcesPath !== undefined ? { resourcesPath: options.resourcesPath } : {})
    };
    const entry = resolveDaemonEntry(lookup);
    if (entry === undefined) {
        throw new DaemonUnavailableError(
            'No kelpid daemon is running and no daemon bundle was found to start one.',
            `Build it with \`pnpm --filter @kelpi/daemon build\`, or set ${ENTRY_ENV} to the daemon entry script. Looked at: ${daemonEntryCandidates(lookup).join(', ') || '(no candidates)'}`
        );
    }
    const nodeBinary = resolveNodeBinary(lookup);
    if (nodeBinary === undefined) {
        throw new DaemonUnavailableError(
            'No Node binary was found to run the kelpid daemon.',
            `Install Node 24+ (so \`node\` is on PATH), or set ${NODE_ENV_VAR} to a Node binary.`
        );
    }

    const configuredLog = env[LOG_FILE_ENV]?.trim();
    const logFile = configuredLog !== undefined && configuredLog.length > 0 ? configuredLog : options.defaultLogFile;
    let spawnEnv = daemonSpawnEnv(env, lookup, options.appVersion);
    // In the daemon's own env too, so the successor a `kelpid restart` spawns logs to the same file.
    if (logFile !== undefined && logFile !== configuredLog) spawnEnv = { ...spawnEnv, [LOG_FILE_ENV]: logFile };
    if (spawnEnv[CLIENT_DIR_ENV] !== env[CLIENT_DIR_ENV]) {
        log(`daemon client dir ${String(spawnEnv[CLIENT_DIR_ENV])} (from the app bundle)`);
    }
    if (spawnEnv[HELPERS_DIR_ENV] !== env[HELPERS_DIR_ENV]) {
        log(`daemon helpers dir ${String(spawnEnv[HELPERS_DIR_ENV])} (from the app bundle)`);
    }
    // `start --foreground` is what `kelpid start` itself execs after detaching; going straight
    // to it skips a redundant process hop and gives us the daemon's real pid.
    const child = spawnDetached(entry, ['start', '--foreground'], {
        env: spawnEnv,
        execPath: nodeBinary,
        ...(logFile !== undefined && logFile.length > 0 ? { logFile } : {})
    });
    log(`daemon spawned pid=${String(child.pid)} entry=${entry} node=${nodeBinary}${logFile === undefined ? '' : ` log=${logFile}`}`);

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
