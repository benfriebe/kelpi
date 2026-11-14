import { allPaneIDs, leaf, type Pane } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';
import { workspaceByID } from './derived.js';
import { applyDomainEvents } from './events.js';
import { fromSnapshot, toSnapshot } from './snapshot.js';
import {
    activeTab,
    normalizeTabs,
    onScreenPaneIDs,
    tabOfPane,
    tabPaneIDs,
    workspacePaneOrder,
    workspaceTabs
} from './tabs.js';
import { paneTabTitle } from './tab-title.js';
import { harness, HOME, id, NOW, seededState, W1, W2, type Harness } from './testing.js';
import type { DaemonState, DomainAction, WorkspaceState, WorkspaceTab } from './types.js';
import { syncedPaneIDs } from './derived.js';

const P0 = id('dddddddd', 100);
const P1 = id('eeeeeeee', 1);
const P2 = id('eeeeeeee', 2);
const P3 = id('eeeeeeee', 3);
const T1 = id('ffffffff', 1);
const T2 = id('ffffffff', 2);
const T3 = id('ffffffff', 3);

function ws(h: Harness, workspaceID: string = W1): WorkspaceState {
    return workspaceByID(h.state(), workspaceID) as WorkspaceState;
}

function newTab(tabID: string, paneID: string, extra: Partial<Extract<DomainAction, { type: 'create-tab' }>> = {}): DomainAction {
    return {
        type: 'create-tab',
        workspaceID: W1,
        tabID,
        create: { type: 'create-pane', workspaceID: W1, paneID, now: NOW },
        ...extra
    };
}

function split(paneID: string, sourcePaneID: string, focus?: boolean): DomainAction {
    return {
        type: 'split-pane',
        workspaceID: W1,
        paneID,
        sourcePaneID,
        direction: 'horizontal',
        now: NOW,
        ...(focus === undefined ? {} : { focus })
    };
}

/** W1 with P0 in the first tab and P1 alone in a second tab T1, which is on screen. */
function twoTabs(): Harness {
    const h = harness(seededState());
    h.dispatch(newTab(T1, P1));
    return h;
}

describe('a workspace and its first tab', () => {
    it('starts with one tab, on screen, named after its focused pane', () => {
        const workspace = workspaceByID(seededState(), W1) as WorkspaceState;
        expect(workspace.tabs).toEqual([{ id: W1, name: null, stash: null, seen: true }]);
        expect(workspace.activeTabID).toBe(W1);
        expect(onScreenPaneIDs(workspace)).toEqual([P0]);
    });
});

describe('create-tab', () => {
    it('opens a tab after the one on screen, shows it, and roots its pane there', () => {
        const h = twoTabs();
        const workspace = ws(h);
        expect(workspaceTabs(workspace).map((tab) => tab.id)).toEqual([W1, T1]);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toEqual(leaf(P1));
        expect(workspace.focusedPaneID).toBe(P1);
        // The first tab keeps its own tree and focus in the background.
        expect(workspace.tabs[0]?.stash?.layout).toEqual(leaf(P0));
        expect(workspace.tabs[0]?.stash?.focusedPaneID).toBe(P0);
        // Both panes stay in the workspace's lane.
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0, P1]);
        expect(workspacePaneOrder(workspace)).toEqual([P0, P1]);
    });

    it('in the background leaves the screen alone and the tab unvisited', () => {
        const h = harness(seededState());
        const before = ws(h);
        h.dispatch(newTab(T1, P1, { focus: false }));
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(W1);
        expect(workspace.layout).toBe(before.layout);
        expect(workspace.focusedPaneID).toBe(P0);
        const tab = workspace.tabs[1];
        expect(tab).toMatchObject({ id: T1, seen: false });
        expect(tab?.stash?.layout).toEqual(leaf(P1));
        // Showing it is the visit.
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: T1 });
        expect(ws(h).tabs[1]?.seen).toBe(true);
    });

    it('goes where asked, and at the end of the bar past it', () => {
        const h = twoTabs();
        h.dispatch(newTab(T2, P2, { index: 0 }), newTab(T3, P3, { index: 99 }));
        expect(ws(h).tabs.map((tab) => tab.id)).toEqual([T2, W1, T1, T3]);
    });

    it('leaves no empty tab behind when its create makes nothing', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T1,
            // A split of a pane that does not exist creates nothing.
            create: split(P1, id('99999999', 9))
        });
        expect(h.state()).toBe(before);
    });

    it('opens a content pane alone in the new tab, whatever source or --here pane it names', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T1,
            focus: false,
            create: { type: 'open-markdown-pane', workspaceID: W1, paneID: P1, filePath: '/a.md', sourcePaneID: P0, now: NOW }
        });
        h.dispatch({
            type: 'create-tab',
            workspaceID: W1,
            tabID: T2,
            focus: false,
            create: { type: 'open-web-pane', workspaceID: W1, paneID: P2, tabID: P3, url: 'https://example.com', reusePaneID: P0, now: NOW }
        });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1, T2, T1]);
        expect(workspace.layout).toEqual(leaf(P0));
        // Nothing was parked: P0 is still where it was, on screen.
        expect(workspace.parkedPanes).toEqual([]);
        expect(workspace.tabs[2]?.stash?.layout).toEqual(leaf(P1));
        expect(workspace.tabs[1]?.stash?.layout).toEqual(leaf(P2));
    });
});

