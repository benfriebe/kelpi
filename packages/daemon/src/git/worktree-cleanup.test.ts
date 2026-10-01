/**
 * Worktree cleanup against real throwaway repos (graft-git.md §8.7): what may be removed with a
 * workspace, and what removal and branch deletion actually do. Skips when git is absent.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, type KelpiStore } from '../store/index.js';
import type { RepoAssociation } from '../store/types.js';
import { createGitRunner, resolveGitExecutable } from './exec.js';
import { createGitService } from './service.js';
import { worktreeGitOps } from './worktree-add.js';
import {
    describeWorktreeBlock,
    planWorktreeCleanup,
    removeWorktrees,
    bundledWorktreeOps,
    type WorktreeCleanupDeps
} from './worktree-cleanup.js';

const GIT = resolveGitExecutable();
const HAS_GIT = (() => {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-cleanup-${prefix}-`));
    roots.push(dir);
    return fs.realpathSync(dir);
}

function git(cwd: string, ...args: string[]): string {
    return execFileSync(GIT, args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'kelpi',
            GIT_AUTHOR_EMAIL: 'kelpi@example.com',
            GIT_COMMITTER_NAME: 'kelpi',
            GIT_COMMITTER_EMAIL: 'kelpi@example.com'
        }
    });
}

function commit(cwd: string, file: string, message: string): void {
    fs.writeFileSync(path.join(cwd, file), `${message}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', message);
}

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const P1 = 'DDDDDDDD-0000-4000-8000-000000000001';
const P2 = 'DDDDDDDD-0000-4000-8000-000000000002';

interface Fixture {
    readonly repo: string;
    readonly base: string;
    readonly store: KelpiStore;
    readonly deps: WorktreeCleanupDeps;
    /** `git worktree add` under the managed base (or `where`), plus a row on W1. */
    worktree(name: string, options?: { where?: string; detach?: boolean; branch?: string }): { path: string; association: RepoAssociation };
}

function fixture(options: { branches?: boolean } = {}): Fixture {
    const root = tmpDir('root');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=main');
    commit(repo, 'README.md', 'initial');
    const base = path.join(root, 'worktrees');
    const store = createStore(emptyDaemonState(root));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: P1, name: 'one', now: 0, workingDirectory: root });
    let n = 0;
    return {
        repo,
        base,
        store,
        deps: {
            git: createGitService(),
            bundled: options.branches === false ? null : bundledWorktreeOps(worktreeGitOps(createGitRunner())),
            worktreeBasePath: `${base}/<repo>`
        },
        worktree(name, worktreeOptions = {}) {
            const where = worktreeOptions.where ?? path.join(base, 'repo', name);
            if (worktreeOptions.detach === true) git(repo, 'worktree', 'add', '-q', '--detach', where);
            else if (worktreeOptions.branch !== undefined) git(repo, 'worktree', 'add', '-q', where, worktreeOptions.branch);
            else git(repo, 'worktree', 'add', '-q', '-b', name, where);
            n += 1;
            const association: RepoAssociation = {
                id: `CCCCCCCC-0000-4000-8000-${String(n).padStart(12, '0')}`,
                repoID: 'BBBBBBBB-0000-4000-8000-000000000001',
                worktreePath: where,
                branchName: worktreeOptions.detach === true ? null : (worktreeOptions.branch ?? name),
                isAutoDetected: false
            };
            store.dispatch({ type: 'add-repo-association', workspaceID: W1, association });
            return { path: where, association };
        }
    };
}

function planAll(f: Fixture, rows: readonly RepoAssociation[], excluding: readonly string[] = [W1]) {
    return planWorktreeCleanup(
        {
            state: f.store.getState(),
            rows: rows.map((association) => ({ workspaceID: W1, association })),
            excluding: new Set(excluding)
        },
        f.deps
    );
}

async function plan(f: Fixture, rows: readonly RepoAssociation[], excluding: readonly string[] = [W1]) {
    return [...(await planAll(f, rows, excluding)).candidates];
}

