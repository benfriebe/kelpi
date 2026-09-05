/**
 * The graft engine (graft-git.md §4): one-way, tree-based mirroring of a linked worktree's
 * content into its parent checkout's index + working tree.
 *
 * Invariants worth re-reading before touching this file:
 *
 *  1. **The claim is derived, never registered** (§4.1 / issue #231). A parent root is claimed
 *     iff a `start()` is mid-flight for it (`startingRoots`) OR some live session names it.
 *     There is deliberately no busy-roots set: anything holding a claim must be visible via
 *     `activeSessions()` and releasable via `stop()`, or the root becomes permanently
 *     un-graftable with no way for the user to see or clear it.
 *  2. **The parent's HEAD/branch never move.** A sync is `write-tree` in the worktree (through
 *     a throw-away index) + `read-tree --reset -u` in the parent. Untracked parent files
 *     survive; tracked ones are overwritten or removed.
 *  3. **One sync pass at a time per session**, and `stop()` cancels the watcher FIRST, then
 *     awaits the in-flight pass. Without that await, a pass sitting inside `read-tree` would
 *     re-apply the worktree AFTER the parent was restored — corrupting it and breaking the
 *     stash pop.
 *  4. **Concurrent stops coalesce** onto one promise and every awaiter gets its real outcome.
 *  5. The breadcrumb is written BEFORE the first sync and removed only on a clean stop, so a
 *     crash at any point in between is recoverable on the next launch.
 */

import { newUUID, parseUUID } from '@kelpi/core/codec';

import { describeRepoState, type GitService } from '../git/index.js';
import {
    readBreadcrumb,
    removeBreadcrumb,
    writeBreadcrumb,
    type GraftBreadcrumb
} from './breadcrumb.js';
import { describeSyncError, errorText, GraftError } from './errors.js';
import { canonicalizePath, directoryExists, type RealpathFn } from './paths.js';
import type {
    GraftAssociation,
    GraftOrphan,
    GraftSession,
    GraftSessionEvent,
    GraftSessionStatus
} from './types.js';
import { watchRecursive, type RecursiveWatcher, type RecursiveWatchFn } from './watcher.js';

/** §5: a clean shutdown gets this long to unwind every session before breadcrumbs take over. */
export const GRAFT_SHUTDOWN_GRACE_MS = 2_000;

/**
 * How long after the watch attaches to run ONE catch-up sync pass (§9.1).
 *
 * The recursive `fs.watch` is FSEvents on macOS, and an FSEvents stream delivers nothing for
 * a change made before the stream is actually live on libuv's CF thread. `start` publishes the
 * session and replies as soon as the watch is CREATED, so a caller that writes to the worktree
 * the moment `graft start` returns can land inside that window, and the change is then never
 * observed: the session says `watching`, nothing mirrors, and no later event repairs it. Under
 * load the window widens; the compat test that writes immediately after start failed three
 * promotes in a row exactly this way while passing standalone every time. One delayed pass
 * through the serial consumer closes the window at the cost of one extra write-tree/read-tree
 * per session start. The timer is cancelled by `stop` and `shutdown`, because a pass that fired
 * after the restore would re-apply the worktree over the restored parent.
 */
export const GRAFT_WATCH_CATCH_UP_MS = 1_500;

/** The auto-stash message tag, so the stash is identifiable in `git stash list`. */
export function stashMessageFor(associationID: string): string {
    return `kelpi-graft:${associationID}`;
}

/** The git surface graft drives (a `GitService` satisfies it). */
export type GraftGit = Pick<
    GitService,
    | 'resolveRepoRoot'
    | 'repoState'
    | 'getCurrentBranch'
    | 'getHeadSha'
    | 'getStatus'
    | 'stashPushIncludeUntracked'
    | 'stashPopRef'
    | 'writeTreeForWorktree'
    | 'readTreeInto'
    | 'checkoutBranchForce'
    | 'checkoutHeadForce'
    | 'resetHard'
    | 'resetMixed'
>;

