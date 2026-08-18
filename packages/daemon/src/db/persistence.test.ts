/// <reference types="node" />

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyDaemonState, makeWorkspaceState, toSnapshot, type PersistedSnapshot } from '../store/index.js';
import { PERSISTED_SNAPSHOT_VERSION } from '../store/index.js';
import { openSqliteDatabase, type SqlDatabase } from './adapter.js';
import { APP_STATE_ACTIVE_WORKSPACE, APP_STATE_TOP_LEVEL_ORDER } from './codec.js';
import { createPersistence, SAVE_DEBOUNCE_MS, type SqlitePersistence } from './persistence.js';
import { migrate } from './schema.js';

const W1 = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const W2 = '1DE27A23-1EDA-4967-B4A7-9746532F257A';
const G1 = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';
const P_SHELL = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const P_MARKDOWN = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const P_SCRATCH = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const P_WEB = '2415F59F-1EC1-4118-B66D-070DF303536B';
const P_PRIVATE = '4C4B2231-641C-493A-BA68-31639278ED15';
const P_DIFF = '2EBAAD98-4E01-41A7-93EB-C8DD48CB13B1';
const R1 = '6A8188E8-9161-47B7-BE9E-3708C943551D';
const A1 = '76A48E1B-3696-4853-8499-0122FADBABEF';
const TAB1 = '5F0C24D9-1111-4111-8111-111111111111';
const TAB2 = '5F0C24D9-2222-4222-8222-222222222222';