describe('switching tabs', () => {
    it('swaps each tab tree, focus and zoom in and out of its stash', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true), { type: 'toggle-zoom', workspaceID: W1 });
        expect(ws(h).zoomedPaneID).toBe(P2);
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: W1 });
        let workspace = ws(h);
        expect(workspace.layout).toEqual(leaf(P0));
        expect(workspace.zoomedPaneID).toBeNull();
        expect(workspace.tabs[1]?.stash?.zoomedPaneID).toBe(P2);
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: T1 });
        workspace = ws(h);
        expect(workspace.zoomedPaneID).toBe(P2);
        expect(workspace.layout).toEqual(leaf(P2));
        expect(allPaneIDs(workspace.savedLayout ?? workspace.layout)).toEqual([P1, P2]);
    });

    it('closes a find bar whose pane the new tab does not hold', () => {
        const h = twoTabs();
        h.dispatch({ type: 'toggle-search', workspaceID: W1 });
        expect(ws(h).searchingPaneID).toBe(P1);
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: W1 });
        expect(ws(h).searchingPaneID).toBeNull();
    });
});

describe('pane actions aimed at a background tab', () => {
    it('split there in the background, leaving the screen exactly as it was', () => {
        const h = twoTabs();
        const before = ws(h);
        h.dispatch(split(P2, P0, false));
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toBe(before.layout);
        expect(workspace.focusedPaneID).toBe(P1);
        expect(tabPaneIDs(workspace, workspace.tabs[0] as never)).toEqual([P0, P2]);
        expect(tabOfPane(workspace, P2)?.id).toBe(W1);
    });

    it('take the user there when they ask for focus', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P0, true));
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(W1);
        expect(workspace.focusedPaneID).toBe(P2);
        expect(onScreenPaneIDs(workspace)).toEqual([P0, P2]);
    });

    it('focusing a pane shows its tab, even when it is already that tab focus', () => {
        const h = twoTabs();
        h.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: P0 });
        expect(ws(h).activeTabID).toBe(W1);
        expect(ws(h).focusedPaneID).toBe(P0);
    });

    it('a close of a background tab last pane takes the tab and nothing else', () => {
        const h = twoTabs();
        const before = ws(h);
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P0 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([T1]);
        expect(workspace.layout).toBe(before.layout);
        expect(workspace.recentlyClosedPanes).toHaveLength(1);
    });

    it('a shell that exits in a background tab closes there', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P0, false), { type: 'pane-process-terminated', paneID: P0 });
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(T1);
        expect(tabPaneIDs(workspace, workspace.tabs[0] as never)).toEqual([P2]);
        expect(workspace.tabs[0]?.stash?.focusedPaneID).toBe(P2);
    });

    it('a background pane that changes only its own record leaves the tabs alone', () => {
        // An external-editor preview in the first tab: its editor exiting flips the pane record
        // and nothing in any tree, so the borrowed tab comes back exactly as it was.
        const h = harness(seededState());
        const M = id('eeeeeeee', 7);
        h.dispatch(
            { type: 'open-markdown-pane', workspaceID: W1, paneID: M, filePath: '/a.md', sourcePaneID: P0, now: NOW },
            { type: 'set-markdown-editing', workspaceID: W1, paneID: M, editing: true, externalEditorCommand: 'vim' },
            newTab(T1, P1)
        );
        const before = ws(h);
        const events = h.events.length;
        h.dispatch({ type: 'pane-process-terminated', paneID: M });
        const workspace = ws(h);
        expect(h.events.slice(events).map((event) => event.kind)).toEqual(['pane-upserted']);
        expect(workspace.tabs).toBe(before.tabs);
        expect(workspace.layout).toBe(before.layout);
        expect(workspace.panes.find((pane) => pane.id === M)).not.toBe(before.panes.find((pane) => pane.id === M));
    });

    it('a layout cycle from a pane lays out that pane tab', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P0, false), split(P3, P0, false));
        h.dispatch({ type: 'select-layout', workspaceID: W1, kind: 'even-vertical', paneID: P0 });
        const workspace = ws(h);
        expect(workspace.layout).toEqual(leaf(P1));
        expect(workspace.tabs[0]?.stash?.layout).toMatchObject({ kind: 'split', direction: 'vertical' });
        expect(workspace.tabs[0]?.stash?.currentLayoutIndex).toBe(1);
    });
});

