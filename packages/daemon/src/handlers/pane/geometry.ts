/**
 * Layout-affecting pane commands: `pane-resize`, `pane-move` (directional),
 * `pane-move-adjacent` and `pane-move-to-workspace`.
 * Spec: docs/socket-handlers.md §4.8–§4.11, pane-layout.md §12.5 (share ↔ ratio).
 *
 * `pane-move` and `pane-move-to-workspace` are fire-and-forget: every guard still runs, but a
 * failure is silent because there is nobody to tell.
 */

import { epochSecondsFromUnixMillis, workspaceSidebarID } from '@kelpi/core/codec';
import { currentPaneShare, dropZoneForWireEdge, enclosingSplitPath, resizePaneShare } from '@kelpi/core/layout';
import { makeSlug, resolvePaneInWorkspace, resolveWorkspaceLenient } from '@kelpi/core/resolve';

import type { CommandHandler } from '../../seams.js';
import {
    makeWorkspaceState,
    nextRandomColor,
    resolveStateOf,
    workspaceByID,
    type DaemonState
} from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import {
    labelField,
    mintWorkspaceID,
    nowMillis,
    refreshSyncGroup,
    resolveTarget,
    sendError,
    sendOK,
    workspaceOfVisiblePane
} from './support.js';

// ---------------------------------------------------------------------------
// §4.9 pane-resize
// ---------------------------------------------------------------------------

export const handlePaneResize: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-resize') return;
    const resolution = resolveTarget(ctx, msg);
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;

    // While zoomed the live layout is a single leaf and the real tree is parked, so a resize
    // has no split to map onto.
    if (workspace.zoomedPaneID !== null) {
        sendError(reply, 'cannot resize while a pane is zoomed — un-zoom first');
        return;
    }

    const enclosing = enclosingSplitPath(workspace.layout, paneID);
    if (enclosing === null) {
        sendError(
            reply,
            `pane ${paneID} has no sibling to resize against (it is the only pane in its workspace)`
        );
        return;
    }

    let desiredShare: number;
    if (msg.ratio !== undefined) {
        desiredShare = msg.ratio;
    } else if (msg.delta !== undefined) {
        // `--grow`/`--shrink` nudge the pane's CURRENT share (default step 0.05, signed by the
        // CLI); an unreadable ratio falls back to an even split.
        desiredShare = (currentPaneShare(workspace.layout, paneID) ?? 0.5) + msg.delta;
    } else {
        sendError(reply, 'pane resize requires --ratio or --grow/--shrink');
        return;
    }

    const result = resizePaneShare(workspace.layout, paneID, desiredShare);
    /* c8 ignore next 4 -- unreachable: the enclosing-split guard above already ran */
    if (result === null) {
        sendError(
            reply,
            `pane ${paneID} has no sibling to resize against (it is the only pane in its workspace)`
        );
        return;
    }

    // The reducer re-runs the same share→ratio pipeline and clears the tracked predefined
    // layout index (a manual ratio breaks the predefined layout, exactly like a divider drag).
    ctx.store.dispatch({
        type: 'resize-pane',
        workspaceID: workspace.id,
        paneID,
        share: desiredShare
    });

    sendOK(reply, {
        pane_id: paneID,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        split_path: result.splitPath,
        ratio: result.ratio,
        target_share: result.targetShare,
        ...labelField(pane.label)
    });
};

// ---------------------------------------------------------------------------
// §4.8 pane-move (directional, fire-and-forget)
// ---------------------------------------------------------------------------

export const handlePaneMove: CommandHandler<PaneHandlerContext> = (msg, ctx) => {
    if (msg.command !== 'pane-move') return;
    const workspace = workspaceOfVisiblePane(ctx.store.getState(), msg.pane_id);
    if (workspace === null) return;
    // The directional move operates on the FOCUSED pane, so the caller pane is focused first.
    ctx.store.dispatch({
        type: 'focus-pane',
        workspaceID: workspace.id,
        paneID: msg.pane_id
    });
    ctx.store.dispatch({
        type: 'move-pane-direction',
        workspaceID: workspace.id,
        direction: msg.direction
    });
};

// ---------------------------------------------------------------------------
// §4.10 pane-move-adjacent
// ---------------------------------------------------------------------------

