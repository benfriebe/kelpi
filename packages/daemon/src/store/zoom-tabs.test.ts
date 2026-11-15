/**
 * Zoom and the tab partition (workspace-feature.md §12.4): every visible pane is in exactly one
 * tab's tree, and a tab's tree is its UN-ZOOMED one (`savedLayout ?? layout`). A zoomed tab's
 * zoomed tree must therefore never hold a pane its saved tree lacks: such a pane is drawn by
 * nothing, counted by nothing, left alive by Close Tab and dropped by the next un-zoom.
 *
 * Each case below zooms a tab (the one on screen, or one in the background that a routed action
 * reaches), runs one action that creates or moves a pane, then un-zooms, shows every tab and
 * opens one more, checking the partition after every step.
 */

import { allPaneIDs, type PaneLayout } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';

import { activeTabIDOf, onScreenPaneIDs, tabLayout, tabPaneIDs, tabTree, workspaceTabs } from './tabs.js';
import { harness, id, NOW, seededState, W1, W2, type Harness } from './testing.js';
import type { DaemonState, DomainAction, WorkspaceState } from './types.js';

const P0 = id('dddddddd', 100);
const P1 = id('eeeeeeee', 1);
const P2 = id('eeeeeeee', 2);
const P3 = id('eeeeeeee', 3);
const Q0 = id('dddddddd', 200);
const Q1 = id('eeeeeeee', 21);
const NEW = id('eeeeeeee', 9);
const NEW_WEB_TAB = id('cccccccc', 9);
const T1 = id('ffffffff', 1);
const T_NEXT = id('ffffffff', 8);
const T_LAST = id('ffffffff', 9);

function leaves(tree: PaneLayout | null): string[] {
    return tree === null ? [] : allPaneIDs(tree);
}

/** The partition, for every workspace in the state; the failure names the step. */
function expectPartition(state: DaemonState, step: string): void {
    for (const workspace of state.workspaces) {
        const visible = workspace.panes.map((pane) => pane.id).sort();
        const held = workspaceTabs(workspace).flatMap((tab) => tabPaneIDs(workspace, tab));
        expect({ step, workspace: workspace.name, held: [...held].sort() }).toEqual({ step, workspace: workspace.name, held: visible });
        for (const tab of workspaceTabs(workspace)) {
            const tuple = tabLayout(workspace, tab);
            if (tuple.savedLayout === null) continue;
            const kept = new Set(leaves(tuple.savedLayout));
            const stray = leaves(tuple.layout).filter((paneID) => !kept.has(paneID));
            expect({ step, tab: tab.id, stray }).toEqual({ step, tab: tab.id, stray: [] });
        }
        expect({ step, onScreen: onScreenPaneIDs(workspace) }).toEqual({
            step,
            onScreen: leaves(tabTree(workspace, workspaceTabs(workspace).find((tab) => tab.id === activeTabIDOf(workspace)) ?? workspaceTabs(workspace)[0]!))
        });
    }
}

function workspace(h: Harness, workspaceID = W1): WorkspaceState {
    const found = h.state().workspaces.find((candidate) => candidate.id === workspaceID);
    if (found === undefined) throw new Error(`no workspace ${workspaceID}`);
    return found;
}

/**
 * W1: tab 1 holds P0 | P1, tab T1 holds P2 | P3. W2 holds Q0 | Q1, zoomed on Q1. `zoomOnScreen`
 * zooms tab 1 (on P1) and leaves it on screen; otherwise T1 is zoomed (on P3) and tab 1 is shown.
 */
