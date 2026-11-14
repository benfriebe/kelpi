/**
 * Workspace tabs: the reads and the tab-level edits every tab reducer is built from.
 *
 * Spec: docs/workspace-feature.md §12.
 *
 * The model in one paragraph: a workspace holds every pane in its `panes` lane, whichever tab
 * shows it, and an ordered list of tabs that partition those panes between layout trees. The
 * tab on screen (`activeTabID`) has no tree of its own; its tree is the workspace's `layout`,
 * with the focus, zoom and layout-cycle fields beside it, which is what every pane and layout
 * reducer has always read and written. A background tab keeps that same tuple in its `stash`.
 * Showing a tab swaps the two. So a reducer that knows nothing about tabs edits the tab on
 * screen, and `reducers/tabs.ts` runs it against a background tab by showing that tab first.
 *
 * Pure, and free of Node imports: the client replays the store and reads these helpers too.
 */

import { allPaneIDs, containsPane, removing, replacing, split, type PaneLayout } from '@kelpi/core/layout';
import { initialTab, type TabLayoutStash, type WorkspaceState, type WorkspaceTab } from './types.js';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The workspace's tabs. A mirror of a daemon older than tabs has none, and is shown as the
 * single tab it effectively has.
 */
export function workspaceTabs(workspace: WorkspaceState): readonly WorkspaceTab[] {
    const tabs = (workspace as { readonly tabs?: readonly WorkspaceTab[] }).tabs;
    return tabs !== undefined && tabs.length > 0 ? tabs : [initialTab(workspace.id)];
}

export function activeTabIDOf(workspace: WorkspaceState): string {
    const tabs = workspaceTabs(workspace);
    const id = (workspace as { readonly activeTabID?: string }).activeTabID;
    return id !== undefined && tabs.some((tab) => tab.id === id) ? id : (tabs[0] as WorkspaceTab).id;
}

export function activeTab(workspace: WorkspaceState): WorkspaceTab {
    const id = activeTabIDOf(workspace);
    return workspaceTabs(workspace).find((tab) => tab.id === id) as WorkspaceTab;
}

export function tabByID(workspace: WorkspaceState, tabID: string): WorkspaceTab | null {
    return workspaceTabs(workspace).find((tab) => tab.id === tabID) ?? null;
}

export function tabIndex(workspace: WorkspaceState, tabID: string): number {
    return workspaceTabs(workspace).findIndex((tab) => tab.id === tabID);
}

export function isActiveTab(workspace: WorkspaceState, tab: WorkspaceTab): boolean {
    return tab.id === activeTabIDOf(workspace);
}

/** The on-screen tab's tuple, read off the workspace. */
export function liveTabLayout(workspace: WorkspaceState): TabLayoutStash {
    return {
        layout: workspace.layout,
        focusedPaneID: workspace.focusedPaneID,
        focusHistory: workspace.focusHistory,
        zoomedPaneID: workspace.zoomedPaneID,
        savedLayout: workspace.savedLayout,
        currentLayoutIndex: workspace.currentLayoutIndex
    };
}

/** A tab's tuple, wherever it lives (the workspace's own for the tab on screen). */
export function tabLayout(workspace: WorkspaceState, tab: WorkspaceTab): TabLayoutStash {
    return tab.stash === null || isActiveTab(workspace, tab) ? liveTabLayout(workspace) : tab.stash;
}

/** The tab's UN-ZOOMED tree: what decides which panes it holds. */
export function tabTree(workspace: WorkspaceState, tab: WorkspaceTab): PaneLayout {
    const tuple = tabLayout(workspace, tab);
    return tuple.savedLayout ?? tuple.layout;
}

/** The tab's panes, in layout order. */
export function tabPaneIDs(workspace: WorkspaceState, tab: WorkspaceTab): string[] {
    return allPaneIDs(tabTree(workspace, tab));
}

/**
 * The tree a copy of `tab` takes (Duplicate Tab, workspace-feature.md §12.5): the un-zoomed tree,
 * with the panes a zoomed tab shows that are not in it (a document opened beside a zoomed pane
 * lands only in the zoomed tree) placed where they are on screen, beside the zoomed pane, and
 * without a leaf that has no pane behind it. So the copy holds what the user can see, and older
 * leftovers never make the whole copy fail.
 */
