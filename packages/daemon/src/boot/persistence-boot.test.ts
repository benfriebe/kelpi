/**
 * Boot-level half of the P0 (`db/durability.test.ts` is the storage half).
 *
 * The observed failure: a daemon started with `NEXD_DB_PATH=/tmp/nexd-dev.db` came up, served a
 * full day of work, answered every health check cheerfully, printed a clean `nexd stop`, and had
 * written **zero bytes**. The chmod bug itself is fixed in `db/location.ts`; these tests pin the
 * semantics that make a future variant of it impossible to sit on:
 *
 *   1. persistence failure at boot is FATAL — the daemon refuses to start, names the file and
 *      the errno, and binds nothing;
 *   2. running without persistence is possible only on purpose, and says so on every boot;
 *   3. a degraded daemon reports it through `ping`, so `nexd status` cannot pretend;
 *   4. a mid-run save failure reaches attached clients as a broadcast, not just a log line;
 *   5. shutdown knows whether the final flush actually landed;
 *   6. and the whole thing works end to end through a shared parent directory: create state over
 *      the real control socket, stop, boot again, state is there.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { createLineBuffer } from '@nex/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase } from '../db/index.js';
import {
    ALLOW_EPHEMERAL_STATE_ENV,
    createDaemon,
    PERSISTENCE_DEGRADED_EVENT,
    type Daemon
} from './compose.js';

type Reply = Record<string, unknown>;

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

/**
 * Short paths (a unix socket path is capped near 104 bytes on macOS) and — the point of this
 * file — a database whose parent directory ALREADY EXISTS and is world-writable, the way /tmp
 * does. Every other suite hands the daemon a directory it creates itself, which is precisely
 * the case the bug could not happen in.
 */
function scratch(): Scratch {
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-pboot-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
        dbPath: path.join(shared, 'nex.db'),
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
        ...overrides
    });
    cleanups.push(() => daemon.stop());
    return daemon;
}

/** One request, one reply line, then EOF — exactly what the `nex` CLI does. */
function request(socketPath: string, message: Reply, timeoutMs = 10_000): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
        const socket = net.connect({ path: socketPath });
        const buffer = createLineBuffer();
        let settled = false;
        const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            fn();
        };
        const timer = setTimeout(
            () => finish(() => reject(new Error(`timeout: ${String(message['command'])}`))),
            timeoutMs
        );
        socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
        socket.on('data', (chunk: Buffer) => {
            for (const line of buffer.push(chunk)) {
                finish(() => resolve(JSON.parse(line) as Reply));
                return;
            }
        });
        socket.on('error', (error) => finish(() => reject(error)));
        socket.on('close', () => finish(() => reject(new Error('closed without a reply'))));
    });
}

function workspaceNamesIn(dbPath: string): string[] {
    const db = openSqliteDatabase(dbPath);
    try {
        return db.all('SELECT "name" FROM "workspace"').map((row) => String(row['name']));
    } finally {
        db.close();
    }
}

/** A parent directory this user cannot write into; reopened afterwards so cleanup works. */
function lockedDbPath(paths: Scratch): string {
    const dir = path.join(paths.root, 'locked');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o500);
    cleanups.push(() => {
        try {
            fs.chmodSync(dir, 0o700);
        } catch {
            // already gone
        }
    });
    return path.join(dir, 'nex.db');
}

// ── mid-run failure fixture ─────────────────────────────────────────────────────────
//
// Removing write permission after boot does NOT break a live daemon: SQLite holds the
// descriptor and keeps writing to the inode (verified). What DOES break it — and is a real
// thing that happens — is the file changing under it. A second connection drops a table the
// save writes into, so the daemon's very next transaction fails, exactly as it would against a
// truncated, corrupted or externally rewritten database.

function corruptDatabaseFile(dbPath: string): void {
    const handle = openSqliteDatabase(dbPath);
    try {
        handle.exec('DROP TABLE "pane"');
    } finally {
        handle.close();
    }
}

let counter = 0;
/** A store change, then a synchronous write attempt: the production save path, forced. */
function forceSave(daemon: Daemon): void {
    counter += 1;
    const suffix = String(counter).padStart(3, '0');
    daemon.store.dispatch({
        type: 'create-workspace',
        id: `CCCCCCCC-0000-4000-8000-000000000${suffix}`,
        paneID: `DDDDDDDD-0000-4000-8000-000000000${suffix}`,
        name: `forced-${suffix}`,
        now: Date.now()
    });
    daemon.persistence.flush();
}