describe('closing the tab on screen', () => {
    it('shows the tab to its right, else its left', () => {
        const h = twoTabs();
        h.dispatch(newTab(T2, P2));
        expect(ws(h).tabs.map((tab) => tab.id)).toEqual([W1, T1, T2]);
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: T1 });
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        expect(ws(h).activeTabID).toBe(T2);
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });
        expect(ws(h).activeTabID).toBe(W1);
        expect(ws(h).tabs.map((tab) => tab.id)).toEqual([W1]);
    });

    it('keeps the only tab when its last pane closes', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P0 });
        const workspace = ws(h);
        expect(workspace.tabs).toEqual([{ id: W1, name: null, stash: null, seen: true }]);
        expect(workspace.layout).toEqual({ kind: 'empty' });
    });
});

describe('close-tab and close-other-tabs', () => {
    it('close every pane in the tab, as single closes would', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true));
        h.dispatch({ type: 'close-tab', workspaceID: W1, tabID: T1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1]);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P0]);
        expect(workspace.recentlyClosedPanes).toHaveLength(2);
        expect(workspace.layout).toEqual(leaf(P0));
    });

    it('never close a workspace only tab', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({ type: 'close-tab', workspaceID: W1, tabID: W1 });
        expect(h.state()).toBe(before);
    });

    it('close-other-tabs leaves the named tab on screen', () => {
        const h = twoTabs();
        h.dispatch(newTab(T2, P2));
        h.dispatch({ type: 'close-other-tabs', workspaceID: W1, tabID: T1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([T1]);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.panes.map((pane) => pane.id)).toEqual([P1]);
    });
});

describe('moving panes between tabs', () => {
    it('move-pane-to-new-tab takes a pane out into a tab just after its own', () => {
        const h = harness(seededState());
        h.dispatch(split(P1, P0, true));
        h.dispatch({ type: 'move-pane-to-new-tab', workspaceID: W1, paneID: P1, tabID: T1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1, T1]);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toEqual(leaf(P1));
        expect(workspace.tabs[0]?.stash?.layout).toEqual(leaf(P0));
        expect(workspace.tabs[0]?.stash?.focusedPaneID).toBe(P0);
    });

    it('move-pane-to-new-tab on a pane alone in its tab moves the tab', () => {
        const h = twoTabs();
        h.dispatch(newTab(T2, P2));
        // P2 alone in T2, at index 2; the slot before W1 is index 0.
        h.dispatch({ type: 'move-pane-to-new-tab', workspaceID: W1, paneID: P2, tabID: T3, index: 0 });
        expect(ws(h).tabs.map((tab) => tab.id)).toEqual([T2, W1, T1]);
    });

    it('move-pane-to-tab docks the pane right of that tab focus and goes there', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true));
        h.dispatch({ type: 'move-pane-to-tab', workspaceID: W1, paneID: P2, tabID: W1 });
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(W1);
        expect(workspace.layout).toMatchObject({
            kind: 'split',
            direction: 'horizontal',
            first: { kind: 'leaf', paneID: P0 },
            second: { kind: 'leaf', paneID: P2 }
        });
        expect(workspace.focusedPaneID).toBe(P2);
        expect(workspace.tabs[1]?.stash?.layout).toEqual(leaf(P1));
    });

    it('a move-pane-adjacent across tabs docks beside the target, in its tab', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true));
        h.dispatch({ type: 'move-pane-adjacent', workspaceID: W1, paneID: P2, targetPaneID: P0, zone: 'top' });
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(W1);
        expect(workspace.layout).toMatchObject({
            kind: 'split',
            direction: 'vertical',
            first: { kind: 'leaf', paneID: P2 },
            second: { kind: 'leaf', paneID: P0 }
        });
    });

    it('moving a tab only pane out leaves no empty tab', () => {
        const h = twoTabs();
        h.dispatch({ type: 'move-pane-to-tab', workspaceID: W1, paneID: P1, tabID: W1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1]);
        expect(onScreenPaneIDs(workspace)).toEqual([P0, P1]);
    });
});

describe('split-tab-panes and merge-tab-into-previous', () => {
    it('gives every pane but the first a tab of its own, in layout order', () => {
        const h = harness(seededState());
        h.dispatch(split(P1, P0, true), split(P2, P1, true));
        h.dispatch({ type: 'split-tab-panes', workspaceID: W1, tabID: W1, newTabIDs: [T1, T2] });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1, T1, T2]);
        expect(workspace.activeTabID).toBe(W1);
        expect(workspace.layout).toEqual(leaf(P0));
        expect(workspace.tabs.slice(1).map((tab) => tab.stash?.layout)).toEqual([leaf(P1), leaf(P2)]);
    });

    it('merging the tab on screen keeps its find bar open on the pane that stays in view', () => {
        const h = harness(seededState());
        h.dispatch(newTab(T1, P1, { focus: false }), { type: 'select-tab', workspaceID: W1, tabID: T1 });
        h.dispatch({ type: 'toggle-search', workspaceID: W1 });
        expect(ws(h).searchingPaneID).toBe(P1);
        h.dispatch({ type: 'merge-tab-into-previous', workspaceID: W1, tabID: T1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1]);
        expect(workspace.focusedPaneID).toBe(P1);
        expect(workspace.searchingPaneID).toBe(P1);
        expect(workspace.tabs[0]?.seen).toBe(true);
    });

    it('merges a tab tree beside the previous tab, keeping the merged tab focus', () => {
        const h = twoTabs();
        h.dispatch({ type: 'merge-tab-into-previous', workspaceID: W1, tabID: T1 });
        const workspace = ws(h);
        expect(workspace.tabs.map((tab) => tab.id)).toEqual([W1]);
        expect(workspace.layout).toMatchObject({
            kind: 'split',
            direction: 'horizontal',
            first: { kind: 'leaf', paneID: P0 },
            second: { kind: 'leaf', paneID: P1 }
        });
        expect(workspace.focusedPaneID).toBe(P1);
    });

    it('the first tab has nothing to merge into', () => {
        const h = twoTabs();
        const before = h.state();
        h.dispatch({ type: 'merge-tab-into-previous', workspaceID: W1, tabID: W1 });
        expect(h.state()).toBe(before);
    });
});

