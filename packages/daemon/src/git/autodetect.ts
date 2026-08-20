/**
 * Repo auto-detect (graft-git.md §GIT-074…§GIT-081) — the subsystem that keeps a workspace's
 * repo associations in step with where its panes actually are.
 *
 * Ported from `Nex/AppReducer+RepoGit.swift` (`autoLinkRepoForPane` / `autoLinkResolved` /
 * `autoUnlinkUnusedRepos` + the two scheduling helpers), which the Swift app drives from the
 * pwd-change interception at `AppReducer.swift:2289-2294`. Every timing constant, every
 * re-validation and every "never touch a manual entry" rule below is that file's:
 *
 *   - **500 ms auto-link debounce, per pane, cancel-in-flight** so a burst of `cd`s coalesces
 *     into one git resolution (§GIT-075).
 *   - **Re-validate twice** — once when the debounce fires, once when the async `git rev-parse`
 *     answers — because the user can toggle the setting off, delete the workspace, close the
 *     pane or `cd` back out in between. The second check is an inside-the-worktree test on
 *     standardized paths (exact match or `root + "/"` prefix), so a pane that left the tree
 *     never creates an association (§GIT-076).
 *   - **Register the PARENT repo as auto-discovered** when it is not in the registry, named
 *     after its directory, and resolve its `origin` URL in the background (§GIT-077).
 *   - **Never create a second association** for a worktree root the workspace already has
 *     (§GIT-078), and let the store's association watcher back-fill branch + status + HEAD
 *     watcher for the new row (§GIT-079's downstream half, `graft/associations.ts`).
 *   - **5 s auto-unlink debounce, per workspace** (§GIT-080). It removes only `isAutoDetected`
 *     associations that no longer contain any visible-or-parked pane's directory; a manually
 *     added association is never auto-removed. Graft force-stop and HEAD-watcher teardown for
 *     the vanished rows come from the store reconciler, which is what §GIT-054 asks for.
 *   - **GC auto-discovered repos** left with no association in any workspace; a repo the user
 *     added by hand (`isAutoDiscovered === false`) is never collected (§GIT-081).
 *
 * The gate is the daemon settings' `autoDetectRepos` (`auto-detect-repos` in the config file),
 * read through a callback so a settings change takes effect without re-wiring anything.
 */

import path from 'node:path';

import { standardizePath } from './names.js';
import { canonicalizePath } from '../graft/paths.js';
import type { GitService } from './service.js';
import type {
    DaemonState,
    DomainAction,
    DomainEvent,
    Repo,
    RepoAssociation,
    WorkspaceState
} from '../store/types.js';
import type { DomainStore } from '../seams.js';

/** §GIT-075: coalesce rapid `cd`s before spending a `git rev-parse`. */
export const AUTO_LINK_DEBOUNCE_MS = 500;
/** §GIT-080: a pane that briefly leaves a worktree and comes back keeps its association. */
export const AUTO_UNLINK_DEBOUNCE_MS = 5_000;

export type AutoDetectStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** The two `GitService` members auto-detect needs; the rest is not its business. */
export type AutoDetectGit = Pick<GitService, 'resolveRepoRoot' | 'getRemoteURL'>;

