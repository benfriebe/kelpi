/**
 * A throwaway full stack for the audit: a private daemon, a private shell, a private CLI.
 *
 * Isolation is non-negotiable — a developer machine is running the real Kelpi (and, right now,
 * the user's own dev stack on 19733/19734/9223 and /tmp/kelpid-dev*). Every path lives under a
 * fresh `mkdtemp`, the control socket is `<tmp>/kelpid.sock` and never `/tmp/kelpi.sock`, ports are
 * ephemeral and explicitly re-drawn if they collide with the reserved dev ports, and Electron
 * gets its own `--user-data-dir`. The pattern is lifted from
 * `packages/shell/scripts/web-smoke.mjs`, which has the same constraints.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { bundleHash, cacheDecision, writeRecordedHash } from './build-cache.mjs';

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
        // Every child, not just the ones that host a window — see `clearBackgroundTaskPolicy`.
        // `buildAll`, `packageApp` and the `codesign` check all come through here, and
        // `packageApp` in particular is a minute of first-touch I/O over a 250 MB bundle, which
        // is precisely the shape DARWIN_BG throttles.
        clearBackgroundTaskPolicy(child.pid);
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

/**
 * Clear a just-spawned child's **external** background task policy.
 *
 * The name and the paragraphs below used to say "the policy it INHERITED", and that is measurably
 * not what this does — §N22's residual lane, `docs/audit/n22-darwin-bg/`. The policy has two
 * components. The **internal** one is self-applied and is carried across `fork`/`exec` into every
 * descendant; the **external** one is applied by another process and is not inherited at all.
 * `taskpolicy -B -p <pid>` writes only the external one, so on a child that INHERITED `DARWIN_BG`
 * it changes nothing: measured with the kernel's own `PROC_FLAG_DARWINBG`, such a child reads
 * `flag=1` before and after the call, and the children it then spawns are throttled too. Read with
 * `getpriority(PRIO_DARWIN_PROCESS, <other pid>)` it *looks* cleared — that call returns only the
 * external component, which is why the original measurement read as a success.
 *
 * It is kept because it is cheap (~1.3 ms per child) and it does clear a genuine external override
 * (`taskpolicy -b -p <pid>` applied to a running process). What it is not is a fix for the
 * inherited case, and the operative mitigation for that is the one already written down in
 * `docs/audit/README.md`: prefer a quiet machine, and do not start a `--packaged` run from a shell
 * that is itself under `DARWIN_BG`. The two levers that would work are an internal self-clear
 * inside the launched process (`setpriority(PRIO_DARWIN_PROCESS, 0, 0)`, which needs a native call
 * Node does not expose, and must precede Electron's helper spawns) or a LaunchServices launch,
 * which drops the policy outright.
 *
 * Applied to EVERY child the harness makes — the dev shell, the packaged app, the daemon, each
 * build step, every CLI probe, and each shard's child process — and not only to the packaged
 * launch it was written for. A `kelpi` probe is a Node cold start and a run makes hundreds of them;
 * `packageApp` is a minute of first-touch I/O over a 250 MB bundle. Both are the shape the policy
 * throttles, and leaving them inherited left the run's non-Electron half on the slow path for no
 * reason. It is one ~1 ms `taskpolicy` exec per child, best-effort.
 *
 * A run started from an agent session or a CI shell is usually running under `DARWIN_BG`: macOS
 * throttles its disk I/O hard and coalesces its timers, and every child inherits that. The dev
 * shell shrugs it off; the **packaged** app does not, because its cold start is mostly
 * first-touch I/O — a 250 MB signed bundle to page in and validate, asar integrity, the staged
 * `Resources` payload. Under the background policy that start *freezes*: with a timestamped boot
 * log, the app's whole main process went silent between two adjacent lines for 49.6 s and then
 * finished every pending task inside 300 ms. Nothing answers while it is frozen — not the window
 * load, not the DevTools port — which is exactly N22's "the port listens and never replies", and
 * it is why the packaged path still looked like a coin flip after the code-signing half was fixed.
 *
 * Measured, packaged, harness-daemon shape: `-B` on the child attached in 191–207 ms on 7 of 8
 * launches; without it, 1 of 8 (the rest never answered inside 15 s). It has to be the CHILD's
 * pid — clearing the policy on this process first does not propagate to what it spawns (measured:
 * 0/4), and the residual lane explains why: an EXTERNAL clear is not inherited either, so neither
 * end of that call reaches a child's internal policy. Best-effort: a missing `taskpolicy` just
 * leaves the policy as it was.
 */
