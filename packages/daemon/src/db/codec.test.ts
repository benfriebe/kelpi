/// <reference types="node" />

import { describe, expect, it } from 'vitest';

import type { PersistedGroup, PersistedPane, PersistedWorkspace } from '../store/index.js';
import { PERSISTED_SNAPSHOT_VERSION } from '../store/index.js';
import type { SqlRow } from './adapter.js';
import {
    APP_STATE_ACTIVE_WORKSPACE,
    APP_STATE_LABEL_PRESETS,
    APP_STATE_LABEL_PRESETS_MIGRATED,
    APP_STATE_SNAPSHOT_VERSION,
    APP_STATE_TOP_LEVEL_ORDER,
    decodeAgentKind,
    decodeAppStateFlag,
    decodeGroupColor,
    decodeGroupRow,
    decodeLabelPresetsJSON,
    decodePaneRow,
    decodePaneStatus,
    decodePaneType,
    decodeRepoAssociationRow,
    decodeWorkspaceColor,
    decodeWorkspaceRow,
    encodeGroupRow,
    encodeLabelPresetsJSON,
    encodePaneRow,
    encodeWorkspaceRow,
    snapshotFromRows,
    snapshotToRows,
    toEpochSecondsColumn,
    type LoadedRows
} from './codec.js';

const W1 = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const W2 = '1DE27A23-1EDA-4967-B4A7-9746532F257A';
const P1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const P2 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const G1 = '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A';
const TAB1 = '5F0C24D9-1111-4111-8111-111111111111';
const TAB2 = '5F0C24D9-2222-4222-8222-222222222222';

/** Row builders default every column so a test only states what it is about. */
function workspaceRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
    return {
        id: W1,
        name: 'nex',
        color: 'blue',
        layoutJSON: `{"leaf":{"_0":"${P1}"}}`,
        focusedPaneID: P1,
        createdAt: 1_755_500_000.5,
        lastAccessedAt: 1_755_500_100.5,
        sortOrder: 0,
        slug: 'nex-a4e8a251',
        labelsJSON: '["frontend","wip"]',
        icon: 'system:star.fill',
        profileName: 'work',
        ...overrides
    } as SqlRow;
}

function paneRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
    return {
        id: P1,
        workspaceID: W1,
        label: 'coordinator',
        type: 'shell',
        workingDirectory: '/Users/test/code/nex',
        createdAt: 1_755_500_000,
        lastActivityAt: 1_755_500_050,
        agentSessionID: 'abc-123',
        status: 'running',
        filePath: null,
        content: null,
        webURL: null,
        webTabsJSON: null,
        webActiveTabID: null,
        webIsPrivate: null,
        agentKind: 'codex',
        ...overrides
    } as SqlRow;
}

function groupRow(overrides: Partial<Record<string, unknown>> = {}): SqlRow {
    return {
        id: G1,
        name: 'work',
        color: 'purple',
        isCollapsed: 1,
        childOrderJSON: `["${W1}"]`,
        createdAt: 1_755_400_000,
        sortOrder: 0,
        icon: 'emoji:📁',
        ...overrides
    } as SqlRow;
}

describe('enum degradation (§9.6)', () => {
    it('falls back to blue for an unknown workspace color', () => {
        expect(decodeWorkspaceColor('purple')).toBe('purple');
        expect(decodeWorkspaceColor('chartreuse')).toBe('blue');
        expect(decodeWorkspaceColor(null)).toBe('blue');
    });

    it('leaves an unknown group color untinted', () => {
        expect(decodeGroupColor('red')).toBe('red');
        expect(decodeGroupColor('chartreuse')).toBeNull();
        expect(decodeGroupColor(null)).toBeNull();
    });

    it('falls back to shell / idle and keeps agentKind strict', () => {
        expect(decodePaneType('markdown')).toBe('markdown');
        expect(decodePaneType('quantum')).toBe('shell');
        expect(decodePaneStatus('waitingForInput')).toBe('waitingForInput');
        expect(decodePaneStatus('exploded')).toBe('idle');
        expect(decodeAgentKind('codex')).toBe('codex');
        expect(decodeAgentKind('gemini')).toBeNull();
        expect(decodeAgentKind(null)).toBeNull();
    });
});

