/**
 * Reading a legacy Swift `nex.db`: the ledger check, every degradation rule in
 * docs/current/persistence.md §9 items 5–8, and the promise that the source file is never
 * touched.
 *
 * Fixtures are built from the spec's §8 DDL (`testing.ts`) and carry real column values
 * captured from a live database (`packages/core/fixtures`).
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    isLegacyImportError,
    LegacyImportError,
    readLegacyDatabase,
    type LegacyReadResult,
    type SkippedRow
} from './reader.js';
import {
    legacyGroup,
    legacyPane,
    legacyRepo,
    legacyRepoAssociation,
    legacyWorkspace,
    realLayoutJSON,
    realLegacyLedger,
    realTopLevelOrder,
    realWorkspaceScalars,
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

function build(spec: LegacyDatabaseSpec): string {
    const file = path.join(scratchDir(), 'nex.db');
    writeLegacyDatabase(file, spec);
    return file;
}

function read(spec: LegacyDatabaseSpec, newTabID?: () => string): LegacyReadResult {
    return readLegacyDatabase({ path: build(spec), ...(newTabID !== undefined ? { newTabID } : {}) });
}

function reasons(skipped: readonly SkippedRow[], table: string): string[] {
    return skipped.filter((entry) => entry.table === table).map((entry) => entry.reason);
}

function warningMatching(result: LegacyReadResult, needle: string): string | undefined {
    return result.warnings.find((warning) => warning.includes(needle));
}

// Real ids from the live-database fixtures.
const SCALARS = realWorkspaceScalars();
const LAYOUTS = realLayoutJSON();
const WS_A = SCALARS[0]?.id as string;
const WS_B = SCALARS[1]?.id as string;
const WS_C = SCALARS[2]?.id as string;
/** The three leaves of `LAYOUTS[0]`. */
const PANE_A1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const PANE_A2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const PANE_A3 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
/** The two leaves of `LAYOUTS[3]`. */
const PANE_B1 = '9E8F6E9C-2DA2-41DE-94E3-44166C68FE1F';
const PANE_B2 = 'A81AEA55-87A7-40CA-A49F-5978BFB363E5';
const GROUP_ID = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';
const REPO_ID = 'C1DFCF02-F226-4075-9944-86C5E5E42820';
const ASSOCIATION_ID = '2415F59F-1EC1-4118-B66D-070DF303536B';
const TAB_ID = '5F0C24D9-1111-4222-8333-444455556666';

