/**
 * `runImport`: write the converted snapshot into a target daemon database through the existing
 * persistence layer, and refuse anything that would lose state.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_WORKSPACE_NAME } from '../boot/index.js';
import { createPersistence, openSqliteDatabase } from '../db/index.js';
import { FRESH_INSTALL_WORKSPACE_NAME, runImport } from './importer.js';
import { isLegacyImportError, type LegacyImportError } from './reader.js';
import {
    legacyGroup,
    legacyPane,
    legacyRepo,
    legacyRepoAssociation,
    legacyWorkspace,
    realLayoutJSON,
    writeLegacyDatabase,
    type LegacyDatabaseSpec
} from './testing.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
});

function scratchDir(): string {
    const root = fs.mkdtempSync(path.join('/tmp', 'kelpid-import-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

const WS_A = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const WS_B = '1DE27A23-1EDA-4967-B4A7-9746532F257A';
const PANE_A1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const PANE_A2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const PANE_A3 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const GROUP_ID = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';
const REPO_ID = 'C1DFCF02-F226-4075-9944-86C5E5E42820';

function sourceSpec(): LegacyDatabaseSpec {
    return {
        workspaces: [
            legacyWorkspace({
                id: WS_A,
                name: 'Alpha',
                layoutJSON: realLayoutJSON()[0] as string,
                labelsJSON: '["wip"]',
                sortOrder: 0
            }),
            legacyWorkspace({ id: WS_B, name: 'Beta', sortOrder: 1 })
        ],
        panes: [
            legacyPane({ id: PANE_A1, workspaceID: WS_A, label: 'coordinator' }),
            legacyPane({
                id: PANE_A2,
                workspaceID: WS_A,
                status: 'running',
                agentSessionID: 'sess-abc123',
                agentKind: 'codex'
            }),
            legacyPane({ id: PANE_A3, workspaceID: WS_A }),
            legacyPane({ id: 'not-a-uuid', workspaceID: WS_A })
        ],
        repos: [legacyRepo({ id: REPO_ID, path: '/Users/dev/app', name: 'app' })],
        repoAssociations: [
            legacyRepoAssociation({
                id: '22222222-2222-4222-8222-222222222222',
                workspaceID: WS_A,
                repoID: REPO_ID,
                worktreePath: '/Users/dev/app'
            })
        ],
        groups: [legacyGroup({ id: GROUP_ID, name: 'agents', childOrderJSON: `["${WS_B}"]` })],
        appState: [
            { key: 'activeWorkspaceID', value: WS_A },
            { key: 'topLevelOrder', value: `[{"workspace":{"_0":"${WS_A}"}},{"group":{"_0":"${GROUP_ID}"}}]` }
        ]
    };
}

function makeSource(spec: LegacyDatabaseSpec = sourceSpec()): string {
    const file = path.join(scratchDir(), 'nex.db');
    writeLegacyDatabase(file, spec);
    return file;
}

/** Seed a target database with one workspace, the way a running daemon would leave it. */
function seedTarget(target: string, name: string): void {
    const persistence = createPersistence({ path: target });
    persistence.saveNow({
        version: 1,
        workspaces: [
            {
                id: '99999999-9999-4999-8999-999999999999',
                name,
                slug: 'existing-99999999',
                color: 'blue',
                icon: null,
                profileName: null,
                muted: false,
                layout: { kind: 'empty' },
                focusedPaneID: null,
                createdAt: 1_776_000_000,
                lastAccessedAt: 1_776_000_000,
                labels: [],
                panes: [],
                repoAssociations: []
            }
        ],
        groups: [],
        topLevelOrder: [],
        activeWorkspaceID: null,
        repos: [],
        labelPresets: []
    });
    persistence.close();
}

function workspaceNames(target: string): string[] {
    const persistence = createPersistence({ path: target });
    const snapshot = persistence.load();
    persistence.close();
    return (snapshot?.workspaces ?? []).map((workspace) => workspace.name);
}

const FRESH_WS = '88888888-8888-4888-8888-888888888888';
const FRESH_PANE = '77777777-7777-4777-8777-777777777777';