export interface GraftService {
    /** Start mirroring `association.worktreePath` into its parent repo. */
    start(association: GraftAssociation): Promise<GraftSession>;
    /**
     * Stop + restore. Idempotent: an id the service never knew still runs the watcher/sync
     * cleanup and then returns quietly, which is what makes the unconditional `forceStop` on
     * every association-removal path safe.
     */
    stop(associationID: string): Promise<void>;
    activeSessions(): readonly GraftSession[];
    session(associationID: string): GraftSession | null;
    /** Subscribe to started/updated/stopped; returns the unsubscribe. */
    updates(listener: (event: GraftSessionEvent) => void): () => void;
    /** Breadcrumbs left by a crashed session, one per given parent root. */
    detectOrphans(parentRepoRoots: readonly string[]): GraftOrphan[];
    /** Replay the stop sequence from breadcrumb data. Failure leaves the breadcrumb. */
    recoverOrphan(orphan: GraftOrphan): Promise<void>;
    /** Delete the breadcrumb only; the stash and the parent are left as they are. */
    dismissOrphan(orphan: GraftOrphan): void;
    /** §5 quit flush: stop everything within the grace period, then drop the watchers. */
    shutdown(): Promise<void>;
    /** Canonical parent roots currently claimed (live sessions ∪ in-flight starts). */
    claimedRoots(): readonly string[];
}

export interface CreateGraftServiceOptions {
    readonly git: GraftGit;
    /** Epoch ms clock (tests). */
    readonly now?: (() => number) | undefined;
    readonly uuid?: (() => string) | undefined;
    /** Injected FS watcher (tests); defaults to the recursive `fs.watch` wrapper. */
    readonly watch?: RecursiveWatchFn | undefined;
    readonly debounceMs?: number | undefined;
    /** Delay before the post-attach catch-up pass (tests); see `GRAFT_WATCH_CATCH_UP_MS`. */
    readonly catchUpMs?: number | undefined;
    readonly shutdownGraceMs?: number | undefined;
    /** Injected `realpath` for canonicalization (tests). */
    readonly realpath?: RealpathFn | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

interface MutableSession {
    readonly id: string;
    readonly worktreePath: string;
    readonly parentRepoRoot: string;
    branch: string;
    status: GraftSessionStatus;
    stashRef: string | null;
    lastSyncAt: number | null;
    preGraftBranch: string | null;
    preGraftSha: string | null;
    worktreePreGraftSha: string | null;
}

interface WatcherEntry {
    readonly watcher: RecursiveWatcher;
    /** A batch arrived while a pass was running; drain it when the pass finishes. */
    pending: boolean;
    /** The one-shot post-attach catch-up pass, until it fires or the session stops. */
    catchUp: ReturnType<typeof setTimeout> | null;
}

function snapshot(session: MutableSession): GraftSession {
    return {
        id: session.id,
        worktreePath: session.worktreePath,
        parentRepoRoot: session.parentRepoRoot,
        branch: session.branch,
        status: session.status,
        stashRef: session.stashRef,
        lastSyncAt: session.lastSyncAt,
        preGraftBranch: session.preGraftBranch,
        preGraftSha: session.preGraftSha,
        worktreePreGraftSha: session.worktreePreGraftSha
    };
}

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

export function createGraftService(options: CreateGraftServiceOptions): GraftService {
    const git = options.git;
    const now = options.now ?? ((): number => Date.now());
    const mintID = options.uuid ?? ((): string => newUUID());
    const graceMs = options.shutdownGraceMs ?? GRAFT_SHUTDOWN_GRACE_MS;
    const catchUpMs = options.catchUpMs ?? GRAFT_WATCH_CATCH_UP_MS;
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };
    const canonical = (value: string): string =>
        options.realpath === undefined
            ? canonicalizePath(value)
            : canonicalizePath(value, options.realpath);

    const sessions = new Map<string, MutableSession>();
    const watchers = new Map<string, WatcherEntry>();
    const activeSync = new Map<string, Promise<void>>();
    const startingRoots = new Set<string>();
    const startTasks = new Map<string, Promise<GraftSession>>();
    const stopTasks = new Map<string, Promise<void>>();
    const subscribers = new Set<(event: GraftSessionEvent) => void>();

