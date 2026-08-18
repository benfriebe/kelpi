/**
 * Graft's data model (graft-git.md §2). Timestamps are epoch **milliseconds** (JS-native);
 * the wire layer formats them as second-precision ISO 8601.
 */

export type GraftSessionStatus =
    | { readonly kind: 'starting' }
    | { readonly kind: 'watching' }
    | { readonly kind: 'syncing' }
    | { readonly kind: 'error'; readonly message: string };

/** The slice of a store `RepoAssociation` the engine needs (id doubles as the session id). */
export interface GraftAssociation {
    readonly id: string;
    readonly worktreePath: string;
    readonly branchName: string | null;
}

export interface GraftSession {
    /** == the association id. The engine enforces uniqueness on the ROOT, not on this. */
    readonly id: string;
    readonly worktreePath: string;
    /** Canonicalized (symlinks resolved) — every claim/match compares this form. */
    readonly parentRepoRoot: string;
    /** The worktree's branch at start; the literal `"HEAD"` when detached. */
    readonly branch: string;
    readonly status: GraftSessionStatus;
    /** SHA of the auto-stash taken in the PARENT at start. */
    readonly stashRef: string | null;
    /** Epoch ms of the last successful sync pass. */
    readonly lastSyncAt: number | null;
    readonly preGraftBranch: string | null;
    readonly preGraftSha: string | null;
    /** Always null for sessions this design creates; set only by legacy breadcrumbs. */
    readonly worktreePreGraftSha: string | null;
}

export interface GraftOrphan {
    /** The breadcrumb's `assocId` when it parses as a UUID, else a freshly minted one. */
    readonly id: string;
    readonly parentRepoRoot: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly stashRef: string | null;
    readonly preGraftBranch: string | null;
    readonly preGraftSha: string | null;
    readonly worktreePreGraftSha: string | null;
}

export type GraftSessionEvent =
    | { readonly kind: 'started'; readonly session: GraftSession }
    | { readonly kind: 'updated'; readonly session: GraftSession }
    | { readonly kind: 'stopped'; readonly id: string };
