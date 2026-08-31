#!/usr/bin/env node
/**
 * Stress test for run-F **N1** — "terminal renderer failed to start", the intermittent defect
 * where a newly created pane came up with a placeholder instead of a shell and never recovered.
 *
 * The cause is upstream and shared-state: ghostty-web 0.4 runs **every terminal in the tab
 * through one WASM instance**, and its `init()` is not idempotent under concurrency — the
 * shipped dist is literally
 *
 *     let R = null;
 *     async function init() { R || (R = await Ghostty.load()); }
 *
 * so two panes that start while neither `load()` has settled each instantiate the module. The
 * first write after `open()` then lands outside the heap it was measured against:
 *
 *     RangeError: offset is out of bounds
 *         at Uint8Array.set
 *         at K.write            ← GhosttyTerminal.write, straight into the shared heap
 *
 * The audit saw it twice in four full 35-step runs, always on a flow that reveals a pane while
 * another engine is coming up (`kelpi pane split`, `kelpi workspace create`). This script makes
 * that flow the whole run: rounds of panes created **simultaneously** across several
 * workspaces, then torn down, then again — which is the same shape at ~20× the rate.
 *
 * Two modes, and both matter:
 *
 *   1. **race** (default) — no injection at all. Every pane is a real engine on the real shared
 *      WASM instance. This is the mode that can reproduce the genuine defect, and the one that
 *      runs against a tree WITHOUT the fix (there is nothing in it the fix has to provide).
 *   2. **`--faults <rate>`** — plants the exact N1 error in a fraction of engine startups
 *      through the `globalThis.__kelpiTerminalFaults` seam the renderer reads (see
 *      `packages/client/src/terminal/renderer.ts`). Deterministic proof that the retry path
 *      turns the failure into a hiccup: with the fix a faulted pane comes up on attempt 2 or 3,
 *      without it the pane is stranded on the first fault.
 *
 * A pane counts as STRANDED when it still paints `data-terminal-status="error"` after the
 * settle window — the same read the UI audit's `panesFailedToRender()` makes, and exactly what
 * a person sees. RECOVERED panes (`data-terminal-attempts > 1` and live) are reported too,
 * because a run where the fault fired and nothing stranded is the proof, not a clean run where
 * it never fired.
 *
 * Isolation rules (non-negotiable — the production app owns the real socket on a dev machine):
 * every path lives in a fresh `mkdtemp` dir, the control socket is `<tmp>/kelpid.sock` and NEVER
 * `/tmp/nex.sock`, HOME is a throwaway, Electron gets its own `--user-data-dir`, and every port
 * is ephemeral.
 *
 *   node packages/shell/scripts/renderer-start-stress.mjs \
 *       [--rounds N] [--panes N] [--workspaces N] [--faults <0..1>] \
 *       [--no-build] [--out <dir>] [--verbose] [--keep]
 *
 * Exit code 0 = no pane was stranded and the renderer console stayed clean.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const require = createRequire(path.join(shellRoot, 'package.json'));
const WebSocket = require('ws');

const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
const shellEntry = path.join(shellRoot, 'dist', 'main.js');
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const options = {
    build: !argv.includes('--no-build'),
    verbose: argv.includes('--verbose'),
    keep: argv.includes('--keep'),
    outDir: flag('--out', null),
    rounds: Number(flag('--rounds', '6')),
    panes: Number(flag('--panes', '5')),
    workspaces: Number(flag('--workspaces', '3')),
    faults: Number(flag('--faults', '0')),
    /**
     * Which client bundle the daemon serves. Overridable so a run can be pointed at a bundle
     * built somewhere private — which is how the same script is run against a tree WITHOUT the
     * fix (build the old client into its own directory, point this at it) without disturbing
     * `packages/client/dist`.
     */
    clientDist: flag('--client-dist', path.join(repoRoot, 'packages', 'client', 'dist'))
};
const clientDist = path.resolve(options.clientDist);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 60_000, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await predicate();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
        await sleep(intervalMs);
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// ── sandbox ─────────────────────────────────────────────────────────────────────────

