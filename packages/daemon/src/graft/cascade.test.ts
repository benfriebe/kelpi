/**
 * The two removal cascades, end to end, against a real git repo + worktree and a LIVE graft
 * session (graft-git.md §GIT-052 / §GIT-053).
 *
 * `associations.test.ts` proves the reconciler calls `headWatch.stop` + `graft.stop` for a
 * vanished association with stubs on both ends. What it cannot prove is the thing the items
 * actually promise the user: that pressing **Remove** on a repository — or on a single
 * association — *unwinds a graft that is running right now*, and hands the parent checkout back
 * with its own uncommitted work.
 *
 * So this suite wires the production pieces together and pulls the same lever the UI pulls:
 *
 *   `handleRepoCommand('repo-remove' | 'remove-repo-association')`   ← the WS verb the
 *        ↓                                                             Settings ▸ Repositories
 *   store `remove-repo` / `remove-repo-association`                    row and the inspector's
 *        ↓                                                             Remove button send
 *   `createRepoAssociationWatch` reconcile  →  headWatch.stop + graft.stop (§8.8)
 *        ↓
 *   the real graft engine's stop sequence  →  parent restored, stash popped, breadcrumb gone
 *
 * The HEAD watcher is the only stub (its own file covers it, and real `fs.watch` timing would
 * make the cascade flaky); git, the store, the reducers, the WS handlers and the graft engine
 * are all real.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createGitService, resolveGitExecutable } from '../git/index.js';
import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import { handleRepoCommand, type RepoChannel } from '../ws/repos.js';
import { breadcrumbPath } from './breadcrumb.js';
import {
    createRepoAssociationWatch,
    type RepoAssociationWatchService
} from './associations.js';
import type { HeadWatchService } from './head-watcher.js';
import { createGraftService, type GraftService } from './service.js';

const GIT = resolveGitExecutable();

function gitAvailable(): boolean {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const HAS_GIT = gitAvailable();
const roots: string[] = [];

const HOME = '/Users/test';
const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const R1 = 'BBBBBBBB-0000-4000-8000-000000000001';
const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-graft-${prefix}-`));
    roots.push(dir);
    return dir;
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'kelpi',
            GIT_AUTHOR_EMAIL: 'kelpi@example.com',
            GIT_COMMITTER_NAME: 'kelpi',
            GIT_COMMITTER_EMAIL: 'kelpi@example.com',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null'
        }
    });
}

interface Fixture {
    readonly parent: string;
    readonly worktree: string;
}

/** Parent on `main` with an uncommitted edit; linked worktree on `feature` with its own file. */
function fixture(prefix: string): Fixture {
    const container = tmpDir(prefix);
    const parent = path.join(container, 'repo');
    fs.mkdirSync(parent);
    git(parent, 'init', '--initial-branch=main');
    fs.writeFileSync(path.join(parent, 'README.md'), '# hi\n');
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'original\n');
    git(parent, 'add', '.');
    git(parent, 'commit', '-m', 'initial');

    const worktree = path.join(container, 'wt-feature');
    git(parent, 'worktree', 'add', '-b', 'feature', worktree);
    fs.writeFileSync(path.join(worktree, 'MIRROR.md'), 'from the worktree\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'worktree work');

    fs.writeFileSync(path.join(parent, 'keep.txt'), 'local edit\n');
    return { parent: fs.realpathSync(parent), worktree: fs.realpathSync(worktree) };
}

interface FakeHeadWatch extends HeadWatchService {
    readonly started: string[];
    readonly stopped: string[];
}

function fakeHeadWatch(): FakeHeadWatch {
    const started: string[] = [];
    const stopped: string[] = [];
    const live = new Set<string>();
    return {
        async start(associationID) {
            started.push(associationID);
            live.add(associationID);
        },
        stop(associationID) {
            stopped.push(associationID);
            live.delete(associationID);
        },
        stopAll() {
            for (const id of live) stopped.push(id);
            live.clear();
        },
        watched: () => [...live],
        headPath: () => null,
        started,
        stopped
    };
}

