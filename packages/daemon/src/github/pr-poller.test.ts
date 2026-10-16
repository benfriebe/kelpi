import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createStore, emptyDaemonState, type KelpiStore, type DomainEvent } from '../store/index.js';
import type { GhResult } from './gh.js';
import {
    createPullRequestPoller,
    loggedInHosts,
    PR_ACTIVE_INTERVAL_MS,
    PR_DEBOUNCE_MS,
    PR_IDLE_INTERVAL_MS,
    PR_RATE_LIMIT_PAUSE_MS,
    PR_SETTLED_INTERVAL_MS,
    PR_UNAVAILABLE_RETRY_MS,
    type PullRequestGit,
    type PullRequestPoller
} from './pr-poller.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const R1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const R2 = 'BBBBBBBB-0000-4000-8000-000000000002';
const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const A2 = 'CCCCCCCC-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;
const TIP = 'a'.repeat(40);

type Wire = Record<string, unknown>;

function wirePR(
    number: number,
    state: 'open' | 'draft' | 'merged' | 'closed',
    overrides: { branch?: string; oid?: string; owner?: string; repo?: string | null; url?: string } = {}
): Wire {
    return {
        number,
        title: `PR ${String(number)}`,
        url: overrides.url ?? `https://github.com/acme/widgets/pull/${String(number)}`,
        state: state === 'draft' ? 'OPEN' : state.toUpperCase(),
        isDraft: state === 'draft',
        headRefName: overrides.branch ?? 'feat-x',
        headRefOid: overrides.oid ?? TIP,
        headRepository: overrides.repo === null ? null : { name: overrides.repo ?? 'widgets' },
        headRepositoryOwner: { login: overrides.owner ?? 'acme' }
    };
}

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '', missing: false, timedOut: false });
const fail = (code: number, stderr: string): GhResult => ({ code, stdout: '', stderr, missing: false, timedOut: false });
const MISSING: GhResult = { code: -1, stdout: '', stderr: '', missing: true, timedOut: false };
const AUTH_OK = ok('github.com\n  ✓ Logged in to github.com account octo (keyring)\n');

interface FakeGh {
    readonly calls: string[][];
    readonly prCalls: () => string[][];
    auth: GhResult;
    /** Per branch: the PR list, or a canned failure. */
    readonly pulls: Map<string, Wire[] | GhResult>;
    /** When set, `pr list` for this branch waits until `release` is called. */
    hold: string | null;
    release: () => void;
    run(args: readonly string[]): Promise<GhResult>;
    running: number;
    maxRunning: number;
}

function fakeGh(): FakeGh {
    let releaseHeld: () => void = () => {};
    const gh: FakeGh = {
        calls: [],
        prCalls: () => gh.calls.filter((args) => args[0] === 'pr'),
        auth: AUTH_OK,
        pulls: new Map(),
        hold: null,
        release: () => {
            releaseHeld();
        },
        running: 0,
        maxRunning: 0,
        async run(args) {
            gh.calls.push([...args]);
            if (args[0] === 'auth') return gh.auth;
            const head = args.find((arg) => arg.startsWith('--head='))?.slice('--head='.length) ?? '';
            gh.running += 1;
            gh.maxRunning = Math.max(gh.maxRunning, gh.running);
            try {
                if (gh.hold === head) {
                    await new Promise<void>((resolve) => {
                        releaseHeld = resolve;
                    });
                }
                const answer = gh.pulls.get(head) ?? [];
                return Array.isArray(answer) ? ok(JSON.stringify(answer)) : answer;
            } finally {
                gh.running -= 1;
            }
        }
    };
    return gh;
}

interface FakeGit extends PullRequestGit {
    readonly remotes: Map<string, string | null>;
    readonly defaults: Map<string, string | null>;
    /** Commits that are ancestors of (or equal to) the branch tip. */
    readonly ancestors: Set<string>;
    remoteReads: number;
}

