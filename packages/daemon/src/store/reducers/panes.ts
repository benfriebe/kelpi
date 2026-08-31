/**
 * Pane reducers: creation, splitting, closing, parking, moving, resizing, and the content-pane
 * opening actions (records + layout only — rendering lands in M5).
 *
 * Spec: docs/current/workspace-feature.md §7.2–§7.9, §7.11; docs/current/pane-layout.md §12;
 * docs/current/socket-handlers.md §4.11 (pane-move-to-workspace).
 *
 * Swift quirks are preserved deliberately (PLAN.md lists no fixes for them) and flagged QUIRK:
 *  - `create-pane` replaces the whole layout unconditionally (only correct on an empty
 *    workspace; the caller contract routes populated workspaces to split instead).
 *  - `split-pane-at-path` does not verify the focused pane still exists (stale focus appends an
 *    orphan pane).
 *  - the markdown split branch does NOT un-zoom first.
 *  - `reopen-closed-pane` pops the snapshot BEFORE the focus guard, so it can be consumed and
 *    lost.
 *  - a reopened PRIVATE web pane gets no sidecar entry.
 *  - `move-pane-adjacent` onto itself leaves the layout alone but still refocuses and clears
 *    `currentLayoutIndex`.
 */

// POSIX-only path splitting, kept dependency-free: this module must stay importable in the
// browser (the client replays store reducers/events), so node:path is off limits.
const basename = (p: string): string => {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
};
const dirname = (p: string): string => {
    const trimmed = p.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    if (idx === -1) return '.';
    if (idx === 0) return '/';
    return trimmed.slice(0, idx);
};
import {
    allPaneIDs,
    leaf,
    movingPane,
    neighborPaneID,
    removing,
    replacing,
    resizePaneShare,
    splitting,
    swappingLeaves,
    updatingSplitRatio,
    type Pane
} from '@kelpi/core/layout';
import type { DaemonState, DomainAction, WebPaneState, WorkspaceState } from '../types.js';
import { MAX_RECENTLY_CLOSED_PANES } from '../types.js';
import {
    appendPane,
    clearSearchIfTargets,
    findParkedPane,
    findVisiblePane,
    mutateVisiblePane,
    newPane,
    popFocusFromHistory,
    removeVisiblePane,
    restoreZoomIfNeeded,
    scrubFocusHistory,
    setFocus,
    updateWorkspace
} from './helpers.js';
import { normalizeURLInput } from './url.js';

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function createPane(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'create-pane' }>
): DaemonState {
    return updateWorkspace(state, action.workspaceID, (workspace) => {
        const directory =
            action.workingDirectory !== undefined &&
            action.workingDirectory !== null &&
            action.workingDirectory !== ''
                ? action.workingDirectory
                : state.homeDirectory;
        const pane = newPane({
            id: action.paneID,
            workingDirectory: directory,
            nowMillis: action.now,
            label: action.label ?? null
        });
        // QUIRK: unconditional layout replacement (§7.2). No un-zoom, no layout-index reset.
        const next: WorkspaceState = {
            ...appendPane(workspace, pane),
            layout: leaf(pane.id)
        };
        return setFocus(next, pane.id);
    });
}

function splitPane(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'split-pane' }>
): DaemonState {
    return updateWorkspace(state, action.workspaceID, (workspace) => {
        const unzoomed = restoreZoomIfNeeded(workspace);
        const sourceID = action.sourcePaneID ?? unzoomed.focusedPaneID;
        if (sourceID === null || sourceID === undefined) return workspace;
        const source = findVisiblePane(unzoomed, sourceID);
        if (source === null) return workspace; // parked panes are not eligible
        const pane = newPane({
            id: action.paneID,
            workingDirectory: source.workingDirectory,
            nowMillis: action.now,
            label: action.label ?? null
        });
        const next: WorkspaceState = {
            ...appendPane(unzoomed, pane),
            layout: splitting(unzoomed.layout, sourceID, action.direction, pane.id).layout,
            currentLayoutIndex: null
        };
        return setFocus(next, pane.id);
    });
}