describe('workspace row decoding', () => {
    it('decodes every column', () => {
        const decoded = decodeWorkspaceRow(workspaceRow());
        expect(decoded).not.toBeNull();
        expect(decoded?.workspace).toEqual({
            id: W1,
            name: 'nex',
            slug: 'nex-a4e8a251',
            color: 'blue',
            icon: { kind: 'system', name: 'star.fill' },
            profileName: 'work',
            layout: { kind: 'leaf', paneID: P1 },
            focusedPaneID: P1,
            createdAt: 1_755_500_000.5,
            lastAccessedAt: 1_755_500_100.5,
            labels: ['frontend', 'wip']
        } satisfies Omit<PersistedWorkspace, 'panes' | 'repoAssociations'>);
    });

    it('skips a row whose id is not a UUID (§9.5)', () => {
        expect(decodeWorkspaceRow(workspaceRow({ id: 'not-a-uuid' }))).toBeNull();
        expect(decodeWorkspaceRow(workspaceRow({ id: null }))).toBeNull();
    });

    it('uppercases a lowercase id and focused pane id', () => {
        const decoded = decodeWorkspaceRow(
            workspaceRow({ id: W1.toLowerCase(), focusedPaneID: P1.toLowerCase() })
        );
        expect(decoded?.workspace.id).toBe(W1);
        expect(decoded?.workspace.focusedPaneID).toBe(P1);
    });

    it('degrades corrupt layout JSON to empty without losing the row (§3.1)', () => {
        expect(decodeWorkspaceRow(workspaceRow({ layoutJSON: '{"split":{' }))?.workspace.layout).toEqual({
            kind: 'empty'
        });
        expect(decodeWorkspaceRow(workspaceRow({ layoutJSON: '{"leaf":{"_0":"nope"}}' }))?.workspace.layout).toEqual(
            { kind: 'empty' }
        );
    });

    it('degrades corrupt labels JSON to [] and an unparseable icon to null', () => {
        const decoded = decodeWorkspaceRow(workspaceRow({ labelsJSON: '["a",2]', icon: 'sticker:x' }));
        expect(decoded?.workspace.labels).toEqual([]);
        expect(decoded?.workspace.icon).toBeNull();
        expect(decodeWorkspaceRow(workspaceRow({ icon: 'system:' }))?.workspace.icon).toBeNull();
    });

    it('regenerates an empty slug from name + id (§6.3)', () => {
        expect(decodeWorkspaceRow(workspaceRow({ slug: '', name: 'My App!' }))?.workspace.slug).toBe(
            'my-app-a4e8a251'
        );
        // An all-punctuation name yields the bare suffix (the live DB has such rows).
        expect(decodeWorkspaceRow(workspaceRow({ slug: '', name: '手伝い' }))?.workspace.slug).toBe('a4e8a251');
    });

    it('nulls an invalid focusedPaneID rather than failing the row', () => {
        expect(decodeWorkspaceRow(workspaceRow({ focusedPaneID: 'nope' }))?.workspace.focusedPaneID).toBeNull();
    });

    it('treats a stored "default" / empty profile as the null baseline (§2.1)', () => {
        expect(decodeWorkspaceRow(workspaceRow({ profileName: 'default' }))?.workspace.profileName).toBeNull();
        expect(decodeWorkspaceRow(workspaceRow({ profileName: '' }))?.workspace.profileName).toBeNull();
        expect(decodeWorkspaceRow(workspaceRow({ profileName: null }))?.workspace.profileName).toBeNull();
        expect(decodeWorkspaceRow(workspaceRow({ profileName: 'work' }))?.workspace.profileName).toBe('work');
    });
});

