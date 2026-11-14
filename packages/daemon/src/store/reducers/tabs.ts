/**
 * Workspace tab reducers, the routing that lets every pane reducer work inside a background
 * tab, and the invariant pass run after every dispatch.
 *
 * Spec: docs/workspace-feature.md §12.
 *
 * Routing: a pane action names a pane (a split's source, the pane to close, the pane to
 * focus…). When that pane lives in a background tab, the action runs with that tab borrowed
 * onto the screen, and the tab that was on screen comes back afterwards. An agent splitting
 * its own pane in a background tab therefore splits it THERE, without moving the user. Only an
 * action that asks for focus (a focus change, or a create/move without `focus: false`) leaves
 * the borrowed tab on screen: that is the user, or an agent with `--focus`, going to the pane.
 */

import { allPaneIDs, containsPane, leaf, movingPane, removing, split, splitting, type Pane, type PaneLayout } from '@kelpi/core/layout';
import { workspaceByID, workspaceContainingPane, workspaceContainingVisiblePane } from '../derived.js';
import {
    activeTabIDOf,
    backgroundStash,
    inTab,
    insertTab,
    isActiveTab,
    normalizeTabs,
    onScreenPaneIDs,
    putBackTab,
    removeBackgroundTab,
    showTab,
    tabByID,
    tabIndex,
    tabLayout,
    tabOfPane,
    tabTree,
    updateTab,
    workspaceTabs
} from '../tabs.js';
import type { DaemonState, DomainAction, DropZone, WebPaneState, WorkspaceState, WorkspaceTab } from '../types.js';
import {
    clearSearchIfTargets,
    findVisiblePane,
    focusCreatedPane,
    movingCargo,
    newPane,
    popFocusFromHistory,
    restoreZoomIfNeeded,
    scrubFocusHistory,
    setFocus,
    updateWorkspace
} from './helpers.js';
import { closePaneInWorkspace } from './panes.js';

export type TabAction = Extract<
    DomainAction,
    {
        type:
            | 'create-tab'
            | 'select-tab'
            | 'rename-tab'
            | 'move-tab'
            | 'move-pane-to-new-tab'
            | 'move-pane-to-tab'
            | 'split-tab-panes'
            | 'merge-tab-into-previous'
            | 'move-tab-to-workspace'
            | 'close-tab'
            | 'close-other-tabs'
            | 'duplicate-tab';
    }
>;

/** The non-routing family reducer (`reducers/index.ts`), passed in to avoid an import cycle. */
export type FamilyReducer = (state: DaemonState, action: DomainAction) => DaemonState;

// ---------------------------------------------------------------------------
// Pane placement within the tab on screen
// ---------------------------------------------------------------------------

/** Take a pane out of the tree on screen; its record stays in the lane for the next tab. */
function detachFromScreen(workspace: WorkspaceState, paneID: string): WorkspaceState {
    let next = clearSearchIfTargets(workspace, paneID);
    next = restoreZoomIfNeeded(next);
    next = { ...next, layout: removing(next.layout, paneID), currentLayoutIndex: null };
    next = scrubFocusHistory(next, paneID);
    if (next.focusedPaneID === paneID) {
        const popped = popFocusFromHistory(next, paneID);
        next = {
            ...next,
            focusHistory: popped.history,
            focusedPaneID: popped.candidate ?? allPaneIDs(next.layout)[0] ?? null
        };
    }
    return next;
}

/**
 * Put a pane (already in the lane) into the tree on screen: beside `targetPaneID` on `zone`
 * when both are given and the target is there, else to the right of the focused pane, else
 * as the root of an empty tree.
 */
function attachToScreen(
    workspace: WorkspaceState,
    paneID: string,
    targetPaneID: string | undefined,
    zone: DropZone | undefined,
    focus: boolean | undefined
): WorkspaceState {
    const unzoomed = restoreZoomIfNeeded(workspace);
    const tree = unzoomed.layout;
    const named = targetPaneID !== undefined && containsPane(tree, targetPaneID) ? targetPaneID : null;
    const focused =
        unzoomed.focusedPaneID !== null && containsPane(tree, unzoomed.focusedPaneID) ? unzoomed.focusedPaneID : null;
    const anchor = named ?? focused ?? allPaneIDs(tree)[0] ?? null;
    const layout =
        anchor === null
            ? leaf(paneID)
            : named !== null && zone !== undefined
              ? movingPane(tree, paneID, named, zone)
              : splitting(tree, anchor, 'horizontal', paneID).layout;
    return focusCreatedPane({ ...unzoomed, layout, currentLayoutIndex: null }, paneID, focus);
}

