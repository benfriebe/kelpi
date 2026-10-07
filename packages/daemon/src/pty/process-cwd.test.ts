/**
 * Asking the OS where a pane's shell is (`process-cwd.ts`), and choosing between that and the
 * stored directory when a split inherits one.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { chooseSplitDirectory, createProcessCwdReader, type SplitDirectoryFs } from './process-cwd.js';

describe('createProcessCwdReader on macOS (lsof)', () => {
    it("asks lsof for the pid's cwd only, and reads the name field", async () => {
        const runLsof = vi.fn(() => Promise.resolve('p4242\nfcwd\nn/Users/me/code/kelpi\n'));
        const read = createProcessCwdReader({ platform: 'darwin', runLsof });

        await expect(read(4242)).resolves.toBe('/Users/me/code/kelpi');
        expect(runLsof).toHaveBeenCalledWith(['-a', '-p', '4242', '-d', 'cwd', '-Fn'], 1_000);
    });

    it('keeps spaces in the path', async () => {
        const read = createProcessCwdReader({
            platform: 'darwin',
            runLsof: () => Promise.resolve('p1\nfcwd\nn/Users/me/My Code\n')
        });
        await expect(read(1)).resolves.toBe('/Users/me/My Code');
    });

    it('says null when lsof fails, times out or names nothing', async () => {
        const failing = createProcessCwdReader({ platform: 'darwin', runLsof: () => Promise.reject(new Error('exit 1')) });
        await expect(failing(1)).resolves.toBeNull();
        const empty = createProcessCwdReader({ platform: 'darwin', runLsof: () => Promise.resolve('') });
        await expect(empty(1)).resolves.toBeNull();
    });

    it('shares one lookup between concurrent asks, but never caches a settled one', async () => {
        let answer = '/first';
        const runLsof = vi.fn(() => Promise.resolve(`p7\nfcwd\nn${answer}\n`));
        const read = createProcessCwdReader({ platform: 'darwin', runLsof });

        const [a, b] = await Promise.all([read(7), read(7)]);
        expect([a, b]).toEqual(['/first', '/first']);
        expect(runLsof).toHaveBeenCalledTimes(1);

        // A `cd` right before the next split must count.
        answer = '/second';
        await expect(read(7)).resolves.toBe('/second');
        expect(runLsof).toHaveBeenCalledTimes(2);
    });
});

describe('createProcessCwdReader on Linux (/proc)', () => {
    it('reads /proc/<pid>/cwd and never runs lsof', async () => {
        const runLsof = vi.fn(() => Promise.resolve(''));
        const readProcLink = vi.fn((path: string) => Promise.resolve(path === '/proc/42/cwd' ? '/home/me' : ''));
        const read = createProcessCwdReader({ platform: 'linux', runLsof, readProcLink });

        await expect(read(42)).resolves.toBe('/home/me');
        expect(runLsof).not.toHaveBeenCalled();
    });

    it('says null for a process it cannot read', async () => {
        const read = createProcessCwdReader({ platform: 'linux', readProcLink: () => Promise.reject(new Error('ENOENT')) });
        await expect(read(42)).resolves.toBeNull();
    });
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('the real OS', () => {
    it("reports this process's own directory", async () => {
        const read = createProcessCwdReader();
        await expect(read(process.pid)).resolves.toBe(realpathSync(process.cwd()));
    });
});

describe('chooseSplitDirectory', () => {
    /** A filesystem where `/var` is a link to `/private/var`, as on macOS. */
    const fs: SplitDirectoryFs = {
        realpath: (path) =>
            path.startsWith('/gone')
                ? Promise.reject(new Error('ENOENT'))
                : Promise.resolve(path.replace(/^\/var\//, '/private/var/')),
        isDirectory: (path) => Promise.resolve(!path.includes('\\'))
    };

    it('keeps the stored directory when the OS has no answer', async () => {
        await expect(chooseSplitDirectory('/repo', null, fs)).resolves.toBe('/repo');
        await expect(chooseSplitDirectory('/repo', '', fs)).resolves.toBe('/repo');
    });

    it('keeps the logical stored path while the shell is still in that directory', async () => {
        await expect(chooseSplitDirectory('/var/folders/x/repo', '/private/var/folders/x/repo', fs)).resolves.toBe(
            '/var/folders/x/repo'
        );
    });

    it("takes the shell's directory once it has moved", async () => {
        await expect(chooseSplitDirectory('/Users/me', '/Users/me/.agents/skills', fs)).resolves.toBe(
            '/Users/me/.agents/skills'
        );
    });

    it('takes it when the stored directory is gone too', async () => {
        await expect(chooseSplitDirectory('/gone/away', '/Users/me', fs)).resolves.toBe('/Users/me');
    });

    it('does not trust an answer that is not a directory here', async () => {
        await expect(chooseSplitDirectory('/repo', '/odd\\nname', fs)).resolves.toBe('/repo');
    });

    describe('against the real filesystem', () => {
        const roots: string[] = [];
        afterEach(() => {
            for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
        });

        it('resolves a symlinked stored path to the same directory', async () => {
            const root = mkdtempSync(join(tmpdir(), 'kelpi-split-dir-'));
            roots.push(root);
            mkdirSync(join(root, 'real'));
            symlinkSync(join(root, 'real'), join(root, 'link'));
            const physical = realpathSync(join(root, 'real'));

            await expect(chooseSplitDirectory(join(root, 'link'), physical)).resolves.toBe(join(root, 'link'));
            await expect(chooseSplitDirectory(join(root, 'link'), realpathSync(root))).resolves.toBe(realpathSync(root));
        });
    });
});