describe('pane row decoding', () => {
    it('decodes a shell pane', () => {
        const decoded = decodePaneRow(paneRow());
        expect(decoded?.workspaceID).toBe(W1);
        expect(decoded?.pane).toEqual({
            id: P1,
            label: 'coordinator',
            type: 'shell',
            workingDirectory: '/Users/test/code/nex',
            createdAt: 1_755_500_000,
            lastActivityAt: 1_755_500_050,
            agentSessionID: 'abc-123',
            agentKind: 'codex',
            status: 'running',
            filePath: null,
            scratchpadContent: null,
            webTabs: null,
            webActiveTabID: null,
            webIsPrivate: false
        } satisfies PersistedPane);
    });

    it('skips rows with an unparseable pane or workspace id', () => {
        expect(decodePaneRow(paneRow({ id: 'nope' }))).toBeNull();
        expect(decodePaneRow(paneRow({ workspaceID: 'nope' }))).toBeNull();
    });

    it('restores web tabs from webTabsJSON and keeps the stored active tab', () => {
        const decoded = decodePaneRow(
            paneRow({
                type: 'web',
                webTabsJSON: JSON.stringify([
                    { id: TAB1, url: 'https://example.com', title: 'Example Domain' },
                    { id: TAB2, url: 'http://localhost:3000', title: '' }
                ]),
                webActiveTabID: TAB2,
                webURL: 'http://localhost:3000',
                webIsPrivate: 0
            })
        );
        expect(decoded?.pane.webTabs).toEqual([
            { id: TAB1, url: 'https://example.com', title: 'Example Domain' },
            { id: TAB2, url: 'http://localhost:3000', title: '' }
        ]);
        expect(decoded?.pane.webActiveTabID).toBe(TAB2);
        expect(decoded?.pane.webIsPrivate).toBe(false);
    });

    it('falls back to the first tab when the active id is stale', () => {
        const decoded = decodePaneRow(
            paneRow({
                type: 'web',
                webTabsJSON: JSON.stringify([{ id: TAB1, url: 'https://example.com', title: '' }]),
                webActiveTabID: TAB2
            })
        );
        expect(decoded?.pane.webActiveTabID).toBe(TAB1);
    });

    it('synthesizes one tab from the legacy webURL when webTabsJSON is absent (pre-v13)', () => {
        const decoded = decodePaneRow(
            paneRow({ type: 'web', webTabsJSON: null, webURL: 'https://example.com', webActiveTabID: null }),
            { newTabID: () => TAB1 }
        );
        expect(decoded?.pane.webTabs).toEqual([{ id: TAB1, url: 'https://example.com', title: '' }]);
        expect(decoded?.pane.webActiveTabID).toBe(TAB1);
    });

    it('ignores webURL whenever webTabsJSON decodes (§9.11)', () => {
        const decoded = decodePaneRow(
            paneRow({
                type: 'web',
                webTabsJSON: JSON.stringify([{ id: TAB1, url: 'https://tabs.example', title: '' }]),
                webURL: 'https://legacy.example'
            })
        );
        expect(decoded?.pane.webTabs).toEqual([{ id: TAB1, url: 'https://tabs.example', title: '' }]);
    });

    it('restores a private web pane blank but still private (§9.10)', () => {
        const decoded = decodePaneRow(
            paneRow({ type: 'web', webIsPrivate: 1, webTabsJSON: null, webURL: 'https://leak.example' })
        );
        expect(decoded?.pane.webIsPrivate).toBe(true);
        expect(decoded?.pane.webTabs).toBeNull();
        expect(decoded?.pane.webActiveTabID).toBeNull();
    });

    it('degrades undecodable webTabsJSON to a blank web pane', () => {
        const decoded = decodePaneRow(paneRow({ type: 'web', webTabsJSON: '[{"id":"nope"}]' }));
        expect(decoded?.pane.webTabs).toEqual([]);
    });

    it('keeps scratchpad content verbatim, including the empty body', () => {
        expect(decodePaneRow(paneRow({ type: 'scratchpad', content: '' }))?.pane.scratchpadContent).toBe('');
        expect(decodePaneRow(paneRow({ type: 'scratchpad', content: '# notes' }))?.pane.scratchpadContent).toBe(
            '# notes'
        );
    });

    it('degrades non-numeric timestamps to epoch 0 instead of dropping the pane', () => {
        const decoded = decodePaneRow(paneRow({ createdAt: 'yesterday', lastActivityAt: null }));
        expect(decoded?.pane.createdAt).toBe(0);
        expect(decoded?.pane.lastActivityAt).toBe(0);
    });
});

