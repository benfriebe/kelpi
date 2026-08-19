/**
 * `runImport`: write the converted snapshot into a target daemon database through the existing
 * persistence layer, and refuse anything that would lose state.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPersistence, openSqliteDatabase } from '../db/index.js';
import { runImport } from './importer.js';
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
    const root = fs.mkdtempSync(path.join('/tmp', 'nexd-import-'));
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

describe('runImport — into a fresh target', () => {
    it('writes the whole snapshot and reports what landed', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'nexd.db');

        const report = runImport({ from, to });

        expect(report.written).toBe(true);
        expect(report.dryRun).toBe(false);
        expect(report.backupPath).toBeNull();
        expect(report.targetWorkspacesBefore).toBe(0);
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
        runImport({ from, to: path.join(scratchDir(), 'nexd.db') });
        expect(fs.readFileSync(from).equals(before)).toBe(true);
    });
});

describe('runImport — a populated target', () => {
    it('refuses without --force and writes nothing', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'nexd.db');
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
        const to = path.join(scratchDir(), 'nexd.db');
        seedTarget(to, 'existing');
        expect(() => runImport({ from, to, dryRun: true })).toThrow(/already holds/);
    });

    it('with --force, backs the target up first and then replaces it', () => {
        const from = makeSource();
        const dir = scratchDir();
        const to = path.join(dir, 'nexd.db');
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
        const to = path.join(dir, 'nexd.db');
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

describe('runImport — dry run', () => {
    it('creates nothing at all', () => {
        const from = makeSource();
        const dir = scratchDir();
        const to = path.join(dir, 'nexd.db');

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
        const to = path.join(scratchDir(), 'nexd.db');
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
        const to = path.join(scratchDir(), 'nexd.db');
        fs.writeFileSync(to, 'not a database');
        try {
            runImport({ from, to });
            expect.unreachable('should have refused');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            // "I could not tell what is in there" must never become "so I replaced it".
            expect((error as LegacyImportError).code).toBe('target-populated');
            expect((error as LegacyImportError).message).toContain('could not be inspected');
        }
        expect(fs.readFileSync(to, 'utf8')).toBe('not a database');
    });

    it('backs up even an unreadable target when --force insists', () => {
        const from = makeSource();
        const to = path.join(scratchDir(), 'nexd.db');
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
        const to = path.join(scratchDir(), 'nexd.db');
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
