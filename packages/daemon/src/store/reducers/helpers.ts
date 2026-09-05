/**
 * Shared reducer plumbing: workspace addressing, the focus bookkeeping rules, zoom restore,
 * search clearing and pane mutation across the visible/parked lanes.
 *
 * Spec: docs/workspace-feature.md §3.5 (focus), §3.6 (lanes), §5.1 (restoreZoomIfNeeded),
 * §5.2 (clearSearchIfTargets).
 */

import { epochSecondsFromUnixMillis } from '@kelpi/core/codec';
import { makePane, type Pane, type PaneType } from '@kelpi/core/layout';
import { MAX_FOCUS_HISTORY, type DaemonState, type WorkspaceState } from '../types.js';

/** Persisted timestamps are epoch seconds; actions carry epoch milliseconds. */
export function seconds(nowMillis: number): number {
    return epochSecondsFromUnixMillis(nowMillis);
}

/** Replace one workspace; a missing id (or an unchanged result) leaves state identical. */
export function updateWorkspace(
    state: DaemonState,
    workspaceID: string,
    update: (workspace: WorkspaceState) => WorkspaceState
): DaemonState {
    const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceID);
    if (index < 0) return state;
    const current = state.workspaces[index] as WorkspaceState;
    const next = update(current);
    if (next === current) return state;
    const workspaces = [...state.workspaces];
    workspaces[index] = next;
    return { ...state, workspaces };
}

export function findVisiblePane(workspace: WorkspaceState, paneID: string): Pane | null {
    return workspace.panes.find((pane) => pane.id === paneID) ?? null;
}

export function findParkedPane(workspace: WorkspaceState, paneID: string): Pane | null {
    return workspace.parkedPanes.find((pane) => pane.id === paneID) ?? null;
}

/** §3.6: visible pane, else parked pane, else null. */
export function findPane(workspace: WorkspaceState, paneID: string): Pane | null {
    return findVisiblePane(workspace, paneID) ?? findParkedPane(workspace, paneID);
}

/** §3.6 `mutatePane`: apply to whichever lane holds the pane; no-op if absent. */
export function mutatePane(
    workspace: WorkspaceState,
    paneID: string,
    update: (pane: Pane) => Pane
): WorkspaceState {
    const visibleIndex = workspace.panes.findIndex((pane) => pane.id === paneID);
    if (visibleIndex >= 0) {
        const current = workspace.panes[visibleIndex] as Pane;
        const next = update(current);
        if (next === current) return workspace;
        const panes = [...workspace.panes];
        panes[visibleIndex] = next;
        return { ...workspace, panes };
    }
    const parkedIndex = workspace.parkedPanes.findIndex((pane) => pane.id === paneID);
    if (parkedIndex < 0) return workspace;
    const current = workspace.parkedPanes[parkedIndex] as Pane;
    const next = update(current);
    if (next === current) return workspace;
    const parkedPanes = [...workspace.parkedPanes];
    parkedPanes[parkedIndex] = next;
    return { ...workspace, parkedPanes };
}

/** Visible lane only (scratchpad content, labels, markdown flags). */
export function mutateVisiblePane(
    workspace: WorkspaceState,
    paneID: string,
    update: (pane: Pane) => Pane
): WorkspaceState {
    const index = workspace.panes.findIndex((pane) => pane.id === paneID);
    if (index < 0) return workspace;
    const current = workspace.panes[index] as Pane;
    const next = update(current);
    if (next === current) return workspace;
    const panes = [...workspace.panes];
    panes[index] = next;
    return { ...workspace, panes };
}

export function appendPane(workspace: WorkspaceState, pane: Pane): WorkspaceState {
    return { ...workspace, panes: [...workspace.panes, pane] };
}

export function removeVisiblePane(workspace: WorkspaceState, paneID: string): WorkspaceState {
    const panes = workspace.panes.filter((pane) => pane.id !== paneID);
    return panes.length === workspace.panes.length ? workspace : { ...workspace, panes };
}

