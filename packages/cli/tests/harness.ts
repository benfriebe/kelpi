/**
 * Integration harness: the REAL bundled `dist/kelpi.js` driven as a child process against a fake
 * control server.
 *
 * The unit tests cover the pure halves (parsing, routing, renderers); this drives the binary a
 * user actually runs, so it is the only place that can prove the process-level contract —
 * exit codes, which stream each line lands on, that stdout is not truncated on exit, and the
 * exact bytes that reach the socket.
 *
 * The fake server is TCP on an ephemeral port, reached through `KELPI_SOCKET`. **Never
 * `/tmp/nex.sock`**: that path is hardcoded in the CLI and belongs to whatever Kelpi is running
 * on the developer's machine, so a test that used it would talk to the user's real app.
 * The child's environment is built from scratch for the same reason — inheriting a real
 * `KELPI_PANE_ID` would silently change what several commands do.
 */

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_BUNDLE = path.join(packageRoot, 'dist', 'kelpi.js');

let buildPromise: Promise<void> | null = null;

/** Build the bundle once per test run (esbuild is a devDependency of this package). */
export async function buildCLI(): Promise<void> {
    buildPromise ??= new Promise<void>((resolve, reject) => {
        execFile(
            process.execPath,
            [path.join(packageRoot, 'scripts', 'bundle.mjs')],
            { cwd: packageRoot },
            (error) => {
                if (error !== null) reject(error);
                else resolve();
            }
        );
    });
    return buildPromise;
}

export interface ServerReply {
    /** JSON objects to write, one per line. */
    readonly lines?: readonly object[];
    /** Keep the connection open after writing (the `--follow` stream). */
    readonly keepOpen?: boolean;
    /** Write nothing at all and close — the "old Kelpi" empty-reply path. */
    readonly silent?: boolean;
}

export interface FakeServer {
    readonly port: number;
    /** Every JSON line the CLI has sent, in order. */
    readonly requests: Record<string, unknown>[];
    /** Sockets still open (a `--follow` stream holds one). */
    readonly open: net.Socket[];
    respond(responder: (request: Record<string, unknown>) => ServerReply): void;
    /** Push an extra line down the newest open connection (streams). */
    push(line: object): void;
    close(): Promise<void>;
}

export async function startFakeServer(): Promise<FakeServer> {
    const requests: Record<string, unknown>[] = [];
    const open: net.Socket[] = [];
    let responder: (request: Record<string, unknown>) => ServerReply = () => ({ lines: [{ ok: true }] });

    const server = net.createServer((socket) => {
        open.push(socket);
        let pending = '';
        socket.on('data', (chunk: Buffer) => {
            pending += chunk.toString('utf8');
            for (;;) {
                const index = pending.indexOf('\n');
                if (index < 0) break;
                const raw = pending.slice(0, index);
                pending = pending.slice(index + 1);
                if (raw.trim().length === 0) continue;
                const request = JSON.parse(raw) as Record<string, unknown>;
                requests.push(request);
                const reply = responder(request);
                if (reply.silent === true) {
                    socket.end();
                    continue;
                }
                for (const line of reply.lines ?? []) socket.write(`${JSON.stringify(line)}\n`);
                if (reply.keepOpen !== true) socket.end();
            }
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
            const index = open.indexOf(socket);
            if (index >= 0) open.splice(index, 1);
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('fake server did not bind a TCP port');

    return {
        port: address.port,
        requests,
        open,
        respond(next) {
            responder = next;
        },
        push(line) {
            const socket = open[open.length - 1];
            socket?.write(`${JSON.stringify(line)}\n`);
        },
        async close() {
            for (const socket of [...open]) socket.destroy();
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        }
    };
}

/** A TCP port nothing is listening on — for the transport-failure cases. */
export async function deadPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const { port } = address;
    await new Promise<void>((resolve) => {
        server.close(() => {
            resolve();
        });
    });
    return port;
}

export interface RunOptions {
    readonly port?: number | undefined;
    readonly paneID?: string | undefined;
    readonly env?: Record<string, string> | undefined;
    readonly cwd?: string | undefined;
    readonly stdin?: string | undefined;
    readonly timeoutMs?: number | undefined;
    /** Exec the bundle directly (shebang + mode 0755) instead of `node dist/kelpi.js`. */
    readonly direct?: boolean | undefined;
    /** Deliver SIGINT this long after spawn — the `--follow` Ctrl-C path. */
    readonly sigintAfterMs?: number | undefined;
}

export interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export function scratchHome(): string {
    // realpath: on macOS `/var` is a symlink to `/private/var`, and a child process reports the
    // RESOLVED cwd — which is what the CLI puts in `repo_path` / `path` payload fields.
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexcli-')));
}

/** Run the bundled CLI with a from-scratch environment. */
export async function runCLI(args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    await buildCLI();
    const home = options.cwd ?? scratchHome();
    const env: Record<string, string> = {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        HOME: home,
        ...(options.port !== undefined ? { KELPI_SOCKET: `tcp:127.0.0.1:${String(options.port)}` } : {}),
        ...(options.paneID !== undefined ? { KELPI_PANE_ID: options.paneID } : {}),
        ...options.env
    };
    const command = options.direct === true ? CLI_BUNDLE : process.execPath;
    const argv = options.direct === true ? [...args] : [CLI_BUNDLE, ...args];

    return new Promise<RunResult>((resolve, reject) => {
        const child = spawn(command, argv, { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] });
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
        child.stdin.on('error', () => undefined);
        child.stdin.end(options.stdin ?? '');
        const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 20_000);
        const interrupt =
            options.sigintAfterMs === undefined
                ? undefined
                : setTimeout(() => child.kill('SIGINT'), options.sigintAfterMs);
        child.on('error', (error) => {
            clearTimeout(timer);
            if (interrupt !== undefined) clearTimeout(interrupt);
            reject(error);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (interrupt !== undefined) clearTimeout(interrupt);
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}
