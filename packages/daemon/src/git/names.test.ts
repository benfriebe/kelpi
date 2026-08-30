import { describe, expect, it } from 'vitest';

import { GitCommandError } from './exec.js';
import {
    DEFAULT_WORKTREE_BASE_PATH,
    expandTilde,
    resolvedWorktreeBasePath,
    sanitizedGitName,
    standardizePath,
    worktreeErrorMessage,
    worktreePathFor
} from './names.js';

const HOME = '/Users/test';

describe('sanitizedGitName', () => {
    it('is a fixed point for an already-valid name', () => {
        expect(sanitizedGitName('feature/foo.bar_baz-1')).toBe('feature/foo.bar_baz-1');
    });

    it('collapses unsafe runs to a single hyphen and preserves case', () => {
        expect(sanitizedGitName('My Feature!!')).toBe('My-Feature');
        expect(sanitizedGitName('a  b   c')).toBe('a-b-c');
    });

    it('collapses repeated separators', () => {
        expect(sanitizedGitName('a--b//c..d')).toBe('a-b/c.d');
    });

    it('trims leading and trailing separator characters (space included)', () => {
        expect(sanitizedGitName('  /.-_feature-_./  ')).toBe('feature');
    });

    it('returns null when nothing survives', () => {
        expect(sanitizedGitName('   ')).toBeNull();
        expect(sanitizedGitName('///')).toBeNull();
        expect(sanitizedGitName('!!!')).toBeNull();
    });
});

describe('resolvedWorktreeBasePath', () => {
    it('expands a leading <repo> to the full repo path', () => {
        expect(resolvedWorktreeBasePath('<repo>/worktrees', '/Users/ben/code/myrepo', HOME)).toBe(
            '/Users/ben/code/myrepo/worktrees'
        );
    });

    it('expands a non-leading <repo> to the repo directory name', () => {
        expect(resolvedWorktreeBasePath(DEFAULT_WORKTREE_BASE_PATH, '/Users/ben/code/myrepo', HOME)).toBe(
            `${HOME}/nex/worktrees/myrepo`
        );
    });

    it('expands both forms in one template', () => {
        expect(resolvedWorktreeBasePath('<repo>/wt/<repo>', '/code/kelpi', HOME)).toBe('/code/kelpi/wt/kelpi');
    });

    it('joins the sanitized folder name onto the base', () => {
        expect(
            worktreePathFor({
                template: DEFAULT_WORKTREE_BASE_PATH,
                repoPath: '/code/kelpi',
                home: HOME,
                folderName: 'feature-x'
            })
        ).toBe(`${HOME}/nex/worktrees/kelpi/feature-x`);
    });
});

describe('path helpers', () => {
    it('expands a bare tilde and a tilde prefix only', () => {
        expect(expandTilde('~', HOME)).toBe(HOME);
        expect(expandTilde('~/code', HOME)).toBe(`${HOME}/code`);
        expect(expandTilde('/tmp/~/x', HOME)).toBe('/tmp/~/x');
    });

    it('standardizes . / .. and a trailing separator', () => {
        expect(standardizePath('/a/b/../c/', HOME)).toBe('/a/c');
        expect(standardizePath(' ~/code/./kelpi ', HOME)).toBe(`${HOME}/code/kelpi`);
    });
});

describe('worktreeErrorMessage', () => {
    const gitError = (stderr: string): GitCommandError =>
        new GitCommandError({ command: 'git worktree add x', exitCode: 128, stderr, cwd: '/repo' });

    it('prefers the LAST fatal: line over git’s informational preamble', () => {
        const message = worktreeErrorMessage(
            gitError("Preparing worktree (new branch 'x')\nfatal: '/tmp/wt' already exists")
        );
        expect(message).toBe("fatal: '/tmp/wt' already exists");
    });

    it('matches fatal:/error: case-insensitively and takes the last one', () => {
        const message = worktreeErrorMessage(gitError('error: first\nFATAL: second\nnoise'));
        expect(message).toBe('FATAL: second');
    });

    it('falls back to the last non-empty line', () => {
        expect(worktreeErrorMessage(gitError('one\ntwo\n\n'))).toBe('two');
    });

    it('falls back to the error description without stderr', () => {
        expect(worktreeErrorMessage(new Error('spawn git ENOENT'))).toBe('spawn git ENOENT');
        expect(worktreeErrorMessage('boom')).toBe('boom');
    });
});