describe('rename-tab and move-tab', () => {
    it('names a tab, trims, and clears with blank', () => {
        const h = twoTabs();
        h.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: T1, name: '  workers ' });
        expect(ws(h).tabs[1]?.name).toBe('workers');
        h.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: T1, name: '   ' });
        expect(ws(h).tabs[1]?.name).toBeNull();
    });

    it('reorders, clamping the index', () => {
        const h = twoTabs();
        h.dispatch({ type: 'move-tab', workspaceID: W1, tabID: W1, toIndex: 5 });
        expect(ws(h).tabs.map((tab) => tab.id)).toEqual([T1, W1]);
    });
});

describe('move-tab-to-workspace', () => {
    function twoWorkspaces(): Harness {
        const h = twoTabs();
        h.dispatch({ type: 'create-workspace', id: W2, paneID: P3, name: 'other', color: 'red', now: NOW, focus: false });
        return h;
    }

    it('moves the panes with their tab, and shows it there', () => {
        const h = twoWorkspaces();
        h.dispatch({ type: 'move-tab-to-workspace', workspaceID: W1, tabID: T1, toWorkspaceID: W2 });
        const source = ws(h, W1);
        const target = ws(h, W2);
        expect(source.tabs.map((tab) => tab.id)).toEqual([W1]);
        expect(source.panes.map((pane) => pane.id)).toEqual([P0]);
        expect(source.layout).toEqual(leaf(P0));
        expect(target.tabs.map((tab) => tab.id)).toEqual([W2, T1]);
        expect(target.activeTabID).toBe(T1);
        expect(target.layout).toEqual(leaf(P1));
        expect(target.panes.map((pane) => pane.id)).toEqual([P3, P1]);
        expect(h.state().lastActiveWorkspaceID).toBe(W2);
    });

    it('moves a workspace only tab, leaving the empty tab it named', () => {
        const h = twoWorkspaces();
        h.dispatch({ type: 'move-tab-to-workspace', workspaceID: W2, tabID: W2, toWorkspaceID: W1, replacementTabID: T3 });
        const source = ws(h, W2);
        expect(source.tabs.map((tab) => tab.id)).toEqual([T3]);
        expect(source.layout).toEqual({ kind: 'empty' });
        expect(source.panes).toEqual([]);
        expect(ws(h, W1).tabs.map((tab) => tab.id)).toEqual([W1, T1, W2]);
    });

    it('refuses a only tab without a replacement', () => {
        const h = twoWorkspaces();
        const before = h.state();
        h.dispatch({ type: 'move-tab-to-workspace', workspaceID: W2, tabID: W2, toWorkspaceID: W1 });
        expect(h.state()).toBe(before);
    });

    it('takes the --here sources its panes park, and their web sidecars, along', () => {
        const h = twoWorkspaces();
        // T1's P1 is replaced in place by a web pane, then that by a preview: both park.
        const web = id('eeeeeeee', 9);
        h.dispatch(
            { type: 'open-web-pane', workspaceID: W1, paneID: P2, tabID: web, url: 'https://example.com', reusePaneID: P1, now: NOW },
            { type: 'open-markdown-pane', workspaceID: W1, paneID: id('eeeeeeee', 10), filePath: '/a.md', reusePaneID: P2, now: NOW }
        );
        expect(ws(h).parkedPanes.map((pane) => pane.id).sort()).toEqual([P1, P2].sort());
        h.dispatch({ type: 'move-tab-to-workspace', workspaceID: W1, tabID: T1, toWorkspaceID: W2 });
        // The chain moves whole: closing the preview brings P2 back, and closing P2 then P1.
        expect(ws(h, W1).parkedPanes).toEqual([]);
        expect(ws(h, W2).parkedPanes.map((pane) => pane.id).sort()).toEqual([P1, P2].sort());
        expect(ws(h, W2).webPanes[P2]?.tabs[0]?.url).toBe('https://example.com');
        expect(ws(h, W1).webPanes[P2]).toBeUndefined();
        h.dispatch({ type: 'close-pane', workspaceID: W2, paneID: id('eeeeeeee', 10) }, { type: 'close-pane', workspaceID: W2, paneID: P2 });
        expect(ws(h, W2).parkedPanes).toEqual([]);
        expect(ws(h, W2).layout).toEqual(leaf(P1));
    });
});

