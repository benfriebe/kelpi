/**
 * Layout, focus, zoom and search reducers.
 *
 * Spec: docs/current/workspace-feature.md §7.8 (focus), §7.12 (layout/zoom), §7.14 (search);
 * docs/current/pane-layout.md §11 (cycling + `currentLayoutIndex` reset rule).
 */

import {
    leaf,
    nextLayoutIndex,
    nextPaneID,
    predefinedLayoutAtIndex,
    predefinedLayoutIndex,
    previousPaneID,
    rebuildLayout
} from '@nex/core/layout';
import type { DaemonState, DomainAction, WorkspaceState } from '../types.js';
import { findVisiblePane, restoreZoomIfNeeded, setFocus, updateWorkspace } from './helpers.js';

/** cycle/select share everything but the target index; both need >= 2 visible panes. */
function applyPredefinedLayout(workspace: WorkspaceState, index: number): WorkspaceState {
    if (workspace.panes.length <= 1) return workspace;
    const kind = predefinedLayoutAtIndex(index);
    if (kind === null) return workspace;
    const unzoomed = restoreZoomIfNeeded(workspace);
    return {
        ...unzoomed,
        layout: rebuildLayout(unzoomed.layout, kind, unzoomed.focusedPaneID),
        currentLayoutIndex: index
    };
}

/** §7.12 `toggleZoomPane`: `currentLayoutIndex` is untouched in both directions. */
function toggleZoom(workspace: WorkspaceState): WorkspaceState {
    if (workspace.zoomedPaneID !== null) {
        return {
            ...workspace,
            layout: workspace.savedLayout ?? workspace.layout,
            zoomedPaneID: null,
            savedLayout: null
        };
    }
    const focused = workspace.focusedPaneID;
    if (focused === null || workspace.panes.length <= 1) return workspace;
    return {
        ...workspace,
        savedLayout: workspace.layout,
        zoomedPaneID: focused,
        layout: leaf(focused)
    };
}

/** §7.14 `toggleSearch`: only shell / web / non-editing markdown panes can host find. */
function canHostSearch(workspace: WorkspaceState): boolean {
    const focused = workspace.focusedPaneID;
    if (focused === null) return false;
    const pane = findVisiblePane(workspace, focused);
    if (pane === null) return false;
    if (pane.type === 'shell' || pane.type === 'web') return true;
    return pane.type === 'markdown' && !pane.isEditing;
}

function closeSearch(workspace: WorkspaceState): WorkspaceState {
    if (workspace.searchingPaneID === null) return workspace;
    return {
        ...workspace,
        searchingPaneID: null,
        searchNeedle: '',
        searchTotal: null,
        searchSelected: null
    };
}

export function reduceLayoutAction(state: DaemonState, action: DomainAction): DaemonState {
    switch (action.type) {
        case 'cycle-layout':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                applyPredefinedLayout(workspace, nextLayoutIndex(workspace.currentLayoutIndex))
            );
        case 'select-layout':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                applyPredefinedLayout(workspace, predefinedLayoutIndex(action.kind))
            );
        case 'toggle-zoom':
            return updateWorkspace(state, action.workspaceID, toggleZoom);
        case 'focus-pane':
            // No existence check (§7.8): callers pass real ids.
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                setFocus(workspace, action.paneID)
            );
        case 'focus-next-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                if (workspace.focusedPaneID === null) return workspace;
                const target = nextPaneID(workspace.layout, workspace.focusedPaneID);
                return target === null ? workspace : setFocus(workspace, target);
            });
        case 'focus-previous-pane':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                if (workspace.focusedPaneID === null) return workspace;
                const target = previousPaneID(workspace.layout, workspace.focusedPaneID);
                return target === null ? workspace : setFocus(workspace, target);
            });
        case 'toggle-search':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                if (!canHostSearch(workspace)) return workspace;
                // An open bar closes wherever it lives; the toggle never moves it.
                if (workspace.searchingPaneID !== null) return closeSearch(workspace);
                return {
                    ...workspace,
                    searchingPaneID: workspace.focusedPaneID,
                    searchNeedle: '',
                    searchTotal: null,
                    searchSelected: null
                };
            });
        case 'close-search':
            return updateWorkspace(state, action.workspaceID, closeSearch);
        case 'set-search-needle':
            return updateWorkspace(state, action.workspaceID, (workspace) =>
                workspace.searchingPaneID === null
                    ? workspace
                    : { ...workspace, searchNeedle: action.needle, searchSelected: null }
            );
        case 'set-search-counts':
            return updateWorkspace(state, action.workspaceID, (workspace) => {
                // Stale reports from a pane that no longer hosts the bar are dropped (§7.14).
                if (workspace.searchingPaneID !== action.paneID) return workspace;
                const total = action.total === undefined ? workspace.searchTotal : action.total;
                let selected =
                    action.selected === undefined ? workspace.searchSelected : action.selected;
                // A reported total of 0 also clears the selection (no "3/0" after a reload).
                if (action.total === 0) selected = null;
                if (total === workspace.searchTotal && selected === workspace.searchSelected) {
                    return workspace;
                }
                return { ...workspace, searchTotal: total, searchSelected: selected };
            });
        default:
            return state;
    }
}
