/**
 * Which registered repository a ticket belongs to, and what its local branches say about a pull
 * request (docs/integrations.md §9.6).
 *
 * A ticket names `owner/name`; a registered repository is a folder whose remotes point somewhere.
 * A repository matches when ANY of its remotes points at the ticket's repository: `origin` in a
 * plain clone, `upstream` in a fork clone (origin = the user's fork, upstream = the base), any other
 * name anyone uses. The remotes are read with `git remote -v` (`git/repo-facts.ts`), so
 * `insteadOf` rewrites are applied, not just the registry's `remoteURL` (which is origin's).
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
    gitHubRepoKey,
    parseGitHubRemote,
    replaceGitHubRemoteRepo,
    sameGitHubRepo,
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

function remoteRank(name: string): number {
    if (name === 'origin') return 0;
    if (name === 'upstream') return 1;
    return 2;
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
        // A repository's best remote per GitHub repository: origin, then upstream, then git's order.
        const best = new Map<string, RemoteFact>();
        remotes.forEach((remote) => {
            remoteURLs.push(remote.fetchURL);
            if (remote.pushURL !== remote.fetchURL) remoteURLs.push(remote.pushURL);
            const parsed = parseGitHubRemote(remote.fetchURL);
            if (parsed === null) return;
            const key = gitHubRepoKey(parsed.repo);
            const current = best.get(key);
            if (current === undefined || remoteRank(remote.name) < remoteRank(current.name)) best.set(key, remote);
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

/** Whether a `branch.<b>.remote` value (a remote name or a URL) points at `repo`. */
function pointsAt(value: string | null, remotes: readonly RemoteFact[], repo: string | null): boolean {
    if (value === null || value === '' || value === '.' || repo === null) return false;
    const named = remotes.find((remote) => remote.name === value);
    const urls = named === undefined ? [value] : [named.fetchURL, named.pushURL];
    return urls.some((url) => {
        const parsed = parseGitHubRemote(url);
        return parsed !== null && sameGitHubRepo(parsed.repo, repo);
    });
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
}

/**
 * The `LocalBranchLookup` `ticketCreateDefaults` decides with, from one read of the matched
 * repository (`@kelpi/core/tickets`' `LocalBranchFact` has the rule): a branch tracks THIS pull
 * request when its config merges `refs/pull/<n>/head` from the base repository, or
 * `refs/heads/<head>` from the repository the head lives in, or (same-repository pull request
 * only) when it has no upstream at all. An issue's branches never "track" anything.
 */
export function localBranchLookup(branches: BranchFacts | null, remotes: readonly RemoteFact[], target: BranchLookupTarget): LocalBranchLookup {
    if (branches === null) return NO_LOCAL_BRANCHES;
    const headRepo = target.crossRepository ? target.headRepo : target.repo;
    return (name) => {
        const config = branches.branches.get(name);
        if (config === undefined) return { exists: false };
        let tracks = false;
        if (target.kind === 'pr') {
            if (config.remote === null && config.merge === null) tracks = !target.crossRepository;
            else if (config.merge === `refs/pull/${target.number}/head`) tracks = pointsAt(config.remote, remotes, target.repo);
            else if (target.headRef !== null && config.merge === `refs/heads/${target.headRef}`) tracks = pointsAt(config.remote, remotes, headRepo);
        }
        return { exists: true, tracksPullRequest: tracks, checkedOutAt: branches.checkedOutAt(name) };
    };
}

export interface HeadRemoteDecision {
    readonly headRemote: string | null;
    readonly headPushURL: string | null;
}

/**
 * For a fork's pull request: a remote of the matched repository that already points at the head
 * repository (preferring `origin`, the usual fork clone), else, when the fork exists and its
 * maintainers may push, the base remote's push URL with owner/name swapped (so an SSH host alias
 * carries over). Same-repository pull requests need neither.
 */
export function headRemoteFor(
    pullRequest: { readonly crossRepository: boolean; readonly headRepo: string | null; readonly maintainerCanModify: boolean },
    remotes: readonly RemoteFact[],
    baseRemote: RemoteFact | null
): HeadRemoteDecision {
    if (!pullRequest.crossRepository || pullRequest.headRepo === null) return { headRemote: null, headPushURL: null };
    const pointing = remotes
        .filter((remote) => {
            const parsed = parseGitHubRemote(remote.fetchURL);
            return parsed !== null && sameGitHubRepo(parsed.repo, pullRequest.headRepo as string);
        })
        .sort((a, b) => remoteRank(a.name) - remoteRank(b.name));
    const found = pointing[0];
    if (found !== undefined) return { headRemote: found.name, headPushURL: null };
    if (!pullRequest.maintainerCanModify || baseRemote === null) return { headRemote: null, headPushURL: null };
    const [owner, name] = pullRequest.headRepo.split('/') as [string, string];
    const pushURL = replaceGitHubRemoteRepo(baseRemote.pushURL, owner, name) ?? replaceGitHubRemoteRepo(baseRemote.fetchURL, owner, name);
    return { headRemote: null, headPushURL: pushURL };
}