function fakeGit(): FakeGit {
    const git: FakeGit = {
        remotes: new Map([['/repo', 'git@github.com:acme/widgets.git']]),
        defaults: new Map([['/repo', 'main']]),
        ancestors: new Set([TIP]),
        remoteReads: 0,
        async remoteURL(repoPath) {
            git.remoteReads += 1;
            return git.remotes.get(repoPath) ?? null;
        },
        async defaultBranch(repoPath) {
            return git.defaults.get(repoPath) ?? null;
        },
        async isAncestor(_worktreePath, commit) {
            return git.ancestors.has(commit);
        }
    };
    return git;
}

interface Harness {
    readonly store: KelpiStore;
    readonly gh: FakeGh;
    readonly git: FakeGit;
    readonly logs: string[];
    readonly events: DomainEvent[];
    poller: PullRequestPoller;
    enabled: boolean;
    prs(workspaceID?: string): { number: number; state: string; associationID: string; branch: string; repoID: string }[];
}

function addRepo(store: KelpiStore, id: string, repoPath: string): void {
    // remoteURL null, as a worktree create stores it: the poller must read origin itself.
    store.dispatch({
        type: 'add-repo',
        repo: { id, path: repoPath, name: 'widgets', remoteURL: null, lastAccessedAt: NOW / 1000, isAutoDiscovered: false }
    });
}

function associate(store: KelpiStore, workspaceID: string, id: string, branchName: string | null, repoID = R1): void {
    store.dispatch({
        type: 'add-repo-association',
        workspaceID,
        association: { id, repoID, worktreePath: '/repo', branchName, isAutoDetected: false }
    });
}

function harness(options: { branch?: string | null; start?: boolean } = {}): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: 'DDDDDDDD-0000-4000-8000-000000000001', name: 'w1', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: 'DDDDDDDD-0000-4000-8000-000000000002', name: 'w2', now: NOW });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    addRepo(store, R1, '/repo');
    associate(store, W1, A1, options.branch === undefined ? 'feat-x' : options.branch);
    const events: DomainEvent[] = [];
    store.subscribe((batch) => {
        events.push(...batch);
    });
    const gh = fakeGh();
    const git = fakeGit();
    const logs: string[] = [];
    const h: Harness = {
        store,
        gh,
        git,
        logs,
        events,
        enabled: true,
        poller: null as unknown as PullRequestPoller,
        prs: (workspaceID = W1) =>
            (store.getState().workspaces.find((workspace) => workspace.id === workspaceID)?.pullRequests ?? []).map(
                (entry) => ({ number: entry.number, state: entry.state, associationID: entry.associationID, branch: entry.branch, repoID: entry.repoID })
            )
    };
    h.poller = createPullRequestPoller({
        store,
        gh: (args) => gh.run(args),
        git,
        enabled: () => h.enabled,
        log: (message) => logs.push(message),
        now: () => Date.now()
    });
    if (options.start !== false) h.poller.start();
    return h;
}

/** Let every queued microtask and zero-delay timer run, without moving the clock. */
async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
}

let current: Harness | null = null;
function make(options?: Parameters<typeof harness>[0]): Harness {
    current = harness(options);
    return current;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    current?.poller.dispose();
    current = null;
    vi.useRealTimers();
});

describe('loggedInHosts', () => {
    it('reads every host gh holds a working token for, in either output format', () => {
        expect(loggedInHosts('github.com\n  ✓ Logged in to github.com account octo (keyring)\nghe.corp.com\n  X Failed to log in to ghe.corp.com account x')).toEqual(new Set(['github.com']));
        expect(loggedInHosts('  ✓ Logged in to GHE.corp.com as octo (oauth_token)')).toEqual(new Set(['ghe.corp.com']));
        expect(loggedInHosts('You are not logged into any GitHub hosts.')).toEqual(new Set());
    });
});

