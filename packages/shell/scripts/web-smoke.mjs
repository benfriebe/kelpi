#!/usr/bin/env node
/**
 * Live smoke test for the **web-pane host** (M6's acceptance gate).
 *
 * `smoke.mjs` proves the shell's daemon lifecycle; this proves the other half that only exists
 * in a real process: an Electron shell registers as the daemon's web-pane host, builds real
 * `WebContentsView`s with real CDP sessions, and the **shipped Swift `nex` CLI** drives them
 * end to end. Nothing here is a fake — the daemon is the real daemon, the host is the real
 * host, the browser is Chromium, and the client is the binary that ships today.
 *
 * What it asserts, in order:
 *
 *   1. the shell claims the `web-pane-host` role over its own WS connection;
 *   2. `nex web open <url>` creates a pane daemon-side AND a live view host-side (proved by
 *      `nex web url` returning the page's *live* title);
 *   3. the read surface: `capture --mode text`, `capture --mode screenshot` (a real PNG off an
 *      off-screen view), `exec`, and the actuator (`text`, `click`, `wait`, `exists`);
 *   4. the console pipeline: the page's `console.log` / `console.error` / `console.assert`, a
 *      failed `fetch` and a failed subresource all arrive in the daemon's ring buffer in the
 *      spec's own message formats (§7.1);
 *   5. tabs: `tab-new` builds a second view, `tabs --json` agrees with the host, `navigate`
 *      moves the active one;
 *   6. `file://` loading with sibling assets (the deliberate `webSecurity` decision);
 *   7. the element picker: arm → an actuated click is captured → `inspect-result` drains the
 *      sanitised payload (the nonce round-trips through the CDP binding);
 *   8. cookies + private mode: a cookie set by the page is listed and deleted, and flipping
 *      `private on` rebuilds the pane against a fresh in-memory partition (empty cookie jar);
 *   9. host lifecycle: quitting the shell releases the role (browser-bound verbs then fail with
 *      `no web pane host connected`), and a **new** shell re-registers and gets the daemon's
 *      `pane-open` replay, so the same pane is drivable again.
 *
 * Isolation rules (non-negotiable — the production Swift app owns the real socket on a dev
 * machine): every path lives in a fresh `mkdtemp` dir, the control socket is `<tmp>/nexd.sock`
 * and NEVER `/tmp/nex.sock`, the CLI is pointed at the sandbox daemon with
 * `NEX_SOCKET=tcp:127.0.0.1:<ephemeral>` (the same transport the compat harness uses), and
 * Electron gets its own `--user-data-dir`.
 *
 *   node packages/shell/scripts/web-smoke.mjs [--no-build] [--verbose] [--keep-logs]
 *
 * Exit code 0 = every check passed. With no Swift CLI installed the run is SKIPPED (exit 0):
 * `NEX_COMPAT_CLI=/path/to/nex` points it at another copy.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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

/** The shipped Swift CLI — the whole point of this smoke. */
const NEX_CLI = process.env.NEX_COMPAT_CLI ?? '/Applications/Nex.app/Contents/Helpers/nex';

const argv = new Set(process.argv.slice(2));
const options = {
    build: !argv.has('--no-build'),
    verbose: argv.has('--verbose'),
    keepLogs: argv.has('--keep-logs')
};

// ── tiny test harness (same shape as scripts/smoke.mjs) ─────────────────────────────

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

const raceTimeout = (ms) =>
    new Promise((resolve) => {
        setTimeout(resolve, ms).unref();
    });

function releaseChild(child) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
}

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
        const child = spawn(command, args, {
            cwd: opts.cwd ?? repoRoot,
            env: { ...process.env, ...opts.env }
        });
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

// ── the fixture site ────────────────────────────────────────────────────────────────

/**
 * A tiny local site, because every interesting web-pane behaviour needs a real origin:
 * cookies (a `file://` page has none), network console lines, and a second page to navigate
 * to. `/page.js` deliberately produces one of *each* console shape the spec pins.
 */
