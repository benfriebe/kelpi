/**
 * Repo-registry lookups for the wire handlers that name a repository: a group's default
 * repository (`group-set-repo`) and the repository a new workspace starts with
 * (`workspace-create`'s `repo`, or its group's default).
 *
 * Spec: docs/app-state-core.md §5.5; docs/socket-handlers.md §6.2, §7.6.
 *
 * The path identity and the register-if-new step are `git/registry.ts`, the same ones the
 * inspector's repo verbs use, so a path resolves to the same registry row whichever verb names it.
 */

import { standardizePath } from '../../git/index.js';
import { ensureRegisteredRepo, findRepoByPath, promoteRepo } from '../../git/registry.js';
import type { DaemonState, Repo, RepoAssociation, WorkspaceGroup } from '../../store/index.js';
import type { AppContext, AppDeps } from './context.js';

/** A group's default repository, or null when it has none (or it left the registry). */
export function groupRepo(state: DaemonState, group: WorkspaceGroup): Repo | null {
    if (group.repoID === null) return null;
    return state.repos.find((repo) => repo.id === group.repoID) ?? null;
}

/** The `{id, name, path}` a reply names a group's repository with. */
export function repoRef(repo: Repo): { id: string; name: string; path: string } {
    return { id: repo.id, name: repo.name, path: repo.path };
}

export type RepoResolution =
    | { readonly ok: true; readonly repo: Repo; readonly worktreeRoot: string }
    | { readonly ok: false; readonly error: string };

/**
 * A registered repo taken AS IS: its own path is the checkout, and nothing is re-resolved. This
 * is how a group's repo and a registry row picked by id are used, because the registry may hold
 * a monorepo subfolder or a linked worktree as a row of its own (Settings ▸ Repositories
 * registers any folder, §GIT-068), and resolving that path to its top level would pick a
 * DIFFERENT repo and register it as a duplicate. The row is promoted to manual on the way
 * (§GIT-068): a group or a workspace now depends on it.
 */
export function registeredRepo(ctx: AppContext, repo: Repo): Extract<RepoResolution, { ok: true }> {
    return { ok: true, repo: promoteRepo(ctx.store, repo), worktreeRoot: repo.path };
}

/**
 * Resolve `rawPath` to a registered repository, registering it when the registry lacks it.
 *
 *   - a path the registry holds EXACTLY (by canonical path) is that row, as is
 *     (`registeredRepo`), whatever git would say its top level is;
 *   - any other path inside a checkout resolves to that checkout's MAIN repository (a linked
 *     worktree registers its parent, the shape `workspace-create --worktree` produces), and
 *     `worktreeRoot` is the checkout the path itself lives in;
 *   - anything else is refused: a group's repository and a workspace's association both have
 *     to be a repository.
 *
 * A repo reached this way was chosen deliberately, so an auto-discovered row is promoted to
 * manual: §GIT-081's GC collects auto-discovered repos whose last association lapses.
 */
export async function resolveRepo(ctx: AppContext, deps: AppDeps, rawPath: string): Promise<RepoResolution> {
    const state = ctx.store.getState();
    const candidate = standardizePath(rawPath, state.homeDirectory);
    const exact = findRepoByPath(state, candidate);
    if (exact !== undefined) return registeredRepo(ctx, exact);

    let root: { worktreeRoot: string; parentRepoRoot: string } | null;
    try {
        root = await deps.git.resolveRepoRoot(candidate);
    } catch {
        root = null;
    }
    if (root === null) return { ok: false, error: `${candidate} is not inside a git repository` };
    const repo = await ensureRegisteredRepo(
        {
            store: ctx.store,
            uuid: deps.uuid,
            now: deps.now,
            getRemoteURL: (repoPath) => deps.git.getRemoteURL(repoPath)
        },
        root.parentRepoRoot,
        { promote: true }
    );
    return { ok: true, repo, worktreeRoot: root.worktreeRoot };
}

/**
 * The association a new workspace starts with for a resolved repository: its checkout, on the
 * branch that checkout is on now (best effort, like the inspector's Add Repository; null when
 * git cannot say), never auto-detected, so §GIT-081's auto-unlink leaves it alone.
 */
export async function associationFor(
    deps: AppDeps,
    resolution: Extract<RepoResolution, { ok: true }>
): Promise<RepoAssociation> {
    let branchName: string | null = null;
    try {
        branchName = await deps.git.getCurrentBranch(resolution.worktreeRoot);
    } catch {
        branchName = null;
    }
    return {
        id: deps.uuid(),
        repoID: resolution.repo.id,
        worktreePath: resolution.worktreeRoot,
        branchName,
        isAutoDetected: false
    };
}
