#!/usr/bin/env node
/**
 * `phone-pwa-shell`: the live gate for the service worker (phone program A2).
 *
 *   node packages/shell/scripts/pwa-smoke.mjs [--no-build] [--verbose] [--keep-logs]
 *
 * Why a smoke and not an audit step. The audit harness drives the ELECTRON SHELL, and the shell
 * is precisely the client that does not register a worker (`client/src/pwa/register.ts` gates on
 * `readShellWindowID()`), so there is nothing for an audit step to watch. This gate needs a page
 * that is a plain browser tab on the daemon's origin, which is what a phone is. So it sits
 * beside `smoke:web` and `smoke:terminal`, boots its own daemon over the real built client, and
 * drives a bare Chromium window through CDP.
 *
 * The Chromium is Electron's. It is already a devDependency of this package, every other smoke
 * here launches it, and unlike a system Chrome it is present on any machine that ran
 * `pnpm install`. The probe is a throwaway Electron app written into the sandbox: a hidden
 * `BrowserWindow` on `http://127.0.0.1:<port>/` and nothing else. That URL is a trustworthy
 * origin, so service workers are available exactly as they are over https on the tailnet.
 *
 * What it asserts, in order:
 *
 *   1. the daemon serves `/sw.js` with `Service-Worker-Allowed: /` and `Cache-Control:
 *      no-cache`, and the file has no `import` statement in it;
 *   2. a plain browser page registers the worker, it activates, and it claims the page;
 *   3. the cache holds exactly this build's precache list: `/`, every `/assets/*` file, the
 *      manifest and the icons;
 *   4. the token stays out of it. The page fetches `/?token=...`, `/ws`, `/ws?token=...` and a
 *      `/pane-assets/...` path, and NOTHING carrying a query string or either prefix is in any
 *      cache afterwards;
 *   5. **the daemon is killed** and the page reloaded: the app paints its own
 *      `connection-splash`, not a browser error page, and how long that took is reported;
 *   6. a second window loading the SAME url with the shell's own `?shellWindow=<uuid>` marker,
 *      in its own partition, registers nothing and is controlled by nothing. That is guardrail
 *      1 (desktop is untouched) measured in a real browser rather than only in jsdom.
 *
 * Exit code 0 = every check passed. Isolation follows `web-smoke.mjs` exactly: a fresh
 * `mkdtemp` for everything, an ephemeral control socket that is never `/tmp/nex.sock`, and
 * Electron's own `--user-data-dir`.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connect, waitForPageTarget } from '../../../scripts/ui-audit/lib/cdp.mjs';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
const clientDist = path.join(repoRoot, 'packages', 'client', 'dist');
const PROTOCOL_VERSION = 1;

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

async function run(command, args, opts = {}) {
    return await new Promise((resolve) => {
        const child = spawn(command, args, { cwd: repoRoot, ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += String(chunk)));
        child.stderr.on('data', (chunk) => (stderr += String(chunk)));
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
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

// ── builds ──────────────────────────────────────────────────────────────────────────

/**
 * Both bundles, because this gate is about what the REAL build emits. `--no-build` reuses what
 * is on disk, which is what the coordinator's battery wants after it has already built once.
 */
async function ensureBuilds() {
    if (options.build || !fs.existsSync(daemonEntry)) {
        process.stdout.write('building the daemon bundle…\n');
        const result = await run('pnpm', ['--filter', '@kelpi/daemon', 'build']);
        if (result.code !== 0) throw new Error(`daemon build failed:\n${result.stdout}${result.stderr}`);
    }
    if (options.build || !fs.existsSync(path.join(clientDist, 'sw.js'))) {
        process.stdout.write('building the client…\n');
        const result = await run('pnpm', ['--filter', '@kelpi/client', 'build']);
        if (result.code !== 0) throw new Error(`client build failed:\n${result.stdout}${result.stderr}`);
    }
}

// ── throwaway environment ───────────────────────────────────────────────────────────

