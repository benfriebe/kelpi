/**
 * `workspace-delete` with worktree cleanup (graft-git.md §8.7, wire-protocol.md §6.3), against
 * real throwaway repos: the delete stands whatever git does, the reply comes after the git work
 * and says what happened to each worktree, and nothing is removed that the plan blocks.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createGitRunner, resolveGitExecutable, bundledWorktreeOps, worktreeGitOps } from '../../git/index.js';
import type { RepoAssociation } from '../../store/index.js';
import { harness, id, seeded, type Harness } from './testing.js';

const GIT = resolveGitExecutable();
const HAS_GIT = (() => {
    try {
        execFileSync(GIT, ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
})();

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const REPO_ID = id('bbbbbbbb', 1);

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

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

interface Fixture {
    readonly h: Harness;
    readonly repo: string;
    /** A new worktree on its own branch under the managed base, with a row on `workspaceID`. */
    worktree(name: string, workspaceID?: string): { path: string; association: RepoAssociation };
    associate(workspaceID: string, association: RepoAssociation): void;
}

function fixture(): Fixture {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-delete-wt-')));
    roots.push(root);
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '--initial-branch=main');
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    const h = harness({
        initial: seeded(2),
        worktreeBasePath: `${root}/worktrees/<repo>`,
        bundledWorktrees: () => bundledWorktreeOps(worktreeGitOps(createGitRunner()))
    });
    let n = 0;
    const associate = (workspaceID: string, association: RepoAssociation): void => {
        h.dispatch({ type: 'add-repo-association', workspaceID, association });
    };
    return {
        h,
        repo,
        associate,
        worktree(name, workspaceID = W1) {
            const where = path.join(root, 'worktrees', 'repo', name);
            git(repo, 'worktree', 'add', '-q', '-b', name, where);
            n += 1;
            const association: RepoAssociation = {
                id: id('cccccccc', n),
                repoID: REPO_ID,
                worktreePath: where,
                branchName: name,
                isAutoDetected: false
            };
            associate(workspaceID, association);
            return { path: where, association };
        }
    };
}

/** Send, then wait for the one reply a cleanup delete sends after its git work. */
async function reply(h: Harness, object: Record<string, unknown>): Promise<Record<string, unknown>> {
    const payloads = h.send(object);
    await vi.waitFor(() => expect(payloads).toHaveLength(1), { timeout: 10_000 });
    return payloads[0] ?? {};
}

/** Point a workspace's first pane at `directory` (its shell `cd`'d there). */
function cd(h: Harness, workspaceID: string, directory: string): void {
    const pane = h.state().workspaces.find((workspace) => workspace.id === workspaceID)?.panes[0];
    if (pane === undefined) throw new Error('no pane');
    h.dispatch({ type: 'pane-directory-changed', paneID: pane.id, directory, now: 0 });
}

