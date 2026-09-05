/**
 * Composition-level behaviour that only shows up once the seams are wired together:
 * the fresh-install branch, the "persist only AFTER the resume went out" gate, the single
 * `pty.onExit → pane-process-terminated` subscription, and port-file reuse across restarts.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { leaf } from '@kelpi/core/layout';
import { afterEach, describe, expect, it } from 'vitest';

import { WS_PROTOCOL_VERSION } from '@kelpi/protocol';
import { WebSocket } from 'ws';

import { probeControlPing } from '../control/index.js';
import { createPersistence } from '../db/index.js';
import { spawnEnvVars } from '../handlers/pane/index.js';
import { mintDevice, revokeDevice } from '../lifecycle/index.js';
import { WS_CLOSE_CODES } from '../ws/sync.js';
import type { PersistedSnapshot } from '../store/index.js';
import { createDaemon, type Daemon } from './compose.js';
import { readPortFile, writePortFile } from './port.js';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
    while (cleanups.length > 0) {
        const cleanup = cleanups.pop();
        if (cleanup !== undefined) await cleanup();
    }
});

interface Scratch {
    readonly root: string;
    readonly runDir: string;
    readonly socketPath: string;
    readonly dbPath: string;
    readonly home: string;
    readonly configPath: string;
}

function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-compose-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'kelpi.sock'),
        dbPath: path.join(root, 'nex.db'),
        home,
        configPath: path.join(root, 'config')
    };
}

function daemonFor(paths: Scratch, overrides: Parameters<typeof createDaemon>[0] = {}): Daemon {
    const daemon = createDaemon({
        env: {},
        home: paths.home,
        runDir: paths.runDir,
        controlSocketPath: paths.socketPath,
        dbPath: paths.dbPath,
        configPath: paths.configPath,
        httpPort: 0,
        settleMs: 0,
        spawn: { cols: 80, rows: 24, shell: '/bin/sh' },
        // Nothing will ever attach to a daemon a unit test composes, so there is no window
        // whose measurement a restored pane's spawn should wait for (`pty/spawn-gate.ts`).
        // Zero is the headless daemon's own policy; the two tests at the bottom of this file
        // drive the boot window deliberately.
        bootDeferWindowMs: 0,
        ...overrides
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

const PANE = 'AAAAAAAA-0000-4000-8000-000000000001';
const WORKSPACE = 'BBBBBBBB-0000-4000-8000-000000000001';

function seedDatabase(dbPath: string, home: string, sessionID: string): void {
    const snapshot: PersistedSnapshot = {
        version: 1,
        workspaces: [
            {
                id: WORKSPACE,
                name: 'dev',
                slug: 'dev',
                color: 'blue',
                icon: null,
                profileName: null,
                layout: leaf(PANE),
                focusedPaneID: PANE,
                createdAt: 1_700_000_000,
                lastAccessedAt: 1_700_000_000,
                labels: [],
                panes: [
                    {
                        id: PANE,
                        label: 'agent',
                        type: 'shell',
                        workingDirectory: home,
                        createdAt: 1_700_000_000,
                        lastActivityAt: 1_700_000_000,
                        agentSessionID: sessionID,
                        agentKind: 'claude',
                        agentProfileName: null,
                        status: 'running',
                        filePath: null,
                        scratchpadContent: null,
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: false
                    }
                ],
                repoAssociations: []
            }
        ],
        groups: [],
        topLevelOrder: [{ kind: 'workspace', id: WORKSPACE }],
        activeWorkspaceID: WORKSPACE,
        repos: [],
        labelPresets: []
    };
    const persistence = createPersistence({ path: dbPath });
    expect(persistence.saveNow(snapshot)).toBe(true);
    persistence.close();
}

function readBack(dbPath: string): PersistedSnapshot | null {
    const persistence = createPersistence({ path: dbPath });
    const snapshot = persistence.load();
    persistence.close();
    return snapshot;
}

describe('createDaemon', () => {
    it('creates the Default workspace on a fresh install and persists it after the restore', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        const info = await daemon.start();

        expect(info.loadStatus).toBe('empty');
        const state = daemon.store.getState();
        expect(state.workspaces.map((workspace) => workspace.name)).toEqual(['Default']);
        expect(state.lastActiveWorkspaceID).toBe(state.workspaces[0]?.id);
        // The workspace's pane is a real shell with a live PTY.
        const paneID = state.workspaces[0]?.panes[0]?.id as string;
        expect(daemon.pty.has(paneID)).toBe(true);

        await daemon.restored;
        await daemon.stop();
        expect(readBack(paths.dbPath)?.workspaces.map((workspace) => workspace.name)).toEqual(['Default']);
    }, 20_000);

    it('gives the fresh-install Default workspace a palette pick, not the reducer fallback (#56)', async () => {
        // §12.2 creates "Default" with the full §4.1 semantics, whose step 3 is `nextRandomColor()`
        // (persistence.md §6.2 Case A says the same). The reducer's `?? 'blue'` must never be what
        // decides it. With no trailing workspace the pool is the whole 10-colour palette, so 0.35
        // lands on index 3: green, which also proves the injected stream reaches boot.
        const paths = scratch();
        const daemon = daemonFor(paths, { random: () => 0.35 });
        await daemon.start();

        expect(daemon.store.getState().workspaces[0]?.color).toBe('green');

        await daemon.restored;
        await daemon.stop();
        expect(readBack(paths.dbPath)?.workspaces[0]?.color).toBe('green');
    }, 20_000);

    it('holds every write back until the resume commands have gone out (§12.3 step 9)', async () => {
        const paths = scratch();
        seedDatabase(paths.dbPath, paths.home, 'sess-keepme');

        let releaseSettle: () => void = () => {};
        const settled = new Promise<void>((resolve) => {
            releaseSettle = resolve;
        });
        const daemon = daemonFor(paths, { sleep: () => settled, settleMs: 5 });
        const info = await daemon.start();

        expect(info.loadStatus).toBe('ok');
        expect(info.resumeTuples).toBe(1);
        // In memory the id is already cleared (capture-then-clear ran before the spawn)…
        expect(daemon.store.getState().workspaces[0]?.panes[0]?.agentSessionID).toBeNull();
        // …but the DB must still hold it: a crash before the resume has to be resumable.
        expect(readBack(paths.dbPath)?.workspaces[0]?.panes[0]?.agentSessionID).toBe('sess-keepme');
        // agentKind survives the reset (it is the badge's last-known value).
        expect(daemon.store.getState().workspaces[0]?.panes[0]?.agentKind).toBe('claude');

        releaseSettle();
        await daemon.restored;
        // Step 9: only now does the cleared state reach disk.
        daemon.persistence.flush();
        expect(readBack(paths.dbPath)?.workspaces[0]?.panes[0]?.agentSessionID).toBeNull();
    }, 20_000);

    it('keeps the session id in the DB when the daemon is stopped mid-restore', async () => {
        const paths = scratch();
        seedDatabase(paths.dbPath, paths.home, 'sess-unused');
        const daemon = daemonFor(paths, { sleep: () => new Promise<void>(() => {}) });
        await daemon.start();

        await daemon.stop();
        expect(readBack(paths.dbPath)?.workspaces[0]?.panes[0]?.agentSessionID).toBe('sess-unused');
    }, 20_000);

    it('closes a pane when its PTY exits', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        await daemon.start();
        await daemon.restored;

        const workspaceID = daemon.store.getState().workspaces[0]?.id as string;
        const paneID = daemon.store.getState().workspaces[0]?.panes[0]?.id as string;
        daemon.pty.kill(paneID);

        const deadline = Date.now() + 5_000;
        while (
            daemon.store.getState().workspaces.find((workspace) => workspace.id === workspaceID)?.panes.length !== 0 &&
            Date.now() < deadline
        ) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(
            daemon.store.getState().workspaces.find((workspace) => workspace.id === workspaceID)?.panes
        ).toEqual([]);
    }, 20_000);

    it('boots DEGRADED when another daemon owns the CLI-compat socket, leaving it untouched', async () => {
        const first = scratch();
        const owner = daemonFor(first);
        await owner.start();

        // A second daemon (its own run dir + DB) pointed at the same CLI-compat socket — the
        // shape of a machine where the Swift app owns `/tmp/nex.sock`. Refusing to boot here
        // used to take every pane, hook and client down with it; now the compat socket alone
        // degrades and the daemon serves its run-dir socket + pane-route TCP.
        const second = scratch();
        const intruder = createDaemon({
            env: {},
            home: second.home,
            runDir: second.runDir,
            controlSocketPath: first.socketPath,
            // A configured tcp-port (0 = ephemeral here) must survive the degraded unix bind:
            // dev-container `NEX_SOCKET=tcp:…` clients keep working while the Swift app keeps
            // the socket file. `startCompat` salvages it with a standalone TCP bind.
            tcpPort: 0,
            dbPath: second.dbPath,
            configPath: second.configPath,
            httpPort: 0,
            settleMs: 0
        });
        cleanups.push(() => intruder.stop());

        const info = await intruder.start();
        expect(intruder.running).toBe(true);
        expect(fs.existsSync(intruder.paths.socket)).toBe(true);
        expect(intruder.ctx.controlTransport?.().tcp?.bound).not.toBeNull();

        // The degraded state is a `ping`-visible fact, not just a log line.
        const transport = intruder.ctx.controlTransport?.();
        expect(transport?.compat).toMatchObject({ path: first.socketPath });
        expect(transport?.compat?.error).toContain('already owned by a live daemon');
        // The pane route is the intruder's OWN loopback TCP listener — the env every pane it
        // spawns will carry — never the socket the other daemon owns.
        expect(transport?.paneRoute).toMatch(/^tcp:127\.0\.0\.1:\d+$/);
        expect(info.socketPath).toBe(first.socketPath);

        // The degraded state travels the wire: a real `ping` over the run-dir socket decodes
        // into the same facts `kelpid status` and `kelpi doctor` print.
        const probed = await probeControlPing({ socketPath: intruder.paths.socket });
        expect(probed.alive).toBe(true);
        expect(probed.compat).toMatchObject({ path: first.socketPath });
        expect(probed.paneRoute).toMatch(/^tcp:127\.0\.0\.1:\d+$/);

        // The owner is untouched: still running, still the one serving the compat path.
        expect(fs.existsSync(first.socketPath)).toBe(true);
        expect(owner.running).toBe(true);
        expect(owner.ctx.controlTransport?.().compat ?? null).toBeNull();

        // Stopping the degraded daemon must not unlink the socket it never bound.
        await intruder.stop();
        expect(fs.existsSync(first.socketPath)).toBe(true);
    }, 20_000);

    it('injects the pane route + bundled-CLI PATH into every spawn env, and the route answers', async () => {
        const paths = scratch();
        const helpers = path.join(paths.root, 'helpers');
        fs.mkdirSync(helpers, { recursive: true });
        const daemon = daemonFor(paths, { env: { KELPID_HELPERS_DIR: helpers } });
        await daemon.start();
        await daemon.restored;

        const workspace = daemon.store.getState().workspaces[0];
        expect(workspace).toBeDefined();
        const env = spawnEnvVars(
            daemon.ctx,
            'CCCCCCCC-0000-4000-8000-000000000001',
            workspace as NonNullable<typeof workspace>
        );
        const byKey = Object.fromEntries(env.map((entry) => [entry.key, entry.value]));
        // The bundled CLI shadows whatever the inherited PATH resolves.
        expect(byKey['PATH']?.startsWith(`${helpers}:`)).toBe(true);
        // The injected KELPI_SOCKET is the daemon's own loopback TCP listener…
        expect(byKey['KELPI_SOCKET']).toMatch(/^tcp:127\.0\.0\.1:\d+$/);
        expect(daemon.ctx.controlTransport?.().paneRoute).toBe(byKey['KELPI_SOCKET']);

        // …and it ANSWERS: a `ping` over exactly that route reaches exactly this daemon.
        const port = Number((byKey['KELPI_SOCKET'] as string).split(':').pop());
        const reply = await new Promise<string>((resolve, reject) => {
            const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
                socket.write('{"command":"ping"}\n');
            });
            const chunks: Buffer[] = [];
            socket.on('data', (chunk) => chunks.push(chunk));
            socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            socket.on('error', reject);
        });
        const parsed = JSON.parse(reply) as { ok: boolean; pid: number };
        expect(parsed.ok).toBe(true);
        expect(parsed.pid).toBe(process.pid);
    }, 20_000);

    it('reuses the remembered HTTP port, and falls back when it is taken', async () => {
        const paths = scratch();
        const first = daemonFor(paths);
        const info = await first.start();
        expect(readPortFile(first.paths)).toBe(info.httpPort);
        await first.stop();
        // The port file deliberately outlives the daemon: the next boot keeps the URL stable.
        expect(readPortFile(first.paths)).toBe(info.httpPort);

        const second = daemonFor(paths, { httpPort: undefined });
        const reused = await second.start();
        expect(reused.httpPort).toBe(info.httpPort);
        await second.stop();

        // A port that is no longer bindable must not stop the daemon from coming up.
        writePortFile(second.paths, 1); // privileged port: bind fails for a normal user
        const third = daemonFor(paths, { httpPort: undefined });
        const fallback = await third.start();
        expect(fallback.httpPort).toBeGreaterThan(1024);
        await third.stop();
    }, 30_000);

    /*
     * §SET-022 / §AGNT-005: `tcp-port` is the one general setting whose effect is a LISTENER,
     * so a Settings write has to move it NOW rather than being filed away for the next boot.
     *
     * Driven through the settings service (the same `set-general-setting` path Settings ▸
     * General ▸ Network uses), against a daemon with no `KELPID_TCP_PORT` in its environment —
     * an env-supplied port deliberately outranks the file and is not re-bound (a dev container
     * asked for that port on the command line).
     */
    it('binds, re-binds and tears down the control TCP listener from a live settings write', async () => {
        const paths = scratch();
        fs.writeFileSync(paths.configPath, 'tcp-port = 0\n');
        const daemon = daemonFor(paths);
        await daemon.start();
        // Read through the same accessor `ping`, `kelpid status` and Settings ▸ Network read, so
        // this asserts what those three report rather than which server object holds it.
        const tcp = (): { requested: number; bound: number | null } | null =>
            (daemon.ctx.controlTransport?.().tcp ?? null) as { requested: number; bound: number | null } | null;
        expect(tcp()).toBeNull();

        daemon.settings.setGeneralSetting('tcp-port', '49222');
        await new Promise((resolve) => setTimeout(resolve, 200));
        const bound = tcp();
        // A port that is already taken on the runner is a legitimate outcome of the same call:
        // what must be true either way is that the daemon TRIED, now, for the new port.
        expect(bound?.requested).toBe(49222);
        if (bound?.bound !== null) expect(bound?.bound).toBe(49222);

        // …and turning it off closes it, without a restart.
        daemon.settings.setGeneralSetting('tcp-port', '0');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(tcp()).toBeNull();

        // The file is the store, in both directions: the last write is what a hand-edit sees.
        expect(fs.readFileSync(paths.configPath, 'utf8')).toContain('tcp-port = 0');
        await daemon.stop();
    }, 30_000);

    /*
     * The spawn gate, composed (`pty/spawn-gate.ts`).
     *
     * `pid()` is the honest probe here and `has()` is not: a pane whose spawn is still being
     * held deliberately reads as live (a write to it lands, because the write flushes the
     * gate), so only the child process id distinguishes "waiting" from "running".
     */
    it('spawns a fresh install pane immediately when no window is expected', async () => {
        const paths = scratch();
        // A CLI-only daemon: the compat suite, CI, `kelpid start` on a headless box. There is
        // nobody to report a grid, so waiting for one would buy nothing and cost a second.
        const daemon = daemonFor(paths, { bootDeferWindowMs: 0 });
        await daemon.start();

        const paneID = daemon.store.getState().workspaces[0]?.panes[0]?.id as string;
        expect(daemon.pty.pid(paneID)).toEqual(expect.any(Number));
    }, 20_000);

    it('holds that spawn inside the boot window, then gives up and spawns anyway', async () => {
        const paths = scratch();
        // The launched-with-a-window case: nothing is attached yet (the WS server is not even
        // listening when panes are restored), so boot bets on the window that is on its way.
        const daemon = daemonFor(paths, { bootDeferWindowMs: 5000, spawnDeferTimeoutMs: 250 });
        await daemon.start();

        const paneID = daemon.store.getState().workspaces[0]?.panes[0]?.id as string;
        // Nothing has measured the pane, so no shell has printed a prompt at a guessed width.
        expect(daemon.pty.pid(paneID)).toBeUndefined();
        // …and it still reads as a live pane, which is what keeps a `pane send` landing.
        expect(daemon.pty.has(paneID)).toBe(true);

        // No window ever arrives: the wait is bounded, and what follows it is exactly the
        // behaviour this daemon had before the gate existed.
        const deadline = Date.now() + 5000;
        while (daemon.pty.pid(paneID) === undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(daemon.pty.pid(paneID)).toEqual(expect.any(Number));
    }, 20_000);

    it('cuts a LIVE paired-device session when the registry revokes it (the watcher path)', async () => {
        const paths = scratch();
        const devicesFile = path.join(paths.root, 'devices.json');
        const daemon = daemonFor(paths, { env: { KELPID_DEVICES_PATH: devicesFile } });
        const info = await daemon.start();

        // Pair exactly as the CLI does — the daemon must notice the file, not a command.
        const minted = mintDevice(devicesFile, 'test-tablet');

        const socket = new WebSocket(`ws://127.0.0.1:${String(info.httpPort)}/ws?token=${minted.token}`);
        cleanups.push(() => socket.close());
        const messages: Record<string, unknown>[] = [];
        const waitFor = (predicate: (m: Record<string, unknown>) => boolean, label: string): Promise<Record<string, unknown>> =>
            new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 10_000);
                const check = (): void => {
                    const hit = messages.find(predicate);
                    if (hit !== undefined) {
                        clearTimeout(timer);
                        socket.off('message', onMessage);
                        resolve(hit);
                    }
                };
                const onMessage = (): void => check();
                socket.on('message', onMessage);
                check();
            });
        socket.on('message', (data) => {
            messages.push(JSON.parse(String(data)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve, reject) => {
            socket.once('open', () => resolve());
            socket.once('error', reject);
        });
        socket.send(
            JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token: minted.token })
        );
        await waitFor((m) => m['type'] === 'welcome', 'welcome');

        // The revoke is a plain registry write (write-then-rename); the daemon's watcher must
        // notice on its own and cut the session mid-stream with the reason a client can act on.
        const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
        expect(revokeDevice(devicesFile, minted.device.id)).not.toBeNull();
        const rejected = await waitFor((m) => m['type'] === 'rejected', 'the revoked cut');
        expect(rejected).toMatchObject({ code: 'unauthorized', reason: 'revoked' });
        expect(await closed).toBe(WS_CLOSE_CODES.unauthorized);
    }, 20_000);
});