export function clearBackgroundTaskPolicy(pid) {
    if (process.platform !== 'darwin' || pid === undefined) return;
    try {
        spawnSync('/usr/sbin/taskpolicy', ['-B', '-p', String(pid)], { stdio: 'ignore' });
    } catch {
        // the policy stays as inherited; a packaged run may then be slow to attach
    }
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
 *
 * "From source" is the promise; "unconditionally" never was. Each bundle is content-hashed over
 * its declared inputs (`./build-cache.mjs`) and skipped when that hash matches the one the last
 * build recorded beside its `dist/`. Measured on this tree: 2.5 s for all four cold, 0.05 s when
 * all four are cached. The saving is small because esbuild and vite are fast here — the reason it
 * is worth having is the *sharded* run, where the parent builds once and N children would
 * otherwise race four `pnpm build`s against the same `dist/` trees and against each other.
 * `force: true` (`--force-build`) bypasses it. Either way the decision is logged per bundle, so a
 * skip is never a silent one.
 */
export async function buildAll(repoRoot, { log = () => {}, force = false } = {}) {
    const steps = [
        ['daemon', ['pnpm', ['--filter', '@kelpi/daemon', 'build'], { cwd: repoRoot }]],
        ['cli', ['pnpm', ['--filter', '@kelpi/cli', 'build'], { cwd: repoRoot }]],
        ['client', ['pnpm', ['--filter', '@kelpi/client', 'build'], { cwd: repoRoot }]],
        ['shell', ['node', [path.join(repoRoot, 'packages', 'shell', 'scripts', 'bundle.mjs')], { cwd: path.join(repoRoot, 'packages', 'shell') }]]
    ];
    const built = {};
    for (const [name, [command, args, opts]] of steps) {
        const decision = cacheDecision(repoRoot, name, { force });
        if (decision.cached) {
            log(`${name}: cached — ${decision.reason}`);
            built[name] = 'cached';
            continue;
        }
        log(`building ${name}… (${decision.reason})`);
        const result = await run(command, args, opts);
        if (result.code !== 0) {
            throw new Error(`${name} build failed (exit ${String(result.code)}):\n${result.stdout}${result.stderr}`);
        }
        // Recorded only AFTER a successful build, and re-hashed rather than reusing the decision's
        // hash: a bundle step that writes into its own input tree (or a concurrent edit landing
        // mid-build) would otherwise record a hash for a tree that no longer exists.
        writeRecordedHash(repoRoot, name, bundleHash(repoRoot, name));
        built[name] = 'built';
    }
    return built;
}

// ── sandbox ─────────────────────────────────────────────────────────────────────────

export async function makeSandbox(repoRoot, { label = 'audit', clientDir, auditWindow } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `nexaudit-${label}-`));
    const home = path.join(root, 'home');
    const userData = path.join(root, 'electron');
    const work = path.join(root, 'work');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(work, { recursive: true });

    const socketPath = path.join(root, 'kelpid.sock');
    // The live app's socket AND the legacy app's: the rename moved the live one to
    // /tmp/kelpi.sock and this guard had only ever named /tmp/nex.sock (#61).
    if (socketPath === '/tmp/kelpi.sock' || socketPath === '/tmp/nex.sock' || socketPath.startsWith('/tmp/kelpid-dev')) {
        throw new Error('refusing to touch a non-sandbox socket path');
    }

    const configPath = path.join(root, 'config');
    fs.writeFileSync(configPath, '');

    // The GHOSTTY config the daemon parses for the terminal palette and now WRITES for
    // Settings ▸ Appearance (SET-039…041). Pinned explicitly rather than left to resolve under
    // the sandbox HOME, so an appearance step can read the exact file the daemon touched and a
    // stray resolution change can never point it at the developer's own.
    const ghosttyConfigPath = path.join(root, 'ghostty-config');
    // `KELPI_AUDIT_GHOSTTY_EXTRA` seeds extra lines BEFORE the shell starts. It exists for the
    // one setting the shell can only act on at window creation: `background-opacity` decides
    // whether the BrowserWindow is transparent (APP-012 / SET-049), and no in-run gesture can
    // change that. Unset (the default) this is a no-op and the sandbox is byte-identical.
    const extraGhostty = process.env['KELPI_AUDIT_GHOSTTY_EXTRA'] ?? '';
    fs.writeFileSync(
        ghosttyConfigPath,
        `# audit sandbox ghostty config\nbackground = #0a0a0c\n${extraGhostty === '' ? '' : `${extraGhostty}\n`}`
    );

    const httpPort = await freePort();
    const controlPort = await freePort();
    const debugPort = await freePort();

    // What the packaged app stages at Resources/cli and hands over as KELPID_HELPERS_DIR: a
    // `kelpi` the daemon prepends to every pane's PATH. With it, a bare `kelpi event …` typed (or
    // hook-fired) INSIDE a sandbox pane resolves this repo's CLI and routes via the pane's
    // injected KELPI_SOCKET — the same chain a real install's Claude Code hooks take. Without
    // it, in-pane `kelpi` resolution falls to the audit machine's own PATH (often the Swift
    // app's helper), which is exactly the ambiguity the routing fix exists to remove.
    const helpersDir = path.join(root, 'helpers');
    fs.mkdirSync(helpersDir, { recursive: true });
    fs.writeFileSync(
        path.join(helpersDir, 'kelpi'),
        `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js')}" "$@"\n`,
        { mode: 0o755 }
    );

    const env = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        KELPID_RUN_DIR: path.join(root, 'run'),
        KELPID_SOCKET_PATH: socketPath,
        KELPID_TCP_PORT: String(controlPort),
        KELPID_DB_PATH: path.join(root, 'nex.db'),
        KELPID_CONFIG_PATH: configPath,
        KELPID_GHOSTTY_CONFIG: ghosttyConfigPath,
        KELPID_HTTP_PORT: String(httpPort),
        KELPID_HTTP_HOST: '127.0.0.1',
        KELPID_ENTRY: path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js'),
        KELPID_HELPERS_DIR: helpersDir,
        // Harness marker: a shell/daemon that sees this exits when its stdout pipe dies,
        // instead of orphaning a window when the harness (or a probe script) is hard-killed.
        KELPI_HARNESS: '1',
        /*
         * Where every shell this sandbox ever launches puts its window
         * (`packages/shell/src/audit-window.ts`).
         *
         * It lives on the SANDBOX rather than in the caller's `extraEnv` because a run launches
         * the shell more than once: `reattach-after-relaunch` quits it and starts another, with
         * its own `extraEnv` that knows nothing about placement. With the value only in the
         * caller's hands, the last two steps of every run silently got a differently-placed
         * window from the other 116 — which is exactly the kind of split a fidelity comparison
         * is supposed to detect and this one would have hidden. `extraEnv` still wins where a
         * caller passes it, so nothing loses the ability to override.
         */
        ...(auditWindow === undefined ? {} : { KELPI_AUDIT_WINDOW: auditWindow }),
        ...(clientDir === undefined ? {} : { KELPID_CLIENT_DIR: clientDir })
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
        runDir: env.KELPID_RUN_DIR,
        base: `http://127.0.0.1:${String(httpPort)}`,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