/** Multi-workspace / multi-group / every pane type / labels / web tabs / repos. */
function richSnapshot(): PersistedSnapshot {
    return {
        version: PERSISTED_SNAPSHOT_VERSION,
        workspaces: [
            {
                id: W1,
                name: 'nex',
                slug: 'nex-a4e8a251',
                color: 'purple',
                icon: { kind: 'system', name: 'star.fill' },
                profileName: 'work',
                layout: {
                    kind: 'split',
                    direction: 'horizontal',
                    ratio: 0.6,
                    first: { kind: 'leaf', paneID: P_SHELL },
                    second: {
                        kind: 'split',
                        direction: 'vertical',
                        ratio: 0.5,
                        first: { kind: 'leaf', paneID: P_MARKDOWN },
                        second: { kind: 'leaf', paneID: P_SCRATCH }
                    }
                },
                focusedPaneID: P_SHELL,
                createdAt: 1_755_500_000.123_456,
                lastAccessedAt: 1_755_500_900.5,
                labels: ['frontend', 'wip'],
                panes: [
                    {
                        id: P_SHELL,
                        label: 'coordinator',
                        type: 'shell',
                        workingDirectory: '/Users/test/code/nex',
                        createdAt: 1_755_500_000,
                        lastActivityAt: 1_755_500_800,
                        agentSessionID: 'f0e1d2c3-session',
                        agentKind: 'codex',
                        status: 'running',
                        filePath: null,
                        scratchpadContent: null,
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: false
                    },
                    {
                        id: P_MARKDOWN,
                        label: null,
                        type: 'markdown',
                        workingDirectory: '/Users/test/code/nex',
                        createdAt: 1_755_500_100,
                        lastActivityAt: 1_755_500_100,
                        agentSessionID: null,
                        agentKind: null,
                        status: 'idle',
                        filePath: '/Users/test/code/nex/PLAN.md',
                        scratchpadContent: null,
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: false
                    },
                    {
                        id: P_SCRATCH,
                        label: 'notes',
                        type: 'scratchpad',
                        workingDirectory: '/Users/test',
                        createdAt: 1_755_500_200,
                        lastActivityAt: 1_755_500_300,
                        agentSessionID: null,
                        agentKind: 'claude',
                        status: 'waitingForInput',
                        filePath: null,
                        scratchpadContent: '# scratch\n\nline two',
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: false
                    }
                ],
                repoAssociations: [
                    {
                        id: A1,
                        repoID: R1,
                        worktreePath: '/Users/test/code/nex',
                        branchName: 'main',
                        isAutoDetected: true
                    }
                ]
            },
            {
                id: W2,
                name: 'web',
                slug: 'web-1de27a23',
                color: 'blue',
                icon: { kind: 'emoji', grapheme: '📁' },
                profileName: null,
                layout: { kind: 'leaf', paneID: P_WEB },
                focusedPaneID: null,
                createdAt: 1_755_400_000,
                lastAccessedAt: 1_755_401_000,
                labels: [],
                panes: [
                    {
                        id: P_WEB,
                        label: 'docs',
                        type: 'web',
                        workingDirectory: '/Users/test',
                        createdAt: 1_755_400_000,
                        lastActivityAt: 1_755_400_500,
                        agentSessionID: null,
                        agentKind: null,
                        status: 'idle',
                        filePath: null,
                        scratchpadContent: null,
                        webTabs: [
                            { id: TAB1, url: 'https://example.com', title: 'Example Domain' },
                            { id: TAB2, url: 'http://localhost:3000', title: '' }
                        ],
                        webActiveTabID: TAB2,
                        webIsPrivate: false
                    },
                    {
                        id: P_PRIVATE,
                        label: null,
                        type: 'web',
                        workingDirectory: '/Users/test',
                        createdAt: 1_755_400_100,
                        lastActivityAt: 1_755_400_100,
                        agentSessionID: null,
                        agentKind: null,
                        status: 'idle',
                        filePath: null,
                        scratchpadContent: null,
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: true
                    },
                    {
                        id: P_DIFF,
                        label: null,
                        type: 'diff',
                        workingDirectory: '/Users/test/code/nex',
                        createdAt: 1_755_400_200,
                        lastActivityAt: 1_755_400_200,
                        agentSessionID: null,
                        agentKind: null,
                        status: 'idle',
                        filePath: 'packages/daemon',
                        scratchpadContent: null,
                        webTabs: null,
                        webActiveTabID: null,
                        webIsPrivate: false
                    }
                ],
                repoAssociations: []
            }
        ],
        groups: [
            {
                id: G1,
                name: 'work',
                color: 'orange',
                isCollapsed: true,
                childOrder: [W2],
                createdAt: 1_755_300_000,
                icon: { kind: 'system', name: 'folder' }
            }
        ],
        topLevelOrder: [
            { kind: 'workspace', id: W1 },
            { kind: 'group', id: G1 }
        ],
        activeWorkspaceID: W1,
        repos: [
            {
                id: R1,
                path: '/Users/test/code/nex',
                name: 'nex',
                remoteURL: 'https://github.com/user/nex.git',
                lastAccessedAt: 1_755_200_000.75,
                isAutoDiscovered: true
            }
        ],
        labelPresets: [
            { name: 'frontend', color: { kind: 'named', color: 'blue' }, textColor: null },
            {
                name: 'wip',
                color: { kind: 'custom', hex: '#ff00aa' },
                textColor: { kind: 'named', color: 'black' }
            }
        ]
    };
}

let tempDir = '';
let persistence: SqlitePersistence | null = null;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-db-'));
});

