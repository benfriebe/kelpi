/**
 * The bridge between the store's repo associations and the two git watchers
 * (graft-git.md §8.8, §9.2 downstream pipeline, §9.3 polling backstop).
 *
 * One reconciler subscribed to the store replaces the Swift app's per-call-site bookkeeping:
 * every path that drops an association (workspace delete, bulk delete, group cascade, repo
 * removal, inspector removal, auto-unlink GC) is, from the store's point of view, the same
 * event — the association is gone. So this module diffs the association set on every event
 * batch and, for each one that disappeared, does BOTH things §8.8 demands:
 *
 *   - `stopHeadWatcher(id)`, and
 *   - an unconditional graft `forceStop(id)` — a no-op for ids the engine never knew, and the
 *     only thing standing between issue #231 and a permanently claimed parent root.
 *
 * Newly appearing associations get a HEAD watcher plus an immediate branch/status read, so the
 * sidebar badge does not lag until the 30 s poll.
 */

import type { GitService, RepoGitStatus } from '../git/index.js';
import type { DomainStore } from '../seams.js';
import type {
    DaemonState,
    DomainAction,
    DomainEvent,
    RepoAssociation
} from '../store/index.js';
import { createHeadWatchService, type HeadWatchService } from './head-watcher.js';

/** §9.3: the dirtiness poll that catches edits which never touch HEAD. */
export const GIT_STATUS_POLL_MS = 30_000;

export type AssociationStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

export type AssociationGit = Pick<
    GitService,
    'resolveHeadPath' | 'getStatus' | 'getCurrentBranch'
>;

export interface RepoAssociationWatchService {
    /** Install watchers for the associations already in state and start the poll timer. */
    start(): void;
    /** Re-read branch + status for one association now (also the poll's unit of work). */
    refresh(associationID: string): Promise<void>;
    /** Last known dirtiness for an association; `unknown` until the first read lands. */
    statusFor(associationID: string): RepoGitStatus;
    dispose(): void;
    /** Association ids with a live HEAD watch (diagnostics/tests). */
    watched(): readonly string[];
}

