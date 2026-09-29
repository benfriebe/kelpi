/**
 * The worktree-name preview, client side: the live preview behind the "Create git worktree"
 * section and the Create Worktree sheet (WS-078, WS-147, GIT-099), and the New Workspace sheet's
 * worktree-name autofill (app-state-core.md §5.5).
 *
 * The sanitizer is the daemon's own `sanitizedGitName`, from `@kelpi/core/git`: it used to be a
 * transcription here (the daemon's module reaches for `node:path`), pinned by a copied corpus.
 * The whole point of the preview is that what the user reads is what git gets, so it is now the
 * same function rather than a copy of it (issue #218).
 *
 * The BASE path is deliberately not computed here. `~` and `<repo>` expand against the DAEMON
 * host's home directory, which the client mirror does not carry (it is stripped on purpose), so
 * the resolved base arrives per repo from `repo-registry` and is only joined here.
 */

import { sanitizedGitName } from '@kelpi/core/git';

/** Safe as BOTH a path component and a git ref. `null` = nothing usable survived. */
export const sanitizeGitName: (name: string) => string | null = sanitizedGitName;

/**
 * §5.5: the worktree name the New Workspace sheet fills in from the workspace name, until the user
 * types their own. Lowercased first (a branch reads as `fix-login-bug`, not `Fix-Login-Bug`), then
 * the daemon's own sanitizer, so the result is a fixed point of it: the daemon creates exactly
 * this folder and branch. `''` when nothing usable survives (only punctuation or emoji), so the
 * field is left empty rather than inventing a name.
 */
export function worktreeNameFromWorkspace(workspaceName: string): string {
    return sanitizedGitName(workspaceName.toLowerCase()) ?? '';
}

/** `<resolved base>/<sanitized name>`, with the daemon's trailing-separator normalization. */
export function worktreePreviewPath(base: string, folderName: string): string {
    const trimmed = base.endsWith('/') && base.length > 1 ? base.slice(0, -1) : base;
    return `${trimmed}/${folderName}`;
}

export interface WorktreeDraft {
    readonly name: string;
    readonly branch: string;
    /** Resolved base path for the chosen repo (`repo-registry`'s `worktree_base`). */
    readonly base: string;
}

export interface WorktreePreview {
    readonly sanitizedName: string | null;
    readonly sanitizedBranch: string | null;
    /** What the sheet prints: the real folder, or a `<name>` placeholder while it is unusable. */
    readonly path: string;
    readonly branchLine: string;
    /** Create stays disabled until BOTH names sanitize to something usable. */
    readonly valid: boolean;
}

export function worktreePreview(draft: WorktreeDraft): WorktreePreview {
    const sanitizedName = sanitizeGitName(draft.name);
    const sanitizedBranch = sanitizeGitName(draft.branch);
    return {
        sanitizedName,
        sanitizedBranch,
        path: worktreePreviewPath(draft.base, sanitizedName ?? '<name>'),
        branchLine: `branch: ${sanitizedBranch ?? '<branch>'}`,
        valid: sanitizedName !== null && sanitizedBranch !== null
    };
}
