import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createDaemon } from '../boot/compose.js';
import { createPersistence } from '../db/persistence.js';
import { createStore } from '../store/store.js';
import { toSnapshot } from '../store/snapshot.js';
import { seededState, W1, NOW, id } from '../store/testing.js';

it('restarts a daemon with missing plugin panes without spawning substitute terminals', async () => {
    const root = fs.mkdtempSync('/tmp/kelpi-plugin-boot-');
    const paneID = id('aaaaaaaa', 8);
    const descriptor = { pluginID: 'missing.board', viewID: 'missing.board.view', stateVersion: 3, state: { query: 'keep me' } };
    const seed = seededState();
    const shellPaneID = seed.workspaces[0]!.panes[0]!.id;
    const store = createStore({ ...seed, homeDirectory: root, workspaces: seed.workspaces.map(workspace => ({ ...workspace, panes: workspace.panes.map(pane => ({ ...pane, workingDirectory: root })) })) });
    store.dispatch({ type: 'create-plugin-pane', workspaceID: W1, paneID, plugin: descriptor, title: 'Board', now: NOW });
    const dbPath = path.join(root, 'kelpi-v2.db');
    const db = createPersistence({ path: dbPath });
    expect(db.saveNow(toSnapshot(store.getState()))).toBe(true); db.close();
    try {
        for (let boot = 0; boot < 2; boot++) {
            const daemon = createDaemon({ env: {}, home: root, runDir: path.join(root, 'run'), controlSocketPath: path.join(root, 'control.sock'), dbPath, configPath: path.join(root, 'config'), httpPort: 0, settleMs: 0, spawn: { shell: '/bin/sh', cols: 80, rows: 24 } });
            try {
                await daemon.start(); await daemon.restored;
                expect(daemon.pty.has(shellPaneID.toUpperCase())).toBe(true);
                expect(daemon.pty.has(paneID.toUpperCase())).toBe(false);
                const restored = daemon.store.getState().workspaces[0]!.panes.find(pane => pane.id === paneID.toUpperCase());
                expect(restored).toMatchObject({ type: 'plugin', plugin: descriptor });
            } finally { await daemon.stop(); }
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
