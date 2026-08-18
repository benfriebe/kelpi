/**
 * `nex graft start|stop|status` against the REAL Swift CLI and REAL git repos (M7).
 *
 * The graft engine's contract is entirely about what lands on disk, so nothing here is faked:
 * a real `git init` parent, a real `git worktree add` (performed by the daemon, through
 * `nex workspace create --worktree`, because that is the only CLI-reachable way to get a repo
 * ASSOCIATION — associations are otherwise created from the GUI inspector), a real recursive
 * `fs.watch`, and the shipped `nex` binary driving all three verbs.
 *
 * What this pins that unit tests cannot:
 *   - the CLI's `graft-start` / `graft-stop` / `graft-status` payload shapes reach the daemon's
 *     handlers and come back through the CLI's own renderers (`started …`, `stopped …`,
 *     `<branch> [<status>] <path>`, `--json`);
 *   - scope precedence as the CLI sends it: `--workspace`, `--repo`, and the implicit
 *     `NEX_PANE_ID` default scope;
 *   - the sync itself: an edit in the worktree reaches the parent's working tree while the
 *     session watches, and `graft stop` restores the parent (HEAD, tracked files, auto-stash);
 *   - the error contracts: no scope, unknown workspace, unmatched repo, double start.
 *
 * Timing: sync passes are driven by a real watcher (500 ms trailing debounce), so every
 * disk-state assertion polls instead of sleeping a fixed amount.
 */

import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BREADCRUMB_FILENAME } from '../../src/graft/index.js';
import {
    currentBranch,
    git,
    gitAvailable,
    initRepo,
    porcelain,
    readIfPresent,
    waitFor
} from './gitfix.js';
import { startCompatDaemon, swiftCLIAvailable, type CompatDaemon } from './harness.js';

const RUNNABLE = swiftCLIAvailable() && gitAvailable();

interface CreateReply {
    readonly ok: boolean;
    readonly workspace_id?: string;
    readonly workspace_name?: string;
    readonly worktree_path?: string;
    readonly branch?: string;
    readonly error?: string;
}

interface SessionJSON {
    readonly association_id: string;
    readonly worktree_path: string;
    readonly parent_repo_root: string;
    readonly branch: string;
    readonly status: string;
    readonly error?: string;
    readonly stash_ref?: string;
    readonly last_sync?: string;
}

