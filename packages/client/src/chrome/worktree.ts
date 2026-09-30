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

import type {
    WorktreeCreateProgress,
    WorktreeCreateStep,
    WorktreeCreateStepID,
    WorktreeCreateStepStatus
} from './types';

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

// ── #294: a worktree create's steps ───────────────────────────────────────────────────────

const STEP_IDS: readonly WorktreeCreateStepID[] = ['resolve-default-branch', 'fetch', 'worktree-add', 'create-workspace'];
const STEP_STATUSES: readonly WorktreeCreateStepStatus[] = ['pending', 'running', 'done', 'skipped', 'failed'];

/** What each step is called in the sheet's checklist (graft-git.md §8.5.1). */
export const WORKTREE_STEP_LABELS: Readonly<Record<WorktreeCreateStepID, string>> = {
    'resolve-default-branch': 'Find the default branch',
    fetch: 'Fetch the latest main',
    'worktree-add': 'Create the worktree',
    'create-workspace': 'Open the workspace'
};

/**
 * The checklist the sheet shows the moment Create is pressed, before the daemon's first frame:
 * the steps this create will run, the first one running. Without update main there is nothing
 * to resolve or fetch, exactly the daemon's `worktreeStepsFor`.
 */
export function initialWorktreeProgress(updateMain: boolean): WorktreeCreateProgress {
    const ids: readonly WorktreeCreateStepID[] = updateMain ? STEP_IDS : ['worktree-add', 'create-workspace'];
    return {
        steps: ids.map((id, index) => ({ id, status: index === 0 ? 'running' : 'pending' })),
        cancelled: false,
        detailed: true
    };
}

/**
 * A `command-progress` payload → the sheet's model, or null when it is not a worktree create's
 * (a frame from a newer daemon the client does not understand is ignored, never half-read).
 * Unknown step ids and statuses are dropped row by row for the same reason.
 */
export function parseWorktreeProgress(raw: unknown): WorktreeCreateProgress | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    if (record['kind'] !== 'worktree-create' || !Array.isArray(record['steps'])) return null;
    const steps: WorktreeCreateStep[] = [];
    for (const entry of record['steps'] as unknown[]) {
        if (typeof entry !== 'object' || entry === null) continue;
        const step = entry as Record<string, unknown>;
        const id = step['id'];
        const status = step['status'];
        if (typeof id !== 'string' || !(STEP_IDS as readonly string[]).includes(id)) continue;
        if (typeof status !== 'string' || !(STEP_STATUSES as readonly string[]).includes(status)) continue;
        const text = (key: string): string | undefined => {
            const value = step[key];
            return typeof value === 'string' && value !== '' ? value : undefined;
        };
        const percent = step['percent'];
        const detail = text('detail');
        const phase = text('phase');
        const error = text('error');
        steps.push({
            id: id as WorktreeCreateStepID,
            status: status as WorktreeCreateStepStatus,
            ...(detail !== undefined ? { detail } : {}),
            ...(phase !== undefined ? { phase } : {}),
            ...(typeof percent === 'number' && Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, percent)) } : {}),
            ...(error !== undefined ? { error } : {})
        });
    }
    return { steps, cancelled: record['cancelled'] === true, detailed: record['detailed'] !== false };
}

/** `3.4 s` under ten seconds, `12 s` after, `1:05` past a minute: the sheet's elapsed clock. */
export function formatElapsed(ms: number): string {
    const safe = Math.max(0, ms);
    if (safe < 10_000) return `${(safe / 1000).toFixed(1)} s`;
    const total = Math.floor(safe / 1000);
    if (total < 60) return `${String(total)} s`;
    return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}