export interface CreateRepoAutoDetectOptions {
    readonly store: AutoDetectStore;
    readonly git: AutoDetectGit;
    /** The `auto-detect-repos` setting, read at every decision point (§GIT-074). */
    readonly enabled: () => boolean;
    readonly uuid: () => string;
    /** Epoch **milliseconds** (the store keeps repo `lastAccessedAt` in seconds). */
    readonly now?: (() => number) | undefined;
    /** Debounced full-state save; a new association must survive a restart. */
    readonly persist?: (() => void) | undefined;
    readonly linkDebounceMs?: number | undefined;
    readonly unlinkDebounceMs?: number | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface RepoAutoDetectService {
    /**
     * A pane reported a new working directory. Schedules the two debounced passes exactly the
     * way the Swift reducer's `paneDirectoryChanged` interception does.
     */
    paneDirectoryChanged(input: { workspaceID: string; paneID: string; directory: string }): void;
    /** Test seam: settle everything currently in flight (timers already fired). */
    idle(): Promise<void>;
    /** Cancel every pending timer; safe to call twice. */
    stop(): void;
}

/**
 * §GIT-076/§GIT-080's containment test.
 *
 * **Canonicalized on both sides, which is a deliberate superset of the Swift original.** There
 * the comparison is `standardizingPath`, which collapses `.`/`..` but does NOT resolve
 * symlinks — so a shell reporting `/var/folders/…/repo` never matches the `/private/var/…/repo`
 * that `git rev-parse` answers with, and auto-detect silently does nothing inside any
 * symlinked tree (every macOS temp directory, and plenty of real setups). Resolving both sides
 * makes the two spellings the same directory, which is what the user means.
 *
 * `home` still expands a `~` in a hand-written association path before resolution.
 */
export function isPathInside(candidate: string, root: string, home = ''): boolean {
    const p = canonicalizePath(standardizePath(candidate, home));
    const r = canonicalizePath(standardizePath(root, home));
    if (p === '' || r === '') return false;
    if (p === r) return true;
    return p.startsWith(`${r}/`);
}

function workspaceOf(state: DaemonState, workspaceID: string): WorkspaceState | undefined {
    return state.workspaces.find((workspace) => workspace.id === workspaceID);
}

function paneDirectory(workspace: WorkspaceState, paneID: string): string | undefined {
    const pane =
        workspace.panes.find((entry) => entry.id === paneID) ??
        workspace.parkedPanes.find((entry) => entry.id === paneID);
    return pane?.workingDirectory;
}

export function createRepoAutoDetect(options: CreateRepoAutoDetectOptions): RepoAutoDetectService {
    const { store, git, enabled, uuid } = options;
    const now = options.now ?? Date.now;
    const linkDebounceMs = options.linkDebounceMs ?? AUTO_LINK_DEBOUNCE_MS;
    const unlinkDebounceMs = options.unlinkDebounceMs ?? AUTO_UNLINK_DEBOUNCE_MS;
    const persist = options.persist;
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const linkTimers = new Map<string, NodeJS.Timeout>();
    const unlinkTimers = new Map<string, NodeJS.Timeout>();
    /** Cancel-in-flight for the ASYNC half: a newer resolve invalidates an older one. */
    const linkGeneration = new Map<string, number>();
    const inFlight = new Set<Promise<void>>();
    let stopped = false;

    const track = (work: Promise<void>): void => {
        inFlight.add(work);
        void work.finally(() => inFlight.delete(work));
    };

    /**
     * §GIT-077's registry half plus §GIT-078's dedupe, run after the git resolution lands and
     * after everything has been re-validated.
     */
    const link = async (workspaceID: string, paneID: string, directory: string): Promise<void> => {
        if (!enabled()) return;
        const before = workspaceOf(store.getState(), workspaceID);
        if (before === undefined) return;
        // The pane must still be where the debounce was scheduled for (§GIT-076 first check).
        if (paneDirectory(before, paneID) !== directory) return;

        const generation = (linkGeneration.get(paneID) ?? 0) + 1;
        linkGeneration.set(paneID, generation);

        let info: Awaited<ReturnType<AutoDetectGit['resolveRepoRoot']>>;
        try {
            info = await git.resolveRepoRoot(directory);
        } catch (error) {
            report(error, 'auto-link resolve');
            return;
        }
        if (info === null) return;
        // Cancel-in-flight: a newer pwd for this pane started its own resolution.
        if (linkGeneration.get(paneID) !== generation || stopped) return;

        // §GIT-076's second check: the setting, the workspace, the pane, and the pane still
        // being INSIDE the resolved worktree.
        if (!enabled()) return;
        const state = store.getState();
        const workspace = workspaceOf(state, workspaceID);
        if (workspace === undefined) return;
        const pwd = paneDirectory(workspace, paneID);
        if (pwd === undefined) return;
        if (!isPathInside(pwd, info.worktreeRoot, state.homeDirectory)) return;

        let repoID: string;
        let addedRepo = false;
        // Canonical comparison: `git rev-parse` answers with the REAL path (`/private/var/…`
        // on macOS) while a hand-registered row usually holds the symlinked one, and matching
        // raw strings would register the same repository twice.
        const parentKey = canonicalizePath(info.parentRepoRoot);
        const existing = state.repos.find((repo) => canonicalizePath(repo.path) === parentKey);
        if (existing !== undefined) {
            repoID = existing.id;
        } else {
            repoID = uuid();
            const repo: Repo = {
                id: repoID,
                path: info.parentRepoRoot,
                name: path.basename(info.parentRepoRoot),
                remoteURL: null,
                lastAccessedAt: now() / 1000,
                // §GIT-081's GC only ever collects rows carrying this flag.
                isAutoDiscovered: true
            };
            store.dispatch({ type: 'add-repo', repo });
            addedRepo = true;
        }

        const alreadyLinked = workspace.repoAssociations.some(
            (association) => association.worktreePath === info.worktreeRoot
        );
        if (!alreadyLinked) {
            const association: RepoAssociation = {
                id: uuid(),
                repoID,
                worktreePath: info.worktreeRoot,
                // Left null: `graft/associations.ts` reads the real branch the moment the
                // association appears, which is §GIT-079's downstream half.
                branchName: null,
                isAutoDetected: true
            };
            store.dispatch({ type: 'add-repo-association', workspaceID, association });
        }

        if (addedRepo) {
            // §GIT-069/§GIT-077: the remote URL is a display value, so it lands whenever it
            // lands and never blocks the association.
            try {
                const remoteURL = await git.getRemoteURL(info.parentRepoRoot);
                if (!stopped && remoteURL !== null) {
                    store.dispatch({ type: 'set-repo-remote-url', id: repoID, remoteURL });
                }
            } catch (error) {
                report(error, 'auto-link remote url');
            }
        }

        if (!alreadyLinked || addedRepo) persist?.();
    };

    /** §GIT-080 + §GIT-081. Synchronous: everything it needs is already in the store. */
    const unlink = (workspaceID: string): void => {
        if (!enabled()) return;
        const state = store.getState();
        const workspace = workspaceOf(state, workspaceID);
        if (workspace === undefined) return;

        const candidates = workspace.repoAssociations.filter((association) => association.isAutoDetected);
        if (candidates.length === 0) return;

        // Visible AND parked panes: a parked pane is still "in" its directory.
        const panePaths = [
            ...workspace.panes.map((pane) => pane.workingDirectory),
            ...workspace.parkedPanes.map((pane) => pane.workingDirectory)
        ];

        const removedRepoIDs = new Set<string>();
        for (const association of candidates) {
            const stillInUse = panePaths.some((pwd) =>
                isPathInside(pwd, association.worktreePath, state.homeDirectory)
            );
            if (stillInUse) continue;
            store.dispatch({
                type: 'remove-repo-association',
                workspaceID,
                associationID: association.id
            });
            removedRepoIDs.add(association.repoID);
        }
        if (removedRepoIDs.size === 0) return;

        // §GIT-081: collect auto-discovered repos nothing references any more. A manual repo
        // (`isAutoDiscovered === false`) is never collected, however unreferenced it is.
        const after = store.getState();
        for (const repoID of removedRepoIDs) {
            const repo = after.repos.find((entry) => entry.id === repoID);
            if (repo === undefined || !repo.isAutoDiscovered) continue;
            const stillReferenced = after.workspaces.some((entry) =>
                entry.repoAssociations.some((association) => association.repoID === repoID)
            );
            if (!stillReferenced) store.dispatch({ type: 'remove-repo', id: repoID });
        }
        persist?.();
    };

    return {
        paneDirectoryChanged({ workspaceID, paneID, directory }) {
            if (stopped) return;
            // The Swift scheduler checks the setting when it SCHEDULES as well as when it
            // fires; with it off, a pwd change costs nothing at all.
            if (!enabled()) return;

            const existingLink = linkTimers.get(paneID);
            if (existingLink !== undefined) clearTimeout(existingLink);
            linkTimers.set(
                paneID,
                setTimeout(() => {
                    linkTimers.delete(paneID);
                    track(
                        link(workspaceID, paneID, directory).catch((error: unknown) => {
                            report(error, 'auto-link');
                        })
                    );
                }, linkDebounceMs)
            );

            const existingUnlink = unlinkTimers.get(workspaceID);
            if (existingUnlink !== undefined) clearTimeout(existingUnlink);
            unlinkTimers.set(
                workspaceID,
                setTimeout(() => {
                    unlinkTimers.delete(workspaceID);
                    try {
                        unlink(workspaceID);
                    } catch (error) {
                        report(error, 'auto-unlink');
                    }
                }, unlinkDebounceMs)
            );
        },

        async idle() {
            while (inFlight.size > 0) await Promise.all([...inFlight]);
        },

        stop() {
            stopped = true;
            for (const timer of linkTimers.values()) clearTimeout(timer);
            for (const timer of unlinkTimers.values()) clearTimeout(timer);
            linkTimers.clear();
            unlinkTimers.clear();
        }
    };
}
