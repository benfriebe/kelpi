#!/usr/bin/env node
/**
 * A full second Kelpi — daemon + shell + client — off the current tree, beside the running app.
 *
 * Self-hosting demands this: once the main instance hosts the session that develops it, a
 * candidate build needs somewhere to run that is not the ground under your feet. This gives it
 * one: its own run dir, its own control socket, its own DB, ephemeral ports, its own Electron
 * user-data-dir. The coexistence machinery (the compat-socket degrade, the injected pane
 * KELPI_SOCKET routes) means the two instances cannot fight over endpoints by construction —
 * the second instance's panes route to the second daemon, always.
 *
 *   node scripts/dev-instance.mjs                 # throwaway state, dev shell, builds first
 *   node scripts/dev-instance.mjs --no-build      # reuse the current dists
 *   node scripts/dev-instance.mjs --packaged      # run the packaged Kelpi.app instead
 *   node scripts/dev-instance.mjs --state ~/tmp/kelpi-candidate   # persistent state dir
 *
 * Ctrl-C stops the instance. A throwaway state dir is deleted on exit; a --state dir is kept
 * (config and DB survive, so a candidate can be tested against accumulated state).
 *
 * The printed `KELPI_SOCKET=tcp:…` line is how a plain terminal talks to THIS instance's daemon
 * rather than the main one.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { nonExecutableSpawnHelpers, spawnHelperRemedy } from './node-pty-exec-bit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const { buildAll, freePort, startDaemon, startShell, waitForHealthz, clearBackgroundTaskPolicy } =
    await import(path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs'));

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
};

const stateDir = value('--state');
const packaged = has('--packaged');
const noBuild = has('--no-build');
const persistent = stateDir !== undefined;

// ── the instance root ───────────────────────────────────────────────────────────────

const root = persistent
    ? path.resolve(stateDir.replace(/^~(?=\/|$)/, os.homedir()))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-dev-instance-'));
for (const sub of ['home', 'electron', 'work']) fs.mkdirSync(path.join(root, sub), { recursive: true });

const socketPath = path.join(root, 'kelpid.sock');
if (socketPath === '/tmp/kelpi.sock' || socketPath === '/tmp/nex.sock' || socketPath.startsWith('/tmp/kelpid-dev')) {
    console.error('refusing a state dir that collides with a real endpoint');
    process.exit(1);
}

// Config files: create-if-absent so a persistent dir keeps its own edits.
const configPath = path.join(root, 'config');
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '');
const ghosttyConfigPath = path.join(root, 'ghostty-config');
if (!fs.existsSync(ghosttyConfigPath)) {
    fs.writeFileSync(ghosttyConfigPath, '# dev-instance ghostty config\n');
}

// The helpers dir: the same shape the packaged app stages, so this instance's panes resolve
// THIS tree's CLI and their injected KELPI_SOCKET routes here (the N13 discipline).
const helpersDir = path.join(root, 'helpers');
fs.mkdirSync(helpersDir, { recursive: true });
fs.writeFileSync(
    path.join(helpersDir, 'kelpi'),
    `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, 'packages', 'cli', 'dist', 'kelpi.js')}" "$@"\n`,
    { mode: 0o755 }
);

// The built web UI. The daemon serves it only when it is told where it is: `resolveClientDistDir`
// (packages/daemon/src/ws/http.ts) reads KELPID_CLIENT_DIR and returns undefined with no fallback,
// and `serve` then answers every GET with the "client not built" placeholder page (#37).
const clientDistDir = path.join(repoRoot, 'packages', 'client', 'dist');

// ── build ───────────────────────────────────────────────────────────────────────────

// Cheapest failure first: one stat, before a minute of builds and before a window opens.
try {
    assertPtyCanSpawn();
} catch (error) {
    console.error(`[dev-instance] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}

if (!noBuild) {
    console.log('[dev-instance] building the tree (skip with --no-build)…');
    await buildAll(repoRoot, { log: (line) => console.log(`[dev-instance] ${line}`) });
}

// ── guards ──────────────────────────────────────────────────────────────────────────

/**
 * Assert this daemon is actually serving the app, before a window opens on top of the answer.
 *
 * #37 is worth a guard rather than just its one-line fix because the broken state is invisible
 * from everything you would normally check: /healthz is healthy, the control socket answers,
 * `pane list` / `pane create` / `web open` all succeed, and the web panes' native views load their
 * pages perfectly well, because the shell's webhost drives those from daemon state rather than
 * from the client. The only tell is the window itself, and a reviewer who does not recognise the
 * placeholder concludes the change under test is what is broken. That cost about an hour once.
 *
 * Two assertions, because they fail for different reasons and want different advice: the build
 * being absent is the developer's to fix, while the daemon serving `x-kelpi-client: not-built`
 * (packages/daemon/src/ws/http.ts) with a build present and KELPID_CLIENT_DIR set means the
 * plumbing regressed, which is the bug this guard exists to catch.
 *
 * Deliberately NOT a fallback inside `resolveClientDistDir` itself, which was the other option on
 * the issue. That would change daemon behaviour for every caller: `packages/shell/scripts/
 * web-smoke.mjs` leaves KELPID_CLIENT_DIR unset on purpose so the shell window loads the
 * placeholder instead of a real client that would race its own probe for pane geometry, and a
 * daemon that located the repo and served `packages/client/dist` anyway would break it. A packaged
 * daemon has no repo to find, so the fallback would also be dead weight exactly where the app
 * ships. The check belongs where the wrong environment is built, not in the daemon that trusts it.
 */
