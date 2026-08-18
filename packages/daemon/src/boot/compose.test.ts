/**
 * Composition-level behaviour that only shows up once the seams are wired together:
 * the fresh-install branch, the "persist only AFTER the resume went out" gate, the single
 * `pty.onExit → pane-process-terminated` subscription, and port-file reuse across restarts.
 */

import fs from 'node:fs';
import path from 'node:path';

import { leaf } from '@nex/core/layout';
import { afterEach, describe, expect, it } from 'vitest';

import { createPersistence } from '../db/index.js';
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
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-compose-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    return {
        root,
        runDir: path.join(root, 'run'),
        socketPath: path.join(root, 'nex.sock'),
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

    it('refuses to steal a live control socket, and leaves nothing bound behind', async () => {
        const first = scratch();
        const owner = daemonFor(first);
        await owner.start();

        // A second daemon (its own run dir + DB) pointed at the same CLI-compat socket.
        const second = scratch();
        const intruder = createDaemon({
            env: {},
            home: second.home,
            runDir: second.runDir,
            controlSocketPath: first.socketPath,
            dbPath: second.dbPath,
            configPath: second.configPath,
            httpPort: 0,
            settleMs: 0
        });
        cleanups.push(() => intruder.stop());

        await expect(intruder.start()).rejects.toMatchObject({ code: 'ECONTROLBUSY' });
        // Rollback: its own discovery socket must not be left listening.
        expect(fs.existsSync(intruder.paths.socket)).toBe(false);
        // The owner is untouched.
        expect(fs.existsSync(first.socketPath)).toBe(true);
        expect(owner.running).toBe(true);
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
});
