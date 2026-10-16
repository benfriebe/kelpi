/**
 * Pull request status for every workspace (workspace-feature.md §11).
 *
 * The source is the store's repo associations: each one on a named branch (not detached, not the
 * repo's default branch) of a repo whose `origin` is on GitHub is one lookup key, deduped by
 * (repo, branch) across workspaces. Each key is one `gh pr list --head <branch>` against origin.
 * Results are projected back onto each workspace as the TRANSIENT `pullRequests` field, which
 * reaches every client through `workspace-upserted` like any other workspace field.
 *
 * Cost rules, because the GitHub budget is per user and shared with every `gh` an agent runs:
 *   - nothing is spawned while the setting is off, and no `gh` at all without a GitHub remote;
 *   - the active workspace's keys every minute, the rest every 5 min, keys whose PRs are all
 *     merged or closed every 15 min; at most two `gh` processes at once;
 *   - a missing or logged-out `gh` stands everything down, clears every row, and looks again
 *     every 10 min; a rate-limit error pauses every lookup for 15 min;
 *   - any other failure keeps the key's last good answer until the next try.
 *
 * Refresh is driven by the poller's own diff of the key set (a branch switch, a new association,
 * the active workspace changing), never by the association watcher's 30 s status reads.
 */

import {
    samePullRequests,
    sortPullRequests,
    type PullRequestState,
    type WorkspacePullRequest
} from '@kelpi/core/git';

import type { DomainStore } from '../seams.js';
import type { DaemonState, DomainAction, DomainEvent } from '../store/index.js';
import type { GhResult, GhRunner } from './gh.js';
import { parseGitHubRemote, type GitHubRepoRef } from './remote.js';

export const PR_ACTIVE_INTERVAL_MS = 60_000;
export const PR_IDLE_INTERVAL_MS = 5 * 60_000;
export const PR_SETTLED_INTERVAL_MS = 15 * 60_000;
export const PR_UNAVAILABLE_RETRY_MS = 10 * 60_000;
export const PR_RATE_LIMIT_PAUSE_MS = 15 * 60_000;
/** How long a repo's origin and default branch are believed before being read again. */
export const PR_REPO_CACHE_MS = 60 * 60_000;
/** How long a working `gh`'s list of logged-in hosts is believed. */
export const PR_AUTH_RECHECK_MS = 60 * 60_000;
export const PR_DEBOUNCE_MS = 2_000;
export const PR_TICK_MS = 5_000;
export const PR_MAX_CONCURRENT = 2;
export const PR_LIST_LIMIT = 20;
const TITLE_MAX = 300;

const PR_JSON_FIELDS = 'number,title,url,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner';

/** `git rev-parse --abbrev-ref HEAD` prints this for a detached HEAD. */
const DETACHED = 'HEAD';

export type PullRequestStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** The three local git reads a lookup needs. All of them must never throw. */
export interface PullRequestGit {
    /** `git remote get-url origin`, or null. */
    remoteURL(repoPath: string): Promise<string | null>;
    /** The repo's default branch name, or null when it cannot be told. */
    defaultBranch(repoPath: string): Promise<string | null>;
    /** Whether `commit` is the tip of `branch` or one of its ancestors, here. */
    isAncestor(worktreePath: string, commit: string, branch: string): Promise<boolean>;
}