export interface CreateRepoAssociationWatchOptions {
    readonly store: AssociationStore;
    readonly git: AssociationGit;
    /** Only `stop` is used: the unconditional force-stop on every removal path. */
    readonly graft: { stop(associationID: string): Promise<void> };
    /** Debounced full-state save, called when a branch label actually changed. */
    readonly persist?: (() => void) | undefined;
    /** 0 disables the backstop (tests); defaults to 30 s. */
    readonly pollIntervalMs?: number | undefined;
    /** Injected for tests; defaults to the real HEAD-file watcher. */
    readonly headWatch?: HeadWatchService | undefined;
    /**
     * A watched worktree was (re)read — a HEAD change, a new association, or the 30 s poll.
     *
     * The pane-branch producer (§GIT-091, `git/branch.ts`) hangs off this rather than opening a
     * second HEAD watcher on the same files: a `git checkout` in one pane has to move the branch
     * chip in every pane sitting in that tree, and this watcher is already the thing that knows
     * a checkout happened.
     */
    readonly onWorktreeChanged?: ((worktreePath: string) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

interface Located {
    readonly workspaceID: string;
    readonly association: RepoAssociation;
}

function locate(state: DaemonState, associationID: string): Located | null {
    for (const workspace of state.workspaces) {
        for (const association of workspace.repoAssociations) {
            if (association.id === associationID) return { workspaceID: workspace.id, association };
        }
    }
    return null;
}

function associationPaths(state: DaemonState): Map<string, string> {
    const map = new Map<string, string>();
    for (const workspace of state.workspaces) {
        for (const association of workspace.repoAssociations) {
            map.set(association.id, association.worktreePath);
        }
    }
    return map;
}

export function createRepoAssociationWatch(
    options: CreateRepoAssociationWatchOptions
): RepoAssociationWatchService {
    const { store, git, graft } = options;
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };
    const statuses = new Map<string, RepoGitStatus>();
    let tracked = new Map<string, string>();
    let poll: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    const refresh = async (associationID: string): Promise<void> => {
        const found = locate(store.getState(), associationID);
        if (found === null) return;
        const worktreePath = found.association.worktreePath;
        let status: RepoGitStatus;
        try {
            status = await git.getStatus(worktreePath);
        } catch {
            status = { kind: 'unknown' };
        }
        let branch: string | null;
        try {
            branch = await git.getCurrentBranch(worktreePath);
        } catch {
            branch = null;
        }
        if (disposed) return;
        statuses.set(associationID, status);
        // Re-locate: the association may have been removed while git ran.
        const current = locate(store.getState(), associationID);
        if (current === null) return;
        // §GIT-091's trigger: whatever this read learned, the panes inside the tree may need to
        // learn too. Fired before the branch-label dispatch below because it is independent of
        // whether the ASSOCIATION's label changed — a pane can be on a different branch to the
        // association row (a nested worktree), and it still has to re-resolve on a checkout.
        options.onWorktreeChanged?.(worktreePath);
        if (current.association.branchName === branch) return;
        store.dispatch({
            type: 'set-repo-association-branch',
            workspaceID: current.workspaceID,
            associationID,
            branchName: branch
        });
        options.persist?.();
    };

    const headWatch =
        options.headWatch ??
        createHeadWatchService({
            resolveHeadPath: (worktreePath) => git.resolveHeadPath(worktreePath),
            onChanged: (associationID) => {
                void refresh(associationID).catch((error: unknown) => {
                    report(error, `git status refresh ${associationID}`);
                });
            },
            ...(options.onError !== undefined ? { onError: options.onError } : {})
        });

    const watchAssociation = (associationID: string, worktreePath: string): void => {
        void headWatch.start(associationID, worktreePath).catch((error: unknown) => {
            report(error, `head watch ${associationID}`);
        });
        void refresh(associationID).catch((error: unknown) => {
            report(error, `git status refresh ${associationID}`);
        });
    };

    const reconcile = (): void => {
        if (disposed) return;
        const next = associationPaths(store.getState());
        for (const [associationID, worktreePath] of next) {
            const previous = tracked.get(associationID);
            if (previous === worktreePath) continue;
            watchAssociation(associationID, worktreePath);
        }
        for (const associationID of tracked.keys()) {
            if (next.has(associationID)) continue;
            headWatch.stop(associationID);
            statuses.delete(associationID);
            // §8.8: unconditional force-stop. Unknown ids are a cheap no-op; a live session
            // whose association just vanished would otherwise keep the root claimed forever.
            void graft.stop(associationID).catch((error: unknown) => {
                report(error, `graft force-stop ${associationID}`);
            });
        }
        tracked = next;
    };

    return {
        start() {
            if (disposed || unsubscribe !== null) return;
            unsubscribe = store.subscribe(() => {
                reconcile();
            });
            reconcile();
            const interval = options.pollIntervalMs ?? GIT_STATUS_POLL_MS;
            if (interval <= 0) return;
            poll = setInterval(() => {
                // §9.3: the ACTIVE workspace only — polling every repo would be wasteful.
                const state = store.getState();
                const activeID = state.lastActiveWorkspaceID;
                const workspace = state.workspaces.find((candidate) => candidate.id === activeID);
                if (workspace === undefined) return;
                for (const association of workspace.repoAssociations) {
                    void refresh(association.id).catch((error: unknown) => {
                        report(error, `git status poll ${association.id}`);
                    });
                }
            }, interval);
            poll.unref?.();
        },

        refresh,

        statusFor(associationID) {
            return statuses.get(associationID) ?? { kind: 'unknown' };
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe?.();
            unsubscribe = null;
            if (poll !== null) clearInterval(poll);
            poll = null;
            headWatch.stopAll();
        },

        watched() {
            return headWatch.watched();
        }
    };
}
