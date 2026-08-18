import { describe, expect, it } from 'vitest';

import { GitCommandError } from '../git/index.js';
import { describeSyncError, errorText, GraftError, graftErrorKind, isGraftError } from './errors.js';

function gitFailure(stderr: string): GitCommandError {
    return new GitCommandError({ command: 'git read-tree', exitCode: 128, stderr, cwd: '/repo' });
}

describe('GraftError', () => {
    it('carries the diagnostics the user needs in each kind', () => {
        const active = GraftError.alreadyActive('/Users/ben/code/nex');
        expect(active.kind).toBe('alreadyActive');
        expect(active.parentRepoRoot).toBe('/Users/ben/code/nex');
        expect(active.message).toContain('/Users/ben/code/nex');

        const busy = GraftError.repoBusy('merge in progress');
        expect(busy.kind).toBe('repoBusy');
        expect(busy.message).toBe('repository is busy: merge in progress');

        const missing = GraftError.missingWorktree('/w/gone');
        expect(missing.kind).toBe('missingWorktree');
        expect(missing.worktreePath).toBe('/w/gone');

        const main = GraftError.notAWorktree('/repo');
        expect(main.kind).toBe('notAWorktree');

        const conflict = GraftError.stashPopConflict('deadbeef', 'CONFLICT in keep.txt');
        expect(conflict.kind).toBe('stashPopConflict');
        expect(conflict.stashRef).toBe('deadbeef');
        expect(conflict.message).toContain('deadbeef');
        expect(conflict.message).toContain('CONFLICT in keep.txt');

        expect(GraftError.branchResolutionFailed('/w').kind).toBe('branchResolutionFailed');
        expect(isGraftError(active)).toBe(true);
        expect(isGraftError(new Error('nope'))).toBe(false);
    });

    it('maps any thrown value to an error_kind', () => {
        expect(graftErrorKind(GraftError.repoBusy('rebase in progress'))).toBe('repoBusy');
        expect(graftErrorKind(new Error('boom'))).toBe('unknown');
        expect(graftErrorKind('boom')).toBe('unknown');
        expect(graftErrorKind(null)).toBe('unknown');
        expect(GraftError.unknown(GraftError.repoBusy('x')).kind).toBe('repoBusy');
        expect(GraftError.unknown('plain string').message).toBe('plain string');
    });
});

describe('errorText', () => {
    it('prefers an Error message (git stderr rides on it) over stringification', () => {
        expect(errorText(gitFailure('fatal: bad object'))).toBe('fatal: bad object');
        expect(errorText(new Error('boom'))).toBe('boom');
        expect(errorText({ toString: () => 'weird' })).toBe('weird');
    });
});

describe('describeSyncError', () => {
    it('renders the untracked-file refusal as an actionable "Sync blocked" line', () => {
        const error = gitFailure(
            "error: Untracked working tree file 'src/app.ts' would be overwritten by merge.\n" +
                'fatal: could not read the index'
        );
        expect(describeSyncError(error)).toBe(
            "Sync blocked — error: Untracked working tree file 'src/app.ts' would be overwritten by merge."
        );
    });

    it('renders any other git failure with its full stderr', () => {
        expect(describeSyncError(gitFailure('fatal: not a tree object'))).toBe(
            'Sync failed: fatal: not a tree object'
        );
    });

    it('falls back to the stringified error for non-git failures', () => {
        expect(describeSyncError(GraftError.repoBusy('merge in progress'))).toBe(
            'Sync failed: repository is busy: merge in progress'
        );
        expect(describeSyncError(gitFailure(''))).toContain('Sync failed:');
    });
});
