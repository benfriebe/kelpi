/**
 * `kelpid` — the New Kelpi daemon entrypoint.
 *
 *   kelpid start [--foreground]   spawn (or become) the daemon
 *   kelpid stop                   ask the running daemon to shut down cleanly
 *   kelpid status [--json]        ping it over the control socket
 *   kelpid url                    print the URL a browser should open (token included)
 *
 * `url` exists because the WS handshake is token-gated: opening a bare
 * `http://127.0.0.1:<port>` loads the client, which then fails to authenticate and shows a
 * rejection. Every path that prints a port therefore prints the ready-to-open URL beside it,
 * and `kelpid url` prints that one line alone so it can be piped into `open`.
 *
 * The daemon is started on demand and **detached** (ARCHITECTURE.md "Daemon lifecycle"): it
 * outlives its spawner, so closing the terminal that ran `kelpid start` — or quitting the app —
 * never kills an agent. `--foreground` is the same daemon in this process, which is what the
 * detached child itself runs, and what you want under a supervisor or in a container.
 *
 * Everything here is thin: `boot/compose.ts` owns the daemon, `lifecycle/` owns the run dir,
 * detach and probing. This file parses arguments and prints.
 */

import { encodeQr, qrText } from '@kelpi/core/qr';
import fs, { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    createDaemon,
    HTTP_HOST_ENV,
    readPortFile,
    resolveConfigPath,
    resolveDaemonVersion,
    type DaemonInfo
} from './boot/index.js';
import { resolveControlEndpoints } from './control/index.js';
import { expandTilde, legacyDataDir, LEGACY_DATABASE_FILENAME, legacyMacAppDatabasePath, resolveDatabasePath } from './db/index.js';
import { isLegacyImportError, runImport, type ImportReport } from './import/index.js';
import {
    isProcessAlive,
    loadDevices,
    mintDevice,
    probeDaemon,
    readPidRecord,
    readToken,
    resolveDevicesPath,
    removeDevice,
    resolveRunPaths,
    resolveTailnetURL,
    revokeDevice,
    spawnDetached,
    type DaemonProbe,
    type RunPaths,
    type TailscaleRunner
} from './lifecycle/index.js';

export const ENTRY_ENV = 'KELPID_ENTRY';
export const LOG_FILE_ENV = 'KELPID_LOG_FILE';

/** How long `kelpid start` waits for the detached child to answer `ping`. */
export const START_TIMEOUT_MS = 15_000;
/** How long `kelpid stop` waits for the daemon to disappear after SIGTERM. */
export const STOP_TIMEOUT_MS = 10_000;

export type KelpidCommand = 'start' | 'stop' | 'status' | 'url' | 'pair' | 'devices' | 'import' | 'help' | 'version';

export interface ParsedArgs {
    readonly command: KelpidCommand;
    readonly foreground: boolean;
    readonly json: boolean;
    readonly timeoutMs: number | undefined;
    /** `import --from`: the legacy Swift database. Defaults to the Mac app's path. */
    readonly from: string | undefined;
    /** `import --to`: the daemon database. Defaults to this environment's `KELPID_DB_PATH`. */
    readonly to: string | undefined;
    /** `import --force`: replace a populated target (after backing it up). */
    readonly force: boolean;
    /** `import --dry-run`: report only, write nothing. */
    readonly dryRun: boolean;
    /** `url --tailnet`: print the tailscale-serve HTTPS URL instead of the loopback one. */
    readonly tailnet: boolean;
    /** `pair --name`: who the minted device token is for. */
    readonly pairName: string | undefined;
    /** `pair --qr`: draw the URL as a scannable symbol under it, on stderr. */
    readonly qr: boolean;
    /** `pair --qr --qr-invert`: the symbol drawn for a LIGHT terminal instead of a dark one. */
    readonly qrInvert: boolean;
    /** `devices [revoke]`: list by default. */
    readonly deviceAction: 'list' | 'revoke';
    /** `devices revoke <id-or-name>`. */
    readonly deviceTarget: string | undefined;
    /** Set when parsing failed; `runKelpid` prints it and exits 2. */
    readonly error: string | undefined;
}