// ── daemon ──────────────────────────────────────────────────────────────────────────

/**
 * `packaged: true` runs the daemon the app *ships* — `Contents/Resources/daemon/kelpid.js` under
 * the bundled `Contents/Resources/node`, with the packaged `node-pty` behind every PTY — instead
 * of the working tree's `dist/`.
 *
 * The harness starts the daemon before the shell, and the shell then *discovers* it rather than
 * spawning one (`daemon ready … (spawned=false)`). So in a `--packaged` run this is the only
 * thing that decides whether the daemon under test is the shipped one; leaving it on the working
 * tree's build would have quietly re-introduced exactly the gap N22 is about.
 */
export function startDaemon(sandbox, { repoRoot, verbose = false, packaged = false }) {
    const entry = packaged ? path.join(packagedResource(repoRoot, 'daemon'), 'kelpid.js') : path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
    const runtime = packaged ? packagedResource(repoRoot, 'node') : process.execPath;
    const lines = [];
    const child = spawn(runtime, [entry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: sandbox.env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    clearBackgroundTaskPolicy(child.pid);
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

/**
 * Identity pre-flight: prove the process answering the sandbox control port IS the daemon
 * this harness just spawned, before any step mutates anything. `ping` replies with the
 * daemon's own `pid` (socket-handlers.md §10); comparing it against the spawned child's pid
 * catches every wrong-process shape at once — a stale route env, a dead sandbox daemon with
 * a squatter on its port, or a future rename that severs the harness from the CLI again.
 * Throws (aborting the whole run) on any mismatch; a wipe of the live instance is what this
 * refusal is cheaper than (2026-08-31).
 */
export async function assertSandboxDaemon(sandbox, expectedPid, timeoutMs = 10_000) {
    const reply = await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: sandbox.controlPort, family: 4 });
        let data = '';
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`identity ping to 127.0.0.1:${String(sandbox.controlPort)} timed out`));
        }, timeoutMs);
        timer.unref();
        socket.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`identity ping failed: ${String(error.message ?? error)}`));
        });
        socket.on('connect', () => socket.write('{"command":"ping"}\n'));
        socket.on('data', (chunk) => (data += String(chunk)));
        socket.on('close', () => {
            clearTimeout(timer);
            resolve(data);
        });
        socket.setEncoding('utf8');
    });
    let parsed;
    try {
        parsed = JSON.parse(reply.split('\n').find((line) => line.trim().length > 0) ?? '');
    } catch {
        throw new Error(`identity ping got a non-JSON reply from 127.0.0.1:${String(sandbox.controlPort)}: ${reply.slice(0, 200)}`);
    }
    const answeringPid = parsed?.pid;
    if (answeringPid !== expectedPid) {
        throw new Error(
            `WRONG DAEMON on 127.0.0.1:${String(sandbox.controlPort)}: ping answered by pid ${String(answeringPid)}, ` +
                `but this harness spawned pid ${String(expectedPid)}. Refusing to run a single step — ` +
                'a mutating audit against the wrong daemon wipes real state.'
        );
    }
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

