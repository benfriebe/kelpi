#!/usr/bin/env node
/**
 * Live smoke test for the PACKAGED app (M8 wave 7's acceptance gate).
 *
 * `scripts/smoke.mjs` proves the shell works when it is run out of the workspace: `electron .`,
 * with the daemon bundle sitting two directories away and `node` on `PATH`. None of that is
 * true inside `Nex.app`, and every one of the differences is a way for a build to be broken in
 * a way no unit test can see:
 *
 *   1. `electron-forge package` produces `Nex.app` — with the fuses actually flipped in the
 *      binary, and an `app.asar` holding the bundle and nothing else;
 *   2. `Contents/Resources` carries the three staged payloads: the daemon (bundle **plus** the
 *      node-pty tree its `require` resolves to), the built client, and a Node 24 runtime;
 *   3. launched with a private environment and NOTHING pointing at any of them, the app finds
 *      its own daemon entry, runs it under its own `node`, and hands it its own client build;
 *   4. that daemon really works: it serves the packaged client bytes over HTTP, answers the
 *      **shipped `nex` CLI**, and spawns a real PTY — which is the only proof that node-pty
 *      loaded its native module from inside the bundle;
 *   5. quitting the app leaves the daemon running, exactly as in the dev flow.
 *
 * Isolation rules, same as the other smokes and non-negotiable: the production Swift app owns
 * `/tmp/nex.sock` on this machine, so every path here lives in one `mkdtemp` directory — run
 * dir, control socket, database, config, HOME and Electron's `--user-data-dir`. The private run
 * dir is also what makes check 3 meaningful: there is no daemon there to adopt, so the app has
 * to start one from its own Resources.
 *
 *   node packages/shell/scripts/packaged-smoke.mjs [options]
 *
 *     --no-build     trust the existing daemon/client/shell bundles instead of rebuilding
 *     --no-package   reuse the existing out/Nex-darwin-<arch>/Nex.app instead of repackaging
 *     --verbose      stream the app's output to stderr as it runs
 *     --keep-logs    print the captured output at the end even when everything passed
 *     --clean-app    delete the packaged app when finished (default: keep it — it is the
 *                    artifact you just built, and `out/` is gitignored)
 *     --mock-keychain  launch with Chromium's `--use-mock-keychain`. Only needed for a build
 *                    that has cookie encryption fused on (i.e. a *signed* one): the sandbox
 *                    below gives the app a private, empty `HOME`, so `OSCrypt`'s login-keychain
 *                    call would block on an authorization dialog nothing can answer and the
 *                    window would never load (see `cookieEncryptionFuseEnabled`). Off by
 *                    default on purpose — it would mask exactly that failure on an unsigned
 *                    build, which is the one this smoke has to keep catching.
 *
 * Runtime is ~30s with the Electron zip already in `~/Library/Caches/electron`.
 * Exit code 0 = every check passed.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The build-time helpers, from the same compiled module `forge.config.cjs` uses — so the fuse
 * rule asserted below is literally the rule the packager applied, not a copy of it. Resolved
 * lazily: `dist/packaging.cjs` is a build output, and `ensureBuilds()` may be what creates it.
 */
const packagingHelpers = () => createRequire(import.meta.url)(path.join(shellRoot, 'dist', 'packaging.cjs'));
const repoRoot = path.resolve(shellRoot, '..', '..');
const daemonBundle = path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js');
const clientBundle = path.join(repoRoot, 'packages', 'client', 'dist', 'index.html');
const shellBundle = path.join(shellRoot, 'dist', 'main.js');

const PROTOCOL_VERSION = 1;
/** Forge writes `out/<productName>-<platform>-<arch>/<productName>.app`. */
const appDir = path.join(shellRoot, 'out', `Nex-${process.platform}-${process.arch}`);
const appPath = path.join(appDir, 'Nex.app');
const resourcesPath = path.join(appPath, 'Contents', 'Resources');
const appBinary = path.join(appPath, 'Contents', 'MacOS', 'Nex');

