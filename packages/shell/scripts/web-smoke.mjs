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
 *   2. `kelpi web open <url>` creates a pane daemon-side AND a live view host-side (proved by
 *      `kelpi web url` returning the page's *live* title);
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
 *   9. embedded views: a synthetic WS client tagged as the page inside THIS shell's window
 *      reports a page-area rect, and the pane's live view moves out of the off-screen holder
 *      into the real window at those bounds; geometry from any other client is ignored, hiding
 *      the pane puts the view straight back, and the pane stays fully drivable either way;
 *  10. host lifecycle: quitting the shell releases the role (browser-bound verbs then fail with
 *      `no web pane host connected`), and a **new** shell re-registers and gets the daemon's
 *      `pane-open` replay, so the same pane is drivable again.
 *
 * Isolation rules (non-negotiable — the production Swift app owns the real socket on a dev
 * machine): every path lives in a fresh `mkdtemp` dir, the control socket is `<tmp>/kelpid.sock`
 * and NEVER `/tmp/nex.sock`, the CLI is pointed at the sandbox daemon with
 * `KELPI_SOCKET=tcp:127.0.0.1:<ephemeral>` (plus the pre-rename `NEX_SOCKET` for the Swift compat CLI), and
 * Electron gets its own `--user-data-dir`.
 *
 *   node packages/shell/scripts/web-smoke.mjs [--no-build] [--verbose] [--keep-logs]
 *
 * Exit code 0 = every check passed. With no Swift CLI installed the run is SKIPPED (exit 0):
 * `KELPI_COMPAT_CLI=/path/to/kelpi` points it at another copy.
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
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
const shellEntry = path.join(shellRoot, 'dist', 'main.js');
const PROTOCOL_VERSION = 1;

/** The shipped Swift CLI — the whole point of this smoke. */
const KELPI_CLI = process.env.KELPI_COMPAT_CLI ?? '/Applications/Nex.app/Contents/Helpers/nex';

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
<html><head><meta charset="utf-8"><title>Kelpi Web Smoke</title></head>
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
        const result = await run('pnpm', ['--filter', '@kelpi/daemon', 'build']);
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

    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const configPath = path.join(root, 'config');
    fs.writeFileSync(configPath, '');

    const controlPort = await freePort();
    // §N29: the shell is launched with a DevTools port so this smoke can reach the web pane's
    // own page target. Ephemeral and bound to loopback by Chromium — never the 9223 a dev
    // session might be using.
    const debugPort = await freePort();
    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        KELPID_RUN_DIR: path.join(root, 'run'),
        KELPID_SOCKET_PATH: socketPath,
        KELPID_TCP_PORT: String(controlPort),
        KELPID_DB_PATH: path.join(root, 'nex.db'),
        KELPID_CONFIG_PATH: configPath,
        KELPID_HTTP_PORT: String(await freePort()),
        KELPID_HTTP_HOST: '127.0.0.1',
        KELPID_ENTRY: daemonEntry
        // Deliberately NOT `KELPID_CLIENT_DIR`: the shell window must load the daemon's "client
        // not built" page rather than the real UI. This smoke plays the client itself (see
        // `connectProbe`) and a second, genuine reporter would race it for the same pane's
        // geometry, making the placement assertions depend on whether the client happened to be
        // built. The window still loads, paints and shows, which is all the host needs.
    };

    return {
        root,
        env,
        home,
        userData,
        controlPort,
        debugPort,
        runDir: env.KELPID_RUN_DIR,
        socketPath,
        base: `http://127.0.0.1:${env.KELPID_HTTP_PORT}`,
        runSocket: path.join(env.KELPID_RUN_DIR, `daemon-v${PROTOCOL_VERSION}.sock`),
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

/**
 * Issue #12: the client's own hold deadline, read from the module that owns it.
 *
 * Hard-coding 250 here would make this file a second, silent home for the number - the exact
 * shape of drift these smokes exist to catch. The client is TypeScript and this script is plain
 * Node, so the constant is read out of the source rather than imported; a source that no longer
 * declares it is a failure worth having, not a default worth guessing.
 */
function clientPosterDeadlineMs() {
    const source = fs.readFileSync(
        path.join(repoRoot, 'packages', 'client', 'src', 'webpane', 'poster.ts'),
        'utf8'
    );
    const found = /POSTER_DEADLINE_MS\s*=\s*(\d+)/.exec(source);
    if (found === null) throw new Error('POSTER_DEADLINE_MS is no longer declared in webpane/poster.ts');
    return Number(found[1]);
}

// ── a synthetic web client (the geometry reporter) ──────────────────────────────────

/**
 * The one thing the shipped CLI cannot do: play the WEB UI.
 *
 * Embedded web panes need a client that says where it drew a pane's page area, so this opens an
 * ordinary WS connection (the same handshake the real client performs, token and all) and sends
 * `web-geometry-report` frames. Node 24's global `WebSocket` keeps it dependency-free.
 */
async function connectProbe(sandbox) {
    const token = fs
        .readFileSync(path.join(sandbox.runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8')
        .trim();
    const socket = new WebSocket(`${sandbox.base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('geometry probe could not connect')), {
            once: true
        });
    });
    const welcomed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no welcome for the geometry probe')), 10_000);
        socket.addEventListener('message', (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (message.type === 'welcome') {
                clearTimeout(timer);
                resolve(message);
            }
            if (message.type === 'rejected') {
                clearTimeout(timer);
                reject(new Error(`geometry probe rejected: ${message.message ?? message.code}`));
            }
        });
    });
    // §N29: everything the daemon pushes, kept, so the smoke can assert on a BROADCAST rather
    // than only on the shell's own log — the two ends of the same hop.
    const received = [];
    socket.addEventListener('message', (event) => {
        try {
            received.push(JSON.parse(String(event.data)));
        } catch {
            // Not JSON: nothing the daemon sends, and nothing to assert on.
        }
    });
    socket.send(
        JSON.stringify({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            token,
            client: { kind: 'browser', name: 'geometry-probe' }
        })
    );
    await welcomed;
    let commandID = 0;
    return {
        /** One `web-geometry-report`; `shellWindowID` is what makes it actionable. */
        geometry(report) {
            socket.send(JSON.stringify({ type: 'web-geometry-report', ...report }));
        },
        /** Every broadcast of one type, oldest first. */
        messages(type) {
            return received.filter((message) => message.type === type);
        },
        /** One ordinary client command (the GUI-only web verbs have no CLI). */
        command(command, extra = {}) {
            commandID += 1;
            socket.send(
                JSON.stringify({
                    type: 'command',
                    id: `probe-${String(commandID)}`,
                    payload: { command, ...extra }
                })
            );
        },
        /**
         * The same, awaited. Issue #12's `web-poster` is answered rather than broadcast, and the
         * whole point of it is that the answer arrives while a menu is opening — so the reply,
         * and how long it took, are both worth having here.
         */
        call(command, extra = {}, timeoutMs = 10_000) {
            commandID += 1;
            const id = `probe-${String(commandID)}`;
            const started = Date.now();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    socket.removeEventListener('message', onMessage);
                    reject(new Error(`no reply to ${command} within ${String(timeoutMs)}ms`));
                }, timeoutMs);
                const onMessage = (event) => {
                    let message;
                    try {
                        message = JSON.parse(String(event.data));
                    } catch {
                        return;
                    }
                    if (message.type !== 'command-reply' || message.id !== id) return;
                    clearTimeout(timer);
                    socket.removeEventListener('message', onMessage);
                    resolve({ reply: message.reply ?? {}, elapsedMs: Date.now() - started });
                };
                socket.addEventListener('message', onMessage);
                socket.send(JSON.stringify({ type: 'command', id, payload: { command, ...extra } }));
            });
        },
        close() {
            try {
                socket.close();
            } catch {
                // Already gone.
            }
        }
    };
}

// ── §N29: reaching the web pane's OWN page target ───────────────────────────────────

/**
 * The page inside a web pane is a `WebContentsView` — its own CDP target, listed by the shell's
 * DevTools port alongside the window's renderer. Attaching to it is what lets this smoke deliver
 * a press through the view's OWN input pipeline (`Input.dispatchMouseEvent`), which is the signal
 * the fix keys on: Electron raises `input-event` with `type: 'mouseDown'`, exactly as it does for
 * a finger.
 *
 * It is deliberately NOT `Page.bringToFront`. That was this smoke's stand-in for a click under
 * §N29's first fix, and it is an operation whose job is to MOVE keyboard focus — so it
 * manufactured the very focus transition that fix keyed on, and the smoke stayed green while the
 * owner's real click did nothing. A click makes no focus transition once the view holds focus,
 * which it does from the moment a pane finishes loading.
 *
 * (Measured on Electron 43: a second CDP client coexists with the tab's own
 * `webContents.debugger.attach('1.3')` — both sessions keep working.)
 */
async function findPageTarget(port, match, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
                signal: AbortSignal.timeout(3_000),
                headers: { connection: 'close' }
            });
            if (response.ok) {
                const targets = await response.json();
                const found = targets.find(
                    (target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string' && match(target)
                );
                if (found !== undefined) return found;
            }
        } catch {
            // The DevTools server comes up with the app; keep polling until the deadline.
        }
        if (Date.now() > deadline) return null;
        await sleep(200);
    }
}

/**
 * Which of a pane's page targets is the one IN the window.
 *
 * A pane can have several tabs on the same URL, and only the active one is embedded — so the
 * URL cannot tell them apart. Nor, any more, can the layout: a view that was on screen keeps
 * the pane's width when it is parked (`webhost/viewport-pin.ts` - the automation viewport is
 * applied lazily, by the first automation read, because pinning on every park is what reflowed
 * a page under a menu), and a holder view says `document.visibilityState === 'visible'` all the
 * same (measured). What CAN tell them apart is the daemon: `web-exec` runs on the pane's ACTIVE
 * tab and nothing else, so a global it sets is on exactly one page - the embedded one. The
 * caller sets `marker` that way and this finds the target that carries it.
 */
async function findEmbeddedTarget(port, baseURL, marker, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`, {
            signal: AbortSignal.timeout(3_000),
            headers: { connection: 'close' }
        }).catch(() => null);
        const targets = response !== null && response.ok ? await response.json() : [];
        for (const target of targets) {
            if (target.type !== 'page' || typeof target.webSocketDebuggerUrl !== 'string') continue;
            if (!String(target.url).startsWith(baseURL)) continue;
            const marked = await cdpCommand(target, 'Runtime.evaluate', {
                expression: `window[${JSON.stringify(marker)}] === true`,
                returnByValue: true
            });
            if (marked?.result?.result?.value === true) return target;
        }
        if (Date.now() > deadline) return null;
        await sleep(250);
    }
}

/** Send one CDP command to a target and wait for its reply. */
async function cdpCommand(target, method, params = {}) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error(`CDP connect failed for ${target.url}`)), {
            once: true
        });
    });
    try {
        const answered = new Promise((resolve) => {
            socket.addEventListener('message', (event) => {
                let message;
                try {
                    message = JSON.parse(String(event.data));
                } catch {
                    return;
                }
                if (message.id === 1) resolve(message);
            });
        });
        socket.send(JSON.stringify({ id: 1, method, params }));
        return await Promise.race([answered, raceTimeout(5_000)]);
    } finally {
        try {
            socket.close();
        } catch {
            // Already gone.
        }
    }
}