export function packagedApp(repoRoot) {
    return path.join(repoRoot, 'packages', 'shell', 'out', `Kelpi-darwin-${process.arch}`, 'Kelpi.app');
}

/** `Contents/Resources/<name>` — the payload `forge.config.cjs` stages beside `app.asar`. */
export function packagedResource(repoRoot, name) {
    return path.join(packagedApp(repoRoot), 'Contents', 'Resources', name);
}

export function packagedBinary(repoRoot) {
    return path.join(packagedApp(repoRoot), 'Contents', 'MacOS', 'Kelpi');
}

/**
 * Repackage `Kelpi.app` from the bundles `buildAll` just produced.
 *
 * `--packaged` runs are only worth anything if the bundle under the debugger is the one this
 * working tree makes *now*; a run against yesterday's `out/` is a screenshot of yesterday's
 * bugs. `electron-forge package` (not `make`) — the audit drives the `.app`, and building a
 * DMG on top of it would add a minute for nothing.
 */
export async function packageApp(repoRoot, { log = () => {} } = {}) {
    log('packaging Kelpi.app… (~1 min)');
    const result = await run('pnpm', ['--filter', '@kelpi/shell', 'package'], { cwd: repoRoot });
    if (result.code !== 0) {
        throw new Error(`packaging failed (exit ${String(result.code)}):\n${result.stdout}${result.stderr}`);
    }
    return packagedApp(repoRoot);
}

/**
 * Refuse to drive a packaged app whose code signature is broken — N22, and the reason the audit
 * spent the whole port unable to reach shipped bytes.
 *
 * Forge's fuses plugin signs ad-hoc at `packageAfterCopy`; `@electron/packager` then renames the
 * app and its four helper bundles and rewrites their `Info.plist`s, and (with no `osxSign`
 * config) nothing signs again. The bundle still launches, but it runs under the *stale*
 * signature's identity — `tccd` logs it as `com.github.Electron` — and in that state the
 * browser process's `--remote-debugging-port` listener accepts a TCP connection and never
 * answers it: `waitForPageTarget` just burns its 90 s and the run dies with nothing to show.
 * `packages/shell/forge.config.cjs` re-signs in `postPackage` now, so a bundle that fails this
 * check is one built before that fix.
 */
