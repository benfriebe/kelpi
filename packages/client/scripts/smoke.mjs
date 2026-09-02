#!/usr/bin/env node
/**
 * Live smoke test for the assembled client (WP3.6's acceptance gate).
 *
 * Unit tests prove the pieces; this proves the SYSTEM. It builds the client, boots a real
 * `kelpid` on private paths, and then behaves like the browser does — an HTTP GET of the page,
 * a WebSocket handshake, a state snapshot, a delta caused by the REAL Swift CLI, a PTY attach
 * with its replay, and keystrokes that come back as terminal output.
 *
 * Everything it asserts is something a unit test cannot: that the daemon serves the built
 * bundle, that the protocol versions agree end to end, that the token gate accepts the token
 * the run dir wrote, that a CLI-driven mutation reaches an attached browser as a delta, and
 * that bytes make the full round trip client → PTY → VT → client.
 *
 * Isolation rules (non-negotiable — the production Swift app owns the real socket on a dev
 * machine): every path is inside a fresh `mkdtemp` directory, the control socket is
 * `<tmp>/kelpid.sock` and NEVER `/tmp/nex.sock`, the DB, run dir, config and HOME are all
 * throwaway, and the control TCP port is one the OS just handed us.
 *
 *   node packages/client/scripts/smoke.mjs [--no-build] [--keep] [--verbose]
 *
 *     --no-build  trust the existing dist/ output instead of rebuilding both packages
 *     --keep      leave the daemon running and print how to reach it
 *     --verbose   stream the daemon's log to stderr as it runs
 *
 * Exit code 0 = every check passed. Any failure prints the daemon log and exits 1.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(clientRoot, '..', '..');
const daemonEntry = path.join(repoRoot, 'packages', 'daemon', 'dist', 'kelpid.js');
const clientDist = path.join(clientRoot, 'dist');

const SWIFT_CLI = process.env['KELPI_COMPAT_CLI'] ?? '/Applications/Nex.app/Contents/Helpers/nex';

/** Frame layout from `@kelpi/protocol` `ws/pty.ts` (kept in sync by `smoke.test.ts`). */
const FRAME = { output: 0x01, input: 0x02, ack: 0x03, resize: 0x04, replay: 0x05 };
const FRAME_HEADER_BYTES = 17;
const PROTOCOL_VERSION = 1;

const argv = new Set(process.argv.slice(2));
const options = {
    // Rebuilding is the default: a stale `dist/kelpid.js` silently tests LAST commit's daemon,
    // which is exactly the confusion a live smoke exists to prevent.
    build: !argv.has('--no-build'),
    keep: argv.has('--keep'),
    verbose: argv.has('--verbose')
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

async function waitFor(label, predicate, timeoutMs = 15_000, intervalMs = 100) {
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
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            server.close(() => resolve(port));
        });
    });
}

// ── build ───────────────────────────────────────────────────────────────────────────

async function ensureBuilds() {
    if (options.build || !fs.existsSync(daemonEntry)) {
        process.stdout.write('building the daemon bundle…\n');
        const result = await run('pnpm', ['--filter', '@kelpi/daemon', 'build']);
        if (result.code !== 0) throw new Error(`daemon build failed:\n${result.stdout}${result.stderr}`);
    }
    if (options.build || !fs.existsSync(path.join(clientDist, 'index.html'))) {
        process.stdout.write('building the client…\n');
        const result = await run('pnpm', ['--filter', '@kelpi/client', 'build']);
        if (result.code !== 0) throw new Error(`client build failed:\n${result.stdout}${result.stderr}`);
    }
}

// ── daemon ──────────────────────────────────────────────────────────────────────────

/**
 * The settings files the daemon reads (M8). Written BEFORE the daemon boots so the very first
 * `welcome` already carries them — and written into the throwaway root, never near the
 * developer's real `~/.config/nex/config` or `~/.config/ghostty/config`.
 */
const SMOKE_CONFIG = `# kelpi smoke config
focus-follows-mouse = true
focus-follows-mouse-delay = 175

keybind = ctrl+alt+t=split_right
`;

const SMOKE_GHOSTTY_CONFIG = `# ghostty smoke config
background = #ffffff
background-opacity = 0.85
font-family = JetBrains Mono
font-size = 15
`;