async function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-pwa-'));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    const probe = path.join(root, 'probe');
    for (const dir of [home, userData, probe]) fs.mkdirSync(dir, { recursive: true });

    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const configPath = path.join(root, 'config');
    fs.writeFileSync(configPath, '');

    const httpPort = await freePort();
    const debugPort = await freePort();
    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        KELPID_RUN_DIR: path.join(root, 'run'),
        KELPID_SOCKET_PATH: socketPath,
        KELPID_TCP_PORT: String(await freePort()),
        KELPID_DB_PATH: path.join(root, 'kelpi.db'),
        KELPID_CONFIG_PATH: configPath,
        KELPID_HTTP_PORT: String(httpPort),
        KELPID_HTTP_HOST: '127.0.0.1',
        KELPID_ENTRY: daemonEntry,
        // Unlike web-smoke, this gate is entirely about the real client build: the worker, the
        // precache list and the connection screen all come out of `packages/client/dist`.
        KELPID_CLIENT_DIR: clientDist
    };

    return {
        root,
        env,
        probe,
        userData,
        debugPort,
        base: `http://127.0.0.1:${String(httpPort)}`,
        runDir: env.KELPID_RUN_DIR,
        cleanup() {
            if (!options.keepLogs) fs.rmSync(root, { recursive: true, force: true });
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
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2000) });
            if (response.ok) return true;
        } catch {
            // still coming up
        }
        if (Date.now() > deadline) return false;
        await sleep(100);
    }
}

/** The daemon is gone when the port stops answering, not when the process object says so. */
async function waitForDaemonGone(base, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) });
        } catch {
            return true;
        }
        if (Date.now() > deadline) return false;
        await sleep(100);
    }
}

// ── the browser probe ───────────────────────────────────────────────────────────────

function electronBinary() {
    for (const candidate of [
        path.join(shellRoot, 'node_modules', '.bin', 'electron'),
        path.join(repoRoot, 'node_modules', '.bin', 'electron')
    ]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error('electron is not installed (pnpm install)');
}

/**
 * A throwaway Electron app: two hidden windows on the daemon's origin, in two partitions.
 *
 * The first is the phone: `http://127.0.0.1:<port>/`, exactly the URL a browser opens. The
 * second is the desktop shell as far as the CLIENT can tell: the same URL plus the
 * `?shellWindow=<uuid>` marker `shell/src/main.ts` appends, in a partition of its own so it
 * cannot inherit the first window's registration - which is also the truth on a real machine,
 * where the shell talks to a loopback daemon and the phone to a tailnet one.
 *
 * `show: false` keeps both off the owner's screen; nothing here needs a composited frame.
 */
function writeProbeApp(sandbox) {
    const shellWindowID = crypto.randomUUID();
    fs.writeFileSync(
        path.join(sandbox.probe, 'package.json'),
        `${JSON.stringify({ name: 'kelpi-pwa-probe', version: '0.0.0', main: 'main.cjs' }, null, 2)}\n`
    );
    fs.writeFileSync(
        path.join(sandbox.probe, 'main.cjs'),
        `const { app, BrowserWindow } = require('electron');
const base = ${JSON.stringify(sandbox.base)};
const shellWindowID = ${JSON.stringify(shellWindowID)};
app.on('window-all-closed', () => {});
app.whenReady().then(() => {
    const make = (url, partition) => {
        const win = new BrowserWindow({
            show: false,
            width: 390,
            height: 844,
            webPreferences: { partition, backgroundThrottling: false }
        });
        win.loadURL(url);
        return win;
    };
    make(base + '/', 'persist:kelpi-pwa-phone');
    make(base + '/?shellWindow=' + shellWindowID, 'persist:kelpi-pwa-shell');
});
`
    );
    return shellWindowID;
}

function startProbe(sandbox) {
    const lines = [];
    const child = spawn(
        electronBinary(),
        ['.', `--user-data-dir=${sandbox.userData}`, `--remote-debugging-port=${String(sandbox.debugPort)}`],
        {
            cwd: sandbox.probe,
            env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true
        }
    );
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk) => {
        if (options.verbose) process.stderr.write(`[probe] ${chunk}`);
        lines.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exited = false;
    child.on('exit', () => {
        exited = true;
    });

    return {
        text: () => lines.join(''),
        get exited() {
            return exited;
        },
        async quit() {
            if (!exited) {
                signalGroup(child, 'SIGTERM');
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(10_000)]);
            }
            signalGroup(child, 'SIGKILL');
            await sleep(150);
            releaseChild(child);
        }
    };
}

/** Open a CDP session on the page whose URL matches, and enable the Page domain. */
async function attach(sandbox, matcher, label) {
    const target = await waitForPageTarget(sandbox.debugPort, {
        timeoutMs: 60_000,
        match: (page) => matcher(String(page.url))
    });
    const session = await connect(target.webSocketDebuggerUrl, { repoRoot, verbose: options.verbose });
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    if (options.verbose) process.stderr.write(`[probe] attached to ${label}: ${String(target.url)}\n`);
    return session;
}

// ── the run ─────────────────────────────────────────────────────────────────────────

