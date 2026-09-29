/**
 * The repo registry's path identity and its one "register if new" step, shared by every verb that
 * names a repository by PATH: the inspector's repo verbs (`ws/repos.ts`), a group's default
 * repository (`group-set-repo`) and the repository a new workspace starts with
 * (`workspace-create`), both in `handlers/app/repos.ts`.
 *
 * Spec: docs/graft-git.md §GIT-068, §GIT-103; docs/app-state-core.md §5.5.
 *
 * Deliberately not re-exported from `git/index.ts`: it reads `graft/paths.ts`, which itself
 * imports the git barrel, and a barrel export would close that loop.
 */

import path from 'node:path';

import { canonicalizeUserPath } from '../graft/paths.js';
import type { DomainStore } from '../seams.js';
import type { DaemonState, DomainAction, DomainEvent, Repo } from '../store/types.js';

export type RegistryStore = Pick<DomainStore<DaemonState, DomainAction, DomainEvent>, 'getState' | 'dispatch'>;

/**
 * The identity a registry lookup compares on: standardized AND symlink-resolved.
 *
 * `git rev-parse` always answers with the real path (`/private/var/…` on macOS), while a path
 * the user typed, dropped or scanned is usually the symlinked one (`/var/…`). Comparing the
 * raw strings registers the same repository twice (one row from Add/Scan and another from the
 * association flow), and then a Remove only cascades one of them.
 */
export function repoKey(value: string, home: string): string {
    return canonicalizeUserPath(value, home);
}

/** The registered repo at `value`, by canonical path; undefined when none is. */
export function findRepoByPath(state: DaemonState, value: string): Repo | undefined {
    const home = state.homeDirectory;
    const key = repoKey(value, home);
    return state.repos.find((repo) => repoKey(repo.path, home) === key);
}

/**
 * §GIT-068 / §GIT-103: a repo reached by a deliberate act is kept. An auto-discovered row is
 * promoted to manual, so §GIT-081's GC can never collect it (and with it, anything that points
 * at it, such as a group's default repository).
 */
export function promoteRepo(store: RegistryStore, repo: Repo): Repo {
    if (!repo.isAutoDiscovered) return repo;
    store.dispatch({ type: 'set-repo-auto-discovered', id: repo.id, isAutoDiscovered: false });
    return { ...repo, isAutoDiscovered: false };
}

export interface RegisterRepoDeps {
    readonly store: RegistryStore;
    readonly uuid: () => string;
    /** Epoch MILLISECONDS; the registry stores seconds. */
    readonly now: () => number;
    /** Best effort: a repo without an `origin` is normal. */
    readonly getRemoteURL: (repoPath: string) => Promise<string | null>;
}

/**
 * The registered repo at `repoPath` (already standardized), registering it when new. A repo
 * reached through here is a deliberate one, so a new row is never auto-discovered; an existing
 * row is promoted only when `promote` says so (the plain association add is not the deliberate
 * act the Swift promotes on, §GIT-103).
 *
 * The registry is re-read after the remote-URL await: a concurrent registration of the same
 * path (two creates racing) must not add a second row for it.
 */
export async function ensureRegisteredRepo(
    deps: RegisterRepoDeps,
    repoPath: string,
    options: { readonly promote?: boolean } = {}
): Promise<Repo> {
    const keep = (repo: Repo): Repo => (options.promote === true ? promoteRepo(deps.store, repo) : repo);
    const existing = findRepoByPath(deps.store.getState(), repoPath);
    if (existing !== undefined) return keep(existing);
    let remoteURL: string | null = null;
    try {
        remoteURL = await deps.getRemoteURL(repoPath);
    } catch {
        remoteURL = null;
    }
    const raced = findRepoByPath(deps.store.getState(), repoPath);
    if (raced !== undefined) return keep(raced);
    const repo: Repo = {
        id: deps.uuid(),
        path: repoPath,
        name: path.basename(repoPath),
        remoteURL,
        lastAccessedAt: deps.now() / 1000,
        isAutoDiscovered: false
    };
    deps.store.dispatch({ type: 'add-repo', repo });
    return repo;
}