describe('normalizeTabs repairs an active tab that still has a stash', () => {
    /** W1 with P0 on screen in tab W1 and P1 in background tab T1, then the given corruption. */
    function corrupted(edit: (workspace: WorkspaceState) => WorkspaceState): WorkspaceState {
        return normalizeTabs(edit(ws(twoTabs())));
    }

    it('shows the tab that owns the live tree, keeping the other tab tree', () => {
        // T1 on screen (stash null) but the active id names W1, whose stash holds P0.
        const workspace = corrupted((current) => ({ ...current, activeTabID: W1 }));
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toEqual(leaf(P1));
        expect(workspace.tabs[0]?.stash?.layout).toEqual(leaf(P0));
    });

    it('with no owner, puts the active tab tree on screen beside what only the live tree held', () => {
        const P9 = id('eeeeeeee', 99);
        const workspace = corrupted((current) => ({
            ...current,
            panes: [...current.panes, { ...(current.panes[0] as Pane), id: P9 }],
            // Every tab has a stash; the live tree holds P9, which no tab does.
            tabs: current.tabs.map((tab) => (tab.id === T1 ? { ...tab, stash: { layout: leaf(P1), focusedPaneID: P1, focusHistory: [], zoomedPaneID: null, savedLayout: null, currentLayoutIndex: null } } : tab)),
            layout: leaf(P9),
            focusedPaneID: P9
        }));
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.tabs.find((tab) => tab.id === T1)?.stash).toBeNull();
        expect(allPaneIDs(workspace.layout).sort()).toEqual([P1, P9].sort());
        expect(workspace.focusedPaneID).toBe(P1);
        expect(workspace.tabs[0]?.stash?.layout).toEqual(leaf(P0));
    });
});

describe('sync input', () => {
    it('reaches only the shells in the tab on screen', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true), { type: 'set-sync-input-active', workspaceID: W1, active: true });
        expect(syncedPaneIDs(ws(h)).sort()).toEqual([P1, P2].sort());
        h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: W1 });
        // One shell on screen: nothing to sync.
        expect(syncedPaneIDs(ws(h))).toEqual([]);
    });
});