async function main() {
    await ensureBuilds();

    const sandbox = await makeSandbox();
    const shellWindowID = writeProbeApp(sandbox);
    const daemon = startDaemon(sandbox);
    let probe;

    try {
        if (!(await waitForHealthz(sandbox.base))) {
            throw new Error(`the daemon never answered /healthz:\n${daemon.log()}`);
        }

        // 1. the headers the whole update story rests on ───────────────────────────────
        const swResponse = await fetch(`${sandbox.base}/sw.js`);
        const swBody = await swResponse.text();
        check('GET /sw.js is 200 JavaScript', swResponse.status === 200, `status ${String(swResponse.status)}`);
        check(
            'GET /sw.js carries Service-Worker-Allowed: /',
            swResponse.headers.get('service-worker-allowed') === '/',
            String(swResponse.headers.get('service-worker-allowed'))
        );
        check(
            'GET /sw.js carries Cache-Control: no-cache',
            swResponse.headers.get('cache-control') === 'no-cache',
            String(swResponse.headers.get('cache-control'))
        );
        check(
            '/sw.js loads as a classic script (no import statement)',
            !/(^|[\s;}])(?:import|export)[\s({*]/.test(swBody),
            `${String(swBody.length)} bytes`
        );

        probe = startProbe(sandbox);

        // 2. the worker installs, activates and claims the page ────────────────────────
        const phone = await attach(sandbox, (url) => !url.includes('shellWindow'), 'the phone window');
        await phone.waitFor('document.readyState === "complete"', { timeoutMs: 60_000 });

        const registered = await phone.eval(
            `(async () => {
                const r = await navigator.serviceWorker.getRegistration('/');
                return r === undefined ? null : { scope: r.scope, hasActive: r.active !== null };
            })()`,
            { timeoutMs: 30_000 }
        );
        check('the page registered a worker at scope /', registered !== null && registered.scope.endsWith('/'), JSON.stringify(registered));

        await phone.waitFor('navigator.serviceWorker.controller !== null', {
            timeoutMs: 30_000,
            label: 'the worker to claim the page'
        });
        pass('the worker activated and claimed the page without a reload');

        const scriptURL = await phone.eval(
            '(async () => (await navigator.serviceWorker.getRegistration("/")).active.scriptURL)()'
        );
        check(
            'the registered script URL carries no query string',
            !String(scriptURL).includes('?') && String(scriptURL).endsWith('/sw.js'),
            String(scriptURL)
        );

        // 3. the cache holds this build's precache list ────────────────────────────────
        const expected = precacheFromDist();
        const cached = await phone.eval(
            `(async () => {
                const names = await caches.keys();
                const out = { names, urls: [] };
                for (const name of names) {
                    const cache = await caches.open(name);
                    for (const request of await cache.keys()) out.urls.push(request.url);
                }
                return out;
            })()`,
            { timeoutMs: 30_000 }
        );
        const origin = sandbox.base;
        const cachedPaths = cached.urls.map((url) => url.slice(origin.length)).sort();
        check('exactly one cache, named for this build', cached.names.length === 1 && /^kelpi-shell-[0-9a-f]{12}$/.test(cached.names[0]), String(cached.names));
        check(
            `the cache holds this build's precache list (${String(expected.length)} entries)`,
            JSON.stringify(cachedPaths) === JSON.stringify([...expected].sort()),
            `cached ${String(cachedPaths.length)}: ${cachedPaths.filter((p) => !expected.includes(p)).join(' ') || 'no extras'}`
        );

        // 4. the token stays out of the caches ─────────────────────────────────────────
        // Not an absence check on a cache nobody wrote to: the page actively asks for each of
        // the forbidden shapes first, so a worker that cached any of them would be caught.
        const probes = await phone.eval(
            `(async () => {
                const tried = [];
                for (const url of ['/?token=kd_smoke_secret', '/ws', '/ws?token=kd_smoke_secret',
                                   '/pane-assets/c/cred/pane-1/x.png', '/icon-192.png?v=2']) {
                    try { await fetch(url, { cache: 'no-store' }); } catch (error) { /* a refusal is fine */ }
                    tried.push(url);
                }
                return tried;
            })()`,
            { timeoutMs: 30_000 }
        );
        await sleep(500);
        const after = await phone.eval(
            `(async () => {
                const urls = [];
                for (const name of await caches.keys()) {
                    const cache = await caches.open(name);
                    for (const request of await cache.keys()) urls.push(request.url);
                }
                return urls;
            })()`,
            { timeoutMs: 30_000 }
        );
        const offenders = after.filter(
            (url) => url.includes('?') || url.includes('/ws') || url.includes('/pane-assets')
        );
        check(
            `after fetching ${String(probes.length)} forbidden shapes, none of them is in any cache`,
            offenders.length === 0,
            offenders.join(' ') || 'clean'
        );
        check(
            'the cache did not grow',
            after.length === cached.urls.length,
            `${String(cached.urls.length)} → ${String(after.length)}`
        );
        check(
            'no cache entry anywhere contains the string "token"',
            !after.some((url) => url.toLowerCase().includes('token')),
            'clean'
        );

        // 6. the Electron shell registers nothing ─────────────────────────────────────
        // Read before the daemon dies, since this window has nothing cached to fall back on.
        const shell = await attach(sandbox, (url) => url.includes('shellWindow'), 'the shell window');
        await shell.waitFor('document.readyState === "complete"', { timeoutMs: 60_000 });
        // Give a registration that should not happen every chance to happen.
        await sleep(1500);
        const shellState = await shell.eval(
            `(async () => ({
                marker: new URLSearchParams(location.search).get('shellWindow'),
                controller: navigator.serviceWorker.controller === null ? null : 'present',
                registrations: (await navigator.serviceWorker.getRegistrations()).length,
                caches: (await caches.keys()).length
            }))()`,
            { timeoutMs: 30_000 }
        );
        check(
            'the shell window is the client that thinks it is in a shell',
            shellState.marker === shellWindowID,
            String(shellState.marker)
        );
        check(
            'the Electron shell registered no worker and has no cache',
            shellState.controller === null && shellState.registrations === 0 && shellState.caches === 0,
            JSON.stringify(shellState)
        );

        // 5. the daemon dies and the app still opens ───────────────────────────────────
        await daemon.stop();
        const goneAt = Date.now();
        const gone = await waitForDaemonGone(sandbox.base);
        check('the daemon is gone', gone, gone ? `${String(Date.now() - goneAt)}ms after SIGTERM` : 'the port is still answering');

        const startedAt = Date.now();
        await phone.send('Page.reload', { ignoreCache: false });
        const splash = await phone.waitFor(
            'document.querySelector(\'[data-testid="connection-splash"]\') === null ? false : document.querySelector(\'[data-testid="connection-splash"]\').getAttribute("data-status") ?? "present"',
            { timeoutMs: 30_000, label: 'the client`s own connection splash' }
        );
        const elapsed = Date.now() - startedAt;
        pass(`with the daemon dead, the reload paints connection-splash (${String(splash)})`, `${String(elapsed)}ms`);

        const offline = await phone.eval(
            `({
                title: document.title,
                root: document.getElementById('root') !== null,
                text: (document.body.innerText || '').slice(0, 120),
                controller: navigator.serviceWorker.controller === null ? null : 'present'
            })`
        );
        check(
            'it is Kelpi`s own document, not a browser error page',
            offline.root && offline.title.toLowerCase().includes('kelpi'),
            JSON.stringify(offline)
        );
        check(
            'it is still the worker serving the page',
            offline.controller === 'present',
            String(offline.controller)
        );
        check(
            'the text on screen is the app`s own connecting copy',
            /kelpid|connect/i.test(offline.text),
            JSON.stringify(offline.text)
        );

        phone.close();
        shell.close();
    } finally {
        await probe?.quit();
        await daemon.stop();
        sandbox.cleanup();
    }
}

/**
 * The precache list this build actually emitted, read back out of `dist/sw.js`.
 *
 * Recomputed from `dist/` rather than trusted: the assertion above is "what is in the cache is
 * what the build said to cache", and reading the list out of the shipped worker is the only way
 * to say that without a second copy of `precacheList` living in this file.
 */
function precacheFromDist() {
    const code = fs.readFileSync(path.join(clientDist, 'sw.js'), 'utf8');
    const found = /JSON\.parse\((\"(?:[^\"\\]|\\.)*\")\)/.exec(code);
    if (found === null) throw new Error('dist/sw.js carries no injected precache list');
    return JSON.parse(JSON.parse(found[1]));
}

main()
    .then(() => {
        const failed = results.filter((entry) => !entry.ok);
        process.stdout.write(
            `\nphone-pwa-shell: ${String(results.length - failed.length)}/${String(results.length)} passed\n`
        );
        process.exit(failed.length === 0 ? 0 : 1);
    })
    .catch((error) => {
        process.stderr.write(`\nphone-pwa-shell failed: ${String(error?.stack ?? error)}\n`);
        process.exit(1);
    });