describe.skipIf(!HAS_GIT)('planWorktreeCleanup', () => {
    it('offers a clean Kelpi worktree, recommended, with its branch safe to delete', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('feature');
        const [candidate, ...rest] = await plan(f, [association]);

        expect(rest).toEqual([]);
        expect(candidate).toMatchObject({
            worktreePath: wt,
            repoPath: f.repo,
            branch: 'feature',
            managed: true,
            changedFiles: 0,
            commitsOnlyHere: 0,
            blocked: null,
            recommended: true,
            branchDeletable: true,
            associations: [{ workspaceID: W1, associationID: association.id }]
        });
    });

    it('never offers the main checkout, a folder inside one, or a path that is gone', async () => {
        const f = fixture();
        fs.mkdirSync(path.join(f.repo, 'sub'));
        const row = (id: number, worktreePath: string): RepoAssociation => ({
            id: `CCCCCCCC-0000-4000-8000-00000000009${id}`,
            // Registered against an ANCESTOR, as rows linked by the old relative-path bug are:
            // git's answer, not the registry's, is what makes a row a worktree.
            repoID: 'BBBBBBBB-0000-4000-8000-000000000009',
            worktreePath,
            branchName: 'main',
            isAutoDetected: true
        });
        const planned = await planAll(f, [row(1, f.repo), row(2, path.join(f.repo, 'sub')), row(3, path.join(f.base, 'gone'))]);
        expect(planned.candidates).toEqual([]);
        // …and says why, so a caller never has to ask git again.
        expect(planned.skipped.map((entry) => [entry.worktreePath, entry.reason])).toEqual([
            [f.repo, 'main-checkout'],
            [path.join(f.repo, 'sub'), 'not-a-worktree'],
            [path.join(f.base, 'gone'), 'not-a-worktree']
        ]);
    });

    it("trusts git's worktree list over a parent that is not a checkout (a submodule's git dir)", async () => {
        const f = fixture();
        const sub = path.join(f.base, 'sub');
        const association: RepoAssociation = { id: 'CCCCCCCC-0000-4000-8000-000000000099', repoID: 'r', worktreePath: sub, branchName: 'main', isAutoDetected: true };
        const deps = {
            ...f.deps,
            git: {
                ...f.deps.git,
                // What rev-parse answers for a submodule checkout: the common dir is not `.git`.
                resolveRepoRoot: async () => ({ worktreeRoot: sub, parentRepoRoot: path.join(f.repo, '.git', 'modules', 'sub') }),
                listWorktrees: async () => [{ path: sub, branch: 'main', isMain: true }]
            }
        };
        const planned = await planWorktreeCleanup(
            { state: f.store.getState(), rows: [{ workspaceID: W1, association }], excluding: new Set([W1]) },
            deps
        );
        expect(planned.candidates).toEqual([]);
        expect(planned.skipped.map((entry) => entry.reason)).toEqual(['main-checkout']);
    });

    it('lists the worktrees of a repo once however many of its candidates there are', async () => {
        const f = fixture();
        const rows = [f.worktree('one').association, f.worktree('two').association, f.worktree('three').association];
        let lists = 0;
        const listWorktrees = f.deps.git.listWorktrees.bind(f.deps.git);
        const deps = { ...f.deps, git: { ...f.deps.git, listWorktrees: (repoPath: string) => { lists += 1; return listWorktrees(repoPath); } } };
        const planned = await planWorktreeCleanup(
            { state: f.store.getState(), rows: rows.map((association) => ({ workspaceID: W1, association })), excluding: new Set([W1]) },
            deps
        );
        expect(planned.candidates).toHaveLength(3);
        expect(lists).toBe(1);
    });

    it('offers a worktree outside the base path, but does not recommend it', async () => {
        const f = fixture();
        const { association } = f.worktree('agent', { where: path.join(f.repo, '.claude', 'worktrees', 'agent') });
        const [candidate] = await plan(f, [association]);
        expect(candidate).toMatchObject({ managed: false, blocked: null, recommended: false });
    });

    it('blocks a worktree with uncommitted changes, untracked files included', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('dirty');
        fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');
        const [candidate] = await plan(f, [association]);
        expect(candidate?.blocked).toEqual({ kind: 'dirty', changedFiles: 1 });
        expect(candidate?.recommended).toBe(false);
        // Uncommitted changes are its only problem, so the user may opt in to discarding them.
        expect(candidate?.forceable).toBe(true);
        expect(describeWorktreeBlock({ kind: 'dirty', changedFiles: 1 })).toBe('has 1 uncommitted change');
    });

    it('blocks a worktree another workspace has a pane inside or a row for', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('shared');
        f.store.dispatch({ type: 'create-workspace', id: W2, paneID: P2, name: 'two', now: 0, workingDirectory: path.join(wt) });
        fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');
        const [byPane] = await plan(f, [association]);
        expect(byPane?.blocked).toEqual({ kind: 'shared', workspaces: ['two'] });
        // Dirty AND shared: forcing would pull it out from under the other workspace.
        expect(byPane?.forceable).toBe(false);
        fs.rmSync(path.join(wt, 'scratch.txt'));

        // Deleting both in one go: neither counts as the other's sharer.
        const [together] = await plan(f, [association], [W1, W2]);
        expect(together?.blocked).toBeNull();
    });

    it('blocks a worktree with another worktree inside it, which git would delete as ignored files', async () => {
        const f = fixture();
        const { path: outer, association } = f.worktree('outer');
        fs.writeFileSync(path.join(outer, '.gitignore'), '.claude/\n');
        git(outer, 'add', '.gitignore');
        git(outer, 'commit', '-q', '-m', 'ignore');
        const inner = path.join(outer, '.claude', 'worktrees', 'inner');
        git(f.repo, 'worktree', 'add', '-q', '-b', 'inner', inner);

        const [candidate] = await plan(f, [association]);
        expect(candidate?.blocked).toEqual({ kind: 'nested', worktrees: [inner] });
    });

    it('keeps a branch with commits no other ref has, and a detached HEAD holding such commits', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('ahead');
        commit(wt, 'work.txt', 'work');
        const [ahead] = await plan(f, [association]);
        expect(ahead).toMatchObject({ blocked: null, commitsOnlyHere: 1, branchDeletable: false });

        const detached = f.worktree('loose', { detach: true });
        commit(detached.path, 'loose.txt', 'loose');
        fs.writeFileSync(path.join(detached.path, 'wip.txt'), 'wip\n');
        const [loose] = await plan(f, [detached.association]);
        // Dirty comes first, but the commits on no branch mean it can never be forced.
        expect(loose?.blocked).toEqual({ kind: 'dirty', changedFiles: 1 });
        expect(loose?.forceable).toBe(false);
        fs.rmSync(path.join(detached.path, 'wip.txt'));
        const [committedOnly] = await plan(f, [detached.association]);
        expect(committedOnly?.blocked).toEqual({ kind: 'detached-commits', commits: 1 });

        const clean = f.worktree('clean-detached', { detach: true });
        const [detachedClean] = await plan(f, [clean.association]);
        expect(detachedClean).toMatchObject({ branch: null, blocked: null, branchDeletable: false });
    });

    it('treats a branch whose commits are on a remote-tracking ref as safe (a pushed branch)', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('pushed');
        commit(wt, 'work.txt', 'work');
        git(f.repo, 'update-ref', 'refs/remotes/origin/pushed', 'refs/heads/pushed');
        const [candidate] = await plan(f, [association]);
        expect(candidate).toMatchObject({ commitsOnlyHere: 0, branchDeletable: true });
    });

    it('never offers to delete the branch origin/HEAD names', async () => {
        const f = fixture();
        git(f.repo, 'update-ref', 'refs/remotes/origin/main', 'refs/heads/main');
        git(f.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
        git(f.repo, 'checkout', '-q', '--detach');
        const { association } = f.worktree('main-wt', { branch: 'main' });
        const [candidate] = await plan(f, [association]);
        expect(candidate).toMatchObject({ branch: 'main', commitsOnlyHere: 0, blocked: null, branchDeletable: false });
    });

    it('without bundled branch reads (a plugin provider), offers no branch and blocks a detached HEAD', async () => {
        const f = fixture({ branches: false });
        const { association } = f.worktree('provider');
        const detached = f.worktree('provider-detached', { detach: true });
        const [onBranch, onDetached] = await plan(f, [association, detached.association]);
        expect(onBranch).toMatchObject({ blocked: null, commitsOnlyHere: null, branchDeletable: false });
        expect(onDetached?.blocked).toEqual({ kind: 'detached-commits', commits: null });
        // Forcing needs bundled git too.
        fs.writeFileSync(path.join(f.worktree('provider-dirty').path, 'wip.txt'), 'wip\n');
        const [dirty] = await plan(f, [f.store.getState().workspaces[0]!.repoAssociations.at(-1)!]);
        expect(dirty).toMatchObject({ blocked: { kind: 'dirty', changedFiles: 1 }, forceable: false });
    });

    it('merges two rows for one worktree into one candidate', async () => {
        const f = fixture();
        const { association } = f.worktree('twice');
        const again = { ...association, id: 'CCCCCCCC-0000-4000-8000-000000000077' };
        const planned = await plan(f, [association, again]);
        expect(planned).toHaveLength(1);
        expect(planned[0]?.associations.map((entry) => entry.associationID)).toEqual([association.id, again.id]);
    });
});

