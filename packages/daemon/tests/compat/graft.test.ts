/**
 * `kelpi graft start|stop|status` against the REAL Swift CLI and REAL git repos (M7).
 *
 * The graft engine's contract is entirely about what lands on disk, so nothing here is faked:
 * a real `git init` parent, a real `git worktree add` (performed by the daemon, through
 * `kelpi workspace create --worktree`, because that is the only CLI-reachable way to get a repo
 * ASSOCIATION — associations are otherwise created from the GUI inspector), a real recursive
 * `fs.watch`, and the shipped `kelpi` binary driving all three verbs.
 *
 * What this pins that unit tests cannot:
 *   - the CLI's `graft-start` / `graft-stop` / `graft-status` payload shapes reach the daemon's
 *     handlers and come back through the CLI's own renderers (`started …`, `stopped …`,
 *     `<branch> [<status>] <path>`, `--json`);
 *   - scope precedence as the CLI sends it: `--workspace`, `--repo`, and the implicit
 *     `KELPI_PANE_ID` default scope;
 *   - the sync itself: an edit in the worktree reaches the parent's working tree while the
 *     session watches, and `graft stop` restores the parent (HEAD, tracked files, auto-stash);
 *   - the error contracts: no scope, unknown workspace, unmatched repo, no association, double
 *     start — plus the *partial* success (`started` + `Partial failure:` on stderr, exit 0) when
 *     one scope holds two associations of the same parent;
 *   - the quit flush: stopping the daemon unwinds every live session, so a clean shutdown never
 *     leaves a repo grafted, stashed or breadcrumbed.
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

/** `workspace create --worktree` is the only CLI path that mints a repo ASSOCIATION. */
async function createWorktreeWorkspace(
    kelpi: CompatDaemon,
    name: string,
    repo: string
): Promise<CreateReply> {
    const created = await kelpi.run(
        ['workspace', 'create', '--name', name, '--worktree', name, '--repo', repo, '--json'],
        { timeoutMs: 60_000 }
    );
    expect(created.code, created.stderr).toBe(0);
    return JSON.parse(created.stdout) as CreateReply;
}

/** `graft status --json` — the session list, straight from the engine. */
async function graftSessions(kelpi: CompatDaemon): Promise<readonly SessionJSON[]> {
    const listed = await kelpi.run(['graft', 'status', '--json']);
    expect(listed.code, listed.stderr).toBe(0);
    return JSON.parse(listed.stdout) as SessionJSON[];
}

