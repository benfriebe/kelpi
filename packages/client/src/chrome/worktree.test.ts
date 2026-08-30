/**
 * The client sanitizer must agree with the daemon's, character for character: the preview's
 * whole job is to show the folder and branch git will actually get (issue #218). The corpus is
 * the daemon's own (`daemon/src/git/names.test.ts`), plus the daemon's real implementation
 * imported directly so a future edit to either side fails here rather than in a user's window.
 */

import { sanitizedGitName } from '@kelpi/daemon/git';
import { describe, expect, it } from 'vitest';

import { sanitizeGitName, worktreePreview, worktreePreviewPath } from './worktree';

const CORPUS = [
    'feature/foo.bar_baz-1',
    'My Feature!!',
    'a  b   c',
    'a--b//c..d',
    '  /.-_feature-_./  ',
    '   ',
    '///',
    '!!!',
    'fix #218: worktree preview',
    'ünïcödé-name',
    'UPPER/lower',
    '.hidden',
    'trailing/',
    'a'.repeat(80)
];

describe('sanitizeGitName', () => {
    it('matches the daemon implementation on every case in the corpus', () => {
        for (const input of CORPUS) {
            expect(sanitizeGitName(input), `input: ${JSON.stringify(input)}`).toBe(sanitizedGitName(input));
        }
    });

    it('is a fixed point for an already-valid name and collapses everything else', () => {
        expect(sanitizeGitName('feature/foo.bar_baz-1')).toBe('feature/foo.bar_baz-1');
        expect(sanitizeGitName('My Feature!!')).toBe('My-Feature');
        expect(sanitizeGitName('a--b//c..d')).toBe('a-b/c.d');
        expect(sanitizeGitName('  /.-_feature-_./  ')).toBe('feature');
    });

    it('returns null when nothing survives', () => {
        expect(sanitizeGitName('   ')).toBeNull();
        expect(sanitizeGitName('///')).toBeNull();
    });
});

describe('worktreePreviewPath', () => {
    it('joins onto the daemon-resolved base and normalizes a trailing separator', () => {
        expect(worktreePreviewPath('/Users/x/nex/worktrees/app', 'fix')).toBe(
            '/Users/x/nex/worktrees/app/fix'
        );
        expect(worktreePreviewPath('/Users/x/nex/worktrees/app/', 'fix')).toBe(
            '/Users/x/nex/worktrees/app/fix'
        );
    });
});

describe('worktreePreview', () => {
    it('shows the real folder and branch, and enables Create only when both sanitize', () => {
        const preview = worktreePreview({
            name: 'Fix Login Bug',
            branch: 'fix/login bug',
            base: '/Users/x/nex/worktrees/app'
        });
        expect(preview.path).toBe('/Users/x/nex/worktrees/app/Fix-Login-Bug');
        expect(preview.branchLine).toBe('branch: fix/login-bug');
        expect(preview.valid).toBe(true);
    });

    it('falls back to placeholders and refuses Create while a name is unusable', () => {
        const preview = worktreePreview({ name: '!!!', branch: '', base: '/base' });
        expect(preview.path).toBe('/base/<name>');
        expect(preview.branchLine).toBe('branch: <branch>');
        expect(preview.valid).toBe(false);
    });
});