export const handlePaneMoveAdjacent: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-move-adjacent') return;
    const resolution = resolveTarget(ctx, {
        pane_id: msg.pane_id,
        target: msg.target,
        workspace: msg.workspace
    });
    if (!resolution.ok) {
        sendError(reply, resolution.error);
        return;
    }
    const { paneID, pane, workspace } = resolution;

    // The anchor MUST live in the moved pane's workspace, since `movingPane` operates on one tree.
    // Missing, other-workspace and ambiguous-label anchors all share this error.
    const anchorID = resolvePaneInWorkspace(
        resolveStateOf(ctx.store.getState()),
        workspace.id,
        msg.anchor
    );
    if (anchorID === null) {
        sendError(reply, `no pane matching '${msg.anchor}' in workspace '${workspace.name}'`);
        return;
    }
    if (anchorID === paneID) {
        sendError(reply, 'cannot move a pane adjacent to itself');
        return;
    }

    sendOK(reply, {
        pane_id: paneID,
        anchor_id: anchorID,
        zone: msg.zone,
        workspace_id: workspace.id,
        workspace_name: workspace.name,
        ...labelField(pane.label)
    });

    ctx.store.dispatch({
        type: 'move-pane-adjacent',
        workspaceID: workspace.id,
        paneID,
        targetPaneID: anchorID,
        zone: dropZoneForWireEdge(msg.zone)
    });
};

// ---------------------------------------------------------------------------
// §4.11 pane-move-to-workspace (fire-and-forget)
// ---------------------------------------------------------------------------

export const handlePaneMoveToWorkspace: CommandHandler<PaneHandlerContext> = (msg, ctx) => {
    if (msg.command !== 'pane-move-to-workspace') return;
    const state = ctx.store.getState();
    const source = workspaceOfVisiblePane(state, msg.pane_id);
    if (source === null) return;

    // The LENIENT resolver (§2.3): UUID → case-insensitive first-match name → slug. No
    // ambiguity guard: two workspaces named "Dev"/"dev" resolve to whichever comes first.
    const resolved = resolveWorkspaceLenient(resolveStateOf(state), msg.name);
    let targetID = resolved?.id ?? null;

    if (targetID === null && msg.create) {
        targetID = createEmptyWorkspace(ctx, state, msg.name);
    }
    if (targetID === null || targetID === source.id) return;
    if (workspaceByID(ctx.store.getState(), targetID) === null) return;

    ctx.store.dispatch({
        type: 'move-pane-to-workspace',
        paneID: msg.pane_id,
        toWorkspaceID: targetID
    });

    // The move mutates two workspaces at once, so BOTH broadcast groups are refreshed (§5).
    refreshSyncGroup(ctx, source.id);
    refreshSyncGroup(ctx, targetID);

    // §4.11 "the app switches to the destination" (#52). The reducer's `lastActiveWorkspaceID`
    // only moves what `kelpi workspace list` calls ACTIVE: the port's active workspace is PER
    // CLIENT (the client selector prefers its own `ui.activeWorkspaceID`), so without this an
    // attached window stayed on the source workspace and the pane the user just moved vanished
    // from view. Same fan-out `workspace-create` uses for the same reason (`workspaces.ts`,
    // run-B L3): untargeted `reveal-pane`, which clients implement as "activate the workspace,
    // then focus the pane". Skipped if the reducer declined the move, so nothing is revealed
    // that did not actually arrive.
    const landed = workspaceByID(ctx.store.getState(), targetID);
    if (landed === null || !landed.panes.some((pane) => pane.id === msg.pane_id)) return;
    ctx.broadcast({ type: 'reveal-pane', workspaceID: targetID, paneID: msg.pane_id });
};

/**
 * `--create`: an EMPTY workspace (no panes, empty layout, no focus) named verbatim, appended
 * to the sidebar. The store has no "create empty workspace" action, and `create-workspace` always
 * seeds a first pane, which would strand a spurious PTY here, so this composes the same shape
 * through `replace-state`, the store's wholesale escape hatch.
 */
function createEmptyWorkspace(
    ctx: PaneHandlerContext,
    state: DaemonState,
    name: string
): string {
    const id = mintWorkspaceID(ctx);
    const createdAt = epochSecondsFromUnixMillis(nowMillis(ctx));
    const workspace = makeWorkspaceState({
        id,
        name,
        slug: makeSlug(name, id),
        color: nextRandomColor(state, ctx.random),
        createdAt
    });
    ctx.store.dispatch({
        type: 'replace-state',
        state: {
            ...state,
            workspaces: [...state.workspaces, workspace],
            topLevelOrder: [...state.topLevelOrder, workspaceSidebarID(id)]
        }
    });
    return id;
}
