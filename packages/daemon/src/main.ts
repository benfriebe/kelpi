/**
 * `nexd` — the New Nex daemon entrypoint.
 *
 *   nexd start [--foreground]   spawn (or become) the daemon
 *   nexd stop                   ask the running daemon to shut down cleanly
 *   nexd status [--json]        ping it over the control socket
 *   nexd url                    print the URL a browser should open (token included)
 *
 * `url` exists because the WS handshake is token-gated: opening a bare
 * `http://127.0.0.1:<port>` loads the client, which then fails to authenticate and shows a
 * rejection. Every path that prints a port therefore prints the ready-to-open URL beside it,
 * and `nexd url` prints that one line alone so it can be piped into `open`.
 *
 * The daemon is started on demand and **detached** (ARCHITECTURE.md "Daemon lifecycle"): it
 * outlives its spawner, so closing the terminal that ran `nexd start` — or quitting the app —
 * never kills an agent. `--foreground` is the same daemon in this process, which is what the
 * detached child itself runs, and what you want under a supervisor or in a container.
 *
 * Everything here is thin: `boot/compose.ts` owns the daemon, `lifecycle/` owns the run dir,
 * detach and probing. This file parses arguments and prints.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createDaemon,
    HTTP_HOST_ENV,
    readPortFile,
    resolveDaemonVersion,
    type DaemonInfo
} from './boot/index.js';
import { resolveControlEndpoints } from './control/index.js';
import { expandTilde, legacyMacAppDatabasePath, resolveDatabasePath } from './db/index.js';
import { isLegacyImportError, runImport, type ImportReport } from './import/index.js';
import {
    isProcessAlive,
    probeDaemon,
    readPidRecord,
    readToken,
    resolveRunPaths,
    spawnDetached,
    type DaemonProbe,
    type RunPaths
} from './lifecycle/index.js';

export const ENTRY_ENV = 'NEXD_ENTRY';
export const LOG_FILE_ENV = 'NEXD_LOG_FILE';

/** How long `nexd start` waits for the detached child to answer `ping`. */
export const START_TIMEOUT_MS = 15_000;
/** How long `nexd stop` waits for the daemon to disappear after SIGTERM. */
export const STOP_TIMEOUT_MS = 10_000;

export type NexdCommand = 'start' | 'stop' | 'status' | 'url' | 'import' | 'help' | 'version';

export interface ParsedArgs {
    readonly command: NexdCommand;
    readonly foreground: boolean;
    readonly json: boolean;
    readonly timeoutMs: number | undefined;
    /** `import --from`: the legacy Swift database. Defaults to the Mac app's path. */
    readonly from: string | undefined;
    /** `import --to`: the daemon database. Defaults to this environment's `NEXD_DB_PATH`. */
    readonly to: string | undefined;
    /** `import --force`: replace a populated target (after backing it up). */
    readonly force: boolean;
    /** `import --dry-run`: report only, write nothing. */
    readonly dryRun: boolean;
    /** Set when parsing failed; `runNexd` prints it and exits 2. */
    readonly error: string | undefined;
}