export function duplicableTree(workspace: WorkspaceState, tab: WorkspaceTab): PaneLayout {
    const tuple = tabLayout(workspace, tab);
    let tree = tuple.savedLayout ?? tuple.layout;
    if (tuple.savedLayout !== null) {
        const saved = tuple.savedLayout;
        const extras = allPaneIDs(tuple.layout).filter((paneID) => !containsPane(saved, paneID));
        if (extras.length > 0) {
            // What is on screen, less the panes the saved tree already places.
            let shown = tuple.layout;
            for (const paneID of allPaneIDs(tuple.layout)) {
                if (paneID !== tuple.zoomedPaneID && containsPane(saved, paneID)) shown = removing(shown, paneID);
            }
            const zoomed = tuple.zoomedPaneID;
            if (zoomed !== null && containsPane(saved, zoomed) && containsPane(shown, zoomed)) tree = replacing(saved, zoomed, shown);
            else if (saved.kind === 'empty') tree = shown;
            else tree = split('horizontal', 0.5, saved, shown);
        }
    }
    const live = new Set(workspace.panes.map((pane) => pane.id));
    for (const paneID of allPaneIDs(tree)) {
        if (!live.has(paneID)) tree = removing(tree, paneID);
    }
    return tree;
}

/** The tab whose tree holds `paneID`, or null (a parked pane, an orphan, another workspace's). */
export function tabOfPane(workspace: WorkspaceState, paneID: string): WorkspaceTab | null {
    for (const tab of workspaceTabs(workspace)) {
        if (containsPane(tabTree(workspace, tab), paneID)) return tab;
    }
    return null;
}

/** Is `paneID` in the tab on screen? */
export function isPaneOnScreen(workspace: WorkspaceState, paneID: string): boolean {
    return containsPane(workspace.savedLayout ?? workspace.layout, paneID);
}

/** The on-screen tab's panes, in layout order. */
export function onScreenPaneIDs(workspace: WorkspaceState): string[] {
    return allPaneIDs(workspace.savedLayout ?? workspace.layout);
}

