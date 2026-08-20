/**
 * Graft's client state machine: the two placeholder states the daemon cannot know about, the
 * merge rule that keeps them alive across a broadcast, and §GIT-048's five tooltip strings.
 */

import { describe, expect, it } from 'vitest';

import {
    EMPTY_GRAFT_STATE,
    errorPlaceholder,
    graftReducer,
    graftTooltip,
    mergeSessions,
    parseGraftOrphans,
    parseGraftSession,
    parseGraftSessions,
    parseGraftSnapshot,
    relativeTime,
    startingPlaceholder,
    type GraftSessionView,
    type GraftState
} from './graft';

const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const A2 = 'CCCCCCCC-0000-4000-8000-000000000002';

function watching(id = A1, overrides: Partial<GraftSessionView> = {}): GraftSessionView {
    return {
        associationID: id,
        worktreePath: '/work/wt',
        parentRepoRoot: '/work/repo',
        branch: 'feature',
        status: 'watching',
        error: null,
        lastSyncAt: null,
        ...overrides
    };
}

function withSession(session: GraftSessionView): GraftState {
    return { ...EMPTY_GRAFT_STATE, sessions: { [session.associationID]: session } };
}

describe('the reducer', () => {
    it('places, replaces and removes a session by association id', () => {
        const placed = graftReducer(EMPTY_GRAFT_STATE, {
            kind: 'start-requested',
            session: startingPlaceholder({ associationID: A1, worktreePath: '/work/wt', branch: 'feature' })
        });
        expect(placed.sessions[A1]?.status).toBe('starting');

        const live = graftReducer(placed, { kind: 'start-succeeded', session: watching() });
        expect(live.sessions[A1]?.status).toBe('watching');

        const gone = graftReducer(live, { kind: 'stop-succeeded', associationID: A1 });
        expect(gone.sessions[A1]).toBeUndefined();
    });

    it('marks an existing session `.error` when a stop fails, and never invents one (§GIT-036)', () => {
        const marked = graftReducer(withSession(watching()), {
            kind: 'stop-failed',
            associationID: A1,
            error: 'stash pop conflict'
        });
        expect(marked.sessions[A1]).toMatchObject({ status: 'error', error: 'stash pop conflict' });

        const untouched = graftReducer(EMPTY_GRAFT_STATE, {
            kind: 'stop-failed',
            associationID: A1,
            error: 'x'
        });
        expect(untouched.sessions[A1]).toBeUndefined();
    });

    it('raises and clears the swap prompt (§GIT-042)', () => {
        const prompt = {
            associationID: A1,
            newBranch: 'feature',
            newWorktreePath: '/work/wt',
            existingSessionID: A2,
            existingBranch: 'other',
            existingWorktreePath: '/work/other',
            parentRepoRoot: '/work/repo'
        };
        const raised = graftReducer(EMPTY_GRAFT_STATE, { kind: 'swap-prompt', prompt });
        expect(raised.swapPrompt).toEqual(prompt);
        expect(graftReducer(raised, { kind: 'swap-cancelled' }).swapPrompt).toBeNull();
    });

    it('re-inserts a failed recovery’s orphan, and never duplicates it (§GIT-045)', () => {
        const orphan = {
            associationID: A1,
            parentRepoRoot: '/work/repo',
            worktreePath: '/work/wt',
            branch: 'feature'
        };
        const dropped = graftReducer(
            { ...EMPTY_GRAFT_STATE, orphans: [orphan] },
            { kind: 'orphan-removed', associationID: A1 }
        );
        expect(dropped.orphans).toEqual([]);
        const back = graftReducer(dropped, { kind: 'orphan-restored', orphan });
        expect(back.orphans).toEqual([orphan]);
        expect(graftReducer(back, { kind: 'orphan-restored', orphan }).orphans).toHaveLength(1);
    });
});