describe.skipIf(!RUNNABLE)('compat: graft', () => {
    let kelpi: CompatDaemon;
    /** The main checkout (realpath — the daemon canonicalizes every parent root). */
    let parent: string;
    let workspaceName: string;
    let worktree: string;
    let paneID: string;

    const sessions = async (): Promise<readonly SessionJSON[]> => graftSessions(kelpi);

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
        parent = initRepo(path.join(kelpi.root, 'repo'), { 'keep.txt': 'original\n' });
        workspaceName = 'feature';
        const reply = await createWorktreeWorkspace(kelpi, workspaceName, parent);
        expect(reply.ok).toBe(true);
        worktree = reply.worktree_path as string;
        expect(fs.existsSync(worktree)).toBe(true);
        const panes = await kelpi.json<{ id: string; workspace_name: string }[]>([
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
            await kelpi?.run(['graft', 'stop', '--workspace', workspaceName], { timeoutMs: 30_000 });
        } catch {
            // The daemon may already be gone; the rm below is the real cleanup.
        }
        await kelpi?.stop();
    }, 60_000);

    // ── status / scope errors ───────────────────────────────────────────────

    it('reports an empty session list before anything starts', async () => {
        const human = await kelpi.run(['graft', 'status']);
        expect(human.code).toBe(0);
        expect(human.stdout.trim()).toBe('No active graft sessions.');
        expect(await sessions()).toEqual([]);
    }, 60_000);

    it('refuses a start with no scope and no calling pane', async () => {
        const result = await kelpi.run(['graft', 'start']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('graft requires --workspace, --repo, or KELPI_PANE_ID');
        expect(result.stdout).toBe('');
    }, 60_000);

    it('rejects an unknown workspace and an unmatched repo distinctly', async () => {
        const ghost = await kelpi.run(['graft', 'start', '--workspace', 'ghost']);
        expect(ghost.code).toBe(1);
        expect(ghost.stderr).toContain('workspace not found: ghost');

        const noRepo = await kelpi.run(['graft', 'start', '--repo', 'not-a-repo-here']);
        expect(noRepo.code).toBe(1);
        expect(noRepo.stderr).toContain('no repo associations matched the requested scope');

        expect(await sessions()).toEqual([]);
    }, 60_000);

    it('answers "no active sessions in scope" for a stop with nothing running', async () => {
        const stopped = await kelpi.run(['graft', 'stop', '--workspace', workspaceName]);
        expect(stopped.code).toBe(0);
        expect(stopped.stdout.trim()).toBe('No active sessions in scope.');
    }, 60_000);

    // ── start → sync → stop ─────────────────────────────────────────────────

    it('starts a session, mirrors the worktree into the parent, and lists it in status', async () => {
        // An UNCOMMITTED worktree edit: proves the start performs a real sync pass (the two
        // checkouts share a commit, so only uncommitted content can distinguish them).
        fs.writeFileSync(path.join(worktree, 'from-worktree.txt'), 'grafted\n');

        const started = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
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

        const human = await kelpi.run(['graft', 'status']);
        expect(human.code).toBe(0);
        expect(human.stdout).toContain('feature [watching]');
        expect(human.stdout).toContain(worktree);
    }, 120_000);

    it('syncs a later worktree edit into the parent while watching', async () => {
        const started = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
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

        const started = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        const session = (await sessions())[0] as SessionJSON;
        expect(session.stash_ref).toMatch(/^[0-9a-f]{7,}$/);
        // While grafted the parent shows the WORKTREE's content, not its own.
        expect(readIfPresent(path.join(parent, 'keep.txt'))).toBe('original\n');
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe('grafted\n');

        const stopped = await kelpi.run(['graft', 'stop', '--workspace', workspaceName], {
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
        const first = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(first.code, first.stderr).toBe(0);

        const second = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
            timeoutMs: 60_000
        });
        expect(second.code).toBe(1);
        expect(second.stderr).toContain('another graft is already active for');
        expect(second.stderr).toContain(parent);
        expect(await sessions()).toHaveLength(1);
    }, 120_000);

    // ── scope forms ─────────────────────────────────────────────────────────

    it('composes --workspace with --repo (the repo filter narrows the workspace scope)', async () => {
        // §9.1 precedence: workspace wins as the SCOPE, then `--repo` filters inside it. A repo
        // filter that matches nothing in that workspace is "no associations", not "wrong repo".
        const both = await kelpi.run(
            ['graft', 'start', '--workspace', workspaceName, '--repo', path.basename(parent)],
            { timeoutMs: 60_000 }
        );
        expect(both.code, both.stderr).toBe(0);
        expect(await sessions()).toHaveLength(1);

        const stopped = await kelpi.run(
            ['graft', 'stop', '--workspace', workspaceName, '--repo', path.basename(parent)],
            { timeoutMs: 60_000 }
        );
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(await sessions()).toEqual([]);

        const mismatched = await kelpi.run(
            ['graft', 'start', '--workspace', workspaceName, '--repo', 'some-other-repo'],
            { timeoutMs: 60_000 }
        );
        expect(mismatched.code).toBe(1);
        expect(mismatched.stderr).toContain('no repo associations matched the requested scope');
    }, 180_000);

    it('scopes by --repo name and by the calling pane', async () => {
        // `--repo` matches the association's worktree path, its last component, or the repo's
        // registry name — here, the repo directory's name.
        const byRepo = await kelpi.run(['graft', 'start', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(byRepo.code, byRepo.stderr).toBe(0);
        expect(await sessions()).toHaveLength(1);

        const byRepoStop = await kelpi.run(['graft', 'stop', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(byRepoStop.code, byRepoStop.stderr).toBe(0);
        expect(await sessions()).toEqual([]);

        // No filters + KELPI_PANE_ID = the caller's workspace.
        const byPane = await kelpi.run(['graft', 'start'], { paneID, timeoutMs: 60_000 });
        expect(byPane.code, byPane.stderr).toBe(0);
        expect(await sessions()).toHaveLength(1);

        const stopByPane = await kelpi.run(['graft', 'stop'], { paneID, timeoutMs: 60_000 });
        expect(stopByPane.code, stopByPane.stderr).toBe(0);
        expect(await sessions()).toEqual([]);
    }, 180_000);

    it('keeps the session alive (status: error) when the parent is mid-merge, then recovers', async () => {
        const started = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
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

        const human = await kelpi.run(['graft', 'status']);
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
        // Documented delta (see ../kelpi-docs/compat-status.md): graft-git.md §4.6 treats "Untracked
        // working tree file" as the routine sync failure, but `git read-tree --reset -u`
        // (git 2.50) overwrites the untracked file instead of erroring. The engine's error
        // *formatting* for that case still exists; git just never produces it on this path.
        const started = await kelpi.run(['graft', 'start', '--workspace', workspaceName], {
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

/**
 * Scopes that span more than one association, and the shutdown path.
 *
 * The suite above drives a single worktree; these cases need two, so they build their own
 * fixtures per test rather than sharing a `beforeEach` worktree.
 */
describe.skipIf(!RUNNABLE)('compat: graft across several associations', () => {
    let kelpi: CompatDaemon;

    beforeEach(async () => {
        kelpi = await startCompatDaemon();
    }, 60_000);

    afterEach(async () => {
        try {
            // Unwind whatever a test left running before the tmp tree disappears underneath it.
            await kelpi?.daemon.stop();
        } catch {
            // Already stopped by the test itself.
        }
        await kelpi?.stop();
    }, 60_000);

    it('refuses a workspace that has no repo association', async () => {
        const plain = await kelpi.run(['workspace', 'create', '--name', 'Plain', '--json'], {
            timeoutMs: 30_000
        });
        expect(plain.code, plain.stderr).toBe(0);

        const started = await kelpi.run(['graft', 'start', '--workspace', 'Plain'], {
            timeoutMs: 30_000
        });
        expect(started.code).toBe(1);
        expect(started.stderr).toContain('no repo associations matched the requested scope');
        expect(await graftSessions(kelpi)).toEqual([]);
    }, 120_000);

    it('starts what it can and reports the rest as a partial failure', async () => {
        // Two worktrees of the SAME parent: `--repo <name>` matches both associations, but a
        // parent can host only one graft, so the second start loses and the reply carries
        // `started` AND `partial_error` — the CLI prints both and still exits 0.
        const parent = initRepo(path.join(kelpi.root, 'shared'), { 'keep.txt': 'original\n' });
        const first = await createWorktreeWorkspace(kelpi, 'alpha', parent);
        const second = await createWorktreeWorkspace(kelpi, 'beta', parent);
        expect(first.ok && second.ok).toBe(true);

        const started = await kelpi.run(['graft', 'start', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        expect(started.stdout).toContain('started ');
        expect(started.stderr).toContain('Partial failure:');
        expect(started.stderr).toContain('another graft is already active for');
        expect(started.stderr).toContain(parent);

        // Exactly one session exists — the loser started nothing.
        const listed = await graftSessions(kelpi);
        expect(listed).toHaveLength(1);
        expect(['alpha', 'beta']).toContain(listed[0]?.branch);

        // …and the repo-wide stop takes it down again (one `stopped <id>` line).
        const stopped = await kelpi.run(['graft', 'stop', '--repo', path.basename(parent)], {
            timeoutMs: 60_000
        });
        expect(stopped.code, stopped.stderr).toBe(0);
        expect(stopped.stdout.trim().split('\n')).toHaveLength(1);
        expect(await graftSessions(kelpi)).toEqual([]);
    }, 180_000);

    it('keeps sessions in different repos independent, and stops only the scope asked for', async () => {
        const one = initRepo(path.join(kelpi.root, 'one'), { 'keep.txt': 'one original\n' });
        const two = initRepo(path.join(kelpi.root, 'two'), { 'keep.txt': 'two original\n' });
        const wsOne = await createWorktreeWorkspace(kelpi, 'ws-one', one);
        const wsTwo = await createWorktreeWorkspace(kelpi, 'ws-two', two);

        // Distinguishable uncommitted content in each worktree, so "which parent got grafted"
        // is answerable from disk alone.
        fs.writeFileSync(path.join(wsOne.worktree_path as string, 'mark.txt'), 'from one\n');
        fs.writeFileSync(path.join(wsTwo.worktree_path as string, 'mark.txt'), 'from two\n');

        for (const name of ['ws-one', 'ws-two']) {
            const started = await kelpi.run(['graft', 'start', '--workspace', name], {
                timeoutMs: 60_000
            });
            expect(started.code, started.stderr).toBe(0);
        }

        const listed = await graftSessions(kelpi);
        expect(listed.map((session) => session.branch).sort()).toEqual(['ws-one', 'ws-two']);
        expect(readIfPresent(path.join(one, 'mark.txt'))).toBe('from one\n');
        expect(readIfPresent(path.join(two, 'mark.txt'))).toBe('from two\n');

        const stopped = await kelpi.run(['graft', 'stop', '--workspace', 'ws-one'], {
            timeoutMs: 60_000
        });
        expect(stopped.code, stopped.stderr).toBe(0);

        const remaining = await graftSessions(kelpi);
        expect(remaining.map((session) => session.branch)).toEqual(['ws-two']);
        // Only the scoped parent was restored; the other is still mirroring its worktree.
        expect(readIfPresent(path.join(one, 'mark.txt'))).toBe(null);
        expect(readIfPresent(path.join(two, 'mark.txt'))).toBe('from two\n');
        expect(fs.existsSync(path.join(one, '.git', BREADCRUMB_FILENAME))).toBe(false);
        expect(fs.existsSync(path.join(two, '.git', BREADCRUMB_FILENAME))).toBe(true);
    }, 180_000);

    it('unwinds every live session when the daemon shuts down', async () => {
        // The quit flush (graft-git.md §5): a clean daemon stop must never leave a user's repo
        // grafted, stashed or breadcrumbed — the breadcrumb is the crash path, not this one.
        const parent = initRepo(path.join(kelpi.root, 'quit'), { 'keep.txt': 'original\n' });
        const created = await createWorktreeWorkspace(kelpi, 'quitting', parent);
        fs.writeFileSync(path.join(parent, 'keep.txt'), 'parent work in progress\n');
        fs.writeFileSync(path.join(created.worktree_path as string, 'from-worktree.txt'), 'grafted\n');

        const started = await kelpi.run(['graft', 'start', '--workspace', 'quitting'], {
            timeoutMs: 60_000
        });
        expect(started.code, started.stderr).toBe(0);
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe('grafted\n');
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(true);

        await kelpi.daemon.stop();

        expect(readIfPresent(path.join(parent, 'keep.txt'))).toBe('parent work in progress\n');
        expect(readIfPresent(path.join(parent, 'from-worktree.txt'))).toBe(null);
        expect(currentBranch(parent)).toBe('main');
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(false);
        expect(git(parent, 'stash', 'list').trim()).toBe('');
    }, 180_000);
});