    const emit = (event: GraftSessionEvent): void => {
        for (const listener of [...subscribers]) {
            try {
                listener(event);
            } catch (error) {
                report(error, 'graft subscriber');
            }
        }
    };

    const emitUpdated = (session: MutableSession): void => {
        emit({ kind: 'updated', session: snapshot(session) });
    };

    /** §4.1: the claim is a UNION computed on demand, never a stored set. */
    const rootIsClaimed = (root: string): boolean => {
        if (startingRoots.has(root)) return true;
        for (const session of sessions.values()) {
            // `.error` sessions count: they still own the watcher, the claim and the breadcrumb.
            if (session.parentRepoRoot === root) return true;
        }
        return false;
    };

    // ── sync ────────────────────────────────────────────────────────────────

    const runSyncPass = async (worktreePath: string, parentRepoRoot: string): Promise<void> => {
        // The parent must be operation-free: a `git merge` the user started between passes
        // must not be wiped by read-tree.
        const parentState = await git.repoState(parentRepoRoot);
        if (parentState !== 'clean') throw GraftError.repoBusy(describeRepoState(parentState));
        if (!directoryExists(worktreePath)) throw GraftError.missingWorktree(worktreePath);
        // …and so must the worktree, or write-tree would snapshot conflict markers.
        const worktreeState = await git.repoState(worktreePath);
        if (worktreeState !== 'clean') throw GraftError.repoBusy(describeRepoState(worktreeState));

        const tree = await git.writeTreeForWorktree(worktreePath);
        await git.readTreeInto(parentRepoRoot, tree);
    };

    const handleBatch = async (associationID: string): Promise<void> => {
        const session = sessions.get(associationID);
        if (session === undefined) return;
        session.status = { kind: 'syncing' };
        emitUpdated(session);
        try {
            await runSyncPass(session.worktreePath, session.parentRepoRoot);
            session.status = { kind: 'watching' };
            session.lastSyncAt = now();
        } catch (error) {
            // The session STAYS ALIVE: the watcher keeps running and the next batch retries.
            session.status = { kind: 'error', message: describeSyncError(error) };
        }
        emitUpdated(session);
    };

    /** Serial consumer: one pass at a time, a batch that lands mid-pass is drained after. */
    const pump = (associationID: string): void => {
        if (activeSync.has(associationID)) return;
        const entry = watchers.get(associationID);
        if (entry === undefined || !entry.pending) return;
        entry.pending = false;
        const task = handleBatch(associationID);
        activeSync.set(associationID, task);
        void task.then(
            () => {
                // `stop()` may already have taken (and awaited) this entry.
                if (activeSync.get(associationID) === task) activeSync.delete(associationID);
                pump(associationID);
            },
            (error: unknown) => {
                if (activeSync.get(associationID) === task) activeSync.delete(associationID);
                report(error, `graft sync ${associationID}`);
            }
        );
    };

    const startWatcher = (session: MutableSession): void => {
        const watcher = watchRecursive({
            root: session.worktreePath,
            onBatch: () => {
                const entry = watchers.get(session.id);
                if (entry === undefined) return;
                entry.pending = true;
                pump(session.id);
            },
            ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
            ...(options.watch !== undefined ? { watch: options.watch } : {}),
            ...(options.onError !== undefined ? { onError: options.onError } : {})
        });
        const entry: WatcherEntry = { watcher, pending: false, catchUp: null };
        watchers.set(session.id, entry);
        // The catch-up pass (see GRAFT_WATCH_CATCH_UP_MS): a change made before the OS watch
        // went live would otherwise never be seen. Routed through `pending` + `pump` so it is
        // serialised with real batches exactly like one of them.
        const timer = setTimeout(() => {
            const live = watchers.get(session.id);
            if (live !== entry) return; // stopped and possibly restarted in the meantime
            live.catchUp = null;
            live.pending = true;
            pump(session.id);
        }, catchUpMs);
        timer.unref?.();
        entry.catchUp = timer;
    };

