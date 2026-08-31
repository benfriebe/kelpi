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

// ── build ───────────────────────────────────────────────────────────────────────────

if (!noBuild) {
    console.log('[dev-instance] building the tree (skip with --no-build)…');
    await buildAll(repoRoot, { log: (line) => console.log(`[dev-instance] ${line}`) });
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
        KELPID_HELPERS_DIR: helpersDir
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

const shell = startShell(sandbox, { repoRoot, packaged, verbose: false });
clearBackgroundTaskPolicy(shell.child?.pid);
console.log(`[dev-instance] shell up (${packaged ? 'packaged Kelpi.app' : 'dev electron'})`);
console.log('[dev-instance]');
console.log(`[dev-instance]   talk to it:   KELPI_SOCKET=tcp:127.0.0.1:${String(controlPort)} kelpi pane list`);
console.log(`[dev-instance]   run dir:      ${sandbox.runDir}`);
console.log('[dev-instance]');
console.log('[dev-instance] Ctrl-C to stop.');

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[dev-instance] stopping…');
    try {
        await shell.stop?.();
    } catch {
        /* already gone */
    }
    try {
        await daemon.stop?.();
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
