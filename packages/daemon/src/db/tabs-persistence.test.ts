/**
 * Workspace tabs through a real SQLite file (workspace-feature.md §12.7, persistence.md).
 *
 * Restore, save, restore: a database is read and written on every boot, so whatever the restore
 * builds has to survive its own save. The recovered tab is the case that once did not (its id was
 * not a UUID, so the next load threw every tab away).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, fromSnapshot, toSnapshot, type DaemonState, type DomainAction } from '../store/index.js';
import { openSqliteDatabase } from './adapter.js';
import { createPersistence } from './persistence.js';

const W1 = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const P0 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const P1 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const P2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const T1 = '5F0C24D9-1111-4111-8111-111111111111';
const T2 = '5F0C24D9-2222-4222-8222-222222222222';
const NOW = 1_755_500_000_000;
const HOME = '/Users/test';

let dir = '';
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-tabs-'));
});
afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function state(...actions: DomainAction[]): DaemonState {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P0, name: 'dev', color: 'blue', now: NOW });
    for (const action of actions) store.dispatch(action);
    return store.getState();
}

const newTab = (tabID: string, paneID: string, focus?: boolean): DomainAction => ({
    type: 'create-tab',
    workspaceID: W1,
    tabID,
    ...(focus === undefined ? {} : { focus }),
    create: { type: 'create-pane', workspaceID: W1, paneID, now: NOW }
});

/** One boot: load the file, restore, and save what the restore built (the tail save). */
function boot(file: string): DaemonState {
    const persistence = createPersistence({ path: file });
    const snapshot = persistence.load();
    if (snapshot === null) throw new Error('nothing to load');
    const restored = fromSnapshot(snapshot, { homeDirectory: HOME });
    persistence.saveNow(toSnapshot(restored));
    persistence.close();
    return restored;
}

function save(file: string, value: DaemonState): void {
    const persistence = createPersistence({ path: file });
    persistence.saveNow(toSnapshot(value));
    persistence.close();
}

const shape = (value: DaemonState) =>
    value.workspaces.map((workspace) => ({
        active: workspace.activeTabID,
        layout: workspace.layout,
        tabs: workspace.tabs.map((tab) => ({ id: tab.id, name: tab.name, seen: tab.seen, layout: tab.stash?.layout ?? null }))
    }));

describe('tabs through SQLite', () => {
    it('restore, save, restore keeps every tab, its name, tree, focus and visit', () => {
        const file = path.join(dir, 'kelpi.db');
        const live = state(
            newTab(T1, P1),
            { type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'main' },
            newTab(T2, P2, false)
        );
        save(file, live);
        const first = boot(file);
        const second = boot(file);
        expect(shape(first)).toEqual(shape(live));
        expect(shape(second)).toEqual(shape(first));
    });

    it('recovers what an older daemon left behind into one tab, and keeps it that way', () => {
        const file = path.join(dir, 'kelpi.db');
        save(file, state(newTab(T1, P1)));
        // An older daemon's save: its INSERT has no tab columns, so they come back NULL.
        const db = openSqliteDatabase(file);
        db.run('UPDATE "workspace" SET "tabsJSON" = NULL, "activeTabID" = NULL');
        db.close();

        const first = boot(file);
        const workspace = first.workspaces[0];
        expect(workspace?.tabs).toHaveLength(2);
        expect(workspace?.tabs[1]?.seen).toBe(false);
        const recoveredID = workspace?.tabs[1]?.id ?? '';
        expect(recoveredID).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);

        const second = boot(file);
        expect(shape(second)).toEqual(shape(first));
        expect(second.workspaces[0]?.tabs[1]?.id).toBe(recoveredID);
    });

    it('keeps the other tabs when one entry is unreadable, recovering only its panes', () => {
        const file = path.join(dir, 'kelpi.db');
        save(file, state(newTab(T1, P1), newTab(T2, P2), { type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'main' }));
        const db = openSqliteDatabase(file);
        const row = db.all('SELECT "tabsJSON" FROM "workspace"')[0] as { tabsJSON: string };
        const entries = JSON.parse(row.tabsJSON) as { id: string; name: unknown }[];
        // T1's entry gets a name that is not a string: it alone is skipped.
        const broken = entries.map((entry) => (entry.id === T1 ? { ...entry, name: 7 } : entry));
        db.run('UPDATE "workspace" SET "tabsJSON" = ?', JSON.stringify(broken));
        db.close();

        const restored = boot(file).workspaces[0];
        expect(restored?.tabs[0]).toMatchObject({ id: W1, name: 'main' });
        expect(restored?.tabs.map((tab) => tab.id)).toContain(T2);
        // P1 is not lost: the recovered tab holds it.
        const recovered = restored?.tabs.find((tab) => tab.id !== W1 && tab.id !== T2);
        expect(recovered?.stash?.layout).toEqual({ kind: 'leaf', paneID: P1 });
    });

    it('reads an active tab id the column does not list as one tab, losing no pane', () => {
        const file = path.join(dir, 'kelpi.db');
        save(file, state(newTab(T1, P1)));
        const db = openSqliteDatabase(file);
        db.run('UPDATE "workspace" SET "activeTabID" = ?', '5F0C24D9-9999-4999-8999-999999999999');
        db.close();
        const restored = boot(file).workspaces[0];
        const panes = (restored?.tabs ?? []).flatMap((tab) =>
            tab.stash === null ? [restored?.layout] : [tab.stash.layout]
        );
        expect(JSON.stringify(panes)).toContain(P0);
        expect(JSON.stringify(panes)).toContain(P1);
    });
});
