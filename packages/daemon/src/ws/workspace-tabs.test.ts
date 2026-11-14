import { leaf } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';

import { harness, seedSplit, seedWorkspace, testID, W1, W2, type Harness } from '../handlers/pane/testing.js';
import { onScreenPaneIDs, tabPaneIDs, workspaceTabs } from '../store/tabs.js';
import { createWorkspaceTabChannel, isWorkspaceTabCommand, type WorkspaceTabChannelOptions } from './workspace-tabs.js';
import { isPaneLifecycleCommand } from './panes.js';

const P0 = testID('D', 100);
const P1 = testID('D', 101);
const T1 = testID('F', 1);
const T2 = testID('F', 2);
const T3 = testID('F', 3);

interface Fixture {
    readonly h: Harness;
    readonly channel: ReturnType<typeof createWorkspaceTabChannel>;
    readonly agents: { paneID: string; workspaceID: string }[];
}

function fixture(
    extra: Partial<Omit<WorkspaceTabChannelOptions, 'ctx'>> & {
        readonly position?: 'after-current' | 'end';
        readonly tabs?: readonly string[];
    } = {}
): Fixture {
    const h = harness();
    seedWorkspace(h, { id: W1, name: 'dev', paneID: P0, path: '/tmp/work' });
    const tabIDs = [...(extra.tabs ?? [T1, T2, T3])];
    const agents: { paneID: string; workspaceID: string }[] = [];
    const channel = createWorkspaceTabChannel({
        ctx: {
            ...h.ctx,
            mintTabID: () => tabIDs.shift() ?? testID('F', 99),
            newTabPosition: () => extra.position ?? 'after-current'
        },
        startAgent: (paneID, workspaceID) => agents.push({ paneID, workspaceID }),
        ...(extra.newTabOpens === undefined ? {} : { newTabOpens: extra.newTabOpens })
    });
    return { h, channel, agents };
}

describe('the verbs', () => {
    it('ride the pane lifecycle channel', () => {
        expect(isWorkspaceTabCommand('workspace-tab-new')).toBe(true);
        expect(isPaneLifecycleCommand('workspace-tab-close')).toBe(true);
        expect(isPaneLifecycleCommand('pane-move-to-new-tab')).toBe(true);
        expect(isWorkspaceTabCommand('pane-close')).toBe(false);
    });
});

describe('workspace-tab-new', () => {
    it('opens a terminal tab in the workspace folder, spawned, and shows it', () => {
        const f = fixture();
        const reply = f.channel.run('workspace-tab-new', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, tab_id: T1, kind: 'terminal' });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(T1);
        const paneID = String(reply['pane_id']);
        expect(onScreenPaneIDs(workspace)).toEqual([paneID]);
        expect(f.h.pty.spawns.map((spawn) => spawn.paneID)).toContain(paneID);
        expect(workspace.panes.find((pane) => pane.id === paneID)?.workingDirectory).toBe('/tmp/work');
    });

    it('follows "New tabs go: at the end"', () => {
        const f = fixture({ position: 'end' });
        f.channel.run('workspace-tab-new', { workspace_id: W1 });
        f.channel.run('workspace-tab-select', { workspace_id: W1, tab_id: W1 });
        f.channel.run('workspace-tab-new', { workspace_id: W1 });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([W1, T1, T2]);
    });

    it('opens what "A new tab opens" says when the caller names no kind', () => {
        const f = fixture({ newTabOpens: () => 'agent' });
        const reply = f.channel.run('workspace-tab-new', { workspace_id: W1 });
        expect(reply).toMatchObject({ ok: true, kind: 'agent' });
        expect(f.agents).toEqual([{ paneID: reply['pane_id'], workspaceID: W1 }]);
    });

    it('opens a web tab and a scratchpad tab without a PTY', () => {
        const f = fixture();
        const web = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'web' });
        const pad = f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'scratchpad' });
        const workspace = f.h.workspace(W1);
        expect(workspace.panes.find((pane) => pane.id === web['pane_id'])?.type).toBe('web');
        expect(workspace.panes.find((pane) => pane.id === pad['pane_id'])?.type).toBe('scratchpad');
        expect(f.h.pty.spawns.map((spawn) => spawn.paneID)).not.toContain(web['pane_id']);
    });

    it('refuses an unknown kind and an unknown workspace', () => {
        const f = fixture();
        expect(f.channel.run('workspace-tab-new', { workspace_id: W1, kind: 'diff' })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-new', { workspace_id: 'nope' })).toMatchObject({ ok: false });
    });
});