const USAGE = `nexd — the New Nex daemon

Usage:
  nexd start [--foreground]   Start the daemon (detached unless --foreground)
  nexd stop [--timeout <ms>]  Stop the running daemon (SIGTERM, then SIGKILL)
  nexd status [--json]        Ping the daemon and report version, pid and ports
  nexd url                    Print the client URL (with the token) and nothing else
  nexd import [options]       Import the Swift app's nex.db into the daemon's database
  nexd --version              Print the daemon version
  nexd --help                 This message

Import (one-time migration from the macOS app):
  nexd import [--from <db>] [--to <db>] [--force] [--dry-run] [--json]

    --from   legacy database (default: ~/Library/Application Support/Nex/nex.db)
    --to     daemon database (default: NEXD_DB_PATH, else the platform default)
    --force  replace a target that already holds workspaces; the existing database
             is copied aside as <target>.<timestamp>.bak first
    --dry-run  print the report and write nothing

  The source is opened read-only and is never modified. Stop the daemon first —
  the import is refused while one is running against the target, and --force does
  not override that. Recommended flow:

    nexd stop && nexd import && nexd start

  Panes come back on that start, and any pane that had an agent session resumes it
  (\`claude --resume <id>\` / \`codex resume <id>\`) just as a Nex.app restart would.

Open the web client (the token is required — a bare http://127.0.0.1:<port> cannot
authenticate and the client will say so):
  open "$(nexd url)"

Environment:
  NEXD_RUN_DIR       Run directory holding daemon-v<N>.{sock,token,pid,port}
                     (default: ~/Library/Application Support/nexd/run, or
                      $XDG_RUNTIME_DIR/nexd on Linux)
  NEXD_SOCKET_PATH   CLI-compat control socket (default: /tmp/nex.sock)
  NEXD_TCP_PORT      Control TCP listener on 127.0.0.1 (overrides config tcp-port)
  NEXD_HTTP_PORT     HTTP/WS port (default: the run dir's port file, else ephemeral)
  NEXD_HTTP_HOST     HTTP/WS bind address (default: 127.0.0.1)
  NEXD_DB_PATH       SQLite database file (default: ~/Library/Application Support/nexd/nex.db)
  NEXD_ALLOW_EPHEMERAL_STATE=1
                     Start even when that database cannot be opened. Nothing is
                     saved and every boot says so. Without it, an unusable
                     database is a hard startup failure — by design: a daemon
                     that silently stops persisting loses a day of work.
  NEXD_CONFIG_PATH   Config file (default: ~/.config/nex/config)
  NEXD_CLIENT_DIR    Directory holding the built web client
  NEXD_LOG_FILE      Append the detached daemon's stdout/stderr here
  NEXD_VERSION       Override the reported version (packaging)
  NEXD_BUILD         Override the reported build (packaging)
  NEXD_ENTRY         Executable/script re-spawned by \`nexd start\` when detaching

The \`nex\` CLI reaches the daemon over NEX_SOCKET:
  NEX_SOCKET=tcp:127.0.0.1:19400 nex pane list
`;

export function helpText(): string {
    return USAGE;
}

function parseTimeout(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return undefined;
    return Number.parseInt(trimmed, 10);
}

/** A flag value must be present and must not be the next flag (`--from --json`). */
function parseValue(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith('--')) return undefined;
    return trimmed;
}

export function parseNexdArgs(argv: readonly string[]): ParsedArgs {
    let command: NexdCommand | undefined;
    let foreground = false;
    let json = false;
    let timeoutMs: number | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let force = false;
    let dryRun = false;
    let error: string | undefined;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] as string;
        switch (arg) {
            case '--force':
                force = true;
                break;
            case '--dry-run':
                dryRun = true;
                break;
            case '--from': {
                const value = parseValue(argv[index + 1]);
                if (value === undefined) {
                    error ??= '--from needs a path';
                    break;
                }
                from = value;
                index += 1;
                break;
            }
            case '--to': {
                const value = parseValue(argv[index + 1]);
                if (value === undefined) {
                    error ??= '--to needs a path';
                    break;
                }
                to = value;
                index += 1;
                break;
            }
            case '--help':
            case '-h':
                command = 'help';
                break;
            case '--version':
            case '-V':
                if (command === undefined) command = 'version';
                break;
            case '--foreground':
            case '-f':
            case '--no-detach':
                foreground = true;
                break;
            case '--json':
                json = true;
                break;
            case '--timeout': {
                const value = parseTimeout(argv[index + 1]);
                if (value === undefined) {
                    error ??= '--timeout needs a millisecond value';
                    break;
                }
                timeoutMs = value;
                index += 1;
                break;
            }
            default:
                if (
                    arg === 'start' ||
                    arg === 'stop' ||
                    arg === 'status' ||
                    arg === 'url' ||
                    arg === 'import'
                ) {
                    if (command === undefined || command === 'version') command = arg;
                    break;
                }
                error ??= `unknown argument: ${arg}`;
                break;
        }
    }

    return {
        command: command ?? 'help',
        foreground,
        json,
        timeoutMs,
        from,
        to,
        force,
        dryRun,
        error
    };
}