/** The shipped Swift CLI: the one client of the control protocol we did not write. */
const NEX_CLI = process.env.NEX_COMPAT_CLI ?? '/Applications/Nex.app/Contents/Helpers/nex';

const argv = new Set(process.argv.slice(2));
const options = {
    build: !argv.has('--no-build'),
    package: !argv.has('--no-package'),
    verbose: argv.has('--verbose'),
    keepLogs: argv.has('--keep-logs'),
    cleanApp: argv.has('--clean-app'),
    mockKeychain: argv.has('--mock-keychain')
};

/** What `forge.config.cjs` saw, so the fuse expectation matches the build that just ran. */
const signingIdentity = (process.env.NEX_MACOS_IDENTITY ?? '').trim();

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

function skip(name, detail) {
    process.stdout.write(`  – ${name}  (skipped: ${detail})\n`);
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

/** Signal the whole process group — Electron is a tree of helper processes. */
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

async function waitFor(label, predicate, timeoutMs = 30_000, intervalMs = 100) {
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
            env: { ...process.env, ...opts.env },
            stdio: ['ignore', 'pipe', 'pipe']
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

/** One newline-JSON command over the sandbox's control socket. Never `/tmp/nex.sock`. */
function controlCommand(socketPath, payload, timeoutMs = 8000) {
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
        socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
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

function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** The executable behind a pid, as the kernel sees it (`ps -o comm=`). */
function processExecutable(pid) {
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    return (result.stdout ?? '').trim();
}

// ── build + package ─────────────────────────────────────────────────────────────────

async function ensureBuilds() {
    const steps = [
        { name: 'daemon', output: daemonBundle, args: ['--filter', '@nex/daemon', 'build'] },
        { name: 'client', output: clientBundle, args: ['--filter', '@nex/client', 'build'] },
        { name: 'shell', output: shellBundle, args: ['--filter', '@nex/shell', 'build'] }
    ];
    for (const step of steps) {
        if (!options.build && fs.existsSync(step.output)) continue;
        process.stdout.write(`building the ${step.name} bundle…\n`);
        const result = await run('pnpm', step.args);
        if (result.code !== 0) throw new Error(`${step.name} build failed:\n${result.stdout}${result.stderr}`);
    }
}

async function packageApp() {
    if (!options.package && fs.existsSync(appBinary)) {
        process.stdout.write(`reusing ${appPath}\n`);
        return;
    }
    process.stdout.write('packaging the app (electron-forge package)…\n');
    const forge = path.join(shellRoot, 'node_modules', '.bin', 'electron-forge');
    const binary = fs.existsSync(forge) ? forge : path.join(repoRoot, 'node_modules', '.bin', 'electron-forge');
    const result = await run(binary, ['package'], { cwd: shellRoot });
    if (result.code !== 0) throw new Error(`electron-forge package failed:\n${result.stdout}${result.stderr}`);
}

// ── phase 1: what is actually in the bundle ─────────────────────────────────────────

/**
 * Read an asar's header without an asar library.
 *
 * The format is a chromium Pickle followed by the payload: four little-endian uint32s, of which
 * the last is the length of the header JSON, then that JSON. Parsing it here means the smoke
 * can assert the archive's exact contents (an allowlist is only worth anything if something
 * checks it) without adding a dependency for one twelve-line function.
 */
function readAsarHeader(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const prefix = Buffer.alloc(16);
        fs.readSync(fd, prefix, 0, 16, 0);
        const jsonSize = prefix.readUInt32LE(12);
        const json = Buffer.alloc(jsonSize);
        fs.readSync(fd, json, 0, jsonSize, 16);
        return JSON.parse(json.toString('utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function bundlePhase() {
    process.stdout.write('\nphase 1 — the packaged bundle\n');

    check('electron-forge produced the app bundle', fs.existsSync(appBinary), appPath);

    // ── the asar: the shell, and only the shell ──────────────────────────────────
    const asar = path.join(resourcesPath, 'app.asar');
    if (check('the app is asar-packed', fs.existsSync(asar))) {
        const header = readAsarHeader(asar);
        const top = Object.keys(header.files ?? {}).sort();
        check(
            'the asar holds exactly package.json + dist/',
            top.join(',') === 'dist,package.json',
            `top level: ${top.join(', ')}`
        );
        const dist = Object.keys(header.files?.dist?.files ?? {}).sort();
        check(
            'dist/ inside the asar is the bundle and its sourcemap',
            dist.join(',') === 'main.js,main.js.map',
            `dist: ${dist.join(', ')}`
        );
        check(
            'no node_modules and no src/ were shipped',
            !top.includes('node_modules') && !top.includes('src'),
            'the ignore allowlist held'
        );
    }

    // ── the daemon payload, outside the asar ─────────────────────────────────────
    const daemonDir = path.join(resourcesPath, 'daemon');
    const entry = path.join(daemonDir, 'nexd.js');
    check('the daemon bundle is staged outside the asar', fs.existsSync(entry), entry);
    check('its sourcemap came too', fs.existsSync(`${entry}.map`));

    const manifestFile = path.join(daemonDir, 'payload.json');
    let manifest;
    if (check('the payload manifest is present', fs.existsSync(manifestFile))) {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        check(
            'the manifest was staged for this platform/arch',
            manifest.platform === process.platform && manifest.arch === process.arch,
            `${manifest.platform}/${manifest.arch}`
        );
    }

    // The resolution chain nexd actually uses: `require('node-pty')` from `<payload>/nexd.js`
    // walks up to `<payload>/node_modules/node-pty`, whose loader then computes
    // `prebuilds/<platform>-<arch>/pty.node` relative to its own `lib/`.
    const ptyRoot = path.join(daemonDir, 'node_modules', 'node-pty');
    check('node-pty sits where the bundle\'s require will find it', fs.existsSync(path.join(ptyRoot, 'package.json')), ptyRoot);
    check('its JS half is there', fs.existsSync(path.join(ptyRoot, 'lib', 'index.js')));
    const nativeModule = path.join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node');
    check('the native module for this platform is staged', fs.existsSync(nativeModule), path.relative(daemonDir, nativeModule));
    if (manifest !== undefined) {
        check(
            'and the manifest names that exact file',
            path.resolve(daemonDir, manifest.node_pty?.native_module ?? '') === nativeModule,
            manifest.node_pty?.native_module
        );
    }
    const helper = path.join(path.dirname(nativeModule), 'spawn-helper');
    let helperExecutable = false;
    try {
        fs.accessSync(helper, fs.constants.X_OK);
        helperExecutable = true;
    } catch {
        helperExecutable = false;
    }
    check('the fork helper kept its +x bit', helperExecutable, helper);

    // ── the client build ─────────────────────────────────────────────────────────
    check('the client build is staged', fs.existsSync(path.join(resourcesPath, 'client', 'index.html')));

    // ── the Node runtime ─────────────────────────────────────────────────────────
    const node = path.join(resourcesPath, 'node');
    if (check('a Node runtime is staged beside the app', fs.existsSync(node))) {
        check('it is a real file, not a symlink into the build machine', !fs.lstatSync(node).isSymbolicLink());
        const probe = spawnSync(node, ['-p', 'process.versions.node + " " + process.arch'], { encoding: 'utf8' });
        const [version = '', arch = ''] = (probe.stdout ?? '').trim().split(' ');
        check(
            'it runs, and it is Node 24 for this architecture',
            Number.parseInt(version, 10) >= 24 && arch === process.arch,
            `node ${version} ${arch}`
        );
    }

    // ── the icon ─────────────────────────────────────────────────────────────────
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    const iconName = /<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    const iconFile = iconName === undefined ? undefined : path.join(resourcesPath, iconName);
    check(
        'the bundle carries the generated icon (not the stock Electron one)',
        iconFile !== undefined &&
            fs.existsSync(iconFile) &&
            fs.readFileSync(iconFile).equals(fs.readFileSync(path.join(shellRoot, 'out', 'staging', 'icon.icns'))),
        iconName
    );
    check(
        'the bundle id is distinct from the shipped Swift app',
        /<key>CFBundleIdentifier<\/key>\s*<string>com\.benfriebe\.newnex<\/string>/.test(plist)
    );
}

/** Fuses are flipped in the binary itself, so this reads them back out of it. */
async function fusePhase() {
    const wire = await getCurrentFuseWire(appBinary);
    const state = (fuse) => (wire[fuse] === FuseState.ENABLE ? 'enabled' : 'disabled');
    check(
        'runAsNode is fused off (stack.md: the daemon must not be ELECTRON_RUN_AS_NODE)',
        wire[FuseV1Options.RunAsNode] === FuseState.DISABLE,
        state(FuseV1Options.RunAsNode)
    );
    check(
        'NODE_OPTIONS and --inspect are fused off',
        wire[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === FuseState.DISABLE &&
            wire[FuseV1Options.EnableNodeCliInspectArguments] === FuseState.DISABLE
    );
    check(
        'the app can only load from the asar, and its integrity is checked',
        wire[FuseV1Options.OnlyLoadAppFromAsar] === FuseState.ENABLE &&
            wire[FuseV1Options.EnableEmbeddedAsarIntegrityValidation] === FuseState.ENABLE
    );
    /**
     * Cookie encryption travels with the code signature (`cookieEncryptionFuseEnabled`). Fused
     * on, Chromium will not serve a single request until `OSCrypt` has fetched its key from the
     * login keychain — and on an ad-hoc-signed build that call blocks forever inside
     * `SecItemAdd → makeLoginAuthUI → AuthorizationCopyRights`, waiting on a dialog no
     * automated launch can answer. The window then never loads and *nothing* says why: no
     * `did-fail-load`, no console error, just an empty document (run-F ▸ N2, reproduced 5/5).
     *
     * So this is the early, static guard for that whole failure mode: it fires in phase 1, from
     * the fuse wire in the binary, before anything is launched.
     */
    const cookieExpected = packagingHelpers().cookieEncryptionFuseEnabled(signingIdentity);
    const cookieActual = wire[FuseV1Options.EnableCookieEncryption] === FuseState.ENABLE;
    check(
        cookieExpected
            ? 'cookie encryption is on (this build is signed, so the keychain key has a stable owner)'
            : 'cookie encryption is off (an ad-hoc build must not block on the login keychain)',
        cookieActual === cookieExpected,
        cookieActual === cookieExpected
            ? `NEX_MACOS_IDENTITY ${signingIdentity === '' ? 'unset' : 'set'}`
            : cookieActual
              ? 'the fuse is ON but this build is ad-hoc signed (NEX_MACOS_IDENTITY unset) — it will hang ' +
                'the browser process on a login-keychain authorization dialog and never load its window'
              : 'the fuse is OFF but NEX_MACOS_IDENTITY is set — repackage so the signed build gets it ' +
                '(if you only exported the variable for this run, the app it is checking was built without it)'
    );
}

// ── the sandbox the packaged app runs in ────────────────────────────────────────────

/**
 * A throwaway environment with **nothing** pointing at the daemon, the client or Node: no
 * `NEXD_ENTRY`, no `NEXD_NODE`, no `NEXD_CLIENT_DIR`. Everything the app needs, it has to find
 * inside its own bundle — which is the whole point of the launch phase.
 */
async function makeSandbox() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexpkg-'));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    const socketPath = path.join(root, 'nexd.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');
    fs.writeFileSync(path.join(root, 'config'), '');

    const httpPort = await freePort();
    const controlPort = await freePort();
    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        NEXD_RUN_DIR: path.join(root, 'run'),
        NEXD_SOCKET_PATH: socketPath,
        NEXD_TCP_PORT: String(controlPort),
        NEXD_DB_PATH: path.join(root, 'nex.db'),
        NEXD_CONFIG_PATH: path.join(root, 'config'),
        NEXD_HTTP_PORT: String(httpPort),
        NEXD_HTTP_HOST: '127.0.0.1'
    };

    return {
        root,
        home,
        env,
        userData,
        runDir: env.NEXD_RUN_DIR,
        runSocket: path.join(env.NEXD_RUN_DIR, `daemon-v${PROTOCOL_VERSION}.sock`),
        pidFile: path.join(env.NEXD_RUN_DIR, `daemon-v${PROTOCOL_VERSION}.pid`),
        httpPort,
        controlPort,
        base: `http://127.0.0.1:${String(httpPort)}`,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

function startApp(sandbox) {
    const lines = [];
    const args = [`--user-data-dir=${sandbox.userData}`];
    // Only when asked for: see `--mock-keychain` in the header. A default-on switch here would
    // hide the very failure phase 2 exists to catch.
    if (options.mockKeychain) args.push('--use-mock-keychain');
    const child = spawn(appBinary, args, {
        cwd: sandbox.home,
        // A bare object, NOT `{...process.env}`: an inherited NEXD_* from the developer's shell
        // would quietly invalidate the entire phase.
        env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let pending = '';
    const collect = (chunk) => {
        if (options.verbose) process.stderr.write(`[app] ${chunk}`);
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
                    if (exited) throw new Error(`the app exited (code ${String(exitCode)}) before ${label}`);
                    return lines.find((line) => pattern.test(line));
                },
                timeoutMs
            ),
        async quit(signal = 'SIGTERM') {
            if (!exited) {
                if (signal === 'SIGTERM') child.kill('SIGTERM');
                else signalGroup(child, signal);
                await Promise.race([new Promise((resolve) => child.on('exit', resolve)), raceTimeout(20_000)]);
            }
            signalGroup(child, 'SIGKILL');
            await sleep(150);
            releaseChild(child);
        }
    };
}

/** The shipped CLI, pointed at the sandbox daemon over TCP (its only non-hardcoded transport). */
function cli(sandbox, args, timeoutMs = 20_000) {
    return new Promise((resolve) => {
        const child = spawn(NEX_CLI, args, {
            cwd: sandbox.home,
            env: {
                PATH: sandbox.env.PATH,
                HOME: sandbox.home,
                NEX_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        timer.unref();
        child.on('close', () => clearTimeout(timer));
    });
}

// ── phase 2: run it ─────────────────────────────────────────────────────────────────

async function launchPhase() {
    process.stdout.write('\nphase 2 — launch the packaged app\n');
    const sandbox = await makeSandbox();
    let app;
    let daemonPid;
    try {
        // Nothing to adopt: the run dir does not exist yet, so a daemon can only come from the
        // app's own Resources. (This is also the isolation guarantee — the developer's real
        // daemon lives in a different run dir and is never touched.)
        check('the sandbox run dir starts empty', !fs.existsSync(sandbox.runDir), sandbox.runDir);

        app = startApp(sandbox);

        const clientDir = await app.waitForLine(/daemon client dir/, 'the client-dir line');
        check(
            'the shell hands the daemon its own bundled client build',
            clientDir.includes(path.join(resourcesPath, 'client')),
            clientDir.trim()
        );

        const spawned = await app.waitForLine(/daemon spawned/, 'the daemon-spawned line');
        check(
            'it starts the daemon from its own Resources',
            spawned.includes(`entry=${path.join(resourcesPath, 'daemon', 'nexd.js')}`),
            spawned.trim()
        );
        check(
            '…running it under the bundled Node, not Electron and not a PATH node',
            spawned.includes(`node=${path.join(resourcesPath, 'node')}`),
            'no ELECTRON_RUN_AS_NODE anywhere'
        );

        await app.waitForLine(/daemon ready/, 'the daemon-ready line');
        pass('the daemon came up', sandbox.base);

        const record = JSON.parse(fs.readFileSync(sandbox.pidFile, 'utf8'));
        daemonPid = record.pid;
        check(
            'the daemon process really is the bundled Node binary',
            processExecutable(daemonPid) === path.join(resourcesPath, 'node'),
            processExecutable(daemonPid)
        );

        const health = await fetch(`${sandbox.base}/healthz`).then((response) => response.json());
        check('it serves HTTP', health.ok === true, `pid ${String(health.pid)} protocol ${String(health.protocol)}`);

        // ── the client comes out of Resources, byte for byte ─────────────────────
        const served = await fetch(`${sandbox.base}/`).then((response) => response.text());
        const staged = fs.readFileSync(path.join(resourcesPath, 'client', 'index.html'), 'utf8');
        check('the daemon serves the client staged in Resources', served === staged, `${String(served.length)} bytes`);
        check('…and not its "client not built" placeholder', !served.includes('client not built'));

        const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(served)?.[0];
        if (asset !== undefined) {
            const response = await fetch(`${sandbox.base}${asset}`);
            const size = fs.statSync(path.join(resourcesPath, 'client', asset)).size;
            check(
                'its hashed assets are served from there too',
                response.ok && (await response.arrayBuffer()).byteLength === size,
                asset
            );
        }

        /**
         * The renderer-booted check, and the one that stayed red through run-F.
         *
         * It is deliberately *not* fatal to the phase: everything after it talks to the daemon,
         * so a dead window should cost one red check and still let the rest report. What it
         * must do is say why — the failure mode is completely silent from the outside (no
         * `did-fail-load`, no crash, an empty document forever), so the diagnosis has to be
         * carried here rather than looked up.
         */
        try {
            await app.waitForLine(/did-finish-load/, 'did-finish-load', 30_000);
            pass('the window loaded the daemon-served UI');
        } catch (error) {
            const loading = app.lines.find((line) => line.includes('loading http')) ?? '(no "loading" line)';
            fail(
                'the window loaded the daemon-served UI',
                `${error instanceof Error ? error.message : String(error)} — the shell asked for the page ` +
                    `(${loading.trim()}) and the renderer never came back.\n` +
                    '      The daemon is healthy above, so this is the window, not the payload. Check, in order:\n' +
                    '        · cookie encryption fused on without a signing identity — the browser process blocks\n' +
                    '          in SecItemAdd → makeLoginAuthUI on a keychain dialog nothing can answer, and no\n' +
                    '          navigation ever commits (phase 1 asserts the rule; re-run with --mock-keychain if\n' +
                    "          this build IS signed, since the sandbox's private HOME has no login keychain);\n" +
                    '        · attach CDP (--remote-debugging-port) and read the page target for a real page error.\n' +
                    "      Note: an 'Electron sandboxed_renderer.bundle.js script failed to run' console line is\n" +
                    '      NOT a signal — the dev Electron prints it too, on a window that loads fine.'
            );
        }
        await app.waitForLine(/status ws connected/, 'the status WebSocket');
        pass('the main process opened its status WebSocket');
        check(
            'auto-update stayed off (no network call in the packaged default)',
            app.text().includes('auto-update: disabled'),
            app.lines.find((line) => line.includes('auto-update')) ?? ''
        );

        // ── the shipped CLI drives it, and a real PTY runs ───────────────────────
        if (fs.existsSync(NEX_CLI)) {
            const doctor = await cli(sandbox, ['doctor', '--json']);
            const ping = JSON.parse(doctor.stdout).checks.find((entry) => entry.name === 'ping');
            check('the shipped nex CLI gets a ping round-trip', ping?.status === 'pass', ping?.detail);

            const workspace = await cli(sandbox, ['workspace', 'create', '--name', 'packaged', '--json']);
            const workspaceID = JSON.parse(workspace.stdout || '{}').workspace_id;
            check('`nex workspace create` works against the packaged daemon', workspace.code === 0 && typeof workspaceID === 'string');

            const pane = await cli(sandbox, ['pane', 'create', '--workspace', 'packaged', '--name', 'w1', '--json']);
            const paneID = JSON.parse(pane.stdout || '{}').pane_id;
            check('`nex pane create` spawns a pane', pane.code === 0 && typeof paneID === 'string', paneID);

            // The real proof that node-pty loaded its native module out of the app bundle:
            // bytes went through a pty, a shell ran, and the output came back.
            const marker = `packaged-pty-${String(process.pid)}`;
            await cli(sandbox, ['pane', 'send', '--target', paneID, `echo ${marker}`]);
            const captured = await waitFor(
                'the PTY echo',
                async () => {
                    const capture = await cli(sandbox, ['pane', 'capture', '--target', paneID]);
                    return capture.stdout.includes(`\n${marker}`) ? capture.stdout : undefined;
                },
                15_000,
                500
            );
            check('a real PTY runs — node-pty loaded from inside the bundle', captured.includes(marker), marker);

            const list = await cli(sandbox, ['pane', 'list', '--json']);
            check(
                '`nex pane list` sees it',
                list.code === 0 && JSON.parse(list.stdout).some((entry) => entry.id === paneID),
                `${String(JSON.parse(list.stdout || '[]').length)} panes`
            );
        } else {
            skip('the shipped nex CLI drives the packaged daemon', `${NEX_CLI} is not installed`);
            const pane = await controlCommand(sandbox.runSocket, { command: 'pane-create', name: 'w1' });
            check('a pane can still be created over the control socket', pane?.ok === true, JSON.stringify(pane));
        }

        // ── quit: the sessions outlive the app ───────────────────────────────────
        await app.quit('SIGTERM');
        check('the app exits cleanly on a quit request', app.exitCode === 0, `exit code ${String(app.exitCode)}`);
        check('the quit path says it is leaving the daemon running', app.text().includes('quit: leaving the daemon running'));

        check('the daemon process is still alive', processAlive(daemonPid), `pid ${String(daemonPid)}`);
        const ping = await controlCommand(sandbox.runSocket, { command: 'ping' });
        check('it still answers ping after the app is gone', ping?.ok === true, JSON.stringify(ping));
        const stillServing = await fetch(`${sandbox.base}/healthz`).then((response) => response.ok);
        check('and still serves the client', stillServing);

        return { appLog: app.text() };
    } finally {
        await app?.quit('SIGKILL');
        // The daemon is DETACHED by design, so the harness stops it explicitly. This is the one
        // place a shell-started daemon gets signalled, and it is the test doing it.
        if (daemonPid !== undefined && processAlive(daemonPid)) {
            try {
                process.kill(daemonPid, 'SIGTERM');
            } catch {
                // Already gone.
            }
            for (let attempt = 0; attempt < 60 && processAlive(daemonPid); attempt += 1) await sleep(100);
            if (processAlive(daemonPid)) {
                try {
                    process.kill(daemonPid, 'SIGKILL');
                } catch {
                    // Already gone.
                }
            }
        }
        sandbox.cleanup();
    }
}

// ── main ────────────────────────────────────────────────────────────────────────────

async function main() {
    if (process.platform !== 'darwin') {
        process.stdout.write('packaged-smoke only covers the macOS bundle; skipping.\n');
        return;
    }

    await ensureBuilds();
    await packageApp();

    const logs = [];
    try {
        bundlePhase();
        await fusePhase();
    } catch (error) {
        fail('phase 1 (bundle)', error instanceof Error ? error.message : String(error));
    }
    try {
        logs.push(await launchPhase());
    } catch (error) {
        fail('phase 2 (launch)', error instanceof Error ? error.message : String(error));
    }

    if (options.cleanApp) fs.rmSync(appDir, { recursive: true, force: true });

    const failed = results.filter((result) => !result.ok);
    process.stdout.write(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed\n`);
    if (failed.length > 0 || options.keepLogs) {
        for (const entry of logs) {
            if (entry?.appLog !== undefined) process.stdout.write(`\n── app log ──\n${entry.appLog}\n`);
        }
    }
    if (failed.length > 0) process.exitCode = 1;
}

await main();
// Every child is dead and released by here; exit explicitly so a stray handle from a torn-down
// Electron helper cannot turn a finished run into a hang.
process.exit(process.exitCode ?? 0);
