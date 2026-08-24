/**
 * A throwaway full stack for the audit: a private daemon, a private shell, a private CLI.
 *
 * Isolation is non-negotiable — a developer machine is running the real Nex (and, right now,
 * the user's own dev stack on 19733/19734/9223 and /tmp/nexd-dev*). Every path lives under a
 * fresh `mkdtemp`, the control socket is `<tmp>/nexd.sock` and never `/tmp/nex.sock`, ports are
 * ephemeral and explicitly re-drawn if they collide with the reserved dev ports, and Electron
 * gets its own `--user-data-dir`. The pattern is lifted from
 * `packages/shell/scripts/web-smoke.mjs`, which has the same constraints.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PROTOCOL_VERSION = 1;

/** The user's own dev stack. The audit must never bind or connect to these. */
export const RESERVED_PORTS = new Set([19733, 19734, 9223, 19400]);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const raceTimeout = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref?.();
    });

export async function freePort() {
    for (let attempt = 0; attempt < 40; attempt++) {
        const port = await new Promise((resolve, reject) => {
            const server = net.createServer();
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const { port: chosen } = server.address();
                server.close(() => resolve(chosen));
            });
        });
        if (!RESERVED_PORTS.has(port)) return port;
    }
    throw new Error('could not find a free non-reserved port');
}

export async function waitFor(label, predicate, timeoutMs = 30_000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value !== undefined && value !== null && value !== false) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

export function run(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
}

function signalGroup(child, signal) {
    try {
        process.kill(-child.pid, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // already gone
        }
    }
}

function releaseChild(child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
}

// ── builds ──────────────────────────────────────────────────────────────────────────

/**
 * Rebuild every bundle the audit drives, from source, at the moment the run starts.
 *
 * This is what makes the harness safe to re-run while other agents are editing the tree: the
 * screenshots always describe the working copy as it is right now, never a stale `dist/`.
 */
export async function buildAll(repoRoot, { log = () => {} } = {}) {
    const steps = [
        ['daemon', ['pnpm', ['--filter', '@nex/daemon', 'build'], { cwd: repoRoot }]],
        ['cli', ['pnpm', ['--filter', '@nex/cli', 'build'], { cwd: repoRoot }]],
        ['client', ['pnpm', ['--filter', '@nex/client', 'build'], { cwd: repoRoot }]],
        ['shell', ['node', [path.join(repoRoot, 'packages', 'shell', 'scripts', 'bundle.mjs')], { cwd: path.join(repoRoot, 'packages', 'shell') }]]
    ];
    const built = {};
    for (const [name, [command, args, opts]] of steps) {
        log(`building ${name}…`);
        const result = await run(command, args, opts);
        if (result.code !== 0) {
            throw new Error(`${name} build failed (exit ${String(result.code)}):\n${result.stdout}${result.stderr}`);
        }
        built[name] = true;
    }
    return built;
}

// ── sandbox ─────────────────────────────────────────────────────────────────────────

