import { isWireCommand } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import { GraftError, type GraftOrphan, type GraftService, type GraftSession } from '../graft/index.js';
import { createStore, emptyDaemonState, type NexStore } from '../store/index.js';
import {
    GRAFT_UI_COMMANDS,
    createGraftOrphanRegistry,
    handleGraftUiCommand,
    isGraftUiCommand,
    type GraftChannel
} from './graft.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const R1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function session(overrides: Partial<GraftSession> = {}): GraftSession {
    return {
        id: A1,
        worktreePath: '/work/wt',
        parentRepoRoot: '/work/repo',
        branch: 'feature',
        status: { kind: 'watching' },
        stashRef: null,
        lastSyncAt: NOW,
        preGraftBranch: 'main',
        preGraftSha: '0'.repeat(40),
        worktreePreGraftSha: null,
        ...overrides
    };
}

function orphan(overrides: Partial<GraftOrphan> = {}): GraftOrphan {
    return {
        id: A1,
        parentRepoRoot: '/work/repo',
        worktreePath: '/work/wt',
        branch: 'feature',
        stashRef: 'abc123',
        preGraftBranch: 'main',
        preGraftSha: '0'.repeat(40),
        worktreePreGraftSha: null,
        ...overrides
    };
}

interface Harness {
    readonly store: NexStore;
    readonly channel: GraftChannel;
    readonly started: string[];
    readonly stopped: string[];
    readonly recovered: string[];
    readonly dismissed: string[];
    readonly broadcasts: (readonly GraftOrphan[])[];
}

function harness(
    overrides: Partial<GraftService> & { sessions?: readonly GraftSession[] } = {}
): Harness {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    store.dispatch({
        type: 'add-repo',
        repo: {
            id: R1,
            path: '/work/repo',
            name: 'repo',
            remoteURL: null,
            lastAccessedAt: NOW / 1000,
            isAutoDiscovered: false
        }
    });
    store.dispatch({
        type: 'add-repo-association',
        workspaceID: W1,
        association: {
            id: A1,
            repoID: R1,
            worktreePath: '/work/wt',
            branchName: 'feature',
            isAutoDetected: false
        }
    });

    const started: string[] = [];
    const stopped: string[] = [];
    const recovered: string[] = [];
    const dismissed: string[] = [];
    let live: readonly GraftSession[] = overrides.sessions ?? [];

    const graft: GraftService = {
        async start(association) {
            started.push(association.id);
            const created = session({ id: association.id, worktreePath: association.worktreePath });
            live = [...live, created];
            return created;
        },
        async stop(associationID) {
            stopped.push(associationID);
            live = live.filter((entry) => entry.id !== associationID);
        },
        activeSessions: () => live,
        session: (id) => live.find((entry) => entry.id === id) ?? null,
        updates: () => () => {},
        detectOrphans: () => [],
        async recoverOrphan(value) {
            recovered.push(value.id);
        },
        dismissOrphan(value) {
            dismissed.push(value.id);
        },
        async shutdown() {},
        claimedRoots: () => live.map((entry) => entry.parentRepoRoot),
        ...overrides
    };
    const orphans = createGraftOrphanRegistry(graft);
    const broadcasts: (readonly GraftOrphan[])[] = [];
    orphans.onChange((value) => broadcasts.push(value));
    return { store, channel: { store, graft, orphans }, started, stopped, recovered, dismissed, broadcasts };
}