/** Close everything in the tree on screen, the panes a `--here` close un-parks included. */
function closeEverythingOnScreen(workspace: WorkspaceState): WorkspaceState {
    let next = workspace;
    // Bounded: each pass closes at least one pane, and an un-park only ever swaps one in.
    for (let pass = 0; pass < 64; pass++) {
        const ids = onScreenPaneIDs(next);
        if (ids.length === 0) break;
        for (const id of ids) next = closePaneInWorkspace(next, id);
    }
    return next;
}

// ---------------------------------------------------------------------------
// The tab reducers
// ---------------------------------------------------------------------------

function newTab(id: string, name: string | null, seen: boolean, stash: WorkspaceTab['stash']): WorkspaceTab {
    return { id, name, stash, seen };
}

function createTab(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'create-tab' }>,
    reduceFamily: FamilyReducer
): DaemonState {
    const workspace = workspaceByID(state, action.workspaceID);
    if (workspace === null || tabByID(workspace, action.tabID) !== null) return state;
    const originalID = activeTabIDOf(workspace);
    const index = action.index ?? tabIndex(workspace, originalID) + 1;
    const visit = action.focus !== false;
    const tab = newTab(action.tabID, normalizedName(action.name), visit, backgroundStash({ kind: 'empty' }, null));
    let next = updateWorkspace(state, workspace.id, (current) =>
        showTab(insertTab(current, tab, index), tab.id, { visit })
    );
    next = reduceFamily(next, opensAlone(action.create));
    const after = workspaceByID(next, workspace.id);
    // A create that made nothing (a bad source, a duplicate id) leaves no empty tab behind.
    if (after === null || activeTabIDOf(after) !== tab.id || onScreenPaneIDs(after).length === 0) return state;
    if (!visit) next = updateWorkspace(next, workspace.id, (current) => showTab(current, originalID, { visit: false }));
    return next;
}

/**
 * A content pane opened into a new tab is that tab's only pane. The new tab's tree is empty,
 * so a `sourcePaneID` to split beside, or a `reusePaneID` to take the place of (`--here`),
 * names a pane in some other tab and would make nothing here; both are dropped. A split keeps
 * its source, since splitting one is all it means, and so makes nothing in a new tab.
 */
function opensAlone(create: DomainAction): DomainAction {
    switch (create.type) {
        case 'open-markdown-pane':
        case 'open-diff-pane':
        case 'open-web-pane': {
            const { sourcePaneID: _source, reusePaneID: _reuse, ...rest } = create;
            return rest;
        }
        case 'create-plugin-pane': {
            const { sourcePaneID: _source, ...rest } = create;
            return rest;
        }
        default:
            return create;
    }
}

function normalizedName(name: string | null | undefined): string | null {
    if (name === undefined || name === null) return null;
    const trimmed = name.trim();
    return trimmed === '' ? null : trimmed;
}

function moveTab(workspace: WorkspaceState, tabID: string, toIndex: number): WorkspaceState {
    const tabs = [...workspaceTabs(workspace)];
    const from = tabs.findIndex((tab) => tab.id === tabID);
    if (from < 0) return workspace;
    const [tab] = tabs.splice(from, 1) as [WorkspaceTab];
    const at = Number.isFinite(toIndex) ? Math.max(0, Math.min(Math.trunc(toIndex), tabs.length)) : tabs.length;
    if (at === from) return workspace;
    tabs.splice(at, 0, tab);
    return { ...workspace, tabs };
}

function movePaneToNewTab(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'move-pane-to-new-tab' }>
): WorkspaceState {
    const source = tabOfPane(workspace, action.paneID);
    if (source === null || tabByID(workspace, action.tabID) !== null) return workspace;
    const sourceIndex = tabIndex(workspace, source.id);
    const index = action.index ?? sourceIndex + 1;
    const focus = action.focus !== false;
    if (allPaneIDs(tabTree(workspace, source)).length <= 1) {
        // Already alone: the gesture means "put this tab there". `index` counts the tab itself,
        // as a drop slot does, so a slot past the tab lands one earlier once it has moved.
        const moved = moveTab(workspace, source.id, index > sourceIndex ? index - 1 : index);
        return focus ? showTab(moved, source.id) : moved;
    }
    let next = inTab(workspace, source.id, (current) => detachFromScreen(current, action.paneID));
    next = insertTab(next, newTab(action.tabID, null, focus, backgroundStash(leaf(action.paneID), action.paneID)), index);
    return focus ? showTab(next, action.tabID) : next;
}