describe.skipIf(!HAS_GIT)('workspace-delete worktree cleanup (graft-git §8.7)', () => {
    it('removes the named worktree and its branch, replying after the git work', async () => {
        const f = fixture();
        const { path: wt, association } = f.worktree('feature');

        const answer = await reply(f.h, {
            command: 'workspace-delete',
            name: 'w1',
            force: true,
            worktree_paths: [wt],
            delete_branches: true
        });

        expect(answer).toEqual({
            ok: true,
            workspace_id: W1,
            workspace_name: 'w1',
            path: expect.any(String),
            worktrees: [
                { association_id: association.id, worktree_path: wt, branch: 'feature', removed: true, branch_deleted: true }
            ]
        });
        // The delete itself happened first, exactly as without cleanup.
        expect(f.h.replies[0]?.states[0]?.workspaces.map((workspace) => workspace.id)).toEqual([W2]);
        expect(fs.existsSync(wt)).toBe(false);
        expect(git(f.repo, 'branch', '--list', 'feature').trim()).toBe('');
    });

    it('prune_worktrees removes the Kelpi worktrees that are safe, reports the kept ones, and leaves the rest alone', async () => {
        const f = fixture();
        const clean = f.worktree('clean');
        const busy = f.worktree('busy');
        fs.writeFileSync(path.join(busy.path, 'wip.txt'), 'wip\n');
        // A worktree a pane merely visited (outside the base path) is not prune's to remove.
        const visited = path.join(f.repo, '..', 'elsewhere');
        git(f.repo, 'worktree', 'add', '-q', '-b', 'visited', visited);
        f.associate(W1, { id: id('cccccccc', 80), repoID: REPO_ID, worktreePath: visited, branchName: 'visited', isAutoDetected: true });
        // The main checkout is never a candidate, so prune does not list it at all.
        f.associate(W1, { id: id('cccccccc', 90), repoID: REPO_ID, worktreePath: f.repo, branchName: 'main', isAutoDetected: false });

        const answer = await reply(f.h, { command: 'workspace-delete', name: 'w1', force: true, prune_worktrees: true });

        expect(answer['worktrees']).toEqual([
            { association_id: clean.association.id, worktree_path: clean.path, branch: 'clean', removed: true },
            {
                association_id: busy.association.id,
                worktree_path: busy.path,
                branch: 'busy',
                removed: false,
                blocked: 'dirty',
                error: 'has 1 uncommitted change'
            }
        ]);
        expect(fs.existsSync(clean.path)).toBe(false);
        expect(fs.existsSync(path.join(busy.path, 'wip.txt'))).toBe(true);
        expect(fs.existsSync(visited)).toBe(true);
        // No `delete_branches`: the branch stays.
        expect(git(f.repo, 'branch', '--list', 'clean')).toContain('clean');
    });

    it("prune_worktrees also takes the Kelpi worktree the workspace's shell was in when it has no row for it", async () => {
        const f = fixture();
        const where = path.join(path.dirname(f.repo), 'worktrees', 'repo', 'unlinked');
        git(f.repo, 'worktree', 'add', '-q', '-b', 'unlinked', where);
        cd(f.h, W1, path.join(where));

        const answer = await reply(f.h, { command: 'workspace-delete', name: 'w1', force: true, prune_worktrees: true });

        expect(answer['worktrees']).toEqual([{ worktree_path: where, branch: 'unlinked', removed: true }]);
        expect(fs.existsSync(where)).toBe(false);
    });

    it('forces a named dirty worktree only when it is also in force_worktree_paths; prune never forces', async () => {
        const f = fixture();
        const dirty = f.worktree('dirty');
        fs.writeFileSync(path.join(dirty.path, 'wip.txt'), 'wip\n');
        const answer = await reply(f.h, {
            command: 'workspace-delete',
            name: 'w1',
            force: true,
            worktree_paths: [dirty.path],
            force_worktree_paths: [dirty.path]
        });
        expect(answer['worktrees']).toEqual([
            { association_id: dirty.association.id, worktree_path: dirty.path, branch: 'dirty', removed: true, discarded_changes: 1 }
        ]);
        expect(fs.existsSync(dirty.path)).toBe(false);

        const g = fixture();
        const kept = g.worktree('kept');
        fs.writeFileSync(path.join(kept.path, 'wip.txt'), 'wip\n');
        const pruned = await reply(g.h, {
            command: 'workspace-delete',
            name: 'w1',
            force: true,
            prune_worktrees: true,
            force_worktree_paths: [kept.path]
        });
        expect(pruned['worktrees']).toEqual([
            { association_id: kept.association.id, worktree_path: kept.path, branch: 'kept', removed: false, blocked: 'dirty', error: 'has 1 uncommitted change' }
        ]);
        expect(fs.existsSync(path.join(kept.path, 'wip.txt'))).toBe(true);
    });

    it('names an unknown path and a row that is not a linked worktree without failing the delete', async () => {
        const f = fixture();
        const main = { id: id('cccccccc', 91), repoID: REPO_ID, worktreePath: f.repo, branchName: 'main', isAutoDetected: false };
        f.associate(W1, main);

        const answer = await reply(f.h, {
            command: 'workspace-delete',
            name: 'w1',
            force: true,
            worktree_paths: ['/nowhere/at/all', f.repo]
        });

        expect(answer['ok']).toBe(true);
        expect(answer['worktrees']).toEqual([
            { association_id: main.id, worktree_path: f.repo, removed: false, error: 'the main checkout, not a worktree' },
            { worktree_path: '/nowhere/at/all', removed: false, error: 'not a worktree of the deleted workspaces' }
        ]);
        expect(f.h.state().workspaces.map((workspace) => workspace.id)).toEqual([W2]);
    });

    it("a batch's last delete takes the earlier members' worktrees, shared by rows or only by panes", async () => {
        const f = fixture();
        const W3 = id('aaaaaaaa', 3);
        f.h.dispatch({ type: 'create-workspace', id: W3, paneID: id('dddddddd', 3), name: 'w3', now: 0 });
        const { path: wt } = f.worktree('shared');
        // W2 only has a shell inside it: no row of its own.
        cd(f.h, W2, wt);

        // Alone, W1's delete would keep it: W2 is still using it.
        f.h.reply({ command: 'workspace-delete', name: 'w1', force: true });
        const last = await reply(f.h, { command: 'workspace-delete', name: 'w2', force: true, worktree_paths: [wt], batch_ids: [W1] });

        expect(last['worktrees']).toEqual([
            { association_id: id('cccccccc', 1), worktree_path: wt, branch: 'shared', removed: true }
        ]);
        expect(fs.existsSync(wt)).toBe(false);
    });

    it('a batch member that was never deleted is still a sharer, and its worktree stays', async () => {
        const f = fixture();
        const W3 = id('aaaaaaaa', 3);
        f.h.dispatch({ type: 'create-workspace', id: W3, paneID: id('dddddddd', 3), name: 'w3', now: 0 });
        const { path: wt } = f.worktree('kept', W2);
        f.associate(W1, { id: id('cccccccc', 60), repoID: REPO_ID, worktreePath: wt, branchName: 'kept', isAutoDetected: false });

        // W2's delete never happened (a plugin hook vetoed it, say), yet the last delete names it.
        const last = await reply(f.h, { command: 'workspace-delete', name: 'w1', force: true, worktree_paths: [wt], batch_ids: [W2] });

        expect(last['worktrees']).toEqual([
            {
                association_id: id('cccccccc', 60),
                worktree_path: wt,
                branch: 'kept',
                removed: false,
                blocked: 'shared',
                error: 'also used by workspace "w2"'
            }
        ]);
        expect(fs.existsSync(wt)).toBe(true);
    });

    it('leaves the guards and the reply-before-effect path untouched when no cleanup is asked', () => {
        const f = fixture();
        const { path: wt } = f.worktree('untouched');
        const answer = f.h.reply({ command: 'workspace-delete', name: 'w1', force: true });
        expect(answer).not.toHaveProperty('worktrees');
        // Reply-before-effect: the state the reply was written against still had W1.
        expect(f.h.replies[0]?.states[0]?.workspaces.map((workspace) => workspace.id)).toEqual([W1, W2]);
        expect(fs.existsSync(wt)).toBe(true);
    });

    it('refuses exactly as before when a guard fails, touching no worktree', () => {
        const f = fixture();
        const { path: wt } = f.worktree('guarded');
        f.h.dispatch({ type: 'delete-workspace', id: W2 });
        const answer = f.h.reply({ command: 'workspace-delete', name: 'w1', force: true, worktree_paths: [wt] });
        expect(answer).toEqual({ ok: false, error: 'refusing to delete the last workspace' });
        expect(fs.existsSync(wt)).toBe(true);
    });
});
