/**
 * Typed graft failures (graft-git.md §2 `GraftError`, §4.6 `describeSyncError`).
 *
 * The Swift app puts stringified enum cases on the wire (`alreadyActive(parentRepoRoot: "/x")`);
 * port note 7 explicitly allows cleaner prose as long as the diagnostics survive — the root
 * path, the stash SHA and git's stderr are the user's ONLY clue. PLAN.md also asks for the
 * additive machine-readable `error_kind`, which is what `kind` becomes on the wire.
 */

import { isGitCommandError } from '../git/index.js';

export type GraftErrorKind =
    | 'alreadyActive'
    | 'repoBusy'
    | 'missingWorktree'
    | 'branchResolutionFailed'
    | 'stashPopConflict'
    | 'notAWorktree'
    | 'unknown';

export class GraftError extends Error {
    readonly kind: GraftErrorKind;
    /** Set for `alreadyActive`. */
    readonly parentRepoRoot: string | undefined;
    /** Set for `missingWorktree` / `notAWorktree`. */
    readonly worktreePath: string | undefined;
    /** Set for `repoBusy`: "merge in progress", … */
    readonly state: string | undefined;
    /** Set for `stashPopConflict`. */
    readonly stashRef: string | undefined;
    readonly underlying: string | undefined;

    constructor(
        kind: GraftErrorKind,
        message: string,
        detail: {
            readonly parentRepoRoot?: string;
            readonly worktreePath?: string;
            readonly state?: string;
            readonly stashRef?: string;
            readonly underlying?: string;
        } = {}
    ) {
        super(message);
        this.name = 'GraftError';
        this.kind = kind;
        this.parentRepoRoot = detail.parentRepoRoot;
        this.worktreePath = detail.worktreePath;
        this.state = detail.state;
        this.stashRef = detail.stashRef;
        this.underlying = detail.underlying;
    }

    static alreadyActive(parentRepoRoot: string): GraftError {
        return new GraftError(
            'alreadyActive',
            `another graft is already active for ${parentRepoRoot}`,
            { parentRepoRoot }
        );
    }

    static repoBusy(state: string): GraftError {
        return new GraftError('repoBusy', `repository is busy: ${state}`, { state });
    }

    static missingWorktree(worktreePath: string): GraftError {
        return new GraftError(
            'missingWorktree',
            `worktree not found or not a git checkout: ${worktreePath}`,
            { worktreePath }
        );
    }

    static notAWorktree(worktreePath: string): GraftError {
        return new GraftError(
            'notAWorktree',
            `${worktreePath} is the repository's main checkout, not a linked worktree`,
            { worktreePath }
        );
    }

    static branchResolutionFailed(worktreePath: string): GraftError {
        return new GraftError(
            'branchResolutionFailed',
            `couldn't resolve the branch of ${worktreePath}`,
            { worktreePath }
        );
    }

    static stashPopConflict(stashRef: string, underlying: string): GraftError {
        return new GraftError(
            'stashPopConflict',
            `couldn't restore the parent's stashed changes (stash ${stashRef}): ${underlying}`,
            { stashRef, underlying }
        );
    }

    static unknown(error: unknown): GraftError {
        if (error instanceof GraftError) return error;
        return new GraftError('unknown', errorText(error));
    }
}

export function isGraftError(value: unknown): value is GraftError {
    return value instanceof GraftError;
}

/** The `error_kind` wire field: a non-graft failure is honestly `unknown`. */
export function graftErrorKind(error: unknown): GraftErrorKind {
    return isGraftError(error) ? error.kind : 'unknown';
}

/** Human text for any thrown value, preferring git's stderr (which `Error.message` carries). */
export function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}

/**
 * §4.6: `read-tree` refusing to clobber an untracked parent file is the one failure the user
 * can act on directly (remove or commit that file), so it gets its own prefix and keeps only
 * the first stderr line — the path is what matters.
 */
export function describeSyncError(error: unknown): string {
    if (isGitCommandError(error) && error.stderr.trim() !== '') {
        const stderr = error.stderr.trim();
        if (stderr.includes('Untracked working tree file')) {
            const firstLine = stderr.split('\n')[0]?.trim() ?? stderr;
            return `Sync blocked - ${firstLine}`;
        }
        return `Sync failed: ${stderr}`;
    }
    return `Sync failed: ${errorText(error)}`;
}