function realisticSpec(): LegacyDatabaseSpec {
    const [a, b, c] = SCALARS;
    return {
        foreignTables: true,
        workspaces: [
            legacyWorkspace({
                id: WS_A,
                name: 'My App!',
                color: 'purple',
                layoutJSON: LAYOUTS[0] as string,
                focusedPaneID: PANE_A2,
                createdAt: a?.createdAt ?? 0,
                lastAccessedAt: a?.lastAccessedAt ?? 0,
                sortOrder: 0,
                slug: '',
                labelsJSON: '["frontend","wip"]',
                icon: 'system:star.fill',
                profileName: 'work'
            }),
            legacyWorkspace({
                id: WS_B,
                name: 'Beta',
                color: 'not-a-color',
                // Written lowercase: Swift emits uppercase but parses case-insensitively.
                layoutJSON: (LAYOUTS[3] as string).replace(/"([0-9A-F-]{36})"/g, (_m, id: string) => `"${id.toLowerCase()}"`),
                createdAt: b?.createdAt ?? 0,
                lastAccessedAt: b?.lastAccessedAt ?? 0,
                sortOrder: 1,
                slug: 'beta-1de27a23',
                icon: 'emoji:📁'
            }),
            legacyWorkspace({
                id: WS_C,
                name: 'Gamma',
                layoutJSON: '{"split":{"_0":"sideways"}}',
                createdAt: c?.createdAt ?? 0,
                lastAccessedAt: c?.lastAccessedAt ?? 0,
                sortOrder: 2,
                labelsJSON: '{"not":"an array"}'
            }),
            legacyWorkspace({ id: 'definitely-not-a-uuid', name: 'Broken', sortOrder: 3 })
        ],
        panes: [
            legacyPane({ id: PANE_A1, workspaceID: WS_A, label: 'coordinator', workingDirectory: '/tmp' }),
            legacyPane({
                id: PANE_A2,
                workspaceID: WS_A,
                label: 'agent',
                status: 'running',
                agentSessionID: 'sess-abc123',
                agentKind: 'codex'
            }),
            legacyPane({ id: PANE_A3, workspaceID: WS_A, type: 'markdown', filePath: '/tmp/notes.md' }),
            legacyPane({
                id: PANE_B1,
                workspaceID: WS_B,
                type: 'web',
                webTabsJSON: `[{"id":"${TAB_ID}","url":"https://example.com","title":"Example"}]`,
                webActiveTabID: TAB_ID,
                webIsPrivate: 0
            }),
            legacyPane({
                id: PANE_B2,
                workspaceID: WS_B,
                type: 'web',
                webIsPrivate: 1,
                webURL: 'https://secret.example',
                webTabsJSON: `[{"id":"${TAB_ID}","url":"https://secret.example","title":"Secret"}]`
            }),
            // Degradation cases.
            legacyPane({ id: 'nope', workspaceID: WS_A }),
            legacyPane({ id: '00000000-0000-4000-8000-000000000001', workspaceID: 'also-not-a-uuid' }),
            legacyPane({
                id: '00000000-0000-4000-8000-000000000002',
                workspaceID: '11111111-2222-3333-4444-555555555555'
            }),
            legacyPane({
                id: '00000000-0000-4000-8000-000000000003',
                workspaceID: WS_C,
                type: 'hologram',
                status: 'napping',
                agentKind: 'gemini',
                agentSessionID: 'rm -rf /; echo pwned'
            })
        ],
        repos: [
            legacyRepo({ id: REPO_ID, path: '/Users/dev/app', name: 'app', remoteURL: 'git@example:app.git' }),
            legacyRepo({ id: 'not-a-repo-uuid', path: '/Users/dev/other' })
        ],
        repoAssociations: [
            legacyRepoAssociation({
                id: ASSOCIATION_ID,
                workspaceID: WS_A,
                repoID: REPO_ID,
                worktreePath: '/Users/dev/app',
                branchName: 'main',
                isAutoDetected: 1
            }),
            legacyRepoAssociation({
                id: '00000000-0000-4000-8000-0000000000BB',
                workspaceID: WS_A,
                repoID: '99999999-9999-4999-8999-999999999999',
                worktreePath: '/Users/dev/ghost'
            })
        ],
        groups: [
            legacyGroup({
                id: GROUP_ID,
                name: 'agents',
                color: 'green',
                isCollapsed: 1,
                childOrderJSON: `["${WS_B}"]`,
                icon: 'system:folder'
            }),
            legacyGroup({
                id: '00000000-0000-4000-8000-0000000000CC',
                name: 'broken order',
                childOrderJSON: '["not-a-uuid"]'
            })
        ],
        appState: [
            { key: 'activeWorkspaceID', value: WS_B },
            {
                key: 'topLevelOrder',
                value: `[{"workspace":{"_0":"${WS_A}"}},{"group":{"_0":"${GROUP_ID}"}},{"workspace":{"_0":"${WS_C}"}}]`
            }
        ]
    };
}