export interface CliIO {
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Injected for tests; production waits on real signals. */
    readonly waitForever?: (() => Promise<void>) | undefined;
}

function defaultIO(): CliIO {
    return {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`)
    };
}

/**
 * Deliberately NOT unref'd: these sleeps are the CLI waiting for a daemon to appear or to
 * exit, and an unref'd timer lets node drain the loop and exit mid-poll — silently, with the
 * exit code of a success.
 */
function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * The script/binary `nexd start` re-spawns when it detaches. In the shipped bundle that is
 * `dist/nexd.js` (this very file); `NEXD_ENTRY` overrides it for packaging layouts where the
 * daemon is launched through a wrapper.
 */
export function resolveEntry(env: NodeJS.ProcessEnv): string {
    const override = env[ENTRY_ENV]?.trim();
    if (override !== undefined && override.length > 0) return override;
    try {
        return fileURLToPath(import.meta.url);
    } catch {
        return process.argv[1] ?? process.execPath;
    }
}

/** The URL a client would use — honouring the daemon's own bind-host override. */
function httpURL(env: NodeJS.ProcessEnv, port: number): string {
    const host = env[HTTP_HOST_ENV]?.trim();
    const bind = host === undefined || host.length === 0 ? '127.0.0.1' : host;
    return `http://${bind.includes(':') ? `[${bind}]` : bind}:${String(port)}`;
}

/**
 * The URL a human should actually open. The `?token=` half is not decoration: the `/ws`
 * handshake refuses a client that cannot present the run dir's token, so a bare origin loads
 * the bundle and then sits in a rejection. The client remembers the token and strips it from
 * the address bar on arrival (`client/src/app/config.ts`).
 */
export function clientURL(env: NodeJS.ProcessEnv, port: number, token: string): string {
    return `${httpURL(env, port)}/?token=${encodeURIComponent(token)}`;
}

/** `clientURL` from whatever the run dir knows; undefined when the port or token is missing. */
function runDirClientURL(env: NodeJS.ProcessEnv, paths: RunPaths): string | undefined {
    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);
    const token = readToken(paths);
    if (port === undefined || token === undefined) return undefined;
    return clientURL(env, port, token);
}

function runPathsFor(env: NodeJS.ProcessEnv): RunPaths {
    return resolveRunPaths({ env, protocol: resolveDaemonVersion(env).protocol });
}

async function waitForDaemon(paths: RunPaths, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const probe = await probeDaemon(paths, { timeoutMs: 500 });
        if (probe.alive) return true;
        if (Date.now() >= deadline) return false;
        await sleep(100);
    }
}

/**
 * The one warning that must never be swallowed: this daemon is running but nothing it does is
 * being written down. Printed by `status`, by `stop` (before the process goes away with the
 * state still in RAM) and by `start` when it adopts a running instance.
 */
function warnIfDegraded(io: CliIO, probe: DaemonProbe, headline?: string, repair?: string): boolean {
    const health = probe.persistence;
    if (health === undefined || !health.degraded) return false;
    io.err(
        headline ??
            'Warning: nexd is running WITHOUT working persistence — state is NOT being saved.'
    );
    if (health.path !== undefined) io.err(`  db: ${health.path}`);
    if (health.error !== undefined) io.err(`  error: ${health.error}`);
    if (health.failedSaves !== undefined && health.failedSaves > 0) {
        io.err(`  failed saves: ${String(health.failedSaves)}`);
    }
    io.err(
        `  Repair: ${repair ?? 'fix the database path, then `nexd stop && nexd start`. Restarting NOW loses everything created since it started.'}`
    );
    return true;
}

