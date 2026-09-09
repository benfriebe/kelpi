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
    /** Forget answers from the previous Git provider, rebind HEAD watches, and refresh. */
    invalidate(): void;
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

interface PendingRefresh {
    readonly sequence: number;
    readonly found: Located;
    /** The read itself, excluding any wait for a newer read. */
    readonly done: Promise<void>;
    readonly retired: Promise<void>;
    retire(): void;
}

function locate(state: DaemonState, associationID: string): Located | null {
    for (const workspace of state.workspaces) {
        for (const association of workspace.repoAssociations) {
            if (association.id === associationID) return { workspaceID: workspace.id, association };
        }
    }
    return null;
}

function associations(state: DaemonState): Map<string, Located> {
    const map = new Map<string, Located>();
    for (const workspace of state.workspaces) {
        for (const association of workspace.repoAssociations) {
            map.set(association.id, { workspaceID: workspace.id, association });
        }
    }
    return map;
}

function sameAssociation(left: Located, right: Located): boolean {
    return left.workspaceID === right.workspaceID &&
        left.association.repoID === right.association.repoID &&
        left.association.worktreePath === right.association.worktreePath;
}

export function createRepoAssociationWatch(
    options: CreateRepoAssociationWatchOptions
): RepoAssociationWatchService {
    const { store, git, graft } = options;
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };
    const statuses = new Map<string, RepoGitStatus>();
    const requests = new Map<string, number>();
    const pending = new Map<string, PendingRefresh>();
    let requestSequence = 0;
    let tracked = new Map<string, Located>();
    let poll: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;
    let invalidating = false;

    const retirePending = (associationID: string): void => {
        pending.get(associationID)?.retire();
        pending.delete(associationID);
    };

    const readAssociation = async (associationID: string, found: Located, request: number): Promise<void> => {
        const currentAssociation = (): Located | null => {
            if (disposed || requests.get(associationID) !== request) return null;
            const current = locate(store.getState(), associationID);
            return current !== null && sameAssociation(found, current) ? current : null;
        };
        const worktreePath = found.association.worktreePath;
        let status: RepoGitStatus;
        try {
            status = await git.getStatus(worktreePath);
        } catch {
            status = { kind: 'unknown' };
        }
        // Native status/branch reads cannot be aborted. A newer refresh, provider switch,
        // or association removal retires this request before it can publish an old answer.
        if (currentAssociation() === null) return;
        let branch: string | null;
        try {
            branch = await git.getCurrentBranch(worktreePath);
        } catch {
            branch = null;
        }
        let current = currentAssociation();
        if (current === null) return;
        statuses.set(associationID, status);
        // §GIT-091's trigger: whatever this read learned, the panes inside the tree may need to
        // learn too. Fired before the branch-label dispatch below because it is independent of
        // whether the ASSOCIATION's label changed — a pane can be on a different branch to the
        // association row (a nested worktree), and it still has to re-resolve on a checkout.
        options.onWorktreeChanged?.(worktreePath);
        current = currentAssociation();
        if (current === null) return;
        if (current.association.branchName === branch) return;
        store.dispatch({
            type: 'set-repo-association-branch',
            workspaceID: current.workspaceID,
            associationID,
            branchName: branch
        });
        options.persist?.();
    };

    const refresh = async (associationID: string): Promise<void> => {
        if (disposed) return;
        const found = locate(store.getState(), associationID);
        if (found === null) return;
        const sequence = ++requestSequence;
        requests.set(associationID, sequence);
        retirePending(associationID);
        let complete!: () => void;
        let fail!: (error: unknown) => void;
        let retire!: () => void;
        const done = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
        const retired = new Promise<void>(resolve => { retire = resolve; });
        const request: PendingRefresh = { sequence, found, done, retired, retire };
        // Register before calling Git: provider/lifecycle callbacks can start another read.
        pending.set(associationID, request);
        void readAssociation(associationID, found, sequence).then(complete, fail);
        try {
            // A superseded caller can follow the current read even if its own native
            // process has not finished; that old process still cannot publish a result.
            await Promise.race([done, retired]);
        } finally {
            if (pending.get(associationID) === request) retirePending(associationID);
        }

        // A CLI/UI refresh is a promise of current data. If its own answer was retired,
        // join a newer applicable read before the caller inspects statusFor(). Wait only
        // for raw reads with increasing sequence numbers, never another refresh's join.
        let joined = sequence;
        while (!disposed) {
            const current = locate(store.getState(), associationID);
            const newest = pending.get(associationID);
            if (current === null || !sameAssociation(found, current) || newest === undefined ||
                newest.sequence <= joined || !sameAssociation(found, newest.found)) return;
            joined = newest.sequence;
            // If this intermediate read is superseded or removed, follow the next one
            // immediately instead of waiting for an obsolete native process to finish.
            await Promise.race([newest.done, newest.retired]);
        }
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

    const reconcile = (restart = false): void => {
        if (disposed || invalidating) return;
        const previous = tracked;
        const next = associations(store.getState());
        tracked = next;
        for (const [associationID, found] of next) {
            const before = previous.get(associationID);
            if (!restart && before !== undefined && sameAssociation(before, found)) continue;
            requests.delete(associationID);
            retirePending(associationID);
            statuses.delete(associationID);
            watchAssociation(associationID, found.association.worktreePath);
        }
        for (const associationID of previous.keys()) {
            if (next.has(associationID)) continue;
            requests.delete(associationID);
            retirePending(associationID);
            headWatch.stop(associationID);
            statuses.delete(associationID);
            // §8.8: unconditional force-stop. Unknown ids are a cheap no-op; a live session
            // whose association just vanished would otherwise keep the root claimed forever.
            void graft.stop(associationID).catch((error: unknown) => {
                report(error, `graft force-stop ${associationID}`);
            });
        }
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

        invalidate() {
            if (disposed) return;
            requests.clear();
            for (const associationID of pending.keys()) retirePending(associationID);
            statuses.clear();
            headWatch.stopAll();
            invalidating = true;
            let changed = false;
            try {
                for (const [associationID, found] of associations(store.getState())) {
                    const current = locate(store.getState(), associationID);
                    if (current === null || !sameAssociation(found, current) ||
                        current.association.branchName === null) continue;
                    store.dispatch({
                        type: 'set-repo-association-branch',
                        workspaceID: current.workspaceID,
                        associationID,
                        branchName: null
                    });
                    changed = true;
                }
            } finally {
                invalidating = false;
            }
            if (changed) options.persist?.();
            if (unsubscribe !== null) reconcile(true);
        },

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
            requests.clear();
            for (const associationID of pending.keys()) retirePending(associationID);
            statuses.clear();
            tracked.clear();
        },

        watched() {
            return headWatch.watched();
        }
    };
}