afterEach(() => {
    persistence?.close();
    persistence = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function dbPath(name = 'nex.db'): string {
    return path.join(tempDir, name);
}

describe('save → load round trip', () => {
    it('restores a rich snapshot byte-for-byte through a real file', () => {
        const file = dbPath();
        const snapshot = richSnapshot();

        const writer = createPersistence({ path: file });
        expect(writer.saveNow(snapshot)).toBe(true);
        writer.close();

        const reader = createPersistence({ path: file });
        persistence = reader;
        expect(reader.load()).toEqual(snapshot);
    });

    it('round-trips a snapshot produced by the store (toSnapshot)', () => {
        const state = {
            ...emptyDaemonState('/Users/test'),
            workspaces: [
                makeWorkspaceState({
                    id: W1,
                    name: 'nex',
                    slug: 'nex-a4e8a251',
                    color: 'blue',
                    createdAt: 1_755_500_000,
                    layout: { kind: 'leaf', paneID: P_SHELL },
                    focusedPaneID: P_SHELL,
                    panes: [
                        {
                            id: P_SHELL,
                            label: null,
                            type: 'shell',
                            title: 'live title',
                            workingDirectory: '/Users/test',
                            gitBranch: 'main',
                            status: 'running',
                            filePath: null,
                            isEditing: false,
                            externalEditorCommand: null,
                            scratchpadContent: null,
                            agentSessionID: 'abc',
                            agentKind: 'claude',
                            markdownFontSize: 20,
                            parkedSourcePaneID: null,
                            agentStartedAt: 1_755_500_000_000,
                            backgroundTaskCount: 3,
                            createdAt: 1_755_500_000,
                            lastActivityAt: 1_755_500_000
                        }
                    ]
                })
            ]
        };

        const file = dbPath();
        const writer = createPersistence({ path: file });
        expect(writer.saveNow(toSnapshot(state))).toBe(true);
        writer.close();

        const reader = createPersistence({ path: file });
        persistence = reader;
        const loaded = reader.load();
        expect(loaded?.workspaces[0]?.panes[0]).toMatchObject({
            id: P_SHELL,
            // Persisted verbatim; `applyLoadReset` (not persistence) does the clearing.
            status: 'running',
            agentSessionID: 'abc',
            agentKind: 'claude'
        });
        // Transient fields never reach the DB (§7.2).
        expect(loaded?.workspaces[0]?.panes[0]).not.toHaveProperty('title');
        expect(loaded?.workspaces[0]?.panes[0]).not.toHaveProperty('backgroundTaskCount');
    });

    it('replaces the previous snapshot wholesale (clear + reinsert)', () => {
        const file = dbPath();
        const writer = createPersistence({ path: file });
        persistence = writer;
        writer.saveNow(richSnapshot());

        const trimmed: PersistedSnapshot = {
            ...richSnapshot(),
            workspaces: [richSnapshot().workspaces[0]!],
            groups: [],
            repos: []
        };
        writer.saveNow(trimmed);

        const loaded = writer.load();
        expect(loaded?.workspaces.map((w) => w.id)).toEqual([W1]);
        expect(loaded?.groups).toEqual([]);
        expect(loaded?.repos).toEqual([]);
        // The cascade + explicit delete leave no orphan panes behind.
        const db = openSqliteDatabase(file);
        expect(db.all('SELECT "id" FROM "pane"').map((row) => row['id'])).toEqual([
            P_SHELL,
            P_MARKDOWN,
            P_SCRATCH
        ]);
        db.close();
    });

    it('rolls back a failed write, leaving the previous snapshot intact (§9.1)', () => {
        const file = dbPath();
        const real = openSqliteDatabase(file);
        migrate(real);
        let failWrites = false;
        const flaky: SqlDatabase = {
            get isOpen() {
                return real.isOpen;
            },
            exec: (sql) => real.exec(sql),
            prepare: (sql) => real.prepare(sql),
            all: (sql, ...params) => real.all(sql, ...params),
            get: (sql, ...params) => real.get(sql, ...params),
            run: (sql, ...params) => {
                if (failWrites && sql.startsWith('INSERT INTO "workspace_group"')) {
                    throw new Error('disk on fire');
                }
                return real.run(sql, ...params);
            },
            transaction: (body) => real.transaction(body),
            close: () => real.close()
        };

        const errors: unknown[] = [];
        const store = createPersistence({
            db: flaky,
            path: file,
            migrate: false,
            onError: (error) => errors.push(error)
        });
        persistence = store;

        const first = richSnapshot();
        expect(store.saveNow(first)).toBe(true);

        failWrites = true;
        expect(store.saveNow({ ...first, workspaces: [] })).toBe(false);
        expect(errors).toHaveLength(1);

        failWrites = false;
        expect(store.load()).toEqual(first);
    });

    it('reports load() as null for a fresh (empty) database without deleting it', () => {
        const file = dbPath();
        const empty = createPersistence({ path: file });
        persistence = empty;
        expect(empty.load()).toBeNull();
        expect(empty.loadOutcome().status).toBe('empty');
        expect(empty.loadOutcome().snapshot?.workspaces).toEqual([]);
        expect(fs.existsSync(file)).toBe(true);
    });
});

describe('written column encodings', () => {
    function readRow(file: string, sql: string): Record<string, unknown> {
        const db = openSqliteDatabase(file);
        const row = db.get(sql);
        db.close();
        return row as Record<string, unknown>;
    }

    it('writes epoch SECONDS, never milliseconds', () => {
        const file = dbPath();
        const writer = createPersistence({ path: file });
        persistence = writer;
        writer.saveNow(richSnapshot());

        const workspace = readRow(file, 'SELECT "createdAt","lastAccessedAt" FROM "workspace" WHERE "id" = \'' + W1 + "'");
        expect(workspace['createdAt']).toBe(1_755_500_000.123_456);
        expect(workspace['lastAccessedAt']).toBe(1_755_500_900.5);

        const pane = readRow(file, 'SELECT "createdAt","lastActivityAt" FROM "pane" WHERE "id" = \'' + P_SHELL + "'");
        expect(pane['createdAt']).toBe(1_755_500_000);
        expect(pane['lastActivityAt']).toBe(1_755_500_800);

        const repo = readRow(file, 'SELECT "lastAccessedAt" FROM "repo"');
        expect(repo['lastAccessedAt']).toBe(1_755_200_000.75);

        const group = readRow(file, 'SELECT "createdAt" FROM "workspace_group"');
        expect(group['createdAt']).toBe(1_755_300_000);

        const db = openSqliteDatabase(file);
        for (const [table, column] of [
            ['workspace', 'createdAt'],
            ['workspace', 'lastAccessedAt'],
            ['pane', 'createdAt'],
            ['pane', 'lastActivityAt'],
            ['repo', 'lastAccessedAt'],
            ['workspace_group', 'createdAt']
        ] as const) {
            const rows = db.all(`SELECT "${column}" AS t FROM "${table}"`);
            for (const row of rows) {
                const value = row['t'];
                expect(typeof value).toBe('number');
                // Anything ≥1e11 in a seconds column is a millisecond value (year 5138+).
                expect(Math.abs(value as number)).toBeLessThan(1e11);
            }
        }
        db.close();
    });

    it('normalizes a millisecond timestamp that leaks into the snapshot', () => {
        const file = dbPath();
        const snapshot = richSnapshot();
        const broken: PersistedSnapshot = {
            ...snapshot,
            workspaces: [{ ...snapshot.workspaces[0]!, createdAt: 1_755_500_000_500 }]
        };
        const writer = createPersistence({ path: file });
        persistence = writer;
        writer.saveNow(broken);
        expect(readRow(file, 'SELECT "createdAt" FROM "workspace"')['createdAt']).toBe(1_755_500_000.5);
    });

    it('writes uppercase UUIDs and the Swift `_0` JSON encodings', () => {
        const file = dbPath();
        const snapshot = richSnapshot();
        const lowercased: PersistedSnapshot = {
            ...snapshot,
            workspaces: [{ ...snapshot.workspaces[0]!, id: W1.toLowerCase(), panes: [] }],
            activeWorkspaceID: W1.toLowerCase()
        };
        const writer = createPersistence({ path: file });
        persistence = writer;
        writer.saveNow(lowercased);

        const workspace = readRow(file, 'SELECT "id","layoutJSON","labelsJSON","icon" FROM "workspace"');
        expect(workspace['id']).toBe(W1);
        expect(JSON.parse(String(workspace['layoutJSON']))).toEqual({
            split: {
                _0: 'horizontal',
                ratio: 0.6,
                first: { leaf: { _0: P_SHELL } },
                second: {
                    split: {
                        _0: 'vertical',
                        ratio: 0.5,
                        first: { leaf: { _0: P_MARKDOWN } },
                        second: { leaf: { _0: P_SCRATCH } }
                    }
                }
            }
        });
        expect(workspace['labelsJSON']).toBe('["frontend","wip"]');
        expect(workspace['icon']).toBe('system:star.fill');

        const db = openSqliteDatabase(file);
        const active = db.get('SELECT "value" FROM "appState" WHERE "key" = ?', APP_STATE_ACTIVE_WORKSPACE);
        expect(active?.['value']).toBe(W1);
        const order = db.get('SELECT "value" FROM "appState" WHERE "key" = ?', APP_STATE_TOP_LEVEL_ORDER);
        expect(JSON.parse(String(order?.['value']))).toEqual([
            { workspace: { _0: W1 } },
            { group: { _0: G1 } }
        ]);
        db.close();
    });

    it('stores private web panes as flag-only rows (§9.10)', () => {
        const file = dbPath();
        const writer = createPersistence({ path: file });
        persistence = writer;
        writer.saveNow(richSnapshot());

        const row = readRow(
            file,
            'SELECT "webIsPrivate","webTabsJSON","webActiveTabID","webURL" FROM "pane" WHERE "id" = \'' + P_PRIVATE + "'"
        );
        expect(row['webIsPrivate']).toBe(1);
        expect(row['webTabsJSON']).toBeNull();
        expect(row['webActiveTabID']).toBeNull();
        expect(row['webURL']).toBeNull();

        const publicRow = readRow(file, 'SELECT "webURL","webActiveTabID" FROM "pane" WHERE "id" = \'' + P_WEB + "'");
        // Legacy fallback column mirrors the ACTIVE tab.
        expect(publicRow['webURL']).toBe('http://localhost:3000');
        expect(publicRow['webActiveTabID']).toBe(TAB2);
    });
});

describe('debounce + flush (§5.2)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function workspaceNames(file: string): string[] {
        const db = openSqliteDatabase(file);
        const names = db.all('SELECT "name" FROM "workspace" ORDER BY "sortOrder"').map((row) => String(row['name']));
        db.close();
        return names;
    }

    it('coalesces rapid saves into one write, last snapshot wins', () => {
        const file = dbPath();
        const store = createPersistence({ path: file });
        persistence = store;

        const base = richSnapshot();
        store.scheduleSave({ ...base, workspaces: [{ ...base.workspaces[0]!, name: 'first' }] });
        vi.advanceTimersByTime(300);
        store.scheduleSave({ ...base, workspaces: [{ ...base.workspaces[0]!, name: 'second' }] });
        vi.advanceTimersByTime(300);
        // 600 ms since the first schedule, but only 300 ms of quiet: nothing written yet.
        expect(workspaceNames(file)).toEqual([]);
        expect(store.hasPendingSave()).toBe(true);

        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 300);
        expect(workspaceNames(file)).toEqual(['second']);
        expect(store.hasPendingSave()).toBe(false);
    });

    it('waits the full 500 ms quiet period', () => {
        const file = dbPath();
        const store = createPersistence({ path: file });
        persistence = store;

        store.scheduleSave(richSnapshot());
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
        expect(workspaceNames(file)).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(workspaceNames(file)).toEqual(['nex', 'web']);
    });

    it('flush() writes the pending snapshot synchronously (SIGTERM path)', () => {
        const file = dbPath();
        const store = createPersistence({ path: file });
        persistence = store;

        store.scheduleSave(richSnapshot());
        store.flush();
        expect(workspaceNames(file)).toEqual(['nex', 'web']);
        expect(store.hasPendingSave()).toBe(false);

        // The cancelled timer must not fire a second write.
        vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
        expect(workspaceNames(file)).toEqual(['nex', 'web']);
    });

    it('flush() with nothing pending is a no-op', () => {
        const file = dbPath();
        const store = createPersistence({ path: file });
        persistence = store;
        expect(() => store.flush()).not.toThrow();
        expect(workspaceNames(file)).toEqual([]);
    });

    it('close() flushes first, then refuses further saves', () => {
        const file = dbPath();
        const store = createPersistence({ path: file });
        store.scheduleSave(richSnapshot());
        store.close();
        expect(workspaceNames(file)).toEqual(['nex', 'web']);

        store.scheduleSave(richSnapshot());
        expect(store.hasPendingSave()).toBe(false);
        expect(store.saveNow(richSnapshot())).toBe(false);
        expect(() => store.close()).not.toThrow();
    });
});