describe('workspace-tab-close', () => {
    it('ends the PTY of every pane the tab took', () => {
        const f = fixture();
        const reply = f.channel.run('workspace-tab-new', { workspace_id: W1 });
        const paneID = String(reply['pane_id']);
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: paneID, paneID: P1 });
        const closed = f.channel.run('workspace-tab-close', { workspace_id: W1, tab_id: T1 });
        expect(closed).toMatchObject({ ok: true, closed: 2 });
        expect(f.h.pty.killed.sort()).toEqual([paneID, P1].sort());
        expect(f.h.term.disposed.sort()).toEqual([paneID, P1].sort());
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([W1]);
        expect(f.h.workspace(W1).layout).toEqual(leaf(P0));
    });

    it('keeps the last tab', () => {
        const f = fixture();
        const reply = f.channel.run('workspace-tab-close', { workspace_id: W1, tab_id: W1 });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('at least one tab');
        expect(f.h.pty.killed).toEqual([]);
    });

    it('refuses when a document will not save, closing nothing', () => {
        const f = fixture();
        f.channel.run('workspace-tab-new', { workspace_id: W1 });
        const refusing = createWorkspaceTabChannel({
            ctx: {
                ...f.h.ctx,
                prepareDocumentClose: () => {
                    throw new Error('could not save notes.md');
                }
            }
        });
        expect(refusing.run('workspace-tab-close', { workspace_id: W1, tab_id: T1 })).toEqual({
            ok: false,
            error: 'could not save notes.md'
        });
        expect(workspaceTabs(f.h.workspace(W1))).toHaveLength(2);
    });
});

describe('moving panes and tabs', () => {
    it('pane-move-to-new-tab answers with the tab the pane landed in', () => {
        const f = fixture();
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1 });
        expect(f.channel.run('pane-move-to-new-tab', { pane_id: P1 })).toMatchObject({ ok: true, tab_id: T1 });
        const workspace = f.h.workspace(W1);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toEqual(leaf(P1));
    });

    it('pane-move-to-tab checks its zone, a wire edge beside the named pane', () => {
        const f = fixture();
        const opened = f.channel.run('workspace-tab-new', { workspace_id: W1 });
        const target = String(opened['pane_id']);
        expect(f.channel.run('pane-move-to-tab', { pane_id: P0, tab_id: T1, zone: 'middle' })).toMatchObject({ ok: false });
        expect(
            f.channel.run('pane-move-to-tab', { pane_id: P0, tab_id: T1, target_pane_id: target, zone: 'left-of' })
        ).toMatchObject({ ok: true });
        expect(f.h.workspace(W1).layout).toMatchObject({ kind: 'split', first: { kind: 'leaf', paneID: P0 } });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([T1]);
    });

    it('workspace-tab-move-to-workspace carries the tab and its panes over', () => {
        const f = fixture();
        seedWorkspace(f.h, { id: W2, name: 'other', paneID: testID('D', 200) });
        const opened = f.channel.run('workspace-tab-new', { workspace_id: W1 });
        const reply = f.channel.run('workspace-tab-move-to-workspace', { workspace_id: W1, tab_id: T1, to_workspace_id: W2 });
        expect(reply).toMatchObject({ ok: true, workspace_id: W2, tab_id: T1 });
        expect(f.h.workspace(W2).panes.map((pane) => pane.id)).toContain(opened['pane_id']);
        expect(f.h.workspace(W1).panes.map((pane) => pane.id)).toEqual([P0]);
    });

    it('split-panes mints a tab per extra pane', () => {
        const f = fixture();
        seedSplit(f.h, { workspaceID: W1, sourcePaneID: P0, paneID: P1 });
        expect(f.channel.run('workspace-tab-split-panes', { workspace_id: W1, tab_id: W1 })).toMatchObject({
            ok: true,
            tab_ids: [T1]
        });
        const workspace = f.h.workspace(W1);
        expect(tabPaneIDs(workspace, workspaceTabs(workspace)[1] as never)).toEqual([P1]);
        expect(f.channel.run('workspace-tab-split-panes', { workspace_id: W1, tab_id: W1 })).toMatchObject({ ok: false });
    });

    it('merge-previous refuses the first tab', () => {
        const f = fixture();
        f.channel.run('workspace-tab-new', { workspace_id: W1 });
        expect(f.channel.run('workspace-tab-merge-previous', { workspace_id: W1, tab_id: W1 })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-merge-previous', { workspace_id: W1, tab_id: T1 })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1))).toHaveLength(1);
    });
});

describe('rename and reorder', () => {
    it('rename takes a string or null and nothing else', () => {
        const f = fixture();
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: 'main' })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1))[0]?.name).toBe('main');
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: 3 })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-rename', { workspace_id: W1, tab_id: W1, name: null })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1))[0]?.name).toBeNull();
    });

    it('move needs an index', () => {
        const f = fixture();
        f.channel.run('workspace-tab-new', { workspace_id: W1 });
        expect(f.channel.run('workspace-tab-move', { workspace_id: W1, tab_id: T1 })).toMatchObject({ ok: false });
        expect(f.channel.run('workspace-tab-move', { workspace_id: W1, tab_id: T1, index: 0 })).toMatchObject({ ok: true });
        expect(workspaceTabs(f.h.workspace(W1)).map((tab) => tab.id)).toEqual([T1, W1]);
    });
});