const USAGE = `kelpid — the Kelpi daemon

Usage:
  kelpid start [--foreground]   Start the daemon (detached unless --foreground)
  kelpid stop [--timeout <ms>]  Stop the running daemon (SIGTERM, then SIGKILL)
  kelpid status [--json]        Ping the daemon and report version, pid and ports
  kelpid url [--tailnet]        Print the client URL (with the token) and nothing else
  kelpid pair --name <who> [--tailnet] [--qr [--qr-invert]]
                                Mint a per-device token and print its client URL
                                (--qr draws it as a scannable symbol under the URL;
                                 --qr-invert if your terminal has a light background)
  kelpid devices                List paired devices
  kelpid devices revoke <id|name>
                                Revoke a paired device (applies at its next connect)
  kelpid import [options]       Import the Swift app's nex.db into the daemon's database
  kelpid --version              Print the daemon version
  kelpid --help                 This message

Import (one-time migration from the macOS app):
  kelpid import [--from <db>] [--to <db>] [--force] [--dry-run] [--json]

    --from   legacy database (default: the pre-rename daemon's nexd/nex.db when it exists,
           else the Swift app's ~/Library/Application Support/Nex/nex.db)
    --to     daemon database (default: KELPID_DB_PATH, else the platform default)
    --force  replace a target that already holds workspaces; the existing database
             is copied aside as <target>.<timestamp>.bak first
    --dry-run  print the report and write nothing

  The source is opened read-only and is never modified. Stop the daemon first —
  the import is refused while one is running against the target, and --force does
  not override that. Recommended flow:

    kelpid stop && kelpid import && kelpid start

  Panes come back on that start, and any pane that had an agent session resumes it
  (\`claude --resume <id>\` / \`codex resume <id>\`) just as a Kelpi.app restart would.

Open the web client (the token is required — a bare http://127.0.0.1:<port> cannot
authenticate and the client will say so):
  open "$(kelpid url)"

Remote (another machine on the tailnet): --tailnet fronts the daemon's port with
\`tailscale serve\` (HTTPS at https://<machine>.<tailnet>.ts.net, tailnet-only — never
funnel) and prints that URL instead. It configures serve when nothing is being served,
says so on stderr, and REFUSES to replace a serve config that fronts something else —
stdout stays exactly the URL, so this works from the daemon machine:
  open "$(kelpid url --tailnet)"

Other people and devices: never share the \`url\` URL — its token is the OWNER
credential. Mint each person/device its own with \`pair\` (the printed URL carries a
token only that device holds, stored hashed in <data dir>/devices.json):
  kelpid pair --name "alice-laptop" --tailnet
  kelpid devices
  kelpid devices revoke alice-laptop

Pairing a phone from a terminal: --qr draws the URL as a QR code on stderr, under
the URL, so the phone can be pointed at the screen instead of being typed into.
stdout is still exactly the URL, so \`open "$(kelpid pair --name x --tailnet --qr)"\`
keeps working. The symbol is drawn for a DARK terminal; add --qr-invert for a light
one. It needs --tailnet: a loopback URL is not reachable from a phone, so --qr
without it pairs as usual and says why it drew nothing.
  kelpid pair --name "my-phone" --tailnet --qr

Environment:
  KELPID_RUN_DIR       Run directory holding daemon-v<N>.{sock,token,pid,port}
                     (default: ~/Library/Application Support/kelpid/run, or
                      $XDG_RUNTIME_DIR/nexd on Linux)
  KELPID_SOCKET_PATH   CLI-compat control socket (default: /tmp/kelpi.sock)
  KELPID_TCP_PORT      Control TCP listener on 127.0.0.1 (overrides config tcp-port)
  KELPID_HTTP_PORT     HTTP/WS port (default: the run dir's port file, else ephemeral)
  KELPID_HTTP_HOST     HTTP/WS bind address (default: 127.0.0.1)
  KELPID_DB_PATH       SQLite database file (default: ~/Library/Application Support/kelpid/kelpi.db)
  KELPID_ALLOW_EPHEMERAL_STATE=1
                     Start even when that database cannot be opened. Nothing is
                     saved and every boot says so. Without it, an unusable
                     database is a hard startup failure — by design: a daemon
                     that silently stops persisting loses a day of work.
  KELPID_CONFIG_PATH   Config file (default: ~/.config/kelpi/config)
  KELPID_DEVICES_PATH  Paired-devices registry (default: <data dir>/devices.json)
  KELPID_CLIENT_DIR    Directory holding the built web client
  KELPID_LOG_FILE      Append the detached daemon's stdout/stderr here
  KELPID_VERSION       Override the reported version (packaging)
  KELPID_BUILD         Override the reported build (packaging)
  KELPID_ENTRY         Executable/script re-spawned by \`kelpid start\` when detaching

The \`kelpi\` CLI reaches the daemon over KELPI_SOCKET:
  KELPI_SOCKET=tcp:127.0.0.1:19400 kelpi pane list
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

export function parseKelpidArgs(argv: readonly string[]): ParsedArgs {
    let command: KelpidCommand | undefined;
    let foreground = false;
    let json = false;
    let timeoutMs: number | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let force = false;
    let dryRun = false;
    let tailnet = false;
    let pairName: string | undefined;
    let qr = false;
    let qrInvert = false;
    let deviceAction: 'list' | 'revoke' = 'list';
    let deviceTarget: string | undefined;
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
            case '--tailnet':
                tailnet = true;
                break;
            case '--qr':
                qr = true;
                break;
            case '--qr-invert':
                // Implies --qr: nobody types the polarity flag meaning "and no symbol".
                qr = true;
                qrInvert = true;
                break;
            case '--name': {
                const value = parseValue(argv[index + 1]);
                if (value === undefined) {
                    error ??= '--name needs a value';
                    break;
                }
                pairName = value;
                index += 1;
                break;
            }
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
                // `devices` takes positional words, checked BEFORE the verb list so a device
                // named like a verb (`kelpid devices revoke start`) still resolves.
                if (command === 'devices' && deviceAction === 'list' && arg === 'revoke') {
                    deviceAction = 'revoke';
                    break;
                }
                if (command === 'devices' && deviceAction === 'revoke' && deviceTarget === undefined && !arg.startsWith('--')) {
                    deviceTarget = arg;
                    break;
                }
                if (
                    arg === 'start' ||
                    arg === 'stop' ||
                    arg === 'status' ||
                    arg === 'url' ||
                    arg === 'pair' ||
                    arg === 'devices' ||
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
        tailnet,
        pairName,
        qr,
        qrInvert,
        deviceAction,
        deviceTarget,
        error
    };
}

export interface CliIO {
    readonly out: (line: string) => void;
    readonly err: (line: string) => void;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Injected for tests; production waits on real signals. */
    readonly waitForever?: (() => Promise<void>) | undefined;
    /** Injected for tests; production shells out to the real `tailscale`. */
    readonly tailscaleRunner?: TailscaleRunner | undefined;
}

function defaultIO(): CliIO {
    /*
     * Writes never throw, and a dead pipe never kills the daemon. `kelpid start --foreground`
     * under a supervisor (the audit harness, a crashed probe script, a terminal that closed)
     * has stdout/stderr as pipes whose reader can die first — from then on every write raises
     * EPIPE, and an uncaught EPIPE would take a healthy daemon down with the process that was
     * merely WATCHING it. Logging is best-effort: swallow both the synchronous throw and the
     * async 'error' event (Node surfaces EPIPE either way depending on timing).
     */
    const supervisorGone = (): void => {
        // Under the audit harness the daemon must not outlive its supervisor: a dead stdout
        // pipe or a reparent to pid 1 means the harness was hard-killed, so take the graceful
        // SIGTERM path (flush + socket teardown) instead of lingering as an orphan. A user's
        // daemon (packaged, or `kelpid start` from a terminal) never carries the marker.
        if (process.env['KELPI_HARNESS'] === '1') process.kill(process.pid, 'SIGTERM');
    };
    for (const stream of [process.stdout, process.stderr]) {
        if (stream.listenerCount('error') === 0) stream.on('error', supervisorGone);
    }
    if (process.env['KELPI_HARNESS'] === '1') {
        const watchdog = setInterval(() => {
            if (process.ppid === 1) supervisorGone();
        }, 10_000);
        watchdog.unref();
    }
    const write = (stream: NodeJS.WriteStream, line: string): void => {
        try {
            stream.write(`${line}\n`);
        } catch {
            // dead pipe — the log goes quiet, the daemon stays up
        }
    };
    return {
        out: (line) => write(process.stdout, line),
        err: (line) => write(process.stderr, line)
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
 * The script/binary `kelpid start` re-spawns when it detaches. In the shipped bundle that is
 * `dist/kelpid.js` (this very file); `KELPID_ENTRY` overrides it for packaging layouts where the
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
            'Warning: kelpid is running WITHOUT working persistence — state is NOT being saved.'
    );
    if (health.path !== undefined) io.err(`  db: ${health.path}`);
    if (health.error !== undefined) io.err(`  error: ${health.error}`);
    if (health.failedSaves !== undefined && health.failedSaves > 0) {
        io.err(`  failed saves: ${String(health.failedSaves)}`);
    }
    io.err(
        `  Repair: ${repair ?? 'fix the database path, then `kelpid stop && kelpid start`. Restarting NOW loses everything created since it started.'}`
    );
    return true;
}

async function commandStart(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);

    const existing = await probeDaemon(paths, { timeoutMs: 500 });
    if (existing.alive) {
        io.out(
            `kelpid already running (pid ${existing.pid === undefined ? 'unknown' : String(existing.pid)}) on ${paths.socket}`
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
            onError: (error, context) => io.err(`kelpid error [${context}]: ${error.message}`),
            onLog: (message) => io.out(message)
        });
        let info;
        try {
            info = await daemon.start();
        } catch (error) {
            const failure = error as NodeJS.ErrnoException & { repair?: string };
            io.err(`kelpid failed to start: ${failure.message}`);
            if (failure.code === 'ENEXDPERSIST') {
                // Refusing to start beats running memory-only: the repair text names the file,
                // the errno and the way out (including the opt-in for a throw-away daemon).
                io.err(`Repair: ${failure.repair ?? 'point KELPID_DB_PATH at a writable file.'}`);
                io.err(
                    'To run anyway, without saving anything, set KELPID_ALLOW_EPHEMERAL_STATE=1.'
                );
            }
            if (failure.code === 'ECONTROLBUSY') {
                // Only the RUN-DIR socket is fatal now (a daemon of this protocol is already
                // running there); a busy CLI-compat socket merely degrades (`startCompat`).
                io.err(
                    `Repair: a live daemon already owns this run dir's socket — use it (\`kelpid status\`), or point KELPID_RUN_DIR at a different run dir for a second daemon.`
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
            `kelpid did not answer on ${paths.socket} within ${String(args.timeoutMs ?? START_TIMEOUT_MS)}ms (spawned pid ${String(child.pid)})`
        );
        io.err(`Repair: run \`kelpid start --foreground\` to see why, or set ${LOG_FILE_ENV} and retry.`);
        return 1;
    }
    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);
    io.out(`kelpid started (pid ${String(record?.pid ?? child.pid)})`);
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
            io.err(`kelpid (pid ${String(pid)}) is not answering on ${paths.socket}; sending SIGTERM anyway`);
        } else {
            io.out('kelpid is not running');
            return 0;
        }
    }
    if (pid === undefined) {
        io.err(`kelpid is running on ${paths.socket} but its pid is unknown; cannot stop it`);
        return 1;
    }

    // Asked BEFORE the SIGTERM, because after it there is nobody left to ask — and a daemon
    // that never managed to write is exactly the one whose "stopped cleanly" is a lie. This is
    // the observed P0: `kelpid stop` printed a clean stop over a database of zero bytes.
    const degraded = probe.persistence?.degraded === true;

    try {
        process.kill(pid, 'SIGTERM');
    } catch (error) {
        io.err(`failed to signal kelpid (pid ${String(pid)}): ${(error as Error).message}`);
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
                    `kelpid (pid ${String(pid)}) exited, but it was NOT saving state — everything from that session is gone.`,
                    'fix the database path (the errno above says why), then `kelpid start`.'
                );
                return 1;
            }
            io.out(`kelpid stopped (pid ${String(pid)})`);
            return 0;
        }
        await sleep(100);
    }

    try {
        process.kill(pid, 'SIGKILL');
    } catch {
        // It exited between the check and the signal — that is the outcome we wanted.
    }
    io.err(`kelpid (pid ${String(pid)}) did not exit within ${String(timeoutMs)}ms; sent SIGKILL`);
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
                // null = the compat socket is serving (or an older daemon did not report).
                compat:
                    probe.compat === undefined
                        ? null
                        : { path: probe.compat.path, error: probe.compat.error },
                // The NEX_SOCKET value panes carry; null = the daemon did not report one.
                pane_route: probe.paneRoute ?? null,
                ...(probe.alive ? {} : { reason: probe.reason ?? 'not running' })
            })
        );
        // Running-but-not-saving is a failed health check, not a passing one.
        return probe.alive && health?.degraded !== true ? 0 : 1;
    }

    if (!probe.alive) {
        io.out(`kelpid is not running (${probe.reason ?? 'no socket'})`);
        if (probe.stalePidRecord) io.out(`  stale pid record: ${paths.pid}`);
        io.out(`  run dir: ${paths.dir}`);
        return 1;
    }

    io.out(`kelpid is running (pid ${probe.pid === undefined ? 'unknown' : String(probe.pid)})`);
    io.out(`  version: ${probe.version ?? 'unknown'} (build ${probe.build ?? 'unknown'})`);
    io.out(`  protocol: ${String(paths.protocol)}`);
    // A degraded compat socket is not a degraded daemon — panes route via their injected
    // NEX_SOCKET — but this line is where a user learns their plain-terminal `kelpi` commands
    // on the default socket are reaching a DIFFERENT app (typically the Swift one).
    io.out(
        probe.compat === undefined
            ? `  control: ${resolveControlEndpoints(env).socketPath}`
            : `  control: ${probe.compat.path} DEGRADED — ${probe.compat.error}`
    );
    if (probe.paneRoute !== undefined) io.out(`  pane route: ${probe.paneRoute}`);
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
            '  Repair: free the port or set a different `tcp-port` in ~/.config/kelpi/config, then restart kelpid. Unix-socket clients are unaffected.'
        );
    }
    return warnIfDegraded(io, probe) ? 1 : 0;
}

