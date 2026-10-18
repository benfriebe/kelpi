/**
 * Which remote of a clone is a ticket's repository, and whether a local branch already belongs to
 * a pull request (docs/integrations.md §9.6, graft-git.md §8.5.3). Pure: the daemon reads the
 * remotes and the branch config once (`git/repo-facts.ts`) and decides with these, so the resolve
 * (`ticket-resolve`, the sheet's prefill) and the checkout (`workspace-create`) can never answer
 * differently for the same repository.
 *
 * A remote FETCHES from a repository when any URL it fetches from names it on GitHub: the URL as
 * git uses it (`url.<base>.insteadOf` applied, so a `gh:acme/api` alias counts) and the URL as
 * written in the config (so a GitHub URL rewritten onto a mirror or a local path counts too). Where
 * a remote pushes is not where it points: a triangular clone's `pushurl` names the user's fork.
 */

import { parseGitHubRemote, sameGitHubRepo } from './refs.js';

/** A remote as these rules see it: its name and every URL it fetches from. */
export interface TicketRemote {
    readonly name: string;
    readonly fetchURLs: readonly string[];
}

/** `origin` first, then `upstream`, then any other (P10): the order a match prefers remotes in. */
export function remoteRank(name: string): number {
    if (name === 'origin') return 0;
    if (name === 'upstream') return 1;
    return 2;
}

/** Whether `remote` fetches from `repo` (`owner/name`) on GitHub (module note). */
export function remoteFetchesFrom(remote: TicketRemote, repo: string): boolean {
    return remote.fetchURLs.some((url) => {
        const parsed = parseGitHubRemote(url);
        return parsed !== null && sameGitHubRepo(parsed.repo, repo);
    });
}

/** The remote that fetches from `repo`, preferring `origin`, then `upstream`, then git's order; null when none does. */
export function bestRemoteFor<R extends TicketRemote>(remotes: readonly R[], repo: string): R | null {
    let best: R | null = null;
    for (const remote of remotes) {
        if (!remoteFetchesFrom(remote, repo)) continue;
        if (best === null || remoteRank(remote.name) < remoteRank(best.name)) best = remote;
    }
    return best;
}

/** `branch.<b>.remote` and `branch.<b>.merge`, as configured; null where the key is absent. */
export interface BranchUpstream {
    readonly remote: string | null;
    readonly merge: string | null;
}

/** The pull request a branch may belong to. */
export interface TrackedPullRequest {
    readonly number: number;
    /** The head branch's own name; null when unknown. */
    readonly headRef: string | null;
    readonly crossRepository: boolean;
}

/**
 * Whether a `branch.<b>.remote` value (a remote's name, or a URL) points at the pull request's
 * base repository (`base`) or the repository its head lives in (`head`).
 */
export type UpstreamPointsAt = (value: string, side: 'base' | 'head') => boolean;

/**
 * THE rule for "this local branch already is this pull request's" (`LocalBranchFact.
 * tracksPullRequest`, `prLocalBranchName`): its config merges `refs/pull/<n>/head` from the base
 * repository, or `refs/heads/<head>` from the repository the head lives in (the base for a
 * same-repository pull request), or, for a same-repository pull request only, it has no upstream
 * at all (the author's own branch, never pushed with `-u`). A `.` (local) upstream, or a remote
 * that points elsewhere, never counts.
 */
export function tracksPullRequest(config: BranchUpstream, pr: TrackedPullRequest, pointsAt: UpstreamPointsAt): boolean {
    if (config.remote === null && config.merge === null) return !pr.crossRepository;
    if (config.remote === null || config.remote === '' || config.remote === '.') return false;
    if (config.merge === `refs/pull/${pr.number}/head`) return pointsAt(config.remote, 'base');
    if (pr.headRef !== null && config.merge === `refs/heads/${pr.headRef}`) return pointsAt(config.remote, pr.crossRepository ? 'head' : 'base');
    return false;
}

/** What a create already knows about where a pull request's base and head are reached. */
export interface PullRequestRemotes {
    /** The base repository, `owner/name`. */
    readonly baseRepo: string;
    /** The head repository, `owner/name`; null when the fork was deleted. */
    readonly headRepo: string | null;
    readonly crossRepository: boolean;
    /** The remote matched to the base repository, when one was. */
    readonly baseRemote: string | null;
    /** A remote matched to a fork's head repository, when one was. */
    readonly headRemote: string | null;
    /** The URL a fork's branch is pushed to and pulled from (gh's configuration), when there is one. */
    readonly headPushURL: string | null;
}

/**
 * The `UpstreamPointsAt` for one repository's remotes: a value names the base (or head) when it is
 * the remote already matched to it, the fork URL the create configures, a remote that fetches from
 * it, or a URL that names it.
 */
export function pullRequestUpstreamPointsAt(remotes: readonly TicketRemote[], known: PullRequestRemotes): UpstreamPointsAt {
    const names = (value: string, repo: string | null): boolean => {
        if (repo === null) return false;
        const named = remotes.find((remote) => remote.name === value);
        if (named !== undefined) return remoteFetchesFrom(named, repo);
        const parsed = parseGitHubRemote(value);
        return parsed !== null && sameGitHubRepo(parsed.repo, repo);
    };
    return (value, side) => {
        if (side === 'base') return (known.baseRemote !== null && value === known.baseRemote) || names(value, known.baseRepo);
        if (!known.crossRepository) return (known.baseRemote !== null && value === known.baseRemote) || names(value, known.baseRepo);
        return (
            (known.headRemote !== null && value === known.headRemote) ||
            (known.headPushURL !== null && value === known.headPushURL) ||
            names(value, known.headRepo)
        );
    };
}
