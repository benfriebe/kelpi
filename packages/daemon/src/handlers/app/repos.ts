/**
 * Repo-registry lookups shared by the wire handlers that name a repository by PATH: a group's
 * default repository (`group-set-repo`) and the repository a new workspace starts with
 * (`workspace-create`'s `repo`, or its group's default).
 *
 * Spec: docs/app-state-core.md §5.5; docs/socket-handlers.md §6.2, §7.6.
 *
 * The comparison is the one the inspector's verbs use (`ws/repos.ts` ▸ `repoKey`): standardized
 * AND symlink-resolved, because git answers with the physical path (`/private/var/…`) while a
 * path a user typed or picked is usually the logical one (`/var/…`), and comparing raw strings
 * would register the same checkout twice.
 */

import path from 'node:path';

import { standardizePath } from '../../git/index.js';
import { canonicalizeUserPath } from '../../graft/index.js';
import type { DaemonState, Repo, RepoAssociation, WorkspaceGroup } from '../../store/index.js';
import type { AppContext, AppDeps } from './context.js';

function repoKey(value: string, home: string): string {
    return canonicalizeUserPath(value, home);
}

/** The registered repo at `candidate`, by canonical path; undefined when none is. */
export function findRegisteredRepo(state: DaemonState, candidate: string): Repo | undefined {
    const home = state.homeDirectory;
    const key = repoKey(candidate, home);
    return state.repos.find((repo) => repoKey(repo.path, home) === key);
}

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
 * Resolve `rawPath` to a registered repository, registering it when the registry lacks it.
 *
 *   - a path inside a checkout resolves to that checkout's MAIN repository (a linked worktree
 *     registers its parent, the shape `workspace-create --worktree` produces), and
 *     `worktreeRoot` is the checkout the path itself lives in;
 *   - a path the registry already holds is accepted even when git cannot read it (Settings ▸
 *     Repositories registers any folder, §GIT-068), with `worktreeRoot` its own path;
 *   - anything else is refused: a group's repository and a workspace's association both have
 *     to be a repository.
 *
 * A repo reached this way was chosen deliberately, so an auto-discovered row is promoted to
 * manual (§GIT-068): §GIT-081's GC collects auto-discovered repos whose last association
 * lapses, and would otherwise take a group's default repository with it.
 */
export async function resolveRepo(ctx: AppContext, deps: AppDeps, rawPath: string): Promise<RepoResolution> {
    const state = ctx.store.getState();
    const candidate = standardizePath(rawPath, state.homeDirectory);
    let root: { worktreeRoot: string; parentRepoRoot: string } | null;
    try {
        root = await deps.git.resolveRepoRoot(candidate);
    } catch {
        root = null;
    }
    if (root === null) {
        const registered = findRegisteredRepo(ctx.store.getState(), candidate);
        if (registered === undefined) return { ok: false, error: `${candidate} is not inside a git repository` };
        return { ok: true, repo: promoted(ctx, registered), worktreeRoot: registered.path };
    }

    const existing = findRegisteredRepo(ctx.store.getState(), root.parentRepoRoot);
    if (existing !== undefined) {
        return { ok: true, repo: promoted(ctx, existing), worktreeRoot: root.worktreeRoot };
    }
    let remoteURL: string | null = null;
    try {
        remoteURL = await deps.git.getRemoteURL(root.parentRepoRoot);
    } catch {
        remoteURL = null;
    }
    // Re-checked after the await: a concurrent registration of the same path must not add a
    // second row for it.
    const raced = findRegisteredRepo(ctx.store.getState(), root.parentRepoRoot);
    if (raced !== undefined) return { ok: true, repo: promoted(ctx, raced), worktreeRoot: root.worktreeRoot };
    const repo: Repo = {
        id: deps.uuid(),
        path: root.parentRepoRoot,
        name: path.basename(root.parentRepoRoot),
        remoteURL,
        lastAccessedAt: deps.now() / 1000,
        isAutoDiscovered: false
    };
    ctx.store.dispatch({ type: 'add-repo', repo });
    return { ok: true, repo, worktreeRoot: root.worktreeRoot };
}

function promoted(ctx: AppContext, repo: Repo): Repo {
    if (!repo.isAutoDiscovered) return repo;
    ctx.store.dispatch({ type: 'set-repo-auto-discovered', id: repo.id, isAutoDiscovered: false });
    return { ...repo, isAutoDiscovered: false };
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