// ── the shipped CLI, pointed at the sandbox daemon ──────────────────────────────────

function makeCli(sandbox) {
    const invoke = (args, opts = {}) =>
        new Promise((resolve, reject) => {
            const child = spawn(KELPI_CLI, args, {
                cwd: opts.cwd ?? sandbox.home,
                env: {
                    PATH: sandbox.env.PATH,
                    HOME: sandbox.home,
                    // The real CLI hardcodes its transports; `tcp:` is the one the compat
                    // harness uses to reach a sandbox daemon without touching /tmp/nex.sock.
                    KELPI_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`,
                    // The Swift compat CLI reads the pre-rename name; the TS CLI ignores it.
                    NEX_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`,
                    // Refuse the /tmp/kelpi.sock fallback outright if the route above goes stale.
                    KELPI_REQUIRE_SOCKET: '1',
                    // Screenshots and page loads are slower than a state read.
                    KELPI_REPLY_TIMEOUT: '30',
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
                throw new Error(`kelpi ${args.join(' ')} exited ${String(result.code)}: ${result.stderr.trim()}`);
            }
            try {
                return JSON.parse(result.stdout);
            } catch {
                throw new Error(`kelpi ${args.join(' ')} printed non-JSON: ${result.stdout.slice(0, 400)}`);
            }
        }
    };
}

function cliAvailable() {
    try {
        fs.accessSync(KELPI_CLI, fs.constants.X_OK);
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
        check('`kelpi web open` succeeds', opened.code === 0, `${opened.stdout.trim()} ${opened.stderr.trim()}`);
        const paneID = /open ok: ([0-9A-Fa-f-]{36})/.exec(opened.stdout)?.[1];
        if (paneID === undefined) throw new Error(`no pane id in: ${opened.stdout}`);
        const at = (...args) => ['--target', paneID, ...args];

        // The daemon would answer `url` from its own state if the host said nothing, so a LIVE
        // title is the proof that a real view exists and loaded the page.
        const titled = await waitFor(
            'the live page title',
            async () => {
                const result = await cli.run(['web', 'url', ...at()]);
                return result.code === 0 && result.stdout.includes('Kelpi Web Smoke') ? result.stdout : false;
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
            exec.code === 0 && exec.stdout.trim() === 'Kelpi Web Smoke',
            `${exec.stdout.trim()} ${exec.stderr.trim()}`
        );

        const execAsync = await cli.run(['web', 'exec', ...at(), 'return await kelpi.text("css:#hello")']);
        check(
            '`exec` awaits a promise (kelpi/$ aliases resolve, not a pending Promise)',
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
                return result.stdout.includes('Kelpi Web Smoke') ? result.stdout : false;
            },
            20_000
        );
        check('the active tab actually navigated', back.includes('Kelpi Web Smoke'), back.trim());

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
            async () => (await cli.run(['web', 'url', ...at()])).stdout.includes('Kelpi Web Smoke'),
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
                return result.code === 0 && result.stdout.includes('Kelpi Web Smoke') ? result.stdout : false;
            },
            30_000
        );
        check('the private flip destroys and rebuilds the pane against the other store', rebuilt.includes('Kelpi Web Smoke'), rebuilt.trim());
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

        // ── embedded views (geometry → a view in the real window) ───────────────────
        //
        // The only party that knows where a web pane's page area is, is the client that drew
        // the chrome around it. Here a synthetic WS client plays that part: it tags itself as
        // the page inside THIS shell's window and reports a rect, and the shell must move the
        // pane's live view out of the off-screen holder and into the window at those bounds.
        const loading = await shell.waitForLine(/loading http/, 'the client URL the shell loaded');
        const windowID = /shellWindow=([0-9A-Fa-f-]{36})/.exec(loading)?.[1];
        check('the shell marks the UI it loads with its window id', windowID !== undefined, loading.trim());
        if (windowID === undefined) throw new Error(`no shellWindow marker in: ${loading}`);

        const probe = await connectProbe(sandbox);
        try {
            const embedded = `web pane ${paneID} view owner=main`;
            probe.geometry({
                paneID,
                rect: { x: 24, y: 60, w: 800, h: 420 },
                visible: true,
                devicePixelRatio: 2,
                shellWindowID: windowID
            });
            const placed = await shell.waitForLine(
                new RegExp(`${embedded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} bounds=`),
                'the view to move into the shell window',
                20_000
            );
            check(
                'a geometry report from the shell’s own window embeds the live view',
                placed.includes('owner=main') && /bounds=\d+,\d+ \d+×\d+/.test(placed),
                placed.trim()
            );

            // ── issue #12: the poster, taken off the view that is on screen right now ──
            //
            // This is the assumption the whole fix rests on and the one no unit test can
            // reach: a `WebContentsView` embedded in a real window answers
            // `Page.captureScreenshot {format:'jpeg'}` with the pane's own pixels, fast enough
            // that a menu can wait for it. Both halves are asserted — the frame IS a JPEG (the
            // `/9j/` magic, base64) and the round trip is inside the client's own deadline.
            const liveTabs = await cli.json(['web', 'tabs', ...at(), '--json']);
            const activeTabID = (liveTabs.find((tab) => tab.active === true) ?? liveTabs[0]).id;
            const shot = await probe.call('web-poster', { pane_id: paneID, tab_id: activeTabID });
            check(
                'a covered pane can photograph its own on-screen view (issue #12)',
                shot.reply.ok === true &&
                    typeof shot.reply.image_base64 === 'string' &&
                    shot.reply.image_base64.startsWith('/9j/') &&
                    shot.reply.mime === 'image/jpeg' &&
                    shot.reply.base64_bytes > 1000,
                `${String(shot.reply.base64_bytes ?? shot.reply.error)} base64 bytes in ${String(shot.elapsedMs)}ms`
            );
            /*
             * A WALL-CLOCK ceiling, so it must be one no honest machine trips.
             *
             * What matters is the order of magnitude: a capture that costs tens of milliseconds
             * is a menu that opens a frame late, and one that costs seconds is a different
             * mechanism entirely. A CI box under load, a cold renderer or a busy laptop can all
             * push a healthy 16ms capture past the client's own 250ms deadline without anything
             * being wrong — and missing that deadline is a case the client HANDLES (it parks with
             * no frame) rather than a defect. So the check is against the host budget the daemon
             * enforces, with the measurement and the client's deadline both printed: the number
             * to read is the detail, and the assertion only fails when the mechanism is broken.
             */
            const clientDeadlineMs = clientPosterDeadlineMs();
            const ceilingMs = 2_000;
            check(
                'the frame arrives in a time a menu could wait for (not seconds)',
                shot.elapsedMs < ceilingMs,
                `${String(shot.elapsedMs)}ms · client holds for ${String(clientDeadlineMs)}ms · ceiling ${String(ceilingMs)}ms` +
                    (shot.elapsedMs < clientDeadlineMs ? '' : ' — SLOW: inside the ceiling but past the hold')
            );
            const posterLine = shell.lines.filter((line) => line.includes(': poster ')).at(-1) ?? '';
            check(
                'the shell logs the frame it took, so the capture is visible from outside',
                posterLine.includes(`web pane ${paneID}: poster `),
                posterLine.trim()
            );
            /*
             * Issue #12's second half: the frame names the BOX it is a picture of, and that box
             * is the placement this run just watched the shell make. Without it the client lays
             * the image out on its own CSS rect, which is neither rounded nor clamped the way
             * `viewBounds` is — a 0.76% scale error on a 2× display, seen as the page jumping
             * when a menu opens.
             */
            const placedBounds = /bounds=(\d+),(\d+) (\d+)×(\d+)/.exec(placed);
            check(
                'the frame names the box it is a picture of, and it is the placed one',
                placedBounds !== null &&
                    typeof shot.reply.bounds === 'object' &&
                    shot.reply.bounds !== null &&
                    shot.reply.bounds.x === Number(placedBounds[1]) &&
                    shot.reply.bounds.y === Number(placedBounds[2]) &&
                    shot.reply.bounds.width === Number(placedBounds[3]) &&
                    shot.reply.bounds.height === Number(placedBounds[4]) &&
                    typeof shot.reply.css_scale === 'number' &&
                    shot.reply.css_scale > 0,
                `${JSON.stringify(shot.reply.bounds)} css_scale=${String(shot.reply.css_scale)} vs ${String(placed).trim()}`
            );

            // ── §N29: the click that lands in the PAGE ─────────────────────────────
            //
            // A native view's content cannot be clicked from here — no automation surface
            // delivers an OS mouse press to a `WebContentsView`. What CAN be driven is the
            // signal the fix keys on, and it is the production one rather than a test hook:
            // `Page.bringToFront` on the pane's own CDP target makes that view's `webContents`
            // take keyboard focus, exactly as a real click does, and with nothing on the shell
            // side having asked for it. The REAL pointer gesture is the owner's one-gesture
            // check; everything downstream of the focus event is proved here.
            //
            // Finding the right target takes one extra step: the pane has several tabs on the
            // same URL, and only the ACTIVE one is the view in the window. A parked view keeps
            // the pane's layout now (`webhost/viewport-pin.ts`), so the width cannot say which is
            // which; the daemon can - `web-exec` runs on the active tab alone, so a marker it
            // sets is on exactly the embedded page. (Exec on the EMBEDDED view pins nothing: the
            // pane's rect is its viewport, and `expectedWidth` below is the proof.)
            const marker = '__kelpiSmokeEmbedded';
            const marked = await probe.call('web-exec', { pane_id: paneID, script: `window.${marker} = true` });
            check('the daemon can mark the active tab through exec', marked.reply.ok === true, JSON.stringify(marked.reply));
            const placedWidth = Number(/bounds=\d+,\d+ (\d+)×\d+/.exec(placed)?.[1] ?? '0');
            const viewTarget = await findEmbeddedTarget(sandbox.debugPort, fixture.base, marker);
            check(
                'the embedded page has its own CDP target',
                viewTarget !== null,
                `${String(viewTarget?.url ?? 'none')} placed at ${String(placedWidth)}px`
            );
            if (viewTarget !== null) {
                const expectedWidth = await cdpCommand(viewTarget, 'Runtime.evaluate', {
                    expression: 'window.innerWidth',
                    returnByValue: true
                });
                check(
                    'the marked page is laid out at the pane\'s width (an automation read on an on-screen view pins nothing)',
                    expectedWidth?.result?.result?.value === placedWidth,
                    `innerWidth ${String(expectedWidth?.result?.result?.value)} vs placed ${String(placedWidth)}`
                );
            }
            if (viewTarget !== null) {
                // Settle first. A focus event that arrives mid-load is held and then dropped by
                // the commit that follows it (that is the second filter — a committing
                // navigation takes the keyboard and fires `focus` TWICE), so the gesture below
                // is only a gesture once the page is idle.
                await waitFor(
                    'the embedded page to finish loading',
                    async () => {
                        const state = await cdpCommand(viewTarget, 'Runtime.evaluate', {
                            expression: 'document.readyState',
                            returnByValue: true
                        });
                        return state?.result?.result?.value === 'complete';
                    },
                    20_000
                );
                const clientTarget = await findPageTarget(sandbox.debugPort, (target) =>
                    String(target.url).includes(`shellWindow=${windowID}`)
                );
                check('the shell window’s own renderer has a CDP target', clientTarget !== null);
                if (clientTarget === null) throw new Error('no client target to park focus in');

                /** Park keyboard focus in the window's own renderer — "the user clicked a terminal". */
                const parkFocusInClient = async () => {
                    await cdpCommand(clientTarget, 'Page.bringToFront');
                    await sleep(400);
                };
                /**
                 * A press inside the page, through the view's own input pipeline — the gesture.
                 *
                 * `mouseDown` is what Electron surfaces as `input-event`, and it is the whole
                 * signal; the release is sent so the page is left in a sane state, not because
                 * anything keys on it.
                 */
                const pressPage = async (x = 40, y = 40) => {
                    await cdpCommand(viewTarget, 'Input.dispatchMouseEvent', {
                        type: 'mousePressed',
                        x,
                        y,
                        button: 'left',
                        buttons: 1,
                        clickCount: 1
                    });
                    await sleep(40);
                    await cdpCommand(viewTarget, 'Input.dispatchMouseEvent', {
                        type: 'mouseReleased',
                        x,
                        y,
                        button: 'left',
                        buttons: 0,
                        clickCount: 1
                    });
                };
                const reportCount = () =>
                    shell.lines.filter((line) => line.includes('page took focus from the user')).length;

                // ── a NAVIGATION must not read as a click, live ────────────────────────
                //
                // Chromium focuses the newly committed widget, so `kelpi web navigate` on an
                // embedded pane DOES take the keyboard (that is what N30 is filed for). Under the
                // old focus-edge signal this needed a hold-and-cancel filter to stay quiet. It now
                // needs nothing at all: a commit presses no mouse button. The assertion is kept
                // because the guarantee is what matters to a user, not the mechanism behind it.
                await parkFocusInClient();
                const beforeNavigation = reportCount();
                const broadcastsBeforeNavigation = probe.messages('web-view-focus').length;
                await cli.run(['web', 'navigate', ...at(), `${fixture.base}/second`]);
                await waitFor(
                    'the navigation to land',
                    async () => (await cli.run(['web', 'url', ...at()])).stdout.includes('Second Page'),
                    20_000
                );
                await sleep(800);
                check(
                    'a committing navigation is not reported as a click',
                    reportCount() === beforeNavigation,
                    `${String(beforeNavigation)} reports before and after`
                );
                check(
                    '…so an agent’s `web navigate` cannot move the user’s focus ring',
                    probe.messages('web-view-focus').length === broadcastsBeforeNavigation,
                    `${String(broadcastsBeforeNavigation)} broadcasts before and after`
                );

                // ── the gesture ────────────────────────────────────────────────────────
                await waitFor(
                    'the navigated page to finish loading',
                    async () => {
                        const state = await cdpCommand(viewTarget, 'Runtime.evaluate', {
                            expression: 'document.readyState',
                            returnByValue: true
                        });
                        return state?.result?.result?.value === 'complete';
                    },
                    20_000
                );
                /*
                 * Drive the OWNER'S case, not the easy one.
                 *
                 * The ring is parked on the client, but the view is left HOLDING the keyboard —
                 * the ordinary state after a load, and the state in which a click produces no
                 * focus transition at all. §N29's first fix could not see this case; the input
                 * signal does not care, because a press is a press.
                 */
                await parkFocusInClient();
                // Captured BEFORE the focus move, or the check below is a tautology: comparing a
                // count to itself across no elapsed time can never fail, and a gate that cannot
                // fail is the exact kind of green this wave exists to stop trusting. (Verifier
                // fix — the assertion as first written was vacuous.)
                const beforeGesture = reportCount();
                await cdpCommand(viewTarget, 'Page.bringToFront');
                await sleep(400);
                check(
                    'the view taking keyboard focus reports nothing (focus is not the gesture)',
                    reportCount() === beforeGesture,
                    `${String(beforeGesture)} → ${String(reportCount())} reports across the focus move`
                );
                await pressPage();
                const reported = await shell.waitForLine(
                    new RegExp(`web pane ${paneID}: page took focus from the user`),
                    'the host to report the page taking focus',
                    15_000
                );
                check('the host reports a user-driven page focus', reported.includes('page took focus'), reported.trim());
                check(
                    '…from the PRESS, on a view that already held focus (the owner’s case)',
                    reportCount() > beforeGesture,
                    `${String(beforeGesture)} → ${String(reportCount())}`
                );

                const broadcast = await waitFor(
                    'the daemon to fan the page focus out to clients',
                    () => probe.messages('web-view-focus').at(-1) ?? false,
                    15_000
                );
                check(
                    'the daemon broadcasts `web-view-focus` for that pane',
                    broadcast.paneID === paneID,
                    JSON.stringify(broadcast)
                );
                check(
                    '…carrying the workspace the client needs to move its ring',
                    typeof broadcast.workspaceID === 'string' && broadcast.workspaceID.length > 0,
                    String(broadcast.workspaceID)
                );
                check(
                    '…and scoped to the shell window whose host saw the click',
                    broadcast.windowID === windowID,
                    `${String(broadcast.windowID)} vs ${windowID}`
                );

                // ── the shell's OWN focus claim must not read as a click, live ──────────
                //
                // Focus is parked in the window's renderer first, so WEB-043's `focus-view`
                // really does move focus into the view. Under the old signal that fired a `focus`
                // event which a re-entrancy claim had to swallow — and the 250 ms backstop it
                // needed could swallow a real click with it. There is nothing to swallow now:
                // moving focus presses no button. The guarantee is kept, the machinery is gone.
                await parkFocusInClient();
                const emissionsBefore = reportCount();
                const broadcastsBefore = probe.messages('web-view-focus').length;
                probe.command('web-focus-view', { pane_id: paneID });
                await shell.waitForLine(
                    new RegExp(`web pane ${paneID}: focusing the page view`),
                    'the shell’s own focus claim',
                    15_000
                );
                await sleep(600);
                check(
                    'the shell’s OWN focus claim is not reported as a click (seam a)',
                    reportCount() === emissionsBefore,
                    `${String(emissionsBefore)} reports before and after`
                );
                check(
                    '…and no ring-moving broadcast follows it',
                    probe.messages('web-view-focus').length === broadcastsBefore,
                    `${String(broadcastsBefore)} broadcasts before and after`
                );

                // …and nothing latches: the very next real press is reported again.
                await parkFocusInClient();
                await pressPage(60, 60);
                const again = await waitFor(
                    'a second user-driven page focus to be reported',
                    () => reportCount() > emissionsBefore,
                    15_000
                );
                check('the shell’s own focus claim does not disable the next real click', again === true);

                // Put the pane back on the page the checks after this one read.
                await cli.run(['web', 'navigate', ...at(), `${fixture.base}/`]);
                await waitFor(
                    'the pane to return to the smoke page',
                    async () => (await cli.run(['web', 'url', ...at()])).stdout.includes('Kelpi Web Smoke'),
                    20_000
                );
            }

            // Geometry from anyone else must not move anything: a browser on another machine
            // reporting rects would otherwise shove a desktop user's views around.
            const before = shell.lines.filter((line) => line.includes('view owner=')).length;
            probe.geometry({
                paneID,
                rect: { x: 0, y: 0, w: 400, h: 200 },
                visible: true,
                devicePixelRatio: 1
            });
            await sleep(750);
            check(
                'geometry from a client that is not this window is ignored',
                shell.lines.filter((line) => line.includes('view owner=')).length === before,
                `${String(before)} placement lines before and after`
            );

            // …and hiding the pane sends the view straight back to the holder, which is what
            // keeps every off-screen verb (capture, exec, the actuator) working afterwards.
            probe.geometry({
                paneID,
                rect: { x: 0, y: 0, w: 0, h: 0 },
                visible: false,
                devicePixelRatio: 2,
                shellWindowID: windowID
            });
            const returned = await shell.waitForLine(
                new RegExp(`web pane ${paneID} view owner=holder`),
                'the view to return to the holder',
                20_000
            );
            check('hiding the pane returns the view to the off-screen holder', returned.includes('owner=holder'), returned.trim());

            // Issue #12's other half: a view in the holder is laid out at the pinned automation
            // viewport, so its frame is not the pane's page and the host must refuse rather than
            // hand the client something to paint that is the wrong size at the wrong scale.
            const noShot = await probe.call('web-poster', { pane_id: paneID, tab_id: activeTabID });
            check(
                'a parked view refuses to poster rather than lying about what it shows',
                noShot.reply.ok === false && noShot.reply.error === 'no on-screen view to poster',
                String(noShot.reply.error ?? noShot.reply.ok)
            );

            const stillDrivable = await cli.run(['web', 'capture', '--mode', 'text', ...at()]);
            check(
                'the pane is still fully drivable once its view is back off-screen',
                stillDrivable.code === 0 && stillDrivable.stdout.includes('Hello from the smoke page'),
                stillDrivable.stdout.slice(0, 80).trim()
            );
        } finally {
            probe.close();
        }

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
        process.stdout.write(`skipped: the Swift kelpi CLI is not installed at ${KELPI_CLI}\n`);
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