describe('unknown tables, columns and appState keys are preserved', () => {
    it('never touches tables the daemon does not own', () => {
        const file = dbPath();
        const seed = openSqliteDatabase(file);
        migrate(seed);
        seed.exec(`
            CREATE TABLE "scheduledTask" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL, "workspaceName" TEXT NOT NULL);
            CREATE TABLE "workspaceFolder" ("id" TEXT PRIMARY KEY NOT NULL, "name" TEXT NOT NULL);
        `);
        seed.run('INSERT INTO "scheduledTask" ("id","name","workspaceName") VALUES (?,?,?)', 'T1', 'nightly', 'nex');
        seed.run('INSERT INTO "workspaceFolder" ("id","name") VALUES (?,?)', 'F1', 'archive');
        // The live schema carries this extra column on `workspace`.
        seed.exec('ALTER TABLE "workspace" ADD COLUMN "folderID" TEXT REFERENCES "workspaceFolder"("id") ON DELETE SET NULL');
        seed.close();

        const store = createPersistence({ path: file });
        persistence = store;
        store.saveNow(richSnapshot());
        store.saveNow(richSnapshot());

        const db = openSqliteDatabase(file);
        expect(db.all('SELECT "name" FROM "scheduledTask"')).toEqual([{ name: 'nightly' }]);
        expect(db.all('SELECT "name" FROM "workspaceFolder"')).toEqual([{ name: 'archive' }]);
        // The unknown column survives and defaults to NULL for rows we insert.
        expect(db.get('SELECT "folderID" FROM "workspace" WHERE "id" = ?', W1)).toEqual({ folderID: null });
        db.close();
    });

    it('upserts appState instead of clearing it (§9.3)', () => {
        const file = dbPath();
        const seed = openSqliteDatabase(file);
        migrate(seed);
        seed.run('INSERT INTO "appState" ("key","value") VALUES (?,?)', 'someFutureKey', 'keep me');
        seed.run('INSERT INTO "appState" ("key","value") VALUES (?,?)', APP_STATE_ACTIVE_WORKSPACE, 'stale');
        seed.close();

        const store = createPersistence({ path: file });
        persistence = store;
        store.saveNow(richSnapshot());

        const db = openSqliteDatabase(file);
        expect(db.get('SELECT "value" FROM "appState" WHERE "key" = ?', 'someFutureKey')).toEqual({
            value: 'keep me'
        });
        expect(db.get('SELECT "value" FROM "appState" WHERE "key" = ?', APP_STATE_ACTIVE_WORKSPACE)).toEqual({
            value: W1
        });
        db.close();
    });
});

