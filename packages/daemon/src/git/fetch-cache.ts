/**
 * One default-branch fetch per repository, shared between the New Workspace sheet's prefetch and
 * the worktree creates that follow it (issue #294, graft-git.md §8.5.1).
 *
 * The sheet asks for a prefetch (`repo-prefetch`) the moment it shows a worktree off latest main,
 * so by the time Create is pressed the network round trip is usually over. This module is what
 * makes that pay off, and what keeps it from being abused:
 *
 *   - **one fetch per repo at a time.** A prefetch while one is running is a no-op, and a create
 *     while one is running WAITS for it (`joined`) instead of starting a second;
 *   - **a finished fetch is reused for `reuseMs` (60 s)** by a create for the same remote and
 *     branch (`reused`), which is the create's fetch skipped outright; older than that, or a
 *     different branch, and the create fetches for itself;
 *   - **a prefetch is rate-limited per repo**: none starts within `minIntervalMs` (10 s) of the
 *     previous start, whatever that one's outcome, so a client cannot turn the verb into a fetch
 *     loop. Creates are never rate-limited (they are the user's own request);
 *   - **a failed prefetch is silent**: it is logged, remembered only for the rate limit, and the
 *     create that follows fetches for itself and reports its own error;
 *   - **a prefetch is bounded** (`prefetchTimeoutMs`) and never prompts for credentials, since
 *     nobody asked for it interactively (`BACKGROUND_GIT_ENV`, on its `ls-remote` too);
 *   - **a joined wait is bounded** (`joinTimeoutMs`): a CLI create's own fetch has no signal or
 *     timeout, so a create joining a hung one stops waiting after 120 s and fetches for itself.
 *
 * A create that joins a fetch it did not start does not own it: cancelling the create stops the
 * WAIT, never the shared fetch. A create's OWN fetch is registered here too, so a second create
 * joins it; cancelling its owner kills it, and the joiner then fetches for itself.
 *
 * Entries are keyed by the resolved repo path and pruned once they are older than `reuseMs` and
 * past the rate limit, so the map holds at most one small record per recently used repository.
 */

import path from 'node:path';

import type { GitProgress } from './progress.js';
import {
    describeDefaultBranchSource,
    fetchDefaultBranch,
    fetchWithRenameFallback,
    resolveDefaultBranch,
    WorktreeCreateCancelledError,
    type DefaultBranchFetches,
    type FetchForCreateInput,
    type FetchForCreateOutcome,
    type WorktreeGitOps
} from './worktree-add.js';

export const PREFETCH_REUSE_MS = 60_000;
export const PREFETCH_MIN_INTERVAL_MS = 10_000;
export const PREFETCH_TIMEOUT_MS = 120_000;
/**
 * The longest a create WAITS on a fetch it joined before fetching for itself. A CLI create's
 * own fetch has neither a signal nor a timeout (its caller waits as long as git takes), so a
 * create that joined a hung one must not be stuck with it.
 */
export const JOIN_TIMEOUT_MS = 120_000;

/**
 * Nobody is at a prompt for a background fetch, so none may be shown: no terminal prompt, no
 * Git Credential Manager dialog, no ssh askpass. `GIT_SSH_COMMAND` / `core.sshCommand` are left
 * alone (a user's own ssh setup must keep working). Foreground creates keep their environment.
 */
export const BACKGROUND_GIT_ENV: Readonly<Record<string, string>> = {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    SSH_ASKPASS_REQUIRE: 'never'
};

export type PrefetchResult = 'started' | 'in-flight' | 'recent' | 'rate-limited';

export interface DefaultBranchFetchCache extends DefaultBranchFetches {
    /** Start a background fetch of `repoPath`'s default branch, unless the rules above say not. */
    prefetch(repoPath: string, remote?: string): PrefetchResult;
    /** Test and diagnostics view of one repo's record. */
    peek(repoPath: string): FetchRecordView | null;
}

export interface FetchRecordView {
    readonly origin: 'prefetch' | 'create';
    readonly remote: string;
    readonly branch: string | null;
    readonly startedAt: number;
    readonly finishedAt: number | null;
    readonly ok: boolean | null;
}