function movePaneToTab(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'move-pane-to-tab' }>
): WorkspaceState {
    const from = tabOfPane(workspace, action.paneID);
    const to = tabByID(workspace, action.tabID);
    if (from === null || to === null || from.id === to.id) return workspace;
    const originalID = activeTabIDOf(workspace);
    let next = inTab(workspace, from.id, (current) => detachFromScreen(current, action.paneID));
    next = inTab(next, to.id, (current) =>
        attachToScreen(current, action.paneID, action.targetPaneID, action.zone, action.focus)
    );
    if (action.focus !== false) return showTab(next, to.id);
    return tabByID(next, originalID) === null ? next : showTab(next, originalID, { visit: false });
}

function splitTabPanes(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'split-tab-panes' }>
): WorkspaceState {
    const tab = tabByID(workspace, action.tabID);
    if (tab === null) return workspace;
    const ids = allPaneIDs(tabTree(workspace, tab));
    let next = workspace;
    let at = tabIndex(workspace, tab.id) + 1;
    ids.slice(1).forEach((paneID, i) => {
        const id = action.newTabIDs[i];
        if (id === undefined || tabByID(next, id) !== null) return;
        next = inTab(next, tab.id, (current) => detachFromScreen(current, paneID));
        next = insertTab(next, newTab(id, null, true, backgroundStash(leaf(paneID), paneID)), at);
        at += 1;
    });
    return next;
}

function mergeTabIntoPrevious(workspace: WorkspaceState, tabID: string): WorkspaceState {
    const index = tabIndex(workspace, tabID);
    if (index <= 0) return workspace;
    const tabs = workspaceTabs(workspace);
    const previous = tabs[index - 1] as WorkspaceTab;
    const merging = tabs[index] as WorkspaceTab;
    const mergingTree = tabTree(workspace, merging);
    const mergingFocus = tabLayout(workspace, merging).focusedPaneID;
    const wasOnScreen = isActiveTab(workspace, merging);
    // The merged-away tab must be in the background before its entry can go. Not a visit: the
    // user stays with the panes they were looking at, find bar and all, now one tab along.
    let next = wasOnScreen
        ? updateTab(showTab(workspace, previous.id, { visit: false }), previous.id, (tab) => (tab.seen ? tab : { ...tab, seen: true }))
        : workspace;
    next = removeBackgroundTab(next, merging.id);
    return inTab(next, previous.id, (current) => {
        const unzoomed = restoreZoomIfNeeded(current);
        const layout =
            unzoomed.layout.kind === 'empty' ? mergingTree : split('horizontal', 0.5, unzoomed.layout, mergingTree);
        const merged: WorkspaceState = { ...unzoomed, layout, currentLayoutIndex: null };
        // The user was looking at the merged tab: keep their pane focused in its new home.
        return wasOnScreen && mergingFocus !== null ? setFocus(merged, mergingFocus) : merged;
    });
}