describe('group + association row decoding', () => {
    it('decodes a group row', () => {
        const decoded = decodeGroupRow(groupRow());
        expect(decoded?.sortOrder).toBe(0);
        expect(decoded?.group).toEqual({
            id: G1,
            name: 'work',
            color: 'purple',
            isCollapsed: true,
            childOrder: [W1],
            createdAt: 1_755_400_000,
            icon: { kind: 'emoji', grapheme: '📁' }
        } satisfies PersistedGroup);
    });

    it('degrades an undecodable childOrderJSON to []', () => {
        expect(decodeGroupRow(groupRow({ childOrderJSON: '["nope"]' }))?.group.childOrder).toEqual([]);
        expect(decodeGroupRow(groupRow({ childOrderJSON: 'oops' }))?.group.childOrder).toEqual([]);
    });

    it('skips associations with an unparseable id, workspace id or repo id', () => {
        const base = {
            id: '11111111-2222-3333-4444-555555555555',
            workspaceID: W1,
            repoID: W2,
            worktreePath: '/repo',
            branchName: 'main',
            isAutoDetected: 1
        };
        expect(decodeRepoAssociationRow(base as SqlRow)?.association).toEqual({
            id: '11111111-2222-3333-4444-555555555555',
            repoID: W2,
            worktreePath: '/repo',
            branchName: 'main',
            isAutoDetected: true
        });
        expect(decodeRepoAssociationRow({ ...base, id: 'nope' } as SqlRow)).toBeNull();
        expect(decodeRepoAssociationRow({ ...base, workspaceID: 'nope' } as SqlRow)).toBeNull();
        expect(decodeRepoAssociationRow({ ...base, repoID: 'nope' } as SqlRow)).toBeNull();
    });
});