describe('mergeSessions — the broadcast is authoritative, except for what it cannot know', () => {
    it('keeps an in-flight `.starting` placeholder the engine has not published yet', () => {
        const state = withSession(startingPlaceholder({ associationID: A1, worktreePath: '/w', branch: 'b' }));
        expect(mergeSessions(state, []).sessions[A1]?.status).toBe('starting');
    });

    it('keeps an `.error` placeholder — it is the user’s only record of the failure', () => {
        const state = withSession(
            errorPlaceholder({ associationID: A1, worktreePath: '/w', branch: 'b', message: 'boom' })
        );
        expect(mergeSessions(state, []).sessions[A1]?.error).toBe('boom');
    });

    it('drops a live session the engine no longer lists (another window stopped it)', () => {
        expect(mergeSessions(withSession(watching()), []).sessions[A1]).toBeUndefined();
    });

    it('lets the engine’s row win over a placeholder for the same association', () => {
        const state = withSession(startingPlaceholder({ associationID: A1, worktreePath: '/w', branch: 'b' }));
        const merged = mergeSessions(state, [watching(A1, { status: 'syncing' })]);
        expect(merged.sessions[A1]?.status).toBe('syncing');
    });
});

describe('wire parsing', () => {
    it('reads a session entry, including the error string and the ISO last-sync', () => {
        const session = parseGraftSession({
            association_id: A1,
            worktree_path: '/work/wt',
            parent_repo_root: '/work/repo',
            branch: 'feature',
            status: 'error',
            error: 'Sync blocked',
            last_sync: '2026-08-20T10:00:00Z'
        });
        expect(session).toMatchObject({ status: 'error', error: 'Sync blocked' });
        expect(session?.lastSyncAt).toBe(Date.parse('2026-08-20T10:00:00Z'));
    });

    it('treats an unknown status as watching and drops an entry with no id', () => {
        expect(parseGraftSession({ association_id: A1, status: 'nonsense' })?.status).toBe('watching');
        expect(parseGraftSession({ status: 'watching' })).toBeNull();
        expect(parseGraftSessions('not an array')).toEqual([]);
    });

    it('reads both halves of a `graft-session-list` reply', () => {
        const snapshot = parseGraftSnapshot({
            ok: true,
            sessions: [{ association_id: A1, status: 'watching' }],
            orphans: [{ association_id: A2, parent_repo_root: '/work/repo', worktree_path: '/work/wt' }]
        });
        expect(snapshot.sessions).toHaveLength(1);
        expect(snapshot.orphans[0]).toMatchObject({ associationID: A2, parentRepoRoot: '/work/repo' });
        expect(parseGraftOrphans([{ parent_repo_root: '/x' }])).toEqual([]);
    });
});

describe('§GIT-048 tooltips', () => {
    const now = Date.parse('2026-08-20T10:00:00Z');

    it('explains what graft DOES when there is no session, naming the branch', () => {
        expect(graftTooltip({ session: undefined, branch: 'feature' })).toBe(
            "Mirror feature's tracked files into the parent repo's working tree. " +
                "Parent's branch stays put; untracked files (node_modules, build output) are untouched."
        );
    });

    it('falls back to "this worktree" when the branch is unknown', () => {
        expect(graftTooltip({ session: undefined, branch: null })).toContain("Mirror this worktree's tracked files");
    });

    it('names each live state', () => {
        expect(graftTooltip({ session: watching(A1, { status: 'starting' }), branch: 'feature' })).toBe(
            'Starting graft...'
        );
        expect(graftTooltip({ session: watching(A1, { status: 'syncing' }), branch: 'feature' })).toBe(
            'Syncing feature...'
        );
        expect(
            graftTooltip({ session: watching(A1, { status: 'error', error: 'boom' }), branch: 'feature' })
        ).toBe('Graft error: boom');
    });

    it('reads the last sync as a relative time, and says "Watching" before the first one', () => {
        const synced = graftTooltip({
            session: watching(A1, { lastSyncAt: now - 120_000 }),
            branch: 'feature',
            now
        });
        expect(synced).toContain('Mirroring feature into the parent. Last sync ');
        expect(synced).toContain("Stop to restore the parent's working tree.");
        expect(graftTooltip({ session: watching(), branch: 'feature', now })).toContain(
            'Mirroring feature into the parent. Watching. '
        );
    });

    it('scales the relative time by magnitude', () => {
        expect(relativeTime(now - 30_000, now)).toMatch(/sec/);
        expect(relativeTime(now - 5 * 60_000, now)).toMatch(/min/);
        expect(relativeTime(now - 3 * 3_600_000, now)).toMatch(/(hr|hour)/);
        expect(relativeTime(now - 3 * 86_400_000, now)).toMatch(/day/);
    });
});