function moveTabToWorkspace(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'move-tab-to-workspace' }>
): DaemonState {
    const source = workspaceByID(state, action.workspaceID);
    const target = workspaceByID(state, action.toWorkspaceID);
    if (source === null || target === null || source.id === target.id) return state;
    const tab = tabByID(source, action.tabID);
    if (tab === null || tabByID(target, tab.id) !== null) return state;

    // Put another tab on screen first, so the moving tab's tuple is in its stash.
    let from = source;
    if (isActiveTab(from, tab)) {
        const tabs = workspaceTabs(from);
        if (tabs.length === 1) {
            const replacement = action.replacementTabID;
            if (replacement === undefined || replacement === tab.id) return state;
            from = insertTab(from, newTab(replacement, null, true, backgroundStash({ kind: 'empty' }, null)), 1);
            from = showTab(from, replacement);
        } else {
            const index = tabIndex(from, tab.id);
            from = showTab(from, ((tabs[index + 1] ?? tabs[index - 1]) as WorkspaceTab).id);
        }
    }
    const moving = tabByID(from, tab.id) as WorkspaceTab;
    const stash = moving.stash ?? backgroundStash({ kind: 'empty' }, null);
    const movingIDs = new Set(allPaneIDs(stash.savedLayout ?? stash.layout));
    const panes = from.panes.filter((pane) => movingIDs.has(pane.id));
    // A `--here` pane's parked source goes with it, or closing the pane in its new workspace
    // could never un-park it, and its PTY would be stranded where nothing can reach it.
    const cargo = movingCargo(from, movingIDs);
    const keptSidecars = Object.fromEntries(Object.entries(from.webPanes).filter(([paneID]) => !cargo.ids.has(paneID)));

    let nextSource: WorkspaceState = {
        ...removeBackgroundTab(from, moving.id),
        panes: from.panes.filter((pane) => !movingIDs.has(pane.id)),
        parkedPanes: from.parkedPanes.filter((pane) => !cargo.ids.has(pane.id)),
        webPanes: keptSidecars,
        syncInputExcluded: from.syncInputExcluded.filter((id) => !movingIDs.has(id))
    };
    nextSource = scrubFocusHistory(nextSource, ...movingIDs);
    if (nextSource.searchingPaneID !== null && movingIDs.has(nextSource.searchingPaneID)) {
        nextSource = clearSearchIfTargets(nextSource, nextSource.searchingPaneID);
    }

    const visit = action.focus !== false;
    let nextTarget: WorkspaceState = insertTab(
        {
            ...target,
            panes: [...target.panes, ...panes],
            parkedPanes: [...target.parkedPanes, ...cargo.parked],
            webPanes: { ...target.webPanes, ...cargo.sidecars }
        },
        { ...moving, stash, seen: visit ? true : moving.seen }
    );
    if (visit) nextTarget = showTab(nextTarget, moving.id);

    return {
        ...state,
        workspaces: state.workspaces.map((workspace) => {
            if (workspace.id === nextSource.id) return nextSource;
            if (workspace.id === nextTarget.id) return nextTarget;
            return workspace;
        }),
        lastActiveWorkspaceID: visit ? target.id : state.lastActiveWorkspaceID
    };
}

// ---------------------------------------------------------------------------
// Duplicate Tab
// ---------------------------------------------------------------------------

/** The same tree with every leaf renamed through `rename` (ratios and directions kept). */
function renamedLeaves(layout: PaneLayout, rename: ReadonlyMap<string, string>): PaneLayout {
    switch (layout.kind) {
        case 'leaf':
            return leaf(rename.get(layout.paneID) ?? layout.paneID);
        case 'split':
            return split(layout.direction, layout.ratio, renamedLeaves(layout.first, rename), renamedLeaves(layout.second, rename));
        case 'empty':
            return layout;
    }
}

/**
 * A fresh pane of `source`'s kind: the same directory, file, content, sizes and wrap, but no
 * label (labels address panes, so a copy must not answer to its source's), no agent session and
 * a status of its own. A shell starts where its source's shell really is when the caller found
 * out. A pane that cannot be made again (a plugin view whose plugin is gone) is a terminal in
 * the source's directory.
 */
function copiedPane(source: Pane, id: string, action: Extract<DomainAction, { type: 'duplicate-tab' }>): Pane {
    if (source.unavailable !== undefined || (source.type === 'plugin' && source.plugin === undefined)) {
        return newPane({ id, workingDirectory: source.workingDirectory, nowMillis: action.now });
    }
    const pane = newPane({
        id,
        workingDirectory:
            source.type === 'shell' ? (action.workingDirectories?.[source.id] ?? source.workingDirectory) : source.workingDirectory,
        nowMillis: action.now,
        type: source.type,
        // A web pane's title is its page's, and the copy opens the same page.
        title: source.type === 'web' ? source.title : null,
        filePath: source.filePath,
        scratchpadContent: source.scratchpadContent,
        csvHeaderRow: source.csvHeaderRow,
        terminalFontSize: source.terminalFontSize,
        scratchpadWrap: source.scratchpadWrap,
        isEditing: source.type === 'scratchpad'
    });
    return {
        ...pane,
        ...(source.plugin === undefined ? {} : { plugin: source.plugin }),
        markdownFontSize: source.markdownFontSize
    };
}

/** The copy's browser: its source's page in one web tab, private when the source is. */
function copiedWebPane(source: WebPaneState | undefined, webTabID: string): WebPaneState {
    const page = source?.tabs.find((tab) => tab.id === source.activeTabID) ?? source?.tabs[0];
    return {
        tabs: [{ id: webTabID, url: page?.url ?? '', title: page?.title ?? '' }],
        activeTabID: webTabID,
        isPrivate: source?.isPrivate ?? false
    };
}

