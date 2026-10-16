/**
 * Pull request status on a workspace (docs/workspace-feature.md §11), shared by the daemon that
 * looks the PRs up and every client that draws them.
 *
 * Pure data with no Node imports, so a browser bundle can take it.
 */

/** GitHub's four states as a row shows them; a draft is an open PR marked as a draft. */
export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed';

/** Aggregate order (#2): one open PR outranks any number of merged ones. */
export const PULL_REQUEST_STATES: readonly PullRequestState[] = ['open', 'draft', 'merged', 'closed'];

/** One PR found for one of a workspace's repo associations (§1.11). */
export interface WorkspacePullRequest {
    readonly number: number;
    readonly title: string;
    /** The PR's page on GitHub; always http(s). */
    readonly url: string;
    readonly state: PullRequestState;
    /** The association the PR was found for, so the inspector can list it under that repo. */
    readonly repoID: string;
    readonly associationID: string;
    readonly branch: string;
}

function rank(state: PullRequestState): number {
    return PULL_REQUEST_STATES.indexOf(state);
}

/** The state a row shows for a set of PRs: open > draft > merged > closed; null for none. */
export function aggregatePullRequestState(
    pullRequests: readonly WorkspacePullRequest[]
): PullRequestState | null {
    let best: PullRequestState | null = null;
    for (const pullRequest of pullRequests) {
        if (best === null || rank(pullRequest.state) < rank(best)) best = pullRequest.state;
    }
    return best;
}

/** Aggregate rank first, then newest (highest number) first; ties by association id. */
export function sortPullRequests(
    pullRequests: readonly WorkspacePullRequest[]
): WorkspacePullRequest[] {
    return [...pullRequests].sort(
        (left, right) =>
            rank(left.state) - rank(right.state) ||
            right.number - left.number ||
            left.associationID.localeCompare(right.associationID)
    );
}

export function samePullRequests(
    left: readonly WorkspacePullRequest[],
    right: readonly WorkspacePullRequest[]
): boolean {
    if (left.length !== right.length) return false;
    return left.every((pullRequest, index) => {
        const other = right[index];
        return (
            other !== undefined &&
            pullRequest.number === other.number &&
            pullRequest.title === other.title &&
            pullRequest.url === other.url &&
            pullRequest.state === other.state &&
            pullRequest.repoID === other.repoID &&
            pullRequest.associationID === other.associationID &&
            pullRequest.branch === other.branch
        );
    });
}

function isState(value: unknown): value is PullRequestState {
    return typeof value === 'string' && (PULL_REQUEST_STATES as readonly string[]).includes(value);
}

/**
 * A wire value → the PRs it validly names. A daemon older than the field sends nothing (`[]`);
 * an entry missing a field, or with a URL that is not http(s), is dropped rather than drawn.
 */
export function pullRequestsFrom(raw: unknown): WorkspacePullRequest[] {
    if (!Array.isArray(raw)) return [];
    const out: WorkspacePullRequest[] = [];
    for (const entry of raw as unknown[]) {
        if (typeof entry !== 'object' || entry === null) continue;
        const record = entry as Record<string, unknown>;
        const { number, title, url, state, repoID, associationID, branch } = record;
        if (
            typeof number !== 'number' || !Number.isInteger(number) ||
            typeof title !== 'string' ||
            typeof url !== 'string' || !/^https?:\/\//i.test(url) ||
            !isState(state) ||
            typeof repoID !== 'string' ||
            typeof associationID !== 'string' ||
            typeof branch !== 'string'
        ) continue;
        out.push({ number, title, url, state, repoID, associationID, branch });
    }
    return out;
}
