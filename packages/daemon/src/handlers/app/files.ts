/**
 * `open` (markdown) and `diff` (diff pane) — socket-handlers.md §8.1–§8.2. Both fire-and-forget.
 *
 * Routing is identical for the two: a known caller pane focuses that pane and opens in ITS
 * workspace, otherwise the active workspace takes it, and with no active workspace the message
 * is dropped. Only `open` honours `reuse` (`nex open --here`), which converts the caller's pane
 * in place by parking it; `diff` never reuses.
 *
 * "Known pane" deliberately means a VISIBLE pane (`workspace.panes`) — a parked source pane is
 * not addressable by user commands.
 */

import {
    workspaceByID,
    workspaceContainingVisiblePane,
    type DaemonState
} from '../../store/index.js';
import { forCommand, refreshSyncGroup } from './common.js';
import type { AppContext, AppDeps, AppHandler } from './context.js';

interface Route {
    readonly workspaceID: string;
    /** The caller pane, when it is a live visible pane of that workspace. */
    readonly paneID: string | null;
}

function route(state: DaemonState, paneID: string | undefined): Route | null {
    if (paneID !== undefined) {
        const workspace = workspaceContainingVisiblePane(state, paneID);
        if (workspace !== null) return { workspaceID: workspace.id, paneID };
    }
    const active = state.lastActiveWorkspaceID;
    if (active === null || workspaceByID(state, active) === null) return null;
    return { workspaceID: active, paneID: null };
}

export function fileHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('open', (msg, ctx) => {
            const target = route(ctx.store.getState(), msg.pane_id);
            if (target === null) return;
            if (target.paneID !== null) {
                ctx.store.dispatch({
                    type: 'focus-pane',
                    workspaceID: target.workspaceID,
                    paneID: target.paneID
                });
            }
            ctx.store.dispatch({
                type: 'open-markdown-pane',
                workspaceID: target.workspaceID,
                paneID: deps.uuid(),
                filePath: msg.path,
                now: deps.now(),
                // Reuse only applies to the caller's own pane; the fallback branch never reuses.
                ...(msg.reuse && target.paneID !== null ? { reusePaneID: target.paneID } : {})
            });
            // `--here` parks a shell, which changes the sync broadcast group.
            refreshSyncGroup(ctx, target.workspaceID);
            deps.persist();
        }),
        forCommand('diff', (msg, ctx) => {
            const target = route(ctx.store.getState(), msg.pane_id);
            if (target === null) return;
            if (target.paneID !== null) {
                ctx.store.dispatch({
                    type: 'focus-pane',
                    workspaceID: target.workspaceID,
                    paneID: target.paneID
                });
            }
            ctx.store.dispatch({
                type: 'open-diff-pane',
                workspaceID: target.workspaceID,
                paneID: deps.uuid(),
                repoPath: msg.repo_path,
                now: deps.now(),
                ...(msg.target_path !== undefined ? { targetPath: msg.target_path } : {})
            });
            refreshSyncGroup(ctx, target.workspaceID);
            deps.persist();
        })
    ];
}