async function assertServingTheClient(base, distDir) {
    if (!fs.existsSync(path.join(distDir, 'index.html'))) {
        throw new Error(
            [
                `the client build is missing: ${path.join(distDir, 'index.html')}`,
                '  build it with:  pnpm --filter @kelpi/client build',
                '  (or drop --no-build and let this script build the tree for you)'
            ].join('\n')
        );
    }

    const response = await fetch(`${base}/`, { redirect: 'manual' });
    const marker = response.headers.get('x-kelpi-client');
    await response.text(); // drain, so the socket does not sit open behind the rest of the boot
    if (marker === 'not-built') {
        throw new Error(
            [
                'the daemon is serving its "client not built" placeholder, not the app (#37).',
                `  KELPID_CLIENT_DIR was set to: ${distDir}`,
                `  and ${path.join(distDir, 'index.html')} exists`,
                '  so the daemon is not reading it: see resolveClientDistDir in',
                '  packages/daemon/src/ws/http.ts, and check the daemon build is current.'
            ].join('\n')
        );
    }
}

/**
 * Assert PTYs can actually spawn, before the window opens (#36).
 *
 * A dev instance with a non-executable `spawn-helper` comes up looking perfectly healthy and then
 * kills every terminal pane the instant it is created: `kelpi pane create` reports success, the
 * pane shows up in `pane list` once, and it is gone on the next poll, with nothing logged. The
 * root postinstall repairs the bit on any normal `pnpm install`, so this only fires after an
 * install run with --ignore-scripts. It is one stat call and it turns that silence into a line.
 */
function assertPtyCanSpawn() {
    const broken = nonExecutableSpawnHelpers(repoRoot);
    if (broken.length > 0) throw new Error(spawnHelperRemedy(broken));
}

// ── boot ────────────────────────────────────────────────────────────────────────────

const httpPort = await freePort();
const controlPort = await freePort();
const debugPort = await freePort();

const sandbox = {
    root,
    home: path.join(root, 'home'),
    work: path.join(root, 'work'),
    userData: path.join(root, 'electron'),
    configPath,
    ghosttyConfigPath,
    socketPath,
    helpersDir,
    httpPort,
    controlPort,
    debugPort,
    runDir: path.join(root, 'run'),
    base: `http://127.0.0.1:${String(httpPort)}`,
    env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: path.join(root, 'home'),
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
        // Without this the window that comes up is the daemon's placeholder page rather than the
        // app, and nothing else about the instance looks wrong (#37). The env is deliberately
        // clean, so anything the daemon needs has to be listed here by name.
        KELPID_CLIENT_DIR: clientDistDir
        // Deliberately NO KELPI_HARNESS: this instance should outlive a crashed launcher the way
        // the real one outlives its shell — kill it with Ctrl-C here, or `kelpid stop` with the
        // env above.
    },
    cleanup() {
        if (!persistent) fs.rmSync(root, { recursive: true, force: true });
    }
};

console.log(`[dev-instance] state: ${root}${persistent ? ' (persistent)' : ' (throwaway)'}`);
const daemon = startDaemon(sandbox, { repoRoot, verbose: false });
clearBackgroundTaskPolicy(daemon.child?.pid);
await waitForHealthz(sandbox.base);
console.log(`[dev-instance] daemon up: ${sandbox.base}  (control tcp ${String(controlPort)})`);

// Before the window, not after: a placeholder page is much harder to notice once there is
// something on screen that looks like a running app (#37).
try {
    await assertServingTheClient(sandbox.base, clientDistDir);
    console.log(`[dev-instance] client: serving ${clientDistDir}`);
} catch (error) {
    console.error(`[dev-instance] ${error instanceof Error ? error.message : String(error)}`);
    try {
        await daemon.stop();
    } catch {
        /* already gone */
    }
    sandbox.cleanup();
    process.exit(1);
}

const shell = startShell(sandbox, { repoRoot, packaged, verbose: false });
clearBackgroundTaskPolicy(shell.child?.pid);
console.log(`[dev-instance] shell up (${packaged ? 'packaged Kelpi.app' : 'dev electron'})`);
console.log('[dev-instance]');
console.log(`[dev-instance]   talk to it:   KELPI_SOCKET=tcp:127.0.0.1:${String(controlPort)} kelpi pane list`);
console.log(`[dev-instance]   run dir:      ${sandbox.runDir}`);
// The shell's remote debugging port, printed because it is how you tell a window that is the app
// from one that is the placeholder: with the client served, its renderer shows up here as a page
// target beside the web panes' WebContentsView targets (#37).
console.log(`[dev-instance]   debug targets: curl -s http://127.0.0.1:${String(debugPort)}/json/list`);
console.log('[dev-instance]');
console.log('[dev-instance] Ctrl-C to stop.');

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[dev-instance] stopping…');
    // `shell.quit()`, not `shell.stop?.()`: `startShell` exposes `quit` and `startDaemon` exposes
    // `stop`, and the optional call on the wrong name silently did nothing, so Ctrl-C printed
    // "stopping…", exited, and left a live Electron window behind on the screen every single time
    // (its daemon did stop, so the orphan was a window with no instance under it). Called without
    // `?.` on purpose: a future rename should throw into the catch rather than quietly orphan a
    // window again.
    try {
        await shell.quit();
    } catch {
        /* already gone */
    }
    try {
        await daemon.stop();
    } catch {
        /* already gone */
    }
    sandbox.cleanup();
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {
    // If either half dies on its own, wind the rest down rather than idling forever.
    if (daemon.exited || shell.exited) void stop();
}, 2000).unref();
await new Promise(() => {});