/**
 * `kelpid url [--tailnet]` — stdout is exactly the URL and nothing else, so
 * `open "$(kelpid url)"` works and anything diagnostic goes to stderr.
 *
 * `--tailnet` swaps the loopback origin for the machine's MagicDNS one, after making sure
 * `tailscale serve` actually fronts the daemon's port (`lifecycle/tailnet.ts` — it configures
 * an idle serve, reports that on stderr, and refuses to replace a foreign one).
 */
async function commandUrl(io: CliIO, tailnet: boolean): Promise<number> {
    const env = io.env ?? process.env;
    const paths = runPathsFor(env);
    const probe = await probeDaemon(paths, { timeoutMs: 1000 });

    if (!probe.alive) {
        io.err(`kelpid is not running (${probe.reason ?? 'no socket'})`);
        io.err('Repair: start it with `kelpid start`, then run `kelpid url` again.');
        return 1;
    }

    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);
    const token = readToken(paths);
    if (port === undefined || token === undefined) {
        io.err(`kelpid is running but ${paths.dir} has no HTTP port or token to build a URL from`);
        io.err('Repair: restart it (`kelpid stop` then `kelpid start`) so it rewrites the run dir.');
        return 1;
    }

    if (!tailnet) {
        io.out(clientURL(env, port, token));
        return 0;
    }

    const result = await resolveTailnetURL({ port, token, run: io.tailscaleRunner });
    if (result.kind === 'error') {
        io.err(result.message);
        if (result.repair !== undefined) io.err(`Repair: ${result.repair}`);
        return 1;
    }
    for (const note of result.notes) io.err(note);
    io.out(result.url);
    return 0;
}