function fixtureBody(port) {
    return {
        '/': `<!doctype html>
<html><head><meta charset="utf-8"><title>Nex Web Smoke</title></head>
<body>
  <h1 id="hello">Hello from the smoke page</h1>
  <button id="go">Go</button>
  <div id="out">idle</div>
  <!-- a port nothing listens on: a real subresource FAILURE, not a 404 body -->
  <img id="broken" src="http://127.0.0.1:1/nope.png" alt="broken">
  <script src="/page.js"></script>
</body></html>`,
        '/second': `<!doctype html>
<html><head><meta charset="utf-8"><title>Second Page</title></head>
<body><h1 id="hello">the second page</h1></body></html>`,
        '/page.js': `console.log('page console line', 42);
console.error('boom');
console.assert(false, 'assert message');
document.cookie = 'smoke=1; path=/';
document.getElementById('go').addEventListener('click', function () {
  document.getElementById('out').textContent = 'clicked';
});
setTimeout(function () {
  var late = document.createElement('div');
  late.id = 'later';
  late.textContent = 'late arrival';
  document.body.appendChild(late);
}, 400);
fetch('http://127.0.0.1:${port}/missing-endpoint').catch(function () {});`
    };
}

async function startFixture() {
    const port = await freePort();
    const bodies = fixtureBody(port);
    const server = http.createServer((request, response) => {
        const url = (request.url ?? '/').split('?')[0];
        const body = bodies[url];
        if (body === undefined) {
            response.writeHead(404, { 'content-type': 'text/plain' });
            response.end('nope');
            return;
        }
        response.writeHead(200, {
            'content-type': url.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8'
        });
        response.end(body);
    });
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    server.unref();
    return { port, base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

/** A local page + a SIBLING script: the file:// case the webSecurity decision is about. */
function writeLocalPage(root) {
    const dir = path.join(root, 'site');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'local.html'),
        `<!doctype html>
<html><head><meta charset="utf-8"><title>Local Page</title></head>
<body><h1 id="hello">local file</h1><div id="sibling">pending</div>
<script src="./sibling.js"></script></body></html>`
    );
    fs.writeFileSync(
        path.join(dir, 'sibling.js'),
        "document.getElementById('sibling').textContent = 'sibling loaded';\n"
    );
    return path.join(dir, 'local.html');
}

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

async function makeSandbox(label) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexweb-${label}-`));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    const socketPath = path.join(root, 'nexd.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const configPath = path.join(root, 'config');
    fs.writeFileSync(configPath, '');

    const controlPort = await freePort();
    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NEXD_RUN_DIR: path.join(root, 'run'),
        NEXD_SOCKET_PATH: socketPath,
        NEXD_TCP_PORT: String(controlPort),
        NEXD_DB_PATH: path.join(root, 'nex.db'),
        NEXD_CONFIG_PATH: configPath,
        NEXD_HTTP_PORT: String(await freePort()),
        NEXD_HTTP_HOST: '127.0.0.1',
        NEXD_ENTRY: daemonEntry,
        ...(fs.existsSync(path.join(clientDist, 'index.html')) ? { NEXD_CLIENT_DIR: clientDist } : {})
    };

    return {
        root,
        env,
        home,
        userData,
        controlPort,
        runDir: env.NEXD_RUN_DIR,
        socketPath,
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
                if (signal === 'SIGTERM') child.kill('SIGTERM');
                else signalGroup(child, signal);
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(15_000)]);
            }
            signalGroup(child, 'SIGKILL');
            await sleep(150);
            releaseChild(child);
        }
    };
}

// ── the shipped CLI, pointed at the sandbox daemon ──────────────────────────────────

function makeCli(sandbox) {
    const invoke = (args, opts = {}) =>
        new Promise((resolve, reject) => {
            const child = spawn(NEX_CLI, args, {
                cwd: opts.cwd ?? sandbox.home,
                env: {
                    PATH: sandbox.env.PATH,
                    HOME: sandbox.home,
                    // The real CLI hardcodes its transports; `tcp:` is the one the compat
                    // harness uses to reach a sandbox daemon without touching /tmp/nex.sock.
                    NEX_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`,
                    // Screenshots and page loads are slower than a state read.
                    NEX_REPLY_TIMEOUT: '30',
                    ...opts.env
                },
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => (stdout += chunk));
            child.stderr.on('data', (chunk) => (stderr += chunk));
            child.on('error', reject);
            child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr, args }));
            const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 45_000);
            timer.unref();
            child.on('close', () => clearTimeout(timer));
        });

    return {
        run: invoke,
        /** Run + require exit 0 + parse the JSON the CLI printed. */
        async json(args, opts = {}) {
            const result = await invoke(args, opts);
            if (result.code !== 0) {
                throw new Error(`nex ${args.join(' ')} exited ${String(result.code)}: ${result.stderr.trim()}`);
            }
            try {
                return JSON.parse(result.stdout);
            } catch {
                throw new Error(`nex ${args.join(' ')} printed non-JSON: ${result.stdout.slice(0, 400)}`);
            }
        }
    };
}

