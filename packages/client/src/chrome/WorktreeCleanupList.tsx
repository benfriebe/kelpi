/**
 * The delete dialogs' "Also remove worktrees" list (graft-git.md §8.7, shell-ui.md §12.6).
 *
 * The daemon plans what a delete could take with it (`worktree-cleanup-preview`); this renders
 * that plan as a checklist. What it offers and why is the daemon's answer, not this file's:
 *
 *   - the clean worktrees Kelpi created start ticked; any other linked worktree (one an agent
 *     made under `.claude/worktrees`, say) is offered unticked;
 *   - one whose ONLY problem is uncommitted changes (`forceable`) is offered unticked with the
 *     count, and ticking it says, in the destructive colour, that those changes will be lost:
 *     the delete then names it in `force_worktree_paths`;
 *   - any other blocked one (another workspace uses it, another worktree is inside it, a
 *     detached HEAD holds commits no branch has) is dimmed, cannot be ticked, and says why.
 *
 * The delete plans again when it runs, so a list that went stale while the dialog was up
 * cannot remove more than is safe. Main checkouts never appear: the plan leaves them out, so a
 * workspace that only works in one gets no list at all.
 *
 * Each row leads with the worktree's folder name (what the user named it) and its branch when
 * that differs; the location underneath is middle-truncated, with the full path on hover.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';

import { ChromeIcon } from './icons';
import { DESTRUCTIVE_COLOR } from './QuitConfirmDialog';
import { homeAbbreviated, middleTruncate } from './theme';
import { tokens } from './tokens';

export interface WorktreeCleanupBlock {
    readonly kind: string;
    /** The daemon's words, shown as they are (`has 2 uncommitted changes`). */
    readonly reason: string;
}

/** One linked worktree a delete could remove (the preview's `worktrees[]` entry). */
export interface WorktreeCleanupCandidate {
    readonly worktreePath: string;
    readonly repoPath: string;
    /** Null = detached HEAD. */
    readonly branch: string | null;
    /** Directly inside the worktree base path: Kelpi made it. */
    readonly managed: boolean;
    /** Modified plus untracked files; null = unknown. */
    readonly changedFiles: number | null;
    readonly commitsOnlyHere: number | null;
    readonly blocked: WorktreeCleanupBlock | null;
    /** Blocked only by uncommitted changes, which the user may choose to lose. */
    readonly forceable: boolean;
    /** Ticked by default. */
    readonly recommended: boolean;
    readonly branchDeletable: boolean;
}

/**
 * What the user chose: the worktrees to remove, and whether their branches go too. A chosen
 * candidate that is `blocked` is necessarily `forceable`: its uncommitted changes go with it.
 */
export interface WorktreeCleanupChoice {
    readonly candidates: readonly WorktreeCleanupCandidate[];
    readonly deleteBranches: boolean;
}

/** What a dialog is about to delete: workspaces, or a group with every workspace in it. */
export type WorktreeCleanupTarget =
    | { readonly workspaceIDs: readonly string[] }
    | { readonly groupID: string };

/** Where a dialog gets its list from, and where "Remember my choice" goes. */
export interface WorktreeCleanupSource {
    /**
     * The plan for deleting the target, or null when there is nothing to ask: the setting is
     * not `ask`, or none of its workspaces has a row that could be a linked worktree.
     */
    preview(target: WorktreeCleanupTarget): Promise<readonly WorktreeCleanupCandidate[]> | null;
    /**
     * With the setting on `remove` there is no list, so the dialog says what will happen
     * instead; null when nothing will.
     */
    automaticNote?(target: WorktreeCleanupTarget): string | null;
    /** `workspace-delete-branches`: the branch checkbox's starting state. */
    readonly deleteBranchesDefault: boolean;
    /** The daemon's home, for `~/…` paths. */
    readonly home?: string | undefined;
    /** "Remember my choice": remove from now on (something was ticked) or keep, and branches. */
    remember(choice: { readonly removeWorktrees: boolean; readonly deleteBranches: boolean }): void;
}