function duplicateTab(workspace: WorkspaceState, action: Extract<DomainAction, { type: 'duplicate-tab' }>): WorkspaceState {
    const source = tabByID(workspace, action.tabID);
    if (source === null || tabByID(workspace, action.newTabID) !== null) return workspace;
    const tuple = tabLayout(workspace, source);
    const tree = tuple.savedLayout ?? tuple.layout;
    const ids = allPaneIDs(tree);
    if (ids.length === 0) return workspace;
    const taken = new Set([...workspace.panes, ...workspace.parkedPanes].map((pane) => pane.id));
    const rename = new Map<string, string>();
    const copies: Pane[] = [];
    let webPanes = workspace.webPanes;
    for (const id of ids) {
        const copyID = action.paneIDs[id];
        const pane = findVisiblePane(workspace, id);
        if (copyID === undefined || taken.has(copyID) || pane === null) return workspace;
        taken.add(copyID);
        rename.set(id, copyID);
        const copy = copiedPane(pane, copyID, action);
        copies.push(copy);
        if (copy.type === 'web') {
            const webTabID = action.webTabIDs[id];
            if (webTabID === undefined) return workspace;
            webPanes = { ...webPanes, [copyID]: copiedWebPane(workspace.webPanes[id], webTabID) };
        }
    }
    const focusSource = tuple.focusedPaneID !== null && rename.has(tuple.focusedPaneID) ? tuple.focusedPaneID : (ids[0] as string);
    const visit = action.focus !== false;
    const tab = newTab(
        action.newTabID,
        source.name,
        visit,
        backgroundStash(renamedLeaves(tree, rename), rename.get(focusSource) ?? null)
    );
    const next = insertTab({ ...workspace, panes: [...workspace.panes, ...copies], webPanes }, tab, tabIndex(workspace, source.id) + 1);
    return visit ? showTab(next, tab.id) : next;
}

function closeTab(workspace: WorkspaceState, tabID: string): WorkspaceState {
    if (workspaceTabs(workspace).length <= 1 || tabByID(workspace, tabID) === null) return workspace;
    return inTab(workspace, tabID, closeEverythingOnScreen);
}

function closeOtherTabs(workspace: WorkspaceState, tabID: string): WorkspaceState {
    if (tabByID(workspace, tabID) === null) return workspace;
    let next = showTab(workspace, tabID);
    for (const tab of workspaceTabs(next)) {
        if (tab.id === tabID) continue;
        next = inTab(next, tab.id, closeEverythingOnScreen);
    }
    return next;
}

export function reduceTabAction(state: DaemonState, action: TabAction, reduceFamily: FamilyReducer): DaemonState {
    switch (action.type) {
        case 'create-tab':
            return createTab(state, action, reduceFamily);
        case 'select-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) => showTab(workspace, action.tabID));
        case 'rename-tab': {
            const name = normalizedName(action.name);
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                updateTab(workspace, action.tabID, (tab) => (tab.name === name ? tab : { ...tab, name }))
            );
        }
        case 'move-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                moveTab(workspace, action.tabID, action.toIndex)
            );
        case 'move-pane-to-new-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) => movePaneToNewTab(workspace, action));
        case 'move-pane-to-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) => movePaneToTab(workspace, action));
        case 'split-tab-panes':
            return updateWorkspace(state, action.workspaceID, (workspace) => splitTabPanes(workspace, action));
        case 'merge-tab-into-previous':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                mergeTabIntoPrevious(workspace, action.tabID)
            );
        case 'move-tab-to-workspace':
            return moveTabToWorkspace(state, action);
        case 'close-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) => closeTab(workspace, action.tabID));
        case 'close-other-tabs':
            return updateWorkspace(state, action.workspaceID, (workspace) => closeOtherTabs(workspace, action.tabID));
        case 'duplicate-tab':
            return updateWorkspace(state, action.workspaceID, (workspace) => duplicateTab(workspace, action));
    }
}

// ---------------------------------------------------------------------------
// Routing pane actions into background tabs
// ---------------------------------------------------------------------------

interface RoutedPane {
    readonly workspaceID: string;
    readonly paneIDs: readonly string[];
    /** Leave the pane's tab on screen afterwards: the action takes the user there. */
    readonly follow: boolean;
}

function named(workspaceID: string, follow: boolean, ...ids: readonly (string | null | undefined)[]): RoutedPane | null {
    const paneIDs = ids.filter((id): id is string => typeof id === 'string');
    return paneIDs.length === 0 ? null : { workspaceID, paneIDs, follow };
}