/** Every tab's panes, tab by tab, each in layout order: the order `pane list` reports. */
export function workspacePaneOrder(workspace: WorkspaceState): string[] {
    return workspaceTabs(workspace).flatMap((tab) => tabPaneIDs(workspace, tab));
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

function emptyStash(): TabLayoutStash {
    return {
        layout: { kind: 'empty' },
        focusedPaneID: null,
        focusHistory: [],
        zoomedPaneID: null,
        savedLayout: null,
        currentLayoutIndex: null
    };
}

function withLiveTuple(workspace: WorkspaceState, tuple: TabLayoutStash): WorkspaceState {
    return {
        ...workspace,
        layout: tuple.layout,
        focusedPaneID: tuple.focusedPaneID,
        focusHistory: tuple.focusHistory,
        zoomedPaneID: tuple.zoomedPaneID,
        savedLayout: tuple.savedLayout,
        currentLayoutIndex: tuple.currentLayoutIndex
    };
}

export interface ShowTabOptions {
    /** False keeps the tab's `seen` as it was: a reducer borrowing the screen, not a visit. */
    readonly visit?: boolean | undefined;
}

/**
 * Put `tabID` on screen: the outgoing tab's tuple goes into its stash and the incoming tab's
 * comes out of it. On a visit, a find bar in a pane the new tab does not hold closes (§7.14
 * lives on the workspace, not per tab). Unknown ids and the tab already on screen change
 * nothing (bar a first visit).
 */
export function showTab(workspace: WorkspaceState, tabID: string, options: ShowTabOptions = {}): WorkspaceState {
    const visit = options.visit !== false;
    const tabs = workspaceTabs(workspace);
    const target = tabs.find((tab) => tab.id === tabID);
    if (target === undefined) return workspace;
    const currentID = activeTabIDOf(workspace);
    if (target.id === currentID) {
        if (!visit || target.seen) return workspace;
        return { ...workspace, tabs: tabs.map((tab) => (tab.id === tabID ? { ...tab, seen: true } : tab)) };
    }
    const outgoing = liveTabLayout(workspace);
    const incoming = target.stash ?? emptyStash();
    const nextTabs = tabs.map((tab) => {
        if (tab.id === currentID) return { ...tab, stash: outgoing };
        if (tab.id === tabID) return { ...tab, stash: null, seen: visit ? true : tab.seen };
        return tab;
    });
    let next = withLiveTuple({ ...workspace, tabs: nextTabs, activeTabID: tabID }, incoming);
    // Only a visit closes the bar: a reducer borrowing the screen puts the old tab straight back.
    const searching = next.searchingPaneID;
    if (visit && searching !== null && !containsPane(incoming.savedLayout ?? incoming.layout, searching)) {
        next = { ...next, searchingPaneID: null, searchNeedle: '', searchTotal: null, searchSelected: null };
    }
    return next;
}

function sameTuple(a: TabLayoutStash, b: TabLayoutStash): boolean {
    return (
        a.layout === b.layout &&
        a.focusedPaneID === b.focusedPaneID &&
        a.focusHistory === b.focusHistory &&
        a.zoomedPaneID === b.zoomedPaneID &&
        a.savedLayout === b.savedLayout &&
        a.currentLayoutIndex === b.currentLayoutIndex
    );
}

/**
 * The second half of borrowing a background tab: `before` is the workspace as it was, `shown`
 * the same with the borrowed tab on screen, `updated` what a reducer made of `shown`. Puts
 * back whichever tab was on screen (when it still exists). A reducer that changed only pane
 * records, leaving the borrowed tab's tuple and the tab list exactly as they were, gets the
 * workspace's own tabs back too, so the swap there and back is no tab change at all (and no
 * `layout-changed` for a pane that merely exited in a background tab).
 */
export function putBackTab(before: WorkspaceState, shown: WorkspaceState, updated: WorkspaceState): WorkspaceState {
    const originalID = activeTabIDOf(before);
    const borrowedID = activeTabIDOf(shown);
    const stash = tabByID(before, borrowedID)?.stash ?? null;
    if (
        stash !== null &&
        updated.tabs === shown.tabs &&
        activeTabIDOf(updated) === borrowedID &&
        sameTuple(liveTabLayout(updated), stash)
    ) {
        return withLiveTuple({ ...updated, tabs: before.tabs, activeTabID: before.activeTabID }, liveTabLayout(before));
    }
    if (tabByID(updated, originalID) === null) return updated;
    return showTab(updated, originalID, { visit: false });
}

/**
 * Run `update` with `tabID` on screen, then put back whichever tab was on screen before
 * (when it still exists). The borrowed tab's `seen` is untouched: this is a reducer working
 * on a background tab, not the user looking at it.
 */
export function inTab(
    workspace: WorkspaceState,
    tabID: string,
    update: (workspace: WorkspaceState) => WorkspaceState
): WorkspaceState {
    const originalID = activeTabIDOf(workspace);
    if (tabID === originalID) return update(workspace);
    const shown = showTab(workspace, tabID, { visit: false });
    if (activeTabIDOf(shown) !== tabID) return workspace;
    const updated = update(shown);
    if (updated === shown) return workspace;
    return putBackTab(workspace, shown, updated);
}

/** Insert a background `tab` (it carries its stash) at `index` (clamped; absent = the end). */
export function insertTab(
    workspace: WorkspaceState,
    tab: WorkspaceTab,
    index?: number | undefined
): WorkspaceState {
    const tabs = [...workspaceTabs(workspace)];
    const at = index === undefined ? tabs.length : Math.max(0, Math.min(Math.trunc(index), tabs.length));
    tabs.splice(at, 0, tab);
    return { ...workspace, tabs };
}

/** Drop a BACKGROUND tab's entry (its panes stay in the lane; callers move or close them). */
export function removeBackgroundTab(workspace: WorkspaceState, tabID: string): WorkspaceState {
    if (tabID === activeTabIDOf(workspace)) return workspace;
    const tabs = workspaceTabs(workspace).filter((tab) => tab.id !== tabID);
    return tabs.length === workspaceTabs(workspace).length ? workspace : { ...workspace, tabs };
}

/** Rewrite one tab's entry. */
export function updateTab(
    workspace: WorkspaceState,
    tabID: string,
    update: (tab: WorkspaceTab) => WorkspaceTab
): WorkspaceState {
    let changed = false;
    const tabs = workspaceTabs(workspace).map((tab) => {
        if (tab.id !== tabID) return tab;
        const next = update(tab);
        if (next !== tab) changed = true;
        return next;
    });
    return changed ? { ...workspace, tabs } : workspace;
}

export function backgroundStash(layout: PaneLayout, focusedPaneID: string | null): TabLayoutStash {
    return { ...emptyStash(), layout, focusedPaneID };
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** A background tuple without the panes the workspace no longer has. */
function prunedStash(stash: TabLayoutStash, live: ReadonlySet<string>): TabLayoutStash {
    const tree = stash.savedLayout ?? stash.layout;
    const missing = allPaneIDs(tree).filter((id) => !live.has(id));
    if (missing.length === 0) return stash;
    let pruned = tree;
    for (const id of missing) pruned = removing(pruned, id);
    const ids = allPaneIDs(pruned);
    const focusedPaneID =
        stash.focusedPaneID !== null && ids.includes(stash.focusedPaneID) ? stash.focusedPaneID : (ids[0] ?? null);
    // A zoom on a pane that is gone ends; any other zoom is replaced by the plain tree, which
    // is what a structural change does to a zoom on screen too (§5.1).
    return {
        layout: pruned,
        focusedPaneID,
        focusHistory: stash.focusHistory.filter((id) => ids.includes(id)),
        zoomedPaneID: null,
        savedLayout: null,
        currentLayoutIndex: null
    };
}

/**
 * §12's invariants, restored after every dispatch:
 *
 * - there is at least one tab, and exactly the `activeTabID` tab has no stash;
 * - a background tab holds only panes the workspace still has;
 * - a background tab with no panes left is gone;
 * - an EMPTY tab on screen gives way to its right-hand neighbour (else its left), unless it is
 *   the only tab: an empty workspace still has its one tab, as it has always had its empty
 *   layout.
 *
 * Returns the workspace itself when nothing needed repair, so an untouched workspace emits no
 * events.
 */
export function normalizeTabs(workspace: WorkspaceState): WorkspaceState {
    const raw = (workspace as { readonly tabs?: readonly WorkspaceTab[] }).tabs;
    if (raw !== undefined && raw.length === 1) {
        const only = raw[0] as WorkspaceTab;
        if (only.stash === null && only.id === workspace.activeTabID) return workspace;
    }

    let tabs = [...workspaceTabs(workspace)];
    // The tab on screen is the one without a stash, since the live tuple is its tuple: an
    // active id naming no tab, or a tab that still has a stash, defers to that one.
    const requested = (workspace as { readonly activeTabID?: string }).activeTabID;
    const named = tabs.find((tab) => tab.id === requested);
    const activeID =
        named !== undefined && named.stash === null
            ? named.id
            : (tabs.find((tab) => tab.stash === null) ?? named ?? (tabs[0] as WorkspaceTab)).id;
    const live = new Set(workspace.panes.map((pane) => pane.id));
    let changed = raw === undefined || raw.length === 0 || activeID !== workspace.activeTabID;

    // No tab owns the live tuple (every tab has a stash): the active tab's own tree comes on
    // screen, and whatever the live tree held that no tab does joins it beside, so no pane is
    // left in no tree.
    let base = workspace;
    const adopting = tabs.find((tab) => tab.id === activeID) as WorkspaceTab;
    if (adopting.stash !== null) {
        const held = new Set(tabs.flatMap((tab) => (tab.stash === null ? [] : allPaneIDs(tab.stash.savedLayout ?? tab.stash.layout))));
        let stray = workspace.savedLayout ?? workspace.layout;
        for (const id of allPaneIDs(stray)) if (held.has(id)) stray = removing(stray, id);
        const own = adopting.stash.savedLayout ?? adopting.stash.layout;
        base = withLiveTuple(
            workspace,
            allPaneIDs(stray).length === 0
                ? adopting.stash
                : {
                      layout: own.kind === 'empty' ? stray : split('horizontal', 0.5, own, stray),
                      focusedPaneID: adopting.stash.focusedPaneID ?? allPaneIDs(stray)[0] ?? null,
                      focusHistory: adopting.stash.focusHistory,
                      zoomedPaneID: null,
                      savedLayout: null,
                      currentLayoutIndex: null
                  }
        );
        tabs = tabs.map((tab) => (tab.id === activeID ? { ...tab, stash: null } : tab));
        changed = true;
    }

    tabs = tabs.map((tab) => {
        if (tab.id === activeID) return tab;
        const stash = tab.stash ?? emptyStash();
        const pruned = prunedStash(stash, live);
        if (pruned === tab.stash) return tab;
        changed = true;
        return { ...tab, stash: pruned };
    });

    const kept = tabs.filter((tab) => tab.id === activeID || allPaneIDs((tab.stash as TabLayoutStash).layout).length > 0);
    if (kept.length !== tabs.length) changed = true;
    tabs = kept;

    let next: WorkspaceState = changed ? { ...base, tabs, activeTabID: activeID } : workspace;

    const liveEmpty = allPaneIDs(next.savedLayout ?? next.layout).length === 0;
    if (liveEmpty && tabs.length > 1) {
        const index = tabs.findIndex((tab) => tab.id === activeID);
        const neighbour = (tabs[index + 1] ?? tabs[index - 1]) as WorkspaceTab;
        next = showTab(next, neighbour.id);
        next = { ...next, tabs: workspaceTabs(next).filter((tab) => tab.id !== activeID) };
    }
    return next;
}