async function commandStart(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);

    const existing = await probeDaemon(paths, { timeoutMs: 500 });
    if (existing.alive) {
        io.out(
            `nexd already running (pid ${existing.pid === undefined ? 'unknown' : String(existing.pid)}) on ${paths.socket}`
        );
        // The point of `start` is usually "give me something to open", whether or not this
        // invocation is the one that started it.
        const url = runDirClientURL(env, paths);
        if (url !== undefined) io.out(`  url: ${url}`);
        // Adopting a daemon that cannot save is not success.
        return warnIfDegraded(io, existing) ? 1 : 0;
    }

    if (args.foreground) {
        const daemon = createDaemon({
            env,
            installSignalHandlers: true,
            onError: (error, context) => io.err(`nexd error [${context}]: ${error.message}`),
            onLog: (message) => io.out(message)
        });
        let info;
        try {
            info = await daemon.start();
        } catch (error) {
            const failure = error as NodeJS.ErrnoException & { repair?: string };
            io.err(`nexd failed to start: ${failure.message}`);
            if (failure.code === 'ENEXDPERSIST') {
                // Refusing to start beats running memory-only: the repair text names the file,
                // the errno and the way out (including the opt-in for a throw-away daemon).
                io.err(`Repair: ${failure.repair ?? 'point NEXD_DB_PATH at a writable file.'}`);
                io.err(
                    'To run anyway, without saving anything, set NEXD_ALLOW_EPHEMERAL_STATE=1.'
                );
            }
            if (failure.code === 'ECONTROLBUSY') {
                // The most likely one during the port: the Swift app owns /tmp/nex.sock.
                io.err(
                    `Repair: another process owns that control socket. Set NEXD_SOCKET_PATH (and NEXD_TCP_PORT for the CLI) to give this daemon its own endpoints.`
                );
            }
            await daemon.stop();
            return 1;
        }
        printInfo(io, info);
        // The listeners keep the loop alive; SIGTERM/SIGINT run the daemon's own shutdown
        // and exit the process, so this never resolves in production.
        await (io.waitForever ?? (() => new Promise<void>(() => {})))();
        return 0;
    }

    const entry = resolveEntry(env);
    const logFile = env[LOG_FILE_ENV]?.trim();
    const child = spawnDetached(entry, ['start', '--foreground'], {
        env,
        ...(logFile !== undefined && logFile.length > 0 ? { logFile } : {})
    });
    const alive = await waitForDaemon(paths, args.timeoutMs ?? START_TIMEOUT_MS);
    if (!alive) {
        io.err(
            `nexd did not answer on ${paths.socket} within ${String(args.timeoutMs ?? START_TIMEOUT_MS)}ms (spawned pid ${String(child.pid)})`
        );
        io.err(`Repair: run \`nexd start --foreground\` to see why, or set ${LOG_FILE_ENV} and retry.`);
        return 1;
    }
    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);
    io.out(`nexd started (pid ${String(record?.pid ?? child.pid)})`);
    io.out(`  control: ${resolveControlEndpoints(env).socketPath}`);
    io.out(`  discovery: ${paths.socket}`);
    if (port !== undefined) io.out(`  http: ${httpURL(env, port)}`);
    const url = runDirClientURL(env, paths);
    if (url !== undefined) io.out(`  url: ${url}`);
    return 0;
}

