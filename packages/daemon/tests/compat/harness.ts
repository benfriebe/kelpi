/**
 * WP2.9 — the compat harness.
 *
 * These tests are the only place in the repo where the contract is checked against the thing
 * that actually ships: the **real Swift `nex` binary** from `/Applications/Nex.app`. Everything
 * else (unit tests, `boot/integration.test.ts`) tests our reading of `wire-protocol.md` /
 * `socket-handlers.md`; this tests the reading against the shipped client.
 *
 * Shape of a compat test:
 *   1. boot a daemon in-process with its own tmp HOME, tmp sqlite file and an **ephemeral**
 *      control TCP port (`tcpPort: 0`) plus a tmp unix socket path;
 *   2. drive the CLI as a child process with KELPI_SOCKET/NEX_SOCKET=tcp:127.0.0.1:<port>
 *      (our kelpi reads the former, the shipped Swift nex the latter);
 *   3. assert the **exit code** and the **parsed JSON** — never the human table text, which
 *      is rendered CLI-side and is not part of the daemon's contract.
 *
 * NEVER point the harness at `/tmp/nex.sock`: the production Swift app owns it on this
 * machine. The daemon always gets `controlSocketPath` inside the test's tmp dir.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { WebSocket } from 'ws';

import { createDaemon, type Daemon, type DaemonInfo } from '../../src/boot/index.js';
import { readToken } from '../../src/lifecycle/index.js';

/** The shipped Swift CLI. Absent on a machine without Kelpi installed → the suites skip. */
export const KELPI_CLI = process.env['KELPI_COMPAT_CLI'] ?? '/Applications/Nex.app/Contents/Helpers/nex';

const CLI_BUNDLER = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', 'cli', 'scripts', 'bundle.mjs'
);

/**
 * Bundle THIS repo's `kelpi` CLI into `dir` and return the executable's path.
 *
 * For verbs the shipped Swift binary never had (`workspace rename`, #266), the compat question
 * is "does our CLI agree with our daemon", so those cases run this bundle whatever
 * `KELPI_COMPAT_CLI` says. It is a private copy, built fresh: `dist/kelpi.js` may be stale, and
 * the CLI's own integration suite rewrites it while other files are running.
 */
export function bundleKelpiCLI(dir: string): Promise<string> {
    const outfile = path.join(dir, 'kelpi.js');
    return new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [CLI_BUNDLER, '--outfile', outfile], (error) => {
            if (error !== null) reject(error);
            else resolve(outfile);
        });
    });
}