describe('readLegacyDatabase — a realistic database', () => {
    const result = read(realisticSpec());

    it('reports the live ledger, its foreign identifiers and nothing unknown', () => {
        expect(result.ledger.present).toBe(true);
        expect(result.ledger.identifiers).toEqual(realLegacyLedger());
        expect(result.ledger.missing).toEqual([]);
        expect(result.ledger.foreign).toEqual(['v7_scheduled_tasks', 'v9_workspace_folders']);
        expect(result.ledger.unknown).toEqual([]);
    });

    it('ignores tables it does not own and says so', () => {
        expect(result.ignoredTables).toEqual(['scheduledTask', 'workspaceFolder']);
        expect(warningMatching(result, 'does not own')).toContain('scheduledTask');
    });

    it('orders workspaces by sortOrder and decodes their scalars', () => {
        expect(result.snapshot.workspaces.map((workspace) => workspace.name)).toEqual([
            'My App!',
            'Beta',
            'Gamma'
        ]);
        const [alpha, beta, gamma] = result.snapshot.workspaces;
        expect(alpha?.color).toBe('purple');
        expect(alpha?.icon).toEqual({ kind: 'system', name: 'star.fill' });
        expect(alpha?.profileName).toBe('work');
        expect(alpha?.labels).toEqual(['frontend', 'wip']);
        expect(alpha?.focusedPaneID).toBe(PANE_A2);
        // §6.3: the v3 default '' is regenerated as name-slug + first 8 id chars.
        expect(alpha?.slug).toBe('my-app-a4e8a251');
        expect(beta?.slug).toBe('beta-1de27a23');
        // §9.6: unknown color → blue; unparseable labelsJSON → [].
        expect(beta?.color).toBe('blue');
        expect(beta?.icon).toEqual({ kind: 'emoji', grapheme: '📁' });
        expect(gamma?.labels).toEqual([]);
        // Epoch SECONDS, verbatim from the fixture.
        expect(alpha?.createdAt).toBe(SCALARS[0]?.createdAt);
        expect(alpha?.lastAccessedAt).toBe(SCALARS[0]?.lastAccessedAt);
    });

    it('decodes the Swift `_0`-keyed layout tree, case-insensitively', () => {
        const [alpha, beta, gamma] = result.snapshot.workspaces;
        expect(alpha?.layout).toEqual(JSON.parse(JSON.stringify(alpha?.layout)));
        expect(alpha?.layout.kind).toBe('split');
        expect(beta?.layout).toEqual({
            kind: 'split',
            direction: 'horizontal',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: PANE_B1 },
            second: { kind: 'leaf', paneID: PANE_B2 }
        });
        // §3.1: an undecodable layout degrades to empty and is reported.
        expect(gamma?.layout).toEqual({ kind: 'empty' });
        expect(warningMatching(result, 'undecodable layoutJSON')).toContain(WS_C);
    });

    it('keeps panes with their workspace, in row order', () => {
        const alpha = result.snapshot.workspaces[0];
        expect(alpha?.panes.map((pane) => pane.id)).toEqual([PANE_A1, PANE_A2, PANE_A3]);
        expect(alpha?.panes[0]?.label).toBe('coordinator');
        expect(alpha?.panes[2]?.type).toBe('markdown');
        expect(alpha?.panes[2]?.filePath).toBe('/tmp/notes.md');
    });

    it('preserves agentSessionID + agentKind and the raw status (the reset is convert.ts\'s job)', () => {
        const agent = result.snapshot.workspaces[0]?.panes[1];
        expect(agent?.agentSessionID).toBe('sess-abc123');
        expect(agent?.agentKind).toBe('codex');
        expect(agent?.status).toBe('running');
    });

    it('rebuilds web tabs and withholds private ones', () => {
        const beta = result.snapshot.workspaces[1];
        const open = beta?.panes.find((pane) => pane.id === PANE_B1);
        expect(open?.webTabs).toEqual([{ id: TAB_ID, url: 'https://example.com', title: 'Example' }]);
        expect(open?.webActiveTabID).toBe(TAB_ID);
        expect(open?.webIsPrivate).toBe(false);

        const priv = beta?.panes.find((pane) => pane.id === PANE_B2);
        expect(priv?.webIsPrivate).toBe(true);
        expect(priv?.webTabs).toBeNull();
        expect(priv?.webActiveTabID).toBeNull();
        expect(warningMatching(result, 'private web pane')).toContain(PANE_B2);
    });

    it('skips unparseable and orphaned rows, with a reason for each', () => {
        expect(reasons(result.skipped, 'workspace')).toEqual(['unparseable workspace id']);
        expect(result.skipped.find((entry) => entry.table === 'workspace')?.id).toBe('definitely-not-a-uuid');
        expect(reasons(result.skipped, 'pane')).toEqual([
            'unparseable pane id',
            'unparseable workspaceID',
            'orphan: workspace 11111111-2222-3333-4444-555555555555 was not imported'
        ]);
        expect(reasons(result.skipped, 'repo')).toEqual(['unparseable repo id']);
        expect(reasons(result.skipped, 'repoAssociation')).toEqual([
            'repo 99999999-9999-4999-8999-999999999999 is not in the registry (FK would fail)'
        ]);
    });

    it('warns about every enum fallback', () => {
        expect(warningMatching(result, 'unknown color')).toContain('not-a-color');
        expect(warningMatching(result, 'unknown type')).toContain('hologram');
        expect(warningMatching(result, 'unknown status')).toContain('napping');
        expect(warningMatching(result, 'unknown agentKind')).toContain('gemini');
        expect(warningMatching(result, 'undecodable labelsJSON')).toContain(WS_C);
        expect(warningMatching(result, 'undecodable childOrderJSON')).toContain(
            '00000000-0000-4000-8000-0000000000CC'
        );
        expect(warningMatching(result, 'regenerated')).toContain('2 empty workspace slug(s)');
    });

    it('flags a session id that the resume allowlist will refuse to type', () => {
        expect(warningMatching(result, 'shell-safety allowlist')).toContain(
            '00000000-0000-4000-8000-000000000003'
        );
    });

    it('keeps the sidebar order verbatim and flags its dangling entry', () => {
        expect(result.snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: WS_A },
            { kind: 'group', id: GROUP_ID },
            { kind: 'workspace', id: WS_C }
        ]);
        expect(result.snapshot.activeWorkspaceID).toBe(WS_B);
        // WS_C survived, so nothing dangles here — but the second group is absent from the order.
        expect(warningMatching(result, 'sidebar order references')).toBeUndefined();
    });

    it('decodes groups in sortOrder with their collapse state and members', () => {
        expect(result.snapshot.groups.map((group) => group.name)).toEqual(['agents', 'broken order']);
        const [agents, broken] = result.snapshot.groups;
        expect(agents?.isCollapsed).toBe(true);
        expect(agents?.color).toBe('green');
        expect(agents?.childOrder).toEqual([WS_B]);
        expect(broken?.childOrder).toEqual([]);
    });

    it('counts what survived', () => {
        expect(result.counts).toEqual({
            workspaces: 3,
            panes: 6,
            groups: 2,
            repos: 1,
            repoAssociations: 2
        });
    });
});

