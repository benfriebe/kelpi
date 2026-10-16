/**
 * #342: `graft stop` when another git process holds the parent's index lock, through OUR bundled
 * CLI against a real daemon and real git.
 *
 * The reported case is reproduced as it happened: the parent's only dirt is one untracked file
 * (`.local/state/gh/device-id`), graft start stashes it with `--include-untracked`, and at stop
 * something else holds `.git/index.lock` when the pop runs, so git says `could not write index`.
 * A `KELPI_GIT` wrapper plays that other process: while a flag file exists it creates the lock
 * just before `git stash pop`, after the restore has run. Removing the flag and the lock is the
 * other process letting go.
 *
 * What it pins: the stop exits 1 and names the stash, `graft status` still lists the session as
 * an unfinished stop (it said `[]` before), and the next `graft stop` restores the file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BREADCRUMB_FILENAME } from '../../src/graft/index.js';
import { git, GIT, gitAvailable, initRepo, readIfPresent } from './gitfix.js';
import { bundleKelpiCLI, startCompatDaemon, type CompatDaemon } from './harness.js';

interface SessionJSON {
    readonly association_id: string;
    readonly status: string;
    readonly error?: string;
    readonly stash_ref?: string;
    readonly stop_incomplete?: boolean;
}

describe.skipIf(!gitAvailable())('compat: graft stop under a held index lock (#342)', () => {
    let kelpi: CompatDaemon | undefined;
    let bundleDir: string | undefined;

    afterEach(async () => {
        await kelpi?.stop();
        kelpi = undefined;
        if (bundleDir !== undefined) fs.rmSync(bundleDir, { recursive: true, force: true });
        bundleDir = undefined;
    }, 60_000);

    it('reports the stop as unfinished, keeps it in status, and the next stop restores the file', async () => {
        bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-graft-lock-'));
        const cli = await bundleKelpiCLI(bundleDir);
        const flag = path.join(bundleDir, 'rival');
        const wrapper = path.join(bundleDir, 'rival-git');
        fs.writeFileSync(
            wrapper,
            `#!/bin/sh\nif [ "$1" = stash ] && [ "$2" = pop ] && [ -e '${flag}' ]; then : > "$(pwd)/.git/index.lock"; fi\nexec '${GIT}' "$@"\n`,
            { mode: 0o755 }
        );
        // The daemon resolves its git once, when it is created; restore the env right after.
        const previous = process.env['KELPI_GIT'];
        process.env['KELPI_GIT'] = wrapper;
        try {
            kelpi = await startCompatDaemon({ cli });
        } finally {
            if (previous === undefined) delete process.env['KELPI_GIT'];
            else process.env['KELPI_GIT'] = previous;
        }
        const daemon = kelpi;
        const sessions = async (): Promise<SessionJSON[]> =>
            daemon.json<SessionJSON[]>(['graft', 'status', '--json']);

        const parent = initRepo(path.join(daemon.root, 'repo'), { 'keep.txt': 'original\n' });
        const created = await daemon.run(
            ['workspace', 'create', '--name', 'feature', '--worktree', 'feature', '--repo', parent, '--json'],
            { timeoutMs: 60_000 }
        );
        expect(created.code, created.stderr).toBe(0);
        const device = path.join(parent, '.local', 'state', 'gh', 'device-id');
        fs.mkdirSync(path.dirname(device), { recursive: true });
        fs.writeFileSync(device, 'device\n');

        const started = await daemon.run(['graft', 'start', '--workspace', 'feature'], { timeoutMs: 60_000 });
        expect(started.code, started.stderr).toBe(0);
        const stash = (await sessions())[0]?.stash_ref as string;
        expect(stash).toMatch(/^[0-9a-f]{40}$/);
        expect(readIfPresent(device)).toBe(null);

        fs.writeFileSync(flag, '');
        const failed = await daemon.run(['graft', 'stop', '--workspace', 'feature'], { timeoutMs: 60_000 });
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain('stop incomplete');
        expect(failed.stderr).toContain(stash);
        expect(failed.stderr).toContain('could not write index');
        expect(failed.stderr).toContain(`kelpi graft stop --repo ${parent}`);

        // Before #342 this said `[]` while the file was missing and the stash still listed.
        const kept = await sessions();
        expect(kept).toHaveLength(1);
        expect(kept[0]?.status).toBe('error');
        expect(kept[0]?.stop_incomplete).toBe(true);
        expect(kept[0]?.stash_ref).toBe(stash);
        const human = await daemon.run(['graft', 'status']);
        expect(human.stdout).toContain('[error]');
        expect(human.stdout).toContain(stash);
        expect(readIfPresent(device)).toBe(null);
        expect(git(parent, 'stash', 'list', '--format=%H').trim()).toBe(stash);
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(true);

        // The other process lets go; the retry the message names finishes the stop.
        fs.rmSync(flag);
        fs.rmSync(path.join(parent, '.git', 'index.lock'));
        const retried = await daemon.run(['graft', 'stop', '--repo', parent], { timeoutMs: 60_000 });
        expect(retried.code, retried.stderr).toBe(0);
        expect(retried.stdout.trim()).toBe(`stopped ${kept[0]?.association_id ?? ''}`);
        expect(readIfPresent(device)).toBe('device\n');
        expect(git(parent, 'stash', 'list').trim()).toBe('');
        expect(fs.existsSync(path.join(parent, '.git', BREADCRUMB_FILENAME))).toBe(false);
        expect(await sessions()).toEqual([]);
    }, 180_000);
});