/**
 * The pairing URL as a scannable symbol, on stderr, under the URL.
 *
 * WHY THIS EXISTS. A headless host has no Settings window, and the device being paired is
 * usually a phone: the URL is a MagicDNS host plus a 43-character `kd_` token, which nobody
 * types. There is no Swift precedent for any of this (the shipped app has no phone UI at all),
 * so this rule is owner-directed, like the rest of the phone program.
 *
 * WHY STDERR. `pair` has the same stream discipline as `url`: stdout is EXACTLY the URL, so
 * `open "$(kelpid pair --name x --tailnet)"` works. The symbol is human framing, like the
 * "paired ..." and "Revoke any time with ..." lines already on stderr, and putting it on stdout
 * would break every caller that pipes this. Both streams are the terminal in the case that
 * matters and Node's writes to a TTY are synchronous, so it still appears under the URL.
 *
 * WHY TAILNET ONLY. Same rule the pair card follows (D2, `settings/RemoteTab.tsx`): without
 * `--tailnet` the daemon builds `http://127.0.0.1:<port>/?token=...`, which a phone cannot
 * reach whatever it does with the picture. The pairing still succeeds and the URL still prints;
 * only the symbol is withheld, with the reason.
 *
 * `qrText` carries the LIGHT modules in its glyphs, which is the right polarity on a dark
 * terminal and wrong on a light one, so `--qr-invert` exists. Nothing is coloured: the string
 * goes out as it comes back, because an escape sequence in the middle of a symbol is a run of
 * modules the camera reads as the wrong colour, and the terminal's own palette is not ours to
 * assume beyond dark-or-light.
 */