describe('duplicate-tab', () => {
    const WT1 = id('99999999', 1);
    const WT2 = id('99999999', 2);

    /** W1's only tab, named "build": shell P0 (labelled, 16 pt) beside web pane P1, at 0.3. */
    function source(): Harness {
        const h = harness(seededState());
        h.dispatch({ type: 'set-pane-label', workspaceID: W1, paneID: P0, label: 'main' });
        h.dispatch({ type: 'set-terminal-font-size', workspaceID: W1, paneID: P0, size: 16 });
        h.dispatch({ type: 'open-web-pane', workspaceID: W1, paneID: P1, tabID: WT1, url: 'https://example.com/a', now: NOW, sourcePaneID: P0 });
        h.dispatch({ type: 'update-split-ratio', workspaceID: W1, splitPath: 'd', ratio: 0.3 });
        h.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'build' });
        return h;
    }

    function duplicate(extra: Partial<Extract<DomainAction, { type: 'duplicate-tab' }>> = {}): DomainAction {
        return {
            type: 'duplicate-tab',
            workspaceID: W1,
            tabID: W1,
            newTabID: T1,
            paneIDs: { [P0]: P2, [P1]: P3 },
            webTabIDs: { [P1]: WT2 },
            now: NOW,
            ...extra
        };
    }

    it('opens a copy just after the tab, with its name, tree, ratios and focus, and shows it', () => {
        const h = source();
        const sourceFocus = ws(h).focusedPaneID;
        h.dispatch(duplicate({ workingDirectories: { [P0]: '/Users/test/live' } }));
        const workspace = ws(h);
        expect(workspaceTabs(workspace).map((tab) => [tab.id, tab.name])).toEqual([
            [W1, 'build'],
            [T1, 'build']
        ]);
        expect(workspace.activeTabID).toBe(T1);
        expect(workspace.layout).toMatchObject({ kind: 'split', ratio: 0.3 });
        expect(allPaneIDs(workspace.layout)).toEqual([P2, P3]);
        expect(workspace.focusedPaneID).toBe(sourceFocus === P0 ? P2 : P3);
        // The source tab keeps its own panes, untouched.
        expect(tabPaneIDs(workspace, workspaceTabs(workspace)[0] as WorkspaceTab)).toEqual([P0, P1]);
    });

    it('makes each copy fresh: a shell where its source really is, at its size, with no label or agent', () => {
        const h = source();
        h.dispatch(duplicate({ workingDirectories: { [P0]: '/Users/test/live' } }));
        const copy = ws(h).panes.find((pane) => pane.id === P2) as Pane;
        expect(copy).toMatchObject({ type: 'shell', workingDirectory: '/Users/test/live', terminalFontSize: 16, label: null, agentSessionID: null });
        expect(ws(h).panes.find((pane) => pane.id === P0)?.label).toBe('main');
    });

    it('opens a web pane\'s copy on the same page in a browser of its own', () => {
        const h = source();
        h.dispatch(duplicate());
        expect(ws(h).panes.find((pane) => pane.id === P3)?.type).toBe('web');
        expect(ws(h).webPanes[P3]).toEqual({
            tabs: [{ id: WT2, url: ws(h).webPanes[P1]?.tabs[0]?.url, title: '' }],
            activeTabID: WT2,
            isPrivate: false
        });
    });

    it('copies a scratchpad\'s text and wrap, and a document\'s file', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: P1, now: NOW });
        h.dispatch({ type: 'scratchpad-content-changed', workspaceID: W1, paneID: P1, content: 'notes' });
        h.dispatch({ type: 'set-scratchpad-wrap', workspaceID: W1, paneID: P1, on: true });
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: P2, filePath: '/Users/test/README.md', now: NOW, sourcePaneID: P1 });
        h.dispatch(duplicate({ paneIDs: { [P0]: P3, [P1]: id('eeeeeeee', 4), [P2]: id('eeeeeeee', 5) }, webTabIDs: {} }));
        const panes = ws(h).panes;
        expect(panes.find((pane) => pane.id === id('eeeeeeee', 4))).toMatchObject({ type: 'scratchpad', scratchpadContent: 'notes', scratchpadWrap: true });
        expect(panes.find((pane) => pane.id === id('eeeeeeee', 5))).toMatchObject({ type: 'markdown', filePath: '/Users/test/README.md' });
    });

    it('copies the un-zoomed tree of a zoomed tab, and the copy is not zoomed', () => {
        const h = source();
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        expect(ws(h).zoomedPaneID).not.toBeNull();
        h.dispatch(duplicate());
        expect(allPaneIDs(ws(h).layout)).toEqual([P2, P3]);
        expect(ws(h).zoomedPaneID).toBeNull();
    });

    it('opens the copy in the background, unvisited, with focus: false', () => {
        const h = source();
        h.dispatch(duplicate({ focus: false }));
        const workspace = ws(h);
        expect(workspace.activeTabID).toBe(W1);
        expect(onScreenPaneIDs(workspace)).toEqual([P0, P1]);
        const copy = workspace.tabs.find((tab) => tab.id === T1);
        expect(copy?.seen).toBe(false);
        expect(allPaneIDs(copy?.stash?.layout ?? { kind: 'empty' })).toEqual([P2, P3]);
    });

    it('makes a terminal of a pane it cannot make again', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'set-pane-label', workspaceID: W1, paneID: P0, label: null });
        const state = h.state();
        const gone: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({
                ...workspace,
                panes: workspace.panes.map((pane) => ({ ...pane, type: 'plugin' as const, unavailable: { type: 'plugin', pluginJSON: null } }))
            }))
        };
        const g = harness(gone);
        g.dispatch(duplicate({ paneIDs: { [P0]: P2 }, webTabIDs: {} }));
        expect(ws(g).panes.find((pane) => pane.id === P2)).toMatchObject({ type: 'shell', workingDirectory: ws(g).panes[0]?.workingDirectory });
        expect(ws(g).panes.find((pane) => pane.id === P2)?.unavailable).toBeUndefined();
    });

    it('keeps what a document, diff or plugin view is called, and leaves only a shell\'s label behind', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'set-pane-label', workspaceID: W1, paneID: P0, label: 'worker-1' });
        h.dispatch({
            type: 'create-plugin-pane',
            workspaceID: W1,
            paneID: P1,
            title: 'Plan',
            plugin: { pluginID: 'acme.plan', viewID: 'plan', stateVersion: 1, state: {} },
            sourcePaneID: P0,
            now: NOW
        });
        h.dispatch({ type: 'open-diff-pane', workspaceID: W1, paneID: P2, repoPath: '/code/kelpi', targetPath: '/code/kelpi/src', sourcePaneID: P0, now: NOW });
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: P3, filePath: '/Users/test/README.md', now: NOW, sourcePaneID: P0 });
        const [C0, C1, C2, C3] = [4, 5, 6, 7].map((n) => id('cccccccc', n)) as [string, string, string, string];
        h.dispatch(duplicate({ paneIDs: { [P0]: C0, [P1]: C1, [P2]: C2, [P3]: C3 }, webTabIDs: {} }));
        const workspace = ws(h);
        const pane = (paneID: string): Pane => workspace.panes.find((candidate) => candidate.id === paneID) as Pane;
        expect(pane(C0).label).toBeNull();
        for (const [source, copy] of [[P1, C1], [P2, C2], [P3, C3]] as const) {
            expect(pane(copy)).toMatchObject({ label: pane(source).label, title: pane(source).title });
            expect(paneTabTitle(workspace, pane(copy))).toBe(paneTabTitle(workspace, pane(source)));
        }
        expect(paneTabTitle(workspace, pane(C1))).toBe('Plan');
        expect(paneTabTitle(workspace, pane(C2))).toBe('src');
    });

    it('leaves the copy of a shell kept out of sync input out of it too', () => {
        const h = harness(seededState());
        const P4 = id('cccccccc', 4);
        const P5 = id('cccccccc', 5);
        h.dispatch(split(P1, P0, true));
        h.dispatch(split(P4, P1, true));
        h.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        h.dispatch({ type: 'set-sync-input-excluded', workspaceID: W1, paneID: P1, excluded: true });
        let mirror: DaemonState = h.state();
        const before = h.batches.length;
        h.dispatch(duplicate({ paneIDs: { [P0]: P2, [P1]: P3, [P4]: P5 }, webTabIDs: {} }));
        for (const batch of h.batches.slice(before)) mirror = applyDomainEvents(mirror, batch);
        expect(mirror.workspaces).toEqual(h.state().workspaces);
        expect(ws(h).syncInputExcluded).toEqual([P1, P3]);
        expect(syncedPaneIDs(ws(h)).sort()).toEqual([P2, P5].sort());
    });

    it('copies what a zoomed tab shows: a pane opened beside the zoomed one comes along, placed beside it', () => {
        const h = harness(seededState());
        h.dispatch(split(P1, P0, true));
        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
        const zoomed = ws(h).zoomedPaneID as string;
        // A document opened beside a zoomed pane lands only in the zoomed tree (§7.4's QUIRK).
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: P2, filePath: '/Users/test/README.md', now: NOW, sourcePaneID: zoomed });
        expect(allPaneIDs(ws(h).savedLayout ?? leaf(P0))).not.toContain(P2);
        const copies: Record<string, string> = { [P0]: id('cccccccc', 4), [P1]: id('cccccccc', 5), [P2]: id('cccccccc', 6) };
        h.dispatch(duplicate({ paneIDs: copies, webTabIDs: {} }));
        const tree = ws(h).layout;
        expect(allPaneIDs(tree).sort()).toEqual(Object.values(copies).sort());
        // The document's copy sits right beside the zoomed pane's copy, as it does on screen.
        const ids = allPaneIDs(tree);
        expect(ids.indexOf(copies[P2] as string)).toBe(ids.indexOf(copies[zoomed] as string) + 1);
    });

    it('leaves out a leaf with no pane behind it rather than refusing the whole copy', () => {
        const h = harness(seededState());
        h.dispatch(split(P1, P0, true));
        const state = h.state();
        const stale: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace) => ({
                ...workspace,
                zoomedPaneID: P0,
                savedLayout: workspace.layout,
                layout: leaf(P0),
                panes: workspace.panes.filter((pane) => pane.id !== P1)
            }))
        };
        const g = harness(stale);
        g.dispatch(duplicate({ paneIDs: { [P0]: P2 }, webTabIDs: {} }));
        expect(workspaceTabs(ws(g))).toHaveLength(2);
        expect(allPaneIDs(ws(g).layout)).toEqual([P2]);
    });

    it('refuses a new id another workspace already uses', () => {
        const h = source();
        h.dispatch({ type: 'create-workspace', id: W2, paneID: id('cccccccc', 9), name: 'ops', color: 'red', now: NOW });
        const before = h.state();
        h.dispatch(duplicate({ paneIDs: { [P0]: id('cccccccc', 9), [P1]: P3 } }));
        h.dispatch(duplicate({ newTabID: W2 }));
        expect(h.state()).toBe(before);
    });

    it('makes nothing without an id for every pane, with an id already taken, or for an unknown tab', () => {
        const h = source();
        const before = h.state();
        h.dispatch(duplicate({ paneIDs: { [P0]: P2 } }));
        h.dispatch(duplicate({ paneIDs: { [P0]: P2, [P1]: P0 } }));
        h.dispatch(duplicate({ tabID: T3 }));
        h.dispatch(duplicate({ newTabID: W1 }));
        expect(h.state()).toBe(before);
    });
});

