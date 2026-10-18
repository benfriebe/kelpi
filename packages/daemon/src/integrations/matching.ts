/**
 * Which registered repository a ticket belongs to, and what its local branches say about a pull
 * request (docs/integrations.md §9.6).
 *
 * A ticket names `owner/name`; a registered repository is a folder whose remotes point somewhere.
 * A repository matches when ANY of its remotes fetches from the ticket's repository: `origin` in a
 * plain clone, `upstream` in a fork clone (origin = the user's fork, upstream = the base), any other
 * name anyone uses. The remotes are read by `git/repo-facts.ts` (the one reader the create's plan
 * and the pull request checkout use too), each with its URL as git uses it (`git remote -v`, so an
 * `insteadOf` alias is resolved) and as written (so a GitHub URL rewritten onto a mirror still
 * counts), never just the registry's `remoteURL` (which is origin's). Which remote is a
 * repository's and which branch is a pull request's are decided by `@kelpi/core/tickets`
 * (tracking.ts), the same functions the create uses.
 *
 * Several registered rows can match one repository (two clones, a monorepo's subfolder rows,
 * linked worktrees registered by hand). Ties are broken in this order (P10):
 *
 *   1. the matching remote is `origin`, then `upstream`, then any other;
 *   2. a repository added by hand over an auto-discovered one;
 *   3. the repository's own root over a subfolder row or a linked worktree row;
 *   4. the most recently accessed;
 *   5. registry order.
 *
 * The match also names the remote that matched (the BASE remote: base fetches, `refs/pull/<n>/head`
 * and an issue's update main use it) and, for a fork's pull request, a remote that already points
 * at the head repository (the user's own fork), or else the URL a push would go to.
 */

import {
    NO_LOCAL_BRANCHES,
    bestRemoteFor,
    gitHubRepoKey,
    parseGitHubRemote,
    pullRequestUpstreamPointsAt,
    remoteRank,
    replaceGitHubRemoteRepo,
    tracksPullRequest,
    type LocalBranchLookup
} from '@kelpi/core/tickets';
import type { TicketKind } from '@kelpi/protocol';

import type { BranchFacts, RemoteFact, RepoFacts } from '../git/repo-facts.js';
import type { Repo } from '../store/types.js';

/** Registered repositories considered per match (the most recently accessed first). */
export const MAX_MATCHED_REPOS = 200;
/** Repositories read at once. */
const READ_CONCURRENCY = 8;

export interface RepoCandidate {
    readonly repo: Repo;
    /** The remote that points at the ticket's repository. */
    readonly remote: RemoteFact;
    /** All of the repository's remotes. */
    readonly remotes: readonly RemoteFact[];
    /** Registry order, the last tie-break. */
    readonly order: number;
}

/** Every registered repository's remotes, read once, indexed by the GitHub repository they point at. */
export interface RepoIndex {
    /** The candidates for `owner/name`, best first (module note). */
    candidates(repo: string, signal?: AbortSignal): Promise<readonly RepoCandidate[]>;
    /** Every registered repository's remote URLs (fetch and push), for search scoping. */
    readonly remoteURLs: readonly string[];
    /** Each registered repository's remotes, by repository id. */
    readonly remotesByRepo: ReadonlyMap<string, readonly RemoteFact[]>;
}

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next;
            next += 1;
            results[index] = await fn(items[index] as T);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

/** Read every registered repository's remotes (bounded, through the facts cache). */
export async function buildRepoIndex(repos: readonly Repo[], facts: RepoFacts, signal?: AbortSignal): Promise<RepoIndex> {
    const considered = repos
        .map((repo, order) => ({ repo, order }))
        .sort((a, b) => b.repo.lastAccessedAt - a.repo.lastAccessedAt || a.order - b.order)
        .slice(0, MAX_MATCHED_REPOS);
    const read = await mapBounded(considered, READ_CONCURRENCY, async (entry) => ({ ...entry, remotes: await facts.remotes(entry.repo.path, signal) }));
    const byKey = new Map<string, RepoCandidate[]>();
    const remoteURLs: string[] = [];
    const remotesByRepo = new Map<string, readonly RemoteFact[]>();
    for (const { repo, order, remotes } of read) {
        remotesByRepo.set(repo.id, remotes);
        // A repository's best remote per GitHub repository it fetches from (`bestRemoteFor`'s
        // order: origin, then upstream, then git's order).
        const best = new Map<string, RemoteFact>();
        remotes.forEach((remote) => {
            for (const url of new Set([...remote.fetchURLs, remote.pushURL])) remoteURLs.push(url);
            for (const url of remote.fetchURLs) {
                const parsed = parseGitHubRemote(url);
                if (parsed === null) continue;
                const key = gitHubRepoKey(parsed.repo);
                const current = best.get(key);
                if (current === undefined || remoteRank(remote.name) < remoteRank(current.name)) best.set(key, remote);
            }
        });
        for (const [key, remote] of best) {
            const list = byKey.get(key) ?? [];
            list.push({ repo, remote, remotes, order });
            byKey.set(key, list);
        }
    }
    return {
        remoteURLs,
        remotesByRepo,
        async candidates(repo, candidateSignal) {
            const list = byKey.get(gitHubRepoKey(repo)) ?? [];
            if (list.length <= 1) return list;
            // The root check costs a git call per row, so only rows that tie on everything before it pay.
            const roots = await mapBounded(list, READ_CONCURRENCY, async (candidate) => (await facts.layout(candidate.repo.path, candidateSignal))?.isRoot === true);
            const rootOf = new Map(list.map((candidate, index) => [candidate, roots[index] === true]));
            return [...list].sort(
                (a, b) =>
                    remoteRank(a.remote.name) - remoteRank(b.remote.name) ||
                    Number(a.repo.isAutoDiscovered) - Number(b.repo.isAutoDiscovered) ||
                    Number(rootOf.get(b)) - Number(rootOf.get(a)) ||
                    b.repo.lastAccessedAt - a.repo.lastAccessedAt ||
                    a.order - b.order
            );
        }
    };
}