function zoomed(zoomOnScreen: boolean): Harness {
    const h = harness(seededState(W1, P0));
    const run = (...actions: DomainAction[]): void => {
        h.dispatch(...actions);
    };
    run(
        { type: 'create-workspace', id: W2, paneID: Q0, name: 'ops', color: 'green', now: NOW },
        { type: 'split-pane', workspaceID: W2, paneID: Q1, sourcePaneID: Q0, direction: 'horizontal', now: NOW },
        { type: 'toggle-zoom', workspaceID: W2 },
        { type: 'split-pane', workspaceID: W1, paneID: P1, sourcePaneID: P0, direction: 'horizontal', now: NOW },
        {
            type: 'create-tab',
            workspaceID: W1,
            tabID: T1,
            create: { type: 'create-pane', workspaceID: W1, paneID: P2, now: NOW, focus: true }
        },
        { type: 'split-pane', workspaceID: W1, paneID: P3, sourcePaneID: P2, direction: 'horizontal', now: NOW }
    );
    if (zoomOnScreen) {
        run({ type: 'select-tab', workspaceID: W1, tabID: W1 }, { type: 'focus-pane', workspaceID: W1, paneID: P1 }, { type: 'toggle-zoom', workspaceID: W1 });
        expect(workspace(h).zoomedPaneID).toBe(P1);
    } else {
        run({ type: 'focus-pane', workspaceID: W1, paneID: P3 }, { type: 'toggle-zoom', workspaceID: W1 }, { type: 'select-tab', workspaceID: W1, tabID: W1 });
        expect(workspaceTabs(workspace(h)).find((tab) => tab.id === T1)?.stash?.zoomedPaneID).toBe(P3);
    }
    expect(workspace(h, W2).zoomedPaneID).toBe(Q1);
    expectPartition(h.state(), 'setup');
    return h;
}

/** The zoomed tab's panes: the one that is zoomed, and the one it hides. */
function zoomedPanes(zoomOnScreen: boolean): { readonly zoomedID: string; readonly hiddenID: string; readonly tabID: string } {
    return zoomOnScreen ? { zoomedID: P1, hiddenID: P0, tabID: W1 } : { zoomedID: P3, hiddenID: P2, tabID: T1 };
}

const CASES: ReadonlyArray<{ readonly name: string; readonly action: (zoomedID: string, hiddenID: string, tabID: string) => readonly DomainAction[] }> = [
    { name: 'split-pane', action: (zoomedID) => [{ type: 'split-pane', workspaceID: W1, paneID: NEW, sourcePaneID: zoomedID, direction: 'horizontal', now: NOW, focus: false }] },
    { name: 'split-pane-at-path', action: (zoomedID) => [{ type: 'split-pane-at-path', workspaceID: W1, paneID: NEW, path: '/tmp', sourcePaneID: zoomedID, now: NOW, focus: false }] },
    { name: 'open-markdown-pane', action: (zoomedID) => [{ type: 'open-markdown-pane', workspaceID: W1, paneID: NEW, filePath: '/tmp/notes.md', sourcePaneID: zoomedID, now: NOW, focus: false }] },
    { name: 'open-markdown-pane (focused source)', action: () => [{ type: 'open-markdown-pane', workspaceID: W1, paneID: NEW, filePath: '/tmp/notes.md', now: NOW }] },
    { name: 'open-diff-pane', action: (zoomedID) => [{ type: 'open-diff-pane', workspaceID: W1, paneID: NEW, repoPath: '/tmp/repo', sourcePaneID: zoomedID, now: NOW, focus: false }] },
    { name: 'open-web-pane', action: (zoomedID) => [{ type: 'open-web-pane', workspaceID: W1, paneID: NEW, tabID: NEW_WEB_TAB, url: 'https://example.com', sourcePaneID: zoomedID, now: NOW, focus: false }] },
    {
        name: 'create-plugin-pane',
        action: (zoomedID) => [
            {
                type: 'create-plugin-pane',
                workspaceID: W1,
                paneID: NEW,
                title: 'Plan',
                plugin: { pluginID: 'example.plan', viewID: 'plan', stateVersion: 1, state: {} },
                sourcePaneID: zoomedID,
                now: NOW,
                focus: false
            }
        ]
    },
    { name: 'create-scratchpad', action: () => [{ type: 'create-scratchpad', workspaceID: W1, paneID: NEW, now: NOW }] },
    {
        name: 'close then reopen-closed-pane',
        action: (zoomedID, hiddenID) => [
            { type: 'close-pane', workspaceID: W1, paneID: hiddenID },
            { type: 'focus-pane', workspaceID: W1, paneID: zoomedID },
            { type: 'reopen-closed-pane', workspaceID: W1, paneID: NEW, now: NOW }
        ]
    },
    { name: 'move-pane-adjacent onto the hidden pane', action: (zoomedID, hiddenID) => [{ type: 'move-pane-adjacent', workspaceID: W1, paneID: zoomedID, targetPaneID: hiddenID, zone: 'left', focus: false }] },
    { name: 'move-pane-to-workspace into a zoomed workspace', action: (zoomedID) => [{ type: 'move-pane-to-workspace', paneID: zoomedID, toWorkspaceID: W2, focus: false }] },
    { name: 'move-pane-to-workspace out of the zoomed tab', action: (_zoomedID, hiddenID) => [{ type: 'move-pane-to-workspace', paneID: hiddenID, toWorkspaceID: W2, focus: false }] },
    { name: 'move-pane-to-new-tab', action: (_zoomedID, hiddenID) => [{ type: 'move-pane-to-new-tab', workspaceID: W1, paneID: hiddenID, tabID: T_NEXT, focus: false }] },
    { name: 'move-pane-to-tab into the zoomed tab', action: (_zoomedID, _hiddenID, tabID) => [{ type: 'move-pane-to-tab', workspaceID: W1, paneID: tabID === W1 ? P2 : P0, tabID, focus: false }] },
    {
        name: 'duplicate-tab of the zoomed tab',
        action: (zoomedID, hiddenID, tabID) => [
            {
                type: 'duplicate-tab',
                workspaceID: W1,
                tabID,
                newTabID: T_NEXT,
                paneIDs: { [hiddenID]: NEW, [zoomedID]: id('eeeeeeee', 10) },
                webTabIDs: {},
                now: NOW,
                focus: false
            }
        ]
    },
    { name: 'merge-tab-into-previous', action: () => [{ type: 'merge-tab-into-previous', workspaceID: W1, tabID: T1 }] },
    { name: 'close-pane of the zoomed pane', action: (zoomedID) => [{ type: 'close-pane', workspaceID: W1, paneID: zoomedID }] }
];