describe('a mirror replaying the events', () => {
    it('converges through a duplicated tab, shown and in the background', () => {
        const h = harness(seededState());
        let mirror: DaemonState = h.state();
        const steps: DomainAction[] = [
            { type: 'open-web-pane', workspaceID: W1, paneID: P1, tabID: id('99999999', 1), url: 'https://example.com', now: NOW, sourcePaneID: P0 },
            { type: 'duplicate-tab', workspaceID: W1, tabID: W1, newTabID: T1, paneIDs: { [P0]: P2, [P1]: P3 }, webTabIDs: { [P1]: id('99999999', 2) }, now: NOW },
            {
                type: 'duplicate-tab',
                workspaceID: W1,
                tabID: T1,
                newTabID: T2,
                paneIDs: { [P2]: id('eeeeeeee', 4), [P3]: id('eeeeeeee', 5) },
                webTabIDs: { [P3]: id('99999999', 3) },
                now: NOW,
                focus: false
            }
        ];
        for (const step of steps) {
            const before = h.batches.length;
            h.dispatch(step);
            for (const batch of h.batches.slice(before)) mirror = applyDomainEvents(mirror, batch);
            expect(mirror.workspaces).toEqual(h.state().workspaces);
        }
        expect(workspaceTabs(ws(h)).map((tab) => tab.id)).toEqual([W1, T1, T2]);
    });

    it('converges through every tab operation', () => {
        const h = harness(seededState());
        let mirror: DaemonState = h.state();
        const steps: DomainAction[] = [
            newTab(T1, P1),
            split(P2, P0, false),
            { type: 'select-tab', workspaceID: W1, tabID: W1 },
            { type: 'move-pane-to-new-tab', workspaceID: W1, paneID: P2, tabID: T2 },
            { type: 'rename-tab', workspaceID: W1, tabID: T2, name: 'two' },
            { type: 'merge-tab-into-previous', workspaceID: W1, tabID: T2 },
            { type: 'close-tab', workspaceID: W1, tabID: T1 }
        ];
        for (const step of steps) {
            const before = h.batches.length;
            h.dispatch(step);
            for (const batch of h.batches.slice(before)) mirror = applyDomainEvents(mirror, batch);
            expect(mirror.workspaces).toEqual(h.state().workspaces);
        }
    });
});

