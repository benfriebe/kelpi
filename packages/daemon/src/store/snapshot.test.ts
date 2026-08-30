import { resumeCommand } from '@kelpi/core/agent';
import { describe, expect, it } from 'vitest';
import { workspaceByID } from './derived.js';
import { applyLoadReset, fromSnapshot, toSnapshot } from './snapshot.js';
import { harness, HOME, id, NOW, seededState, W1 } from './testing.js';
import type { DaemonState } from './types.js';

const P0 = id('dddddddd', 100);
const PA = id('eeeeeeee', 1);
const PB = id('eeeeeeee', 2);

function reload(state: DaemonState): DaemonState {
    return fromSnapshot(toSnapshot(state), { homeDirectory: HOME });
}

describe('toSnapshot', () => {
    it('keeps the persisted surface and drops every transient field', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'workspace-labels', id: W1, op: 'add', values: ['wip'] },
            { type: 'set-workspace-profile', id: W1, profileName: 'work' },
            { type: 'cycle-layout', workspaceID: W1 },
            { type: 'set-sync-input-active', workspaceID: W1, active: true },
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: PB,
                filePath: '/docs/a.md',
                reusePaneID: P0,
                now: NOW
            },
            { type: 'pane-title-changed', paneID: PA, title: 'live title', now: NOW },
            { type: 'pane-branch-changed', paneID: PA, branch: 'main' }
        );

        const snapshot = toSnapshot(h.state());
        const workspace = snapshot.workspaces[0];
        expect(workspace).toMatchObject({
            id: W1,
            labels: ['wip'],
            profileName: 'work',
            focusedPaneID: PB
        });
        // Parked panes never persist.
        expect(workspace?.panes.map((pane) => pane.id).sort()).toEqual([PA, PB].sort());
        const restored = reload(h.state());
        const reloaded = workspaceByID(restored, W1);
        expect(reloaded).toMatchObject({
            parkedPanes: [],
            focusHistory: [],
            recentlyClosedPanes: [],
            currentLayoutIndex: null,
            isSyncInputActive: false,
            syncInputExcluded: [],
            zoomedPaneID: null,
            savedLayout: null,
            searchingPaneID: null,
            searchNeedle: ''
        });
        const pane = reloaded?.panes.find((candidate) => candidate.id === PA);
        expect(pane).toMatchObject({
            title: null,
            gitBranch: null,
            agentStartedAt: null,
            backgroundTaskCount: 0,
            markdownFontSize: 14,
            parkedSourcePaneID: null,
            externalEditorCommand: null
        });
    });

    it('persists the un-zoomed tree', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'toggle-zoom', workspaceID: W1 }
        );
        const snapshot = toSnapshot(h.state());
        expect(snapshot.workspaces[0]?.layout).toMatchObject({ kind: 'split' });
    });

    it('withholds a private web pane’s tabs but keeps the flag', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: PA,
                tabID: PB,
                url: 'https://example.com',
                isPrivate: true,
                now: NOW
            },
            {
                type: 'open-web-pane',
                workspaceID: W1,
                paneID: id('eeeeeeee', 3),
                tabID: id('eeeeeeee', 4),
                url: 'https://public.example',
                now: NOW
            }
        );
        const snapshot = toSnapshot(h.state());
        const privatePane = snapshot.workspaces[0]?.panes.find((pane) => pane.id === PA);
        expect(privatePane).toMatchObject({ webTabs: null, webActiveTabID: null, webIsPrivate: true });
        const publicPane = snapshot.workspaces[0]?.panes.find(
            (pane) => pane.id === id('eeeeeeee', 3)
        );
        expect(publicPane?.webTabs).toHaveLength(1);

        const restored = workspaceByID(reload(h.state()), W1);
        expect(restored?.webPanes[PA]).toEqual({ tabs: [], activeTabID: null, isPrivate: true });
        expect(restored?.webPanes[id('eeeeeeee', 3)]?.activeTabID).toBe(id('eeeeeeee', 4));
    });

    it('round-trips the persisted surface', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            { type: 'create-group', id: id('cccccccc', 1), name: 'Client', now: NOW },
            { type: 'move-workspace-to-group', id: W1, groupID: id('cccccccc', 1), index: null },
            { type: 'workspace-labels', id: W1, op: 'add', values: ['wip'] }
        );
        const first = toSnapshot(h.state());
        const second = toSnapshot(fromSnapshot(first, { homeDirectory: HOME }));
        expect(second).toEqual(first);
    });
});

