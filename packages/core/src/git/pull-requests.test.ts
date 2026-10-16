import { describe, expect, it } from 'vitest';

import {
    aggregatePullRequestState,
    pullRequestsFrom,
    samePullRequests,
    sortPullRequests,
    type PullRequestState,
    type WorkspacePullRequest
} from './pull-requests.js';

function pr(number: number, state: PullRequestState, associationID = 'a1'): WorkspacePullRequest {
    return {
        number,
        title: `PR ${String(number)}`,
        url: `https://github.com/acme/widgets/pull/${String(number)}`,
        state,
        repoID: 'r1',
        associationID,
        branch: 'feat-x'
    };
}

describe('aggregatePullRequestState', () => {
    it('is null for no PRs', () => {
        expect(aggregatePullRequestState([])).toBeNull();
    });

    it('is the state itself for a single PR, in each of the four states', () => {
        for (const state of ['open', 'draft', 'merged', 'closed'] as const) {
            expect(aggregatePullRequestState([pr(1, state)])).toBe(state);
        }
    });

    it('ranks open > draft > merged > closed whatever the order', () => {
        expect(aggregatePullRequestState([pr(1, 'merged'), pr(2, 'open'), pr(3, 'closed')])).toBe('open');
        expect(aggregatePullRequestState([pr(1, 'closed'), pr(2, 'draft'), pr(3, 'merged')])).toBe('draft');
        expect(aggregatePullRequestState([pr(1, 'closed'), pr(2, 'merged')])).toBe('merged');
        expect(aggregatePullRequestState([pr(1, 'closed'), pr(2, 'closed')])).toBe('closed');
    });
});

describe('sortPullRequests', () => {
    it('orders by aggregate rank, then newest first, without mutating its input', () => {
        const input = [pr(3, 'merged'), pr(9, 'closed'), pr(4, 'open'), pr(7, 'merged'), pr(5, 'draft')];
        const sorted = sortPullRequests(input);
        expect(sorted.map((entry) => entry.number)).toEqual([4, 5, 7, 3, 9]);
        expect(input.map((entry) => entry.number)).toEqual([3, 9, 4, 7, 5]);
    });

    it('breaks a tie on the same PR found for two associations by association id', () => {
        const sorted = sortPullRequests([pr(1, 'open', 'b'), pr(1, 'open', 'a')]);
        expect(sorted.map((entry) => entry.associationID)).toEqual(['a', 'b']);
    });
});

describe('samePullRequests', () => {
    it('compares every field, in order', () => {
        expect(samePullRequests([pr(1, 'open')], [pr(1, 'open')])).toBe(true);
        expect(samePullRequests([], [])).toBe(true);
        expect(samePullRequests([pr(1, 'open')], [pr(1, 'merged')])).toBe(false);
        expect(samePullRequests([pr(1, 'open')], [{ ...pr(1, 'open'), title: 'renamed' }])).toBe(false);
        expect(samePullRequests([pr(1, 'open'), pr(2, 'open')], [pr(2, 'open'), pr(1, 'open')])).toBe(false);
        expect(samePullRequests([pr(1, 'open')], [])).toBe(false);
    });
});

describe('pullRequestsFrom', () => {
    it('is empty for a missing or non-array value (a daemon older than the field)', () => {
        expect(pullRequestsFrom(undefined)).toEqual([]);
        expect(pullRequestsFrom(null)).toEqual([]);
        expect(pullRequestsFrom({})).toEqual([]);
    });

    it('keeps valid entries and drops malformed ones and non-http URLs', () => {
        const good = pr(12, 'open');
        expect(
            pullRequestsFrom([
                good,
                { ...good, state: 'weird' },
                { ...good, number: 1.5 },
                { ...good, url: 'javascript:alert(1)' },
                { ...good, branch: undefined },
                'nope'
            ])
        ).toEqual([good]);
    });
});