export interface BranchLookupTarget {
    readonly kind: TicketKind;
    readonly number: number;
    /** The base repository (`owner/name`). */
    readonly repo: string;
    /** Pull requests: the head branch and where it lives. */
    readonly headRef: string | null;
    readonly headRepo: string | null;
    readonly crossRepository: boolean;
    /** Pull requests: the remote matched to the base repository, and the head's remote or push URL (`headRemoteFor`). */
    readonly baseRemote: string | null;
    readonly headRemote: string | null;
    readonly headPushURL: string | null;
}

/**
 * The `LocalBranchLookup` `ticketCreateDefaults` and `prLocalBranchName` decide with, from one read
 * of a repository: whether a branch exists, where it is checked out, and whether it already is
 * THIS pull request's, by `@kelpi/core/tickets`' `tracksPullRequest` (its config merges
 * `refs/pull/<n>/head` from the base repository, or `refs/heads/<head>` from the repository the
 * head lives in, or, same-repository only, it has no upstream at all). The resolve (through the
 * cache) and the create's plan (uncached) both build it here, and the checkout applies the same
 * rule, so they cannot pick different branch names. An issue's branches never "track" anything.
 */
export function localBranchLookup(branches: BranchFacts | null, remotes: readonly RemoteFact[], target: BranchLookupTarget): LocalBranchLookup {
    if (branches === null) return NO_LOCAL_BRANCHES;
    const pointsAt = pullRequestUpstreamPointsAt(remotes, {
        baseRepo: target.repo,
        headRepo: target.crossRepository ? target.headRepo : target.repo,
        crossRepository: target.crossRepository,
        baseRemote: target.baseRemote,
        headRemote: target.headRemote,
        headPushURL: target.headPushURL
    });
    return (name) => {
        const config = branches.branches.get(name);
        if (config === undefined) return { exists: false };
        const tracks =
            target.kind === 'pr' && tracksPullRequest(config, { number: target.number, headRef: target.headRef, crossRepository: target.crossRepository }, pointsAt);
        return { exists: true, tracksPullRequest: tracks, checkedOutAt: branches.checkedOutAt(name), staleCheckoutAt: branches.staleCheckoutAt(name) };
    };
}

export interface HeadRemoteDecision {
    readonly headRemote: string | null;
    readonly headPushURL: string | null;
}

/**
 * Where a fork's branch is pushed when no remote points at the fork: the base remote's URL with
 * owner/name swapped, so an SSH host alias (or an `insteadOf` alias's target) carries over and the
 * push authenticates exactly as a push to the base would. The push URL first (as git uses it, then
 * as written), then the fetch URL the same way; null when none is a GitHub remote.
 */
export function forkPushURL(baseRemote: RemoteFact, owner: string, name: string): string | null {
    for (const url of [baseRemote.pushURL, baseRemote.configuredPushURL, baseRemote.fetchURL, baseRemote.configuredFetchURL]) {
        if (url === null) continue;
        const swapped = replaceGitHubRemoteRepo(url, owner, name);
        if (swapped !== null) return swapped;
    }
    return null;
}

/**
 * For a fork's pull request: a remote of the repository that already fetches from the head
 * repository (`bestRemoteFor`: `origin`, the usual fork clone, first), else, when the fork exists
 * and its maintainers may push, `forkPushURL` of the base remote. Same-repository pull requests
 * need neither. The resolve and the create's plan both decide with this.
 */
export function headRemoteFor(
    pullRequest: { readonly crossRepository: boolean; readonly headRepo: string | null; readonly maintainerCanModify: boolean },
    remotes: readonly RemoteFact[],
    baseRemote: RemoteFact | null
): HeadRemoteDecision {
    if (!pullRequest.crossRepository || pullRequest.headRepo === null) return { headRemote: null, headPushURL: null };
    const found = bestRemoteFor(remotes, pullRequest.headRepo);
    if (found !== null) return { headRemote: found.name, headPushURL: null };
    if (!pullRequest.maintainerCanModify || baseRemote === null) return { headRemote: null, headPushURL: null };
    const [owner, name] = pullRequest.headRepo.split('/') as [string, string];
    return { headRemote: null, headPushURL: forkPushURL(baseRemote, owner, name) };
}
