import { describe, expect, it } from 'vitest';

import { GraftError, type GraftAssociation, type GraftService, type GraftSession } from '../../graft/index.js';
import type { DaemonState } from '../../store/index.js';
import {
    GRAFT_NO_MATCH_ERROR,
    GRAFT_NO_PANE_WORKSPACE_ERROR,
    GRAFT_SCOPE_REQUIRED_ERROR,
    GRAFT_START_FALLBACK_ERROR,
    resolveGraftAssociations
} from './graft.js';
import { flush, harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const R1 = id('99999999', 1);
const R2 = id('99999999', 2);
const A1 = id('cccc0000', 1);
const A2 = id('cccc0000', 2);
const GHOST = id('cccc0000', 9);

const WT1 = '/Users/test/nex/worktrees/feature-x';
const WT2 = '/Users/test/nex/worktrees/other';
const PARENT = '/Users/test/code/kelpi';

/** Two workspaces, each with one association, plus a two-entry repo registry. */
function seededWithAssociations(): DaemonState {
    const base = seeded(2);
    const withRepos: DaemonState = {
        ...base,
        repos: [
            {
                id: R1,
                path: PARENT,
                name: 'kelpi',
                remoteURL: null,
                lastAccessedAt: NOW / 1000,
                isAutoDiscovered: false
            },
            {
                id: R2,
                path: '/Users/test/code/other',
                name: 'other',
                remoteURL: null,
                lastAccessedAt: NOW / 1000,
                isAutoDiscovered: false
            }
        ],
        workspaces: base.workspaces.map((workspace, index) =>
            index === 0
                ? {
                      ...workspace,
                      repoAssociations: [
                          {
                              id: A1,
                              repoID: R1,
                              worktreePath: WT1,
                              branchName: 'feature/x',
                              isAutoDetected: false
                          }
                      ]
                  }
                : {
                      ...workspace,
                      repoAssociations: [
                          {
                              id: A2,
                              repoID: R2,
                              worktreePath: WT2,
                              branchName: 'other',
                              isAutoDetected: false
                          }
                      ]
                  }
        )
    };
    return withRepos;
}

function session(overrides: Partial<GraftSession> = {}): GraftSession {
    return {
        id: A1,
        worktreePath: WT1,
        parentRepoRoot: PARENT,
        branch: 'feature/x',
        status: { kind: 'watching' },
        stashRef: null,
        lastSyncAt: null,
        preGraftBranch: 'main',
        preGraftSha: 'abc123',
        worktreePreGraftSha: null,
        ...overrides
    };
}

interface FakeGraft extends GraftService {
    readonly startCalls: GraftAssociation[];
    readonly stopCalls: string[];
    sessions: GraftSession[];
    startResult: (association: GraftAssociation) => Promise<GraftSession>;
    stopResult: (associationID: string) => Promise<void>;
}

function fakeGraft(initial: GraftSession[] = []): FakeGraft {
    const startCalls: GraftAssociation[] = [];
    const stopCalls: string[] = [];
    const fake: FakeGraft = {
        sessions: initial,
        startCalls,
        stopCalls,
        startResult: async (association) => session({ id: association.id }),
        stopResult: async () => {},
        async start(association) {
            startCalls.push(association);
            return fake.startResult(association);
        },
        async stop(associationID) {
            stopCalls.push(associationID);
            await fake.stopResult(associationID);
        },
        activeSessions: () => fake.sessions,
        session: (associationID) =>
            fake.sessions.find((entry) => entry.id === associationID) ?? null,
        updates: () => () => {},
        detectOrphans: () => [],
        recoverOrphan: async () => {},
        dismissOrphan: () => {},
        shutdown: async () => {},
        claimedRoots: () => []
    };
    return fake;
}

// ---------------------------------------------------------------------------
// scope resolution (§9.1)
// ---------------------------------------------------------------------------

describe('resolveGraftAssociations', () => {
    const state = seededWithAssociations();

    it('requires at least one scope', () => {
        expect(resolveGraftAssociations(state, undefined, undefined, undefined)).toEqual({
            ok: false,
            error: GRAFT_SCOPE_REQUIRED_ERROR
        });
    });

    it('scopes by workspace with the LENIENT resolver (case-insensitive, slug-aware)', () => {
        const byName = resolveGraftAssociations(state, 'W1', undefined, undefined);
        expect(byName.ok && byName.associations.map((a) => a.id)).toEqual([A1]);
        const bySlug = resolveGraftAssociations(
            state,
            state.workspaces[0]?.slug ?? '',
            undefined,
            undefined
        );
        expect(bySlug.ok && bySlug.associations.map((a) => a.id)).toEqual([A1]);
        expect(resolveGraftAssociations(state, 'nope', undefined, undefined)).toEqual({
            ok: false,
            error: 'workspace not found: nope'
        });
    });

    it('scopes by the requesting pane, parked panes included', () => {
        const scoped = resolveGraftAssociations(state, undefined, undefined, P2);
        expect(scoped.ok && scoped.associations.map((a) => a.id)).toEqual([A2]);
        expect(
            resolveGraftAssociations(state, undefined, undefined, id('dddddddd', 9))
        ).toEqual({ ok: false, error: GRAFT_NO_PANE_WORKSPACE_ERROR });
    });

    it('searches every workspace for a repo-only filter, matching path, folder or repo name', () => {
        for (const filter of [WT1, 'feature-x', 'kelpi']) {
            const scoped = resolveGraftAssociations(state, undefined, filter, undefined);
            expect(scoped.ok && scoped.associations.map((a) => a.id)).toEqual([A1]);
        }
        expect(resolveGraftAssociations(state, undefined, 'ghost', undefined)).toEqual({
            ok: false,
            error: GRAFT_NO_MATCH_ERROR
        });
    });

    it('composes workspace + repo filters (the repo narrows within the workspace)', () => {
        const hit = resolveGraftAssociations(state, 'w1', 'feature-x', undefined);
        expect(hit.ok && hit.associations.map((a) => a.id)).toEqual([A1]);
        // The association lives in w1, so scoping to w2 finds nothing.
        expect(resolveGraftAssociations(state, 'w2', 'feature-x', undefined)).toEqual({
            ok: false,
            error: GRAFT_NO_MATCH_ERROR
        });
    });

    it('prefers the workspace filter over the pane, and the pane over the repo-wide search', () => {
        const workspaceWins = resolveGraftAssociations(state, 'w2', undefined, P1);
        expect(workspaceWins.ok && workspaceWins.associations.map((a) => a.id)).toEqual([A2]);
        const paneWins = resolveGraftAssociations(state, undefined, WT1, P2);
        // Pane scope = w2, whose association does not match the WT1 filter.
        expect(paneWins).toEqual({ ok: false, error: GRAFT_NO_MATCH_ERROR });
    });
});

// ---------------------------------------------------------------------------
// graft-start (§9.2)
// ---------------------------------------------------------------------------

describe('graft-start', () => {
    it('replies with one started entry per session', async () => {
        const graft = fakeGraft();
        const h = harness({ initial: seededWithAssociations(), graft });
        h.send({ command: 'graft-start', pane_id: P1 });
        await flush();
        expect(graft.startCalls).toEqual([
            { id: A1, worktreePath: WT1, branchName: 'feature/x' }
        ]);
        expect(h.replies[0]?.payloads[0]).toEqual({
            ok: true,
            started: [
                {
                    association_id: A1,
                    worktree_path: WT1,
                    branch: 'feature/x',
                    parent_repo_root: PARENT
                }
            ]
        });
        expect(h.replies[0]?.closed).toBe(true);
    });

    it('fails with the LAST error plus a machine-readable error_kind when nothing started', async () => {
        const graft = fakeGraft();
        graft.startResult = async () => {
            throw GraftError.alreadyActive(PARENT);
        };
        const h = harness({ initial: seededWithAssociations(), graft });
        h.send({ command: 'graft-start', pane_id: P1 });
        await flush();
        expect(h.replies[0]?.payloads[0]).toEqual({
            ok: false,
            error: `another graft is already active for ${PARENT}`,
            error_kind: 'alreadyActive'
        });
    });

    it('surfaces partial_error when one association of the scope fails', async () => {
        const state = seededWithAssociations();
        // Put both associations in ONE workspace so a single pane scope covers both.
        const merged: DaemonState = {
            ...state,
            workspaces: state.workspaces.map((workspace, index) =>
                index === 0
                    ? {
                          ...workspace,
                          repoAssociations: [
                              ...workspace.repoAssociations,
                              {
                                  id: A2,
                                  repoID: R2,
                                  worktreePath: WT2,
                                  branchName: 'other',
                                  isAutoDetected: false
                              }
                          ]
                      }
                    : workspace
            )
        };
        const graft = fakeGraft();
        graft.startResult = async (association) => {
            if (association.id === A2) throw GraftError.repoBusy('rebase in progress');
            return session({ id: association.id });
        };
        const h = harness({ initial: merged, graft });
        h.send({ command: 'graft-start', pane_id: P1 });
        await flush();
        expect(h.replies[0]?.payloads[0]).toEqual({
            ok: true,
            started: [
                {
                    association_id: A1,
                    worktree_path: WT1,
                    branch: 'feature/x',
                    parent_repo_root: PARENT
                }
            ],
            partial_error: 'repository is busy: rebase in progress',
            partial_error_kind: 'repoBusy'
        });
    });

    it('rejects an unresolvable scope before touching the engine', async () => {
        const graft = fakeGraft();
        const h = harness({ initial: seededWithAssociations(), graft });
        expect(h.reply({ command: 'graft-start' })).toEqual({
            ok: false,
            error: GRAFT_SCOPE_REQUIRED_ERROR,
            error_kind: 'scope'
        });
        expect(graft.startCalls).toEqual([]);
    });

    it('falls back to a generic message when an empty scope somehow starts nothing', async () => {
        const graft = fakeGraft();
        graft.startResult = async () => {
            throw new Error('');
        };
        const h = harness({ initial: seededWithAssociations(), graft });
        h.send({ command: 'graft-start', pane_id: P1 });
        await flush();
        expect(h.replies[0]?.payloads[0]?.['ok']).toBe(false);
        expect(h.replies[0]?.payloads[0]?.['error_kind']).toBe('unknown');
        expect(GRAFT_START_FALLBACK_ERROR).toBe('graft start failed');
    });
});

// ---------------------------------------------------------------------------
// graft-stop (§9.3)
// ---------------------------------------------------------------------------

describe('graft-stop', () => {
    it('stops the sessions inside the resolved scope', async () => {
        const graft = fakeGraft([session()]);
        const h = harness({ initial: seededWithAssociations(), graft });
        h.send({ command: 'graft-stop', pane_id: P1 });
        await flush();
        expect(graft.stopCalls).toEqual([A1]);
        expect(h.replies[0]?.payloads[0]).toEqual({ ok: true, stopped: [A1] });
    });

    it('answers ok:true with an empty list when the scope holds no live session', async () => {
        const graft = fakeGraft();
        const h = harness({ initial: seededWithAssociations(), graft });
        expect(h.reply({ command: 'graft-stop', pane_id: P1 })).toEqual({
            ok: true,
            stopped: []
        });
        expect(graft.stopCalls).toEqual([]);
    });

    it('matches an ORPHANED session by --repo path when its association is gone', async () => {
        // The session's association no longer exists anywhere in the store (issue #231).
        const graft = fakeGraft([session({ id: GHOST })]);
        const h = harness({ initial: seeded(1), graft });
        h.send({ command: 'graft-stop', repo: WT1 });
        await flush();
        expect(graft.stopCalls).toEqual([GHOST]);
        expect(h.replies[0]?.payloads[0]).toEqual({ ok: true, stopped: [GHOST] });
    });

    it('matches an orphan by worktree folder name, parent root and parent folder name', async () => {
        for (const filter of ['feature-x', PARENT, 'kelpi']) {
            const graft = fakeGraft([session({ id: GHOST })]);
            const h = harness({ initial: seeded(1), graft });
            h.send({ command: 'graft-stop', repo: filter });
            await flush();
            expect(graft.stopCalls).toEqual([GHOST]);
        }
    });

    it('keeps a workspace-scoped resolution failure fatal', async () => {
        const graft = fakeGraft([session({ id: GHOST })]);
        const h = harness({ initial: seeded(1), graft });
        expect(h.reply({ command: 'graft-stop', workspace: 'nope', repo: WT1 })).toEqual({
            ok: false,
            error: 'workspace not found: nope',
            error_kind: 'scope'
        });
        expect(graft.stopCalls).toEqual([]);
    });

    it('reports a failed stop with failed[], a summary error and error_kind', async () => {
        const graft = fakeGraft([session()]);
        graft.stopResult = async () => {
            throw GraftError.stashPopConflict('deadbeef42', 'CONFLICT in keep.txt');
        };
        const h = harness({ initial: seededWithAssociations(), graft });
        h.send({ command: 'graft-stop', pane_id: P1 });
        await flush();
        const payload = h.replies[0]?.payloads[0] as Record<string, unknown>;
        expect(payload['ok']).toBe(false);
        expect(payload['stopped']).toEqual([]);
        expect(payload['failed']).toEqual([
            {
                association_id: A1,
                error:
                    "couldn't restore the parent's stashed changes (stash deadbeef42): CONFLICT in keep.txt",
                error_kind: 'stashPopConflict'
            }
        ]);
        // Additive summary so the shipped CLI prints something better than "unknown error".
        expect(payload['error']).toBe(
            "couldn't restore the parent's stashed changes (stash deadbeef42): CONFLICT in keep.txt"
        );
        expect(payload['error_kind']).toBe('stashPopConflict');
    });

    it('keeps `stopped` alongside `failed` on a partial teardown', async () => {
        const graft = fakeGraft([session(), session({ id: A2, worktreePath: WT2 })]);
        graft.stopResult = async (associationID) => {
            if (associationID === A2) throw new Error('restore failed');
        };
        const h = harness({ initial: seededWithAssociations(), graft });
        // A repo-less, workspace-less path: the orphan fallback plus the resolved scope.
        h.send({ command: 'graft-stop', repo: 'kelpi', pane_id: P1 });
        await flush();
        const payload = h.replies[0]?.payloads[0] as Record<string, unknown>;
        expect(payload['stopped']).toEqual([A1]);
        expect(payload['ok']).toBe(false);
        expect((payload['failed'] as unknown[]).length).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// graft-status (§9.4)
// ---------------------------------------------------------------------------

describe('graft-status', () => {
    it('reports the ENGINE sessions, with optional fields elided', () => {
        const graft = fakeGraft([session()]);
        const h = harness({ initial: seeded(1), graft });
        expect(h.reply({ command: 'graft-status' })).toEqual({
            ok: true,
            sessions: [
                {
                    association_id: A1,
                    worktree_path: WT1,
                    parent_repo_root: PARENT,
                    branch: 'feature/x',
                    status: 'watching'
                }
            ]
        });
    });

    it('adds error, stash_ref and a second-precision ISO last_sync when set', () => {
        const graft = fakeGraft([
            session({
                status: { kind: 'error', message: 'Sync blocked - nope' },
                stashRef: 'deadbeef42',
                lastSyncAt: Date.UTC(2026, 7, 18, 9, 30, 12, 456)
            })
        ]);
        const h = harness({ initial: seeded(1), graft });
        expect(h.reply({ command: 'graft-status' })).toEqual({
            ok: true,
            sessions: [
                {
                    association_id: A1,
                    worktree_path: WT1,
                    parent_repo_root: PARENT,
                    branch: 'feature/x',
                    status: 'error',
                    error: 'Sync blocked - nope',
                    stash_ref: 'deadbeef42',
                    last_sync: '2026-08-18T09:30:12Z'
                }
            ]
        });
    });

    it('reports an empty array when nothing is grafting', () => {
        const h = harness({ initial: seeded(1), graft: fakeGraft() });
        expect(h.reply({ command: 'graft-status' })).toEqual({ ok: true, sessions: [] });
    });
});