    // ── start ───────────────────────────────────────────────────────────────

    const performStart = async (association: GraftAssociation): Promise<GraftSession> => {
        const worktreePath = association.worktreePath;
        const info = await git.resolveRepoRoot(worktreePath);
        if (info === null) throw GraftError.missingWorktree(worktreePath);

        const parentRepoRoot = canonical(info.parentRepoRoot);
        const worktreeRoot = canonical(info.worktreeRoot);
        if (worktreeRoot === parentRepoRoot) throw GraftError.notAWorktree(worktreePath);

        // Claim + check in one synchronous step — no await may split these two lines.
        if (rootIsClaimed(parentRepoRoot)) throw GraftError.alreadyActive(parentRepoRoot);
        startingRoots.add(parentRepoRoot);

        let stashRef: string | null = null;
        let preGraftBranch: string | null = null;
        let preGraftSha: string | null = null;

        /** Every failure after the stash unwinds it before rethrowing the ORIGINAL error. */
        const rollbackAfterStash = async (original: unknown): Promise<never> => {
            if (stashRef !== null) {
                try {
                    await git.stashPopRef(parentRepoRoot, stashRef);
                } catch (popError) {
                    // The user's uncommitted work is now only in the stash: leave a breadcrumb
                    // so the recovery banner can offer to restore it on the next launch.
                    try {
                        writeBreadcrumb(parentRepoRoot, {
                            version: 1,
                            stashed: true,
                            assocId: association.id,
                            stashRef,
                            worktreePath,
                            branch: association.branchName ?? 'HEAD',
                            preGraftBranch,
                            preGraftSha,
                            worktreePreGraftSha: null
                        });
                    } catch (crumbError) {
                        report(crumbError, 'graft breadcrumb (rollback)');
                    }
                    report(popError, 'graft rollback stash pop');
                }
            }
            startingRoots.delete(parentRepoRoot);
            throw original;
        };

        try {
            const parentState = await git.repoState(parentRepoRoot);
            if (parentState !== 'clean') throw GraftError.repoBusy(describeRepoState(parentState));

            // Restore points BEFORE anything is touched.
            preGraftBranch = await git.getCurrentBranch(parentRepoRoot);
            preGraftSha = await git.getHeadSha(parentRepoRoot);

            const status = await git.getStatus(parentRepoRoot);
            if (status.kind === 'dirty') {
                stashRef = await git.stashPushIncludeUntracked(
                    parentRepoRoot,
                    stashMessageFor(association.id)
                );
            }
        } catch (error) {
            // Nothing was stashed yet on this path (or the stash push itself failed): release
            // the claim and surface the failure untouched.
            startingRoots.delete(parentRepoRoot);
            throw error;
        }

        let branch: string;
        try {
            branch =
                (await git.getCurrentBranch(worktreePath)) ?? association.branchName ?? 'HEAD';
        } catch (error) {
            return rollbackAfterStash(error);
        }

        const crumb: GraftBreadcrumb = {
            version: 1,
            stashed: stashRef !== null,
            assocId: association.id,
            stashRef,
            worktreePath,
            branch,
            preGraftBranch,
            preGraftSha,
            // The tree-based design never rewinds the worktree, so this stays null; only a
            // legacy (commit-based) breadcrumb ever carries a value.
            worktreePreGraftSha: null
        };
        try {
            // Written BEFORE the first sync: a crash from here on is recoverable.
            writeBreadcrumb(parentRepoRoot, crumb);
        } catch (error) {
            return rollbackAfterStash(error);
        }

        try {
            await runSyncPass(worktreePath, parentRepoRoot);
        } catch (error) {
            // Nothing is half-grafted on disk, so the breadcrumb would only produce a bogus
            // recovery banner.
            removeBreadcrumb(parentRepoRoot);
            return rollbackAfterStash(error);
        }

        const session: MutableSession = {
            id: association.id,
            worktreePath,
            parentRepoRoot,
            branch,
            status: { kind: 'watching' },
            stashRef,
            lastSyncAt: now(),
            preGraftBranch,
            preGraftSha,
            worktreePreGraftSha: null
        };
        // Publish + transfer the claim in one synchronous step, then register the watcher —
        // no gap a concurrent start could slip through.
        sessions.set(session.id, session);
        startingRoots.delete(parentRepoRoot);
        startWatcher(session);
        emit({ kind: 'started', session: snapshot(session) });
        return snapshot(session);
    };