async function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexflake-'));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    // A bare prompt: this run is about engines starting, not about what they paint.
    fs.writeFileSync(path.join(home, '.zshrc'), "PROMPT='kelpi %1~ $ '\n");

    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');
    fs.writeFileSync(path.join(root, 'config'), '');

    const controlPort = await freePort();
    const httpPort = await freePort();
    const debugPort = await freePort();
    fs.writeFileSync(
        path.join(userData, 'window-state.json'),
        JSON.stringify({ bounds: { x: 40, y: 40, width: 1440, height: 900 }, fullScreen: false })
    );
    return {
        root,
        home,
        userData,
        controlPort,
        debugPort,
        base: `http://127.0.0.1:${httpPort}`,
        env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            SHELL: '/bin/zsh',
            TERM: 'xterm-256color',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            KELPID_RUN_DIR: path.join(root, 'run'),
            KELPID_SOCKET_PATH: socketPath,
            KELPID_TCP_PORT: String(controlPort),
            KELPID_DB_PATH: path.join(root, 'nex.db'),
            KELPID_CONFIG_PATH: path.join(root, 'config'),
            KELPID_HTTP_PORT: String(httpPort),
            KELPID_HTTP_HOST: '127.0.0.1',
            KELPID_ENTRY: daemonEntry,
            KELPID_CLIENT_DIR: clientDist
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function startDaemon(sandbox) {
    const child = spawn(process.execPath, [daemonEntry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let exited = false;
    const collect = (chunk) => {
        if (options.verbose) process.stderr.write(`[daemon] ${chunk}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', () => {
        exited = true;
    });
    return {
        async stop() {
            if (exited) return;
            child.kill('SIGTERM');
            await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(8000)]);
            if (!exited) child.kill('SIGKILL');
        }
    };
}

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
    const child = spawn(
        electronBinary(),
        ['.', `--user-data-dir=${sandbox.userData}`, `--remote-debugging-port=${String(sandbox.debugPort)}`],
        {
            cwd: shellRoot,
            env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        }
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    if (options.verbose) {
        child.stdout.on('data', (chunk) => process.stderr.write(`[shell] ${chunk}`));
        child.stderr.on('data', (chunk) => process.stderr.write(`[shell] ${chunk}`));
    } else {
        child.stdout.resume();
        child.stderr.resume();
    }
    let exited = false;
    child.on('exit', () => {
        exited = true;
    });
    return {
        async quit() {
            if (!exited) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                } catch {
                    child.kill('SIGTERM');
                }
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(10_000)]);
            }
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                /* already gone */
            }
            await sleep(300);
        }
    };
}

// ── CDP ─────────────────────────────────────────────────────────────────────────────

async function connectPage(port, consoleErrors, retryReasons) {
    const target = await waitFor('a CDP page target', async () => {
        try {
            const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
            const targets = await response.json();
            return targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        } catch {
            return undefined;
        }
    });
    const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    let nextID = 1;
    const pending = new Map();
    socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method === 'Runtime.consoleAPICalled') {
            const { type, args = [] } = message.params;
            // Errors and warnings only — the same bar the UI audit's closing step applies. A
            // retried start logs at `info` precisely because the pane recovered.
            const text = args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ');
            if (type === 'error' || type === 'warning') {
                consoleErrors.push(`${type}: ${text}`);
            } else if (text.includes('[kelpi] terminal renderer')) {
                // The `info` line a RECOVERED start logs. Kept so a run says WHY it retried —
                // "0 stranded" is only meaningful next to the reason the retries fired.
                retryReasons.push(text.replace(/pane [0-9A-Fa-f-]{8,}/, 'pane <id>'));
            }
            return;
        }
        if (message.method === 'Runtime.exceptionThrown') {
            const details = message.params.exceptionDetails;
            consoleErrors.push(`exception: ${details?.exception?.description ?? details?.text ?? '?'}`);
            return;
        }
        const entry = message.id === undefined ? undefined : pending.get(message.id);
        if (entry === undefined) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
    });
    const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
            const id = nextID++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
            }, 30_000).unref?.();
        });
    const api = {
        close: () => socket.close(),
        async evaluate(expression) {
            const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (result.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails)}`);
            return result.result.value;
        },
        async screenshot(file) {
            const shot = await send('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        },
        send
    };
    await send('Page.enable');
    await send('Runtime.enable');
    return api;
}

/**
 * The state of every terminal pane in the window, as the person looking at it would read it:
 * the placeholder is `data-terminal-status="error"`, and `data-terminal-attempts` says how many
 * engines that pane had to build.
 */
const PANE_PROBE = `(() => {
    const panes = Array.from(document.querySelectorAll('[data-terminal-status]'));
    return panes.map((el) => ({
        id: el.getAttribute('data-pane-id'),
        status: el.getAttribute('data-terminal-status'),
        attempts: Number(el.getAttribute('data-terminal-attempts') || '0'),
        hasRetryButton: el.querySelector('[data-testid^="terminal-retry-"]') !== null
    }));
})()`;

/**
 * Install the fault hook. Renderers read `globalThis.__kelpiTerminalFaults` once, at construction,
 * so this has to be in place before the panes it is meant to hit are created — which it is:
 * every round creates its panes after this runs.
 */
function faultInstaller(rate) {
    return `(() => {
        const state = { rate: ${String(rate)}, planted: 0, seen: 0 };
        globalThis.__kelpiTerminalStress = state;
        globalThis.__kelpiTerminalFaults = {
            fault(kind) {
                // Only the first write of a startup, which is where the real RangeError lands
                // (the queued replay flush at the end of the adapter's load()).
                if (kind !== 'write') return undefined;
                state.seen += 1;
                if (Math.random() >= state.rate) return undefined;
                state.planted += 1;
                return 'offset is out of bounds';
            }
        };
        return true;
    })()`;
}

// ── the CLI (pane and workspace churn) ──────────────────────────────────────────────

function cli(sandbox, args) {
    const result = spawnSync(process.execPath, [cliEntry, ...args], {
        env: { ...sandbox.env, KELPI_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`, KELPI_REQUIRE_SOCKET: '1' },
        encoding: 'utf8',
        timeout: 30_000
    });
    return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function cliAsync(sandbox, args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [cliEntry, ...args], {
            env: { ...sandbox.env, KELPI_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`, KELPI_REQUIRE_SOCKET: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.resume();
        child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
}

function jsonOr(text, fallback) {
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

// ── the run ─────────────────────────────────────────────────────────────────────────

function ensureBuilds() {
    const builds = [
        ['@kelpi/daemon', daemonEntry, ['pnpm', ['--filter', '@kelpi/daemon', 'build']]],
        ['@kelpi/client', path.join(clientDist, 'index.html'), ['pnpm', ['--filter', '@kelpi/client', 'build']]],
        ['@kelpi/cli', cliEntry, ['pnpm', ['--filter', '@kelpi/cli', 'build']]],
        ['@kelpi/shell', shellEntry, ['node', [path.join(shellRoot, 'scripts', 'bundle.mjs')]]]
    ];
    for (const [name, artefact, [command, args]] of builds) {
        if (!options.build && fs.existsSync(artefact)) continue;
        if (!fs.existsSync(artefact) && name === '@kelpi/client' && options.clientDist !== path.join(repoRoot, 'packages', 'client', 'dist')) {
            throw new Error(`--client-dist ${clientDist} has no index.html; build it there first`);
        }
        process.stdout.write(`building ${name}…\n`);
        const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`${name} build failed:\n${result.stdout}${result.stderr}`);
    }
}

async function main() {
    ensureBuilds();
    if (options.outDir !== null) fs.mkdirSync(options.outDir, { recursive: true });

    const sandbox = await makeSandbox();
    process.stdout.write(`sandbox: ${sandbox.root}\n`);
    process.stdout.write(
        `mode: ${options.faults > 0 ? `injected faults at ${String(options.faults)}` : 'real race (no injection)'} · ` +
            `${String(options.rounds)} rounds × ${String(options.panes)} panes across ${String(options.workspaces)} workspaces\n\n`
    );

    const daemon = startDaemon(sandbox);
    const consoleErrors = [];
    const retryReasons = [];
    let shell = null;
    let cdp = null;
    const stranded = [];
    const recovered = [];
    let created = 0;

    try {
        await waitFor('the daemon to answer /healthz', async () => {
            try {
                return (await fetch(`${sandbox.base}/healthz`)).ok;
            } catch {
                return false;
            }
        });

        shell = startShell(sandbox);
        cdp = await connectPage(sandbox.debugPort, consoleErrors, retryReasons);
        await waitFor('the first pane to go live', async () => {
            const panes = await cdp.evaluate(PANE_PROBE);
            return Array.isArray(panes) && panes.some((pane) => pane.status === 'live');
        });
        await sleep(1500);

        if (options.faults > 0) await cdp.evaluate(faultInstaller(options.faults));

        // Extra workspaces up front: a workspace switch evicts a whole grid of engines and
        // rebuilds another, which is the second flow N1 was seen on. Creating one also SWITCHES
        // the window to it, so the last one made is where round 1 lands.
        const workspaces = [];
        for (let index = 1; index <= options.workspaces; index += 1) {
            const name = `Stress ${String(index)}`;
            const reply = jsonOr(cli(sandbox, ['workspace', 'create', '--name', name, '--json']).stdout, null);
            if (reply?.workspace_id === undefined) throw new Error(`could not create workspace ${name}`);
            workspaces.push(name);
        }
        await sleep(1500);

        for (let round = 1; round <= options.rounds; round += 1) {
            const target = workspaces[(round - 1) % workspaces.length];
            // Switch the window to the workspace this round works in — every visible engine in
            // the outgoing one is evicted and every one in the incoming one is rebuilt, which is
            // the remount path the shared WASM instance is dirtiest on.
            await cdp.evaluate(`(() => {
                const row = Array.from(document.querySelectorAll('[data-testid="workspace-row"]'))
                    .find((el) => el.innerText.includes(${JSON.stringify(target)}));
                if (row === null || row === undefined) return false;
                row.click();
                return true;
            })()`);
            await sleep(1200);

            // SIMULTANEOUS creation is the whole point: concurrent `pane create` is what puts
            // two engines through ghostty-web's non-idempotent `init()` at once.
            const creates = [];
            for (let index = 0; index < options.panes; index += 1) {
                creates.push(
                    cliAsync(sandbox, [
                        'pane',
                        'create',
                        '--workspace',
                        target,
                        '--name',
                        `s${String(round)}-${String(index)}`,
                        '--json'
                    ])
                );
            }
            const replies = await Promise.all(creates);
            const madeIDs = [];
            for (const reply of replies) {
                const parsed = jsonOr(reply.stdout, null);
                if (reply.code === 0 && parsed?.pane_id !== undefined) madeIDs.push(parsed.pane_id);
                else if (options.verbose) process.stderr.write(`[cli] pane create failed: ${reply.stdout}\n`);
            }
            created += madeIDs.length;

            // Let every engine finish (or exhaust its retries — 3 attempts, 150 ms backoff).
            await sleep(4000);

            const panes = await cdp.evaluate(PANE_PROBE);
            for (const pane of panes ?? []) {
                if (pane.status === 'error') stranded.push({ round, ...pane });
                else if (pane.attempts > 1) recovered.push({ round, ...pane });
            }
            const bad = (panes ?? []).filter((pane) => pane.status === 'error').length;
            const retried = (panes ?? []).filter((pane) => pane.status !== 'error' && pane.attempts > 1).length;
            process.stdout.write(
                `round ${String(round)} (${target}): ${String(madeIDs.length)} panes created · ` +
                    `${String((panes ?? []).length)} on screen · ${String(retried)} recovered after a retry · ` +
                    `${String(bad)} stranded\n`
            );
            if (bad > 0 && options.outDir !== null) {
                await cdp.screenshot(path.join(options.outDir, `stranded-round-${String(round)}.png`));
            }

            // Tear the round's panes down so the next round builds engines where others just died.
            await Promise.all(madeIDs.map((id) => cliAsync(sandbox, ['pane', 'close', '--target', id])));
            await sleep(1200);
        }

        const stressState = options.faults > 0 ? await cdp.evaluate('globalThis.__kelpiTerminalStress ?? null') : null;
        if (options.outDir !== null) await cdp.screenshot(path.join(options.outDir, 'final.png'));

        /**
         * The placeholder is the last stop on the retry path, not a dead end — so when the
         * budget HAS been exhausted (which injected faults are tuned to do), prove the button
         * on it works: clear the fault, click every Retry in the window, and require the panes
         * to come up. This is the half a unit test cannot show, because the button has to be
         * real, clickable and wired to a real engine build.
         */
        let retryButtonRecovered = null;
        const stillStranded = (await cdp.evaluate(PANE_PROBE)) ?? [];
        const strandedNow = stillStranded.filter((pane) => pane.status === 'error');
        if (strandedNow.length > 0) {
            const withButton = strandedNow.filter((pane) => pane.hasRetryButton).length;
            process.stdout.write(
                `\n${String(strandedNow.length)} pane(s) on the placeholder · ` +
                    `${String(withButton)} carry a Retry button\n`
            );
            if (options.outDir !== null) await cdp.screenshot(path.join(options.outDir, 'placeholder-with-retry.png'));
            await cdp.evaluate('globalThis.__kelpiTerminalFaults = undefined; true');
            const clicked = await cdp.evaluate(`(() => {
                const buttons = Array.from(document.querySelectorAll('[data-testid^="terminal-retry-"]'));
                buttons.forEach((button) => button.click());
                return buttons.length;
            })()`);
            await sleep(5000);
            const after = (await cdp.evaluate(PANE_PROBE)) ?? [];
            const revived = strandedNow.filter(
                (pane) => after.find((entry) => entry.id === pane.id)?.status === 'live'
            ).length;
            retryButtonRecovered = { clicked, revived, of: strandedNow.length };
            if (options.outDir !== null) await cdp.screenshot(path.join(options.outDir, 'after-retry-click.png'));
            process.stdout.write(
                `Retry clicked on ${String(clicked)} · ${String(revived)}/${String(strandedNow.length)} came up\n`
            );
        }

        process.stdout.write('\n── result ─────────────────────────────────────────────\n');
        process.stdout.write(`panes created:            ${String(created)}\n`);
        if (stressState !== null) {
            process.stdout.write(
                `faults planted:           ${String(stressState.planted)} of ${String(stressState.seen)} startup writes\n`
            );
        }
        const distinctRecovered = new Set(recovered.map((pane) => pane.id));
        const worstAttempt = recovered.reduce((worst, pane) => Math.max(worst, pane.attempts), 0);
        process.stdout.write(
            `panes that RECOVERED:     ${String(distinctRecovered.size)} distinct ` +
                `(worst pane needed ${String(worstAttempt)} engines)\n`
        );
        process.stdout.write(`panes STRANDED:           ${String(stranded.length)}\n`);
        const uniqueConsole = [...new Set(consoleErrors)];
        process.stdout.write(`renderer console errors:  ${String(uniqueConsole.length)}\n`);
        for (const line of uniqueConsole.slice(0, 10)) process.stdout.write(`    ${line}\n`);
        if (retryReasons.length > 0) {
            process.stdout.write(`\nwhy the retries fired (${String(retryReasons.length)} in total):\n`);
            const tally = new Map();
            for (const reason of retryReasons) tally.set(reason, (tally.get(reason) ?? 0) + 1);
            for (const [reason, count] of [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
                process.stdout.write(`    ${String(count)}×  ${reason}\n`);
            }
        }

        const faultsFired = stressState === null ? null : stressState.planted;
        // With injected faults the budget is DESIGNED to be exhaustible, so the bar there is
        // "the placeholder's Retry brought it back"; with no injection the bar is that nothing
        // ever reached the placeholder at all.
        const retryOk = retryButtonRecovered === null || retryButtonRecovered.revived === retryButtonRecovered.of;
        const ok =
            options.faults > 0 ? retryOk : stranded.length === 0 && uniqueConsole.length === 0;
        if (faultsFired !== null && faultsFired === 0) {
            process.stdout.write('\nNO FAULT EVER FIRED — this run proves nothing; raise --faults or --rounds.\n');
            process.exitCode = 2;
        } else {
            const bar =
                options.faults > 0
                    ? 'every pane the injected faults stranded came back from its Retry button'
                    : 'every pane came up';
            process.stdout.write(`\n${ok ? 'PASS' : 'FAIL'} — ${ok ? bar : 'a pane never came up'}\n`);
            process.exitCode = ok ? 0 : 1;
        }
    } finally {
        try {
            cdp?.close();
        } catch {
            /* already gone */
        }
        if (shell !== null) await shell.quit();
        await daemon.stop();
        if (options.keep) process.stdout.write(`sandbox kept: ${sandbox.root}\n`);
        else sandbox.cleanup();
    }
}

main().catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
});