describe('a daemon that cannot persist refuses to start', () => {
    it('throws a typed error naming the path and the errno, and binds nothing', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths, { dbPath: lockedDbPath(paths) });

        const failure = await daemon.start().then(
            () => undefined,
            (error: unknown) => error as NodeJS.ErrnoException & { repair?: string }
        );

        expect(failure).toBeDefined();
        expect(failure?.code).toBe('ENEXDPERSIST');
        expect(failure?.message).toContain('locked');
        expect(failure?.message).toContain('EACCES');
        expect(failure?.repair).toContain('NEXD_DB_PATH');

        // The refusal lands before any side effect: nothing created, nothing listening.
        expect(fs.existsSync(paths.socketPath)).toBe(false);
        expect(fs.existsSync(paths.runDir)).toBe(false);
        expect(daemon.running).toBe(false);
    });

    it('starts anyway — loudly — when the operator opts in', async () => {
        const paths = scratch();
        const logs: string[] = [];
        const daemon = daemonFor(paths, {
            dbPath: lockedDbPath(paths),
            env: { [ALLOW_EPHEMERAL_STATE_ENV]: '1' },
            onLog: (message) => logs.push(message)
        });

        const info = await daemon.start();

        expect(daemon.running).toBe(true);
        expect(info.persistence.degraded).toBe(true);
        // Two unmissable warnings: the opt-in, and the failure it is covering for.
        expect(logs.join('\n')).toContain(ALLOW_EPHEMERAL_STATE_ENV);
        expect(logs.join('\n')).toContain('WARNING: nexd cannot save state');
    });

    it('still allows an explicit in-memory database', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths, { dbPath: ':memory:' });

        const info = await daemon.start();

        expect(daemon.running).toBe(true);
        expect(info.persistence).toMatchObject({ available: true, degraded: false });
    });
});

describe('a degraded daemon says so', () => {
    it('ping carries the persistence block', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        await daemon.start();
        await daemon.restored;

        const healthy = await request(paths.socketPath, { command: 'ping' });
        expect(healthy['persistence']).toMatchObject({
            ok: true,
            degraded: false,
            path: paths.dbPath,
            failed_saves: 0
        });

        corruptDatabaseFile(paths.dbPath);
        forceSave(daemon);

        const degraded = await request(paths.socketPath, { command: 'ping' });
        // `ping` still succeeds — it is a liveness check. It just stops lying about health.
        expect(degraded['ok']).toBe(true);
        expect(degraded['persistence']).toMatchObject({
            ok: false,
            degraded: true,
            path: paths.dbPath,
            phase: 'save',
            failed_saves: 1
        });
    });

    it('broadcasts a client-visible warning when a save fails mid-run', async () => {
        const paths = scratch();
        const daemon = daemonFor(paths);
        await daemon.start();
        await daemon.restored;

        const events: Record<string, unknown>[] = [];
        const ws = daemon.ws;
        expect(ws).toBeDefined();
        const server = ws as unknown as { broadcast: (event: Record<string, unknown>) => void };
        const original = server.broadcast.bind(server);
        server.broadcast = (event) => {
            events.push(event);
            original(event);
        };

        corruptDatabaseFile(paths.dbPath);
        forceSave(daemon);

        const warning = events.find((event) => event['type'] === PERSISTENCE_DEGRADED_EVENT);
        expect(warning).toBeDefined();
        expect(warning).toMatchObject({ path: paths.dbPath, phase: 'save', failedSaves: 1 });
        expect(String(warning?.['error'])).toContain('pane');
    });

    it('shutdown reports that state was not written', async () => {
        const paths = scratch();
        const logs: string[] = [];
        const daemon = daemonFor(paths, { onLog: (message) => logs.push(message) });
        await daemon.start();
        await daemon.restored;

        corruptDatabaseFile(paths.dbPath);
        // A change that needs saving, then a shutdown whose flush cannot land.
        daemon.store.dispatch({
            type: 'create-workspace',
            id: 'EEEEEEEE-0000-4000-8000-000000000001',
            paneID: 'FFFFFFFF-0000-4000-8000-000000000001',
            name: 'doomed',
            now: Date.now()
        });
        await daemon.stop();

        const text = logs.join('\n');
        expect(text).toContain('shut down WITHOUT saving state');
        expect(text).toContain('nexd stopped (state NOT saved)');
        // The old build printed exactly this line over a database of zero bytes.
        expect(logs).not.toContain('nexd stopped');
        expect(daemon.persistenceHealth().degraded).toBe(true);
    });

    it('a healthy shutdown still says the ordinary thing', async () => {
        const paths = scratch();
        const logs: string[] = [];
        const daemon = daemonFor(paths, { onLog: (message) => logs.push(message) });
        await daemon.start();
        await daemon.restored;
        await daemon.stop();

        expect(logs).toContain('nexd stopped');
        expect(daemon.persistenceHealth().degraded).toBe(false);
    });
});

describe('end to end through a shared parent directory', () => {
    it('a workspace created over the control socket survives a restart', async () => {
        const paths = scratch();

        const first = daemonFor(paths);
        await first.start();
        await first.restored;

        // Exactly what `nex workspace create` sends.
        const created = await request(paths.socketPath, {
            command: 'workspace-create',
            name: 'survives-restart'
        });
        expect(created['ok']).toBe(true);

        // …and `ping` agrees that it is being written down. That is the check that was missing.
        const health = (await request(paths.socketPath, { command: 'ping' }))['persistence'] as Reply;
        expect(health).toMatchObject({ ok: true, degraded: false });

        await first.stop();

        // The file exists, is non-empty, and holds the workspace. The bug produced 0 bytes.
        expect(fs.statSync(paths.dbPath).size).toBeGreaterThan(0);
        expect(workspaceNamesIn(paths.dbPath)).toContain('survives-restart');

        const second = daemonFor(paths);
        const info = await second.start();

        expect(info.loadStatus).toBe('ok');
        expect(info.persistence.degraded).toBe(false);
        expect(second.store.getState().workspaces.map((workspace) => workspace.name)).toContain(
            'survives-restart'
        );
        await second.stop();
    });
});