function writePairQr(io: CliIO, url: string, tailnet: boolean, invert: boolean): void {
    if (!tailnet) {
        io.err('(--qr drew nothing: this is a loopback URL, which a phone cannot reach. Add --tailnet.)');
        return;
    }
    io.err('');
    for (const line of qrText(encodeQr(url), { invert }).split('\n')) io.err(line);
    io.err('');
}

/**
 * `kelpid pair --name <who> [--tailnet] [--qr]`: mint a paired-device token and print the URL
 * that carries it. Multi-user remote access: every person/device gets its OWN token
 * (`lifecycle/devices.ts`), so revoking one (`kelpid devices revoke`) strands nobody else and
 * never rotates the run dir's owner token.
 *
 * Same stream discipline as `url`: stdout is exactly the URL. If the tailnet half fails
 * AFTER the mint, the fresh entry is DELETED again (safe: its token never left this process)
 * — a pairing either yields a working URL or leaves no residue in the registry.
 */
async function commandPair(
    io: CliIO,
    name: string | undefined,
    tailnet: boolean,
    qr: boolean,
    qrInvert: boolean
): Promise<number> {
    const env = io.env ?? process.env;
    if (name === undefined || name.trim().length === 0) {
        io.err('kelpid pair needs --name <who> — the person or device this token is for.');
        io.err('Usage: kelpid pair --name <who> [--tailnet] [--qr [--qr-invert]]');
        return 2;
    }
    const paths = runPathsFor(env);
    const probe = await probeDaemon(paths, { timeoutMs: 1000 });
    if (!probe.alive) {
        io.err(`kelpid is not running (${probe.reason ?? 'no socket'})`);
        io.err('Repair: start it with `kelpid start`, then run `kelpid pair` again.');
        return 1;
    }
    const record = readPidRecord(paths);
    const port = record?.http_port ?? readPortFile(paths);
    if (port === undefined) {
        io.err(`kelpid is running but ${paths.dir} has no HTTP port to build a URL from`);
        io.err('Repair: restart it (`kelpid stop` then `kelpid start`) so it rewrites the run dir.');
        return 1;
    }

    const devicesFile = resolveDevicesPath(env);
    let minted: ReturnType<typeof mintDevice>;
    try {
        minted = mintDevice(devicesFile, name);
    } catch (failure) {
        io.err(`kelpid pair: ${failure instanceof Error ? failure.message : String(failure)}`);
        return 1;
    }

    let url: string;
    if (tailnet) {
        const result = await resolveTailnetURL({ port, token: minted.token, run: io.tailscaleRunner });
        if (result.kind === 'error') {
            // Delete, not revoke: the token was never printed, so there is nothing to keep a
            // record of, and a revoked ghost per failed attempt would clutter `devices`.
            try {
                removeDevice(devicesFile, minted.device.id);
                io.err(`(the "${minted.device.name}" device was rolled back — nothing was paired)`);
            } catch (rollbackFailure) {
                io.err(
                    `Warning: could not roll back the just-minted "${minted.device.name}" entry — ` +
                        `remove it yourself: kelpid devices revoke ${minted.device.id} ` +
                        `(${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)})`
                );
            }
            io.err(result.message);
            if (result.repair !== undefined) io.err(`Repair: ${result.repair}`);
            return 1;
        }
        for (const note of result.notes) io.err(note);
        url = result.url;
    } else {
        url = clientURL(env, port, minted.token);
    }

    io.err(`paired "${minted.device.name}" (device ${minted.device.id})`);
    io.err(`The URL below carries this device's own token — send it to them, not to anyone else.`);
    io.err(`Revoke any time with: kelpid devices revoke ${minted.device.id}`);
    io.out(url);
    if (qr) writePairQr(io, url, tailnet, qrInvert);
    return 0;
}