export async function assertPackagedSignature(repoRoot) {
    const appPath = packagedApp(repoRoot);
    if (!fs.existsSync(appPath)) {
        throw new Error(`packaged app is missing: ${appPath} (run \`pnpm --filter @kelpi/shell package\`)`);
    }
    const verify = await run('/usr/bin/codesign', ['--verify', '--strict', appPath]);
    if (verify.code !== 0) {
        throw new Error(
            `the packaged app's code signature is not valid, so CDP cannot attach to it (N22):\n` +
                `  ${verify.stderr.trim().split('\n').join('\n  ')}\n` +
                `Repackage it — \`pnpm --filter @kelpi/shell package\` — which now ad-hoc signs the\n` +
                `finished bundle. (A run started without --no-build does this for you.)`
        );
    }
    return appPath;
}

/**
 * Launch the shell with a remote-debugging port.
 *
 * `packaged: true` runs the real `Kelpi.app` binary (what a user double-clicks); the default runs
 * `electron .` against `packages/shell/dist/main.js`, which is the same main process with a
 * fresh bundle and no 90-second repackage between runs.
 */
export function startShell(sandbox, { repoRoot, packaged = false, verbose = false, extraEnv = {} }) {
    const shellRoot = path.join(repoRoot, 'packages', 'shell');
    const binary = packaged ? packagedBinary(repoRoot) : electronBinary(repoRoot);
    if (packaged && !fs.existsSync(binary)) {
        throw new Error(`packaged app is missing: ${binary} (run pnpm --filter @kelpi/shell package)`);
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
    // Before anything else: the packaged app's cold start must not run under DARWIN_BG.
    clearBackgroundTaskPolicy(child.pid);
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
 * The ported TypeScript CLI (`packages/cli/dist/kelpi.js`) over TCP.
 *
 * TCP rather than the unix socket because `KELPI_SOCKET` only overrides the *TCP* transport —
 * the unix path is hardcoded to `/tmp/kelpi.sock`, which is the LIVE daemon's socket and
 * exactly the file the audit must never touch. `KELPI_REQUIRE_SOCKET` turns that "must never"
 * into a hard refusal inside the CLI itself: if the route below ever goes stale (2026-08-31,
 * this function still exported the pre-rename `NEX_SOCKET`; the resolver saw nothing, silently
 * fell back to the live socket, and the mac-chrome step's delete-every-workspace clause wiped
 * the running instance), every call fails loudly instead of addressing the wrong daemon.
 */
export function makeCli(sandbox, { repoRoot }) {
    const entry = path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js');
    const invoke = (args, opts = {}) =>
        new Promise((resolve) => {
            const child = spawn(process.execPath, [entry, ...args], {
                cwd: opts.cwd ?? sandbox.home,
                env: {
                    PATH: sandbox.env.PATH,
                    HOME: sandbox.home,
                    KELPI_SOCKET: `tcp:127.0.0.1:${String(sandbox.controlPort)}`,
                    KELPI_REQUIRE_SOCKET: '1',
                    KELPI_REPLY_TIMEOUT: '30',
                    ...(opts.paneID === undefined ? {} : { KELPI_PANE_ID: opts.paneID }),
                    ...opts.env
                },
                stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
            });
            // A CLI probe is a Node cold start, and the run makes hundreds of them. Under the
            // inherited DARWIN_BG policy that start is throttled I/O; clear it here too.
            clearBackgroundTaskPolicy(child.pid);
            // `kelpi event` reads its hook payload (session_id, background_tasks) from stdin, so
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
        const logPath = process.env.KELPI_AUDIT_CLI_LOG;
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
                throw new Error(`kelpi ${args.join(' ')} exited ${String(result.code)}\n${result.stdout}${result.stderr}`);
            }
            return result.stdout;
        },
        /** Run + require exit 0 + parse the JSON it printed. */
        async json(args, opts = {}) {
            const stdout = await this.ok(args, opts);
            try {
                return JSON.parse(stdout);
            } catch {
                throw new Error(`kelpi ${args.join(' ')} did not print JSON:\n${stdout}`);
            }
        }
    };
}