    const start = (association: GraftAssociation): Promise<GraftSession> => {
        const task = performStart(association);
        startTasks.set(association.id, task);
        const forget = (): void => {
            if (startTasks.get(association.id) === task) startTasks.delete(association.id);
        };
        task.then(forget, forget);
        return task;
    };

    // ── stop ────────────────────────────────────────────────────────────────

    const restoreParent = async (
        parentRepoRoot: string,
        preGraftBranch: string | null,
        preGraftSha: string | null
    ): Promise<void> => {
        if (preGraftSha === null || preGraftSha === '') {
            // Very old breadcrumbs predate the capture: clear working-tree drift only.
            await git.checkoutHeadForce(parentRepoRoot);
            return;
        }
        // "HEAD" = the parent was detached at start; let the reset land on that position.
        if (preGraftBranch !== null && preGraftBranch !== '' && preGraftBranch !== 'HEAD') {
            await git.checkoutBranchForce(parentRepoRoot, preGraftBranch);
        }
        await git.resetHard(parentRepoRoot, preGraftSha);
    };

    const performStop = async (associationID: string): Promise<void> => {
        // Close the documented stop-during-start window (port note 17): let a start that is
        // already in flight publish its session, so this stop tears down a real session
        // instead of leaving an ownerless one behind.
        const starting = startTasks.get(associationID);
        if (starting !== undefined) {
            try {
                await starting;
            } catch {
                // A failed start owns nothing; the cleanup below is still correct.
            }
        }

        // 1. Cancel the watcher FIRST so no new pass can begin. Runs even for unknown ids.
        const entry = watchers.get(associationID);
        watchers.delete(associationID);
        if (entry?.catchUp !== null && entry?.catchUp !== undefined) clearTimeout(entry.catchUp);
        entry?.watcher.close();

        // 2. Await the pass already in flight — a read-tree that survives the cancel would
        //    re-apply the worktree AFTER the restore below.
        const inFlight = activeSync.get(associationID);
        activeSync.delete(associationID);
        if (inFlight !== undefined) {
            try {
                await inFlight;
            } catch (error) {
                report(error, `graft sync ${associationID}`);
            }
        }

        // 3. Unknown id ⇒ a thorough no-op.
        const session = sessions.get(associationID);
        if (session === undefined) return;

        // 4. Legacy breadcrumb recovery only: rewind the worktree's checkpoint commits.
        if (
            session.worktreePreGraftSha !== null &&
            directoryExists(session.worktreePath)
        ) {
            try {
                await git.resetMixed(session.worktreePath, session.worktreePreGraftSha);
            } catch (error) {
                // Best effort — never block the parent restore.
                report(error, `graft worktree rewind ${associationID}`);
            }
        }

        // 5. Restore the parent.
        try {
            await restoreParent(
                session.parentRepoRoot,
                session.preGraftBranch,
                session.preGraftSha
            );
        } catch (error) {
            // LEAVE the breadcrumb: the stash is still on disk and the recovery banner is the
            // user's way back. Drop the session so the root claim is released.
            sessions.delete(associationID);
            emit({ kind: 'stopped', id: associationID });
            throw error;
        }

        // 6. Pop the auto-stash.
        if (session.stashRef !== null) {
            try {
                await git.stashPopRef(session.parentRepoRoot, session.stashRef);
            } catch (error) {
                sessions.delete(associationID);
                emit({ kind: 'stopped', id: associationID });
                throw GraftError.stashPopConflict(session.stashRef, errorText(error));
            }
        }

        // 7. Clean exit.
        removeBreadcrumb(session.parentRepoRoot);
        sessions.delete(associationID);
        emit({ kind: 'stopped', id: associationID });
    };