describe('encoding (§5.4)', () => {
    it('writes epoch SECONDS, never milliseconds', () => {
        expect(toEpochSecondsColumn(1_755_500_000.5)).toBe(1_755_500_000.5);
        // Defensive: a Date.now() value would corrupt the column by 1000x.
        expect(toEpochSecondsColumn(1_755_500_000_500)).toBe(1_755_500_000.5);
        expect(toEpochSecondsColumn(Number.NaN)).toBe(0);
    });

    it('encodes the layout with Swift `_0` keys and uppercase UUIDs', () => {
        const row = encodeWorkspaceRow(
            {
                id: W1.toLowerCase(),
                name: 'nex',
                slug: 'nex-a4e8a251',
                color: 'blue',
                icon: { kind: 'emoji', grapheme: '🚀' },
                profileName: null,
                layout: {
                    kind: 'split',
                    direction: 'horizontal',
                    ratio: 0.6,
                    first: { kind: 'leaf', paneID: P1.toLowerCase() },
                    second: { kind: 'empty' }
                },
                focusedPaneID: P1.toLowerCase(),
                createdAt: 1_755_500_000,
                lastAccessedAt: 1_755_500_000,
                labels: ['frontend'],
                panes: [],
                repoAssociations: []
            },
            3
        );
        expect(row.id).toBe(W1);
        expect(row.focusedPaneID).toBe(P1);
        expect(row.sortOrder).toBe(3);
        expect(row.icon).toBe('emoji:🚀');
        expect(JSON.parse(row.layoutJSON)).toEqual({
            split: { _0: 'horizontal', ratio: 0.6, first: { leaf: { _0: P1 } }, second: { empty: {} } }
        });
        expect(row.labelsJSON).toBe('["frontend"]');
    });

    it('regenerates an empty slug on the way out too', () => {
        const row = encodeWorkspaceRow(
            {
                id: W1,
                name: 'My App!',
                slug: '',
                color: 'blue',
                icon: null,
                profileName: null,
                layout: { kind: 'empty' },
                focusedPaneID: null,
                createdAt: 1,
                lastAccessedAt: 1,
                labels: [],
                panes: [],
                repoAssociations: []
            },
            0
        );
        expect(row.slug).toBe('my-app-a4e8a251');
    });

    it('writes NULL tab columns for private web panes and for non-web panes (§5.4)', () => {
        const base: PersistedPane = {
            id: P2,
            label: null,
            type: 'web',
            workingDirectory: '/tmp',
            createdAt: 1,
            lastActivityAt: 1,
            agentSessionID: null,
            agentKind: null,
            status: 'idle',
            filePath: null,
            scratchpadContent: null,
            webTabs: [{ id: TAB1, url: 'https://example.com', title: 'Example' }],
            webActiveTabID: TAB1,
            webIsPrivate: false
        };

        const publicRow = encodePaneRow(base, W1);
        expect(publicRow.webTabsJSON).toBe(
            JSON.stringify([{ id: TAB1, url: 'https://example.com', title: 'Example' }])
        );
        expect(publicRow.webActiveTabID).toBe(TAB1);
        // Legacy fallback column carries the ACTIVE tab's URL.
        expect(publicRow.webURL).toBe('https://example.com');
        expect(publicRow.webIsPrivate).toBe(0);

        const privateRow = encodePaneRow({ ...base, webIsPrivate: true, webTabs: null }, W1);
        expect(privateRow.webIsPrivate).toBe(1);
        expect(privateRow.webTabsJSON).toBeNull();
        expect(privateRow.webActiveTabID).toBeNull();
        expect(privateRow.webURL).toBeNull();

        const shellRow = encodePaneRow({ ...base, type: 'shell', webTabs: null, webActiveTabID: null }, W1);
        expect(shellRow.webIsPrivate).toBeNull();
        expect(shellRow.webTabsJSON).toBeNull();
        expect(shellRow.webActiveTabID).toBeNull();
        expect(shellRow.webURL).toBeNull();
    });

    it('omits webTabsJSON for an empty tab list', () => {
        const row = encodePaneRow(
            {
                id: P2,
                label: null,
                type: 'web',
                workingDirectory: '/tmp',
                createdAt: 1,
                lastActivityAt: 1,
                agentSessionID: null,
                agentKind: null,
                status: 'idle',
                filePath: null,
                scratchpadContent: null,
                webTabs: [],
                webActiveTabID: null,
                webIsPrivate: false
            },
            W1
        );
        expect(row.webTabsJSON).toBeNull();
        expect(row.webURL).toBeNull();
        expect(row.webIsPrivate).toBe(0);
    });

    it('encodes booleans as 0/1 and childOrder as a UUID array', () => {
        const row = encodeGroupRow(
            {
                id: G1,
                name: 'work',
                color: null,
                isCollapsed: false,
                childOrder: [W1.toLowerCase()],
                createdAt: 1_755_400_000,
                icon: null
            },
            2
        );
        expect(row.isCollapsed).toBe(0);
        expect(row.childOrderJSON).toBe(`["${W1}"]`);
        expect(row.sortOrder).toBe(2);
        expect(row.color).toBeNull();
    });
});

describe('label presets (daemon-owned appState key)', () => {
    it('round-trips named and custom colors', () => {
        const presets = [
            { name: 'frontend', color: { kind: 'named' as const, color: 'blue' as const }, textColor: null },
            {
                name: 'wip',
                color: { kind: 'custom' as const, hex: '#ff00aa' },
                textColor: { kind: 'named' as const, color: 'black' as const }
            }
        ];
        expect(decodeLabelPresetsJSON(encodeLabelPresetsJSON(presets))).toEqual(presets);
    });

    it('skips malformed entries and degrades a broken blob to []', () => {
        expect(decodeLabelPresetsJSON('[{"name":"ok","color":{"kind":"named","color":"red"}},{"name":2}]')).toEqual([
            { name: 'ok', color: { kind: 'named', color: 'red' }, textColor: null }
        ]);
        expect(decodeLabelPresetsJSON('not json')).toEqual([]);
        expect(decodeLabelPresetsJSON(null)).toEqual([]);
    });
});