interface FetchRecord {
    readonly origin: 'prefetch' | 'create';
    readonly remote: string;
    /** Known once the prefetch has resolved the default branch; a create knows it up front. */
    branch: string | null;
    readonly startedAt: number;
    finishedAt: number | null;
    ok: boolean | null;
    /** Settles when the fetch does; never rejects (the outcome is `ok`). */
    readonly settled: Promise<void>;
    readonly listeners: Set<(progress: GitProgress) => void>;
}

export interface CreateFetchCacheOptions {
    readonly ops: WorktreeGitOps;
    readonly log?: ((message: string) => void) | undefined;
    readonly now?: (() => number) | undefined;
    readonly reuseMs?: number | undefined;
    readonly minIntervalMs?: number | undefined;
    readonly prefetchTimeoutMs?: number | undefined;
    readonly joinTimeoutMs?: number | undefined;
}

function keyOf(repoPath: string): string {
    return path.resolve(repoPath);
}

const TIMED_OUT = Symbol('timed out');

/** `promise`, or `TIMED_OUT` once `ms` have passed without it settling. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    return new Promise<T | typeof TIMED_OUT>((resolve, reject) => {
        const timer = setTimeout(() => resolve(TIMED_OUT), ms);
        timer.unref?.();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (signal === undefined) return promise;
    if (signal.aborted) return Promise.reject(new Error('aborted'));
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(new Error('aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        );
    });
}

export function createDefaultBranchFetchCache(options: CreateFetchCacheOptions): DefaultBranchFetchCache {
    const { ops } = options;
    const log = options.log ?? ((): void => {});
    const now = options.now ?? (() => Date.now());
    const reuseMs = options.reuseMs ?? PREFETCH_REUSE_MS;
    const minIntervalMs = options.minIntervalMs ?? PREFETCH_MIN_INTERVAL_MS;
    const prefetchTimeoutMs = options.prefetchTimeoutMs ?? PREFETCH_TIMEOUT_MS;
    const joinTimeoutMs = options.joinTimeoutMs ?? JOIN_TIMEOUT_MS;
    const records = new Map<string, FetchRecord>();

    const prune = (): void => {
        const at = now();
        for (const [key, record] of records) {
            if (record.finishedAt === null) continue;
            if (at - record.finishedAt >= reuseMs && at - record.startedAt >= minIntervalMs) records.delete(key);
        }
    };

    /** Register a fetch as THE fetch for `key`, run it, and record its outcome. */
    const track = (
        key: string,
        origin: 'prefetch' | 'create',
        remote: string,
        branch: string | null,
        run: (record: FetchRecord) => Promise<void>
    ): { record: FetchRecord; done: Promise<void> } => {
        let finish: () => void = () => {};
        const settled = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const record: FetchRecord = {
            origin,
            remote,
            branch,
            startedAt: now(),
            finishedAt: null,
            ok: null,
            settled,
            listeners: new Set()
        };
        records.set(key, record);
        const done = run(record).then(
            () => {
                record.ok = true;
                record.finishedAt = now();
                finish();
            },
            (error: unknown) => {
                record.ok = false;
                record.finishedAt = now();
                finish();
                throw error;
            }
        );
        return { record, done };
    };

    const broadcast = (record: FetchRecord) => (progress: GitProgress) => {
        for (const listener of record.listeners) listener(progress);
    };

    return {
        prefetch(repoPath, remote = 'origin') {
            prune();
            const key = keyOf(repoPath);
            const existing = records.get(key);
            if (existing !== undefined) {
                if (existing.finishedAt === null) return 'in-flight';
                if (now() - existing.startedAt < minIntervalMs) return 'rate-limited';
                if (existing.ok === true && now() - existing.finishedAt < reuseMs) return 'recent';
            }
            const { done } = track(key, 'prefetch', remote, null, async (record) => {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), prefetchTimeoutMs);
                timer.unref?.();
                try {
                    const resolved = await resolveDefaultBranch(ops, repoPath, remote, controller.signal, BACKGROUND_GIT_ENV);
                    record.branch = resolved.branch;
                    log(`worktree-prefetch: fetching ${remote}/${resolved.branch} for ${repoPath} (default branch ${describeDefaultBranchSource(resolved, remote)})`);
                    // The same stale-origin/HEAD recovery a create gets (worktree-add.ts).
                    const fetched = await fetchWithRenameFallback(
                        ops,
                        repoPath,
                        remote,
                        resolved,
                        (branch) =>
                            fetchDefaultBranch(ops, repoPath, remote, branch, {
                                signal: controller.signal,
                                onProgress: broadcast(record),
                                env: BACKGROUND_GIT_ENV
                            }),
                        { signal: controller.signal, env: BACKGROUND_GIT_ENV, log }
                    );
                    record.branch = fetched.branch;
                } finally {
                    clearTimeout(timer);
                }
            });
            done.then(
                () => {
                    const record = records.get(key);
                    log(`worktree-prefetch: ${remote}/${record?.branch ?? '?'} for ${repoPath} done in ${String(now() - (record?.startedAt ?? now()))} ms`);
                },
                (error: unknown) => {
                    log(`worktree-prefetch: ${repoPath} failed (the next create fetches for itself): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
                }
            );
            return 'started';
        },

        fetchForCreate,

        peek(repoPath) {
            const record = records.get(keyOf(repoPath));
            if (record === undefined) return null;
            return {
                origin: record.origin,
                remote: record.remote,
                branch: record.branch,
                startedAt: record.startedAt,
                finishedAt: record.finishedAt,
                ok: record.ok
            };
        }
    };

    async function fetchForCreate(input: FetchForCreateInput): Promise<FetchForCreateOutcome> {
        prune();
        const key = keyOf(input.repoPath);
        const matches = (record: FetchRecord): boolean => record.remote === input.remote && record.branch === input.branch;
        const existing = records.get(key);
        if (existing !== undefined && existing.finishedAt === null) {
            // One fetch per repo: wait for the running one, whoever started it.
            input.onJoin?.(existing.origin);
            const listener = input.onProgress;
            if (listener !== undefined) existing.listeners.add(listener);
            let gaveUp = false;
            try {
                gaveUp = (await abortable(withTimeout(existing.settled, joinTimeoutMs), input.signal)) === TIMED_OUT;
            } catch {
                throw new WorktreeCreateCancelledError('fetch');
            } finally {
                if (listener !== undefined) existing.listeners.delete(listener);
            }
            if (gaveUp) {
                // A hung fetch this create does not own: stop waiting and fetch for itself,
                // outside the cache (the record still belongs to the fetch that is hung).
                log(`worktree-create: gave up waiting ${String(joinTimeoutMs)} ms on the running fetch for ${input.repoPath}; fetching for itself`);
                await fetchDefaultBranch(ops, input.repoPath, input.remote, input.branch, {
                    ...(input.signal !== undefined ? { signal: input.signal } : {}),
                    ...(input.onProgress !== undefined ? { onProgress: input.onProgress } : {})
                });
                return { kind: 'fetched' };
            }
            if (existing.ok === true && matches(existing)) return { kind: 'joined', origin: existing.origin };
            // It failed, or fetched another branch: fall through to a fetch of our own.
        } else if (
            existing !== undefined &&
            existing.ok === true &&
            existing.finishedAt !== null &&
            matches(existing) &&
            now() - existing.finishedAt < reuseMs
        ) {
            return { kind: 'reused', ageMs: now() - existing.finishedAt, origin: existing.origin };
        }
        const current = records.get(key);
        if (current !== undefined && current.finishedAt === null) {
            // Another create registered its fetch while we waited: join that one too.
            return fetchForCreate(input);
        }
        const { done } = track(key, 'create', input.remote, input.branch, async (record) => {
            const own = input.onProgress;
            if (own !== undefined) record.listeners.add(own);
            await fetchDefaultBranch(ops, input.repoPath, input.remote, input.branch, {
                ...(input.signal !== undefined ? { signal: input.signal } : {}),
                onProgress: broadcast(record)
            });
        });
        await done;
        return { kind: 'fetched' };
    }
}