function splitPaneAtPath(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'split-pane-at-path' }>
): DaemonState {
    return updateWorkspace(state, action.workspaceID, (workspace) => {
        const unzoomed = restoreZoomIfNeeded(workspace);
        const sourceID = unzoomed.focusedPaneID;
        if (sourceID === null) return workspace;
        // QUIRK: the focused pane's existence is NOT verified (§7.2 warning).
        const pane = newPane({
            id: action.paneID,
            workingDirectory: action.path,
            nowMillis: action.now,
            label: action.label ?? null
        });
        const next: WorkspaceState = {
            ...appendPane(unzoomed, pane),
            layout: splitting(
                unzoomed.layout,
                sourceID,
                action.direction ?? 'horizontal',
                pane.id
            ).layout,
            currentLayoutIndex: null
        };
        return setFocus(next, pane.id);
    });
}

// ---------------------------------------------------------------------------
// Closing / parking
// ---------------------------------------------------------------------------

function snapshotForReopen(workspace: WorkspaceState, pane: Pane): WorkspaceState {
    const sidecar = workspace.webPanes[pane.id];
    const webState =
        pane.type === 'web' && sidecar !== undefined && !sidecar.isPrivate ? sidecar : null;
    const snapshots = [
        ...workspace.recentlyClosedPanes,
        {
            workingDirectory: pane.workingDirectory,
            label: pane.label,
            type: pane.type,
            filePath: pane.filePath,
            scratchpadContent: pane.scratchpadContent,
            agentSessionID: pane.agentSessionID,
            agentKind: pane.agentKind,
            agentProfileName: pane.agentProfileName,
            markdownFontSize: pane.markdownFontSize,
            webState
        }
    ];
    while (snapshots.length > MAX_RECENTLY_CLOSED_PANES) snapshots.shift();
    return { ...workspace, recentlyClosedPanes: snapshots };
}

function withoutWebSidecar(workspace: WorkspaceState, paneID: string): WorkspaceState {
    if (workspace.webPanes[paneID] === undefined) return workspace;
    const webPanes = { ...workspace.webPanes };
    delete webPanes[paneID];
    return { ...workspace, webPanes };
}

/** §7.7 `closePane`, both branches. Exported so `pane-process-terminated` can re-enter it. */
export function closePaneInWorkspace(workspace: WorkspaceState, paneID: string): WorkspaceState {
    let next = clearSearchIfTargets(workspace, paneID);
    next = restoreZoomIfNeeded(next);

    // A) UNPARK: this pane replaced a parked terminal (`kelpi open --here`).
    const closing = findVisiblePane(next, paneID);
    const parkedSourceID = closing?.parkedSourcePaneID ?? null;
    const parked = parkedSourceID === null ? null : findParkedPane(next, parkedSourceID);
    if (closing !== null && parked !== null) {
        next = {
            ...next,
            parkedPanes: next.parkedPanes.filter((pane) => pane.id !== parked.id),
            panes: [...next.panes.filter((pane) => pane.id !== paneID), parked],
            layout: replacing(next.layout, paneID, leaf(parked.id)),
            currentLayoutIndex: null
        };
        next = scrubFocusHistory(next, paneID, parked.id);
        // DIRECT assignment: the closing pane never enters its own history.
        return { ...next, focusedPaneID: parked.id };
    }

    // B) NORMAL close.
    const pane = findVisiblePane(next, paneID);
    if (pane !== null) next = snapshotForReopen(next, pane);
    if ((pane?.type ?? null) === 'web') next = withoutWebSidecar(next, paneID);

    next = removeVisiblePane(next, paneID);
    next = {
        ...next,
        layout: removing(next.layout, paneID),
        currentLayoutIndex: null
    };
    next = scrubFocusHistory(next, paneID);

    if (next.focusedPaneID === paneID) {
        const popped = popFocusFromHistory(next, paneID);
        const fallback = allPaneIDs(next.layout)[0] ?? null;
        next = {
            ...next,
            focusHistory: popped.history,
            focusedPaneID: popped.candidate ?? fallback
        };
    }
    return next;
}