describe('zoom keeps the tab partition whole (§12.4)', () => {
    for (const zoomOnScreen of [true, false]) {
        for (const testCase of CASES) {
            it(`${testCase.name}, with the ${zoomOnScreen ? 'tab on screen' : 'background tab'} zoomed`, () => {
                const h = zoomed(zoomOnScreen);
                const { zoomedID, hiddenID, tabID } = zoomedPanes(zoomOnScreen);
                h.dispatch(...testCase.action(zoomedID, hiddenID, tabID));
                expectPartition(h.state(), testCase.name);
                // Un-zoom whatever is zoomed, tab by tab, then open one more tab.
                for (const tab of workspaceTabs(workspace(h))) {
                    h.dispatch({ type: 'select-tab', workspaceID: W1, tabID: tab.id });
                    expectPartition(h.state(), `${testCase.name}, then show ${tab.id}`);
                    if (workspace(h).zoomedPaneID !== null) {
                        h.dispatch({ type: 'toggle-zoom', workspaceID: W1 });
                        expectPartition(h.state(), `${testCase.name}, then un-zoom ${tab.id}`);
                    }
                }
                if (workspace(h, W2).zoomedPaneID !== null) h.dispatch({ type: 'toggle-zoom', workspaceID: W2 });
                h.dispatch({
                    type: 'create-tab',
                    workspaceID: W1,
                    tabID: T_LAST,
                    create: { type: 'create-pane', workspaceID: W1, paneID: id('eeeeeeee', 30), now: NOW, focus: true }
                });
                expectPartition(h.state(), `${testCase.name}, then a new tab`);
            });
        }
    }

    it('keeps a zoomed background tab whose zoomed tree is empty but whose saved tree is not', () => {
        const h = zoomed(false);
        const before = workspaceTabs(workspace(h)).map((tab) => tab.id);
        // Any dispatch normalizes; the zoomed background tab T1 must survive it.
        h.dispatch({ type: 'rename-tab', workspaceID: W1, tabID: W1, name: 'main' });
        expect(workspaceTabs(workspace(h)).map((tab) => tab.id)).toEqual(before);
    });
});
