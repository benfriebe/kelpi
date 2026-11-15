/**
 * The daemon's side of a scan: which pane each shell pid belongs to, which folders each
 * workspace owns, and which folders count as "a worktree that no workspace owns".
 */

import { resolvedWorktreeBasePath } from '../git/names.js';
import type { DaemonState } from '../store/index.js';
import type { ScanContext } from './scanner.js';
import type { PaneShellRef, WorkspaceFolders } from './types.js';

export interface ScanContextSources {
    readonly state: DaemonState;
    /** The live shell pid of a pane, if it has one (`KelpiPtyManager.pid`). */
    readonly panePid: (paneID: string) => number | undefined;
    /** The worktree base path setting, e.g. `~/kelpi/worktrees/<repo>`. */
    readonly worktreeBasePath: string;
    readonly home: string;
    readonly realpath: (path: string) => string;
    readonly selfPids: ReadonlySet<number>;
    readonly workspaceOrder: readonly string[];
}

/**
 * Every pane's shell pid, visible and parked (a tab's panes all live in `panes`), and its pane.
 * The scan attributes through them and a stop never signals one, so both read this one walk.
 */
export function paneShellPids(state: ScanContextSources['state'], panePid: (paneID: string) => number | undefined): Map<number, PaneShellRef> {
    const paneShells = new Map<number, PaneShellRef>();
    for (const workspace of state.workspaces) {
        for (const pane of [...workspace.panes, ...workspace.parkedPanes]) {
            const pid = panePid(pane.id);
            if (pid !== undefined && pid > 0) paneShells.set(pid, { paneID: pane.id, workspaceID: workspace.id });
        }
    }
    return paneShells;
}

export function buildScanContext(sources: ScanContextSources): ScanContext {
    const { state, realpath } = sources;
    const paneShells = paneShellPids(state, sources.panePid);
    const workspaces: WorkspaceFolders[] = state.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        folders: [...new Set(workspace.repoAssociations.map((association) => realpath(association.worktreePath)))]
    }));
    // Each known repo and the folder its worktrees are created in, resolved from the template the
    // way `workspace create --worktree` resolves it (`<repo>` anywhere, or as a leading token).
    const knownFolders = [
        ...new Set(
            state.repos.flatMap((repo) => [
                realpath(resolvedWorktreeBasePath(sources.worktreeBasePath, repo.path, sources.home)),
                realpath(repo.path)
            ])
        )
    ];
    const worktreeBases = [
        ...new Set(state.repos.map((repo) => realpath(resolvedWorktreeBasePath(sources.worktreeBasePath, repo.path, sources.home))))
    ];
    return { paneShells, workspaces, knownFolders, worktreeBases, selfPids: sources.selfPids, workspaceOrder: sources.workspaceOrder };
}
