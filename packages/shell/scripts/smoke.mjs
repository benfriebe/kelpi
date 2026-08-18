#!/usr/bin/env node
/**
 * Live smoke test for the Electron shell (M4's acceptance gate).
 *
 * The unit tests cover the pure halves (bounds clamp, badge derivation, hotkey parse); this
 * proves the parts that only exist in a real Electron process talking to a real daemon:
 *
 *   1. the shell ADOPTS a daemon that is already running (discover, not spawn);
 *   2. the window actually loads the daemon's URL (`did-finish-load`);
 *   3. the MAIN process's own status WebSocket completes the handshake and receives a state
 *      snapshot (that is what drives the dock badge and the tray);
 *   4. **quitting the app leaves the daemon running** — the single most important rule in the
 *      architecture, asserted by pinging the daemon after Electron has exited;
 *   5. with no daemon running, the shell SPAWNS one, detached, and it survives the shell.
 *
 * Isolation rules (non-negotiable — the production Swift app owns the real socket on a dev
 * machine): every path is inside a fresh `mkdtemp` directory, the control socket is
 * `<tmp>/nexd.sock` and NEVER `/tmp/nex.sock`, the run dir / DB / config / HOME are throwaway,
 * and Electron gets its own `--user-data-dir` so it cannot collide with (or steal the
 * single-instance lock from) a real Nex shell.
 *
 *   node packages/shell/scripts/smoke.mjs [--no-build] [--verbose] [--keep-logs]
 *
 *     --no-build   trust the existing dist/ output instead of rebuilding daemon + shell
 *     --verbose    stream the daemon and Electron output to stderr as it runs
 *     --keep-logs  print the captured Electron stdout at the end even when everything passed
 *
 * Exit code 0 = every check passed. Any failure prints the captured logs and exits 1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js');
const shellEntry = path.join(shellRoot, 'dist', 'main.js');
const clientDist = path.join(repoRoot, 'packages', 'client', 'dist');
const PROTOCOL_VERSION = 1;

const argv = new Set(process.argv.slice(2));
const options = {
    build: !argv.has('--no-build'),
    verbose: argv.has('--verbose'),
    keepLogs: argv.has('--keep-logs')
};

// ── tiny test harness ───────────────────────────────────────────────────────────────

const results = [];

function pass(name, detail = '') {
    results.push({ name, ok: true, detail });
    process.stdout.write(`  ✓ ${name}${detail === '' ? '' : `  ${detail}`}\n`);
}

function fail(name, detail) {
    results.push({ name, ok: false, detail });
    process.stdout.write(`  ✗ ${name}\n      ${detail}\n`);
}

function check(name, condition, detail = '') {
    if (condition) pass(name, detail);
    else fail(name, detail === '' ? 'assertion failed' : detail);
    return condition;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A deadline that never keeps the process alive on its own — used in `Promise.race` against a
 * child's exit, where the timer is the loser 99% of the time and would otherwise hold the
 * event loop open for its full duration after the run is done.
 */
const raceTimeout = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });

/**
 * Let go of a child completely: killing Electron leaves its helper processes holding the
 * inherited stdio pipes for a moment, and an open pipe keeps OUR event loop alive.
 */
function releaseChild(child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
}

/**
 * Signal a child's whole process GROUP.
 *
 * Electron is a process tree — GPU and renderer helpers are separate processes — and killing
 * only the main process (which is what happens when a dialog is open and the app refuses to
 * exit) orphans them. The shell children are therefore spawned `detached`, into their own
 * group, so the smoke can sweep the entire tree.
 */
function signalGroup(child, signal) {
    try {
        process.kill(-child.pid, signal);
    } catch {
        try {
            child.kill(signal);
        } catch {
            // Already gone.
        }
    }
}

async function waitFor(label, predicate, timeoutMs = 20_000, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

function run(command, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: opts.cwd ?? repoRoot, env: { ...process.env, ...opts.env } });
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

async function freePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * One newline-JSON command over a unix control socket — the same protocol the `nex` CLI
 * speaks. Always the sandbox's RUN-DIR socket, never `/tmp/nex.sock`.
 */
function controlCommand(socketPath, payload, expectReply = true, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const socket = net.connect({ path: socketPath });
        let buffer = '';
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        socket.on('connect', () => {
            socket.write(`${JSON.stringify(payload)}\n`, () => {
                if (!expectReply) finish({ ok: true });
            });
        });
        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (!buffer.includes('\n')) return;
            try {
                finish(JSON.parse(buffer.split('\n')[0]));
            } catch {
                finish(null);
            }
        });
        socket.on('error', () => finish(null));
        socket.on('close', () => finish(null));
    });
}