async function commandStop(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);
    const probe = await probeDaemon(paths, { timeoutMs: 500 });
    const pid = probe.pid ?? probe.record?.pid;

    if (!probe.alive) {
        if (pid !== undefined && isProcessAlive(pid)) {
            io.err(`nexd (pid ${String(pid)}) is not answering on ${paths.socket}; sending SIGTERM anyway`);
        } else {
            io.out('nexd is not running');
            return 0;
        }
    }
    if (pid === undefined) {
        io.err(`nexd is running on ${paths.socket} but its pid is unknown; cannot stop it`);
        return 1;
    }

    // Asked BEFORE the SIGTERM, because after it there is nobody left to ask — and a daemon
    // that never managed to write is exactly the one whose "stopped cleanly" is a lie. This is
    // the observed P0: `nexd stop` printed a clean stop over a database of zero bytes.
    const degraded = probe.persistence?.degraded === true;

    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        io.err(`failed to signal nexd (pid ${String(pid)}): ${(error as Error).message}`);
        return 1;
    }

    const timeoutMs = args.timeoutMs ?? STOP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            if (degraded) {
                warnIfDegraded(
                    io,
                    probe,
                    `nexd (pid ${String(pid)}) exited, but it was NOT saving state — everything from that session is gone.`,
                    'fix the database path (the errno above says why), then `nexd start`.'
                );
                return 1;
            }
            io.out(`nexd stopped (pid ${String(pid)})`);
            return 0;
        }
        await sleep(100);
    }

    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // It exited between the check and the signal — that is the outcome we wanted.
    }
    io.err(`nexd (pid ${String(pid)}) did not exit within ${String(timeoutMs)}ms; sent SIGKILL`);
    return 1;
}

async function commandStatus(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);
    const probe = await probeDaemon(paths, { timeoutMs: 1000 });
    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);

    const health = probe.persistence;
    const tcp = probe.tcp;

    if (args.json) {
        io.out(
            JSON.stringify({
                running: probe.alive,
                pid: probe.pid ?? null,
                version: probe.version ?? null,
                build: probe.build ?? null,
                protocol: paths.protocol,
                socket: paths.socket,
                control_socket: resolveControlEndpoints(env).socketPath,
                http_port: port ?? null,
                run_dir: paths.dir,
                // null = the daemon did not report (an older one); absent health is not health.
                // Snake_case to match every other key in this object and `ping`'s own block.
                persistence:
                    health === undefined
                        ? null
                        : {
                              ok: health.ok,
                              degraded: health.degraded,
                              path: health.path ?? null,
                              error: health.error ?? null,
                              errno: health.errno ?? null,
                              failed_saves: health.failedSaves ?? 0
                          },
                // §SET-021: null = no TCP listener was configured, which is NOT the same fact
                // as one that was asked for and failed to bind.
                tcp:
                    tcp === undefined
                        ? null
                        : {
                              requested: tcp.requested,
                              host: tcp.host ?? null,
                              bound: tcp.bound ?? null,
                              error: tcp.error ?? null
                          },
                ...(probe.alive ? {} : { reason: probe.reason ?? 'not running' })
            })
        );
        // Running-but-not-saving is a failed health check, not a passing one.
        return probe.alive && health?.degraded !== true ? 0 : 1;
    }

    if (!probe.alive) {
        io.out(`nexd is not running (${probe.reason ?? 'no socket'})`);
        if (probe.stalePidRecord) io.out(`  stale pid record: ${paths.pid}`);
        io.out(`  run dir: ${paths.dir}`);
        return 1;
    }

    io.out(`nexd is running (pid ${probe.pid === undefined ? 'unknown' : String(probe.pid)})`);
    io.out(`  version: ${probe.version ?? 'unknown'} (build ${probe.build ?? 'unknown'})`);
    io.out(`  protocol: ${String(paths.protocol)}`);
    io.out(`  control: ${resolveControlEndpoints(env).socketPath}`);
    // §SET-021 / §AGNT-005: a `tcp-port` that never bound used to be a log line inside the
    // daemon, so every `NEX_SOCKET=tcp:…` client just timed out with nothing to read. Printed
    // only when TCP was actually asked for — silence still means "Unix socket only".
    if (tcp !== undefined) {
        io.out(
            tcp.bound !== undefined
                ? `  tcp: listening on ${tcp.host ?? '127.0.0.1'}:${String(tcp.bound)}`
                : `  tcp: UNAVAILABLE — port ${String(tcp.requested)} did not bind${tcp.error === undefined ? '' : ` (${tcp.error})`}`
        );
    }
    io.out(`  discovery: ${paths.socket}`);
    if (port !== undefined) io.out(`  http: ${httpURL(env, port)}`);
    const url = runDirClientURL(env, paths);
    if (url !== undefined) io.out(`  url: ${url}`);
    io.out(`  run dir: ${paths.dir}`);
    io.out(
        `  persistence: ${health === undefined ? 'unknown (daemon did not report)' : health.degraded ? `DEGRADED — ${health.path ?? 'unknown path'}` : `ok (${health.path ?? 'unknown path'})`}`
    );
    if (tcp !== undefined && tcp.bound === undefined) {
        io.err(
            `Warning: the TCP control listener on port ${String(tcp.requested)} is not running${tcp.error === undefined ? '' : ` (${tcp.error})`}.`
        );
        io.err(
            '  Repair: free the port or set a different `tcp-port` in ~/.config/nex/config, then restart nexd. Unix-socket clients are unaffected.'
        );
    }
    return warnIfDegraded(io, probe) ? 1 : 0;
}

