/**
 * The transient rules (docs/current/persistence.md §7.1–7.3) applied to a decoded legacy
 * snapshot. The load-bearing one: statuses go, session ids stay.
 */

import { describe, expect, it } from 'vitest';

import type {
    PersistedGroup,
    PersistedPane,
    PersistedSnapshot,
    PersistedWorkspace
} from '../store/index.js';
import { PERSISTED_SNAPSHOT_VERSION } from '../store/index.js';
import { convertLegacySnapshot } from './convert.js';

const WS_A = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const WS_B = '1DE27A23-1EDA-4967-B4A7-9746532F257A';
const PANE_1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';
const PANE_2 = 'E73AB578-97F5-4E6B-94D9-E05DF697C2EB';
const PANE_3 = 'C003C0E3-27D5-4F86-A99D-845F64E629A2';
const TAB_ID = '5F0C24D9-1111-4222-8333-444455556666';
const REPO_ID = 'C1DFCF02-F226-4075-9944-86C5E5E42820';

function pane(overrides: Partial<PersistedPane> & { id: string }): PersistedPane {
    return {
        label: null,
        type: 'shell',
        workingDirectory: '/tmp',
        createdAt: 1_776_423_707,
        lastActivityAt: 1_776_423_800,
        agentSessionID: null,
        agentKind: null,
        status: 'idle',
        filePath: null,
        scratchpadContent: null,
        webTabs: null,
        webActiveTabID: null,
        webIsPrivate: false,
        ...overrides
    };
}

function workspace(overrides: Partial<PersistedWorkspace> & { id: string }): PersistedWorkspace {
    return {
        name: 'Alpha',
        slug: 'alpha-a4e8a251',
        color: 'blue',
        icon: null,
        profileName: null,
        layout: { kind: 'empty' },
        focusedPaneID: null,
        createdAt: 1_776_423_707,
        lastAccessedAt: 1_776_423_800,
        labels: [],
        panes: [],
        repoAssociations: [],
        ...overrides
    };
}

function snapshot(overrides: Partial<PersistedSnapshot> = {}): PersistedSnapshot {
    return {
        version: PERSISTED_SNAPSHOT_VERSION,
        workspaces: [],
        groups: [],
        topLevelOrder: [],
        activeWorkspaceID: null,
        repos: [],
        labelPresets: [],
        ...overrides
    };
}

describe('convertLegacySnapshot — transient rules', () => {
    const legacy = snapshot({
        workspaces: [
            workspace({
                id: WS_A,
                panes: [
                    pane({ id: PANE_1, status: 'running', agentSessionID: 'sess-abc', agentKind: 'codex' }),
                    pane({ id: PANE_2, status: 'waitingForInput', agentSessionID: 'sess-def' }),
                    pane({ id: PANE_3, status: 'idle' })
                ]
            })
        ]
    });
    const result = convertLegacySnapshot(legacy);

    it('resets every status to idle — no PTY survives an import', () => {
        expect(result.snapshot.workspaces[0]?.panes.map((entry) => entry.status)).toEqual([
            'idle',
            'idle',
            'idle'
        ]);
        expect(result.warnings.some((warning) => warning.includes('2 non-idle pane status'))).toBe(true);
    });

    it('KEEPS agentSessionID and agentKind so the first boot resumes them', () => {
        const [first, second] = result.snapshot.workspaces[0]?.panes ?? [];
        expect(first?.agentSessionID).toBe('sess-abc');
        expect(first?.agentKind).toBe('codex');
        expect(second?.agentSessionID).toBe('sess-def');
        // Never seen an agent → null, which the resume path reads as claude.
        expect(second?.agentKind).toBeNull();
        expect(result.resumable).toEqual([
            { paneID: PANE_1, sessionID: 'sess-abc' },
            { paneID: PANE_2, sessionID: 'sess-def' }
        ]);
    });

    it('stamps the current snapshot version', () => {
        expect(result.snapshot.version).toBe(PERSISTED_SNAPSHOT_VERSION);
    });

    it('carries a shell-unsafe session id over but does not count it as resumable', () => {
        const unsafe = convertLegacySnapshot(
            snapshot({
                workspaces: [
                    workspace({
                        id: WS_A,
                        panes: [pane({ id: PANE_1, agentSessionID: 'rm -rf /; echo pwned' })]
                    })
                ]
            })
        );
        // §9.13: the boot would refuse to type it, so promising a resume would be a lie…
        expect(unsafe.resumable).toEqual([]);
        expect(unsafe.warnings.some((warning) => warning.includes('shell-safety allowlist'))).toBe(true);
        // …but throwing the id away is not this step's call.
        expect(unsafe.snapshot.workspaces[0]?.panes[0]?.agentSessionID).toBe('rm -rf /; echo pwned');
    });
});

describe('convertLegacySnapshot — web panes', () => {
    it('keeps a private pane private and never carries its tabs', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [
                    workspace({
                        id: WS_A,
                        panes: [
                            pane({
                                id: PANE_1,
                                type: 'web',
                                webIsPrivate: true,
                                // A hand-edited row could carry these; the rule is absolute.
                                webTabs: [{ id: TAB_ID, url: 'https://secret.example', title: 'Secret' }],
                                webActiveTabID: TAB_ID
                            })
                        ]
                    })
                ]
            })
        );
        const restored = result.snapshot.workspaces[0]?.panes[0];
        expect(restored?.webIsPrivate).toBe(true);
        expect(restored?.webTabs).toBeNull();
        expect(restored?.webActiveTabID).toBeNull();
    });

    it('repairs an active tab id that names no tab', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [
                    workspace({
                        id: WS_A,
                        panes: [
                            pane({
                                id: PANE_1,
                                type: 'web',
                                webTabs: [{ id: TAB_ID, url: 'https://example.com', title: '' }],
                                webActiveTabID: '99999999-9999-4999-8999-999999999999'
                            })
                        ]
                    })
                ]
            })
        );
        expect(result.snapshot.workspaces[0]?.panes[0]?.webActiveTabID).toBe(TAB_ID);
    });

    it('leaves non-web panes without web state', () => {
        const result = convertLegacySnapshot(
            snapshot({ workspaces: [workspace({ id: WS_A, panes: [pane({ id: PANE_1 })] })] })
        );
        const restored = result.snapshot.workspaces[0]?.panes[0];
        expect(restored?.webTabs).toBeNull();
        expect(restored?.webIsPrivate).toBe(false);
    });
});