describe('degradation on load', () => {
    function seeded(file: string, seedRows: (db: SqlDatabase) => void): SqlitePersistence {
        const db = openSqliteDatabase(file);
        migrate(db);
        seedRows(db);
        db.close();
        return createPersistence({ path: file });
    }

    it('skips rows with unparseable UUIDs and keeps their siblings', () => {
        const file = dbPath();
        const store = seeded(file, (db) => {
            const insertWorkspace =
                'INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON") VALUES (?,?,?,?,?,?,?,?,?)';
            db.run(insertWorkspace, W1, 'good', 'blue', '{"empty":{}}', 1, 1, 0, 'good-a4e8a251', '[]');
            db.run(insertWorkspace, 'not-a-uuid', 'bad', 'blue', '{"empty":{}}', 1, 1, 1, 'bad', '[]');
            const insertPane =
                'INSERT INTO "pane" ("id","workspaceID","type","workingDirectory","createdAt","lastActivityAt") VALUES (?,?,?,?,?,?)';
            db.run(insertPane, P_SHELL, W1, 'shell', '/tmp', 1, 1);
            db.run(insertPane, 'nope', W1, 'shell', '/tmp', 1, 1);
        });
        persistence = store;

        const loaded = store.load();
        expect(loaded?.workspaces.map((w) => w.name)).toEqual(['good']);
        expect(loaded?.workspaces[0]?.panes.map((p) => p.id)).toEqual([P_SHELL]);
    });

    it('degrades corrupt layout JSON and unknown enums without losing the workspace', () => {
        const file = dbPath();
        const store = seeded(file, (db) => {
            db.run(
                'INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON") VALUES (?,?,?,?,?,?,?,?,?)',
                W1,
                'My App!',
                'chartreuse',
                '{"split":{"_0":"sideways"',
                1,
                1,
                0,
                '', // v3 legacy default → regenerated
                'not json'
            );
            db.run(
                'INSERT INTO "pane" ("id","workspaceID","type","workingDirectory","createdAt","lastActivityAt","status","agentKind") VALUES (?,?,?,?,?,?,?,?)',
                P_SHELL,
                W1,
                'quantum',
                '/tmp',
                1,
                1,
                'exploded',
                'gemini'
            );
        });
        persistence = store;

        const workspace = store.load()?.workspaces[0];
        expect(workspace?.layout).toEqual({ kind: 'empty' });
        expect(workspace?.color).toBe('blue');
        expect(workspace?.labels).toEqual([]);
        expect(workspace?.slug).toBe('my-app-a4e8a251');
        expect(workspace?.panes[0]?.type).toBe('shell');
        expect(workspace?.panes[0]?.status).toBe('idle');
        expect(workspace?.panes[0]?.agentKind).toBeNull();
    });

    it('synthesizes topLevelOrder for a pre-groups DB', () => {
        const file = dbPath();
        const store = seeded(file, (db) => {
            const insert =
                'INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON") VALUES (?,?,?,?,?,?,?,?,?)';
            db.run(insert, W1, 'one', 'blue', '{"empty":{}}', 1, 1, 0, 'one', '[]');
            db.run(insert, W2, 'two', 'blue', '{"empty":{}}', 1, 1, 1, 'two', '[]');
        });
        persistence = store;

        expect(store.load()?.topLevelOrder).toEqual([
            { kind: 'workspace', id: W1 },
            { kind: 'workspace', id: W2 }
        ]);
    });

    it('returns null (not a crash, not a deletion) for an unreadable file', () => {
        const file = dbPath('corrupt.db');
        fs.writeFileSync(file, 'this is definitely not a sqlite database');
        const store = createPersistence({ path: file });
        persistence = store;

        expect(store.isAvailable).toBe(false);
        expect(store.load()).toBeNull();
        expect(store.loadOutcome().status).toBe('unreadable');
        expect(store.lastError).toBeTruthy();
        expect(fs.readFileSync(file, 'utf8')).toBe('this is definitely not a sqlite database');
        // Saves are dropped rather than throwing.
        expect(store.saveNow(richSnapshot())).toBe(false);
        expect(() => store.scheduleSave(richSnapshot())).not.toThrow();
    });

    it('returns null when a table is missing, leaving the file intact', () => {
        const file = dbPath();
        const seed = openSqliteDatabase(file);
        migrate(seed);
        seed.exec('DROP TABLE "workspace"');
        seed.close();

        const errors: string[] = [];
        const store = createPersistence({ path: file, onError: (_error, phase) => errors.push(phase) });
        persistence = store;

        expect(store.load()).toBeNull();
        expect(store.loadOutcome().status).toBe('unreadable');
        expect(errors).toContain('load');
        expect(fs.existsSync(file)).toBe(true);
    });

    it('reconstructs a pre-v13 web pane from webURL alone', () => {
        const file = dbPath();
        const store = seeded(file, (db) => {
            db.run(
                'INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt","sortOrder","slug","labelsJSON") VALUES (?,?,?,?,?,?,?,?,?)',
                W1,
                'web',
                'blue',
                '{"empty":{}}',
                1,
                1,
                0,
                'web',
                '[]'
            );
            db.run(
                'INSERT INTO "pane" ("id","workspaceID","type","workingDirectory","createdAt","lastActivityAt","webURL") VALUES (?,?,?,?,?,?,?)',
                P_WEB,
                W1,
                'web',
                '/tmp',
                1,
                1,
                'https://legacy.example'
            );
        });
        persistence = store;

        const pane = store.load()?.workspaces[0]?.panes[0];
        expect(pane?.webTabs).toEqual([{ id: expect.any(String), url: 'https://legacy.example', title: '' }]);
        expect(pane?.webActiveTabID).toBe(pane?.webTabs?.[0]?.id);
    });
});

describe('injected handles', () => {
    it('accepts a caller-owned in-memory database', () => {
        const db = openSqliteDatabase(':memory:');
        const store = createPersistence({ db, path: ':memory:' });
        expect(store.isAvailable).toBe(true);
        expect(store.saveNow(richSnapshot())).toBe(true);
        expect(store.load()).toEqual(richSnapshot());
        store.close();
    });
});