/**
 * `kelpid devices [revoke <id-or-name>]` — the registry's management verbs. Reads and writes
 * `devices.json` directly (same-UID trust, like every run-dir file); the daemon notices on
 * the next hello.
 */
function commandDevices(io: CliIO, action: 'list' | 'revoke', target: string | undefined): number {
    const env = io.env ?? process.env;
    const file = resolveDevicesPath(env);
    try {
        if (action === 'revoke') {
            if (target === undefined) {
                io.err('kelpid devices revoke needs a device id or name (see `kelpid devices`).');
                io.err('Usage: kelpid devices revoke <id|name>');
                return 2;
            }
            const revoked = revokeDevice(file, target);
            if (revoked === null) {
                io.err(`no paired device matches "${target}" (see \`kelpid devices\`).`);
                return 1;
            }
            io.out(`revoked "${revoked.name}" (device ${revoked.id})`);
            io.err(
                'File (pane-asset) access is cut on its next request; the WS is refused at its next '
                    + 'connect, and any session it has open is cut within a moment (the daemon watches '
                    + 'the registry).'
            );
            return 0;
        }
        const devices = loadDevices(file);
        if (devices.length === 0) {
            io.err('no paired devices. Pair one with: kelpid pair --name <who>');
            return 0;
        }
        for (const device of devices) {
            const state = device.revokedAt === undefined ? 'live   ' : 'revoked';
            const dates = `paired ${device.createdAt}${device.revokedAt !== undefined ? `, revoked ${device.revokedAt}` : ''}`;
            io.out(`${device.id}  ${state}  ${device.name}  (${dates})`);
        }
        return 0;
    } catch (failure) {
        io.err(`kelpid devices: ${failure instanceof Error ? failure.message : String(failure)}`);
        return 1;
    }
}

