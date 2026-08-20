/**
 * The worktree-name sanitizer, client side — the live preview behind the "Create git worktree"
 * section and the Create Worktree sheet (WS-078, WS-147, GIT-099).
 *
 * It is a **transcription** of the daemon's `git/names.ts` `sanitizedGitName`, not an import:
 * that module reaches for `node:path`, which has no place in a browser bundle. The rule it
 * copies is exact and `worktree.test.ts` pins it against the same corpus the daemon's own spec
 * uses, because the whole point of the preview is that what the user reads is what git gets —
 * a preview that disagreed with the daemon would be worse than none (issue #218).
 *
 * The BASE path is deliberately not computed here. `~` and `<repo>` expand against the DAEMON
 * host's home directory, which the client mirror does not carry (it is stripped on purpose), so
 * the resolved base arrives per repo from `repo-registry` and is only joined here.
 */

/** Safe as BOTH a path component and a git ref. `null` = nothing usable survived. */
export function sanitizeGitName(name: string): string | null {
    let slug = name.replace(/[^A-Za-z0-9/._-]+/g, '-');
    slug = slug.replace(/-{2,}/g, '-');
    slug = slug.replace(/\/{2,}/g, '/');
    slug = slug.replace(/\.{2,}/g, '.');
    slug = slug.replace(/^[-/._ ]+/, '').replace(/[-/._ ]+$/, '');
    return slug === '' ? null : slug;
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