describe('snapshotFromRows assembly (§6.1)', () => {
    const rows = (overrides: Partial<LoadedRows> = {}): LoadedRows => ({
        workspaces: [workspaceRow({ id: W1, sortOrder: 1 }), workspaceRow({ id: W2, sortOrder: 0, slug: 'b' })],
        panes: [paneRow({ id: P1, workspaceID: W1 }), paneRow({ id: P2, workspaceID: W2 })],
        repos: [],
        repoAssociations: [],
        groups: [groupRow()],
        appState: [
            { key: APP_STATE_ACTIVE_WORKSPACE, value: W2 },
            {
                key: APP_STATE_TOP_LEVEL_ORDER,
                value: `[{"workspace":{"_0":"${W2}"}},{"group":{"_0":"${G1}"}}]`
            }
        ] as SqlRow[],
        ...overrides
    });

    it('orders workspaces by sortOrder and attaches panes by workspaceID', () => {
        const snapshot = snapshotFromRows(rows());
        expect(snapshot.workspaces.map((w) => w.id)).toEqual([W2, W1]);
        expect(snapshot.workspaces[0]?.panes.map((p) => p.id)).toEqual([P2]);
        expect(snapshot.workspaces[1]?.panes.map((p) => p.id)).toEqual([P1]);
        expect(snapshot.activeWorkspaceID).toBe(W2);
        expect(snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: W2 },
            { kind: 'group', id: G1 }
        ]);
        expect(snapshot.version).toBe(PERSISTED_SNAPSHOT_VERSION);
    });

    it('drops panes whose workspace row is missing, keeping siblings (§9.5)', () => {
        const snapshot = snapshotFromRows(
            rows({ workspaces: [workspaceRow({ id: W1 })], panes: [paneRow({ id: P1 }), paneRow({ id: P2, workspaceID: W2 })] })
        );
        expect(snapshot.workspaces).toHaveLength(1);
        expect(snapshot.workspaces[0]?.panes.map((p) => p.id)).toEqual([P1]);
    });

    it('synthesizes topLevelOrder from workspace order when it is empty (§6.2 step 3)', () => {
        const snapshot = snapshotFromRows(rows({ appState: [] }));
        expect(snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: W2 },
            { kind: 'workspace', id: W1 }
        ]);
        expect(snapshot.activeWorkspaceID).toBeNull();
    });

    it('synthesizes topLevelOrder when the stored JSON is undecodable', () => {
        const snapshot = snapshotFromRows(
            rows({ appState: [{ key: APP_STATE_TOP_LEVEL_ORDER, value: '[{"folder":{"_0":"x"}}]' }] as SqlRow[] })
        );
        expect(snapshot.topLevelOrder.map((entry) => entry.kind)).toEqual(['workspace', 'workspace']);
    });

    it('keeps a workspaceless DB decodable (fresh-install shape)', () => {
        const snapshot = snapshotFromRows(rows({ workspaces: [], panes: [], appState: [] }));
        expect(snapshot.workspaces).toEqual([]);
        expect(snapshot.topLevelOrder).toEqual([]);
    });

    it('keeps a stored topLevelOrder verbatim, dangling entries included (§6.2 step 3)', () => {
        // "No validation that entries reference live workspaces/groups."
        const snapshot = snapshotFromRows(rows({ workspaces: [], panes: [] }));
        expect(snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: W2 },
            { kind: 'group', id: G1 }
        ]);
    });

    it('reads the daemon-owned version and label-preset keys', () => {
        const snapshot = snapshotFromRows(
            rows({
                appState: [
                    { key: APP_STATE_SNAPSHOT_VERSION, value: '7' },
                    { key: APP_STATE_LABEL_PRESETS, value: '[{"name":"wip","color":{"kind":"named","color":"gray"}}]' }
                ] as SqlRow[]
            })
        );
        expect(snapshot.version).toBe(7);
        expect(snapshot.labelPresets).toEqual([
            { name: 'wip', color: { kind: 'named', color: 'gray' }, textColor: null }
        ]);
    });
});