/** Park a visible pane: it leaves the layout, keeps its PTY, and lands in `parkedPanes`. */
function parkPane(workspace: WorkspaceState, paneID: string): WorkspaceState {
    const pane = findVisiblePane(workspace, paneID);
    if (pane === null) return workspace;
    let next = clearSearchIfTargets(workspace, paneID);
    next = restoreZoomIfNeeded(next);
    next = {
        ...next,
        panes: next.panes.filter((candidate) => candidate.id !== paneID),
        parkedPanes: [...next.parkedPanes, pane],
        layout: removing(next.layout, paneID),
        currentLayoutIndex: null
    };
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

/** Bring a parked pane back into the layout (replacing a leaf, splitting, or as the root). */
function unparkPane(
    workspace: WorkspaceState,
    paneID: string,
    replacePaneID: string | undefined
): WorkspaceState {
    const parked = findParkedPane(workspace, paneID);
    if (parked === null) return workspace;
    const unzoomed = restoreZoomIfNeeded(workspace);
    const restored: Pane = { ...parked, parkedSourcePaneID: null };
    let next: WorkspaceState = {
        ...unzoomed,
        parkedPanes: unzoomed.parkedPanes.filter((pane) => pane.id !== paneID),
        panes: [...unzoomed.panes, restored],
        currentLayoutIndex: null
    };

    if (replacePaneID !== undefined && findVisiblePane(next, replacePaneID) !== null) {
        next = { ...next, layout: replacing(next.layout, replacePaneID, leaf(paneID)) };
    } else {
        const anchor = next.focusedPaneID ?? allPaneIDs(next.layout)[0] ?? null;
        next = {
            ...next,
            layout:
                anchor === null
                    ? leaf(paneID)
                    : splitting(next.layout, anchor, 'horizontal', paneID).layout
        };
    }
    return setFocus(next, paneID);
}

/** §7.7 `paneProcessTerminated`: three branches, checked in order. */
function paneProcessTerminated(workspace: WorkspaceState, paneID: string): WorkspaceState {
    // 1. A parked pane died: any pane pointing at it becomes a normal close.
    if (findParkedPane(workspace, paneID) !== null) {
        const parkedPanes = workspace.parkedPanes.filter((pane) => pane.id !== paneID);
        const panes = workspace.panes.map((pane) =>
            pane.parkedSourcePaneID === paneID ? { ...pane, parkedSourcePaneID: null } : pane
        );
        return { ...workspace, parkedPanes, panes };
    }
    // 2. A markdown pane's external editor exited: back to preview.
    const pane = findVisiblePane(workspace, paneID);
    if (pane !== null && pane.type === 'markdown' && pane.externalEditorCommand !== null) {
        return mutateVisiblePane(workspace, paneID, (target) => ({
            ...target,
            isEditing: false,
            externalEditorCommand: null
        }));
    }
    // 3. A shell exited → the pane closes. Only a shell: a content pane that had a PTY (a
    // markdown pane hosting `$EDITOR`, CONT-081) is already back in preview by the time its
    // process is reaped, and closing it then would delete the user's document pane because
    // they pressed ⌘E. The Swift app could not hit this — it destroyed the ghostty surface
    // explicitly rather than through a process-exit notification — so the guard is new here and
    // was found by the audit: `⌘E` out of a live editor session made the pane vanish.
    if (pane !== null && pane.type !== 'shell') return workspace;
    return closePaneInWorkspace(workspace, paneID);
}

// ---------------------------------------------------------------------------
// Reopen
// ---------------------------------------------------------------------------

function reopenClosedPane(
    workspace: WorkspaceState,
    newPaneID: string,
    nowMillis: number
): WorkspaceState {
    if (workspace.recentlyClosedPanes.length === 0) return workspace;
    const snapshots = [...workspace.recentlyClosedPanes];
    const snapshot = snapshots.pop() as (typeof snapshots)[number];
    // QUIRK (§7.9): the snapshot is consumed BEFORE the focus guard, so with no focused pane it
    // is lost.
    if (workspace.focusedPaneID === null) {
        return { ...workspace, recentlyClosedPanes: snapshots };
    }

    const pane = newPane({
        id: newPaneID,
        workingDirectory: snapshot.workingDirectory,
        nowMillis,
        label: snapshot.label,
        type: snapshot.type,
        filePath: snapshot.filePath,
        scratchpadContent: snapshot.scratchpadContent,
        isEditing: snapshot.type === 'scratchpad'
    });
    // agentSessionID is NOT restored (it only types the resume command); agentKind is, for
    // display continuity, and agentProfileName as the same kind of last-known value (the
    // reopen channel also reads it from the snapshot to spawn the PTY with the session's
    // profile env); markdownFontSize survives via the snapshot.
    const restored: Pane = {
        ...pane,
        agentKind: snapshot.agentKind,
        agentProfileName: snapshot.agentProfileName,
        markdownFontSize: snapshot.markdownFontSize
    };

    let next: WorkspaceState = {
        ...workspace,
        recentlyClosedPanes: snapshots,
        panes: [...workspace.panes, restored],
        layout: splitting(workspace.layout, workspace.focusedPaneID, 'horizontal', newPaneID)
            .layout,
        currentLayoutIndex: null
    };
    if (snapshot.type === 'web' && snapshot.webState !== null) {
        next = { ...next, webPanes: { ...next.webPanes, [newPaneID]: snapshot.webState } };
    }
    // QUIRK: a private web pane snapshots with webState null, so the reopened pane has no
    // sidecar at all.
    return setFocus(next, newPaneID);
}

// ---------------------------------------------------------------------------
// Content panes
// ---------------------------------------------------------------------------

/** The shared "`--here` reuse" flow: park the source pane and take its slot (§7.4). */
function reuseBranch(
    workspace: WorkspaceState,
    reusePaneID: string,
    pane: Pane
): WorkspaceState | null {
    const source = findVisiblePane(workspace, reusePaneID);
    if (source === null) return null;
    let next = clearSearchIfTargets(workspace, reusePaneID);
    next = restoreZoomIfNeeded(next);
    const attached: Pane = { ...pane, parkedSourcePaneID: reusePaneID };
    next = {
        ...next,
        layout: replacing(next.layout, reusePaneID, leaf(pane.id)),
        panes: [...next.panes.filter((candidate) => candidate.id !== reusePaneID), attached],
        parkedPanes: [...next.parkedPanes, source],
        currentLayoutIndex: null
    };
    return setFocus(next, pane.id);
}

function openMarkdownPane(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'open-markdown-pane' }>
): WorkspaceState {
    const fileName = basename(action.filePath);
    const pane = newPane({
        id: action.paneID,
        workingDirectory: dirname(action.filePath),
        nowMillis: action.now,
        label: fileName,
        title: fileName,
        type: 'markdown',
        filePath: action.filePath
    });

    if (action.reusePaneID !== undefined) {
        const reused = reuseBranch(workspace, action.reusePaneID, pane);
        if (reused !== null) return reused;
        // A reusePaneID naming no visible pane falls through to the split path.
    }

    // QUIRK (§7.4): no restoreZoomIfNeeded() on this branch.
    const sourceID = workspace.focusedPaneID ?? allPaneIDs(workspace.layout)[0] ?? null;
    const next: WorkspaceState = {
        ...appendPane(workspace, pane),
        layout:
            sourceID === null
                ? leaf(pane.id)
                : splitting(workspace.layout, sourceID, 'horizontal', pane.id).layout,
        currentLayoutIndex: null
    };
    return setFocus(next, pane.id);
}

