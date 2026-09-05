/**
 * The two git-backed workspace flows, against the REAL Swift CLI and REAL repos (M7).
 *
 *   - `kelpi workspace create --worktree <name> [--branch] [--repo] [--update-main] [--group]` —
 *     the daemon runs `git worktree add`, registers the repo, mints the repo ASSOCIATION graft
 *     later consumes, and opens the workspace's first pane inside the new worktree.
 *     `--update-main` adds a real remote round trip: resolve `origin`'s default branch, fetch,
 *     branch off `origin/<default>` — pinned with a bare repo the local checkout is behind;
 *   - `kelpi workspace delete --prune-worktree` — best-effort, **CLI-side** cleanup driven by the
 *     `path` the delete reply carries: `git worktree remove` is deliberately non-forcing, so a
 *     dirty worktree degrades to a `Warning:` and never changes the exit code.
 *
 * These were the two flows `../kelpi-docs/compat-status.md` listed as "not exercised (git flows, M7)".
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { currentBranch, git, gitAvailable, initRepo } from './gitfix.js';
import {
    startCompatDaemon,
    swiftCLIAvailable,
    type CompatDaemon,
    type PaneListEntryJSON,
    type WorkspaceListEntryJSON
} from './harness.js';

const RUNNABLE = swiftCLIAvailable() && gitAvailable();

interface CreateReply {
    readonly ok: boolean;
    readonly workspace_id?: string;
    readonly workspace_name?: string;
    readonly worktree_path?: string;
    readonly branch?: string;
    readonly group?: string;
    readonly error?: string;
}

interface DeleteRecord {
    readonly id: string;
    readonly ok: boolean;
    readonly workspace_id?: string;
    readonly workspace_name?: string;
    readonly path?: string;
    readonly worktree_pruned?: boolean;
    readonly worktree_error?: string;
    readonly error?: string;
}

describe.skipIf(!RUNNABLE)('compat: workspace worktrees', () => {
    let kelpi: CompatDaemon;
    /** The main checkout (realpath). */
    let repo: string;

    async function create(args: readonly string[]): Promise<CreateReply> {
        const result = await kelpi.run(['workspace', 'create', ...args, '--json'], {
            timeoutMs: 60_000
        });
        return JSON.parse(result.stdout) as CreateReply;
    }

    /** `<home>/kelpi/worktrees/<repo-dir-name>` — the default `worktreeBasePath` template. */
    function worktreeBase(): string {
        return path.join(kelpi.home, 'kelpi', 'worktrees', path.basename(repo));
    }

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
        repo = initRepo(path.join(kelpi.root, 'src-repo'), { 'keep.txt': 'original\n' });
    }, 60_000);

    afterEach(async () => {
        await kelpi?.stop();
    }, 60_000);

    // ── create --worktree ───────────────────────────────────────────────────

    it('creates a real worktree, opens the workspace in it, and reports both', async () => {
        const reply = await create(['--name', 'Feature', '--worktree', 'feature', '--repo', repo]);
        expect(reply.ok).toBe(true);
        expect(reply.workspace_name).toBe('Feature');
        expect(reply.branch).toBe('feature');
        expect(reply.worktree_path).toBe(path.join(worktreeBase(), 'feature'));

        const worktree = reply.worktree_path as string;
        expect(fs.existsSync(worktree)).toBe(true);
        expect(currentBranch(worktree)).toBe('feature');
        // It is a LINKED worktree of `repo`, not a fresh clone.
        expect(git(worktree, 'rev-parse', '--show-toplevel').trim()).toBe(fs.realpathSync(worktree));
        expect(git(repo, 'worktree', 'list').includes(fs.realpathSync(worktree))).toBe(true);
        // The seeded content came along.
        expect(fs.readFileSync(path.join(worktree, 'keep.txt'), 'utf8')).toBe('original\n');

        // The workspace exists and its first pane lives inside the worktree.
        const workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        const created = workspaces.find((entry) => entry.id === reply.workspace_id);
        expect(created?.name).toBe('Feature');
        expect(created?.pane_count).toBe(1);

        const panes = await kelpi.json<PaneListEntryJSON[]>([
            'pane',
            'list',
            '--workspace',
            'Feature',
            '--json'
        ]);
        expect(panes).toHaveLength(1);
        expect(panes[0]?.working_directory).toBe(worktree);
        expect(panes[0]?.type).toBe('shell');
    }, 120_000);

    it('renders the human create line and honours --branch', async () => {
        const result = await kelpi.run(
            [
                'workspace',
                'create',
                '--name',
                'Fix',
                '--worktree',
                'fix-pane-crash',
                '--branch',
                'bugfix/pane-crash',
                '--repo',
                repo
            ],
            { timeoutMs: 60_000 }
        );
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toContain('created workspace Fix (');
        expect(result.stdout).toContain('with worktree ');
        expect(result.stdout.trim()).toMatch(/on branch bugfix\/pane-crash$/);

        const worktree = path.join(worktreeBase(), 'fix-pane-crash');
        expect(fs.existsSync(worktree)).toBe(true);
        expect(currentBranch(worktree)).toBe('bugfix/pane-crash');
    }, 120_000);

    it('branches off origin/<default> after a fetch with --update-main', async () => {
        // A REAL remote: a bare repo `repo` pushes to, plus a second clone that moves it ahead.
        // `--update-main` must resolve the default branch (`ls-remote --symref origin HEAD`),
        // `git fetch`, then branch off `origin/<default>` — so the new worktree carries a commit
        // the LOCAL checkout has never seen.
        const origin = path.join(kelpi.root, 'origin.git');
        git(kelpi.root, 'init', '--bare', '--initial-branch=main', origin);
        git(repo, 'remote', 'add', 'origin', origin);
        git(repo, 'push', '-u', 'origin', 'main');

        const pusher = path.join(kelpi.root, 'pusher');
        git(kelpi.root, 'clone', origin, pusher);
        git(pusher, 'config', 'user.name', 'kelpi');
        git(pusher, 'config', 'user.email', 'kelpi@example.com');
        git(pusher, 'config', 'commit.gpgsign', 'false');
        fs.writeFileSync(path.join(pusher, 'ahead.txt'), 'landed on main\n');
        git(pusher, 'add', '.');
        git(pusher, 'commit', '-m', 'ahead of the local checkout');
        git(pusher, 'push', 'origin', 'main');
        expect(fs.existsSync(path.join(repo, 'ahead.txt'))).toBe(false);

        const reply = await create([
            '--name',
            'Fresh',
            '--worktree',
            'fresh',
            '--repo',
            repo,
            '--update-main'
        ]);
        expect(reply.ok, JSON.stringify(reply)).toBe(true);
        const worktree = reply.worktree_path as string;
        expect(currentBranch(worktree)).toBe('fresh');
        expect(fs.readFileSync(path.join(worktree, 'ahead.txt'), 'utf8')).toBe('landed on main\n');
        // The local `main` was NOT moved — only the new branch is based on the remote tip.
        expect(fs.existsSync(path.join(repo, 'ahead.txt'))).toBe(false);
    }, 180_000);

    it('fails --update-main when the repo has no origin to fetch', async () => {
        const result = await kelpi.run(
            ['workspace', 'create', '--worktree', 'no-remote', '--repo', repo, '--update-main'],
            { timeoutMs: 60_000 }
        );
        expect(result.code).toBe(1);
        // `worktreeErrorMessage` keeps git's LAST `fatal:` line — for a missing remote that is
        // the summary, not the "'origin' does not appear to be a git repository" line above it.
        expect(result.stderr).toContain('fatal: Could not read from remote repository.');
        expect(fs.existsSync(path.join(worktreeBase(), 'no-remote'))).toBe(false);
    }, 120_000);

    it('sanitizes the worktree name into a path component and a branch', async () => {
        const reply = await create(['--worktree', 'my feature!!', '--repo', repo]);
        expect(reply.ok).toBe(true);
        expect(reply.branch).toBe('my-feature');
        expect(reply.worktree_path).toBe(path.join(worktreeBase(), 'my-feature'));
        expect(currentBranch(reply.worktree_path as string)).toBe('my-feature');
    }, 120_000);

    it('requires an EXISTING group and never creates one on the worktree path', async () => {
        const unknown = await kelpi.run(
            ['workspace', 'create', '--worktree', 'grouped', '--repo', repo, '--group', 'ghost'],
            { timeoutMs: 60_000 }
        );
        expect(unknown.code).toBe(1);
        expect(unknown.stderr).toContain('--worktree only supports existing groups');
        // Neither the group nor the worktree exists after the refusal.
        const groups = await kelpi.json<{ name: string }[]>(['group', 'list', '--json']);
        expect(groups.map((group) => group.name)).not.toContain('ghost');
        expect(fs.existsSync(path.join(worktreeBase(), 'grouped'))).toBe(false);

        const madeGroup = await kelpi.run(['group', 'create', 'work']);
        expect(madeGroup.code).toBe(0);
        const reply = await create([
            '--name',
            'Grouped',
            '--worktree',
            'grouped',
            '--repo',
            repo,
            '--group',
            'work'
        ]);
        expect(reply.ok).toBe(true);
        expect(reply.group).toBe('work');
        expect(fs.existsSync(reply.worktree_path as string)).toBe(true);
    }, 120_000);

    it('surfaces git\'s own failure when the worktree already exists', async () => {
        const first = await create(['--worktree', 'dupe', '--repo', repo]);
        expect(first.ok).toBe(true);

        const second = await kelpi.run(
            ['workspace', 'create', '--worktree', 'dupe', '--repo', repo],
            { timeoutMs: 60_000 }
        );
        expect(second.code).toBe(1);
        // `worktreeErrorMessage` keeps git's LAST fatal: line, not the "Preparing worktree" chat.
        expect(second.stderr.toLowerCase()).toContain('fatal:');
        expect(second.stderr).toContain('dupe');

        // The failed create left no workspace behind.
        const workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(workspaces.filter((entry) => entry.name === 'Workspace')).toHaveLength(1);
    }, 120_000);

    it('fails when --repo is not a git repository', async () => {
        const plain = path.join(kelpi.root, 'not-a-repo');
        fs.mkdirSync(plain, { recursive: true });
        const result = await kelpi.run(
            ['workspace', 'create', '--worktree', 'nope', '--repo', plain],
            { timeoutMs: 60_000 }
        );
        expect(result.code).toBe(1);
        expect(result.stderr.toLowerCase()).toMatch(/not a git repository|fatal/);
        expect(fs.existsSync(path.join(worktreeBase(), 'nope'))).toBe(false);
    }, 120_000);

    // ── delete --prune-worktree ─────────────────────────────────────────────

    it('prunes a clean worktree on delete and reports it', async () => {
        const reply = await create(['--name', 'Prunable', '--worktree', 'prunable', '--repo', repo]);
        expect(reply.ok).toBe(true);
        const worktree = reply.worktree_path as string;
        expect(fs.existsSync(worktree)).toBe(true);

        const deleted = await kelpi.run(
            ['workspace', 'delete', 'Prunable', '--prune-worktree', '--json'],
            { timeoutMs: 60_000 }
        );
        expect(deleted.code, deleted.stderr).toBe(0);
        const records = JSON.parse(deleted.stdout) as DeleteRecord[];
        expect(records).toHaveLength(1);
        const record = records[0] as DeleteRecord;
        expect(record.ok).toBe(true);
        expect(record.workspace_name).toBe('Prunable');
        // The `path` the prune keys off is the workspace's shell pane cwd.
        expect(record.path).toBe(worktree);
        expect(record.worktree_pruned).toBe(true);
        expect(record.worktree_error).toBeUndefined();

        expect(fs.existsSync(worktree)).toBe(false);
        expect(git(repo, 'worktree', 'list').includes(worktree)).toBe(false);
        const workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(workspaces.map((entry) => entry.name)).not.toContain('Prunable');
    }, 120_000);

    it('prints the prune line in human output', async () => {
        const reply = await create(['--name', 'Human', '--worktree', 'human', '--repo', repo]);
        expect(reply.ok).toBe(true);

        const deleted = await kelpi.run(['workspace', 'delete', 'Human', '--prune-worktree'], {
            timeoutMs: 60_000
        });
        expect(deleted.code, deleted.stderr).toBe(0);
        expect(deleted.stdout).toContain('deleted workspace Human');
        expect(deleted.stdout).toContain('removed worktree:');
    }, 120_000);

    it('degrades to a Warning (exit 0) when the worktree is dirty', async () => {
        const reply = await create(['--name', 'Dirty', '--worktree', 'dirty', '--repo', repo]);
        expect(reply.ok).toBe(true);
        const worktree = reply.worktree_path as string;
        // Untracked work is exactly what non-forcing `git worktree remove` refuses to discard.
        fs.writeFileSync(path.join(worktree, 'unsaved.txt'), 'work in progress\n');

        const deleted = await kelpi.run(
            ['workspace', 'delete', 'Dirty', '--prune-worktree', '--json'],
            { timeoutMs: 60_000 }
        );
        // The DELETE succeeded; only the prune failed, and a prune failure is not an error.
        expect(deleted.code).toBe(0);
        const record = (JSON.parse(deleted.stdout) as DeleteRecord[])[0] as DeleteRecord;
        expect(record.ok).toBe(true);
        expect(record.worktree_pruned).toBe(false);
        expect(record.worktree_error).toContain('git worktree remove failed');

        // The workspace is gone; the user's uncommitted work is not.
        expect(fs.existsSync(path.join(worktree, 'unsaved.txt'))).toBe(true);
        const workspaces = await kelpi.json<WorkspaceListEntryJSON[]>(['workspace', 'list', '--json']);
        expect(workspaces.map((entry) => entry.name)).not.toContain('Dirty');
    }, 120_000);

    it('leaves the worktree alone without --prune-worktree', async () => {
        const reply = await create(['--name', 'Kept', '--worktree', 'kept', '--repo', repo]);
        expect(reply.ok).toBe(true);
        const worktree = reply.worktree_path as string;

        const deleted = await kelpi.run(['workspace', 'delete', 'Kept', '--json'], {
            timeoutMs: 60_000
        });
        expect(deleted.code, deleted.stderr).toBe(0);
        const record = (JSON.parse(deleted.stdout) as DeleteRecord[])[0] as DeleteRecord;
        expect(record.ok).toBe(true);
        expect(record.worktree_pruned).toBeUndefined();
        expect(fs.existsSync(worktree)).toBe(true);
    }, 120_000);

    it('cannot prune a workspace whose panes were closed first', async () => {
        // The documented Swift limitation: the prune keys off the `path` in the delete reply,
        // which is a shell pane's CURRENT cwd. Close the panes and the path is gone with them,
        // so the worktree survives its workspace (and `git worktree remove` is left to the user).
        const reply = await create(['--name', 'Emptied', '--worktree', 'emptied', '--repo', repo]);
        expect(reply.ok).toBe(true);
        const worktree = reply.worktree_path as string;

        const panes = await kelpi.json<PaneListEntryJSON[]>([
            'pane',
            'list',
            '--workspace',
            'Emptied',
            '--json'
        ]);
        const closed = await kelpi.run(['pane', 'close', '--target', panes[0]?.id as string], {
            timeoutMs: 30_000
        });
        expect(closed.code, closed.stderr).toBe(0);

        const deleted = await kelpi.run(
            ['workspace', 'delete', 'Emptied', '--prune-worktree', '--json'],
            { timeoutMs: 60_000 }
        );
        expect(deleted.code).toBe(0);
        const record = (JSON.parse(deleted.stdout) as DeleteRecord[])[0] as DeleteRecord;
        expect(record.ok).toBe(true);
        expect(record.path).toBeUndefined();
        expect(record.worktree_pruned).toBe(false);
        expect(record.worktree_error).toBe('workspace Emptied had no panes; no directory to prune');
        expect(fs.existsSync(worktree)).toBe(true);
    }, 120_000);

    it('warns instead of pruning when the deleted workspace is not in a worktree', async () => {
        const plain = path.join(kelpi.root, 'plain-dir');
        fs.mkdirSync(plain, { recursive: true });
        const created = await create(['--name', 'Plain', '--path', plain]);
        expect(created.ok).toBe(true);

        const deleted = await kelpi.run(
            ['workspace', 'delete', 'Plain', '--prune-worktree', '--json'],
            { timeoutMs: 60_000 }
        );
        expect(deleted.code).toBe(0);
        const record = (JSON.parse(deleted.stdout) as DeleteRecord[])[0] as DeleteRecord;
        expect(record.ok).toBe(true);
        expect(record.worktree_pruned).toBe(false);
        expect(record.worktree_error).toContain('not a git worktree');
        expect(fs.existsSync(plain)).toBe(true);
    }, 120_000);
});