export type WorktreeCleanupStatus =
    | { readonly kind: 'none'; readonly note: string | null }
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly message: string }
    | { readonly kind: 'ready'; readonly candidates: readonly WorktreeCleanupCandidate[] };

export interface WorktreeCleanupState {
    readonly status: WorktreeCleanupStatus;
    readonly selected: ReadonlySet<string>;
    toggle(worktreePath: string, checked: boolean): void;
    readonly deleteBranches: boolean;
    setDeleteBranches(value: boolean): void;
    readonly remember: boolean;
    setRemember(value: boolean): void;
    readonly home: string | undefined;
    /**
     * The choice to hand the delete, applying "Remember my choice" on the way out. Undefined
     * when there was nothing to ask, which leaves it to the setting (`remove` still removes);
     * null when the list never arrived (loading, or the preview failed): the delete then keeps
     * every worktree, since nobody chose any.
     */
    confirm(): WorktreeCleanupChoice | null | undefined;
}

function targetKey(target: WorktreeCleanupTarget): string {
    return 'groupID' in target ? `group:${target.groupID}` : `workspaces:${target.workspaceIDs.join(',')}`;
}

/** Can the user tick it at all? */
export function isSelectable(candidate: WorktreeCleanupCandidate): boolean {
    return candidate.blocked === null || candidate.forceable;
}

/** Does the dialog have a list to show (or one on its way)? It is wider while it does. */
export function hasWorktreeList(state: WorktreeCleanupState): boolean {
    return state.status.kind === 'loading' || (state.status.kind === 'ready' && state.status.candidates.length > 0);
}

/**
 * Fetch the plan for `target` when the dialog opens and hold the user's ticks. `initial` skips
 * the fetch (⌘W already asked before deciding whether to raise its gate at all).
 */
export function useWorktreeCleanup(
    source: WorktreeCleanupSource | undefined,
    target: WorktreeCleanupTarget,
    initial?: readonly WorktreeCleanupCandidate[] | undefined
): WorktreeCleanupState {
    const key = targetKey(target);
    const [status, setStatus] = useState<WorktreeCleanupStatus>(() =>
        initial !== undefined ? { kind: 'ready', candidates: initial } : { kind: 'none', note: null }
    );
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => recommendedPaths(initial ?? []));
    const [deleteBranches, setDeleteBranches] = useState(source?.deleteBranchesDefault ?? true);
    const [remember, setRemember] = useState(false);

    useEffect(() => {
        if (initial !== undefined || source === undefined) return;
        const request = source.preview(target);
        if (request === null) {
            setStatus({ kind: 'none', note: source.automaticNote?.(target) ?? null });
            return;
        }
        let live = true;
        setStatus({ kind: 'loading' });
        request.then(
            (candidates) => {
                if (!live) return;
                setStatus({ kind: 'ready', candidates });
                setSelected(recommendedPaths(candidates));
            },
            (error: unknown) => {
                if (!live) return;
                setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
            }
        );
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `target`; `initial` is read once: a gate raised with a plan keeps it.
    }, [source, key]);

    const toggle = useCallback((worktreePath: string, checked: boolean): void => {
        setSelected((previous) => {
            const next = new Set(previous);
            if (checked) next.add(worktreePath);
            else next.delete(worktreePath);
            return next;
        });
    }, []);

    const confirm = (): WorktreeCleanupChoice | null | undefined => {
        if (status.kind === 'none') return undefined;
        if (status.kind !== 'ready' || status.candidates.length === 0) return null;
        const candidates = status.candidates.filter(
            (candidate) => isSelectable(candidate) && selected.has(candidate.worktreePath)
        );
        if (remember) source?.remember({ removeWorktrees: candidates.length > 0, deleteBranches });
        return { candidates, deleteBranches };
    };

    return {
        status,
        selected,
        toggle,
        deleteBranches,
        setDeleteBranches,
        remember,
        setRemember,
        home: source?.home,
        confirm
    };
}

function recommendedPaths(candidates: readonly WorktreeCleanupCandidate[]): ReadonlySet<string> {
    return new Set(candidates.filter((candidate) => candidate.recommended).map((candidate) => candidate.worktreePath));
}