/**
 * §5.1: any structural operation first exits zoom by restoring the pre-zoom layout.
 * Deliberately NOT run by createPane, movePane, movePaneInDirection, updateSplitRatio and
 * toggleZoomPane (which IS the toggle).
 */
export function restoreZoomIfNeeded(workspace: WorkspaceState): WorkspaceState {
    if (workspace.savedLayout === null) return workspace;
    return {
        ...workspace,
        layout: workspace.savedLayout,
        zoomedPaneID: null,
        savedLayout: null
    };
}

/** §5.2 */
export function clearSearchIfTargets(workspace: WorkspaceState, paneID: string): WorkspaceState {
    if (workspace.searchingPaneID !== paneID) return workspace;
    return {
        ...workspace,
        searchingPaneID: null,
        searchNeedle: '',
        searchTotal: null,
        searchSelected: null
    };
}

/**
 * §3.5 `setFocus`: the outgoing pane is pushed onto the history (deduped, max 8, oldest
 * dropped from the FRONT). Used for every focus change EXCEPT pane close — a closing pane is
 * destroyed, not "left", and must never land in its own history.
 */
export function setFocus(workspace: WorkspaceState, newID: string | null): WorkspaceState {
    const current = workspace.focusedPaneID;
    if (current === newID) return workspace;
    if (current === null) return { ...workspace, focusedPaneID: newID };
    const history = workspace.focusHistory.filter((id) => id !== current);
    history.push(current);
    while (history.length > MAX_FOCUS_HISTORY) history.shift();
    return { ...workspace, focusedPaneID: newID, focusHistory: history };
}

export interface PoppedFocus {
    readonly history: readonly string[];
    /** Most-recent VISIBLE pane id; dead/parked entries are discarded on the way. */
    readonly candidate: string | null;
}

/** §3.5 `popFocusFromHistory`. */
export function popFocusFromHistory(
    workspace: WorkspaceState,
    excluding: string | null
): PoppedFocus {
    const history = workspace.focusHistory.filter((id) => id !== excluding);
    while (history.length > 0) {
        const candidate = history.pop() as string;
        if (findVisiblePane(workspace, candidate) !== null) return { history, candidate };
    }
    return { history, candidate: null };
}

export function scrubFocusHistory(
    workspace: WorkspaceState,
    ...paneIDs: readonly string[]
): WorkspaceState {
    const drop = new Set(paneIDs);
    const history = workspace.focusHistory.filter((id) => !drop.has(id));
    return history.length === workspace.focusHistory.length ? workspace : { ...workspace, focusHistory: history };
}

export interface NewPaneOptions {
    readonly id: string;
    readonly workingDirectory: string;
    readonly nowMillis: number;
    readonly type?: PaneType;
    readonly label?: string | null;
    readonly title?: string | null;
    readonly filePath?: string | null;
    readonly isEditing?: boolean;
    readonly scratchpadContent?: string | null;
}

/** A fresh pane with spec defaults (transient fields empty). */
export function newPane(options: NewPaneOptions): Pane {
    const timestamp = seconds(options.nowMillis);
    const pane = makePane({
        id: options.id,
        workingDirectory: options.workingDirectory,
        createdAt: timestamp,
        lastActivityAt: timestamp,
        label: options.label ?? null,
        type: options.type ?? 'shell',
        filePath: options.filePath ?? null,
        scratchpadContent: options.scratchpadContent ?? null
    });
    return {
        ...pane,
        title: options.title ?? null,
        isEditing: options.isEditing ?? false
    };
}

export function withoutEntry<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
    return items.filter((item) => !predicate(item));
}

export function clampIndex(index: number, length: number): number {
    if (!Number.isFinite(index)) return length;
    return Math.max(0, Math.min(Math.trunc(index), length));
}