function routedPane(state: DaemonState, action: DomainAction): RoutedPane | null {
    switch (action.type) {
        case 'split-pane':
        case 'split-pane-at-path':
            return named(action.workspaceID, action.focus !== false, action.sourcePaneID);
        case 'close-pane':
        case 'park-pane':
        case 'resize-pane':
            return named(action.workspaceID, false, action.paneID);
        case 'unpark-pane':
            return named(action.workspaceID, false, action.replacePaneID);
        case 'move-pane-direction':
            return named(action.workspaceID, false, action.paneID);
        case 'move-pane-adjacent':
            return named(action.workspaceID, action.focus !== false, action.paneID);
        case 'open-markdown-pane':
        case 'open-diff-pane':
        case 'open-web-pane':
            return named(action.workspaceID, action.focus !== false, action.reusePaneID, action.sourcePaneID);
        case 'create-plugin-pane':
            return named(action.workspaceID, action.focus !== false, action.sourcePaneID);
        case 'focus-pane':
            return named(action.workspaceID, true, action.paneID);
        case 'cycle-layout':
        case 'select-layout':
            return named(action.workspaceID, false, action.paneID);
        case 'pane-process-terminated': {
            const workspaceID = action.workspaceID ?? workspaceContainingPane(state, action.paneID)?.id;
            return workspaceID === undefined ? null : named(workspaceID, false, action.paneID);
        }
        case 'move-pane-to-workspace': {
            const source = workspaceContainingVisiblePane(state, action.paneID);
            return source === null ? null : named(source.id, false, action.paneID);
        }
        default:
            return null;
    }
}

/**
 * Run `action` in the tab that holds the pane it names (see the module comment). A
 * `move-pane-adjacent` across two tabs becomes a `move-pane-to-tab`.
 */
export function routeThroughTabs(state: DaemonState, action: DomainAction, reduceFamily: FamilyReducer): DaemonState {
    if (action.type === 'move-pane-adjacent') {
        const workspace = workspaceByID(state, action.workspaceID);
        const from = workspace === null ? null : tabOfPane(workspace, action.paneID);
        const to = workspace === null ? null : tabOfPane(workspace, action.targetPaneID);
        if (from !== null && to !== null && from.id !== to.id) {
            return reduceTabAction(
                state,
                {
                    type: 'move-pane-to-tab',
                    workspaceID: action.workspaceID,
                    paneID: action.paneID,
                    tabID: to.id,
                    targetPaneID: action.targetPaneID,
                    zone: action.zone,
                    ...(action.focus === undefined ? {} : { focus: action.focus })
                },
                reduceFamily
            );
        }
    }

    const routed = routedPane(state, action);
    if (routed === null) return reduceFamily(state, action);
    const workspace = workspaceByID(state, routed.workspaceID);
    if (workspace === null) return reduceFamily(state, action);
    let tab: WorkspaceTab | null = null;
    for (const paneID of routed.paneIDs) {
        tab = tabOfPane(workspace, paneID);
        if (tab !== null) break;
    }
    const originalID = activeTabIDOf(workspace);
    if (tab === null || tab.id === originalID) return reduceFamily(state, action);

    const shown = updateWorkspace(state, workspace.id, (current) => showTab(current, (tab as WorkspaceTab).id, { visit: routed.follow }));
    const reduced = reduceFamily(shown, action);
    // Focusing a pane that is already its tab's focus still takes the user to that tab.
    if (reduced === shown) return action.type === 'focus-pane' ? shown : state;
    if (routed.follow) return reduced;
    const shownWorkspace = workspaceByID(shown, workspace.id) as WorkspaceState;
    return updateWorkspace(reduced, workspace.id, (current) => putBackTab(workspace, shownWorkspace, current));
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

/** `normalizeTabs` on every workspace the dispatch touched (identity tells). */
export function normalizeTouchedWorkspaces(previous: DaemonState, next: DaemonState): DaemonState {
    if (previous === next) return next;
    const before = new Map(previous.workspaces.map((workspace) => [workspace.id, workspace]));
    let changed = false;
    const workspaces = next.workspaces.map((workspace) => {
        if (before.get(workspace.id) === workspace) return workspace;
        const normalized = normalizeTabs(workspace);
        if (normalized !== workspace) changed = true;
        return normalized;
    });
    return changed ? { ...next, workspaces } : next;
}
