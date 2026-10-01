/**
 * Worktree cleanup on workspace delete, the window's half (graft-git.md §8.7): reading the
 * daemon's plan and results, and deciding which delete request carries which worktree.
 *
 *   - `worktree-cleanup-preview` answers the plan the delete dialog renders
 *     (`parseWorktreeCleanupPreview`);
 *   - `mayHaveLinkedWorktrees` is the cheap test that decides whether to ask at all, from the
 *     mirror alone, so a workspace that only works in a main checkout never waits on git;
 *   - `worktreeCleanupToasts` turns each delete's `worktrees` reply into what the user sees.
 */

import type { DaemonState } from '@kelpi/daemon/store';

import { homeAbbreviated } from '../chrome/theme';
import type { WorktreeCleanupCandidate, WorktreeCleanupSource, WorktreeCleanupTarget } from '../chrome/WorktreeCleanupList';
import { replyError, type CommandReply } from '../connection';
import type { KelpiStoreApi } from '../state';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The preview reply's `worktrees[]`; null for a failed or malformed reply. */
export function parseWorktreeCleanupPreview(reply: CommandReply): WorktreeCleanupCandidate[] | null {
    if (reply['ok'] !== true || !Array.isArray(reply['worktrees'])) return null;
    const candidates: WorktreeCleanupCandidate[] = [];
    for (const entry of reply['worktrees']) {
        if (!isRecord(entry)) continue;
        const worktreePath = text(entry['worktree_path']);
        const repoPath = text(entry['repo_path']);
        if (worktreePath === null || repoPath === null) continue;
        const blocked = isRecord(entry['blocked'])
            ? { kind: text(entry['blocked']['kind']) ?? 'unknown', reason: text(entry['blocked']['reason']) ?? 'kept' }
            : null;
        candidates.push({
            worktreePath,
            repoPath,
            branch: text(entry['branch']),
            managed: entry['managed'] === true,
            changedFiles: count(entry['changed_files']),
            commitsOnlyHere: count(entry['commits_only_here']),
            blocked,
            // Only uncommitted changes in the way, and the daemon can force it.
            forceable: blocked !== null && blocked.kind === 'dirty' && entry['forceable'] === true,
            // Never tick what the plan blocked, whatever else the reply says.
            recommended: blocked === null && entry['recommended'] === true,
            branchDeletable: entry['branch_deletable'] === true
        });
    }
    return candidates;
}

/**
 * Could any of these workspaces' rows be a linked worktree? A row whose path IS its repo's
 * registered path is a main checkout, and a workspace with only those gets no list and no git
 * round trip. Anything else (including a row whose repo left the registry) is worth asking the
 * daemon about: it answers from git, not from this mirror.
 */
export function mayHaveLinkedWorktrees(state: DaemonState, workspaceIDs: readonly string[]): boolean {
    const wanted = new Set(workspaceIDs);
    const repoPaths = new Map(state.repos.map((repo) => [repo.id, trimSlash(repo.path)]));
    return state.workspaces.some(
        (workspace) =>
            wanted.has(workspace.id) &&
            workspace.repoAssociations.some(
                (association) => repoPaths.get(association.repoID) !== trimSlash(association.worktreePath)
            )
    );
}

function trimSlash(value: string): string {
    return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

export interface WorktreeCleanupToast {
    readonly title: string;
    readonly body: string;
    /** Something was kept that the user asked to remove: stays up until dismissed. */
    readonly sticky: boolean;
}

/**
 * What a delete's `worktrees` reply tells the user: one toast for what went (auto-dismissed)
 * and one for what stayed (sticky, since a kept worktree is still on disk and nothing in the
 * window points at it any more). None when the reply carries no worktree entries.
 */
export function worktreeCleanupToasts(reply: CommandReply, home: string): WorktreeCleanupToast[] {
    const entries = Array.isArray(reply['worktrees']) ? reply['worktrees'].filter(isRecord) : [];
    const removed: string[] = [];
    const kept: string[] = [];
    for (const entry of entries) {
        const where = homeAbbreviated(text(entry['worktree_path']) ?? text(entry['association_id']) ?? '?', home);
        const branch = text(entry['branch']);
        if (entry['removed'] === true) {
            const discarded = count(entry['discarded_changes']);
            const extras = [
                ...(entry['branch_deleted'] === true && branch !== null ? [`branch ${branch}`] : []),
                ...(discarded !== null && discarded > 0 ? [`${String(discarded)} uncommitted ${discarded === 1 ? 'change' : 'changes'}`] : [])
            ];
            removed.push(extras.length === 0 ? where : `${where} (and ${extras.join(', ')})`);
            const branchError = text(entry['branch_error']);
            if (branchError !== null && branch !== null) kept.push(`branch ${branch}: ${branchError}`);
        } else {
            kept.push(`${where}: ${text(entry['error']) ?? 'not removed'}`);
        }
    }
    const toasts: WorktreeCleanupToast[] = [];
    if (removed.length > 0) {
        toasts.push({
            title: removed.length === 1 ? 'Removed worktree' : `Removed ${String(removed.length)} worktrees`,
            body: removed.join(', '),
            sticky: false
        });
    }
    if (kept.length > 0) {
        toasts.push({ title: 'Kept on disk', body: kept.join('; '), sticky: true });
    }
    return toasts;
}

export interface WorktreeCleanupSourceHost {
    readonly store: KelpiStoreApi;
    readonly preview: (workspaceIDs: readonly string[]) => Promise<CommandReply>;
    /** Writes `workspace-delete-worktrees` and `workspace-delete-branches`. */
    readonly remember: (choice: { readonly removeWorktrees: boolean; readonly deleteBranches: boolean }) => void;
}

/** The workspaces a target deletes: a group's are ALL its members, as the cascade's are. */
export function targetWorkspaceIDs(state: DaemonState, target: WorktreeCleanupTarget): readonly string[] {
    if ('groupID' in target) return state.groups.find((group) => group.id === target.groupID)?.childOrder ?? [];
    return target.workspaceIDs;
}

/**
 * The delete dialogs' source, reading the setting and the mirror at the moment a dialog opens,
 * so a Settings change reaches the very next delete.
 */
export function createWorktreeCleanupSource(host: WorktreeCleanupSourceHost): WorktreeCleanupSource {
    const general = () => host.store.getState().settings.value.general;
    return {
        preview(target) {
            const state = host.store.getState();
            if (general().workspaceDeleteWorktrees !== 'ask') return null;
            const workspaceIDs = targetWorkspaceIDs(state.daemon.state, target);
            if (!mayHaveLinkedWorktrees(state.daemon.state, workspaceIDs)) return null;
            return host.preview(workspaceIDs).then((reply) => {
                const candidates = parseWorktreeCleanupPreview(reply);
                if (candidates === null) throw new Error(replyError(reply));
                return candidates;
            });
        },
        automaticNote(target) {
            const state = host.store.getState();
            if (general().workspaceDeleteWorktrees !== 'remove') return null;
            if (!mayHaveLinkedWorktrees(state.daemon.state, targetWorkspaceIDs(state.daemon.state, target))) return null;
            return 'Clean worktrees Kelpi created are removed too (Settings ▸ Workspaces).';
        },
        get deleteBranchesDefault() {
            return general().workspaceDeleteBranches;
        },
        get home() {
            return host.store.getState().daemon.info?.home;
        },
        remember: host.remember
    };
}