export interface CreatePullRequestPollerOptions {
    readonly store: PullRequestStore;
    readonly gh: GhRunner;
    readonly git: PullRequestGit;
    /** The `workspace-pr-status` setting, read at every decision point. */
    readonly enabled: () => boolean;
    /** One line per availability change. Never given a URL, a host or gh's own output. */
    readonly log?: ((message: string) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    readonly now?: (() => number) | undefined;
    readonly activeIntervalMs?: number | undefined;
    readonly idleIntervalMs?: number | undefined;
    readonly settledIntervalMs?: number | undefined;
    readonly unavailableRetryMs?: number | undefined;
    readonly rateLimitPauseMs?: number | undefined;
    readonly debounceMs?: number | undefined;
    /** How often due keys are looked for. */
    readonly tickMs?: number | undefined;
    readonly maxConcurrent?: number | undefined;
}

export interface PullRequestPoller {
    start(): void;
    /** The setting may have changed: stand down at once when off, look now when on. */
    settingsChanged(): void;
    dispose(): void;
}

interface Found {
    readonly number: number;
    readonly title: string;
    readonly url: string;
    readonly state: PullRequestState;
}

interface Desired {
    readonly repoID: string;
    readonly branch: string;
    readonly repoPath: string;
    readonly worktreePath: string;
    readonly active: boolean;
}

interface KeyState {
    readonly id: string;
    readonly repoID: string;
    readonly branch: string;
    repoPath: string;
    worktreePath: string;
    active: boolean;
    lastRunAt: number | null;
    result: readonly Found[] | null;
    sequence: number;
    running: boolean;
}

interface RepoInfo {
    readonly at: number;
    readonly ref: GitHubRepoRef | null;
    readonly defaultBranch: string | null;
}

type Availability = 'unknown' | 'available' | 'unavailable';

function keyOf(repoID: string, branch: string): string {
    return `${repoID}\u0000${branch}`;
}

function usableBranch(branch: string | null): branch is string {
    return branch !== null && branch !== '' && branch !== DETACHED;
}

function desiredKeys(state: DaemonState): Map<string, Desired> {
    const repos = new Map(state.repos.map((repo) => [repo.id, repo]));
    const out = new Map<string, Desired>();
    for (const workspace of state.workspaces) {
        const active = workspace.id === state.lastActiveWorkspaceID;
        for (const association of workspace.repoAssociations) {
            if (!usableBranch(association.branchName)) continue;
            const repo = repos.get(association.repoID);
            if (repo === undefined) continue;
            const id = keyOf(repo.id, association.branchName);
            const existing = out.get(id);
            out.set(id, {
                repoID: repo.id,
                branch: association.branchName,
                repoPath: repo.path,
                worktreePath: existing?.worktreePath ?? association.worktreePath,
                active: active || existing?.active === true
            });
        }
    }
    return out;
}

/** What the projection and the schedule depend on: who is on which key, and who is active. */
function signatureOf(state: DaemonState): string {
    const repos = new Set(state.repos.map((repo) => repo.id));
    const parts: string[] = [state.lastActiveWorkspaceID ?? ''];
    for (const workspace of state.workspaces) {
        const entries = workspace.repoAssociations
            .filter((association) => usableBranch(association.branchName) && repos.has(association.repoID))
            .map((association) => `${association.id}=${keyOf(association.repoID, association.branchName ?? '')}`);
        if (entries.length > 0) parts.push(`${workspace.id}:${entries.join(',')}`);
    }
    return parts.join('\u0001');
}

function sameFound(left: readonly Found[] | null, right: readonly Found[]): boolean {
    if (left === null || left.length !== right.length) return false;
    return left.every((entry, index) => {
        const other = right[index] as Found;
        return entry.number === other.number && entry.title === other.title &&
            entry.url === other.url && entry.state === other.state;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** `gh auth status` names every host it holds a working token for as "Logged in to <host>". */
export function loggedInHosts(output: string): Set<string> {
    const hosts = new Set<string>();
    for (const match of output.matchAll(/Logged in to ([A-Za-z0-9.-]+[A-Za-z0-9])/g)) {
        hosts.add((match[1] as string).toLowerCase());
    }
    return hosts;
}

function isRateLimited(result: GhResult): boolean {
    return /rate limit/i.test(result.stderr);
}

function isAuthFailure(result: GhResult): boolean {
    return result.code === 4 ||
        /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(result.stderr);
}

function stateOf(raw: Record<string, unknown>): PullRequestState | null {
    switch (raw['state']) {
        case 'OPEN':
            return raw['isDraft'] === true ? 'draft' : 'open';
        case 'MERGED':
            return 'merged';
        case 'CLOSED':
            return 'closed';
        default:
            return null;
    }
}

export function createPullRequestPoller(options: CreatePullRequestPollerOptions): PullRequestPoller {
    const { store, gh, git } = options;
    const clock = options.now ?? Date.now;
    const activeInterval = options.activeIntervalMs ?? PR_ACTIVE_INTERVAL_MS;
    const idleInterval = options.idleIntervalMs ?? PR_IDLE_INTERVAL_MS;
    const settledInterval = options.settledIntervalMs ?? PR_SETTLED_INTERVAL_MS;
    const unavailableRetry = options.unavailableRetryMs ?? PR_UNAVAILABLE_RETRY_MS;
    const rateLimitPause = options.rateLimitPauseMs ?? PR_RATE_LIMIT_PAUSE_MS;
    const debounce = options.debounceMs ?? PR_DEBOUNCE_MS;
    const tickEvery = options.tickMs ?? PR_TICK_MS;
    const maxConcurrent = Math.max(1, options.maxConcurrent ?? PR_MAX_CONCURRENT);
    const log = options.log ?? ((): void => {});
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const keys = new Map<string, KeyState>();
    const repoCache = new Map<string, RepoInfo>();
    const repoReads = new Map<string, Promise<RepoInfo>>();
    let availability: Availability = 'unknown';
    let hosts = new Set<string>();
    let authCheckedAt = 0;
    let retryAt = 0;
    let probe: Promise<void> | null = null;
    let pausedUntil = 0;
    let inFlight = 0;
    let requestSequence = 0;
    /** Bumped whenever every answer in flight stops counting (off, unavailable, disposed). */
    let generation = 0;
    let lastSignature: string | null = null;
    let live = false;
    let started = false;
    let disposed = false;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    /** Every workspace's `pullRequests`, rebuilt from the key results; dispatches only changes. */
    const project = (): void => {
        const state = store.getState();
        for (const workspace of state.workspaces) {
            const next: WorkspacePullRequest[] = [];
            if (live) {
                const seen = new Set<string>();
                for (const association of workspace.repoAssociations) {
                    if (!usableBranch(association.branchName)) continue;
                    const result = keys.get(keyOf(association.repoID, association.branchName))?.result;
                    if (result === null || result === undefined) continue;
                    for (const found of result) {
                        // The same PR under two associations of one workspace is still one PR.
                        const identity = `${association.repoID}#${String(found.number)}`;
                        if (seen.has(identity)) continue;
                        seen.add(identity);
                        next.push({
                            ...found,
                            repoID: association.repoID,
                            associationID: association.id,
                            branch: association.branchName
                        });
                    }
                }
            }
            const sorted = sortPullRequests(next);
            if (samePullRequests(workspace.pullRequests, sorted)) continue;
            store.dispatch({ type: 'set-workspace-pull-requests', id: workspace.id, pullRequests: sorted });
        }
    };

    const standDown = (): void => {
        generation += 1;
        keys.clear();
        live = false;
        project();
    };

    const markUnavailable = (why: string): void => {
        const was = availability;
        availability = 'unavailable';
        hosts = new Set();
        retryAt = clock() + unavailableRetry;
        if (was !== 'unavailable') {
            log(`pull request status: ${why}; looking again in ${String(Math.round(unavailableRetry / 60_000))} min`);
        }
        standDown();
    };

    /** Probe `gh auth status` once, shared by every lookup that needs it. */
    const ensureAvailable = async (): Promise<boolean> => {
        const now = clock();
        if (availability === 'available' && now - authCheckedAt < PR_AUTH_RECHECK_MS) return true;
        if (availability === 'unavailable' && now < retryAt) return false;
        probe ??= (async () => {
            const result = await gh(['auth', 'status']);
            if (disposed) return;
            if (result.missing) {
                markUnavailable('gh was not found');
                return;
            }
            const found = loggedInHosts(`${result.stdout}\n${result.stderr}`);
            if (found.size === 0) {
                markUnavailable(result.timedOut ? 'gh auth status timed out' : 'gh is not logged in');
                return;
            }
            const was = availability;
            hosts = found;
            authCheckedAt = clock();
            availability = 'available';
            if (was !== 'available') log('pull request status: using gh');
        })().finally(() => {
            probe = null;
        });
        await probe;
        return availability === 'available';
    };

    const repoInfo = (repoID: string, repoPath: string): Promise<RepoInfo> => {
        const cached = repoCache.get(repoID);
        if (cached !== undefined && clock() - cached.at < PR_REPO_CACHE_MS) return Promise.resolve(cached);
        const pending = repoReads.get(repoID);
        if (pending !== undefined) return pending;
        const read = (async (): Promise<RepoInfo> => {
            // The remote is read here, not from `Repo.remoteURL`: a repo registered by a
            // worktree create is stored without one, and nothing refreshes it.
            const ref = parseGitHubRemote(await git.remoteURL(repoPath));
            const defaultBranch = ref === null ? null : await git.defaultBranch(repoPath);
            const info: RepoInfo = { at: clock(), ref, defaultBranch };
            repoCache.set(repoID, info);
            return info;
        })().finally(() => {
            repoReads.delete(repoID);
        });
        repoReads.set(repoID, read);
        return read;
    };

    const finish = (key: KeyState, found: readonly Found[]): void => {
        key.lastRunAt = clock();
        if (sameFound(key.result, found)) return;
        key.result = found;
        project();
    };

    const filterResults = async (key: KeyState, ref: GitHubRepoRef, raw: unknown[]): Promise<Found[]> => {
        const out: Found[] = [];
        const numbers = new Set<number>();
        for (const entry of raw) {
            if (!isRecord(entry)) continue;
            const number = entry['number'];
            const url = entry['url'];
            const state = stateOf(entry);
            if (typeof number !== 'number' || !Number.isInteger(number) || numbers.has(number)) continue;
            if (typeof url !== 'string' || !/^https:\/\//i.test(url) || state === null) continue;
            if (entry['headRefName'] !== key.branch) continue;
            // `--head` matches a branch NAME, so a fork's branch of the same name matches too.
            const owner = entry['headRepositoryOwner'];
            const repository = entry['headRepository'];
            if (!isRecord(owner) || !isRecord(repository)) continue;
            if (String(owner['login']).toLowerCase() !== ref.owner.toLowerCase() ||
                String(repository['name']).toLowerCase() !== ref.name.toLowerCase()) continue;
            if (state === 'merged' || state === 'closed') {
                // A branch name gets reused. A finished PR is ours only if its head commit is
                // this branch's tip or behind it; a commit we have never had is someone else's.
                const head = entry['headRefOid'];
                if (typeof head !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(head)) continue;
                if (!await git.isAncestor(key.worktreePath, head, key.branch)) continue;
            }
            const title = typeof entry['title'] === 'string' ? entry['title'] : '';
            numbers.add(number);
            out.push({ number, title: title.length > TITLE_MAX ? title.slice(0, TITLE_MAX) : title, url, state });
        }
        return out;
    };

    const lookup = async (key: KeyState): Promise<void> => {
        const sequence = ++requestSequence;
        const gen = generation;
        key.sequence = sequence;
        key.running = true;
        inFlight += 1;
        const current = (): boolean =>
            !disposed && gen === generation && keys.get(key.id) === key && key.sequence === sequence;
        try {
            const info = await repoInfo(key.repoID, key.repoPath);
            if (!current()) return;
            if (info.ref === null || key.branch === info.defaultBranch) {
                finish(key, []);
                return;
            }
            if (!await ensureAvailable()) return;
            if (!current()) return;
            if (!hosts.has(info.ref.host)) {
                finish(key, []);
                return;
            }
            const result = await gh([
                'pr', 'list',
                `--repo=${info.ref.host}/${info.ref.owner}/${info.ref.name}`,
                `--head=${key.branch}`,
                '--state=all',
                `--limit=${String(PR_LIST_LIMIT)}`,
                `--json=${PR_JSON_FIELDS}`
            ]);
            if (!current()) return;
            if (result.missing) {
                markUnavailable('gh was not found');
                return;
            }
            if (result.code !== 0) {
                if (isRateLimited(result)) {
                    if (pausedUntil <= clock()) {
                        log(`pull request status: GitHub rate limit reached; pausing for ${String(Math.round(rateLimitPause / 60_000))} min`);
                    }
                    pausedUntil = clock() + rateLimitPause;
                    key.lastRunAt = clock();
                    return;
                }
                if (isAuthFailure(result)) {
                    markUnavailable('gh is not logged in');
                    return;
                }
                // Anything else (network, a timeout, a deleted repo): keep the last answer.
                key.lastRunAt = clock();
                return;
            }
            let parsed: unknown;
            try {
                parsed = JSON.parse(result.stdout);
            } catch {
                key.lastRunAt = clock();
                return;
            }
            if (!Array.isArray(parsed)) {
                key.lastRunAt = clock();
                return;
            }
            const found = await filterResults(key, info.ref, parsed);
            if (!current()) return;
            finish(key, found);
        } catch (error) {
            report(error, 'pull request lookup');
            if (current()) key.lastRunAt = clock();
        } finally {
            key.running = false;
            inFlight -= 1;
            if (!disposed) queueMicrotask(tick);
        }
    };

    const intervalOf = (key: KeyState): number => {
        const result = key.result;
        if (result !== null && result.length > 0 && result.every((entry) => entry.state === 'merged' || entry.state === 'closed')) {
            return settledInterval;
        }
        return key.active ? activeInterval : idleInterval;
    };

    /** Bring `keys` in line with the store; true when a key was dropped (rows may change). */
    const syncKeys = (): boolean => {
        const desired = desiredKeys(store.getState());
        let dropped = false;
        for (const id of [...keys.keys()]) {
            if (desired.has(id)) continue;
            keys.delete(id);
            dropped = true;
        }
        for (const [id, want] of desired) {
            const existing = keys.get(id);
            if (existing !== undefined) {
                existing.repoPath = want.repoPath;
                existing.worktreePath = want.worktreePath;
                existing.active = want.active;
                continue;
            }
            keys.set(id, {
                id,
                repoID: want.repoID,
                branch: want.branch,
                repoPath: want.repoPath,
                worktreePath: want.worktreePath,
                active: want.active,
                lastRunAt: null,
                result: null,
                sequence: 0,
                running: false
            });
        }
        return dropped;
    };

    function tick(): void {
        if (disposed || !started) return;
        if (!options.enabled()) {
            if (live || keys.size > 0) standDown();
            availability = 'unknown';
            return;
        }
        live = true;
        const now = clock();
        if (now < pausedUntil) return;
        if (availability === 'unavailable' && now < retryAt) return;
        if (syncKeys()) project();
        const due = [...keys.values()]
            .filter((key) => !key.running && (key.lastRunAt === null || now - key.lastRunAt >= intervalOf(key)))
            .sort((left, right) => (left.lastRunAt ?? -Infinity) - (right.lastRunAt ?? -Infinity));
        for (const key of due) {
            if (inFlight >= maxConcurrent) break;
            // While the first probe is out, one lookup at a time: they would all wait on it.
            if (availability !== 'available' && inFlight > 0) break;
            void lookup(key);
        }
    }

    const scheduleSoon = (): void => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            tick();
        }, debounce);
        debounceTimer.unref?.();
    };

    const onStore = (): void => {
        if (disposed) return;
        const signature = signatureOf(store.getState());
        if (signature === lastSignature) return;
        lastSignature = signature;
        if (!live) return;
        // Drop what no longer applies now (a key, or an association that moved); look up what
        // is new after the debounce.
        syncKeys();
        project();
        scheduleSoon();
    };

    return {
        start() {
            if (disposed || started) return;
            started = true;
            lastSignature = signatureOf(store.getState());
            unsubscribe = store.subscribe(onStore);
            // A restored snapshot carries no PRs, but a stale list must never outlive a restart.
            project();
            tick();
            if (tickEvery > 0) {
                ticker = setInterval(tick, tickEvery);
                ticker.unref?.();
            }
        },

        settingsChanged() {
            if (disposed || !started) return;
            tick();
        },

        dispose() {
            if (disposed) return;
            disposed = true;
            generation += 1;
            unsubscribe?.();
            unsubscribe = null;
            if (ticker !== null) clearInterval(ticker);
            ticker = null;
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            debounceTimer = null;
            keys.clear();
            repoCache.clear();
        }
    };
}
