import { describe, expect, it } from 'vitest';

import type { GraftSession } from './types.js';
import { GRAFT_CHANGED_EVENT, graftChangedEvent, graftSessionEntry, graftStartedEntry } from './wire.js';

const SESSION: GraftSession = {
    id: '5e9c1b4e-6c1d-4a6b-9a87-2c51f0b0d001',
    worktreePath: '/Users/ben/nex/worktrees/my-feature',
    parentRepoRoot: '/Users/ben/code/myrepo',
    branch: 'feature/x',
    status: { kind: 'watching' },
    stashRef: null,
    lastSyncAt: null,
    preGraftBranch: 'main',
    preGraftSha: 'abc',
    worktreePreGraftSha: null
};

describe('graftSessionEntry', () => {
    it('uppercases the id and elides the optional fields', () => {
        expect(graftSessionEntry(SESSION)).toEqual({
            association_id: '5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001',
            worktree_path: '/Users/ben/nex/worktrees/my-feature',
            parent_repo_root: '/Users/ben/code/myrepo',
            branch: 'feature/x',
            status: 'watching'
        });
    });

    it('adds error / stash_ref / second-precision last_sync when known', () => {
        const entry = graftSessionEntry({
            ...SESSION,
            status: { kind: 'error', message: 'Sync failed: boom' },
            stashRef: 'deadbeef42',
            lastSyncAt: Date.UTC(2026, 7, 18, 9, 30, 12, 999)
        });
        expect(entry['status']).toBe('error');
        expect(entry['error']).toBe('Sync failed: boom');
        expect(entry['stash_ref']).toBe('deadbeef42');
        expect(entry['last_sync']).toBe('2026-08-18T09:30:12Z');
    });

    it('carries each status kind through verbatim', () => {
        for (const kind of ['starting', 'watching', 'syncing'] as const) {
            expect(graftSessionEntry({ ...SESSION, status: { kind } })['status']).toBe(kind);
        }
    });
});

describe('graftStartedEntry', () => {
    it('is the four-field start reply shape', () => {
        expect(graftStartedEntry(SESSION)).toEqual({
            association_id: '5E9C1B4E-6C1D-4A6B-9A87-2C51F0B0D001',
            worktree_path: '/Users/ben/nex/worktrees/my-feature',
            branch: 'feature/x',
            parent_repo_root: '/Users/ben/code/myrepo'
        });
    });
});

describe('graftChangedEvent', () => {
    it('is the WS lifecycle broadcast clients render status dots from', () => {
        expect(graftChangedEvent([SESSION])).toEqual({
            type: GRAFT_CHANGED_EVENT,
            sessions: [graftSessionEntry(SESSION)]
        });
        expect(graftChangedEvent([])).toEqual({ type: 'graft-changed', sessions: [] });
    });
});
