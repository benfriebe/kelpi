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

import path from 'node:path';

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

/**
 * §CONT-130 / §CONT-131: a relative path resolves against the **originating pane's** working
 * directory, then the target workspace's **focused pane's**, and is otherwise left exactly as
 * it came (`AppReducer+SearchNotify.swift:110-126`, `AppReducer.swift:2468-2494`).
 *
 * The `nex` CLI absolutises before it sends (`cli/src/commands/openmd.ts`), so this chain is
 * inert for the common path and deliberately stays that way — it is what makes a RAW socket
 * client, the shell's `open-file` forward and a hand-written `{"command":"open"}` behave like
 * the Swift app instead of resolving against the *daemon's* cwd, which is whatever directory
 * `nexd` happened to be launched from and is never what the caller meant.
 *
 * One deliberate widening of the Swift chain: a `~`-prefixed path is left alone rather than
 * appended to a cwd. `NSString.appendingPathComponent` produces `<cwd>/~/x` there, a path that
 * cannot exist; handing it to the opener untouched is the only reading that is ever right.
 */
function resolveAgainstPane(state: DaemonState, target: Route, filePath: string): string {
    if (filePath === '' || path.isAbsolute(filePath) || filePath.startsWith('~')) return filePath;
    const workspace = workspaceByID(state, target.workspaceID);
    if (workspace === null) return filePath;
    const cwdOf = (paneID: string | null): string | null => {
        if (paneID === null) return null;
        const directory = workspace.panes.find((entry) => entry.id === paneID)?.workingDirectory;
        return typeof directory === 'string' && directory.length > 0 ? directory : null;
    };
    const cwd = cwdOf(target.paneID) ?? cwdOf(workspace.focusedPaneID);
    return cwd === null ? filePath : path.join(cwd, filePath);
}

export function fileHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('open', (msg, ctx) => {
            const state = ctx.store.getState();
            const target = route(state, msg.pane_id);
            if (target === null) return;
            const filePath = resolveAgainstPane(state, target, msg.path);
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
                filePath,
                now: deps.now(),
                // Reuse only applies to the caller's own pane; the fallback branch never reuses.
                ...(msg.reuse && target.paneID !== null ? { reusePaneID: target.paneID } : {})
            });
            // `--here` parks a shell, which changes the sync broadcast group.
            refreshSyncGroup(ctx, target.workspaceID);
            deps.persist();
        }),
        forCommand('diff', (msg, ctx) => {
            const state = ctx.store.getState();
            const target = route(state, msg.pane_id);
            if (target === null) return;
            // §CONT-131: the repo path and the optional scope both go through the same chain —
            // `nex diff ../other` names a sibling checkout, not a directory under `nexd`'s cwd.
            const repoPath = resolveAgainstPane(state, target, msg.repo_path);
            const targetPath =
                msg.target_path === undefined
                    ? undefined
                    : resolveAgainstPane(state, target, msg.target_path);
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
                repoPath,
                now: deps.now(),
                ...(targetPath !== undefined ? { targetPath } : {})
            });
            refreshSyncGroup(ctx, target.workspaceID);
            deps.persist();
        })
    ];
}
