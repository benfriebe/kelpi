/**
 * Settings ▸ Repositories' four registry verbs (`repo-add` / `repo-remove` / `repo-rename` /
 * `repo-scan`), which edit the GLOBAL registry rather than a workspace's associations.
 *
 * They are handled directly here rather than through a `SyncHub` session: `repos.test.ts`
 * already proves the routing for every name in `REPO_COMMANDS`, and what is worth pinning here
 * is the behaviour the Swift reducer specifies — promotion, the cascade, and the scan's
 * skip-what-is-known rule.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@kelpi/protocol';
import { afterAll, describe, expect, it } from 'vitest';

import type { RepoGitStatus } from '../git/index.js';
import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import { handleRepoCommand, type RepoChannel, type RepoCommandGit } from './repos.js';

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const R1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const NOW = 1_700_000_000_000;

function stubGit(remote: string | null = 'git@example.invalid:acme/app.git'): RepoCommandGit {
    return {
        resolveRepoRoot: async (directory) => ({ worktreeRoot: directory, parentRepoRoot: directory }),
        getCurrentBranch: async () => 'main',
        getStatus: async (): Promise<RepoGitStatus> => ({ kind: 'clean' }),
        getRemoteURL: async () => remote,
        worktreeAdd: async () => {},
        removeWorktree: async () => {}
    };
}

interface Fixture {
    readonly store: KelpiStore;
    readonly channel: RepoChannel;
    readonly persists: () => number;
}

function fixture(git: RepoCommandGit = stubGit()): Fixture {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    let counter = 0;
    let persists = 0;
    return {
        store,
        persists: () => persists,
        channel: {
            store,
            git,
            worktreeBasePath: '~/nex/worktrees/<repo>',
            uuid: () => {
                counter += 1;
                return `ffffffff-0000-4000-8000-${String(counter).padStart(12, '0')}`;
            },
            now: () => NOW,
            persist: () => {
                persists += 1;
            }
        }
    };
}

function seedRepo(f: Fixture, options: { path?: string; auto?: boolean } = {}): void {
    f.store.dispatch({
        type: 'add-repo',
        repo: {
            id: R1,
            path: options.path ?? '/src/app',
            name: 'app',
            remoteURL: null,
            lastAccessedAt: NOW / 1000,
            isAutoDiscovered: options.auto ?? false
        }
    });
}

const call = (f: Fixture, command: Parameters<typeof handleRepoCommand>[1], payload: JsonObject) =>
    handleRepoCommand(f.channel, command, payload);

describe('repo-add (§GIT-068, §GIT-069, §SET-054)', () => {
    it('registers a new repo with its basename and its origin URL', async () => {
        const f = fixture();
        const reply = await call(f, 'repo-add', { path: '/src/app' });
        expect(reply).toMatchObject({ ok: true, already_registered: false, promoted: false });
        expect(f.store.getState().repos[0]).toMatchObject({
            path: '/src/app',
            name: 'app',
            remoteURL: 'git@example.invalid:acme/app.git',
            isAutoDiscovered: false
        });
        expect(f.persists()).toBe(1);
    });

    it('honours an explicit name', async () => {
        const f = fixture();
        await call(f, 'repo-add', { path: '/src/app', name: 'Work App' });
        expect(f.store.getState().repos[0]?.name).toBe('Work App');
    });

    it('PROMOTES an auto-discovered row instead of duplicating it (§GIT-068)', async () => {
        const f = fixture();
        seedRepo(f, { auto: true });
        const reply = await call(f, 'repo-add', { path: '/src/app' });
        expect(reply).toMatchObject({ ok: true, already_registered: true, promoted: true, repo_id: R1 });
        const repos = f.store.getState().repos;
        expect(repos).toHaveLength(1);
        expect(repos[0]?.isAutoDiscovered).toBe(false);
    });

    it('is a quiet no-op for a repo that is already manual', async () => {
        const f = fixture();
        seedRepo(f, { auto: false });
        const reply = await call(f, 'repo-add', { path: '/src/app' });
        expect(reply).toMatchObject({ ok: true, already_registered: true, promoted: false });
        expect(f.persists()).toBe(0);
        expect(f.store.getState().repos).toHaveLength(1);
    });

    it('survives a repo with no origin remote', async () => {
        const f = fixture(stubGit(null));
        await call(f, 'repo-add', { path: '/src/app' });
        expect(f.store.getState().repos[0]?.remoteURL).toBeNull();
    });

    it('requires a path', async () => {
        expect(await call(fixture(), 'repo-add', {})).toMatchObject({ ok: false });
    });
});

describe('repo-remove (§GIT-052, §GIT-071)', () => {
    it('drops the repo AND every association pointing at it, reporting which ones went', async () => {
        const f = fixture();
        seedRepo(f);
        f.store.dispatch({
            type: 'add-repo-association',
            workspaceID: W1,
            association: { id: A1, repoID: R1, worktreePath: '/src/app', branchName: 'main', isAutoDetected: false }
        });
        const reply = await call(f, 'repo-remove', { repo_id: R1 });
        expect(reply).toMatchObject({ ok: true, repo_id: R1, name: 'app', removed_associations: [A1] });
        expect(f.store.getState().repos).toEqual([]);
        expect(f.store.getState().workspaces[0]?.repoAssociations).toEqual([]);
    });

    it('rejects an unknown id', async () => {
        expect(await call(fixture(), 'repo-remove', { repo_id: R1 })).toMatchObject({ ok: false });
    });
});

describe('repo-rename (§GIT-072)', () => {
    it('renames the display row and persists', async () => {
        const f = fixture();
        seedRepo(f);
        const reply = await call(f, 'repo-rename', { repo_id: R1, name: 'Renamed' });
        expect(reply).toMatchObject({ ok: true });
        expect(f.store.getState().repos[0]).toMatchObject({ name: 'Renamed', path: '/src/app' });
        expect(f.persists()).toBe(1);
    });

    it('needs both an id and a name, and refuses an unknown repo', async () => {
        const f = fixture();
        expect(await call(f, 'repo-rename', { repo_id: R1 })).toMatchObject({ ok: false });
        expect(await call(f, 'repo-rename', { name: 'x' })).toMatchObject({ ok: false });
        expect(await call(f, 'repo-rename', { repo_id: R1, name: 'x' })).toMatchObject({ ok: false });
    });
});

describe('repo-scan (§GIT-066, §GIT-067, §SET-053)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-registry-'));
    fs.mkdirSync(path.join(root, 'alpha', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'beta', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plain'), { recursive: true });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('registers every find that is new and reports the ones already known (§GIT-067)', async () => {
        const f = fixture();
        seedRepo(f, { path: path.join(root, 'alpha') });
        const reply = await call(f, 'repo-scan', { path: root });
        expect(reply).toMatchObject({ ok: true, scanned: 2, skipped: [path.join(root, 'alpha')] });
        expect((reply['added'] as JsonObject[]).map((entry) => entry['name'])).toEqual(['beta']);
        expect(f.store.getState().repos.map((repo) => repo.name).sort()).toEqual(['app', 'beta']);
        // Scanned rows are MANUAL: the user asked for them, so the GC must never take them.
        expect(f.store.getState().repos.every((repo) => !repo.isAutoDiscovered)).toBe(true);
    });

    it('adds nothing twice when run again', async () => {
        const f = fixture();
        await call(f, 'repo-scan', { path: root });
        const second = await call(f, 'repo-scan', { path: root });
        expect(second['added']).toEqual([]);
        expect(f.store.getState().repos).toHaveLength(2);
    });

    it('answers ok with nothing found for a directory that holds no repos', async () => {
        const f = fixture();
        const reply = await call(f, 'repo-scan', { path: path.join(root, 'plain') });
        expect(reply).toMatchObject({ ok: true, scanned: 0, added: [], skipped: [] });
    });

    it('requires a path', async () => {
        expect(await call(fixture(), 'repo-scan', {})).toMatchObject({ ok: false });
    });
});