describe('graft UI verbs', () => {
    it('claims exactly its own five command names, and none of the CLI vocabulary', () => {
        for (const command of GRAFT_UI_COMMANDS) {
            expect(isGraftUiCommand(command)).toBe(true);
            // WS-only by construction: a CLI verb would be a compatibility surface forever.
            expect(isWireCommand(command)).toBe(false);
        }
        // The CLI's scope-addressed verbs stay with the wire decoder.
        expect(isGraftUiCommand('graft-start')).toBe(false);
        expect(isGraftUiCommand('graft-status')).toBe(false);
    });

    it('starts one association by id and answers with the session (§GIT-035)', async () => {
        const h = harness();
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-start', { association_id: A1 });
        expect(reply['ok']).toBe(true);
        expect(h.started).toEqual([A1]);
        expect(reply['session']).toMatchObject({ branch: 'feature', status: 'watching' });
    });

    it('rejects an association id nothing owns, without touching the engine', async () => {
        const h = harness();
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-start', {
            association_id: 'CCCCCCCC-0000-4000-8000-00000000dead'
        });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('no repo association matches');
        expect(h.started).toEqual([]);
    });

    it('carries the contested parent root on an alreadyActive rejection (§GIT-038)', async () => {
        const h = harness({
            start: async () => {
                throw GraftError.alreadyActive('/work/repo');
            }
        });
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-start', { association_id: A1 });
        expect(reply).toMatchObject({
            ok: false,
            error_kind: 'alreadyActive',
            parent_repo_root: '/work/repo'
        });
    });

    it('reports a generic start failure with its kind, so the row can go red (§GIT-036)', async () => {
        const h = harness({
            start: async () => {
                throw GraftError.repoBusy('merge in progress');
            }
        });
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-start', { association_id: A1 });
        expect(reply).toMatchObject({ ok: false, error_kind: 'repoBusy' });
        expect(String(reply['error'])).toContain('merge in progress');
        expect(reply['parent_repo_root']).toBeUndefined();
    });

    it('stops by id, and stays ok for an id the engine never knew (§GIT-043 idempotence)', async () => {
        const h = harness({ sessions: [session()] });
        expect(await handleGraftUiCommand(h.channel, 'graft-session-stop', { association_id: A1 })).toMatchObject({
            ok: true
        });
        expect(h.stopped).toEqual([A1]);
        expect(
            await handleGraftUiCommand(h.channel, 'graft-session-stop', { association_id: A1 })
        ).toMatchObject({ ok: true });
    });

    it('surfaces a stop failure so the client can re-mark the session `.error` (§GIT-036)', async () => {
        const h = harness({
            stop: async () => {
                throw GraftError.stashPopConflict('abc123', 'CONFLICT (content)');
            }
        });
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-stop', { association_id: A1 });
        expect(reply).toMatchObject({ ok: false, error_kind: 'stashPopConflict' });
    });

    it('lists live sessions AND orphans — the client mirror and §GIT-039 owner lookup in one', async () => {
        const h = harness({ sessions: [session()] });
        h.channel.orphans.replace([orphan()]);
        const reply = await handleGraftUiCommand(h.channel, 'graft-session-list', {});
        expect(reply['ok']).toBe(true);
        expect(reply['sessions']).toHaveLength(1);
        expect((reply['sessions'] as Record<string, unknown>[])[0]).toMatchObject({
            parent_repo_root: '/work/repo'
        });
        expect((reply['orphans'] as Record<string, unknown>[])[0]).toMatchObject({
            parent_repo_root: '/work/repo',
            worktree_path: '/work/wt',
            stash_ref: 'abc123'
        });
    });
});

describe('orphan registry (§GIT-045, §GIT-051)', () => {
    it('recovers, drops the row and broadcasts the new set', async () => {
        const h = harness();
        h.channel.orphans.replace([orphan()]);
        const reply = await handleGraftUiCommand(h.channel, 'graft-orphan-recover', { association_id: A1 });
        expect(reply).toMatchObject({ ok: true });
        expect(h.recovered).toEqual([A1]);
        expect(h.channel.orphans.list()).toEqual([]);
        expect(h.broadcasts.at(-1)).toEqual([]);
    });

    it('KEEPS the orphan when recovery fails, so the banner reappears (§GIT-045)', async () => {
        const h = harness({
            recoverOrphan: async () => {
                throw GraftError.stashPopConflict('abc123', 'CONFLICT (content): README.md');
            }
        });
        h.channel.orphans.replace([orphan()]);
        const reply = await handleGraftUiCommand(h.channel, 'graft-orphan-recover', { association_id: A1 });
        expect(reply).toMatchObject({ ok: false });
        expect(String(reply['error'])).toContain('CONFLICT');
        expect(h.channel.orphans.list()).toHaveLength(1);
    });

    it('dismiss deletes the breadcrumb and the row; a second dismiss is an error, not a crash', async () => {
        const h = harness();
        h.channel.orphans.replace([orphan()]);
        expect(await handleGraftUiCommand(h.channel, 'graft-orphan-dismiss', { association_id: A1 })).toMatchObject({
            ok: true
        });
        expect(h.dismissed).toEqual([A1]);
        expect(h.channel.orphans.list()).toEqual([]);
        expect(await handleGraftUiCommand(h.channel, 'graft-orphan-dismiss', { association_id: A1 })).toMatchObject({
            ok: false
        });
    });

    it('requires an association_id on both orphan verbs', async () => {
        const h = harness();
        expect(await handleGraftUiCommand(h.channel, 'graft-orphan-recover', {})).toMatchObject({ ok: false });
        expect(await handleGraftUiCommand(h.channel, 'graft-orphan-dismiss', {})).toMatchObject({ ok: false });
    });
});