describe.skipIf(!RUNNABLE)('compat: graft', () => {
    let nex: CompatDaemon;
    /** The main checkout (realpath — the daemon canonicalizes every parent root). */
    let parent: string;
    let workspaceName: string;
    let worktree: string;
    let paneID: string;

    /** `workspace create --worktree` is the only CLI path that mints a repo association. */
    async function createWorktreeWorkspace(name: string, repo: string): Promise<CreateReply> {
        const created = await nex.run(
            ['workspace', 'create', '--name', name, '--worktree', name, '--repo', repo, '--json'],
            { timeoutMs: 60_000 }
        );
        expect(created.code, created.stderr).toBe(0);
        return JSON.parse(created.stdout) as CreateReply;
    }

    async function sessions(): Promise<readonly SessionJSON[]> {
        const listed = await nex.run(['graft', 'status', '--json']);
        expect(listed.code, listed.stderr).toBe(0);
        return JSON.parse(listed.stdout) as SessionJSON[];
    }

    beforeEach(async () => {
        nex = await startCompatDaemon();
        parent = initRepo(path.join(nex.root, 'repo'), { 'keep.txt': 'original\n' });
        workspaceName = 'feature';
        const reply = await createWorktreeWorkspace(workspaceName, parent);
        expect(reply.ok).toBe(true);
        worktree = reply.worktree_path as string;
        expect(fs.existsSync(worktree)).toBe(true);
        const panes = await nex.json<{ id: string; workspace_name: string }[]>([
            'pane',
            'list',
            '--workspace',
            workspaceName,
            '--json'
        ]);
        paneID = panes[0]?.id as string;
    }, 120_000);

    afterEach(async () => {
        // Stop anything still running BEFORE the tmp tree is deleted, so no watcher outlives
        // its directory and no breadcrumb is left in a repo we are about to remove.
        try {
            await nex?.run(['graft', 'stop', '--workspace', workspaceName], { timeoutMs: 30_000 });
        } catch {
            // The daemon may already be gone; the rm below is the real cleanup.
        }
        await nex?.stop();
    }, 60_000);

    // ── status / scope errors ───────────────────────────────────────────────

    it('reports an empty session list before anything starts', async () => {
        const human = await nex.run(['graft', 'status']);
        expect(human.code).toBe(0);
        expect(human.stdout.trim()).toBe('No active graft sessions.');
        expect(await sessions()).toEqual([]);
    }, 60_000);

    it('refuses a start with no scope and no calling pane', async () => {
        const result = await nex.run(['graft', 'start']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('graft requires --workspace, --repo, or NEX_PANE_ID');
        expect(result.stdout).toBe('');
    }, 60_000);

    it('rejects an unknown workspace and an unmatched repo distinctly', async () => {
        const ghost = await nex.run(['graft', 'start', '--workspace', 'ghost']);
        expect(ghost.code).toBe(1);
        expect(ghost.stderr).toContain('workspace not found: ghost');

        const noRepo = await nex.run(['graft', 'start', '--repo', 'not-a-repo-here']);
        expect(noRepo.code).toBe(1);
        expect(noRepo.stderr).toContain('no repo associations matched the requested scope');

        expect(await sessions()).toEqual([]);
    }, 60_000);

    it('answers "no active sessions in scope" for a stop with nothing running', async () => {
        const stopped = await nex.run(['graft', 'stop', '--workspace', workspaceName]);
        expect(stopped.code).toBe(0);
        expect(stopped.stdout.trim()).toBe('No active sessions in scope.');
    }, 60_000);

    // ── start → sync → stop ─────────────────────────────────────────────────

    it('starts a session, mirrors the worktree into the parent, and lists it in status', async () => {
        // An UNCOMMITTED worktree edit: proves the start performs a real sync pass (the two
        // checkouts share a commit, so only uncommitted content can distinguish them).
        fs.writeFileSync(path.join(worktree, 'from-worktree.txt'), 'grafted\n');

        const started = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        expect(started.stdout).toContain('started feature');
        expect(started.stdout).toContain(worktree);

        // The parent's working tree now carries the worktree's uncommitted file…
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe('grafted\n');
        // …while the parent's own HEAD never moved.
        expect(currentBranch(parent)).toBe('main');
        // The breadcrumb exists while the session lives (crash recovery).
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(true);

        const listed = await sessions();
        expect(listed).toHaveLength(1);
        const session = listed[0] as SessionJSON;
        expect(session.branch).toBe('feature');
        expect(session.status).toBe('watching');
        expect(session.worktree_path).toBe(worktree);
        expect(fs.realpathSync(session.parent_repo_root)).toBe(parent);
        expect(session.last_sync).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(session.error).toBeUndefined();

        const human = await nex.run(['graft', 'status']);
        expect(human.code).toBe(0);
        expect(human.stdout).toContain('feature [watching]');
        expect(human.stdout).toContain(worktree);
    }, 120_000);

    it('syncs a later worktree edit into the parent while watching', async () => {
        const started = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        const before = (await sessions())[0]?.last_sync;

        fs.writeFileSync(path.join(worktree, 'later.txt'), 'after start\n');
        const synced = await waitFor(
            () => readIfPresent(path.join(parent, 'later.txt')) === 'after start\n',
            30_000
        );
        expect(synced, 'the watcher never mirrored later.txt into the parent').toBe(true);

        // A modification of a tracked file mirrors too (read-tree --reset -u overwrites it).
        fs.writeFileSync(path.join(worktree, 'keep.txt'), 'edited in the worktree\n');
        const overwritten = await waitFor(
            () => readIfPresent(path.join(parent, 'keep.txt')) === 'edited in the worktree\n',
            30_000
        );
        expect(overwritten, 'the watcher never mirrored the keep.txt edit').toBe(true);

        const after = (await sessions())[0];
        expect(after?.status).toBe('watching');
        expect(after?.last_sync).not.toBe(undefined);
        // Seconds-precision ISO: equal is possible on a fast machine, earlier is not.
        expect(String(after?.last_sync) >= String(before)).toBe(true);
    }, 120_000);

    it('restores the parent (and its auto-stash) on stop', async () => {
        // Uncommitted parent work → the start must stash it, the stop must pop it back.
        fs.writeFileSync(path.join(parent, 'keep.txt'), 'parent work in progress\n');
        fs.writeFileSync(path.join(worktree, 'from-worktree.txt'), 'grafted\n');

        const started = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        const session = (await sessions())[0] as SessionJSON;
        expect(session.stash_ref).toMatch(/^[0-9a-f]{7,}$/);
        // While grafted the parent shows the WORKTREE's content, not its own.
        expect(readIfPresent(path.join(parent, 'keep.txt'))).toBe('original\n');
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe('grafted\n');

        const stopped = await nex.run(['graft', 'stop', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(stopped.stdout).toContain(`stopped ${session.association_id}`);

        expect(readIfPresent(path.join(parent, 'keep.txt'))).toBe('parent work in progress\n');
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe(null);
        expect(currentBranch(parent)).toBe('main');
        expect(porcelain(parent)).toContain('keep.txt');
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(false);
        expect(await sessions()).toEqual([]);

        // The stash was popped, not left behind.
        expect(git(parent, 'stash', 'list').trim()).toBe('');
    }, 120_000);

    it('refuses a second start for the same parent root', async () => {
        const first = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(first.code, first.stderr).toBe(0);

        const second = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(second.code).toBe(1);
        expect(second.stderr).toContain('another graft is already active for');
        expect(second.stderr).toContain(parent);
        expect(await sessions()).toHaveLength(1);
    }, 120_000);

    // ── scope forms ─────────────────────────────────────────────────────────

    it('scopes by --repo name and by the calling pane', async () => {
        // `--repo` matches the association's worktree path, its last component, or the repo's
        // registry name — here, the repo directory's name.
        const byRepo = await nex.run(['graft', 'start', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(byRepo.code, byRepo.stderr).toBe(0);
        expect(await sessions()).toHaveLength(1);

        const byRepoStop = await nex.run(['graft', 'stop', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(byRepoStop.code, byRepoStop.stderr).toBe(0);
        expect(await sessions()).toEqual([]);

        // No filters + NEX_PANE_ID = the caller's workspace.
        const byPane = await nex.run(['graft', 'start'], { paneID, timeoutMs: 60_000 });
        expect(byPane.code, byPane.stderr).toBe(0);
        expect(await sessions()).toHaveLength(1);

        const stopByPane = await nex.run(['graft', 'stop'], { paneID, timeoutMs: 60_000 });
        expect(stopByPane.code, stopByPane.stderr).toBe(0);
        expect(await sessions()).toEqual([]);
    }, 180_000);

    it('keeps the session alive (status: error) when the parent is mid-merge, then recovers', async () => {
        const started = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);

        // A merge the user started in the parent between passes: `read-tree` would wipe it, so
        // the pass must refuse. (The marker file IS how `repoState` detects it.)
        const mergeHead = path.join(parent, '.git', 'MERGE_HEAD');
        fs.writeFileSync(mergeHead, `${git(parent, 'rev-parse', 'HEAD').trim()}\n`);
        fs.writeFileSync(path.join(worktree, 'blocked.txt'), 'should not land\n');

        const failed = await waitFor(async () => (await sessions())[0]?.status === 'error', 30_000);
        expect(failed, 'the sync never reported an error status').toBe(true);
        const session = (await sessions())[0] as SessionJSON;
        expect(session.error).toContain('merge in progress');
        // Nothing was applied, and the session is still listed (it keeps its watcher).
        expect(readIfPresent(path.join(parent, 'blocked.txt'))).toBe(null);

        const human = await nex.run(['graft', 'status']);
        expect(human.stdout).toContain('feature [error]');

        // The next batch retries: clearing the merge and touching the worktree recovers.
        fs.rmSync(mergeHead);
        fs.writeFileSync(path.join(worktree, 'blocked.txt'), 'now it lands\n');
        const recovered = await waitFor(
            () => readIfPresent(path.join(parent, 'blocked.txt')) === 'now it lands\n',
            30_000
        );
        expect(recovered, 'the session never recovered after the merge was cleared').toBe(true);
        expect((await sessions())[0]?.status).toBe('watching');
    }, 120_000);

    it('clobbers an untracked parent file rather than refusing the sync', async () => {
        // Documented delta (see docs/compat-status.md): graft-git.md §4.6 treats "Untracked
        // working tree file" as the routine sync failure, but `git read-tree --reset -u`
        // (git 2.50) overwrites the untracked file instead of erroring. The engine's error
        // *formatting* for that case still exists; git just never produces it on this path.
        const started = await nex.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);

        fs.writeFileSync(path.join(parent, 'clash.txt'), 'parent version\n');
        fs.writeFileSync(path.join(worktree, 'clash.txt'), 'worktree version\n');

        const clobbered = await waitFor(
            () => readIfPresent(path.join(parent, 'clash.txt')) === 'worktree version\n',
            30_000
        );
        expect(clobbered, 'the untracked parent file was neither replaced nor reported').toBe(true);
        expect((await sessions())[0]?.status).toBe('watching');
    }, 120_000);
});