describe('convertLegacySnapshot — repairs', () => {
    it('synthesizes a sidebar order for a pre-groups database', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [workspace({ id: WS_A }), workspace({ id: WS_B, name: 'Beta' })],
                topLevelOrder: []
            })
        );
        expect(result.snapshot.topLevelOrder).toEqual([
            { kind: 'workspace', id: WS_A },
            { kind: 'workspace', id: WS_B }
        ]);
    });

    it('falls back to the first workspace when the active one did not survive', () => {
        const result = convertLegacySnapshot(
            snapshot({ workspaces: [workspace({ id: WS_A })], activeWorkspaceID: WS_B })
        );
        expect(result.snapshot.activeWorkspaceID).toBe(WS_A);
    });

    it('leaves the active workspace alone when it is present', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [workspace({ id: WS_A }), workspace({ id: WS_B })],
                activeWorkspaceID: WS_B
            })
        );
        expect(result.snapshot.activeWorkspaceID).toBe(WS_B);
    });

    it('drops rows the write path would reject anyway, so the counts are honest', () => {
        const result = convertLegacySnapshot(
            snapshot({
                repos: [
                    { id: REPO_ID, path: '/repo', name: 'repo', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: false },
                    { id: '11111111-1111-4111-8111-111111111111', path: '/repo', name: 'dupe', remoteURL: null, lastAccessedAt: 1, isAutoDiscovered: false }
                ],
                workspaces: [
                    workspace({
                        id: WS_A,
                        panes: [pane({ id: PANE_1 }), pane({ id: PANE_1 })],
                        repoAssociations: [
                            { id: '22222222-2222-4222-8222-222222222222', repoID: REPO_ID, worktreePath: '/repo', branchName: 'main', isAutoDetected: false },
                            { id: '33333333-3333-4333-8333-333333333333', repoID: '99999999-9999-4999-8999-999999999999', worktreePath: '/ghost', branchName: null, isAutoDetected: false }
                        ]
                    }),
                    // A duplicate pane id in ANOTHER workspace: the second one loses.
                    workspace({ id: WS_B, panes: [pane({ id: PANE_1 }), pane({ id: PANE_2 })] })
                ]
            })
        );
        expect(result.snapshot.repos.map((repo) => repo.id)).toEqual([REPO_ID]);
        expect(result.snapshot.workspaces[0]?.panes.map((entry) => entry.id)).toEqual([PANE_1]);
        expect(result.snapshot.workspaces[1]?.panes.map((entry) => entry.id)).toEqual([PANE_2]);
        expect(result.snapshot.workspaces[0]?.repoAssociations.map((entry) => entry.repoID)).toEqual([
            REPO_ID
        ]);
    });

    it('drops a duplicate workspace and group id', () => {
        const group: PersistedGroup = {
            id: '7F429BA5-7F39-477B-AC5B-236ADBB5FE5A',
            name: 'agents',
            color: null,
            isCollapsed: false,
            childOrder: [],
            createdAt: 1,
            icon: null
        };
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [workspace({ id: WS_A }), workspace({ id: WS_A, name: 'Clone' })],
                groups: [group, { ...group, name: 'clone' }]
            })
        );
        expect(result.snapshot.workspaces).toHaveLength(1);
        expect(result.snapshot.groups.map((entry) => entry.name)).toEqual(['agents']);
    });
});

describe('convertLegacySnapshot — label presets', () => {
    it('back-fills a gray preset for every label the legacy DB carried', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [
                    workspace({ id: WS_A, labels: ['frontend', 'wip'] }),
                    workspace({ id: WS_B, labels: ['wip', 'backend'] })
                ]
            })
        );
        expect(result.snapshot.labelPresets.map((preset) => preset.name)).toEqual([
            'frontend',
            'wip',
            'backend'
        ]);
        expect(result.snapshot.labelPresets[0]?.color).toEqual({ kind: 'named', color: 'gray' });
        expect(result.backfilledPresets).toEqual(['frontend', 'wip', 'backend']);
        expect(result.warnings.some((warning) => warning.includes('Settings ▸ Labels'))).toBe(true);
    });

    it('never overwrites a preset that already exists', () => {
        const result = convertLegacySnapshot(
            snapshot({
                workspaces: [workspace({ id: WS_A, labels: ['wip'] })],
                labelPresets: [{ name: 'wip', color: { kind: 'named', color: 'red' }, textColor: null }]
            })
        );
        expect(result.snapshot.labelPresets).toEqual([
            { name: 'wip', color: { kind: 'named', color: 'red' }, textColor: null }
        ]);
        expect(result.backfilledPresets).toEqual([]);
    });

    it('can be switched off', () => {
        const result = convertLegacySnapshot(
            snapshot({ workspaces: [workspace({ id: WS_A, labels: ['wip'] })] }),
            { backfillLabelPresets: false }
        );
        expect(result.snapshot.labelPresets).toEqual([]);
    });
});