function openDiffPane(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'open-diff-pane' }>
): WorkspaceState {
    const target = action.targetPath ?? null;
    const scopeName = target !== null && target !== '' ? basename(target) : basename(action.repoPath);
    const pane = newPane({
        id: action.paneID,
        workingDirectory: action.repoPath,
        nowMillis: action.now,
        label: scopeName,
        title: `diff: ${scopeName}`,
        type: 'diff',
        filePath: target
    });

    if (action.reusePaneID !== undefined) {
        const reused = reuseBranch(workspace, action.reusePaneID, pane);
        if (reused !== null) return reused;
    }

    const sourceID = workspace.focusedPaneID; // no allPaneIDs fallback here (§7.5)
    const base = sourceID === null ? workspace : restoreZoomIfNeeded(workspace);
    const next: WorkspaceState = {
        ...appendPane(base, pane),
        layout:
            sourceID === null
                ? leaf(pane.id)
                : splitting(base.layout, sourceID, 'horizontal', pane.id).layout,
        currentLayoutIndex: null
    };
    return setFocus(next, pane.id);
}

function createScratchpad(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'create-scratchpad' }>,
    homeDirectory: string
): WorkspaceState {
    const pane = newPane({
        id: action.paneID,
        workingDirectory: homeDirectory,
        nowMillis: action.now,
        type: 'scratchpad',
        title: 'Scratchpad',
        isEditing: true
    });
    const focusedID = workspace.focusedPaneID;
    const base = focusedID === null ? workspace : restoreZoomIfNeeded(workspace);
    const next: WorkspaceState = {
        ...appendPane(base, pane),
        layout:
            focusedID === null
                ? leaf(pane.id)
                : splitting(base.layout, focusedID, 'horizontal', pane.id).layout,
        currentLayoutIndex: null
    };
    return setFocus(next, pane.id);
}