    const stop = (associationID: string): Promise<void> => {
        // Concurrent stops coalesce: later callers await the SAME task and get its real
        // outcome, so a second initiator never re-runs the restore + stash pop.
        const existing = stopTasks.get(associationID);
        if (existing !== undefined) return existing;
        let task!: Promise<void>;
        task = (async () => {
            try {
                await performStop(associationID);
            } finally {
                if (stopTasks.get(associationID) === task) stopTasks.delete(associationID);
            }
        })();
        stopTasks.set(associationID, task);
        return task;
    };

    // ── orphans ─────────────────────────────────────────────────────────────

    const orphanFrom = (root: string, crumb: GraftBreadcrumb): GraftOrphan => {
        // `UUID(uuidString:)` semantics: a parseable id keeps its (canonical, uppercase)
        // identity so the orphan matches its association; anything else gets a fresh one.
        const id = parseUUID(crumb.assocId) ?? mintID();
        return {
            id,
            parentRepoRoot: root,
            worktreePath: crumb.worktreePath,
            branch: crumb.branch,
            stashRef: crumb.stashRef,
            preGraftBranch: crumb.preGraftBranch,
            preGraftSha: crumb.preGraftSha,
            worktreePreGraftSha: crumb.worktreePreGraftSha
        };
    };

    return {
        start,
        stop,

        activeSessions() {
            return [...sessions.values()].map(snapshot);
        },

        session(associationID) {
            const found = sessions.get(associationID);
            return found === undefined ? null : snapshot(found);
        },

        updates(listener) {
            subscribers.add(listener);
            return () => {
                subscribers.delete(listener);
            };
        },

        detectOrphans(parentRepoRoots) {
            const seen = new Set<string>();
            const orphans: GraftOrphan[] = [];
            for (const raw of parentRepoRoots) {
                const root = canonical(raw);
                if (root === '' || seen.has(root)) continue;
                seen.add(root);
                const crumb = readBreadcrumb(root);
                if (crumb === null) continue;
                orphans.push(orphanFrom(root, crumb));
            }
            return orphans;
        },

        async recoverOrphan(orphan) {
            if (orphan.worktreePreGraftSha !== null && directoryExists(orphan.worktreePath)) {
                try {
                    await git.resetMixed(orphan.worktreePath, orphan.worktreePreGraftSha);
                } catch (error) {
                    report(error, `graft orphan worktree rewind ${orphan.id}`);
                }
            }
            // Any failure below leaves the breadcrumb on disk so recovery can be retried.
            await restoreParent(orphan.parentRepoRoot, orphan.preGraftBranch, orphan.preGraftSha);
            if (orphan.stashRef !== null) {
                try {
                    await git.stashPopRef(orphan.parentRepoRoot, orphan.stashRef);
                } catch (error) {
                    throw GraftError.stashPopConflict(orphan.stashRef, errorText(error));
                }
            }
            removeBreadcrumb(orphan.parentRepoRoot);
        },

        dismissOrphan(orphan) {
            removeBreadcrumb(orphan.parentRepoRoot);
        },

        async shutdown() {
            const ids = [...sessions.keys()];
            if (ids.length > 0) {
                await Promise.race([
                    Promise.allSettled(ids.map((id) => stop(id))),
                    delay(graceMs)
                ]);
            }
            // Whatever could not finish in time falls back to breadcrumb recovery; the OS
            // watches must still go, or the process cannot exit.
            for (const [id, entry] of [...watchers]) {
                if (entry.catchUp !== null) clearTimeout(entry.catchUp);
                entry.watcher.close();
                watchers.delete(id);
            }
        },

        claimedRoots() {
            const roots = new Set<string>(startingRoots);
            for (const session of sessions.values()) roots.add(session.parentRepoRoot);
            return [...roots];
        }
    };
}