/**
 * `kelpid import` — the one-time migration from the macOS app's database.
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
 * A daemon started with a different `KELPID_RUN_DIR` is invisible here — the same blind spot every
 * other verb has, and the reason `--to` a foreign path only warns.
 */
/**
 * The default `--from`. Two legacy generations can hold nex data, and the PORT daemon's
 * (`nexd/nex.db`) wins when it exists: whoever ran the pre-rename port already imported the
 * Swift database once, so the Swift file underneath is the stale copy. A machine that only
 * ever ran the Swift app falls through to its database; a machine with neither gets the Swift
 * path back so the failure names the canonical location. The reader handles both generations.
 */
export function defaultImportSource(env: NodeJS.ProcessEnv, home: string): string {
    const swift = legacyMacAppDatabasePath(home);
    const candidates = [nodePath.join(legacyDataDir({ env, home }), LEGACY_DATABASE_FILENAME), swift];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? swift;
}

/**
 * The config half of the import: copy `~/.config/nex/config` beside the data. Copy-only and
 * never over an existing file — a Kelpi config the user already edited wins.
 */
function importLegacyConfig(
    env: NodeJS.ProcessEnv,
    home: string,
    dryRun: boolean
): { action: 'copied' | 'would-copy' | 'target-exists' | 'no-source'; from: string; to: string } {
    const from = nodePath.join(home, '.config', 'nex', 'config');
    const to = resolveConfigPath({ env, home });
    if (!fs.existsSync(from)) return { action: 'no-source', from, to };
    if (fs.existsSync(to)) return { action: 'target-exists', from, to };
    if (dryRun) return { action: 'would-copy', from, to };
    fs.mkdirSync(nodePath.dirname(to), { recursive: true, mode: 0o700 });
    fs.copyFileSync(from, to);
    return { action: 'copied', from, to };
}

