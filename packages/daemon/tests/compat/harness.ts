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
 *   2. drive `nex` as a child process with `NEX_SOCKET=tcp:127.0.0.1:<port>`;
 *   3. assert the **exit code** and the **parsed JSON** — never the human table text, which
 *      is rendered CLI-side and is not part of the daemon's contract.
 *
 * NEVER point the harness at `/tmp/nex.sock`: the production Swift app owns it on this
 * machine. The daemon always gets `controlSocketPath` inside the test's tmp dir.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDaemon, type Daemon, type DaemonInfo } from '../../src/boot/index.js';

/** The shipped Swift CLI. Absent on a machine without Nex installed → the suites skip. */
export const NEX_CLI = process.env['NEX_COMPAT_CLI'] ?? '/Applications/Nex.app/Contents/Helpers/nex';

export function swiftCLIAvailable(): boolean {
    try {
        fs.accessSync(NEX_CLI, fs.constants.X_OK);
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
    /** Exported as `NEX_PANE_ID` — set it only when the case is about caller-pane scoping. */
    readonly paneID?: string | undefined;
    readonly cwd?: string | undefined;
    readonly env?: Record<string, string> | undefined;
    readonly timeoutMs?: number | undefined;
    /** Piped to the child's stdin — this is how `nex event` receives its hook payload. */
    readonly stdin?: string | undefined;
}

export interface CompatDaemon {
    readonly daemon: Daemon;
    readonly info: DaemonInfo;
    /** The control TCP port the CLI is pointed at. */
    readonly port: number;
    readonly home: string;
    readonly root: string;
    /** Run the Swift CLI against this daemon. */
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
export async function startCompatDaemon(): Promise<CompatDaemon> {
    const root = scratchRoot();
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });

    const daemon = createDaemon({
        env: {},
        home,
        runDir: path.join(root, 'run'),
        controlSocketPath: path.join(root, 'nex.sock'),
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
            const child = spawn(NEX_CLI, [...args], {
                cwd: options.cwd ?? home,
                env: {
                    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
                    HOME: home,
                    NEX_SOCKET: `tcp:127.0.0.1:${String(port)}`,
                    ...(options.paneID !== undefined ? { NEX_PANE_ID: options.paneID } : {}),
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
            // `nex event` reads stdin (the hook payload); an unclosed stdin would hang it.
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
                    `nex ${args.join(' ')} exited ${String(result.code)}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
                );
            }
            try {
                return JSON.parse(result.stdout) as T;
            } catch (error) {
                throw new Error(
                    `nex ${args.join(' ')} printed non-JSON: ${JSON.stringify(result.stdout)} (${String(error)})`
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