/**
 * `nexd url` — stdout is exactly the URL and nothing else, so `open "$(nexd url)"` works and
 * anything diagnostic goes to stderr.
 */
async function commandUrl(io: CliIO): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);
    const probe = await probeDaemon(paths, { timeoutMs: 1000 });

    if (!probe.alive) {
        io.err(`nexd is not running (${probe.reason ?? 'no socket'})`);
        io.err('Repair: start it with `nexd start`, then run `nexd url` again.');
        return 1;
    }

    const url = runDirClientURL(env, paths);
    if (url === undefined) {
        io.err(`nexd is running but ${paths.dir} has no HTTP port or token to build a URL from`);
        io.err('Repair: restart it (`nexd stop` then `nexd start`) so it rewrites the run dir.');
        return 1;
    }

    io.out(url);
    return 0;
}

/**
 * `nexd import` — the one-time migration from the macOS app's database.
 *
 * Three things this function owns that `import/` deliberately does not:
 *   - resolving the two default paths (they come from the environment, not the importer);
 *   - printing BOTH of them before anything is opened — an import replaces a whole database,
 *     so "which two files?" must be answerable before, not after;
 *   - refusing while a daemon is running against the target. `--force` does NOT override it:
 *     the running daemon holds the state in memory and its next save would overwrite whatever
 *     we imported, so the only correct order is stop → import → start.
 *
 * "Running against the target" is judged from THIS environment: the run dir it names is probed,
 * and the answer only matters when the target is also the database that environment resolves.
 * A daemon started with a different `NEXD_RUN_DIR` is invisible here — the same blind spot every
 * other verb has, and the reason `--to` a foreign path only warns.
 */