export async function makeSandbox(repoRoot, { label = 'audit', clientDir } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexaudit-${label}-`));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    const work = path.join(root, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(work, { recursive: true });

    const socketPath = path.join(root, 'nexd.sock');
    if (socketPath === '/tmp/nex.sock' || socketPath.startsWith('/tmp/nexd-dev')) {
        throw new Error('refusing to touch a non-sandbox socket path');
    }

    const configPath = path.join(root, 'config');
    fs.writeFileSync(configPath, '');

    // The GHOSTTY config the daemon parses for the terminal palette and now WRITES for
    // Settings ▸ Appearance (SET-039…041). Pinned explicitly rather than left to resolve under
    // the sandbox HOME, so an appearance step can read the exact file the daemon touched and a
    // stray resolution change can never point it at the developer's own.
    const ghosttyConfigPath = path.join(root, 'ghostty-config');
    // `NEX_AUDIT_GHOSTTY_EXTRA` seeds extra lines BEFORE the shell starts. It exists for the
    // one setting the shell can only act on at window creation: `background-opacity` decides
    // whether the BrowserWindow is transparent (APP-012 / SET-049), and no in-run gesture can
    // change that. Unset (the default) this is a no-op and the sandbox is byte-identical.
    const extraGhostty = process.env['NEX_AUDIT_GHOSTTY_EXTRA'] ?? '';
    fs.writeFileSync(
        ghosttyConfigPath,
        `# audit sandbox ghostty config\nbackground = #0a0a0c\n${extraGhostty === '' ? '' : `${extraGhostty}\n`}`
    );

    const httpPort = await freePort();
    const controlPort = await freePort();
    const debugPort = await freePort();

    // What the packaged app stages at Resources/cli and hands over as NEXD_HELPERS_DIR: a
    // `nex` the daemon prepends to every pane's PATH. With it, a bare `nex event …` typed (or
    // hook-fired) INSIDE a sandbox pane resolves this repo's CLI and routes via the pane's
    // injected NEX_SOCKET — the same chain a real install's Claude Code hooks take. Without
    // it, in-pane `nex` resolution falls to the audit machine's own PATH (often the Swift
    // app's helper), which is exactly the ambiguity the routing fix exists to remove.
    const helpersDir = path.join(root, 'helpers');
    fs.mkdirSync(helpersDir, { recursive: true });
    fs.writeFileSync(
        path.join(helpersDir, 'nex'),
        `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, 'packages', 'cli', 'dist', 'nex.js')}" "$@"\n`,
        { mode: 0o755 }
    );

    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NEXD_RUN_DIR: path.join(root, 'run'),
        NEXD_SOCKET_PATH: socketPath,
        NEXD_TCP_PORT: String(controlPort),
        NEXD_DB_PATH: path.join(root, 'nex.db'),
        NEXD_CONFIG_PATH: configPath,
        NEXD_GHOSTTY_CONFIG: ghosttyConfigPath,
        NEXD_HTTP_PORT: String(httpPort),
        NEXD_HTTP_HOST: '127.0.0.1',
        NEXD_ENTRY: path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js'),
        NEXD_HELPERS_DIR: helpersDir,
        // Harness marker: a shell/daemon that sees this exits when its stdout pipe dies,
        // instead of orphaning a window when the harness (or a probe script) is hard-killed.
        NEX_HARNESS: '1',
        ...(clientDir === undefined ? {} : { NEXD_CLIENT_DIR: clientDir })
    };

    return {
        root,
        home,
        work,
        env,
        userData,
        configPath,
        ghosttyConfigPath,
        socketPath,
        helpersDir,
        httpPort,
        controlPort,
        debugPort,
        runDir: env.NEXD_RUN_DIR,
        base: `http://127.0.0.1:${String(httpPort)}`,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

// ── daemon ──────────────────────────────────────────────────────────────────────────

export function startDaemon(sandbox, { repoRoot, verbose = false }) {
    const entry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js');
    const lines = [];
    const child = spawn(process.execPath, [entry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk) => {
        lines.push(chunk);
        if (verbose) process.stderr.write(`[daemon] ${chunk}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exited = false;
    child.on('exit', () => (exited = true));

    return {
        child,
        text: () => lines.join(''),
        get exited() {
            return exited;
        },
        async stop() {
            if (exited) {
                releaseChild(child);
                return;
            }
            child.kill('SIGTERM');
            await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(8000)]);
            if (!exited) child.kill('SIGKILL');
            releaseChild(child);
        }
    };
}

export async function waitForHealthz(base, timeoutMs = 30_000) {
    return await waitFor(
        `${base}/healthz`,
        async () => {
            try {
                const response = await fetch(`${base}/healthz`);
                return response.ok;
            } catch {
                return false;
            }
        },
        timeoutMs
    );
}

// ── shell ───────────────────────────────────────────────────────────────────────────

function electronBinary(repoRoot) {
    for (const candidate of [
        path.join(repoRoot, 'packages', 'shell', 'node_modules', '.bin', 'electron'),
        path.join(repoRoot, 'node_modules', '.bin', 'electron')
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('electron is not installed (run pnpm install)');
}

export function packagedBinary(repoRoot) {
    return path.join(
        repoRoot,
        'packages',
        'shell',
        'out',
        `Nex-darwin-${process.arch}`,
        'Nex.app',
        'Contents',
        'MacOS',
        'Nex'
    );
}

/**
 * Launch the shell with a remote-debugging port.
 *
 * `packaged: true` runs the real `Nex.app` binary (what a user double-clicks); the default runs
 * `electron .` against `packages/shell/dist/main.js`, which is the same main process with a
 * fresh bundle and no 90-second repackage between runs.
 */
export function startShell(sandbox, { repoRoot, packaged = false, verbose = false, extraEnv = {} }) {
    const shellRoot = path.join(repoRoot, 'packages', 'shell');
    const binary = packaged ? packagedBinary(repoRoot) : electronBinary(repoRoot);
    if (packaged && !fs.existsSync(binary)) {
        throw new Error(`packaged app is missing: ${binary} (run pnpm --filter @nex/shell package)`);
    }
    const args = packaged ? [] : ['.'];
    args.push(`--user-data-dir=${sandbox.userData}`, `--remote-debugging-port=${String(sandbox.debugPort)}`);

    const lines = [];
    const child = spawn(binary, args, {
        cwd: packaged ? sandbox.home : shellRoot,
        env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    const collect = (chunk) => {
        if (verbose) process.stderr.write(`[shell] ${chunk}`);
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) lines.push(line);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exited = false;
    let exitCode = null;
    child.on('exit', (code, signal) => {
        exited = true;
        exitCode = code ?? (signal === null ? null : -1);
    });

    return {
        child,
        lines,
        get exited() {
            return exited;
        },
        get exitCode() {
            return exitCode;
        },
        text: () => lines.join('\n'),
        waitForLine: (pattern, label, timeoutMs = 45_000) =>
            waitFor(
                label,
                () => {
                    if (exited) throw new Error(`the shell exited (code ${String(exitCode)}) before ${label}`);
                    return lines.find((line) => pattern.test(line));
                },
                timeoutMs
            ),
        async quit(signal = 'SIGTERM') {
            if (!exited) {
                if (signal === 'SIGTERM') child.kill('SIGTERM');
                else signalGroup(child, signal);
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(15_000)]);
            }
            signalGroup(child, 'SIGKILL');
            await sleep(200);
            releaseChild(child);
        }
    };
}

// ── the CLI, pointed at the sandbox daemon ──────────────────────────────────────────

/**
 * The ported TypeScript CLI (`packages/cli/dist/nex.js`) over TCP.
 *
 * TCP rather than the unix socket because `NEX_SOCKET` only overrides the *TCP* transport —
 * the unix path is hardcoded to `/tmp/nex.sock`, which is exactly the file the audit must not
 * touch.
 */
export function makeCli(sandbox, { repoRoot }) {
    const entry = path.join(repoRoot, 'packages', 'cli', 'dist', 'nex.js');
    const invoke = (args, opts = {}) =>
        new Promise((resolve) => {
            const child = spawn(process.execPath, [entry, ...args], {
                cwd: opts.cwd ?? sandbox.home,
                env: {
                    PATH: sandbox.env.PATH,
                    HOME: sandbox.home,
                    NEX_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`,
                    NEX_REPLY_TIMEOUT: '30',
                    ...(opts.paneID === undefined ? {} : { NEX_PANE_ID: opts.paneID }),
                    ...opts.env
                },
                stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
            });
            // `nex event` reads its hook payload (session_id, background_tasks) from stdin, so
            // an agent-lifecycle flow has to be able to hand it one.
            if (opts.stdin !== undefined) {
                child.stdin.end(opts.stdin);
            }
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error), args }));
            child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, args }));
            const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 45_000);
            timer.unref();
            child.on('close', () => clearTimeout(timer));
        });

    const logged = async (args, opts) => {
        const result = await invoke(args, opts);
        // Every CLI invocation, when the audit asks for it: the run-O leak hunt needed to map
        // two orphan panes to the call that made them, and nothing had recorded the calls.
        const logPath = process.env.NEX_AUDIT_CLI_LOG;
        if (logPath !== undefined && logPath !== '') {
            try {
                fs.appendFileSync(
                    logPath,
                    `${JSON.stringify({ t: new Date().toISOString(), args, code: result.code, out: result.stdout.slice(0, 300) })}\n`
                );
            } catch {
                // best-effort
            }
        }
        return result;
    };
    return {
        run: logged,
        /** Run + require exit 0; returns stdout. */
        async ok(args, opts = {}) {
            const result = await logged(args, opts);
            if (result.code !== 0) {
                throw new Error(`nex ${args.join(' ')} exited ${String(result.code)}\n${result.stdout}${result.stderr}`);
            }
            return result.stdout;
        },
        /** Run + require exit 0 + parse the JSON it printed. */
        async json(args, opts = {}) {
            const stdout = await this.ok(args, opts);
            try {
                return JSON.parse(stdout);
            } catch {
                throw new Error(`nex ${args.join(' ')} did not print JSON:\n${stdout}`);
            }
        }
    };
}
