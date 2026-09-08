import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { allPaneIDs } from '@kelpi/core/layout';
import { createStore } from '../store/store.js';
import { seededState, W1, W2, id, NOW, HOME } from '../store/testing.js';
import { toSnapshot, fromSnapshot } from '../store/snapshot.js';
import { createPersistence } from '../db/persistence.js';
import { openSqliteDatabase } from '../db/adapter.js';
import { decodePaneRow, encodePaneRow } from '../db/codec.js';
import { migrateDatabaseGeneration } from '../db/generation.js';

const P = id('aaaaaaaa', 8);
const descriptor = { pluginID: 'sample.board', viewID: 'sample.board.view', stateVersion: 3, state: { filter: 'active', rows: ['one'] } };
describe('plugin pane persistence and layout', () => {
    it('retains parked plugin state across restart and restores zoom to the complete layout', () => {
        const store = createStore(seededState());
        store.dispatch({ type: 'create-plugin-pane', workspaceID: W1, paneID: P, plugin: descriptor, title: 'Board', now: NOW });
        store.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(allPaneIDs(toSnapshot(store.getState()).workspaces[0]!.layout)).toHaveLength(2);
        store.dispatch({ type: 'park-pane', workspaceID: W1, paneID: P });
        store.dispatch({ type: 'set-plugin-pane-state', paneID: P, plugin: { ...descriptor, state: { updatedWhileParked: true } } });
        const db = createPersistence({ path: ':memory:' });
        try {
            expect(db.saveNow(toSnapshot(store.getState()))).toBe(true);
            const restored = fromSnapshot(db.load()!, { homeDirectory: HOME });
            const workspace = restored.workspaces[0]!;
            expect(workspace.panes.some(pane => pane.id === P.toUpperCase())).toBe(false);
            expect(workspace.parkedPanes[0]).toMatchObject({ id: P.toUpperCase(), plugin: { state: { updatedWhileParked: true } } });
            expect(allPaneIDs(workspace.layout)).not.toContain(P.toUpperCase());
        } finally { db.close(); }
    });
    it('keeps layout, identity, state and undo when moved, closed, reopened and saved repeatedly', () => {
        const store = createStore(seededState());
        store.dispatch({ type: 'create-plugin-pane', workspaceID: W1, paneID: P, plugin: descriptor, title: 'Board', now: NOW });
        expect(allPaneIDs(store.getState().workspaces[0]!.layout)).toContain(P);
        store.dispatch({ type: 'create-workspace', id: W2, paneID: id('bbbbbbbb', 9), name: 'Second', color: 'blue', now: NOW });
        store.dispatch({ type: 'move-pane-to-workspace', paneID: P, toWorkspaceID: W2 });
        store.dispatch({ type: 'close-pane', workspaceID: W2, paneID: P });
        store.dispatch({ type: 'reopen-closed-pane', workspaceID: W2, paneID: P, now: NOW });
        const db = createPersistence({ path: ':memory:' });
        try {
            expect(db.saveNow(toSnapshot(store.getState())), String(db.lastError)).toBe(true);
            const restored = fromSnapshot(db.load()!, { homeDirectory: HOME });
            expect(restored.workspaces.find(workspace => workspace.id === W2.toUpperCase())?.panes.find(pane => pane.id === P.toUpperCase())).toMatchObject({ id: P.toUpperCase(), type: 'plugin', plugin: descriptor });
            expect(db.saveNow(toSnapshot(restored))).toBe(true);
            expect(db.load()!.workspaces.find(workspace => workspace.id === W2.toUpperCase())?.panes.find(pane => pane.id === P.toUpperCase())?.plugin).toEqual(descriptor);
        } finally { db.close(); }
    });
    it('retains unknown kinds and malformed future descriptors through ordinary saves without turning them into shells', () => {
        for (const type of ['future-pane', 'plugin']) {
            const pluginJSON = '{"futureVersion":22,"data":[1,2]}';
            const decoded = decodePaneRow({ id: P, workspaceID: W1, type, pluginJSON });
            expect(decoded?.pane.type).toBe('plugin');
            const encoded = encodePaneRow(decoded!.pane, W1);
            expect(encoded.type).toBe(type); expect(encoded.pluginJSON).toBe(pluginJSON);
        }
    });
    it('copies committed WAL state into a new generation and leaves the old database usable for rollback', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-db-generation-'));
        const oldPath = path.join(root, 'kelpi.db'), nextPath = path.join(root, 'kelpi-v2.db');
        const old = openSqliteDatabase(oldPath);
        try {
            old.exec('CREATE TABLE example (id TEXT PRIMARY KEY, value TEXT); INSERT INTO example VALUES (\'id\', \'before\')');
            migrateDatabaseGeneration(nextPath);
            const next = openSqliteDatabase(nextPath);
            try {
                expect(next.get('SELECT value FROM example')?.['value']).toBe('before');
                next.run('UPDATE example SET value = ?', 'after');
                expect(old.get('SELECT value FROM example')?.['value']).toBe('before');
                migrateDatabaseGeneration(nextPath);
                expect(next.get('SELECT value FROM example')?.['value']).toBe('after');
            } finally { next.close(); }
        } finally { old.close(); fs.rmSync(root, { recursive: true, force: true }); }
    });
});