/** Seed a target the way a first launch of Kelpi.app leaves it: "Default" with one shell pane. */
function seedFreshInstall(target: string): void {
    const persistence = createPersistence({ path: target });
    persistence.saveNow({
        version: 1,
        workspaces: [
            {
                id: FRESH_WS,
                name: 'Default',
                slug: 'default-88888888',
                color: 'purple',
                icon: null,
                profileName: null,
                muted: false,
                layout: { kind: 'leaf', paneID: FRESH_PANE },
                focusedPaneID: FRESH_PANE,
                createdAt: 1_776_000_000,
                lastAccessedAt: 1_776_000_000,
                labels: [],
                panes: [
                    {
                        id: FRESH_PANE,
                        label: null,
                        type: 'shell',
                        workingDirectory: '/Users/dev',
                        createdAt: 1_776_000_000,
                        lastActivityAt: 1_776_000_000,
                        agentSessionID: null,
                        agentKind: null,
                        agentProfileName: null,
                        status: 'idle',
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
        topLevelOrder: [{ kind: 'workspace', id: FRESH_WS }],
        activeWorkspaceID: FRESH_WS,
        repos: [],
        labelPresets: []
    });
    persistence.close();
}

/** Change a seeded target behind the persistence layer's back, the way use would. */
function alterTarget(target: string, sql: string): void {
    const db = openSqliteDatabase(target, { wal: false });
    try {
        db.exec(sql);
    } finally {
        db.close();
    }
}

describe('runImport — into a fresh target', () => {
    it('writes the whole snapshot and reports what landed', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');

        const report = runImport({ from, to });

        expect(report.written).toBe(true);
        expect(report.dryRun).toBe(false);
        expect(report.backupPath).toBeNull();
        expect(report.targetWorkspacesBefore).toBe(0);
        expect(report.targetFreshInstall).toBe(false);
        expect(report).toMatchObject({
            from,
            to,
            workspaces: 2,
            panes: 3,
            groups: 1,
            repos: 1,
            repoAssociations: 1,
            resumable: 1
        });
        expect(report.skipped).toEqual([{ table: 'pane', id: 'not-a-uuid', reason: 'unparseable pane id' }]);
        expect(report.ledger.unknown).toEqual([]);

        const persistence = createPersistence({ path: to });
        const snapshot = persistence.load();
        persistence.close();
        expect(snapshot?.workspaces.map((workspace) => workspace.name)).toEqual(['Alpha', 'Beta']);
        expect(snapshot?.workspaces[0]?.labels).toEqual(['wip']);
        expect(snapshot?.workspaces[0]?.layout.kind).toBe('split');
        expect(snapshot?.workspaces[0]?.panes).toHaveLength(3);
        expect(snapshot?.groups.map((group) => group.name)).toEqual(['agents']);
        expect(snapshot?.groups[0]?.childOrder).toEqual([WS_B]);
        expect(snapshot?.topLevelOrder).toEqual([
            { kind: 'workspace', id: WS_A },
            { kind: 'group', id: GROUP_ID }
        ]);
        expect(snapshot?.activeWorkspaceID).toBe(WS_A);
        expect(snapshot?.repos[0]?.path).toBe('/Users/dev/app');
        // The resume contract survives the write, the live status does not.
        const agent = snapshot?.workspaces[0]?.panes.find((entry) => entry.id === PANE_A2);
        expect(agent?.agentSessionID).toBe('sess-abc123');
        expect(agent?.agentKind).toBe('codex');
        expect(agent?.status).toBe('idle');
        // Labels get their managed preset back (the Swift app kept them outside nex.db).
        expect(snapshot?.labelPresets).toEqual([
            { name: 'wip', color: { kind: 'named', color: 'gray' }, textColor: null }
        ]);
    });

    it('leaves the source byte-identical', () => {
        const from = makeSource();
        const before = fs.readFileSync(from);
        runImport({ from, to: path.join(scratchDir(), 'kelpid.db') });
        expect(fs.readFileSync(from).equals(before)).toBe(true);
    });
});

describe('runImport — a populated target', () => {
    it('refuses without --force and writes nothing', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        seedTarget(to, 'existing');
        const before = fs.readFileSync(to);

        try {
            runImport({ from, to });
            expect.unreachable('should have refused');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            expect((error as LegacyImportError).code).toBe('target-populated');
            expect((error as LegacyImportError).message).toContain('already holds 1 workspace(s)');
            expect((error as LegacyImportError).repair).toContain('--force');
        }

        expect(workspaceNames(to)).toEqual(['existing']);
        expect(fs.readFileSync(to).equals(before)).toBe(true);
    });

    it('refuses a dry run too, rather than promising an import that would fail', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        seedTarget(to, 'existing');
        expect(() => runImport({ from, to, dryRun: true })).toThrow(/already holds/);
    });

    it('with --force, backs the target up first and then replaces it', () => {
        const from = makeSource();
        const dir = scratchDir();
        const to = path.join(dir, 'kelpid.db');
        seedTarget(to, 'existing');

        const report = runImport({
            from,
            to,
            force: true,
            now: () => new Date('2026-08-19T10:11:12.345Z')
        });

        expect(report.written).toBe(true);
        expect(report.targetWorkspacesBefore).toBe(1);
        expect(report.backupPath).toBe(`${to}.20260819T101112Z.bak`);
        expect(report.warnings.some((warning) => warning.includes('backed the target up'))).toBe(true);

        // The target is now the import…
        expect(workspaceNames(to)).toEqual(['Alpha', 'Beta']);
        // …and the pre-import database is intact beside it.
        expect(fs.existsSync(report.backupPath as string)).toBe(true);
        expect(workspaceNames(report.backupPath as string)).toEqual(['existing']);
    });

    it('never reuses a backup name', () => {
        const from = makeSource();
        const dir = scratchDir();
        const to = path.join(dir, 'kelpid.db');
        const now = (): Date => new Date('2026-08-19T10:11:12.345Z');

        seedTarget(to, 'first');
        const one = runImport({ from, to, force: true, now });
        seedTarget(to, 'second');
        const two = runImport({ from, to, force: true, now });

        expect(one.backupPath).toBe(`${to}.20260819T101112Z.bak`);
        expect(two.backupPath).toBe(`${to}.20260819T101112Z-2.bak`);
        expect(workspaceNames(one.backupPath as string)).toEqual(['first']);
        expect(workspaceNames(two.backupPath as string)).toEqual(['second']);
    });
});

describe('runImport: a target that is only a fresh install (#360)', () => {
    it('replaces it without --force, backing it up first', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        seedFreshInstall(to);

        const report = runImport({ from, to, now: () => new Date('2026-10-16T10:11:12.345Z') });

        expect(report.written).toBe(true);
        expect(report.targetFreshInstall).toBe(true);
        expect(report.targetWorkspacesBefore).toBe(1);
        expect(report.backupPath).toBe(`${to}.20261016T101112Z.bak`);
        expect(workspaceNames(to)).toEqual(['Alpha', 'Beta']);
        expect(workspaceNames(report.backupPath as string)).toEqual(['Default']);
    });

    it('says so on a dry run, and writes nothing', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        seedFreshInstall(to);
        const before = fs.readFileSync(to);

        const report = runImport({ from, to, dryRun: true });

        expect(report).toMatchObject({ written: false, targetFreshInstall: true, backupPath: null, workspaces: 2 });
        expect(fs.readFileSync(to).equals(before)).toBe(true);
        expect(fs.readdirSync(path.dirname(to)).some((entry) => entry.endsWith('.bak'))).toBe(false);
    });

    it.each([
        ['the workspace was renamed', `UPDATE "workspace" SET "name" = 'Work'`],
        ['the workspace was labelled', `UPDATE "workspace" SET "labelsJSON" = '["wip"]'`],
        ['the workspace was given an icon', `UPDATE "workspace" SET "icon" = '{"kind":"emoji","value":"x"}'`],
        ['the workspace was given a profile', `UPDATE "workspace" SET "profileName" = 'work'`],
        ['the workspace was muted', `UPDATE "workspace" SET "muted" = 1`],
        ['a label preset was made in Settings', `UPDATE "appState" SET "value" = '[{"name":"wip"}]' WHERE "key" = 'kelpid.labelPresets'`],
        ['app state it does not know is there', `INSERT INTO "appState" ("key","value") VALUES ('kelpid.somethingNew','1')`],
        [
            'a second workspace exists',
            `INSERT INTO "workspace" ("id","name","color","layoutJSON","createdAt","lastAccessedAt") VALUES ('66666666-6666-4666-8666-666666666666','Default','blue','{}',0,0)`
        ],
        [
            'a second pane exists',
            `INSERT INTO "pane" ("id","workspaceID","type","workingDirectory","createdAt","lastActivityAt") VALUES ('55555555-5555-4555-8555-555555555555','${FRESH_WS}','shell','/tmp',0,0)`
        ],
        ['the pane recorded an agent session', `UPDATE "pane" SET "agentSessionID" = 'sess-1', "agentKind" = 'claude'`],
        ['the pane has a label', `UPDATE "pane" SET "label" = 'server'`],
        ['the pane is no longer a shell', `UPDATE "pane" SET "type" = 'markdown', "filePath" = '/tmp/a.md'`],
        [
            'a group exists',
            `INSERT INTO "workspace_group" ("id","name","createdAt") VALUES ('44444444-4444-4444-8444-444444444444','g',0)`
        ],
        [
            'a repository is registered',
            `INSERT INTO "repo" ("id","path","name","lastAccessedAt") VALUES ('33333333-3333-4333-8333-333333333333','/Users/dev/app','app',0)`
        ]
    ])('still asks for --force when %s', (_why, sql) => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        seedFreshInstall(to);
        alterTarget(to, sql);
        const before = fs.readFileSync(to);

        expect(() => runImport({ from, to })).toThrow(/already holds/);
        expect(() => runImport({ from, to, dryRun: true })).toThrow(/already holds/);
        expect(fs.readFileSync(to).equals(before)).toBe(true);
    });

    it('judges a target from before the session column was renamed by the columns it has', () => {
        const from = makeSource();
        const fresh = path.join(scratchDir(), 'kelpid.db');
        writeLegacyDatabase(fresh, {
            schema: 'v14',
            workspaces: [legacyWorkspace({ id: FRESH_WS, name: 'Default' })],
            panes: [legacyPane({ id: FRESH_PANE, workspaceID: FRESH_WS })]
        });
        expect(runImport({ from, to: fresh, dryRun: true }).targetFreshInstall).toBe(true);

        const used = path.join(scratchDir(), 'kelpid.db');
        writeLegacyDatabase(used, {
            schema: 'v14',
            workspaces: [legacyWorkspace({ id: FRESH_WS, name: 'Default' })],
            panes: [legacyPane({ id: FRESH_PANE, workspaceID: FRESH_WS, claudeSessionID: 'sess-old' })]
        });
        expect(() => runImport({ from, to: used, dryRun: true })).toThrow(/already holds 1 workspace/);
    });

    it('names the workspace a first boot creates', () => {
        expect(FRESH_INSTALL_WORKSPACE_NAME).toBe(DEFAULT_WORKSPACE_NAME);
    });
});