describe('snapshotToRows', () => {
    const workspace: PersistedWorkspace = {
        id: W1,
        name: 'nex',
        slug: 'nex-a4e8a251',
        color: 'blue',
        icon: null,
        profileName: null,
        layout: { kind: 'leaf', paneID: P1 },
        focusedPaneID: P1,
        createdAt: 1,
        lastAccessedAt: 2,
        labels: [],
        panes: [],
        repoAssociations: []
    };

    it('numbers sortOrder by array index', () => {
        const rows = snapshotToRows({
            version: 1,
            workspaces: [workspace, { ...workspace, id: W2 }],
            groups: [],
            topLevelOrder: [],
            activeWorkspaceID: null,
            repos: [],
            labelPresets: []
        });
        expect(rows.workspaces.map((row) => [row.id, row.sortOrder])).toEqual([
            [W1, 0],
            [W2, 1]
        ]);
    });

    it('drops duplicate primary keys and duplicate repo paths rather than aborting the save (§9.4)', () => {
        const rows = snapshotToRows({
            version: 1,
            workspaces: [workspace, { ...workspace, name: 'dupe' }],
            groups: [],
            topLevelOrder: [],
            activeWorkspaceID: null,
            repos: [
                { id: G1, path: '/repo', name: 'repo', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: false },
                { id: W2, path: '/repo', name: 'other', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: true }
            ],
            labelPresets: []
        });
        expect(rows.workspaces).toHaveLength(1);
        expect(rows.workspaces[0]?.name).toBe('nex');
        expect(rows.repos).toHaveLength(1);
        expect(rows.repos[0]?.name).toBe('repo');
    });

    it('drops a repo association whose repo left the registry (FK violation)', () => {
        const rows = snapshotToRows({
            version: 1,
            workspaces: [
                {
                    ...workspace,
                    repoAssociations: [
                        { id: G1, repoID: W2, worktreePath: '/gone', branchName: null, isAutoDetected: false }
                    ]
                }
            ],
            groups: [],
            topLevelOrder: [],
            activeWorkspaceID: null,
            repos: [],
            labelPresets: []
        });
        expect(rows.workspaces).toHaveLength(1);
        expect(rows.repoAssociations).toEqual([]);
    });

    it('emits the five appState keys', () => {
        const rows = snapshotToRows({
            version: PERSISTED_SNAPSHOT_VERSION,
            workspaces: [],
            groups: [],
            topLevelOrder: [{ kind: 'group', id: G1 }],
            activeWorkspaceID: W1.toLowerCase(),
            repos: [],
            labelPresets: []
        });
        expect(rows.appState).toEqual([
            { key: APP_STATE_ACTIVE_WORKSPACE, value: W1 },
            { key: APP_STATE_TOP_LEVEL_ORDER, value: `[{"group":{"_0":"${G1}"}}]` },
            { key: APP_STATE_LABEL_PRESETS, value: '[]' },
            { key: APP_STATE_SNAPSHOT_VERSION, value: String(PERSISTED_SNAPSHOT_VERSION) },
            // §APP-116: absent on the snapshot means "never migrated", written as '0'.
            { key: APP_STATE_LABEL_PRESETS_MIGRATED, value: '0' }
        ]);
    });

    it('writes the label-preset migration marker as 1 and reads back every truthy spelling', () => {
        const rows = snapshotToRows({
            version: PERSISTED_SNAPSHOT_VERSION,
            workspaces: [],
            groups: [],
            topLevelOrder: [],
            activeWorkspaceID: null,
            repos: [],
            labelPresets: [],
            labelPresetsMigrated: true
        });
        expect(rows.appState).toContainEqual({ key: APP_STATE_LABEL_PRESETS_MIGRATED, value: '1' });
        // A pre-key database has no row at all — that is "never migrated", never "unknown".
        expect(decodeAppStateFlag(null)).toBe(false);
        expect(decodeAppStateFlag('')).toBe(false);
        expect(decodeAppStateFlag('0')).toBe(false);
        expect(decodeAppStateFlag('nonsense')).toBe(false);
        expect(decodeAppStateFlag('1')).toBe(true);
        expect(decodeAppStateFlag(' TRUE ')).toBe(true);
    });
});