describe('readLegacyDatabase — ledger tolerance', () => {
    it('warns about an unknown v19 identifier and reads the database anyway', () => {
        const result = read({
            ledger: [...realLegacyLedger(), 'v19_something_new'],
            workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha', layoutJSON: '{"empty":{}}' })]
        });
        expect(result.ledger.unknown).toEqual(['v19_something_new']);
        expect(warningMatching(result, 'v19_something_new')).toContain('does not know');
        expect(result.snapshot.workspaces).toHaveLength(1);
    });

    it('warns when the ledger is older than this importer', () => {
        const result = read({
            schema: 'v14',
            ledger: realLegacyLedger().filter(
                (identifier) => !['v15_rename_agent_session', 'v16_workspace_icon', 'v17_workspace_profile', 'v18_pane_agent_kind'].includes(identifier)
            ),
            workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha' })],
            panes: [legacyPane({ id: PANE_A1, workspaceID: WS_A, claudeSessionID: 'sess-old' })]
        });
        expect(result.ledger.missing).toEqual([
            'v15_rename_agent_session',
            'v16_workspace_icon',
            'v17_workspace_profile',
            'v18_pane_agent_kind'
        ]);
        expect(warningMatching(result, 'predates this importer')).toBeDefined();
        // §4 v15: the rename never ran, so the id lives in `claudeSessionID` — and an import
        // that dropped it would silently lose every resumable session.
        expect(result.snapshot.workspaces[0]?.panes[0]?.agentSessionID).toBe('sess-old');
        expect(warningMatching(result, 'predates v15_rename_agent_session')).toContain('claudeSessionID');
    });

    it('reads a database with no ledger at all', () => {
        const result = read({
            ledger: null,
            workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha' })]
        });
        expect(result.ledger.present).toBe(false);
        expect(warningMatching(result, 'no grdb_migrations ledger')).toBeDefined();
        expect(result.snapshot.workspaces).toHaveLength(1);
    });
});

