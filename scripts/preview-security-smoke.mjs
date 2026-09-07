#!/usr/bin/env node
/** Real Chromium regression: untrusted previews/assets stay inert; the trusted bridge works. */
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const daemonRequire = createRequire(path.join(root, 'packages/daemon/package.json'));
const shellRequire = createRequire(path.join(root, 'packages/shell/package.json'));
const { build } = daemonRequire('esbuild');
const { getRequestListener } = daemonRequire('@hono/node-server');
const temporary = await mkdtemp(path.join(tmpdir(), 'kelpi-preview-security-'));
let server;
try {
    const bridge = await build({ absWorkingDir: root, entryPoints: ['packages/client/src/content/bridge.ts'], bundle: true, platform: 'browser', format: 'iife', globalName: 'PreviewBridge', write: false });
    const httpBundle = path.join(temporary, 'http.cjs');
    await build({ absWorkingDir: root, entryPoints: ['packages/daemon/src/ws/http.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: httpBundle, external: ['node-pty'] });
    const { createHttpApp, createPaneAssetsRoute } = daemonRequire(httpBundle);
    const assetHtml = path.join(temporary, 'asset.html');
    const assetSvg = path.join(temporary, 'asset.svg');
    await writeFile(assetHtml, '<title>Asset</title><h1>Asset content</h1><script>document.title="stolen:"+localStorage.getItem("kelpi.token")</script>');
    await writeFile(assetSvg, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><script>document.documentElement.setAttribute("data-attacked","yes")</script><rect width="12" height="12" fill="green"/></svg>');
    const app = createHttpApp({ version: { version: 'smoke', build: 'smoke', protocol: 1 }, routes: hono => {
        hono.get('/bridge.js', c => c.body(bridge.outputFiles[0].text, 200, { 'content-type': 'text/javascript' }));
        hono.get('/', c => c.html('<!doctype html><title>Preview security fixture</title><script src="/bridge.js"></script>'));
        createPaneAssetsRoute((_pane, name) => name === 'asset.html' ? assetHtml : name === 'asset.svg' ? assetSvg : null,
            { validateCredential: credential => credential === 'smoke' })(hono);
    } });
    server = createServer(getRequestListener(app.fetch));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(shellRequire('electron'), [path.join(root, 'scripts/fixtures/preview-security.cjs'), url, temporary], { env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    if (code !== 0) throw new Error(`Chromium security smoke exited ${code}`);
} finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await rm(temporary, { recursive: true, force: true });
}