interface Harness {
    readonly store: KelpiStore;
    readonly graft: GraftService;
    readonly watch: RepoAssociationWatchService;
    readonly headWatch: FakeHeadWatch;
    readonly channel: RepoChannel;
    dispose(): void;
}

/** Store + real graft engine + the reconciler + the WS repo channel, over one real repo. */
function harness(f: Fixture): Harness {
    const gitService = createGitService();
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'w1', now: NOW });
    store.dispatch({
        type: 'add-repo',
        repo: {
            id: R1,
            path: f.parent,
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
            worktreePath: f.worktree,
            branchName: 'feature',
            isAutoDetected: false
        }
    });

    const graft = createGraftService({ git: gitService, debounceMs: 1 });
    const headWatch = fakeHeadWatch();
    const watch = createRepoAssociationWatch({
        store,
        git: gitService,
        graft,
        headWatch,
        pollIntervalMs: 0
    });
    watch.start();

    const channel: RepoChannel = {
        store,
        git: gitService,
        worktreeBasePath: '~/nex/worktrees/<repo>',
        uuid: () => 'ffffffff-0000-4000-8000-000000000001',
        now: () => NOW,
        status: { statusFor: (id) => watch.statusFor(id), refresh: (id) => watch.refresh(id) }
    };

    return {
        store,
        graft,
        watch,
        headWatch,
        channel,
        dispose() {
            watch.dispose();
        }
    };
}

function associationIDs(store: KelpiStore): string[] {
    return store
        .getState()
        .workspaces.flatMap((workspace) => workspace.repoAssociations.map((entry) => entry.id));
}

async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    if (!condition()) throw new Error('waitFor: condition not met');
}

