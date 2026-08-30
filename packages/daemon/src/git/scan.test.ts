import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { REPO_SCAN_MAX_DEPTH, scanForRepos } from './scan.js';

/**
 * A throw-away tree, never anywhere near the developer's own directories:
 *
 *   root/
 *     Beta/.git/                 (directory form — a normal checkout)
 *       nested/.git/             (must NOT be found: the walk stops at a repo)
 *     alpha/.git                 (FILE form — a linked worktree)
 *     .hidden/repo/.git/         (hidden branch, skipped entirely)
 *     deep/a/b/c/.git/           (depth 4 from the root — past the bound)
 *     plain/                     (no .git anywhere)
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-scan-'));

function mkdirp(...parts: string[]): string {
    const target = path.join(root, ...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
}

mkdirp('Beta', '.git');
mkdirp('Beta', 'nested', '.git');
mkdirp('alpha');
fs.writeFileSync(path.join(root, 'alpha', '.git'), 'gitdir: /elsewhere/.git/worktrees/alpha\n');
mkdirp('.hidden', 'repo', '.git');
mkdirp('deep', 'a', 'b', 'c', '.git');
mkdirp('plain', 'src');

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('scanForRepos (§GIT-066)', () => {
    it('finds both `.git` forms, skips hidden trees, and never recurses into a repo', () => {
        const found = scanForRepos(root);
        const names = found.map((entry) => entry.name);
        expect(names).toContain('Beta'); // .git directory
        expect(names).toContain('alpha'); // .git file (a linked worktree)
        expect(names).not.toContain('nested'); // inside a repo — the walk stopped
        expect(names).not.toContain('repo'); // under `.hidden/`
        expect(names).not.toContain('plain'); // no .git at all
    });

    it('sorts case-insensitively by name, which is the order the registry list shows', () => {
        expect(scanForRepos(root).map((entry) => entry.name)).toEqual(['alpha', 'Beta']);
    });

    it('bounds the walk at depth 3 by default, and honours a smaller bound', () => {
        // `deep/a/b/c` is four levels down: past the default.
        expect(scanForRepos(root).map((entry) => entry.name)).not.toContain('c');
        expect(scanForRepos(root, { maxDepth: 4 }).map((entry) => entry.name)).toContain('c');
        // Depth 0 can only ever match the root itself.
        expect(scanForRepos(root, { maxDepth: 0 })).toEqual([]);
        expect(REPO_SCAN_MAX_DEPTH).toBe(3);
    });

    it('returns the repo itself when the chosen root IS a checkout', () => {
        const found = scanForRepos(path.join(root, 'Beta'));
        expect(found).toEqual([{ path: path.join(root, 'Beta'), name: 'Beta' }]);
    });

    it('answers empty for a path that does not exist rather than throwing', () => {
        expect(scanForRepos(path.join(root, 'nope'))).toEqual([]);
    });
});