async function commandImport(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const home = env['HOME'] ?? homedir();
    const from = args.from === undefined ? legacyMacAppDatabasePath(home) : expandTilde(args.from, home);
    const to = args.to === undefined ? resolveDatabasePath({ env, home }) : expandTilde(args.to, home);

    // With --json stdout carries the report alone, so the announcement goes to stderr.
    const announce = args.json ? io.err : io.out;
    announce(`nexd import${args.dryRun ? ' (dry run)' : ''}`);
    announce(`  from: ${from}`);
    announce(`  to:   ${to}`);

    const fail = (message: string, repair: string): number => {
        if (args.json) io.out(JSON.stringify({ ok: false, from, to, error: message, repair }));
        else {
            io.err(`Error: ${message}`);
            io.err(`Repair: ${repair}`);
        }
        return 1;
    };

    const probe = await probeDaemon(runPathsFor(env), { timeoutMs: 500 });
    if (probe.alive) {
        const pid = probe.pid === undefined ? 'unknown' : String(probe.pid);
        // "Running against the target" = the daemon this environment describes owns that file.
        if (nodePath.resolve(to) === nodePath.resolve(resolveDatabasePath({ env, home }))) {
            return fail(
                `nexd is running (pid ${pid}) and owns ${to}`,
                'Stop it first — `nexd stop`, then `nexd import`, then `nexd start`. --force does not override this: a running daemon holds the state in memory and would overwrite the import on its next save.'
            );
        }
        io.err(`Warning: nexd is running (pid ${pid}), but ${to} is not the database it opened; importing anyway.`);
    }

    let report: ImportReport;
    try {
        report = runImport({ from, to, force: args.force, dryRun: args.dryRun });
    } catch (error) {
        if (isLegacyImportError(error)) return fail(error.message, error.repair);
        return fail(
            error instanceof Error ? error.message : String(error),
            'Re-run with --dry-run to see how far the import gets without writing anything.'
        );
    }

    if (args.json) {
        io.out(JSON.stringify({ ok: true, ...report }));
        return 0;
    }

    io.out(
        `${report.dryRun ? 'would import' : 'imported'} ${String(report.workspaces)} workspace(s), ${String(report.panes)} pane(s), ${String(report.groups)} group(s), ${String(report.repos)} repo(s)`
    );
    if (report.resumable > 0) {
        io.out(`  agent session(s) to resume on the next start: ${String(report.resumable)}`);
    }
    if (report.backupPath !== null) io.out(`  backup: ${report.backupPath}`);
    if (report.skipped.length > 0) {
        io.out(`  skipped ${String(report.skipped.length)} row(s):`);
        for (const row of report.skipped) {
            io.out(`    ${row.table} ${row.id ?? '(no id)'}: ${row.reason}`);
        }
    }
    if (report.warnings.length > 0) {
        io.out('  warnings:');
        for (const warning of report.warnings) io.out(`    ${warning}`);
    }
    io.out(
        report.dryRun
            ? 'Nothing was written. Re-run without --dry-run to import.'
            : 'Next: `nexd start` — panes are restored and agent sessions resume automatically.'
    );
    return 0;
}

function printInfo(io: CliIO, info: DaemonInfo): void {
    io.out(`nexd running (pid ${String(info.pid)})`);
    io.out(`  control: ${info.socketPath}`);
    io.out(`  discovery: ${info.runSocketPath}`);
    if (info.tcpPort !== undefined) io.out(`  control tcp: 127.0.0.1:${String(info.tcpPort)}`);
    io.out(`  http: ${info.url}`);
    // The one line a person actually needs: `http:` alone loads a client that cannot log in.
    io.out(`  url: ${info.url}/?token=${encodeURIComponent(info.token)}`);
    io.out(
        `  db: ${info.dbPath}${info.persistence.degraded ? ` — DEGRADED: ${info.persistence.error ?? 'not saving'}` : ''}`
    );
    io.out(`  workspaces: ${String(info.workspaces)} (resuming ${String(info.resumeTuples)} session(s))`);
}

/** The whole CLI as a function: returns the process exit code. */
export async function runNexd(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
    const args = parseNexdArgs(argv);
    if (args.error !== undefined) {
        io.err(args.error);
        io.err(USAGE);
        return 2;
    }
    switch (args.command) {
        case 'help':
            io.out(USAGE);
            return 0;
        case 'version':
            io.out(resolveDaemonVersion(io.env ?? process.env).version);
            return 0;
        case 'start':
            return commandStart(io, args);
        case 'stop':
            return commandStop(io, args);
        case 'status':
            return commandStatus(io, args);
        case 'url':
            return commandUrl(io);
        case 'import':
            return commandImport(io, args);
    }
}

/** True when this module is what node was asked to run (not an import from a test). */
function isEntrypoint(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) return false;
    try {
        return pathToFileURL(realpathSync(entry)).href === import.meta.url;
    } catch {
        return false;
    }
}

if (isEntrypoint()) {
    void runNexd(process.argv.slice(2)).then(
        (code) => {
            if (code !== 0) process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`nexd: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    );
}