function openWebPane(
    workspace: WorkspaceState,
    action: Extract<DomainAction, { type: 'open-web-pane' }>,
    homeDirectory: string
): WorkspaceState {
    const pane = newPane({
        id: action.paneID,
        workingDirectory: homeDirectory,
        nowMillis: action.now,
        type: 'web',
        title: 'Web'
    });
    const sidecar: WebPaneState = {
        tabs: [{ id: action.tabID, url: normalizeURLInput(action.url), title: '' }],
        activeTabID: action.tabID,
        isPrivate: action.isPrivate ?? false
    };
    const seeded: WorkspaceState = {
        ...workspace,
        webPanes: { ...workspace.webPanes, [action.paneID]: sidecar }
    };

    if (action.reusePaneID !== undefined) {
        const reused = reuseBranch(seeded, action.reusePaneID, pane);
        if (reused !== null) return reused;
    }

    const sourceID = action.sourcePaneID ?? seeded.focusedPaneID;
    const base = sourceID === null || sourceID === undefined ? seeded : restoreZoomIfNeeded(seeded);
    const next: WorkspaceState = {
        ...appendPane(base, pane),
        layout:
            sourceID === null || sourceID === undefined
                ? leaf(pane.id)
                : splitting(base.layout, sourceID, action.direction ?? 'horizontal', pane.id)
                      .layout,
        currentLayoutIndex: null
    };
    return setFocus(next, pane.id);
}

// ---------------------------------------------------------------------------
// Moving between workspaces (socket-handlers.md §4.11)
// ---------------------------------------------------------------------------