describe('fromSnapshot', () => {
    it('restores scratchpads into edit mode and keeps stored statuses verbatim', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'create-scratchpad', workspaceID: W1, paneID: PA, now: NOW },
            {
                type: 'scratchpad-content-changed',
                workspaceID: W1,
                paneID: PA,
                content: 'draft'
            },
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'agentStarted', agent: 'codex' },
                now: NOW
            },
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'sessionStarted', sessionID: 'sess-1', agent: 'codex' },
                now: NOW
            }
        );
        const restored = workspaceByID(reload(h.state()), W1);
        expect(restored?.panes.find((pane) => pane.id === PA)).toMatchObject({
            type: 'scratchpad',
            isEditing: true,
            scratchpadContent: 'draft'
        });
        // fromSnapshot restores what the DB holds; clearing is applyLoadReset's job.
        expect(restored?.panes.find((pane) => pane.id === P0)).toMatchObject({
            status: 'running',
            agentSessionID: 'sess-1',
            agentKind: 'codex'
        });
    });

    it('synthesizes a legacy top-level order and defaults the active workspace', () => {
        const state = seededState();
        const snapshot = { ...toSnapshot(state), topLevelOrder: [], activeWorkspaceID: null };
        const restored = fromSnapshot(snapshot, { homeDirectory: HOME });
        expect(restored.topLevelOrder).toEqual([{ kind: 'workspace', id: W1 }]);
        expect(restored.lastActiveWorkspaceID).toBe(W1);
    });

    it('drops an active workspace id that no longer exists', () => {
        const snapshot = { ...toSnapshot(seededState()), activeWorkspaceID: 'gone' };
        expect(fromSnapshot(snapshot, { homeDirectory: HOME }).lastActiveWorkspaceID).toBe(W1);
    });
});

describe('applyLoadReset', () => {
    it('captures resume tuples before clearing session ids and statuses', () => {
        const h = harness(seededState());
        h.dispatch(
            { type: 'split-pane', workspaceID: W1, paneID: PA, direction: 'horizontal', now: NOW },
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'sessionStarted', sessionID: 'claude-session', agent: 'claude' },
                now: NOW
            },
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'agentStarted', agent: 'claude' },
                now: NOW
            },
            {
                type: 'pane-agent-event',
                paneID: PA,
                event: { type: 'sessionStarted', sessionID: 'codex-session', agent: 'codex' },
                now: NOW
            }
        );

        const loaded = reload(h.state());
        const { state, resumeTuples } = applyLoadReset(loaded);
        expect(resumeTuples).toEqual([
            { paneID: P0, sessionID: 'claude-session', kind: 'claude' },
            { paneID: PA, sessionID: 'codex-session', kind: 'codex' }
        ]);
        expect(resumeTuples.map((tuple) => resumeCommand(tuple.kind, tuple.sessionID))).toEqual([
            'claude --resume claude-session',
            'codex resume codex-session'
        ]);

        const workspace = workspaceByID(state, W1);
        for (const pane of workspace?.panes ?? []) {
            expect(pane.agentSessionID).toBeNull();
            expect(pane.status).toBe('idle');
        }
        // agentKind is deliberately preserved as a last-known display value.
        expect(workspace?.panes.find((pane) => pane.id === PA)?.agentKind).toBe('codex');
    });

    it('is a no-op (identical state) when nothing needs clearing', () => {
        const loaded = reload(seededState());
        const { state, resumeTuples } = applyLoadReset(loaded);
        expect(resumeTuples).toEqual([]);
        expect(state).toBe(loaded);
    });
});