async function commandImport(io: CliIO, args: ParsedArgs): Promise<number> {
    const env = io.env ?? process.env;
    const home = env['HOME'] ?? homedir();
    const from = args.from === undefined ? defaultImportSource(env, home) : expandTilde(args.from, home);
    const to = args.to === undefined ? resolveDatabasePath({ env, home }) : expandTilde(args.to, home);

    // With --json stdout carries the report alone, so the announcement goes to stderr.
    const announce = args.json ? io.err : io.out;
    announce(`kelpid import${args.dryRun ? ' (dry run)' : ''}`);
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
                `kelpid is running (pid ${pid}) and owns ${to}`,
                'Stop it first — `kelpid stop`, then `kelpid import`, then `kelpid start`. --force does not override this: a running daemon holds the state in memory and would overwrite the import on its next save.'
            );
        }
        io.err(`Warning: kelpid is running (pid ${pid}), but ${to} is not the database it opened; importing anyway.`);
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

    const config = importLegacyConfig(env, home, args.dryRun === true);

    if (args.json) {
        io.out(JSON.stringify({ ok: true, ...report, config }));
        return 0;
    }

    io.out(
        `${report.dryRun ? 'would import' : 'imported'} ${String(report.workspaces)} workspace(s), ${String(report.panes)} pane(s), ${String(report.groups)} group(s), ${String(report.repos)} repo(s)`
    );
    if (report.resumable > 0) {
        io.out(`  agent session(s) to resume on the next start: ${String(report.resumable)}`);
    }
    if (report.backupPath !== null) io.out(`  backup: ${report.backupPath}`);
    switch (config.action) {
        case 'copied':
            io.out(`  config: copied ${config.from} -> ${config.to}`);
            break;
        case 'would-copy':
            io.out(`  config: would copy ${config.from} -> ${config.to}`);
            break;
        case 'target-exists':
            io.out(`  config: ${config.to} already exists — left alone`);
            break;
        case 'no-source':
            break; // nothing to bring over, nothing to say
    }
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
            : 'Next: `kelpid start` — panes are restored and agent sessions resume automatically.'
    );
    return 0;
}

function printInfo(io: CliIO, info: DaemonInfo): void {
    io.out(`kelpid running (pid ${String(info.pid)})`);
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
export async function runKelpid(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
    const args = parseKelpidArgs(argv);
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
            return commandUrl(io, args.tailnet);
        case 'pair':
            return commandPair(io, args.pairName, args.tailnet, args.qr, args.qrInvert);
        case 'devices':
            return commandDevices(io, args.deviceAction, args.deviceTarget);
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
    void runKelpid(process.argv.slice(2)).then(
        (code) => {
            if (code !== 0) process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`kelpid: ${error instanceof Error ? error.message : String(error)}\n`);
            process.exitCode = 1;
        }
    );
}