/** The parent as the fixture left it: on main, its own edit back, no grafted content. */
function expectParentRestored(f: Fixture): void {
    expect(fs.readFileSync(path.join(f.parent, 'keep.txt'), 'utf8')).toBe('local edit\n');
    expect(fs.existsSync(path.join(f.parent, 'MIRROR.md'))).toBe(false);
    expect(git(f.parent, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(f.parent, 'stash', 'list').trim()).toBe('');
    expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(false);
}

afterAll(() => {
    for (const root of roots) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
});

describe.skipIf(!HAS_GIT)('removing a repository cascades (§GIT-052)', () => {
    it('drops every association, clears its status, stops the watcher and unwinds a LIVE graft', async () => {
        const f = fixture('cascade-repo');
        const h = harness(f);
        await waitFor(() => h.watch.statusFor(A1).kind !== 'unknown');

        const session = await h.graft.start({
            id: A1,
            worktreePath: f.worktree,
            branchName: 'feature'
        });
        expect(session.status).toEqual({ kind: 'watching' });
        // The graft is really running: the parent holds the worktree's file, its own edit is
        // in the stash, and a breadcrumb sits beside it.
        expect(fs.readFileSync(path.join(f.parent, 'MIRROR.md'), 'utf8')).toBe('from the worktree\n');
        expect(git(f.parent, 'stash', 'list').trim()).not.toBe('');
        expect(fs.existsSync(breadcrumbPath(f.parent))).toBe(true);
        expect(h.graft.claimedRoots()).toEqual([f.parent]);

        // The Settings ▸ Repositories "Remove" button, verbatim.
        const reply = await handleRepoCommand(h.channel, 'repo-remove', { repo_id: R1 });
        expect(reply['ok']).toBe(true);
        expect(reply['removed_associations']).toEqual([A1]);

        // The repo and every association referencing it left every workspace…
        expect(h.store.getState().repos).toEqual([]);
        expect(associationIDs(h.store)).toEqual([]);
        // …the HEAD watcher stopped and the remembered dirtiness went with it…
        expect(h.headWatch.stopped).toEqual([A1]);
        expect(h.watch.statusFor(A1)).toEqual({ kind: 'unknown' });
        // …and the force-stop unwound the graft for real.
        await waitFor(() => h.graft.activeSessions().length === 0);
        expect(h.graft.claimedRoots()).toEqual([]);
        expectParentRestored(f);
        h.dispose();
    }, 90_000);
});

describe.skipIf(!HAS_GIT)('removing one association cascades (§GIT-053)', () => {
    it('force-stops its graft so nothing keeps mirroring into the parent', async () => {
        const f = fixture('cascade-assoc');
        const h = harness(f);
        const session = await h.graft.start({
            id: A1,
            worktreePath: f.worktree,
            branchName: 'feature'
        });
        expect(session.status).toEqual({ kind: 'watching' });
        expect(fs.existsSync(path.join(f.parent, 'MIRROR.md'))).toBe(true);

        // The inspector's per-row "Remove" (no worktree deletion).
        const reply = await handleRepoCommand(h.channel, 'remove-repo-association', {
            workspace_id: W1,
            association_id: A1
        });
        expect(reply['ok']).toBe(true);
        expect(reply['worktree_deleted']).toBe(false);

        expect(associationIDs(h.store)).toEqual([]);
        expect(h.headWatch.stopped).toEqual([A1]);
        await waitFor(() => h.graft.activeSessions().length === 0);
        expect(h.graft.claimedRoots()).toEqual([]);
        expectParentRestored(f);
        // The repo itself is untouched — only the association was removed.
        expect(h.store.getState().repos.map((repo) => repo.id)).toEqual([R1]);
        // …and the worktree directory is still there: this variant does not delete it.
        expect(fs.existsSync(f.worktree)).toBe(true);
        h.dispose();
    }, 90_000);

    it('"Remove & Delete Worktree" unwinds the graft and takes the directory with it', async () => {
        const f = fixture('cascade-assoc-delete');
        const h = harness(f);
        const session = await h.graft.start({
            id: A1,
            worktreePath: f.worktree,
            branchName: 'feature'
        });
        expect(session.status).toEqual({ kind: 'watching' });

        const reply = await handleRepoCommand(h.channel, 'remove-repo-association', {
            workspace_id: W1,
            association_id: A1,
            delete_worktree: true
        });
        expect(reply['ok']).toBe(true);
        expect(reply['worktree_deleted']).toBe(true);

        expect(associationIDs(h.store)).toEqual([]);
        expect(fs.existsSync(f.worktree)).toBe(false);
        // The parent is handed back whole even though the mirrored directory is gone.
        await waitFor(() => h.graft.activeSessions().length === 0);
        expect(h.graft.claimedRoots()).toEqual([]);
        expectParentRestored(f);
        h.dispose();
    }, 90_000);

    it('keeps the association when git refuses to delete a dirty worktree', async () => {
        const f = fixture('cascade-assoc-dirty');
        const h = harness(f);
        // Uncommitted work in the worktree: a NON-forcing `git worktree remove` must refuse,
        // and refusing has to leave the row (and its graft) exactly as they were.
        fs.writeFileSync(path.join(f.worktree, 'MIRROR.md'), 'unsaved\n');
        const session = await h.graft.start({
            id: A1,
            worktreePath: f.worktree,
            branchName: 'feature'
        });

        const reply = await handleRepoCommand(h.channel, 'remove-repo-association', {
            workspace_id: W1,
            association_id: A1,
            delete_worktree: true
        });
        expect(reply['ok']).toBe(false);
        expect(String(reply['error'])).not.toBe('');

        // Nothing cascaded: the row, the watcher and the live graft all survive.
        expect(associationIDs(h.store)).toEqual([A1]);
        expect(h.headWatch.stopped).toEqual([]);
        expect(h.graft.session(session.id)).not.toBeNull();
        expect(fs.existsSync(f.worktree)).toBe(true);

        await h.graft.stop(session.id);
        h.dispose();
    }, 90_000);
});
