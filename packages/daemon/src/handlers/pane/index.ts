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
import type { PaneHandlerContext } from './context.js';
import { handlePaneCreate, handlePaneSplit } from './create.js';
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

export const paneHandlers: HandlerTable<PaneHandlerContext> = new Map([
    ['pane-split', handlePaneSplit],
    ['pane-create', handlePaneCreate],
    ['pane-close', handlePaneClose],
    ['pane-name', handlePaneName],
    ['pane-send', handlePaneSend],
    ['pane-send-key', handlePaneSendKey],
    ['pane-capture', handlePaneCapture],
    ['pane-resize', handlePaneResize],
    ['pane-move', handlePaneMove],
    ['pane-move-adjacent', handlePaneMoveAdjacent],
    ['pane-move-to-workspace', handlePaneMoveToWorkspace],
    ['pane-list', handlePaneList],
    ['pane-sync', handlePaneSync],
    ['pane-sync-exclude', handlePaneSyncExclude]
]);

export type { AsyncTerminalReads, PaneHandlerContext, PaneSpawnDefaults } from './context.js';
export { handlePaneCreate, handlePaneSplit } from './create.js';
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
