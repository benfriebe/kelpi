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
 *   5. with no daemon running, the shell SPAWNS one, detached, and it survives the shell;
 *   6. a pane's shell is BORN at the width the window will render it at — on a fresh install,
 *      where only the daemon waiting for the client's first measurement can achieve it, and on
 *      a relaunch after a daemon restart, where the persisted grid does. Both are asserted
 *      against a real zsh with a p10k-shaped instant prompt, because the defect they exist for
 *      (a stranded half-width prompt copy that never reflows) is only visible there.
 *
 * Isolation rules (non-negotiable — the production Swift app owns the real socket on a dev
 * machine): every path is inside a fresh `mkdtemp` directory, the control socket is
 * `<tmp>/kelpid.sock` and NEVER `/tmp/nex.sock`, the run dir / DB / config / HOME are throwaway,
 * and Electron gets its own `--user-data-dir` so it cannot collide with (or steal the
 * single-instance lock from) a real Kelpi shell.
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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(shellRoot, '..', '..');
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
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

// ── $HOME safety (§APP-006) ─────────────────────────────────────────────────────────

/**
 * The one thing this smoke must never do.
 *
 * The first port of the launch-time skill refresh wrote into the DEVELOPER'S home while this
 * harness had `HOME` pointed at a throwaway directory, because Electron's `app.getPath('home')`
 * asks the OS and ignores `$HOME`. The state of the machine's own document is therefore
 * captured before anything launches, and re-checked after every phase that could have written:
 * a regression that reintroduces an OS-level home lookup fails here, loudly, instead of being
 * discovered by the person who lost the file.
 */
