import { createStore, emptyDaemonState, type DaemonState, type DomainAction, type WorkspaceState } from '@kelpi/daemon/store';
import { describe, expect, it } from 'vitest';

import { onScreenPanes, paneTabTitle, tabsAgentSummary, workspaceTabViews } from './workspace-tabs';

const W = 'AAAAAAAA-0000-4000-8000-000000000001';
const P0 = 'DDDDDDDD-0000-4000-8000-000000000100';
const P1 = 'EEEEEEEE-0000-4000-8000-000000000001';
const P2 = 'EEEEEEEE-0000-4000-8000-000000000002';
const T1 = 'FFFFFFFF-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function build(...actions: DomainAction[]): WorkspaceState {
    const store = createStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W, paneID: P0, name: 'dev', color: 'blue', now: NOW, workingDirectory: '/Users/test/acme-web' });
    for (const action of actions) store.dispatch(action);
    return (store.getState() as DaemonState).workspaces[0] as WorkspaceState;
}

const newTab = (focus?: boolean): DomainAction => ({
    type: 'create-tab',
    workspaceID: W,
    tabID: T1,
    ...(focus === undefined ? {} : { focus }),
    create: { type: 'create-pane', workspaceID: W, paneID: P1, now: NOW, workingDirectory: '/Users/test/storefront' }
});

describe('workspaceTabViews', () => {
    it('names a tab after its focused pane until it is renamed', () => {
        let views = workspaceTabViews(build(newTab()));
        expect(views.map((tab) => tab.title)).toEqual(['acme-web', 'storefront']);
        expect(views.map((tab) => tab.named)).toEqual([false, false]);
        views = workspaceTabViews(build(newTab(), { type: 'rename-tab', workspaceID: W, tabID: T1, name: 'shop' }));
        expect(views[1]).toMatchObject({ title: 'shop', named: true });
    });

    it('counts panes, marks the tab on screen and its position', () => {
        const views = workspaceTabViews(
            build(newTab(), { type: 'split-pane', workspaceID: W, paneID: P2, sourcePaneID: P1, direction: 'horizontal', now: NOW, focus: true })
        );
        expect(views.map((tab) => [tab.index, tab.paneCount, tab.active])).toEqual([
            [0, 1, false],
            [1, 2, true]
        ]);
        expect(views[1]?.paneIDs).toEqual([P1, P2]);
    });

    it('raises attention for a background tab waiting for input, unless the workspace is muted', () => {
        const base = build(newTab());
        const withStatus = (workspace: WorkspaceState, status: 'waitingForInput' | 'running'): WorkspaceState => ({
            ...workspace,
            panes: workspace.panes.map((pane) => (pane.id === P0 ? { ...pane, status } : pane))
        });
        expect(workspaceTabViews(withStatus(base, 'waitingForInput'))[0]).toMatchObject({ status: 'waitingForInput', attention: true });
        expect(workspaceTabViews({ ...withStatus(base, 'waitingForInput'), muted: true })[0]?.attention).toBe(false);
        expect(workspaceTabViews(withStatus(base, 'running'))[0]).toMatchObject({ status: 'running', attention: false });
    });

    it('marks a tab opened in the background as unvisited until it is shown', () => {
        expect(workspaceTabViews(build(newTab(false)))[1]).toMatchObject({ unvisited: true, active: false });
        expect(
            workspaceTabViews(build(newTab(false), { type: 'select-tab', workspaceID: W, tabID: T1 }))[1]?.unvisited
        ).toBe(false);
    });

    it('reads a mirror without tabs as one tab', () => {
        const workspace = build();
        const legacy = { ...workspace, tabs: undefined, activeTabID: undefined } as unknown as WorkspaceState;
        expect(workspaceTabViews(legacy)).toMatchObject([{ id: W, active: true, paneCount: 1 }]);
    });
});

describe('paneTabTitle', () => {
    it('prefers a label, then an agent, then the last path component', () => {
        const workspace = build();
        const pane = workspace.panes[0] as WorkspaceState['panes'][number];
        expect(paneTabTitle(workspace, { ...pane, label: 'coordinator' })).toBe('coordinator');
        expect(paneTabTitle(workspace, { ...pane, agentKind: 'claude', agentSessionID: 's' })).toBe('claude');
        expect(paneTabTitle(workspace, { ...pane, title: '~/acme-web/src' })).toBe('src');
        expect(paneTabTitle(workspace, pane)).toBe('acme-web');
    });
});

describe('onScreenPanes', () => {
    it('hands a grid only the tab on screen, the same array until the workspace moves', () => {
        const workspace = build(newTab());
        const first = onScreenPanes(workspace);
        expect(first.map((pane) => pane.id)).toEqual([P1]);
        expect(onScreenPanes(workspace)).toBe(first);
        const single = build();
        expect(onScreenPanes(single)).toBe(single.panes);
    });
});

describe('tabsAgentSummary', () => {
    it('counts the agents in the named tabs only, for the close-tab gate', () => {
        const base = build(newTab());
        const workspace: WorkspaceState = {
            ...base,
            panes: base.panes.map((pane) =>
                pane.id === P1 ? { ...pane, status: 'running' } : pane.id === P0 ? { ...pane, status: 'waitingForInput' } : pane
            )
        };
        expect(tabsAgentSummary(workspace, [T1])).toMatchObject({ running: 1, waiting: 0, total: 1 });
        expect(tabsAgentSummary(workspace, [W])).toMatchObject({ running: 0, waiting: 1, total: 1 });
        expect(tabsAgentSummary(workspace, [W, T1]).total).toBe(2);
        expect(tabsAgentSummary(build(newTab()), [T1]).total).toBe(0);
    });
});