describe('createPullRequestPoller', () => {
    it('looks up each association branch against origin and puts the PRs on the workspace', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        expect(h.gh.calls[0]).toEqual(['auth', 'status']);
        expect(h.gh.prCalls()).toEqual([[
            'pr', 'list', '--repo=github.com/acme/widgets', '--head=feat-x', '--state=all', '--limit=20',
            '--json=number,title,url,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner'
        ]]);
        expect(h.prs()).toEqual([{ number: 12, state: 'open', associationID: A1, branch: 'feat-x', repoID: R1 }]);
        const entry = h.store.getState().workspaces[0]?.pullRequests[0];
        expect(entry?.title).toBe('PR 12');
        expect(entry?.url).toBe('https://github.com/acme/widgets/pull/12');
        // It reached clients the ordinary way: a workspace upsert carrying the list.
        expect(h.events.some((event) => event.kind === 'workspace-upserted' && event.workspace.pullRequests.length === 1)).toBe(true);
        expect(h.prs(W2)).toEqual([]);
    });

    it('maps a draft and sorts open, draft, merged, closed', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(3, 'closed'), wirePR(4, 'merged'), wirePR(5, 'draft'), wirePR(6, 'open')]);
        h.poller.start();
        await flush();
        expect(h.prs().map((entry) => [entry.number, entry.state])).toEqual([[6, 'open'], [5, 'draft'], [4, 'merged'], [3, 'closed']]);
    });

    it('skips the default branch, a detached HEAD and an unread branch without running gh', async () => {
        for (const branch of ['main', 'HEAD', null]) {
            const h = make({ branch });
            await flush();
            expect(h.gh.calls).toEqual([]);
            expect(h.prs()).toEqual([]);
            h.poller.dispose();
        }
    });

    it('runs no gh at all for a repo whose origin is not on GitHub, and reads that origin once an hour', async () => {
        const h = make({ start: false });
        h.git.remotes.set('/repo', '/Users/me/origin.git');
        h.poller.start();
        await flush();
        await advance(PR_IDLE_INTERVAL_MS * 3);
        expect(h.gh.calls).toEqual([]);
        expect(h.git.remoteReads).toBe(1);
    });

    it('skips a host gh is not logged in to (an SSH alias, or an unauthenticated GHE host)', async () => {
        const h = make({ start: false });
        h.git.remotes.set('/repo', 'git@github-work:acme/widgets.git');
        h.poller.start();
        await flush();
        expect(h.gh.prCalls()).toEqual([]);
        expect(h.prs()).toEqual([]);
    });

    it('uses a GitHub Enterprise host gh is logged in to', async () => {
        const h = make({ start: false });
        h.gh.auth = ok('  ✓ Logged in to ghe.corp.com account octo (keyring)\n');
        h.git.remotes.set('/repo', 'https://ghe.corp.com/acme/widgets.git');
        h.gh.pulls.set('feat-x', [wirePR(7, 'open', { url: 'https://ghe.corp.com/acme/widgets/pull/7' })]);
        h.poller.start();
        await flush();
        expect(h.gh.prCalls()[0]).toContain('--repo=ghe.corp.com/acme/widgets');
        expect(h.prs().map((entry) => entry.number)).toEqual([7]);
    });

    it('looks a branch up once for every workspace on it', async () => {
        const h = make({ start: false });
        associate(h.store, W2, A2, 'feat-x');
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        expect(h.gh.prCalls()).toHaveLength(1);
        expect(h.prs(W1).map((entry) => entry.associationID)).toEqual([A1]);
        expect(h.prs(W2).map((entry) => entry.associationID)).toEqual([A2]);
    });

    it('drops a fork PR whose branch has the same name, and one whose head repo is gone', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [
            wirePR(20, 'open', { owner: 'someone-else' }),
            wirePR(21, 'open', { repo: 'widgets-fork' }),
            wirePR(22, 'open', { repo: null }),
            wirePR(23, 'open', { branch: 'feat-x-2' }),
            wirePR(24, 'open', { owner: 'ACME', repo: 'Widgets' })
        ]);
        h.poller.start();
        await flush();
        expect(h.prs().map((entry) => entry.number)).toEqual([24]);
    });

    it('counts a merged PR only when its head is on this branch, so a reused name is not "merged"', async () => {
        const h = make({ start: false });
        const old = 'b'.repeat(40);
        h.gh.pulls.set('feat-x', [wirePR(30, 'merged', { oid: old }), wirePR(31, 'closed', { oid: 'not-a-sha' }), wirePR(32, 'merged')]);
        h.poller.start();
        await flush();
        expect(h.prs().map((entry) => entry.number)).toEqual([32]);
    });

    it('drops an entry with a non-https URL', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(40, 'open', { url: 'javascript:alert(1)' }), wirePR(41, 'open')]);
        h.poller.start();
        await flush();
        expect(h.prs().map((entry) => entry.number)).toEqual([41]);
    });

    it('polls the active workspace every minute and the others every five', async () => {
        const h = make({ start: false });
        addRepo(h.store, R2, '/other');
        h.git.remotes.set('/other', 'https://github.com/acme/other.git');
        associate(h.store, W2, A2, 'feat-y', R2);
        h.gh.pulls.set('feat-x', [wirePR(1, 'open')]);
        h.gh.pulls.set('feat-y', [wirePR(2, 'open', { branch: 'feat-y', repo: 'other' })]);
        h.poller.start();
        await flush();
        const heads = (): string[] => h.gh.prCalls().map((args) => args[3] as string);
        expect(heads().sort()).toEqual(['--head=feat-x', '--head=feat-y']);
        await advance(PR_ACTIVE_INTERVAL_MS);
        expect(heads().filter((head) => head === '--head=feat-x')).toHaveLength(2);
        expect(heads().filter((head) => head === '--head=feat-y')).toHaveLength(1);
        await advance(PR_IDLE_INTERVAL_MS - PR_ACTIVE_INTERVAL_MS);
        expect(heads().filter((head) => head === '--head=feat-y')).toHaveLength(2);
        expect(h.prs(W2).map((entry) => entry.number)).toEqual([2]);
    });

    it('polls a key whose PRs are all merged or closed only every fifteen minutes', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(1, 'merged')]);
        h.poller.start();
        await flush();
        expect(h.gh.prCalls()).toHaveLength(1);
        await advance(PR_IDLE_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(1);
        await advance(PR_SETTLED_INTERVAL_MS - PR_IDLE_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(2);
    });

    it('dispatches nothing when a poll finds the same PRs', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        const before = h.events.length;
        await advance(PR_ACTIVE_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(2);
        expect(h.events.length).toBe(before);
    });

    it('looks up a new branch after the debounce, and drops the old branch\'s PRs at once', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.gh.pulls.set('feat-z', [wirePR(13, 'draft', { branch: 'feat-z' })]);
        h.poller.start();
        await flush();
        h.store.dispatch({ type: 'set-repo-association-branch', workspaceID: W1, associationID: A1, branchName: 'feat-z' });
        await flush();
        expect(h.prs()).toEqual([]);
        expect(h.gh.prCalls()).toHaveLength(1);
        await advance(PR_DEBOUNCE_MS);
        expect(h.gh.prCalls().map((args) => args[3])).toEqual(['--head=feat-x', '--head=feat-z']);
        expect(h.prs().map((entry) => [entry.number, entry.state, entry.branch])).toEqual([[13, 'draft', 'feat-z']]);
    });

    it('does not look again for a store change that moves no key (a rename, a status read)', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        h.store.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        h.store.dispatch({ type: 'set-repo-association-branch', workspaceID: W1, associationID: A1, branchName: 'feat-x' });
        await advance(PR_DEBOUNCE_MS * 2);
        expect(h.gh.prCalls()).toHaveLength(1);
    });

    it('drops a PR when its association is removed', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        h.store.dispatch({ type: 'remove-repo-association', workspaceID: W1, associationID: A1 });
        await flush();
        expect(h.prs()).toEqual([]);
    });

    it('stands down with one log line when gh is missing, and looks again after ten minutes', async () => {
        const h = make({ start: false });
        h.gh.auth = MISSING;
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        expect(h.gh.calls).toEqual([['auth', 'status']]);
        expect(h.logs).toEqual(['pull request status: gh was not found; looking again in 10 min']);
        await advance(PR_UNAVAILABLE_RETRY_MS - 10_000);
        expect(h.gh.calls).toHaveLength(1);
        h.gh.auth = AUTH_OK;
        await advance(10_000);
        expect(h.gh.calls.map((args) => args[0])).toEqual(['auth', 'auth', 'pr']);
        expect(h.prs().map((entry) => entry.number)).toEqual([12]);
        expect(h.logs).toEqual(['pull request status: gh was not found; looking again in 10 min', 'pull request status: using gh']);
    });

    it('clears every row when gh turns out to be logged out mid-run, and recovers after a login', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        expect(h.prs()).toHaveLength(1);
        h.gh.pulls.set('feat-x', fail(4, 'To get started with GitHub CLI, please run:  gh auth login'));
        await advance(PR_ACTIVE_INTERVAL_MS);
        expect(h.prs()).toEqual([]);
        expect(h.logs.at(-1)).toBe('pull request status: gh is not logged in; looking again in 10 min');
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        await advance(PR_UNAVAILABLE_RETRY_MS);
        expect(h.prs()).toHaveLength(1);
    });

    it('pauses every lookup for fifteen minutes on a rate limit, keeping what it had', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        h.gh.pulls.set('feat-x', fail(1, 'GraphQL: API rate limit exceeded for user ID 1.'));
        await advance(PR_ACTIVE_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(2);
        expect(h.prs()).toHaveLength(1);
        expect(h.logs.at(-1)).toBe('pull request status: GitHub rate limit reached; pausing for 15 min');
        await advance(PR_RATE_LIMIT_PAUSE_MS - 10_000);
        expect(h.gh.prCalls()).toHaveLength(2);
        await advance(10_000);
        expect(h.gh.prCalls()).toHaveLength(3);
    });

    it('keeps the last good answer through any other failure', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        h.gh.pulls.set('feat-x', fail(1, 'error connecting to api.github.com'));
        await advance(PR_ACTIVE_INTERVAL_MS);
        h.gh.pulls.set('feat-x', ok('not json'));
        await advance(PR_ACTIVE_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(3);
        expect(h.prs().map((entry) => entry.number)).toEqual([12]);
        expect(h.logs).toEqual(['pull request status: using gh']);
    });

    it('spawns nothing while the setting is off, clears when turned off, and looks at once when turned on', async () => {
        const h = make({ start: false });
        h.enabled = false;
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await advance(PR_IDLE_INTERVAL_MS);
        expect(h.gh.calls).toEqual([]);
        h.enabled = true;
        h.poller.settingsChanged();
        await flush();
        expect(h.prs()).toHaveLength(1);
        h.enabled = false;
        h.poller.settingsChanged();
        await flush();
        expect(h.prs()).toEqual([]);
        const calls = h.gh.calls.length;
        await advance(PR_IDLE_INTERVAL_MS);
        expect(h.gh.calls.length).toBe(calls);
    });

    it('discards an answer that lands after its branch changed', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.gh.hold = 'feat-x';
        h.poller.start();
        await flush();
        h.store.dispatch({ type: 'set-repo-association-branch', workspaceID: W1, associationID: A1, branchName: 'feat-z' });
        h.gh.hold = null;
        h.gh.release();
        await flush();
        expect(h.prs()).toEqual([]);
    });

    it('discards an answer that lands after its workspace was deleted', async () => {
        const h = make({ start: false });
        associate(h.store, W2, A2, 'feat-x');
        h.store.dispatch({ type: 'remove-repo-association', workspaceID: W1, associationID: A1 });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.gh.hold = 'feat-x';
        h.poller.start();
        await flush();
        h.store.dispatch({ type: 'delete-workspace', id: W2 });
        h.gh.hold = null;
        h.gh.release();
        await flush();
        expect(h.store.getState().workspaces.every((workspace) => workspace.pullRequests.length === 0)).toBe(true);
    });

    it('runs at most two gh lookups at once', async () => {
        const h = make({ start: false });
        for (const [index, branch] of ['b1', 'b2', 'b3', 'b4'].entries()) {
            associate(h.store, W2, `CCCCCCCC-0000-4000-8000-00000000010${String(index)}`, branch);
        }
        h.poller.start();
        await flush();
        expect(h.gh.prCalls()).toHaveLength(5);
        expect(h.gh.maxRunning).toBeLessThanOrEqual(2);
    });

    it('stops looking when disposed', async () => {
        const h = make({ start: false });
        h.gh.pulls.set('feat-x', [wirePR(12, 'open')]);
        h.poller.start();
        await flush();
        h.poller.dispose();
        await advance(PR_SETTLED_INTERVAL_MS);
        expect(h.gh.prCalls()).toHaveLength(1);
    });
});