function readIfPresent(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

const realHome = process.env.HOME ?? os.homedir();
const realHomeSkillDir = path.join(realHome, '.claude', 'skills', 'nex-agentic');
const realHomeSkillFile = path.join(realHomeSkillDir, 'SKILL.md');
const realHomeSkillBefore = readIfPresent(realHomeSkillFile);
const realHomeMarkerBefore = readIfPresent(path.join(realHomeSkillDir, '.kelpi-skill.json'));

/** The document the app ships — what a heal or an install has to land, byte for byte. */
const bundledSkillFile = path.join(repoRoot, 'packages', 'cli', 'resources', 'skills', 'nex-agentic', 'SKILL.md');
/** The bytes an older build (or a hand edit) left behind, in the fixtures that carry one. */
const DRIFTED_SKILL = '# nex-agentic\n\nlast month\n';

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** Every `SKILL.md.bak-…` sitting in a sandbox's skill directory, sorted. */
function skillBackups(sandbox) {
    return fs
        .readdirSync(sandbox.installedSkill)
        .filter((entry) => entry.startsWith('SKILL.md.bak-'))
        .sort();
}

/**
 * Put a sandbox HOME into the PRE-MARKER state: a drifted document with nothing beside it.
 *
 * This is what every copy `kelpi install-hooks` ever wrote looks like — it leaves no ownership
 * marker — and it is the case §APP-006's migration exists for. Returns the bytes laid down so
 * the phase can assert the backup preserved exactly them.
 */
function layDriftedSkill(sandbox) {
    fs.rmSync(sandbox.skillMarkerFile, { force: true });
    for (const entry of skillBackups(sandbox)) fs.rmSync(path.join(sandbox.installedSkill, entry), { force: true });
    fs.writeFileSync(sandbox.skillFile, DRIFTED_SKILL);
    return DRIFTED_SKILL;
}

function assertRealHomeUntouched(label) {
    check(
        `${label}: the machine's own ~/.claude/skills document is untouched`,
        readIfPresent(realHomeSkillFile) === realHomeSkillBefore,
        realHomeSkillBefore === null ? 'absent before, absent after' : `${realHomeSkillFile} unchanged`
    );
    check(
        `${label}: and nothing was written beside it`,
        readIfPresent(path.join(realHomeSkillDir, '.kelpi-skill.json')) === realHomeMarkerBefore,
        'no marker appeared in the real home'
    );
}

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
 * One newline-JSON command over a unix control socket — the same protocol the `kelpi` CLI
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

/**
 * Every path the daemon and the shell touch, inside one temp directory. `KELPID_SOCKET_PATH`
 * is asserted to not be the production socket — a bug here would reach the user's real app.
 */
async function makeSandbox(label, { skill = 'marked-edited' } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexshell-${label}-`));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });

    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const configPath = path.join(root, 'config');
    // A hotkey the shell will try to register: unusual enough not to fight a real app.
    fs.writeFileSync(configPath, 'global-hotkey = ctrl+alt+shift+f12\nglobal-hotkey-hide-on-repress = true\n');

    /**
     * §APP-006's fixture, inside the throwaway HOME so nothing here can reach a real one.
     *
     *   - `marked-edited`: this app installed the document and the user then EDITED it, so the
     *     ownership marker beside it no longer describes the bytes. The launch must leave the
     *     document, and the marker, exactly as they are — permanently.
     *   - `drifted`: a document that differs from the bundle with NO marker beside it (what
     *     `kelpi install-hooks` leaves). The launch must migrate it: old bytes moved aside to a
     *     `.bak-` name, the bundle installed, a marker written. Laid down by `layDriftedSkill`
     *     rather than here, because phase 1 drives it on its SECOND launch.
     *   - `empty`: the directory exists — the user opted in — but the document is missing. The
     *     launch must fill it in from the bundle.
     *
     * The fourth case, a HOME with no skill directory at all, is `skill.test.ts`'s: it needs an
     * absence to assert, and a smoke phase that installed nothing would be indistinguishable
     * from one where the step never ran.
     */
    const installedSkill = path.join(home, '.claude', 'skills', 'nex-agentic');
    fs.mkdirSync(installedSkill, { recursive: true });
    const skillFile = path.join(installedSkill, 'SKILL.md');
    const skillMarkerFile = path.join(installedSkill, '.kelpi-skill.json');
    let skillFixtureBytes = null;
    let skillMarkerBytes = null;
    if (skill === 'marked-edited') {
        // The marker records the hash of what this app INSTALLED; the document on disk is that
        // plus the user's own line, so the two disagree — which is the whole test.
        const installed = readIfPresent(bundledSkillFile) ?? '# nex-agentic\n';
        skillFixtureBytes = `${installed}\n## my own notes — hands off\n`;
        skillMarkerBytes = `${JSON.stringify(
            {
                installedHash: sha256(installed),
                sourceHash: sha256(installed),
                version: null,
                appVersion: '0.0.0-smoke',
                installedAt: '2026-08-01T00:00:00.000Z',
                by: 'kelpi-shell'
            },
            null,
            2
        )}\n`;
        fs.writeFileSync(skillFile, skillFixtureBytes);
        fs.writeFileSync(skillMarkerFile, skillMarkerBytes);
    } else if (skill === 'drifted') {
        skillFixtureBytes = DRIFTED_SKILL;
        fs.writeFileSync(skillFile, skillFixtureBytes);
    }

    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        // The unpackaged shell has no `Contents/Resources/cli/skills`, so the launch step is
        // pointed at the checkout's copy — the same escape hatch `--skill-source` gives the CLI.
        // It only names a SOURCE; the destination still comes from the HOME above.
        KELPI_SKILL_SOURCE: path.join(repoRoot, 'packages', 'cli', 'resources', 'skills', 'nex-agentic'),
        KELPID_RUN_DIR: path.join(root, 'run'),
        KELPID_SOCKET_PATH: socketPath,
        KELPID_TCP_PORT: String(await freePort()),
        KELPID_DB_PATH: path.join(root, 'nex.db'),
        KELPID_CONFIG_PATH: configPath,
        KELPID_HTTP_PORT: String(await freePort()),
        KELPID_HTTP_HOST: '127.0.0.1',
        KELPID_ENTRY: daemonEntry,
        // Point the daemon at the built client when there is one; the daemon serves its own
        // "client not built" page otherwise, which still exercises window loading.
        ...(fs.existsSync(path.join(clientDist, 'index.html')) ? { KELPID_CLIENT_DIR: clientDist } : {})
    };

    return {
        root,
        env,
        userData,
        installedSkill,
        skillFile,
        skillMarkerFile,
        skillFixture: skill,
        skillFixtureBytes,
        skillMarkerBytes,
        runDir: env.KELPID_RUN_DIR,
        socketPath,
        httpPort: Number(env.KELPID_HTTP_PORT),
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

/**
 * Launch the app a SECOND time with files on argv, the way `open -a Kelpi.app notes.md` does on a
 * machine where Kelpi is already running (CONT-124/125, APP-100/101).
 *
 * Finder's own `open-file` event cannot be raised from a script — LaunchServices delivers it —
 * but it and this route end in the same place: the same extension filter, the same `forwardOpen`,
 * the same `open` control command, the same window raise. This is the half of that path no unit
 * test can reach; the buffer-then-drain race in front of it is `src/launch.test.ts`.
 *
 * Resolves with the second process's own output, which is expected to be one line saying it is
 * exiting because another shell owns the single-instance lock.
 */
async function launchWithFiles(sandbox, files) {
    const child = spawn(electronBinary(), ['.', ...files, `--user-data-dir=${sandbox.userData}`], {
        cwd: shellRoot,
        env: { ...sandbox.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk) => {
        output += chunk;
        if (options.verbose) process.stderr.write(`[second launch] ${chunk}`);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const code = await Promise.race([
        new Promise((resolve) => child.on('exit', (value) => resolve(value ?? -1))),
        raceTimeout(20_000).then(() => 'timeout')
    ]);
    if (code === 'timeout') {
        child.kill('SIGKILL');
        return { code: -1, output, timedOut: true };
    }
    releaseChild(child);
    return { code, output, timedOut: false };
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

        // §AGNT-056: the shell tells the window whether the app is ACTIVE, because the pane grid
        // (in the renderer) gates its 600 ms status-clear on it and cannot see the OS. Reported
        // on every focus/blur, and once on connect so a window that came up in the background
        // is not assumed to be in front of somebody.
        const activation = await shell.waitForLine(/activation report:/, 'the activation report');
        check(
            'the shell reports the window’s activation to its clients (§AGNT-056)',
            /activation report: (active|inactive)/.test(activation),
            activation.trim()
        );

        const hotkey = await shell.waitForLine(/global-hotkey/, 'the global hotkey line');
        check(
            'the global hotkey from the config file was applied',
            hotkey.includes('Control+Alt+Shift+F12'),
            hotkey.trim()
        );

        const tray = await shell.waitForLine(/tray ready/, 'the tray');
        check('a tray item was created', tray !== undefined, tray.trim());
        // UI-FIDELITY U2 / defect N16: the tray's whole gesture is its context menu. macOS opens
        // that menu on a left-click and Electron emits `click` next to it, so a `click` handler
        // that raised the window made one gesture do two things — where the shipped status item
        // only toggles its popover (`StatusBarController.swift:32-39,117-126`). `handlers=` is a
        // count of listeners on the REAL `Tray`, which is the only view of one from out here.
        check(
            '…with no event handler on it — the context menu is the whole gesture',
            tray.includes('handlers=0'),
            tray.trim()
        );

        // APP-020/APP-026/APP-027: the application menu is not observable from outside the
        // process, so the shell logs what it built and this is the check.
        const menu = await shell.waitForLine(/menu: Kelpi /, 'the application menu');
        check('the app menu offers "Check for Updates…"', menu.includes('Check for Updates…'), menu.trim());
        check('the File menu offers "Preview Markdown…" on ⌘O', menu.includes('Preview Markdown… (⌘O)'), menu.trim());
        check('the Help menu offers "Kelpi Help" on ⌘?', menu.includes('Kelpi Help (⌘?)'), menu.trim());
        // §APP-028 / §SET-194: this smoke runs an UNPACKAGED shell (`electron .` against the
        // checkout), which is this port's `#if DEBUG`, so the Debug menu must be there. The
        // other half — that it is NOT there in a built .app — is `packaged-smoke.mjs`.
        check(
            'a dev build carries Debug ▸ Seed Test Group (APP-028/SET-194)',
            menu.includes('Debug ▸ Seed Test Group (dev build)'),
            menu.trim()
        );

        /*
         * §APP-006 case (a) — the sovereignty rule, which is the half that matters most.
         *
         * This HOME carries a document THIS APP INSTALLED (the marker beside it says so) that
         * the user has since EDITED, so the bytes no longer hash to the marker. The launch must
         * leave both exactly as it found them, and must never "helpfully" move the document
         * aside either: this decision is permanent, not a one-launch grace period.
         *
         * Case (b) — a drifted document with NO marker, which the launch MIGRATES — is asserted
         * against the second shell below, and `phase 2` asserts the third case: an opted-in
         * directory with no document at all gets one.
         */
        const refreshLine = await shell.waitForLine(/skill-refresh:/, 'the skill-refresh step', 20_000);
        check('the launch order reaches its documentation-refresh slot', refreshLine !== undefined, refreshLine.trim());
        check(
            'it declines to touch a marked document whose bytes it cannot account for',
            refreshLine.includes('skipped (user-modified)'),
            refreshLine.trim()
        );
        check(
            'and the edited fixture is byte-for-byte as laid down',
            readIfPresent(sandbox.skillFile) === sandbox.skillFixtureBytes,
            'document unchanged'
        );
        check(
            'the marker beside it was not rewritten either — no write means no write',
            readIfPresent(sandbox.skillMarkerFile) === sandbox.skillMarkerBytes,
            'marker unchanged'
        );
        check(
            'and a document it will not replace is never backed up',
            skillBackups(sandbox).length === 0,
            'no SKILL.md.bak-* beside it'
        );
        assertRealHomeUntouched('phase 1a');

        // ── a file opened from outside the app (CONT-124/125, APP-100/101) ──────────
        const markdownTarget = path.join(sandbox.env.HOME, 'smoke-open.md');
        fs.writeFileSync(markdownTarget, '# smoke open\n\nHanded to a second launch on argv.\n');
        const ignoredTarget = path.join(sandbox.env.HOME, 'smoke-open.png');
        fs.writeFileSync(ignoredTarget, 'not markdown at all');
        const beforeOpen = await controlCommand(sandbox.runSocket, { command: 'pane-list' });
        const relaunch = await launchWithFiles(sandbox, [markdownTarget, ignoredTarget]);
        check(
            'a second launch exits instead of starting a second shell (APP-001)',
            relaunch.code === 0 && !relaunch.timedOut,
            `exit ${String(relaunch.code)}`
        );
        check(
            'and it says why, naming the single-instance lock',
            relaunch.output.includes('single-instance lock'),
            relaunch.output.trim().split('\n').slice(-1)[0] ?? '(no output)'
        );
        const openedPane = await waitFor(
            'the markdown pane the second launch asked for',
            async () => {
                const listed = await controlCommand(sandbox.runSocket, { command: 'pane-list' });
                return (listed?.panes ?? []).find(
                    (entry) => entry.type === 'markdown' && entry.file_path === markdownTarget
                );
            },
            15_000
        );
        check(
            'a markdown file on a second launch opens as a markdown pane in the running app',
            openedPane !== undefined,
            `${String(openedPane?.id)} → ${String(openedPane?.file_path)}`
        );
        // CONT-125: the window is raised for a file that goes out. A raise is invisible from
        // here, so the shell logs it and this is the check.
        const raised = await shell.waitForLine(/open: raised the window/, 'the window raise', 10_000);
        check('the app raised its window for the file it was handed (CONT-125)', raised !== undefined, raised.trim());
        /*
         * N15: every raise goes through ONE path now (`window-present.ts`), and that path is what
         * a reopened window depends on — a window that is only `show()`n comes up unable to take
         * a keystroke. The steps it took are logged because keyboard focus is not observable from
         * out here: a synthesised key would bypass exactly the native focus this is about.
         *
         * This raise is of a window that already exists; the `created` variant of the same line
         * is what a Dock reopen prints, and it runs the same three calls.
         */
        const presented = await shell.waitForLine(/window: presented \(/, 'the window focus handoff', 10_000);
        check(
            'the raise focused the window and handed focus to its web contents (N15)',
            presented !== undefined &&
                presented.includes('focused') &&
                presented.includes('contents-focused'),
            presented?.trim() ?? '(no line)'
        );
        const afterOpen = await controlCommand(sandbox.runSocket, { command: 'pane-list' });
        // CONT-124: `open` renders whatever it is handed AS MARKDOWN, so the `.png` must never
        // have been forwarded — one new pane, not two.
        check(
            'the non-markdown path beside it was filtered out, not opened (CONT-124)',
            !(afterOpen?.panes ?? []).some((entry) => String(entry.file_path ?? '').endsWith('.png')) &&
                (afterOpen?.panes ?? []).length === (beforeOpen?.panes ?? []).length + 1,
            `${String((beforeOpen?.panes ?? []).length)} → ${String((afterOpen?.panes ?? []).length)} panes`
        );

        // A real agent lifecycle, driven over the control socket exactly as the `kelpi` CLI's
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
        // dialog cannot be clicked from here, so the assertion is that the app is still alive —
        // plus, since §AGNT-116, WHICH dialog the hybrid chose (`./quit-prompt.ts`).
        //
        // §APP-006 case (b) rides along on this launch: before it starts, the sandbox HOME is
        // rewritten into the pre-marker state — a drifted document with NOTHING beside it, which
        // is what `kelpi install-hooks` leaves and what case (a)'s rule used to strand forever.
        const driftedBytes = layDriftedSkill(sandbox);
        const second = startShell(sandbox);
        try {
            await second.waitForLine(/status ws connected/, 'the second shell handshake');
            pass('a second shell attaches to the same daemon');

            /*
             * The migration, on a real launch: the old bytes are MOVED ASIDE (the divergence
             * from the Swift, which simply overwrites them), the bundle is installed, and the
             * marker that makes this one-time goes down beside it. From here the copy is marked,
             * so the very next user edit lands in case (a) above and is theirs forever.
             */
            const healLine = await second.waitForLine(/skill-refresh:/, 'the second shell’s skill-refresh step', 20_000);
            check(
                'a drifted copy with no marker is healed rather than declined',
                healLine.includes('healed (backed up drifted copy to SKILL.md.bak-'),
                healLine.trim()
            );
            const backups = skillBackups(sandbox);
            check(
                'the old document was moved aside — exactly one backup, carrying exactly its bytes',
                backups.length === 1 &&
                    readIfPresent(path.join(sandbox.installedSkill, backups[0] ?? '')) === driftedBytes,
                backups.join(', ')
            );
            check(
                'and what replaced it is byte-for-byte the bundled document',
                readIfPresent(sandbox.skillFile) === readIfPresent(bundledSkillFile),
                sandbox.skillFile
            );
            const healedMarker = JSON.parse(readIfPresent(sandbox.skillMarkerFile) ?? 'null');
            check(
                'with the ownership marker that makes the migration a one-time event',
                healedMarker !== null &&
                    healedMarker.by === 'kelpi-shell' &&
                    healedMarker.installedHash === sha256(readIfPresent(bundledSkillFile) ?? ''),
                JSON.stringify(healedMarker)
            );
            assertRealHomeUntouched('phase 1b');
            // The renderer route needs a page that has finished loading and installed the gate;
            // waiting for the load is what makes the route assertion below deterministic rather
            // than a race with `webContents.isLoading()`.
            await second.waitForLine(/did-finish-load/, 'the second shell’s page load');

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

            // §AGNT-116: the hybrid's decision, on the real ⌘Q path (a SIGTERM becomes
            // `app.quit()` → `before-quit` → the gate). With the client's own bundle being
            // served, the confirmation is DRAWN BY THE RENDERER — the only route on which Quit
            // can be destructive and Cancel the default; without one, the same gate falls back
            // to `dialog.showMessageBox`, which is the invariant that made this hybrid safe.
            const route = await second.waitForLine(/quit: asking (in the renderer|with the native dialog)/, 'the quit dialog route', 10_000);
            const rendererServed = fs.existsSync(path.join(clientDist, 'index.html'));
            check(
                rendererServed
                    ? 'the quit confirmation is routed to the renderer’s own dialog (§AGNT-116)'
                    : 'with no client bundle to draw it, the quit confirmation falls back to the native dialog',
                rendererServed ? route.includes('in the renderer') : route.includes('native dialog'),
                route.trim()
            );

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
    // §APP-006's other half: this HOME has opted into the skill (the directory is there) but
    // carries no document, so the launch step has to fill it in from the bundle.
    const sandbox = await makeSandbox('spawn', { skill: 'empty' });
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

        /*
         * §APP-006 — the install case. The sandbox HOME has the skill directory and no
         * document; the launch writes the bundled one into it, byte for byte, plus the
         * ownership marker that is what lets a LATER launch tell its own copy from a user's.
         */
        const refreshLine = await shell.waitForLine(/skill-refresh:/, 'the skill-refresh step', 20_000);
        check(
            'the launch installs the bundled skill into an opted-in HOME',
            refreshLine.includes('installed (absent)'),
            refreshLine.trim()
        );
        const bundledSkill = readIfPresent(bundledSkillFile);
        check(
            'and what landed is byte-for-byte the bundled document',
            bundledSkill !== null && readIfPresent(sandbox.skillFile) === bundledSkill,
            sandbox.skillFile
        );
        const marker = JSON.parse(readIfPresent(path.join(sandbox.installedSkill, '.kelpi-skill.json')) ?? 'null');
        check(
            'with an ownership marker recording the hash it wrote',
            marker !== null && typeof marker.installedHash === 'string' && marker.by === 'kelpi-shell',
            JSON.stringify(marker)
        );
        assertRealHomeUntouched('phase 2');

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

// ── phase 3: a shell that is BORN at the width it will be shown at ───────────────────

/**
 * The p10k-instant-prompt fixture, and why it is shaped like this.
 *
 * A modern zsh prompt (powerlevel10k's instant prompt, and anything else that prints before
 * `zle` owns the line) draws a full-width line during INIT — before the client has measured
 * anything — and only later hands a real `PROMPT` to zle. The daemon's terminal never reflows
 * (`@xterm/headless`), so if the PTY was born at a guessed grid and resized once the window
 * measured it, that first line is stranded in the scrollback at the wrong width, permanently,
 * above the correctly-drawn one. That strand is the user-visible defect: a stack of half-width
 * prompt copies down the pane, all stamped with the same second.
 *
 * The marker line is `+KELPIWIDTH ` (10 characters) plus dots padded to `COLUMNS - 20`, so it is
 * exactly `COLUMNS - 10` long: a direct read of the grid the shell believed it had when it
 * printed, and comfortably short of the wrap column, where a line the full width of the screen
 * would be at the mercy of deferred-wrap behaviour instead. The `sleep` stands in for the init
 * work a real prompt framework does between the printed prompt and the real one.
 */
const STRAND_MARKER_SLACK = 10;
const INSTANT_PROMPT_ZSHRC = [
    'setopt prompt_subst',
    'print -P "+KELPIWIDTH ${(l:$((COLUMNS - 20))::.:)}"',
    'print -n "+KELPIPS1> "',
    'sleep 0.6',
    "PROMPT=$'+KELPIWIDTH ${(l:$((COLUMNS - 20))::.:)}\\n+KELPIPS1> '",
    ''
].join('\n');

/** Every marker line's length, in the order the pane holds them. */
function strandWidths(text) {
    return text
        .split('\n')
        .filter((line) => line.includes('+KELPIWIDTH'))
        .map((line) => line.trimEnd().length);
}

/**
 * Read a pane's whole buffer over the control socket, exactly as `kelpi pane capture
 * --scrollback` does.
 */
async function capturePane(sandbox, paneID) {
    const reply = await controlCommand(sandbox.runSocket, {
        command: 'pane-capture',
        target: paneID,
        scrollback: true
    });
    return typeof reply?.text === 'string' ? reply.text : '';
}

/** The first pane the daemon holds, whatever workspace it is in. */
async function firstPaneID(sandbox) {
    const reply = await controlCommand(sandbox.runSocket, { command: 'pane-list' });
    return reply?.panes?.[0]?.id ?? null;
}

/**
 * Assert the pane's scrollback holds NO strand at a width other than the one it ended up at.
 *
 * The count of strands is a property of the zshrc, not of the daemon — this fixture prints the
 * marker once during init and once from zle's own prompt, so two is correct and would be two
 * in a perfect terminal. What must never happen is two DIFFERENT widths: that is the resize
 * that landed during shell init, and everything above it is wrong forever.
 */
function checkNoWidthStrand(label, text) {
    const widths = strandWidths(text);
    const settled = widths[widths.length - 1];
    const stranded = widths.filter((width) => width !== settled);
    check(`${label}: the shell printed something at all`, widths.length > 0, `widths ${JSON.stringify(widths)}`);
    check(
        `${label}: every prompt line is at the pane's final width`,
        widths.length > 0 && stranded.length === 0,
        `widths ${JSON.stringify(widths)} (settled ${String(settled)})`
    );
    // A pane born at the 80×24 fallback is the specific failure this phase exists for, and it
    // is worth naming rather than leaving to the generic mismatch above.
    check(
        `${label}: no line was printed at the 80-column fallback grid`,
        !widths.includes(80 - STRAND_MARKER_SLACK),
        `widths ${JSON.stringify(widths)}`
    );
    return widths;
}

/**
 * Bring the whole stack up against `sandbox`, wait for the window to have measured the pane,
 * and hand back the pane's scrollback.
 */
async function bootAndCapture(sandbox) {
    const daemon = startDaemon(sandbox);
    let shell;
    try {
        await waitForHealthz(sandbox.base);
        shell = startShell(sandbox);
        await shell.waitForLine(/did-finish-load/, 'did-finish-load');
        // The renderer measures the pane and attaches a moment after the load event; the shell
        // has to have finished printing too (the fixture sleeps 600 ms mid-init).
        await sleep(4000);
        const paneID = await firstPaneID(sandbox);
        if (paneID === null) throw new Error('the daemon has no panes to capture');
        const text = await capturePane(sandbox, paneID);
        return { paneID, text, daemonLog: daemon.log() };
    } finally {
        await shell?.quit();
        // SIGTERM, so the geometry cache is flushed the way a real quit flushes it — the
        // relaunch below depends on that file having been written.
        await daemon.stop();
    }
}

async function promptWidthPhase() {
    process.stdout.write('\nphase 3 — a shell is born at the width it will be shown at\n');
    const sandbox = await makeSandbox('width');
    // zsh is the shell the defect was reported against, and the only one with the two-stage
    // prompt shape that makes the strand visible. `/bin/zsh` ships with macOS.
    sandbox.env.SHELL = '/bin/zsh';
    fs.writeFileSync(path.join(sandbox.root, 'home', '.zshrc'), INSTANT_PROMPT_ZSHRC);
    try {
        // ── first boot: nothing has ever rendered this pane ─────────────────────────
        // The geometry cache is empty (fresh install), so the ONLY thing that can save the
        // first prompt is the daemon waiting for the window to report a grid before it spawns
        // the shell (`pty/spawn-gate.ts`).
        const first = await bootAndCapture(sandbox);
        const firstWidths = checkNoWidthStrand('first boot', first.text);

        const geometryFile = path.join(sandbox.root, 'pane-geometry.json');
        check(
            'the daemon persisted the grid it was rendered at',
            fs.existsSync(geometryFile),
            geometryFile
        );
        const remembered = fs.existsSync(geometryFile)
            ? JSON.parse(fs.readFileSync(geometryFile, 'utf8')).panes?.[first.paneID]
            : null;
        // The strand's own length says what the shell was given; the cache has to agree, or
        // the relaunch below is spawning at a number nobody rendered.
        check(
            '…for the pane that was on screen, at the width its prompt printed at',
            remembered != null && remembered.cols === (firstWidths[0] ?? -1) + STRAND_MARKER_SLACK,
            `${JSON.stringify(remembered)} vs printed ${JSON.stringify(firstWidths)}`
        );

        // ── relaunch: the reported case ─────────────────────────────────────────────
        // A daemon restart respawns the persisted pane. With the grid remembered, the shell is
        // born at it and the client's first measurement matches, so no resize lands during
        // init at all — and the trail the user reported (every copy stamped with the daemon's
        // own start second) never gets written.
        const second = await bootAndCapture(sandbox);
        check(
            'the relaunched daemon restored the same pane',
            second.paneID === first.paneID,
            `${String(first.paneID)} → ${String(second.paneID)}`
        );
        checkNoWidthStrand('relaunch after a daemon restart', second.text);

        assertRealHomeUntouched('phase 3');
        return { daemonLog: second.daemonLog };
    } finally {
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
    try {
        logs.push(await promptWidthPhase());
    } catch (error) {
        fail('phase 3 (prompt width)', error instanceof Error ? error.message : String(error));
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
