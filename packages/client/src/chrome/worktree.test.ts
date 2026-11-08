/**
 * The client sanitizer must agree with the daemon's, character for character: the preview's
 * whole job is to show the folder and branch git will actually get (issue #218). The corpus is
 * the daemon's own (`daemon/src/git/names.test.ts`), plus the daemon's real implementation
 * imported directly so a future edit to either side fails here rather than in a user's window.
 */

import { sanitizedGitName, worktreeStepsFor } from '@kelpi/daemon/git';
import { WORKSPACE_CHECKOUT_MODES } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import {
    formatElapsed,
    initialWorktreeProgress,
    parseWorktreeProgress,
    sanitizeGitName,
    worktreeNameFromWorkspace,
    worktreePreview,
    worktreePreviewPath,
    worktreeProgressSteps,
    worktreeStepLabel
} from './worktree';

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

describe('worktreeNameFromWorkspace (app-state-core §5.5)', () => {
    it('is the lowercased name through the daemon’s own sanitizer, and a fixed point of it', () => {
        for (const input of [...CORPUS, 'Fix Login Bug', 'Émile’s Fix', 'x'.repeat(300)]) {
            const followed = worktreeNameFromWorkspace(input);
            expect(followed, `input: ${JSON.stringify(input)}`).toBe(sanitizedGitName(input.toLowerCase()) ?? '');
            if (followed !== '') expect(sanitizedGitName(followed)).toBe(followed);
        }
        expect(worktreeNameFromWorkspace('Fix Login Bug')).toBe('fix-login-bug');
    });

    it('is empty, never an invented name, when nothing usable survives', () => {
        expect(worktreeNameFromWorkspace('!!!')).toBe('');
        expect(worktreeNameFromWorkspace('🚀✨')).toBe('');
        expect(worktreeNameFromWorkspace('')).toBe('');
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

describe('worktree create progress (#294)', () => {
    it('starts the checklist with the steps this create runs, the first one running', () => {
        expect(initialWorktreeProgress(true).steps.map((step) => `${step.id}:${step.status}`)).toEqual([
            'resolve-default-branch:running',
            'fetch:pending',
            'worktree-add:pending',
            'create-workspace:pending'
        ]);
        expect(initialWorktreeProgress(false).steps.map((step) => step.id)).toEqual(['worktree-add', 'create-workspace']);
    });

    it('reads the daemon’s snapshot, dropping what it does not understand row by row', () => {
        expect(
            parseWorktreeProgress({
                kind: 'worktree-create',
                steps: [
                    { id: 'fetch', status: 'running', detail: 'origin/main', phase: 'Receiving objects', percent: 45 },
                    { id: 'teleport', status: 'running' },
                    { id: 'worktree-add', status: 'exploded' },
                    { id: 'create-workspace', status: 'pending', percent: 250, detail: '' },
                    'nonsense'
                ],
                cancelled: true
            })
        ).toEqual({
            cancelled: true,
            detailed: true,
            steps: [
                { id: 'fetch', status: 'running', detail: 'origin/main', phase: 'Receiving objects', percent: 45 },
                { id: 'create-workspace', status: 'pending', percent: 100 }
            ]
        });
        expect(parseWorktreeProgress({ kind: 'something-else', steps: [] })).toBeNull();
        expect(parseWorktreeProgress({ kind: 'worktree-create' })).toBeNull();
        expect(parseWorktreeProgress(null)).toBeNull();
        expect(parseWorktreeProgress({ kind: 'worktree-create', steps: [] })).toEqual({ steps: [], cancelled: false, detailed: true });
        expect(parseWorktreeProgress({ kind: 'worktree-create', steps: [], detailed: false })).toEqual({ steps: [], cancelled: false, detailed: false });
    });

    it('reads the ticket step and the checkout a create from a ticket names, dropping an unknown mode', () => {
        expect(
            parseWorktreeProgress({
                kind: 'worktree-create',
                steps: [
                    { id: 'ticket', status: 'done', detail: '#418' },
                    { id: 'fetch', status: 'running' }
                ],
                checkout: 'pr-head'
            })
        ).toEqual({
            cancelled: false,
            detailed: true,
            checkout: 'pr-head',
            steps: [
                { id: 'ticket', status: 'done', detail: '#418' },
                { id: 'fetch', status: 'running' }
            ]
        });
        expect(parseWorktreeProgress({ kind: 'worktree-create', steps: [], checkout: 'teleport' })).toEqual({
            steps: [],
            cancelled: false,
            detailed: true
        });
    });

    it('plans a ticket create\'s checklist per checkout mode, exactly as the daemon does', () => {
        for (const checkout of WORKSPACE_CHECKOUT_MODES) {
            for (const updateMain of [true, false]) {
                for (const ticket of [true, false]) {
                    expect(worktreeProgressSteps({ checkout, updateMain, ticket }), `${checkout} ${String(updateMain)} ${String(ticket)}`).toEqual(
                        worktreeStepsFor({ checkout, updateMain, ticket })
                    );
                }
            }
        }
        const pr = initialWorktreeProgress({ ticket: true, checkout: 'pr-head' });
        expect(pr.steps.map((step) => `${step.id}:${step.status}`)).toEqual([
            'ticket:running',
            'fetch:pending',
            'worktree-add:pending',
            'create-workspace:pending'
        ]);
        expect(pr.checkout).toBe('pr-head');
        // The plain boolean form names no checkout, so its steps keep their plain labels.
        expect(initialWorktreeProgress(true).checkout).toBeUndefined();
        expect(initialWorktreeProgress({ ticket: true, checkout: 'existing-checkout' }).steps.map((step) => step.id)).toEqual([
            'ticket',
            'create-workspace'
        ]);
    });

    it('labels a step for what it does under the checkout mode', () => {
        expect(worktreeStepLabel('fetch')).toBe('Fetch the latest main');
        expect(worktreeStepLabel('fetch', 'new-branch')).toBe('Fetch the latest main');
        expect(worktreeStepLabel('fetch', 'pr-head')).toBe('Fetch the pull request');
        expect(worktreeStepLabel('worktree-add', 'pr-head')).toBe('Check out the pull request');
        expect(worktreeStepLabel('worktree-add', 'attach-branch')).toBe('Create the worktree on the existing branch');
        expect(worktreeStepLabel('ticket', 'existing-checkout')).toBe('Look up the ticket');
        expect(worktreeStepLabel('create-workspace', 'existing-checkout')).toBe('Open the workspace');
    });

    it('formats the elapsed clock', () => {
        expect(formatElapsed(0)).toBe('0.0 s');
        expect(formatElapsed(3_450)).toBe('3.5 s');
        expect(formatElapsed(12_400)).toBe('12 s');
        expect(formatElapsed(65_000)).toBe('1:05');
        expect(formatElapsed(-5)).toBe('0.0 s');
    });
});