describe('persisting tabs', () => {
    it('round-trips every tab, its name, tree, focus and visit', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P0, false), { type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'main' });
        h.dispatch(newTab(T2, P3, { focus: false }));
        const restored = workspaceByID(fromSnapshot(toSnapshot(h.state()), { homeDirectory: HOME }), W1) as WorkspaceState;
        const live = ws(h);
        expect(restored.activeTabID).toBe(live.activeTabID);
        expect(restored.layout).toEqual(live.layout);
        expect(restored.tabs.map((tab) => [tab.id, tab.name, tab.seen])).toEqual([
            [W1, 'main', true],
            [T1, null, true],
            [T2, null, false]
        ]);
        expect(restored.tabs[0]?.stash?.layout).toEqual(live.tabs[0]?.stash?.layout);
        expect(restored.tabs[0]?.stash?.focusedPaneID).toBe(P0);
    });

    it('saves a zoomed tab as its un-zoomed tree', () => {
        const h = twoTabs();
        h.dispatch(split(P2, P1, true), { type: 'toggle-zoom', workspaceID: W1 });
        const snapshot = toSnapshot(h.state());
        const saved = snapshot.workspaces[0]?.tabs?.find((tab) => tab.id === T1);
        expect(allPaneIDs(saved?.layout ?? { kind: 'empty' })).toEqual([P1, P2]);
    });

    it('reads a workspace saved without tabs as one tab', () => {
        const snapshot = toSnapshot(seededState());
        const record = snapshot.workspaces[0];
        const legacy = { ...snapshot, workspaces: [{ ...record, tabs: undefined, activeTabID: undefined } as never] };
        const restored = workspaceByID(fromSnapshot(legacy, { homeDirectory: HOME }), W1) as WorkspaceState;
        expect(restored.tabs).toEqual([{ id: W1, name: null, stash: null, seen: true }]);
        expect(restored.layout).toEqual(leaf(P0));
    });

    it('recovers a pane no tree holds into a tab of its own, unvisited', () => {
        // What an older daemon leaves behind: it keeps every pane but only the tree on screen.
        const h = twoTabs();
        const snapshot = toSnapshot(h.state());
        const record = snapshot.workspaces[0];
        const legacy = { ...snapshot, workspaces: [{ ...record, tabs: undefined, activeTabID: undefined } as never] };
        const restored = workspaceByID(fromSnapshot(legacy, { homeDirectory: HOME }), W1) as WorkspaceState;
        expect(restored.tabs).toHaveLength(2);
        expect(restored.layout).toEqual(leaf(P1));
        expect(restored.tabs[1]?.seen).toBe(false);
        expect(restored.tabs[1]?.stash?.layout).toEqual(leaf(P0));
        expect(activeTab(restored).id).toBe(W1);
    });

    it('gives a pane claimed by two tabs to the first, and drops panes the workspace lost', () => {
        const h = twoTabs();
        const snapshot = toSnapshot(h.state());
        const record = snapshot.workspaces[0] as NonNullable<(typeof snapshot.workspaces)[number]>;
        const tabs = (record.tabs ?? []).map((tab) =>
            tab.id === W1 ? { ...tab, layout: { kind: 'split' as const, direction: 'horizontal' as const, ratio: 0.5, first: leaf(P0), second: leaf(P1) } } : tab
        );
        const ghost = { ...tabs[0], id: T3, layout: leaf(id('99999999', 9)) } as (typeof tabs)[number];
        const corrupt = { ...snapshot, workspaces: [{ ...record, tabs: [...tabs, ghost] }] };
        const restored = workspaceByID(fromSnapshot(corrupt, { homeDirectory: HOME }), W1) as WorkspaceState;
        // T1 is on screen and claims P1 first; W1 keeps P0; the ghost tab is gone.
        expect(restored.tabs.map((tab) => tab.id)).toEqual([W1, T1]);
        expect(restored.tabs[0]?.stash?.layout).toEqual(leaf(P0));
        expect(restored.layout).toEqual(leaf(P1));
    });
});
