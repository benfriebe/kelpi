/**
 * WP2.5a: the `pane-*` command handlers.
 *
 * Boot merges this table into the control dispatcher; the keys are wire command names, so a
 * command that is not in the table is simply not handled by this family.
 *
 * Reply/fire-and-forget split (wire-protocol.md §4 allowlist): everything here is
 * request/response EXCEPT `pane-move` and `pane-move-to-workspace`, which never write a byte.
 * Every handler still runs its full guard chain when `reply` is null, because a legacy CLI
 * must keep mutating state.
 */

import type { HandlerTable } from '../../seams.js';
import { handlePaneClear } from './clear.js';
import type { PaneHandlerContext } from './context.js';
import { handlePaneCreate, handlePaneSplit } from './create.js';
import { handlePaneFontSize } from './font-size.js';
import {
    handlePaneMove,
    handlePaneMoveAdjacent,
    handlePaneMoveToWorkspace,
    handlePaneResize
} from './geometry.js';
import { handlePaneCapture, handlePaneSend, handlePaneSendKey } from './input.js';
import { handlePaneClose, handlePaneName } from './lifecycle.js';
import { handlePaneList } from './list.js';
import { handlePaneSync, handlePaneSyncExclude } from './sync.js';
import {
    handlePaneMoveToNewTab,
    handlePaneMoveToTab,
    handleWorkspaceTabClose,
    handleWorkspaceTabCloseOthers,
    handleWorkspaceTabDuplicate,
    handleWorkspaceTabList,
    handleWorkspaceTabMergePrevious,
    handleWorkspaceTabMove,
    handleWorkspaceTabMoveToWorkspace,
    handleWorkspaceTabNew,
    handleWorkspaceTabRename,
    handleWorkspaceTabSelect,
    handleWorkspaceTabSplitPanes
} from './tabs.js';

export const paneHandlers: HandlerTable<PaneHandlerContext> = new Map([
    ['pane-split', handlePaneSplit],
    ['pane-create', handlePaneCreate],
    ['pane-close', handlePaneClose],
    ['pane-name', handlePaneName],
    ['pane-send', handlePaneSend],
    ['pane-send-key', handlePaneSendKey],
    ['pane-capture', handlePaneCapture],
    ['pane-resize', handlePaneResize],
    ['pane-font-size', handlePaneFontSize],
    ['pane-clear', handlePaneClear],
    ['pane-move', handlePaneMove],
    ['pane-move-adjacent', handlePaneMoveAdjacent],
    ['pane-move-to-workspace', handlePaneMoveToWorkspace],
    ['pane-list', handlePaneList],
    ['pane-sync', handlePaneSync],
    ['pane-sync-exclude', handlePaneSyncExclude],
    // workspace-feature.md §12: the window's tab verbs, with names (`./tabs.ts`).
    ['workspace-tab-list', handleWorkspaceTabList],
    ['workspace-tab-new', handleWorkspaceTabNew],
    ['workspace-tab-select', handleWorkspaceTabSelect],
    ['workspace-tab-rename', handleWorkspaceTabRename],
    ['workspace-tab-move', handleWorkspaceTabMove],
    ['workspace-tab-close', handleWorkspaceTabClose],
    ['workspace-tab-close-others', handleWorkspaceTabCloseOthers],
    ['workspace-tab-split-panes', handleWorkspaceTabSplitPanes],
    ['workspace-tab-merge-previous', handleWorkspaceTabMergePrevious],
    ['workspace-tab-duplicate', handleWorkspaceTabDuplicate],
    ['workspace-tab-move-to-workspace', handleWorkspaceTabMoveToWorkspace],
    ['pane-move-to-new-tab', handlePaneMoveToNewTab],
    ['pane-move-to-tab', handlePaneMoveToTab]
]);

export { handlePaneClear } from './clear.js';
export type { AsyncTerminalReads, PaneHandlerContext, PaneSpawnDefaults } from './context.js';
export { handlePaneCreate, handlePaneSplit } from './create.js';
export { handlePaneFontSize } from './font-size.js';
export {
    handlePaneMove,
    handlePaneMoveAdjacent,
    handlePaneMoveToWorkspace,
    handlePaneResize
} from './geometry.js';
export { handlePaneCapture, handlePaneSend, handlePaneSendKey } from './input.js';
export { handlePaneClose, handlePaneName } from './lifecycle.js';
export { handlePaneList } from './list.js';
export { handlePaneSync, handlePaneSyncExclude } from './sync.js';
export { resolveWorkspaceTab } from './tabs.js';
export {
    labelField,
    refreshSyncGroup,
    resolveTarget,
    sendError,
    sendOK,
    spawnEnvVars,
    spawnPaneIfShell,
    tailLines,
    wireTimestamp
} from './support.js';
