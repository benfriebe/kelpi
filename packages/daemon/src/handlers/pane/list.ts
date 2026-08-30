/**
 * `pane-list`: a pure read (socket-handlers.md §4.12).
 *
 * Panes are enumerated in LAYOUT order (the tree's leaf order), never state order, and ids
 * with no backing visible pane are skipped; parked panes never appear because they are not in
 * the layout. Optional keys follow the builders in @kelpi/protocol: `background_tasks` only when
 * positive, `group_id`/`group_name` both-or-neither, empty strings omitted entirely.
 */

import { allPaneIDs } from '@kelpi/core/layout';
import { buildPaneListEntry, type PaneListEntry } from '@kelpi/protocol';

import { resolveWorkspaceStrict } from '@kelpi/core/resolve';
import type { CommandHandler } from '../../seams.js';
import {
    groupByID,
    groupIDForWorkspace,
    resolveStateOf,
    visiblePane,
    workspaceByID,
    type DaemonState,
    type WorkspaceState
} from '../../store/index.js';
import type { PaneHandlerContext } from './context.js';
import { sendError, sendOK, wireTimestamp, workspaceOfVisiblePane } from './support.js';

export const handlePaneList: CommandHandler<PaneHandlerContext> = (msg, ctx, reply) => {
    if (msg.command !== 'pane-list') return;
    // Requires a reply handle: there is no side effect to perform without one.
    if (reply === null) return;

    const state = ctx.store.getState();
    const scope = msg.scope;

    if (msg.workspace !== undefined && scope === 'current') {
        sendError(reply, 'workspace and --current are mutually exclusive');
        return;
    }

    let workspaces: readonly WorkspaceState[];
    if (scope === undefined || scope === 'all') {
        if (msg.workspace === undefined) {
            workspaces = state.workspaces;
        } else {
            const resolved = resolveWorkspaceStrict(resolveStateOf(state), msg.workspace);
            const workspace = resolved === null ? null : workspaceByID(state, resolved.id);
            if (workspace === null) {
                sendError(reply, `workspace not found: ${msg.workspace}`);
                return;
            }
            workspaces = [workspace];
        }
    } else if (scope === 'current') {
        const workspace =
            msg.pane_id === undefined ? null : workspaceOfVisiblePane(state, msg.pane_id);
        if (workspace === null) {
            sendError(reply, 'no workspace contains the requesting pane');
            return;
        }
        workspaces = [workspace];
    } else {
        sendError(reply, `unknown scope: ${scope}`);
        return;
    }

    const panes = workspaces.flatMap((workspace) => entriesForWorkspace(state, workspace));
    sendOK(reply, { panes });
};

function entriesForWorkspace(
    state: DaemonState,
    workspace: WorkspaceState
): PaneListEntry[] {
    const groupID = groupIDForWorkspace(state, workspace.id);
    const group = groupID === null ? null : groupByID(state, groupID);
    const isActiveWorkspace = state.lastActiveWorkspaceID === workspace.id;

    const entries: PaneListEntry[] = [];
    for (const paneID of allPaneIDs(workspace.layout)) {
        const pane = visiblePane(workspace, paneID);
        if (pane === null) continue; // a layout id with no backing pane is skipped
        entries.push(
            buildPaneListEntry({
                id: pane.id,
                type: pane.type,
                workspace_id: workspace.id,
                workspace_name: workspace.name,
                working_directory: pane.workingDirectory,
                status: pane.status,
                is_focused: workspace.focusedPaneID === pane.id,
                is_active_workspace: isActiveWorkspace,
                created_at: wireTimestamp(pane.createdAt),
                last_activity_at: wireTimestamp(pane.lastActivityAt),
                label: pane.label ?? undefined,
                title: pane.title ?? undefined,
                git_branch: pane.gitBranch ?? undefined,
                agent_session_id: pane.agentSessionID ?? undefined,
                agent: pane.agentKind ?? undefined,
                background_tasks: pane.backgroundTaskCount,
                file_path: pane.filePath ?? undefined,
                group: group === null ? undefined : { id: group.id, name: group.name }
            })
        );
    }
    return entries;
}