function movePaneToWorkspace(
    state: DaemonState,
    action: Extract<DomainAction, { type: 'move-pane-to-workspace' }>
): DaemonState {
    const source = state.workspaces.find((workspace) =>
        workspace.panes.some((pane) => pane.id === action.paneID)
    );
    if (source === undefined) return state;
    if (source.id === action.toWorkspaceID) return state;
    const target = state.workspaces.find((workspace) => workspace.id === action.toWorkspaceID);
    if (target === undefined) return state;
    const pane = findVisiblePane(source, action.paneID) as Pane;
    // A web pane's tabs live in the sidecar, not on the Pane: carry it across or the target
    // gets a blank pane.
    const sidecar = pane.type === 'web' ? source.webPanes[action.paneID] : undefined;

    let nextSource: WorkspaceState = {
        ...source,
        panes: source.panes.filter((candidate) => candidate.id !== action.paneID),
        syncInputExcluded: source.syncInputExcluded.filter((id) => id !== action.paneID),
        layout: removing(source.layout, action.paneID),
        currentLayoutIndex: null
    };
    if (sidecar !== undefined) nextSource = withoutWebSidecar(nextSource, action.paneID);
    nextSource = scrubFocusHistory(nextSource, action.paneID);
    if (nextSource.focusedPaneID === action.paneID) {
        const popped = popFocusFromHistory(nextSource, action.paneID);
        nextSource = {
            ...nextSource,
            focusHistory: popped.history,
            focusedPaneID: popped.candidate ?? allPaneIDs(nextSource.layout)[0] ?? null
        };
    }
    nextSource = clearSearchIfTargets(nextSource, action.paneID);
    if (nextSource.zoomedPaneID === action.paneID) {
        nextSource = {
            ...nextSource,
            layout:
                nextSource.savedLayout === null
                    ? nextSource.layout
                    : removing(nextSource.savedLayout, action.paneID),
            zoomedPaneID: null,
            savedLayout: null
        };
    }

    const anchor = target.focusedPaneID ?? allPaneIDs(target.layout)[0] ?? null;
    let nextTarget: WorkspaceState = {
        ...target,
        panes: [...target.panes, pane],
        layout:
            target.layout.kind === 'empty' || anchor === null
                ? leaf(action.paneID)
                : splitting(target.layout, anchor, 'horizontal', action.paneID).layout,
        currentLayoutIndex: null
    };
    if (sidecar !== undefined) {
        nextTarget = {
            ...nextTarget,
            webPanes: { ...nextTarget.webPanes, [action.paneID]: sidecar }
        };
    }
    nextTarget = setFocus(nextTarget, action.paneID);

    return {
        ...state,
        workspaces: state.workspaces.map((workspace) => {
            if (workspace.id === nextSource.id) return nextSource;
            if (workspace.id === nextTarget.id) return nextTarget;
            return workspace;
        }),
        lastActiveWorkspaceID: action.toWorkspaceID
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function reducePaneAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'create-pane':
            return createPane(state, action);
        case 'split-pane':
            return splitPane(state, action);
        case 'split-pane-at-path':
            return splitPaneAtPath(state, action);
        case 'close-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                closePaneInWorkspace(workspace, action.paneID)
            );
        case 'set-pane-label':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                mutateVisiblePane(workspace, action.paneID, (pane) => ({
                    ...pane,
                    label: action.label
                }))
            );
        case 'park-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                parkPane(workspace, action.paneID)
            );
        case 'unpark-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                unparkPane(workspace, action.paneID, action.replacePaneID)
            );
        case 'move-pane-adjacent':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                // Both ids must name VISIBLE panes (§7.12).
                if (findVisiblePane(workspace, action.paneID) === null) return workspace;
                if (findVisiblePane(workspace, action.targetPaneID) === null) return workspace;
                const next: WorkspaceState = {
                    ...workspace,
                    layout: movingPane(
                        workspace.layout,
                        action.paneID,
                        action.targetPaneID,
                        action.zone
                    ),
                    currentLayoutIndex: null
                };
                return setFocus(next, action.paneID);
            });
        case 'move-pane-direction':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                if (workspace.zoomedPaneID !== null) return workspace; // no-op, not an un-zoom
                const focused = workspace.focusedPaneID;
                if (focused === null) return workspace;
                const neighbor = neighborPaneID(workspace.layout, focused, action.direction);
                if (neighbor === null) return workspace;
                return {
                    ...workspace,
                    layout: swappingLeaves(workspace.layout, focused, neighbor),
                    currentLayoutIndex: null
                };
            });
        case 'move-pane-to-workspace':
            return movePaneToWorkspace(state, action);
        case 'resize-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                const result = resizePaneShare(workspace.layout, action.paneID, action.share);
                if (result === null) return workspace;
                return { ...workspace, layout: result.layout, currentLayoutIndex: null };
            });
        case 'update-split-ratio':
            return updateWorkspace(state, action.workspaceID, (workspace) => ({
                ...workspace,
                layout: updatingSplitRatio(workspace.layout, action.splitPath, action.ratio),
                currentLayoutIndex: null
            }));
        case 'reopen-closed-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                reopenClosedPane(workspace, action.paneID, action.now)
            );
        case 'pane-process-terminated': {
            const workspaceID =
                action.workspaceID ??
                state.workspaces.find(
                    (workspace) =>
                        workspace.panes.some((pane) => pane.id === action.paneID) ||
                        workspace.parkedPanes.some((pane) => pane.id === action.paneID)
                )?.id;
            if (workspaceID === undefined) return state;
            return updateWorkspace(state, workspaceID, (workspace) =>
                paneProcessTerminated(workspace, action.paneID)
            );
        }
        case 'open-markdown-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                openMarkdownPane(workspace, action)
            );
        case 'open-diff-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                openDiffPane(workspace, action)
            );
        case 'create-scratchpad':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                createScratchpad(workspace, action, state.homeDirectory)
            );
        case 'open-web-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                openWebPane(workspace, action, state.homeDirectory)
            );
        case 'scratchpad-content-changed':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                mutateVisiblePane(workspace, action.paneID, (pane) => ({
                    ...pane,
                    scratchpadContent: action.content
                }))
            );
        case 'set-markdown-editing':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                const pane = findVisiblePane(workspace, action.paneID);
                if (pane === null || pane.type !== 'markdown') return workspace;
                const next = action.editing
                    ? clearSearchIfTargets(workspace, action.paneID)
                    : workspace;
                return mutateVisiblePane(next, action.paneID, (target) => ({
                    ...target,
                    isEditing: action.editing,
                    // CONT-081: an explicit command wins (the pane is about to host a PTY);
                    // without one the pane keeps whatever it had, and leaving edit mode always
                    // clears it so the surface teardown and the record agree (CONT-090).
                    externalEditorCommand: action.editing
                        ? (action.externalEditorCommand ?? target.externalEditorCommand)
                        : null
                }));
            });
        case 'set-markdown-font-size':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                const pane = findVisiblePane(workspace, action.paneID);
                if (pane === null || pane.type !== 'markdown' || pane.isEditing) return workspace;
                const size = Math.max(8, Math.min(32, Math.round(action.size)));
                return mutateVisiblePane(workspace, action.paneID, (target) => ({
                    ...target,
                    markdownFontSize: size
                }));
            });
        default:
            return state;
    }
}