describe.skipIf(!HAS_GIT)('removeWorktrees', () => {
    it('removes the worktree and deletes its branch when asked and safe', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('gone');
        const results = await removeWorktrees(await plan(f, [association]), { deleteBranches: true }, f.deps);

        expect(results).toEqual([
            { associationID: association.id, worktreePath: wt, branch: 'gone', removed: true, branchDeleted: true }
        ]);
        expect(fs.existsSync(wt)).toBe(false);
        expect(git(f.repo, 'branch', '--list', 'gone').trim()).toBe('');
    });

    it('keeps the branch unless asked, and keeps one with commits only it has', async () => {
        const f = fixture();
        const kept = f.worktree('kept');
        const ahead = f.worktree('ahead');
        commit(ahead.path, 'work.txt', 'work');
        const candidates = await plan(f, [kept.association]);
        expect(await removeWorktrees(candidates, { deleteBranches: false }, f.deps)).toEqual([
            { associationID: kept.association.id, worktreePath: kept.path, branch: 'kept', removed: true }
        ]);
        expect(git(f.repo, 'branch', '--list', 'kept')).toContain('kept');

        const results = await removeWorktrees(await plan(f, [ahead.association]), { deleteBranches: true }, f.deps);
        expect(results[0]).toMatchObject({ removed: true, branchDeleted: false, branchError: '1 commit no other branch or remote has' });
        expect(git(f.repo, 'branch', '--list', 'ahead')).toContain('ahead');
    });

    it('reports a blocked candidate with its reason and leaves it on disk', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('busy');
        fs.writeFileSync(path.join(wt, 'scratch.txt'), 'wip\n');
        const results = await removeWorktrees(await plan(f, [association]), { deleteBranches: true }, f.deps);
        expect(results).toEqual([
            { associationID: association.id, worktreePath: wt, branch: 'busy', removed: false, blocked: 'dirty', error: 'has 1 uncommitted change' }
        ]);
        expect(fs.existsSync(path.join(wt, 'scratch.txt'))).toBe(true);
    });

    it('forces a dirty worktree only when its key is named, discarding its changes', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('dirty');
        fs.writeFileSync(path.join(wt, 'one.txt'), 'wip\n');
        fs.writeFileSync(path.join(wt, 'README.md'), 'edited\n');
        const candidates = await plan(f, [association]);

        const unnamed = await removeWorktrees(candidates, { deleteBranches: true, force: new Set() }, f.deps);
        expect(unnamed[0]).toMatchObject({ removed: false, blocked: 'dirty' });
        expect(fs.existsSync(wt)).toBe(true);

        const forced = await removeWorktrees(candidates, { deleteBranches: true, force: new Set([candidates[0]!.key]) }, f.deps);
        expect(forced).toEqual([
            { associationID: association.id, worktreePath: wt, branch: 'dirty', removed: true, discardedChanges: 2, branchDeleted: true }
        ]);
        expect(fs.existsSync(wt)).toBe(false);
    });

    it("reports git's own refusal (a locked worktree) without throwing", async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('locked');
        git(f.repo, 'worktree', 'lock', wt);
        const [result] = await removeWorktrees(await plan(f, [association]), { deleteBranches: true }, f.deps);
        expect(result?.removed).toBe(false);
        expect(result?.blocked).toBeUndefined();
        expect(result?.error).toMatch(/locked/);
        expect(fs.existsSync(wt)).toBe(true);
    });
});