function plural(count: number, one: string, many: string): string {
    return `${String(count)} ${count === 1 ? one : many}`;
}

function capitalized(text: string): string {
    return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

function baseName(worktreePath: string): string {
    const trimmed = worktreePath.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function parentDir(worktreePath: string): string {
    const trimmed = worktreePath.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/** The line under a row's location: what the user should weigh, in its colour; null = none. */
function rowStatus(
    candidate: WorktreeCleanupCandidate,
    selected: boolean,
    deleteBranches: boolean
): { readonly text: string; readonly color: string } | null {
    if (candidate.forceable) {
        const changes = plural(candidate.changedFiles ?? 0, 'uncommitted change', 'uncommitted changes');
        return selected
            ? { text: `${capitalized(changes)} will be lost`, color: DESTRUCTIVE_COLOR }
            : { text: capitalized(changes), color: tokens.activeAgent };
    }
    if (candidate.blocked !== null) return { text: capitalized(candidate.blocked.reason), color: tokens.textSecondary };
    const notes: string[] = [];
    if (!candidate.managed) notes.push('Not created by Kelpi');
    if (candidate.branch !== null && candidate.commitsOnlyHere !== null && candidate.commitsOnlyHere > 0) {
        const commits = plural(candidate.commitsOnlyHere, 'unpushed commit', 'unpushed commits');
        notes.push(selected && deleteBranches ? `${commits}, branch kept` : commits);
    }
    return notes.length === 0 ? null : { text: notes.join(' · '), color: tokens.textTertiary };
}

export interface WorktreeCleanupListProps {
    readonly state: WorktreeCleanupState;
    /** A line above the list, e.g. which of a group dialog's buttons the list applies to. */
    readonly note?: string | undefined;
}

/** The checklist itself. Renders nothing when there is nothing to choose. */
export function WorktreeCleanupList(props: WorktreeCleanupListProps): ReactElement | null {
    const { state } = props;
    const { status } = state;
    const anySelectedBranch = useMemo(
        () =>
            status.kind === 'ready' &&
            status.candidates.some(
                (candidate) => isSelectable(candidate) && candidate.branch !== null && state.selected.has(candidate.worktreePath)
            ),
        [status, state.selected]
    );
    if (status.kind === 'none') {
        return status.note === null ? null : (
            <div data-testid="worktree-cleanup-note" className="mb-3 text-[11px]" style={{ color: tokens.textSecondary }}>
                {status.note}
            </div>
        );
    }
    if (status.kind === 'loading') {
        return (
            <div data-testid="worktree-cleanup-loading" className="mb-3 text-[11px]" style={{ color: tokens.textTertiary }}>
                Checking worktrees…
            </div>
        );
    }
    if (status.kind === 'error') {
        return (
            <div data-testid="worktree-cleanup-error" className="mb-3 text-[11px]" style={{ color: tokens.textTertiary }}>
                {`Could not check worktrees (${status.message}); they will be kept.`}
            </div>
        );
    }
    if (status.candidates.length === 0) return null;
    const home = state.home ?? '';
    const branchRows = status.candidates.filter((candidate) => isSelectable(candidate) && candidate.branch !== null).length;
    const anyBranch = branchRows > 0;
    return (
        <div data-testid="worktree-cleanup" className="mb-3 text-[11px]">
            <div className="mb-1.5 text-[12px] font-medium" style={{ color: tokens.textPrimary }}>
                {status.candidates.length === 1 ? 'Also remove its worktree' : 'Also remove worktrees'}
            </div>
            {props.note === undefined ? null : (
                <div className="mb-1.5" style={{ color: tokens.textSecondary }}>
                    {props.note}
                </div>
            )}
            <div
                data-testid="worktree-cleanup-rows"
                className="max-h-[260px] overflow-y-auto rounded-md"
                style={{ border: `1px solid ${tokens.divider}`, background: 'rgba(255,255,255,0.025)' }}
            >
                {status.candidates.map((candidate, index) => {
                    const selectable = isSelectable(candidate);
                    const checked = selectable && state.selected.has(candidate.worktreePath);
                    const name = baseName(candidate.worktreePath);
                    const where = homeAbbreviated(parentDir(candidate.worktreePath), home);
                    const fullPath = homeAbbreviated(candidate.worktreePath, home);
                    const line = rowStatus(candidate, checked, state.deleteBranches);
                    const branch = candidate.branch ?? 'detached HEAD';
                    return (
                        <label
                            key={candidate.worktreePath}
                            data-testid="worktree-cleanup-row"
                            data-path={candidate.worktreePath}
                            data-blocked={candidate.blocked?.kind}
                            title={fullPath}
                            className="flex items-start gap-2.5 px-2.5 py-[7px]"
                            style={{
                                borderTop: index === 0 ? 'none' : `1px solid ${tokens.divider}`,
                                opacity: selectable ? 1 : 0.55,
                                cursor: selectable ? 'pointer' : 'default'
                            }}
                        >
                            <input
                                type="checkbox"
                                className="mt-[2px] shrink-0"
                                data-testid="worktree-cleanup-check"
                                disabled={!selectable}
                                checked={checked}
                                onChange={(event) => state.toggle(candidate.worktreePath, event.target.checked)}
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
                                {/* One line: the name, where it lives (the first thing to give way
                                    when space runs out), and the branch when it is not the name. */}
                                <span className="flex min-w-0 items-baseline gap-2">
                                    <span
                                        data-testid="worktree-cleanup-name"
                                        className="max-w-[55%] shrink-0 truncate text-[12px] font-medium"
                                        style={{ color: tokens.textPrimary }}
                                    >
                                        {name}
                                    </span>
                                    <span
                                        data-testid="worktree-cleanup-where"
                                        className="min-w-0 flex-1 truncate"
                                        style={{ color: tokens.textTertiary }}
                                    >
                                        {middleTruncate(where, 40)}
                                    </span>
                                    {branch === name ? null : (
                                        <span
                                            data-testid="worktree-cleanup-branch"
                                            className="flex max-w-[40%] shrink-0 items-center gap-1 self-center"
                                            style={{ color: tokens.textTertiary }}
                                        >
                                            <span className="flex shrink-0 items-center">
                                                <ChromeIcon name="branch" size={10} />
                                            </span>
                                            <span className="truncate">{branch}</span>
                                        </span>
                                    )}
                                </span>
                                {line === null ? null : (
                                    <span data-testid="worktree-cleanup-status" style={{ color: line.color }}>
                                        {line.text}
                                    </span>
                                )}
                            </span>
                        </label>
                    );
                })}
            </div>
            {anyBranch ? (
                <label className="mt-2 flex items-center gap-2" style={{ color: tokens.textSecondary }}>
                    <input
                        type="checkbox"
                        data-testid="worktree-cleanup-branches"
                        disabled={!anySelectedBranch}
                        checked={state.deleteBranches}
                        onChange={(event) => state.setDeleteBranches(event.target.checked)}
                    />
                    {branchRows === 1 ? 'Also delete its branch if pushed or merged' : 'Also delete branches that are pushed or merged'}
                </label>
            ) : null}
            <div className="mt-1.5" style={{ color: tokens.textTertiary }}>
                Files git ignores, like .env, are deleted too.
            </div>
        </div>
    );
}

/**
 * "Remember my choice", drawn by the dialog where its own suppression box would go (beside the
 * buttons), so the list itself stays a list. Nothing when there is no list to remember.
 */
export function WorktreeCleanupRemember(props: { readonly state: WorktreeCleanupState; readonly className?: string | undefined }): ReactElement | null {
    const { state } = props;
    if (state.status.kind !== 'ready' || state.status.candidates.length === 0) return null;
    return (
        <label className={`flex items-center gap-2 text-[11px] ${props.className ?? ''}`} style={{ color: tokens.textSecondary }}>
            <input
                type="checkbox"
                data-testid="worktree-cleanup-remember"
                checked={state.remember}
                onChange={(event) => state.setRemember(event.target.checked)}
            />
            Remember my choice
        </label>
    );
}
