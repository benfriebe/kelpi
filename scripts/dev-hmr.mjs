#!/usr/bin/env node
/**
 * The sub-second UI inner loop: vite dev with hot-module-reload over a sandbox daemon.
 *
 * The client is a static SPA the daemon serves from `dist` — but its vite config already
 * carries a `/ws` proxy with `NEX_DAEMON_URL` override, so vite's dev server can serve the
 * SAME app with HMR while every WebSocket frame proxies to a real daemon. Edit a component,
 * watch the running UI patch itself in place: no build, no reload, state intact.
 *
 *   node scripts/dev-hmr.mjs                 # sandbox daemon + vite dev, prints the URL
 *   node scripts/dev-hmr.mjs --state <dir>   # persistent sandbox state
 *
 * Open the printed URL in any browser. Limits, stated: web panes render their placeholder
 * card (a native WebContentsView needs the Electron shell — HMR mode is for CLIENT UI work),
 * and main-process/shell behaviour is out of scope by definition. For those, dev-instance.mjs
 * is the tool.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildAll, freePort, startDaemon, waitForHealthz, clearBackgroundTaskPolicy } = await import(
    path.join(repoRoot, 'scripts', 'ui-audit', 'lib', 'stack.mjs')
);

const args = process.argv.slice(2);
const stateArg = (() => {
    const index = args.indexOf('--state');
    return index >= 0 ? args[index + 1] : undefined;
})();
const persistent = stateArg !== undefined;
const root = persistent
    ? path.resolve(stateArg.replace(/^~(?=\/|$)/, os.homedir()))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nex-hmr-'));
for (const sub of ['home', 'work']) fs.mkdirSync(path.join(root, sub), { recursive: true });
const configPath = path.join(root, 'config');
if (!fs.existsSync(configPath)) fs.writeFileSync(configPath, '');

// The daemon needs built bundles once (vite serves the CLIENT from source thereafter).
if (!fs.existsSync(path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js'))) {
    console.log('[dev-hmr] building (first run)…');
    await buildAll(repoRoot, { log: (line) => console.log(`[dev-hmr] ${line}`) });
}

const httpPort = await freePort();
const controlPort = await freePort();
const sandbox = {
    root,
    env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: path.join(root, 'home'),
        NEXD_RUN_DIR: path.join(root, 'run'),
        NEXD_SOCKET_PATH: path.join(root, 'nexd.sock'),
        NEXD_TCP_PORT: String(controlPort),
        NEXD_DB_PATH: path.join(root, 'nex.db'),
        NEXD_CONFIG_PATH: configPath,
        NEXD_HTTP_PORT: String(httpPort),
        NEXD_HTTP_HOST: '127.0.0.1',
        NEXD_ENTRY: path.join(repoRoot, 'packages', 'daemon', 'dist', 'nexd.js')
    }
};

const daemon = startDaemon(sandbox, { repoRoot });
clearBackgroundTaskPolicy(daemon.child?.pid);
await waitForHealthz(`http://127.0.0.1:${String(httpPort)}`);
const token = (() => {
    const runDir = sandbox.env.NEXD_RUN_DIR;
    const tokenFile = fs.readdirSync(runDir).find((entry) => entry.endsWith('.token'));
    return tokenFile === undefined ? '' : fs.readFileSync(path.join(runDir, tokenFile), 'utf8').trim();
})();

const vite = spawn('npx', ['vite', 'dev', '--port', '0'], {
    cwd: path.join(repoRoot, 'packages', 'client'),
    env: { ...process.env, NEX_DAEMON_URL: `http://127.0.0.1:${String(httpPort)}` },
    stdio: ['ignore', 'pipe', 'pipe']
});
clearBackgroundTaskPolicy(vite.pid);
vite.stdout.setEncoding('utf8');
vite.stderr.setEncoding('utf8');
let printed = false;
const onChunk = (chunk) => {
    process.stdout.write(chunk.replace(/^/gm, '[vite] '));
    const match = /Local:\s+(http:\/\/[^\s]+)/.exec(chunk);
    if (match && !printed) {
        printed = true;
        console.log('[dev-hmr]');
        console.log(`[dev-hmr]   OPEN:  ${match[1]}?token=${token}`);
        console.log('[dev-hmr]   edits under packages/client/src hot-reload in place.');
        console.log('[dev-hmr]');
    }
};
vite.stdout.on('data', onChunk);
vite.stderr.on('data', onChunk);

let stopping = false;
const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[dev-hmr] stopping…');
    try {
        vite.kill('SIGTERM');
    } catch {
        /* gone */
    }
    try {
        await daemon.stop?.();
    } catch {
        /* gone */
    }
    if (!persistent) fs.rmSync(root, { recursive: true, force: true });
    process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {
    if (daemon.exited || vite.exitCode !== null) void stop();
}, 2000).unref();
await new Promise(() => {});