async function startDaemon() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexs-'));
    const home = path.join(root, 'home');
    const runDir = path.join(root, 'run');
    fs.mkdirSync(home, { recursive: true });

    const configPath = path.join(root, 'config');
    const ghosttyConfigPath = path.join(root, 'ghostty-config');
    fs.writeFileSync(configPath, SMOKE_CONFIG, 'utf8');
    fs.writeFileSync(ghosttyConfigPath, SMOKE_GHOSTTY_CONFIG, 'utf8');

    const controlPort = await freePort();
    const httpPort = await freePort();
    const socketPath = path.join(root, 'kelpid.sock');
    if (socketPath === '/tmp/nex.sock') throw new Error('refusing to touch the production socket');

    const log = [];
    const child = spawn(process.execPath, [daemonEntry, 'start', '--foreground'], {
        cwd: repoRoot,
        env: {
            PATH: process.env['PATH'] ?? '/usr/bin:/bin',
            HOME: home,
            KELPID_RUN_DIR: runDir,
            KELPID_SOCKET_PATH: socketPath,
            KELPID_TCP_PORT: String(controlPort),
            KELPID_DB_PATH: path.join(root, 'nex.db'),
            KELPID_CONFIG_PATH: configPath,
            // The settings service's ghostty override; without it the daemon would read the
            // developer's own ~/.config/ghostty/config.
            KELPID_GHOSTTY_CONFIG: ghosttyConfigPath,
            KELPID_HTTP_PORT: String(httpPort),
            KELPID_HTTP_HOST: '127.0.0.1',
            // The static-dir mechanism already exists: `ws/http.ts` `resolveClientDistDir`.
            KELPID_CLIENT_DIR: clientDist
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const collect = (chunk) => {
        log.push(chunk);
        if (options.verbose) process.stderr.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let exited = false;
    child.on('exit', () => {
        exited = true;
    });

    const base = `http://127.0.0.1:${httpPort}`;
    await waitFor('the daemon to answer /healthz', async () => {
        if (exited) throw new Error(`the daemon exited early:\n${log.join('')}`);
        try {
            const response = await fetch(`${base}/healthz`);
            return response.ok;
        } catch {
            return false;
        }
    });

    const token = fs.readFileSync(path.join(runDir, `daemon-v${PROTOCOL_VERSION}.token`), 'utf8').trim();

    return {
        root,
        home,
        base,
        token,
        configPath,
        ghosttyConfigPath,
        controlPort,
        pid: child.pid ?? 0,
        log: () => log.join(''),
        /** `--keep`: stop holding the event loop open on a daemon we are leaving running. */
        detach() {
            child.stdout.destroy();
            child.stderr.destroy();
            child.unref();
        },
        async stop() {
            if (exited) return;
            child.kill('SIGTERM');
            await Promise.race([new Promise((resolve) => child.on('exit', resolve)), sleep(8000)]);
            if (!exited) child.kill('SIGKILL');
        },
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

// ── the WS client (the browser's half, by hand) ─────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function uuidToBytes(uuid) {
    const hex = uuid.replace(/-/g, '');
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index += 1) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function uuidFromBytes(bytes, offset = 0) {
    let hex = '';
    for (let index = 0; index < 16; index += 1) hex += bytes[offset + index].toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

function encodeFrame(type, paneID, payload = new Uint8Array(0)) {
    const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
    frame[0] = type;
    frame.set(uuidToBytes(paneID), 1);
    frame.set(payload, FRAME_HEADER_BYTES);
    return frame;
}

async function connectWs(base, token) {
    const url = `${base.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    const messages = [];
    const frames = [];
    const waiters = [];

    const settle = () => {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
            const waiter = waiters[index];
            const hit = waiter.kind === 'json' ? messages.find(waiter.match) : frames.find(waiter.match);
            if (hit !== undefined) {
                waiters.splice(index, 1);
                waiter.resolve(hit);
            }
        }
    };

    socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
            messages.push(JSON.parse(event.data));
        } else {
            const bytes = new Uint8Array(event.data);
            if (bytes.length >= FRAME_HEADER_BYTES) {
                frames.push({
                    type: bytes[0],
                    paneID: uuidFromBytes(bytes, 1),
                    payload: bytes.subarray(FRAME_HEADER_BYTES)
                });
            }
        }
        settle();
    };

    await new Promise((resolve, reject) => {
        socket.onopen = resolve;
        socket.onerror = () => reject(new Error('the WebSocket failed to open'));
    });

    const wait = (kind, match, label, timeoutMs = 15_000) =>
        new Promise((resolve, reject) => {
            const existing = kind === 'json' ? messages.find(match) : frames.find(match);
            if (existing !== undefined) {
                resolve(existing);
                return;
            }
            const waiter = { kind, match, resolve };
            waiters.push(waiter);
            setTimeout(() => {
                const at = waiters.indexOf(waiter);
                if (at < 0) return;
                waiters.splice(at, 1);
                reject(new Error(`timed out waiting for ${label}`));
            }, timeoutMs);
        });

    return {
        socket,
        messages,
        frames,
        send: (message) => socket.send(JSON.stringify(message)),
        sendFrame: (frame) => socket.send(frame),
        waitJson: (match, label, timeoutMs) => wait('json', match, label, timeoutMs),
        waitFrame: (match, label, timeoutMs) => wait('frame', match, label, timeoutMs),
        close: () => socket.close()
    };
}

// ── the checks ──────────────────────────────────────────────────────────────────────

async function main() {
    await ensureBuilds();

    process.stdout.write('booting a throwaway daemon…\n');
    const daemon = await startDaemon();
    process.stdout.write(`  http ${daemon.base}   control tcp:127.0.0.1:${daemon.controlPort}\n\n`);

    let ws;
    try {
        // 1. the page the daemon serves
        const page = await fetch(`${daemon.base}/`);
        const html = await page.text();
        check('serves the client build', page.ok && html.includes('id="root"'), `status ${page.status}`);
        const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
        check('the page references a hashed module bundle', asset !== undefined, String(asset));
        if (asset !== undefined) {
            const bundle = await fetch(`${daemon.base}${asset}`);
            const body = await bundle.text();
            check(
                'serves the bundle itself',
                bundle.ok && body.length > 1000,
                `${asset} → ${bundle.status}, ${body.length} bytes`
            );
        }

        /**
         * Issue #13: a browser attached over the tailnet must get the Kelpi mark in its tab.
         * The build emits `/favicon.svg` from `@kelpi/core/icon` and the document links it, so
         * the failure mode this catches is either half going missing: a link to a path the
         * daemon answers with the SPA fallback returns an HTML document served as the icon,
         * which is exactly what a 404-shaped bug looks like here.
         */
        const iconHref = /<link rel="icon"[^>]*href="([^"]+)"/.exec(html)?.[1];
        check('the document links a favicon', iconHref === '/favicon.svg', String(iconHref));
        if (iconHref !== undefined) {
            const icon = await fetch(`${daemon.base}${iconHref}`);
            const body = await icon.text();
            check(
                'and the daemon serves the Kelpi mark there, not the SPA fallback',
                icon.ok &&
                    (icon.headers.get('content-type') ?? '').startsWith('image/svg+xml') &&
                    body.startsWith('<svg ') &&
                    body.includes('<path'),
                `${iconHref} → ${icon.status} ${icon.headers.get('content-type') ?? '?'}, ${body.length} bytes`
            );
        }

        const health = await (await fetch(`${daemon.base}/healthz`)).json();
        check('healthz reports the protocol version', health.ok === true && health.protocol === PROTOCOL_VERSION);

        // 2. the handshake
        ws = await connectWs(daemon.base, daemon.token);
        ws.send({
            type: 'hello',
            protocolVersion: PROTOCOL_VERSION,
            token: daemon.token,
            client: { kind: 'browser', name: 'kelpi-smoke' }
        });
        const welcome = await ws.waitJson((m) => m.type === 'welcome', 'welcome');
        check(
            'the WS handshake completes',
            welcome.protocolVersion === PROTOCOL_VERSION && typeof welcome.clientID === 'string',
            `daemon ${welcome.daemon?.version} pid ${welcome.daemon?.pid}`
        );

        // 2b. settings sync (M8): the daemon is the settings authority, and its verdict rides
        //     the handshake so the client never renders a frame on the wrong bindings/theme.
        const settings = welcome.settings ?? {};
        check(
            'the welcome carries the settings snapshot',
            settings.general?.focusFollowsMouse === true && settings.general?.focusFollowsMouseDelay === 175,
            JSON.stringify(settings.general)
        );
        check(
            'the kelpi config’s keybind line reaches the client',
            Array.isArray(settings.keybindLines) && settings.keybindLines.includes('ctrl+alt+t=split_right'),
            JSON.stringify(settings.keybindLines)
        );
        check(
            'the ghostty config is parsed, luminance included',
            settings.appearance?.backgroundColor === '#ffffff' &&
                settings.appearance?.backgroundOpacity === 0.85 &&
                settings.appearance?.fontSize === 15 &&
                settings.appearance?.fontFamily === '"JetBrains Mono"' &&
                settings.appearance?.isDark === false,
            JSON.stringify(settings.appearance)
        );

        const snapshot = await ws.waitJson((m) => m.type === 'snapshot', 'snapshot');
        check(
            'a state snapshot arrives',
            Array.isArray(snapshot.state?.workspaces) && snapshot.state.workspaces.length >= 1,
            `${snapshot.state?.workspaces?.length ?? 0} workspace(s), seq ${snapshot.seq}`
        );
        check(
            'the snapshot strips the server-only home directory',
            snapshot.state.homeDirectory === undefined
        );

        // 3. a mutation from the REAL Swift CLI arrives as a delta
        const cliAvailable = fs.existsSync(SWIFT_CLI);
        if (!cliAvailable) {
            process.stdout.write(`  · skipping the CLI checks (${SWIFT_CLI} not installed)\n`);
        }

        const cli = (args) =>
            run(SWIFT_CLI, args, {
                cwd: daemon.home,
                env: {
                    HOME: daemon.home,
                    NEX_SOCKET: `tcp:127.0.0.1:${daemon.controlPort}`
                }
            });

        let paneID;
        let smokeWorkspaceID;
        if (cliAvailable) {
            const created = await cli(['workspace', 'create', '--name', 'smoke', '--json']);
            const reply = created.code === 0 ? JSON.parse(created.stdout) : {};
            check(
                'the Swift CLI creates a workspace',
                created.code === 0 && reply.ok === true,
                `${reply.workspace_name ?? ''} ${reply.workspace_id ?? created.stderr}`
            );

            const delta = await ws.waitJson(
                (m) =>
                    m.type === 'delta' &&
                    m.events?.some((event) => event.kind === 'workspace-upserted' && event.id === reply.workspace_id),
                'the workspace delta'
            );
            check(
                'the CLI mutation reaches the attached client as a delta',
                delta.seq >= 1,
                `seq ${delta.seq}, kinds: ${[...new Set(delta.events.map((event) => event.kind))].join(', ')}`
            );

            smokeWorkspaceID = reply.workspace_id;
            const pane = await cli(['pane', 'create', '--workspace', 'smoke', '--name', 'smoke-pane', '--json']);
            const paneReply = pane.code === 0 ? JSON.parse(pane.stdout) : {};
            paneID = paneReply.pane_id;
            check('the CLI creates a pane', pane.code === 0 && typeof paneID === 'string', String(paneID ?? pane.stderr));
        } else {
            // Without the Swift CLI the same verbs still have to work over the WS command
            // channel — that is the path the browser itself uses.
            ws.send({
                type: 'command',
                id: 'ws-create',
                payload: { command: 'workspace-create', name: 'smoke' }
            });
            const reply = await ws.waitJson((m) => m.type === 'command-reply' && m.id === 'ws-create', 'create reply');
            check('a WS command creates a workspace', reply.reply?.ok === true, JSON.stringify(reply.reply));
            smokeWorkspaceID = reply.reply?.workspace_id;

            ws.send({
                type: 'command',
                id: 'ws-pane',
                payload: { command: 'pane-create', workspace: 'smoke', name: 'smoke-pane' }
            });
            const paneReply = await ws.waitJson((m) => m.type === 'command-reply' && m.id === 'ws-pane', 'pane reply');
            paneID = paneReply.reply?.pane_id;
            check('a WS command creates a pane', typeof paneID === 'string', String(paneID));
        }

        // 4. PTY: attach → replay, input → output
        if (typeof paneID === 'string') {
            ws.send({ type: 'attach-pane', paneID, cols: 80, rows: 24 });
            const replay = await ws.waitFrame(
                (frame) => frame.type === FRAME.replay && frame.paneID === paneID.toUpperCase(),
                'the attach replay'
            );
            // A pane created a moment ago may not have drawn its prompt yet, so the snapshot
            // is allowed to be empty — what matters is that the daemon replays BEFORE going
            // live, which is the ordering the ingest layer depends on.
            check(
                'attaching a pane replays its screen first',
                replay !== undefined && ws.frames.indexOf(replay) === 0,
                `${replay.payload.length} bytes of VT snapshot, ${JSON.stringify(decoder.decode(replay.payload).slice(0, 40))}`
            );

            const marker = `kelpi-smoke-${Date.now()}`;
            ws.sendFrame(encodeFrame(FRAME.input, paneID, encoder.encode(`echo ${marker}\n`)));
            const seen = [];
            const output = await ws.waitFrame((frame) => {
                if (frame.type !== FRAME.output || frame.paneID !== paneID.toUpperCase()) return false;
                seen.push(decoder.decode(frame.payload));
                // The echo of the command line arrives first; wait for the shell's own output.
                return seen.join('').split(marker).length > 2;
            }, 'the command output', 20_000);
            check(
                'input round-trips to terminal output',
                output !== undefined,
                `echoed ${marker} back through the PTY`
            );

            // Re-attaching is the reattach-from-another-device path: the daemon's own VT holds
            // the screen, so the replay must now carry what the pane printed a moment ago.
            ws.send({ type: 'detach-pane', paneID });
            const before = ws.frames.length;
            ws.send({ type: 'attach-pane', paneID, cols: 80, rows: 24 });
            const second = await ws.waitFrame(
                (frame) => frame.type === FRAME.replay && ws.frames.indexOf(frame) >= before,
                'the re-attach replay'
            );
            check(
                're-attaching replays the daemon-side screen',
                decoder.decode(second.payload).includes(marker),
                `${second.payload.length} bytes, contains the echoed marker`
            );

            // 5. the WS-only verbs WP3.6 added to the daemon
            ws.send({ type: 'command', id: 'ws-zoom', payload: { command: 'toggle-zoom', pane_id: paneID } });
            const zoom = await ws.waitJson((m) => m.type === 'command-reply' && m.id === 'ws-zoom', 'zoom reply');
            check('the WS-only toggle-zoom verb works', zoom.reply?.ok === true, JSON.stringify(zoom.reply));

            // 5a. the client-polish WS-only verbs. An icon is the interesting one: the token is
            //     opaque end to end, so a value the client cannot draw still has to come back
            //     verbatim in the delta the daemon broadcasts.
            if (typeof smokeWorkspaceID === 'string') {
                const workspaceID = smokeWorkspaceID;
                ws.send({
                    type: 'command',
                    id: 'ws-icon',
                    payload: { command: 'set-workspace-icon', workspace_id: workspaceID, icon: 'system:hammer.fill' }
                });
                const icon = await ws.waitJson((m) => m.type === 'command-reply' && m.id === 'ws-icon', 'icon reply');
                check(
                    'the WS-only set-workspace-icon verb round-trips an opaque token',
                    icon.reply?.ok === true && icon.reply?.icon === 'system:hammer.fill',
                    JSON.stringify(icon.reply)
                );
            }

            ws.send({ type: 'command', id: 'ws-clear', payload: { command: 'clear-pane-status', pane_id: paneID } });
            const cleared = await ws.waitJson((m) => m.type === 'command-reply' && m.id === 'ws-clear', 'clear reply');
            check(
                'the WS-only clear-pane-status verb answers with the post-clear status',
                cleared.reply?.ok === true && cleared.reply?.status === 'idle',
                JSON.stringify(cleared.reply)
            );

            // A pane with no agent session cannot be restarted; the refusal is the contract.
            ws.send({ type: 'command', id: 'ws-restart', payload: { command: 'restart-pane-agent', pane_id: paneID } });
            const restart = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'ws-restart',
                'restart reply'
            );
            check(
                'restart-pane-agent refuses a pane with no agent session',
                restart.reply?.ok === false && String(restart.reply?.error ?? '').includes('no agent session'),
                JSON.stringify(restart.reply)
            );

            // 5b. settings mutation: the verb writes THROUGH the config file, so the proof is
            //     on disk — with every unrelated line still there — and the change comes back
            //     as a broadcast the way it would for any other attached client.
            ws.send({
                type: 'command',
                id: 'ws-keybind',
                payload: { command: 'set-keybinding', action: 'close_pane', trigger: 'ctrl+alt+w' }
            });
            const bound = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'ws-keybind',
                'the set-keybinding reply'
            );
            check(
                'a set-keybinding verb is accepted',
                bound.reply?.ok === true &&
                    (bound.reply?.settings?.keybindLines ?? []).includes('ctrl+alt+w=close_pane'),
                JSON.stringify(bound.reply?.settings?.keybindLines ?? bound.reply)
            );
            const configAfter = fs.readFileSync(daemon.configPath, 'utf8');
            check(
                'the keybinding is written through to the config file',
                configAfter.includes('keybind = ctrl+alt+w=close_pane'),
                JSON.stringify(configAfter.split('\n').filter((line) => line.startsWith('keybind')))
            );
            check(
                'the write preserves every unrelated line',
                configAfter.includes('# kelpi smoke config') &&
                    configAfter.includes('focus-follows-mouse = true') &&
                    configAfter.includes('focus-follows-mouse-delay = 175') &&
                    configAfter.includes('keybind = ctrl+alt+t=split_right')
            );
            const broadcast = await ws.waitJson(
                (m) =>
                    m.type === 'settings-changed' &&
                    (m.settings?.keybindLines ?? []).includes('ctrl+alt+w=close_pane'),
                'the settings-changed broadcast'
            );
            check(
                'the change reaches attached clients as settings-changed',
                broadcast !== undefined,
                JSON.stringify(broadcast.settings?.keybindLines)
            );

            // …and a HAND edit of the ghostty config (no verb involved) does the same, which is
            // the watcher doing its job — the path that re-renders markdown/diff on a theme change.
            fs.writeFileSync(
                daemon.ghosttyConfigPath,
                '# edited by the smoke\nbackground = #1a1b26\nbackground-opacity = 0.5\n',
                'utf8'
            );
            const themed = await ws.waitJson(
                (m) => m.type === 'settings-changed' && m.settings?.appearance?.backgroundColor === '#1a1b26',
                'the ghostty settings-changed broadcast',
                20_000
            );
            check(
                'a ghostty config edit is watched and pushed',
                themed.settings?.appearance?.isDark === true &&
                    themed.settings?.appearance?.backgroundOpacity === 0.5,
                JSON.stringify(themed.settings?.appearance)
            );

            // 5b. Settings ▸ Appearance writes a file Kelpi does NOT own (SET-039…041). The
            //     `set-ghostty-setting` verb applies the surgical writer to the user's real
            //     ghostty config, and the check that matters is the line it left alone: a
            //     colour picker must not be able to eat a hand-maintained config.
            ws.send({
                type: 'command',
                id: 'ws-ghostty',
                payload: { command: 'set-ghostty-setting', key: 'font-size', value: '17' }
            });
            const ghosttyReply = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'ws-ghostty',
                'the set-ghostty-setting reply'
            );
            check(
                'set-ghostty-setting answers with the re-read appearance',
                ghosttyReply.reply?.ok === true && ghosttyReply.reply?.settings?.appearance?.fontSize === 17,
                JSON.stringify(ghosttyReply.reply?.settings?.appearance ?? ghosttyReply.reply)
            );
            const ghosttyAfter = fs.readFileSync(daemon.ghosttyConfigPath, 'utf8');
            check(
                'the ghostty write preserves every unrelated line',
                ghosttyAfter.includes('font-size = 17') &&
                    ghosttyAfter.includes('# edited by the smoke') &&
                    ghosttyAfter.includes('background = #1a1b26'),
                JSON.stringify(ghosttyAfter)
            );
            ws.send({
                type: 'command',
                id: 'ws-ghostty-bad',
                payload: { command: 'set-ghostty-setting', key: 'window-padding-x', value: '8' }
            });
            const refused = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'ws-ghostty-bad',
                'the refused ghostty key'
            );
            check(
                'a ghostty key the daemon cannot read back is refused',
                refused.reply?.ok === false && /not a writable ghostty setting/.test(refused.reply?.error ?? ''),
                JSON.stringify(refused.reply)
            );

            // 5c. The system-stat sampler (APP-078…085). The daemon samples the HOST — a
            //     browser tab cannot — and broadcasts on its own 2 s cadence, gated on some
            //     client being attached. This socket is that client, so a sample must arrive.
            const stats = await ws.waitJson((m) => m.type === 'system-stats', 'a system-stats broadcast', 15_000);
            check(
                'the daemon broadcasts system stats to an attached client',
                stats !== undefined && typeof stats.stats?.memTotalBytes === 'number' && stats.stats.memTotalBytes > 0,
                JSON.stringify(stats?.stats)
            );
            check(
                'every metric carries a history ring',
                ['cpu', 'memory', 'load', 'network', 'diskIO', 'diskSpace'].every((kind) =>
                    Array.isArray(stats?.history?.[kind])
                ),
                Object.keys(stats?.history ?? {}).join(', ')
            );
            // AGNT-109: the FIRST sample has no baseline, so its rates are 0 rather than the
            // cumulative counter reported as a per-second figure.
            check(
                'the rates are deltas, not cumulative counters',
                (stats?.history?.network?.[0] ?? -1) === 0 && (stats?.history?.diskIO?.[0] ?? -1) === 0,
                `network[0]=${String(stats?.history?.network?.[0])} diskIO[0]=${String(stats?.history?.diskIO?.[0])}`
            );

            // 6. content panes (M5): open a markdown file the way a user does, mirror it the way
            //    the client does, and prove the daemon-side watcher pushes a disk write back out.
            //    A unit test can fake any of those three; only a live run proves they meet.
            const docPath = path.join(daemon.home, 'smoke-doc.md');
            const assetPath = path.join(daemon.home, 'smoke-asset.txt');
            fs.writeFileSync(docPath, '# Smoke\n\nhello from the smoke test\n', 'utf8');
            fs.writeFileSync(assetPath, 'sibling asset\n', 'utf8');

            if (cliAvailable) {
                // The real Swift CLI's `kelpi md` → the frozen `open` wire command.
                const opened = await run(SWIFT_CLI, ['md', docPath], {
                    cwd: daemon.home,
                    env: {
                        HOME: daemon.home,
                        NEX_SOCKET: `tcp:127.0.0.1:${daemon.controlPort}`,
                        NEX_PANE_ID: paneID
                    }
                });
                check('the Swift CLI opens a markdown pane', opened.code === 0, opened.stderr.trim());
            } else {
                ws.send({
                    type: 'command',
                    id: 'ws-open',
                    payload: { command: 'open', path: docPath, pane_id: paneID }
                });
                const openReply = await ws.waitJson(
                    (m) => m.type === 'command-reply' && m.id === 'ws-open',
                    'the open reply'
                );
                check('the open wire command is accepted', openReply.reply?.ok === true, JSON.stringify(openReply.reply));
            }

            // `open` is fire-and-forget, so the new pane's identity comes from the delta stream —
            // exactly how the browser learns about it.
            const paneDelta = await ws.waitJson(
                (m) =>
                    m.type === 'delta' &&
                    m.events?.some(
                        (event) =>
                            event.kind === 'pane-upserted' &&
                            event.pane?.type === 'markdown' &&
                            event.pane?.filePath === docPath
                    ),
                'the markdown pane delta'
            );
            const markdownPaneID = paneDelta.events.find(
                (event) => event.kind === 'pane-upserted' && event.pane?.type === 'markdown'
            ).pane.id;
            check(
                'opening a file reaches the client as a markdown pane',
                typeof markdownPaneID === 'string',
                `${markdownPaneID} → ${docPath}`
            );

            ws.send({
                type: 'command',
                id: 'content-sub',
                payload: { command: 'content-subscribe', pane_id: markdownPaneID }
            });
            const subscribed = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'content-sub',
                'the content-subscribe reply'
            );
            const contentState = subscribed.reply?.state ?? {};
            check(
                'a subscribed client gets the rendered markdown',
                subscribed.reply?.ok === true &&
                    typeof contentState.html === 'string' &&
                    contentState.html.includes('hello from the smoke test'),
                `${String(contentState.html ?? '').length} bytes of HTML, mode ${contentState.mode}`
            );
            check(
                'the document carries the sibling-asset base',
                contentState.assetBase === `/pane-assets/${markdownPaneID}/` &&
                    String(contentState.html ?? '').includes(`<base href="/pane-assets/${markdownPaneID}/">`),
                String(contentState.assetBase)
            );

            // The base only works if the route behind it does: a relative `<img src>` in a note
            // is fetched from here.
            const assetResponse = await fetch(`${daemon.base}/pane-assets/${markdownPaneID}/smoke-asset.txt`);
            const assetBody = assetResponse.ok ? await assetResponse.text() : '';
            check(
                'the pane-assets route serves a file beside the markdown',
                assetResponse.ok && assetBody.includes('sibling asset'),
                `status ${assetResponse.status}`
            );
            // Percent-encoded so `fetch` cannot normalize the traversal away before it is sent:
            // the daemon has to be the one that refuses it.
            const escaped = await fetch(
                `${daemon.base}/pane-assets/${markdownPaneID}/%2E%2E%2F%2E%2E%2Fetc%2Fhosts`
            );
            check(
                'the pane-assets route refuses to escape the file’s directory',
                escaped.status === 404,
                `status ${escaped.status}`
            );

            // §3.16: a font-size change is a RE-RENDER, not a disk read — so the reply carries
            // new HTML at the new size while the source text is untouched.
            ws.send({
                type: 'command',
                id: 'content-font',
                payload: { command: 'content-set-font-size', pane_id: markdownPaneID, size: 18 }
            });
            const resized = await ws.waitJson(
                (m) => m.type === 'command-reply' && m.id === 'content-font',
                'the content-set-font-size reply'
            );
            check(
                'the font-size verb re-renders the preview at the new size',
                resized.reply?.ok === true &&
                    resized.reply?.state?.fontSize === 18 &&
                    String(resized.reply?.state?.html ?? '').includes('font-size: 18px'),
                `fontSize ${String(resized.reply?.state?.fontSize)}`
            );

            // The watcher: a write on disk (an agent editing the file, a save from vim) has to
            // reach every subscribed client without anyone asking.
            fs.appendFileSync(docPath, '\nappended by the watcher check\n', 'utf8');
            const updated = await ws.waitJson(
                (m) =>
                    m.type === 'content-updated' &&
                    m.paneID === markdownPaneID &&
                    String(m.state?.html ?? '').includes('appended by the watcher check'),
                'the content-updated event',
                20_000
            );
            check(
                'a write on disk arrives as a content-updated event',
                updated !== undefined,
                `revision ${updated.state?.revision}`
            );
        }
    } catch (error) {
        fail('smoke run', error instanceof Error ? error.message : String(error));
    } finally {
        ws?.close();
        if (options.keep) {
            process.stdout.write(
                `\nleaving the daemon up:\n  open ${daemon.base}/?token=${daemon.token}\n  NEX_SOCKET=tcp:127.0.0.1:${daemon.controlPort} kelpi pane list\n  stop it with: kill ${daemon.pid}   (state lives in ${daemon.root})\n`
            );
            // The child keeps this process's event loop alive through its stdio pipes; detach
            // from it so `--keep` returns to the shell instead of hanging on a daemon that is
            // supposed to outlive the run.
            daemon.detach();
        } else {
            await daemon.stop();
            daemon.cleanup();
        }
    }

    const failed = results.filter((result) => !result.ok);
    process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
    if (failed.length > 0) {
        process.stdout.write(`\n── daemon log ──\n${daemon.log()}\n`);
        process.exitCode = 1;
    }
}

await main();