export function swiftCLIAvailable(): boolean {
    try {
        fs.accessSync(KELPI_CLI, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export interface CliResult {
    readonly code: number;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
}

export interface CliOptions {
    /** Exported as `KELPI_PANE_ID` + `NEX_PANE_ID`, set it only when the case is about caller-pane scoping. */
    readonly paneID?: string | undefined;
    readonly cwd?: string | undefined;
    readonly env?: Record<string, string> | undefined;
    readonly timeoutMs?: number | undefined;
    /** Piped to the child's stdin — this is how `kelpi event` receives its hook payload. */
    readonly stdin?: string | undefined;
}

export interface CompatDaemonOptions {
    /** The CLI executable to drive; defaults to `KELPI_CLI`. */
    readonly cli?: string | undefined;
}

export interface CompatDaemon {
    readonly daemon: Daemon;
    readonly info: DaemonInfo;
    /** The control TCP port the CLI is pointed at. */
    readonly port: number;
    readonly home: string;
    readonly root: string;
    /** Run the CLI (the Swift one unless `cli` said otherwise) against this daemon. */
    run(args: readonly string[], options?: CliOptions): Promise<CliResult>;
    /** Run + require exit 0 + JSON.parse stdout. */
    json<T = unknown>(args: readonly string[], options?: CliOptions): Promise<T>;
    stop(): Promise<void>;
}

function scratchRoot(): string {
    // Short prefix: a unix socket path is capped near 104 bytes on macOS.
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nexc-'));
}

/**
 * Boot a daemon wired for the compat suite. `settleMs: 0` skips the resume settle (there is
 * nothing to resume in a fresh DB) and `/bin/sh` keeps the shell deterministic — a user's
 * zsh with a fancy prompt makes `pane capture` assertions flaky.
 */
export async function startCompatDaemon(compat: CompatDaemonOptions = {}): Promise<CompatDaemon> {
    const cli = compat.cli ?? KELPI_CLI;
    const root = scratchRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });

    const daemon = createDaemon({
        env: {},
        home,
        runDir: path.join(root, 'run'),
        controlSocketPath: path.join(root, 'kelpi.sock'),
        tcpPort: 0,
        dbPath: path.join(root, 'nex.db'),
        configPath: path.join(root, 'config'),
        httpPort: 0,
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' }
    });

    const info = await daemon.start();
    const port = info.tcpPort;
    if (port === undefined) {
        await daemon.stop();
        fs.rmSync(root, { recursive: true, force: true });
        throw new Error('compat daemon started without a control TCP listener');
    }

    const run = (args: readonly string[], options: CliOptions = {}): Promise<CliResult> =>
        new Promise<CliResult>((resolve, reject) => {
            const child = spawn(cli, [...args], {
                cwd: options.cwd ?? home,
                env: {
                    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
                    HOME: home,
                    KELPI_SOCKET: `tcp:127.0.0.1:${String(port)}`,
                    NEX_SOCKET: `tcp:127.0.0.1:${String(port)}`,
                    // Our CLI then refuses to fall back to `/tmp/kelpi.sock` (the user's live Kelpi)
                    // when this daemon is unreachable; the Swift binary ignores it.
                    KELPI_REQUIRE_SOCKET: '1',
                    // Both spellings, like the socket pair above: the Swift nex reads NEX_PANE_ID,
                    // a KELPI_COMPAT_CLI pointed at our own bundle reads KELPI_PANE_ID (#46).
                    ...(options.paneID !== undefined
                        ? { KELPI_PANE_ID: options.paneID, NEX_PANE_ID: options.paneID }
                        : {}),
                    ...options.env
                },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            // `kelpi event` reads stdin (the hook payload); an unclosed stdin would hang it.
            // Most verbs never read it, so a fast CLI can exit before the write lands and the
            // pipe closes under us. EPIPE there says "the child was done", not "the test
            // failed" — unhandled it becomes an uncaught exception that fails whichever file
            // happens to be running.
            child.stdin.on('error', () => {});
            child.stdin.end(options.stdin ?? '');
            const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', (code, signal) => {
                clearTimeout(timer);
                resolve({ code: code ?? -1, signal, stdout, stderr });
            });
        });

    return {
        daemon,
        info,
        port,
        home,
        root,
        run,
        async json<T = unknown>(args: readonly string[], options: CliOptions = {}): Promise<T> {
            const result = await run(args, options);
            if (result.code !== 0) {
                throw new Error(
                    `kelpi ${args.join(' ')} exited ${String(result.code)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
                );
            }
            try {
                return JSON.parse(result.stdout) as T;
            } catch (error) {
                throw new Error(
                    `kelpi ${args.join(' ')} printed non-JSON: ${JSON.stringify(result.stdout)} (${String(error)})`
                );
            }
        },
        async stop() {
            await daemon.stop();
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

/** Poll until `predicate` holds (or the deadline passes); returns the last value either way. */
export async function eventually<T>(
    fn: () => Promise<T>,
    predicate: (value: T) => boolean,
    timeoutMs = 10_000
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last = await fn();
    while (!predicate(last)) {
        if (Date.now() > deadline) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
        last = await fn();
    }
    return last;
}

// ── talking to the daemon without a CLI ─────────────────────────────────────────────────

/** A decoded control reply or WebSocket message. */
export type Message = Record<string, unknown>;

/** The events of a WebSocket `delta` message; none for any other message. */
export function deltaEvents(message: Message): Message[] {
    if (message['type'] !== 'delta' || !Array.isArray(message['events'])) return [];
    return message['events'] as Message[];
}

/** One control line over TCP, one reply line back: what the CLI does, minus the CLI. */
export function rawRequest(port: number, message: Message): Promise<Message> {
    return new Promise<Message>((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let pending = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error('timed out waiting for a reply'));
        }, 10_000);
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
            pending += chunk;
            const index = pending.indexOf('\n');
            if (index < 0) return;
            clearTimeout(timer);
            socket.destroy();
            resolve(JSON.parse(pending.slice(0, index)) as Message);
        });
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

export interface WindowSession {
    waitFor(predicate: (message: Message) => boolean): Promise<Message>;
    close(): void;
}

/** A WebSocket session with the owner's token, past `welcome`, the way a window attaches. */
export async function connectWindow(kelpi: CompatDaemon): Promise<WindowSession> {
    const token = readToken(kelpi.daemon.paths) ?? '';
    const socket = new WebSocket(`ws://127.0.0.1:${String(kelpi.info.httpPort)}/ws?token=${token}`);
    const seen: Message[] = [];
    const waiters: { predicate: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
    socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as Message;
        seen.push(message);
        for (const waiter of [...waiters]) {
            if (!waiter.predicate(message)) continue;
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
        }
    });
    const waitFor = (predicate: (message: Message) => boolean): Promise<Message> =>
        new Promise<Message>((resolve, reject) => {
            const hit = seen.find(predicate);
            if (hit !== undefined) {
                resolve(hit);
                return;
            }
            const timer = setTimeout(() => reject(new Error('timed out waiting for a WebSocket message')), 10_000);
            waiters.push({
                predicate,
                resolve: (message) => {
                    clearTimeout(timer);
                    resolve(message);
                }
            });
        });
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token }));
    await waitFor((message) => message['type'] === 'snapshot');
    return { waitFor, close: () => socket.close() };
}

// ── shapes the CLI's `--json` output is asserted against ────────────────────────────────

export interface PaneListEntryJSON {
    readonly id: string;
    readonly type: string;
    readonly workspace_id: string;
    readonly workspace_name: string;
    readonly working_directory: string;
    readonly status: string;
    readonly is_focused: boolean;
    readonly is_active_workspace: boolean;
    readonly created_at: string;
    readonly last_activity_at?: string;
    readonly label?: string;
    readonly title?: string;
    readonly file_path?: string;
    readonly git_branch?: string;
    readonly agent_session_id?: string;
    readonly agent?: string;
    readonly background_tasks?: number;
    readonly group_id?: string;
    readonly group_name?: string;
}

export interface WorkspaceListEntryJSON {
    readonly id: string;
    readonly name: string;
    readonly color?: string;
    readonly pane_count: number;
    readonly is_active: boolean;
    readonly created_at: string;
    readonly last_accessed_at: string;
    readonly labels: readonly string[];
    readonly icon?: string;
    readonly last_activity_at?: string;
    readonly agent_session_id?: string;
    readonly group_id?: string;
    readonly group_name?: string;
}

export interface GroupListEntryJSON {
    readonly id: string;
    readonly name: string;
    readonly color?: string;
    readonly workspaces: readonly { readonly id: string; readonly name: string }[];
}