describe('runImport — dry run', () => {
    it('creates nothing at all', () => {
        const from = makeSource();
        const dir = scratchDir();
        const to = path.join(dir, 'kelpid.db');

        const report = runImport({ from, to, dryRun: true });

        expect(report.written).toBe(false);
        expect(report.workspaces).toBe(2);
        expect(report.panes).toBe(3);
        expect(report.resumable).toBe(1);
        expect(report.warnings).toContain('dry run: nothing was written');
        // Not even an empty database: opening a missing path would have created one.
        expect(fs.existsSync(to)).toBe(false);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it('reports the same counts the real run produces', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        const dry = runImport({ from, to, dryRun: true });
        const real = runImport({ from, to });
        expect({ ...dry, dryRun: false, written: true, warnings: [] }).toEqual({
            ...real,
            warnings: []
        });
    });
});

describe('runImport — target failures', () => {
    it('refuses a target it cannot inspect rather than overwriting it blindly', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        fs.writeFileSync(to, 'not a database');
        try {
            runImport({ from, to });
            expect.unreachable('should have refused');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            // "I could not tell what is in there" must never become "so I replaced it".
            expect((error as LegacyImportError).code).toBe('target-unreadable');
            expect((error as LegacyImportError).message).toContain('could not be inspected');
        }
        expect(fs.readFileSync(to, 'utf8')).toBe('not a database');
    });

    it('backs up even an unreadable target when --force insists', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        fs.writeFileSync(to, 'not a database');
        try {
            runImport({ from, to, force: true, now: () => new Date('2026-08-19T10:11:12.345Z') });
            expect.unreachable('the target is still not a database, so the write must fail');
        } catch (error) {
            expect((error as LegacyImportError).code).toBe('target-unwritable');
        }
        // The junk file was preserved before anything tried to write over it.
        expect(fs.readFileSync(`${to}.20260819T101112Z.bak`, 'utf8')).toBe('not a database');
    });

    it('refuses to import a database into itself', () => {
        const from = makeSource();
        try {
            runImport({ from, to: from });
            expect.unreachable('should have refused');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            expect((error as LegacyImportError).code).toBe('same-database');
        }
    });

    it('creates the target database with the daemon schema and ledger', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'kelpid.db');
        runImport({ from, to });

        const db = openSqliteDatabase(to, { readOnly: true, wal: false });
        try {
            const ledger = db.all('SELECT identifier FROM grdb_migrations').map((row) => row['identifier']);
            expect(ledger).toContain('v1_initial');
            expect(ledger).toContain('v18_pane_agent_kind');
        } finally {
            db.close();
        }
    });
});