const controlPing = (socketPath) => controlCommand(socketPath, { command: 'ping' });

// ── builds ──────────────────────────────────────────────────────────────────────────

async function ensureBuilds() {
    if (options.build || !fs.existsSync(daemonEntry)) {
        process.stdout.write('building the daemon bundle…\n');
        const result = await run('pnpm', ['--filter', '@nex/daemon', 'build']);
        if (result.code !== 0) throw new Error(`daemon build failed:\n${result.stdout}${result.stderr}`);
    }
    if (options.build || !fs.existsSync(shellEntry)) {
        process.stdout.write('building the shell bundle…\n');
        const result = await run('node', [path.join(shellRoot, 'scripts', 'bundle.mjs')], { cwd: shellRoot });
        if (result.code !== 0) throw new Error(`shell build failed:\n${result.stdout}${result.stderr}`);
    }
}

// ── throwaway environment ───────────────────────────────────────────────────────────

/**
 * Every path the daemon and the shell touch, inside one temp directory. `NEXD_SOCKET_PATH`
 * is asserted to not be the production socket — a bug here would reach the user's real app.
 */
async function makeSandbox(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexshell-${label}-`));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    const socketPath = path.join(root, 'nexd.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const configPath = path.join(root, 'config');
    // A hotkey the shell will try to register: unusual enough not to fight a real app.
    fs.writeFileSync(configPath, 'global-hotkey = ctrl+alt+shift+f12\nglobal-hotkey-hide-on-repress = true\n');

    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NEXD_RUN_DIR: path.join(root, 'run'),
        NEXD_SOCKET_PATH: socketPath,
        NEXD_TCP_PORT: String(await freePort()),
        NEXD_DB_PATH: path.join(root, 'nex.db'),
        NEXD_CONFIG_PATH: configPath,
        NEXD_HTTP_PORT: String(await freePort()),
        NEXD_HTTP_HOST: '127.0.0.1',
        NEXD_ENTRY: daemonEntry,
        // Point the daemon at the built client when there is one; the daemon serves its own
        // "client not built" page otherwise, which still exercises window loading.
        ...(fs.existsSync(path.join(clientDist, 'index.html')) ? { NEXD_CLIENT_DIR: clientDist } : {})
    };

    return {
        root,
        env,
        userData,
        runDir: env.NEXD_RUN_DIR,
        socketPath,
        httpPort: Number(env.NEXD_HTTP_PORT),
        base: `http://127.0.0.1:${env.NEXD_HTTP_PORT}`,
        runSocket: path.join(env.NEXD_RUN_DIR, `daemon-v${PROTOCOL_VERSION}.sock`),
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function startDaemon(sandbox) {
    const log = [];
    const child = spawn(process.execPath, [daemonEntry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk) => {
        log.push(chunk);
        if (options.verbose) process.stderr.write(`[daemon] ${chunk}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exited = false;
    child.on('exit', () => {
        exited = true;
    });

    return {
        child,
        log: () => log.join(''),
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

async function waitForHealthz(base, timeoutMs = 20_000) {
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

// ── the shell under test ────────────────────────────────────────────────────────────

function electronBinary() {
    for (const candidate of [
        path.join(shellRoot, 'node_modules', '.bin', 'electron'),
        path.join(repoRoot, 'node_modules', '.bin', 'electron')
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('electron is not installed (pnpm install)');
}

function startShell(sandbox) {
    const lines = [];
    const child = spawn(electronBinary(), ['.', `--user-data-dir=${sandbox.userData}`], {
        cwd: shellRoot,
        env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so `signalGroup` can take the helper processes down too.
        detached: true
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    const collect = (chunk) => {
        if (options.verbose) process.stderr.write(`[shell] ${chunk}`);
        pending += chunk;
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) lines.push(line);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exitCode = null;
    let exited = false;
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
        /** Wait for a stdout line matching `pattern`. */
        waitForLine: (pattern, label, timeoutMs = 40_000) =>
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
                // SIGTERM goes to the main process alone: that is the path the shell's own
                // signal handler turns into `app.quit()`, and the helpers follow it out.
                if (signal === 'SIGTERM') child.kill('SIGTERM');
                else signalGroup(child, signal);
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(15_000)]);
            }
            // Sweep whatever is left of the tree (a held quit keeps the whole app alive).
            signalGroup(child, 'SIGKILL');
            await sleep(150);
            releaseChild(child);
        }
    };
}

// ── phase 1: adopt a running daemon, then quit without taking it down ────────────────

async function adoptPhase() {
    process.stdout.write('\nphase 1 — adopt a running daemon\n');
    const sandbox = await makeSandbox('adopt');
    const daemon = startDaemon(sandbox);
    let shell;
    try {
        await waitForHealthz(sandbox.base);
        pass('the throwaway daemon is up', sandbox.base);

        shell = startShell(sandbox);

        const discovered = await shell.waitForLine(/daemon discovered/, 'the daemon-discovered line');
        check('the shell adopts the running daemon instead of spawning one', discovered !== undefined, discovered);
        check('it did not spawn a second daemon', !shell.text().includes('daemon spawned'));

        const loading = await shell.waitForLine(/loading http/, 'the load request');
        check(
            'the window is pointed at the daemon URL with the run-dir token',
            loading.includes(`${sandbox.base}/?token=<token>`),
            loading.trim()
        );

        const loaded = await shell.waitForLine(/did-finish-load/, 'did-finish-load');
        // The client strips `?token=` from the address bar once it has read it, so the
        // finished URL is the bare origin — that it is the DAEMON's origin is the assertion.
        check('the window finished loading the daemon-served UI', loaded.includes(`${sandbox.base}/`), loaded.trim());

        const connected = await shell.waitForLine(/status ws connected/, 'the status WS handshake');
        check('the main process opened its own status WebSocket', connected.includes(sandbox.base.replace('http', 'ws')), connected.trim());

        const snapshot = await shell.waitForLine(/snapshot workspaces=/, 'the status snapshot');
        check('the status connection received a state snapshot', snapshot !== undefined, snapshot.trim());

        const hotkey = await shell.waitForLine(/global-hotkey/, 'the global hotkey line');
        check(
            'the global hotkey from the config file was applied',
            hotkey.includes('Control+Alt+Shift+F12'),
            hotkey.trim()
        );

        const tray = await shell.waitForLine(/tray ready/, 'the tray');
        check('a tray item was created', tray !== undefined, tray.trim());

        // A real agent lifecycle, driven over the control socket exactly as the `nex` CLI's
        // hooks drive it: the deltas have to reach the MAIN process and move the dock badge.
        const workspace = await controlCommand(sandbox.runSocket, { command: 'workspace-create', name: 'smoke' });
        check('the control socket creates a workspace', workspace?.ok === true, JSON.stringify(workspace));
        const pane = await controlCommand(sandbox.runSocket, {
            command: 'pane-create',
            workspace: 'smoke',
            name: 'agent'
        });
        check('the control socket creates a pane', typeof pane?.pane_id === 'string', JSON.stringify(pane));

        await controlCommand(sandbox.runSocket, { command: 'start', pane_id: pane.pane_id }, false);
        const running = await shell.waitForLine(/agents running=1/, 'the running transition');
        check('an agent start reaches the shell as a delta', running.includes('badge=-'), running.trim());

        await controlCommand(sandbox.runSocket, { command: 'stop', pane_id: pane.pane_id }, false);
        const waitingLine = await shell.waitForLine(/waiting=1/, 'the waiting transition');
        check(
            'a waiting agent badges the dock with the waiting count (§8.4)',
            waitingLine.includes('running=0') && waitingLine.includes('badge=1'),
            waitingLine.trim()
        );

        // Back to idle so the quit gate has nothing to warn about (its active-agent branch is
        // asserted below, with a second shell).
        await controlCommand(sandbox.runSocket, { command: 'pane-close', target: pane.pane_id });
        await shell.waitForLine(/agents running=0 waiting=0/, 'the return to idle');
        pass('closing the pane clears the badge');

        // The whole point: quitting the app must not touch the daemon.
        await shell.quit('SIGTERM');
        check('the shell exits cleanly on a quit request', shell.exitCode === 0, `exit code ${String(shell.exitCode)}`);
        check(
            'the quit path says it is leaving the daemon running',
            shell.text().includes('quit: leaving the daemon running')
        );

        const ping = await controlPing(sandbox.runSocket);
        check('the daemon still answers ping after the app exits', ping?.ok === true, JSON.stringify(ping));
        const health = await fetch(`${sandbox.base}/healthz`).then((response) => response.json());
        check('the daemon still serves HTTP after the app exits', health.ok === true, `pid ${health.pid}`);
        check('the daemon process was never signalled', !daemon.exited);

        const firstLog = shell.text();

        // ── the quit gate's other branch ────────────────────────────────────────────
        // A second shell attaches to the SAME daemon (proving reattach works at all), gets an
        // active agent, and is asked to quit: the gate must hold the quit and ask first. The
        // dialog cannot be clicked from here, so the assertion is that the app is still alive.
        const second = startShell(sandbox);
        try {
            await second.waitForLine(/status ws connected/, 'the second shell handshake');
            pass('a second shell attaches to the same daemon');

            const secondPane = await controlCommand(sandbox.runSocket, {
                command: 'pane-create',
                workspace: 'smoke',
                name: 'agent2'
            });
            await controlCommand(sandbox.runSocket, { command: 'start', pane_id: secondPane.pane_id }, false);
            await controlCommand(sandbox.runSocket, { command: 'stop', pane_id: secondPane.pane_id }, false);
            await second.waitForLine(/waiting=1/, 'the second waiting transition');

            second.child.kill('SIGTERM');
            const held = await second.waitForLine(/quit held/, 'the quit-gate hold', 10_000);
            check('quitting with an active agent asks first', held.includes('1 active agent'), held.trim());
            await sleep(1500);
            check('the app stays alive while the confirmation is open', !second.exited);
            check('and the daemon is still untouched', (await controlPing(sandbox.runSocket))?.ok === true);
        } finally {
            await second.quit('SIGKILL');
        }

        return { shellLog: `${firstLog}\n---- second shell ----\n${second.text()}`, daemonLog: daemon.log() };
    } finally {
        await shell?.quit('SIGKILL');
        await daemon.stop();
        sandbox.cleanup();
    }
}

// ── phase 2: no daemon → the shell spawns a detached one ─────────────────────────────

async function spawnPhase() {
    process.stdout.write('\nphase 2 — spawn a daemon when none is running\n');
    const sandbox = await makeSandbox('spawn');
    let shell;
    let spawnedPid;
    try {
        shell = startShell(sandbox);

        const spawned = await shell.waitForLine(/daemon spawned/, 'the daemon-spawned line');
        check('the shell spawns a daemon when the run dir is empty', spawned !== undefined, spawned.trim());

        const ready = await shell.waitForLine(/daemon ready/, 'the daemon-ready line');
        check('it waits for the daemon to become ready', ready.includes('http://127.0.0.1:'), ready.trim());

        await waitForHealthz(sandbox.base, 20_000);
        pass('the spawned daemon serves HTTP', sandbox.base);

        await shell.waitForLine(/did-finish-load/, 'did-finish-load');
        pass('the window loaded the spawned daemon URL');

        const record = JSON.parse(
            fs.readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.pid`), 'utf8')
        );
        spawnedPid = record.pid;
        check('the daemon recorded its pid and port', typeof spawnedPid === 'number' && record.http_port > 0, JSON.stringify(record));

        await shell.quit('SIGTERM');
        const ping = await controlPing(sandbox.runSocket);
        check('the spawned daemon outlives the shell that started it', ping?.ok === true, JSON.stringify(ping));

        return { shellLog: shell.text() };
    } finally {
        await shell?.quit('SIGKILL');
        // The daemon here is DETACHED on purpose, so the smoke has to stop it explicitly —
        // this is the one place a shell-owned daemon gets signalled, and it is the test
        // harness doing it, not the shell.
        if (spawnedPid !== undefined) {
            try {
                process.kill(spawnedPid, 'SIGTERM');
                for (let attempt = 0; attempt < 40; attempt += 1) {
                    await sleep(100);
                    try {
                        process.kill(spawnedPid, 0);
                    } catch {
                        break;
                    }
                }
            } catch {
                // Already gone.
            }
        }
        sandbox.cleanup();
    }
}

// ── main ────────────────────────────────────────────────────────────────────────────

async function main() {
    await ensureBuilds();

    const logs = [];
    try {
        logs.push(await adoptPhase());
    } catch (error) {
        fail('phase 1 (adopt)', error instanceof Error ? error.message : String(error));
    }
    try {
        logs.push(await spawnPhase());
    } catch (error) {
        fail('phase 2 (spawn)', error instanceof Error ? error.message : String(error));
    }

    const failed = results.filter((result) => !result.ok);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
    if (failed.length > 0 || options.keepLogs) {
        for (const entry of logs) {
            if (entry?.shellLog !== undefined) process.stdout.write(`\n── shell log ──\n${entry.shellLog}\n`);
            if (entry?.daemonLog !== undefined) process.stdout.write(`\n── daemon log ──\n${entry.daemonLog}\n`);
        }
    }
    if (failed.length > 0) process.exitCode = 1;
}

await main();
// Every child has been killed and released by here; exit explicitly so a stray handle from a
// torn-down Electron helper can never turn a finished run into a hang.
process.exit(process.exitCode ?? 0);