describe('readLegacyDatabase — legacy shapes', () => {
    it('synthesizes the sidebar order for a pre-groups database', () => {
        const result = read({
            workspaces: [
                legacyWorkspace({ id: WS_A, name: 'Alpha', sortOrder: 0 }),
                legacyWorkspace({ id: WS_B, name: 'Beta', sortOrder: 1 })
            ]
        });
        expect(result.snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: WS_A },
            { kind: 'workspace', id: WS_B }
        ]);
        expect(warningMatching(result, 'synthesized')).toBeDefined();
    });

    it('turns a pre-v13 webURL into a single tab', () => {
        const result = read(
            {
                workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha' })],
                panes: [
                    legacyPane({
                        id: PANE_B1,
                        workspaceID: WS_A,
                        type: 'web',
                        webURL: 'http://localhost:3000'
                    })
                ]
            },
            () => TAB_ID
        );
        expect(result.snapshot.workspaces[0]?.panes[0]?.webTabs).toEqual([
            { id: TAB_ID, url: 'http://localhost:3000', title: '' }
        ]);
    });

    it('flags a sidebar entry whose workspace was skipped', () => {
        const result = read({
            workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha' })],
            appState: [
                { key: 'activeWorkspaceID', value: WS_C },
                { key: 'topLevelOrder', value: `[{"workspace":{"_0":"${WS_A}"}},{"group":{"_0":"${GROUP_ID}"}}]` }
            ]
        });
        expect(warningMatching(result, 'sidebar order references group')).toContain(GROUP_ID);
        expect(warningMatching(result, 'active workspace')).toContain(WS_C);
    });

    it('decodes the real topLevelOrder value from a live database', () => {
        const result = read({
            workspaces: [legacyWorkspace({ id: WS_A, name: 'Alpha' })],
            appState: [{ key: 'topLevelOrder', value: realTopLevelOrder() }]
        });
        expect(result.snapshot.topLevelOrder).toHaveLength(12);
        expect(result.snapshot.topLevelOrder[0]).toEqual({ kind: 'workspace', id: WS_A });
        expect(result.snapshot.topLevelOrder.filter((entry) => entry.kind === 'group')).toHaveLength(7);
    });
});

describe('readLegacyDatabase — refusals and safety', () => {
    it('refuses a path that does not exist', () => {
        const target = path.join(scratchDir(), 'missing.db');
        try {
            readLegacyDatabase({ path: target });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            expect((error as LegacyImportError).code).toBe('source-missing');
            expect((error as LegacyImportError).repair).toContain('--from');
        }
    });

    it('refuses a database that is not a Kelpi database', () => {
        const file = path.join(scratchDir(), 'other.db');
        writeLegacyDatabase(file, {});
        const db = fs.readFileSync(file);
        expect(db.length).toBeGreaterThan(0);
        const foreign = path.join(scratchDir(), 'foreign.db');
        fs.writeFileSync(foreign, 'this is not a database at all');
        try {
            readLegacyDatabase({ path: foreign });
            expect.unreachable('should have thrown');
        } catch (error) {
            expect(isLegacyImportError(error)).toBe(true);
            expect(['source-unreadable', 'not-a-kelpi-database']).toContain(
                (error as LegacyImportError).code
            );
        }
    });

    it('never writes to the source file', () => {
        const dir = scratchDir();
        const file = path.join(dir, 'nex.db');
        writeLegacyDatabase(file, realisticSpec());
        const before = fs.statSync(file);
        const bytes = fs.readFileSync(file);

        readLegacyDatabase({ path: file });

        const after = fs.statSync(file);
        expect(after.size).toBe(before.size);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(fs.readFileSync(file).equals(bytes)).toBe(true);
        // No journal, no -wal, no -shm: the open was read-only.
        expect(fs.readdirSync(dir)).toEqual(['nex.db']);
    });
});