function cliAvailable() {
    try {
        fs.accessSync(NEX_CLI, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

// ── the run ─────────────────────────────────────────────────────────────────────────

async function webPhase() {
    process.stdout.write('\nweb-pane host — the shipped CLI against real WebContentsViews\n');
    const sandbox = await makeSandbox('host');
    const fixture = await startFixture();
    const daemon = startDaemon(sandbox);
    const cli = makeCli(sandbox);
    const localPage = writeLocalPage(sandbox.root);
    let shell;
    let second;
    try {
        await waitForHealthz(sandbox.base);
        pass('the throwaway daemon is up', sandbox.base);

        shell = startShell(sandbox);
        const registered = await shell.waitForLine(/web host registered/, 'the web-host registration');
        check('the shell claims the web-pane host role', registered !== undefined, registered.trim());

        // ── open a pane ─────────────────────────────────────────────────────────────
        const opened = await cli.run(['web', 'open', `${fixture.base}/`]);
        check('`nex web open` succeeds', opened.code === 0, `${opened.stdout.trim()} ${opened.stderr.trim()}`);
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1];
        if (paneID === undefined) throw new Error(`no pane id in: ${opened.stdout}`);
        const at = (...args) => ['--target', paneID, ...args];

        // The daemon would answer `url` from its own state if the host said nothing, so a LIVE
        // title is the proof that a real view exists and loaded the page.
        const titled = await waitFor(
            'the live page title',
            async () => {
                const result = await cli.run(['web', 'url', ...at()]);
                return result.code === 0 && result.stdout.includes('Nex Web Smoke') ? result.stdout : false;
            },
            30_000
        );
        check('the host built a live view and reports the page title', titled.includes(`${fixture.base}/`), titled.trim());

        // ── reads ───────────────────────────────────────────────────────────────────
        const text = await cli.run(['web', 'capture', '--mode', 'text', ...at()]);
        check(
            '`capture --mode text` returns the rendered page text',
            text.code === 0 && text.stdout.includes('Hello from the smoke page'),
            text.stdout.slice(0, 120).trim()
        );

        const exec = await cli.run(['web', 'exec', ...at(), 'document.title']);
        check(
            '`exec` evaluates in the page and returns the value',
            exec.code === 0 && exec.stdout.trim() === 'Nex Web Smoke',
            `${exec.stdout.trim()} ${exec.stderr.trim()}`
        );

        const execAsync = await cli.run(['web', 'exec', ...at(), 'return await nex.text("css:#hello")']);
        check(
            '`exec` awaits a promise (nex/$ aliases resolve, not a pending Promise)',
            execAsync.code === 0 && execAsync.stdout.includes('Hello from the smoke page'),
            execAsync.stdout.slice(0, 160).trim()
        );

        const actuatorText = await cli.run(['web', 'text', ...at(), 'css:#hello']);
        check(
            'the injected actuator answers `web text`',
            actuatorText.code === 0 && actuatorText.stdout.trim() === 'Hello from the smoke page',
            actuatorText.stdout.trim()
        );

        const missing = await cli.run(['web', 'exists', ...at(), 'css:#nope']);
        check('`exists` exits 1 for a selector that misses', missing.code === 1, `exit ${String(missing.code)}`);
        const present = await cli.run(['web', 'exists', ...at(), 'css:#go']);
        check('`exists` exits 0 for a selector that hits', present.code === 0, `exit ${String(present.code)}`);

        // ── actions ─────────────────────────────────────────────────────────────────
        const clicked = await cli.run(['web', 'click', ...at(), 'css:#go']);
        check('`click` reaches the page listener', clicked.code === 0, clicked.stdout.trim());
        const out = await cli.run(['web', 'text', ...at(), 'css:#out']);
        check('the click ran the page handler', out.stdout.trim() === 'clicked', out.stdout.trim());

        const waited = await cli.run(['web', 'wait', ...at(), '--selector', 'css:#later', '--for', 'visible', '--timeout', '10']);
        check(
            '`wait` polls in-page until the late element appears',
            waited.code === 0 && waited.stdout.includes('visible'),
            waited.stdout.trim()
        );

        // ── screenshot off an off-screen view ───────────────────────────────────────
        const shot = await cli.run(['web', 'capture', '--mode', 'screenshot', ...at()]);
        const shotOut = shot.stdout.trim();
        let png = null;
        if (shotOut.startsWith('/')) png = fs.existsSync(shotOut) ? fs.readFileSync(shotOut) : null;
        else if (shotOut !== '') png = Buffer.from(shotOut, 'base64');
        check(
            '`capture --mode screenshot` produces a real PNG from the off-screen view',
            shot.code === 0 && png !== null && png.length > 1000 && png.subarray(1, 4).toString('latin1') === 'PNG',
            `${String(shot.code)} ${String(png?.length ?? 0)} bytes`
        );

        // ── console pipeline (§7.1 message formats) ─────────────────────────────────
        const consoleReply = await waitFor(
            'the console lines',
            async () => {
                const reply = await cli.json(['web', 'console', ...at(), '--json']);
                const messages = (reply.lines ?? []).map((line) => line.message);
                return messages.some((message) => message.includes('page console line')) ? reply : false;
            },
            20_000
        );
        const messages = consoleReply.lines.map((line) => line.message);
        const levels = new Map(consoleReply.lines.map((line) => [line.message, line.level]));
        check(
            'console.log arguments are joined with a single space',
            messages.some((message) => message === 'page console line 42'),
            JSON.stringify(messages.slice(0, 8))
        );
        check(
            'console.error lands at level error',
            levels.get('boom') === 'error',
            String(levels.get('boom'))
        );
        check(
            'console.assert gets the spec prefix',
            messages.some((message) => message.startsWith('Assertion failed:') && message.includes('assert message')),
            JSON.stringify(messages.filter((message) => message.startsWith('Assertion')))
        );
        const network = await waitFor(
            'the network console lines',
            async () => {
                const reply = await cli.json(['web', 'console', ...at(), '--json']);
                const all = reply.lines.map((line) => line.message);
                return all.some((message) => message.startsWith('fetch 404')) &&
                    all.some((message) => message.startsWith('resource load failed:'))
                    ? all
                    : false;
            },
            20_000
        );
        check(
            'a failed fetch is reported in the spec format',
            network.some((message) => /^fetch 404( Not Found)? — http/.test(message)),
            JSON.stringify(network.filter((message) => message.startsWith('fetch')))
        );
        check(
            'a failed subresource is reported with its tag',
            network.some((message) => message.startsWith('resource load failed: img ')),
            JSON.stringify(network.filter((message) => message.startsWith('resource load failed')))
        );
        const since = await cli.json(['web', 'console', ...at(), '--since', String(consoleReply.next_since), '--json']);
        check(
            '`--since` only returns lines the poller has not seen',
            since.lines.every((line) => line.seq >= consoleReply.next_since),
            `next_since=${String(consoleReply.next_since)} lines=${String(since.lines.length)}`
        );

        // ── tabs ────────────────────────────────────────────────────────────────────
        const tabNew = await cli.run(['web', 'tab-new', ...at(), `${fixture.base}/second`]);
        check('`tab-new` succeeds', tabNew.code === 0, tabNew.stdout.trim());
        const tabs = await cli.json(['web', 'tabs', ...at(), '--json']);
        check('the pane now has two tabs, the new one active', tabs.length === 2 && tabs[1].active === true, JSON.stringify(tabs.map((tab) => [tab.index, tab.active])));
        const secondTitle = await waitFor(
            'the second tab title',
            async () => {
                const result = await cli.run(['web', 'url', ...at()]);
                return result.stdout.includes('Second Page') ? result.stdout : false;
            },
            20_000
        );
        check('the host built and activated the new tab', secondTitle.includes('/second'), secondTitle.trim());

        const navigated = await cli.run(['web', 'navigate', ...at(), `${fixture.base}/`]);
        check('`navigate` acks optimistically', navigated.code === 0, navigated.stdout.trim());
        const back = await waitFor(
            'the navigation to land',
            async () => {
                const result = await cli.run(['web', 'url', ...at()]);
                return result.stdout.includes('Nex Web Smoke') ? result.stdout : false;
            },
            20_000
        );
        check('the active tab actually navigated', back.includes('Nex Web Smoke'), back.trim());

        // ── file:// with a sibling asset ────────────────────────────────────────────
        const localTab = await cli.run(['web', 'tab-new', ...at(), localPage]);
        check('`tab-new <path>` resolves a local file to a file:// URL', localTab.code === 0 && localTab.stdout.includes('file://'), localTab.stdout.trim());
        const sibling = await waitFor(
            'the sibling script to run',
            async () => {
                const result = await cli.run(['web', 'text', ...at(), 'css:#sibling']);
                return result.code === 0 && result.stdout.includes('sibling loaded') ? result.stdout : false;
            },
            20_000
        );
        check('a file:// page loads its sibling assets (the webSecurity decision)', sibling.includes('sibling loaded'), sibling.trim());

        // Back to the http tab for the picker + cookie checks (tab 0).
        await cli.run(['web', 'tab-select', ...at(), '0']);
        await waitFor(
            'the http tab to be active again',
            async () => (await cli.run(['web', 'url', ...at()])).stdout.includes('Nex Web Smoke'),
            20_000
        );
        pass('`tab-select` switches the visible tab back');

        // ── element picker (nonce round trip through the CDP binding) ───────────────
        const armed = await cli.run(['web', 'inspect', ...at()]);
        check('`inspect` arms the in-page picker', armed.code === 0 && armed.stdout.includes('inspect armed'), armed.stdout.trim());
        // An actuated click is a real click event, which the armed capture-phase listener sees.
        await cli.run(['web', 'click', ...at(), 'css:#go']);
        const picked = await waitFor(
            'the picked element',
            async () => {
                const reply = await cli.json(['web', 'inspect-result', ...at(), '--json']);
                return Array.isArray(reply) && reply.length > 0 ? reply : false;
            },
            20_000
        );
        check(
            'the picked payload reaches the daemon with a valid nonce and is sanitised',
            picked[0].selector === '#go' && picked[0].tag === 'button',
            JSON.stringify({ selector: picked[0].selector, tag: picked[0].tag, url: picked[0].url })
        );

        // ── cookies + private mode ──────────────────────────────────────────────────
        const cookies = await waitFor(
            'the page cookie',
            async () => {
                const list = await cli.json(['web', 'cookies', 'list', ...at(), '--json']);
                return list.some((cookie) => cookie.name === 'smoke') ? list : false;
            },
            20_000
        );
        check('the pane cookie store shows the cookie the page set', cookies.some((cookie) => cookie.name === 'smoke'), JSON.stringify(cookies.map((cookie) => cookie.name)));
        const deleted = await cli.run(['web', 'cookies', 'delete', ...at(), 'smoke']);
        check('`cookies delete` removes it and exits 0', deleted.code === 0, deleted.stdout.trim());

        // A marker the PAGE never re-creates: the page re-sets `smoke` on every load, so only a
        // cookie nobody rewrites can prove which partition the rebuilt views landed on.
        await cli.run(['web', 'exec', ...at(), 'document.cookie = "marker=persistent; path=/"']);
        const marked = await waitFor(
            'the marker cookie',
            async () => {
                const list = await cli.json(['web', 'cookies', 'list', ...at(), '--json']);
                return list.some((cookie) => cookie.name === 'marker') ? list : false;
            },
            10_000
        );
        check('a cookie written by page JS lands in the pane store', marked.some((cookie) => cookie.name === 'marker'));

        const privateOn = await cli.run(['web', 'private', 'on', ...at()]);
        check('`private on` succeeds', privateOn.code === 0, privateOn.stdout.trim());
        const rebuilt = await waitFor(
            'the pane to come back after the private rebuild',
            async () => {
                const result = await cli.run(['web', 'url', ...at()]);
                return result.code === 0 && result.stdout.includes('Nex Web Smoke') ? result.stdout : false;
            },
            30_000
        );
        check('the private flip destroys and rebuilds the pane against the other store', rebuilt.includes('Nex Web Smoke'), rebuilt.trim());
        const privateCookies = await cli.json(['web', 'cookies', 'list', ...at(), '--json']);
        check(
            'the private partition cannot see the persistent one (the marker is gone)',
            !privateCookies.some((cookie) => cookie.name === 'marker'),
            JSON.stringify(privateCookies.map((cookie) => cookie.name))
        );

        const privateOff = await cli.run(['web', 'private', 'off', ...at()]);
        check('`private off` succeeds', privateOff.code === 0, privateOff.stdout.trim());
        const restored = await waitFor(
            'the persistent store to come back',
            async () => {
                const list = await cli.json(['web', 'cookies', 'list', ...at(), '--json']);
                return list.some((cookie) => cookie.name === 'marker') ? list : false;
            },
            30_000
        );
        check('flipping back reattaches the untouched persistent store', restored.some((cookie) => cookie.name === 'marker'));

        // ── host lifecycle ──────────────────────────────────────────────────────────
        const shellLog = shell.text();
        await shell.quit('SIGTERM');
        const orphaned = await waitFor(
            'the daemon to notice the host is gone',
            async () => {
                const result = await cli.run(['web', 'capture', '--mode', 'text', ...at()]);
                return result.code !== 0 ? result : false;
            },
            15_000
        );
        check(
            'with the shell gone, browser-bound verbs fail with the stable no-host string',
            orphaned.stderr.includes('no web pane host connected'),
            orphaned.stderr.trim()
        );
        const stateStill = await cli.json(['web', 'tabs', ...at(), '--json']);
        check('daemon-owned state survives the host (tabs still list)', stateStill.length >= 2, `${String(stateStill.length)} tabs`);

        second = startShell(sandbox);
        await second.waitForLine(/web host registered/, 'the second registration');
        const replayed = await waitFor(
            'the replayed pane to be drivable again',
            async () => {
                const result = await cli.run(['web', 'capture', '--mode', 'text', ...at()]);
                return result.code === 0 && result.stdout.includes('Hello from the smoke page') ? result.stdout : false;
            },
            40_000
        );
        check('a new shell re-registers and the daemon replays the pane onto it', replayed.includes('Hello from the smoke page'), replayed.slice(0, 80).trim());

        return { shellLog: `${shellLog}\n---- second shell ----\n${second.text()}`, daemonLog: daemon.log() };
    } finally {
        await second?.quit('SIGKILL');
        await shell?.quit('SIGKILL');
        await daemon.stop();
        fixture.close();
        sandbox.cleanup();
    }
}

async function main() {
    if (!cliAvailable()) {
        process.stdout.write(`skipped: the Swift nex CLI is not installed at ${NEX_CLI}\n`);
        return;
    }
    await ensureBuilds();

    const logs = [];
    try {
        logs.push(await webPhase());
    } catch (error) {
        fail('web-pane host phase', error instanceof Error ? error.message : String(error));
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
process.exit(process.exitCode ?? 0);
