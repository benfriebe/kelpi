/**
 * The group repository sheet (app-state-core.md §5.5, shell-ui.md §10.7): a group's default
 * repository and its "new workspaces create a worktree from latest main" switch, raised by the
 * group context menu's Add Repository… / Edit Repository….
 *
 * It replaced a Repository ▸ submenu that listed the whole registry, which does not scale. The
 * list here is the shared `RepoPicker` (single mode, embedded), so the filter rule (name or path,
 * case-insensitive, Settings ▸ Repositories' own) and the rows (name over a middle-truncated path,
 * arrow keys, Return, double-click) are the ones the New Workspace sheet and the inspector use.
 *
 * Nothing is sent until Save: one `group-set-repo`, carrying `repo_id` for a registry row (taken
 * as is), a path for a folder Choose Folder… returned (the daemon resolves and registers it), or
 * `clear` for Remove Repository. Cancel, Escape and the backdrop discard. The switch can only be
 * on alongside a repository, the reducer's own invariant, so it is disabled without one and never
 * sent with a clear.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';

import { useModalPresence } from './modal-presence';
import { RepoPicker, type RepoPickerEntry } from './RepoPicker';
import { middleTruncate, withAlpha } from './theme';
import { tokens } from './tokens';
import type { ChromeGroup, ChromeRepo, GroupRepoChange } from './types';

/** What the sheet will save: a registry row, a chosen folder, or no repository. */
export type GroupRepoChoice =
    | { readonly kind: 'repo'; readonly repoID: string }
    | { readonly kind: 'folder'; readonly path: string }
    | { readonly kind: 'none' };

/**
 * The rows the sheet lists: auto-discovered repos are hidden (as Settings ▸ Repositories hides
 * them) unless asked for, or unless one is the group's CURRENT repo, which must always be
 * visible to be seen selected.
 */
export function groupRepoSheetRows(
    repos: readonly ChromeRepo[],
    currentRepoID: string | null,
    showAutoDetected: boolean
): readonly ChromeRepo[] {
    if (showAutoDetected) return repos;
    return repos.filter((repo) => repo.isAutoDiscovered !== true || repo.id === currentRepoID);
}

/**
 * The one `group-set-repo` a Save sends, or null when there is nothing to save (no repository
 * chosen for a group that has none). The switch rides only with a repository.
 */
export function groupRepoSaveChange(
    choice: GroupRepoChoice,
    createWorktree: boolean,
    hadRepo: boolean
): GroupRepoChange | null {
    if (choice.kind === 'repo') return { repoID: choice.repoID, createWorktree };
    if (choice.kind === 'folder') return { repoPath: choice.path, createWorktree };
    return hadRepo ? { repoPath: null } : null;
}

export interface GroupRepoSheetProps {
    readonly group: ChromeGroup;
    readonly repos: readonly ChromeRepo[];
    /** #283's native folder panel, desktop app only; absent hides Choose Folder…. */
    readonly onBrowseForFolder?: (() => Promise<string | null>) | undefined;
    readonly onSave: (change: GroupRepoChange) => void;
    readonly onCancel: () => void;
    /** Test seam: where the portal mounts (defaults to `document.body`). */
    readonly container?: Element | undefined;
}

const FOLDER_PATH_MAX_CHARS = 44;

export function GroupRepoSheet(props: GroupRepoSheetProps): ReactElement | null {
    const currentRepoID = props.group.repoID ?? null;
    const hadRepo = currentRepoID !== null;
    const [choice, setChoice] = useState<GroupRepoChoice>(
        currentRepoID === null ? { kind: 'none' } : { kind: 'repo', repoID: currentRepoID }
    );
    const [createWorktree, setCreateWorktree] = useState(props.group.createWorktree === true);
    const [showAuto, setShowAuto] = useState(false);
    /** Bumped when the choice leaves the list (a folder, or none), so the picker drops its row. */
    const [pickerEpoch, setPickerEpoch] = useState(0);
    const saved = useRef(false);
    const browsing = useRef(false);
    // §N26: a sheet, so the whole-window park, like its sibling sheets.
    useModalPresence();

    const cancelRef = useRef(props.onCancel);
    cancelRef.current = props.onCancel;
    // Escape discards, whatever holds focus: capture phase on the window, as the other sheets do,
    // so no pane's own key handling can swallow the way out.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            cancelRef.current();
        };
        globalThis.window?.addEventListener('keydown', onKeyDown, true);
        return () => globalThis.window?.removeEventListener('keydown', onKeyDown, true);
    }, []);
    // Focus goes back where it was when the sheet closes, if that element is still there.
    useEffect(() => {
        const before = globalThis.document?.activeElement;
        return () => {
            if (before instanceof HTMLElement && before.isConnected) before.focus();
        };
    }, []);

    const rows = groupRepoSheetRows(props.repos, currentRepoID, showAuto);
    const hiddenAuto = props.repos.length - groupRepoSheetRows(props.repos, currentRepoID, false).length;
    const hasRepo = choice.kind !== 'none';
    const change = groupRepoSaveChange(choice, hasRepo && createWorktree, hadRepo);
    const canSave = change !== null;
    const title = hadRepo ? `Edit Repository for ${props.group.name}` : `Add Repository to ${props.group.name}`;

    const save = (next: GroupRepoChoice = choice): void => {
        if (saved.current) return;
        const outgoing = groupRepoSaveChange(next, next.kind !== 'none' && createWorktree, hadRepo);
        if (outgoing === null) return;
        saved.current = true;
        props.onSave(outgoing);
    };
    const chooseFolder = (): void => {
        const browse = props.onBrowseForFolder;
        // One panel at a time: a fast double-click must not queue a second native panel.
        if (browse === undefined || browsing.current) return;
        browsing.current = true;
        void browse()
            .then((chosen) => {
                if (chosen === null) return;
                setChoice({ kind: 'folder', path: chosen });
                setPickerEpoch((epoch) => epoch + 1);
            })
            .catch(() => {
                // A panel that failed to open is the same answer as a cancel.
            })
            .finally(() => {
                browsing.current = false;
            });
    };

    /*
     * The picker re-notifies whenever this callback's identity changes, so it is stable, and it
     * keeps the SAME choice object when the row is the one already chosen: a fresh object per
     * notification would re-render, re-notify and loop.
     */
    const onSelectionChange = useCallback((picked: readonly RepoPickerEntry[]) => {
        // An empty selection is the filter hiding the row, not a choice.
        const first = picked[0];
        if (first === undefined) return;
        setChoice((current) =>
            current.kind === 'repo' && current.repoID === first.id ? current : { kind: 'repo', repoID: first.id }
        );
    }, []);

    const container = props.container ?? globalThis.document?.body;
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid="group-repo-backdrop"
            className="fixed inset-0 z-50 flex items-start justify-center"
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) props.onCancel();
            }}
        >
            <div
                data-testid="group-repo-sheet"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="mt-[12vh] flex max-h-[76vh] w-[380px] flex-col gap-3 overflow-y-auto rounded-lg p-5 text-[12px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
                onKeyDown={(event) => {
                    // Return saves from anywhere but a button (which Return activates) and the
                    // picker's own search and list, which confirm the row they have selected.
                    if (event.key !== 'Enter' || event.defaultPrevented) return;
                    if (event.target instanceof HTMLButtonElement) return;
                    event.preventDefault();
                    save();
                }}
            >
                <div data-testid="group-repo-title" className="text-[13px] font-semibold">
                    {title}
                </div>
                <div className="text-[11px]" style={{ color: tokens.textSecondary }}>
                    New workspaces in this group start with this repository associated.
                </div>

                <RepoPicker
                    key={pickerEpoch}
                    repos={rows}
                    mode="single"
                    hideFooter
                    searchPlaceholder="Filter by name or path"
                    initialSelectedIDs={choice.kind === 'repo' ? [choice.repoID] : []}
                    emptyRegistryHint={
                        props.onBrowseForFolder === undefined
                            ? 'Add repositories in Settings ▸ Repositories, and they will be offered here.'
                            : 'Choose Folder… below picks a repository folder, or add some in Settings ▸ Repositories.'
                    }
                    onSelectionChange={onSelectionChange}
                    onConfirm={(picked) => {
                        const first = picked[0];
                        if (first === undefined) return;
                        const next: GroupRepoChoice = { kind: 'repo', repoID: first.id };
                        setChoice(next);
                        save(next);
                    }}
                    onCancel={props.onCancel}
                />

                {hiddenAuto > 0 || showAuto ? (
                    <label
                        className="flex cursor-pointer items-center gap-1.5 text-[11px]"
                        style={{ color: tokens.textSecondary }}
                    >
                        <input
                            type="checkbox"
                            data-testid="group-repo-show-auto"
                            checked={showAuto}
                            onChange={(event) => {
                                setShowAuto(event.target.checked);
                            }}
                        />
                        Show auto-detected
                    </label>
                ) : null}

                {choice.kind === 'folder' ? (
                    <div
                        data-testid="group-repo-folder"
                        title={choice.path}
                        className="truncate rounded px-2 py-1 text-[11px]"
                        style={{ background: withAlpha(tokens.accent, 0.25) }}
                    >
                        Folder: {middleTruncate(choice.path, FOLDER_PATH_MAX_CHARS)}
                    </div>
                ) : null}
                {choice.kind === 'none' && hadRepo ? (
                    <div data-testid="group-repo-none" className="text-[11px]" style={{ color: tokens.textSecondary }}>
                        No repository: new workspaces in this group start without one.
                    </div>
                ) : null}

                <div className="flex items-center gap-3">
                    {props.onBrowseForFolder === undefined ? null : (
                        <button
                            type="button"
                            data-testid="group-repo-browse"
                            className="text-[11px]"
                            style={{ color: tokens.accent }}
                            onClick={chooseFolder}
                        >
                            Choose Folder…
                        </button>
                    )}
                    {hadRepo ? (
                        <button
                            type="button"
                            data-testid="group-repo-remove"
                            className="text-[11px]"
                            style={{ color: tokens.accent }}
                            onClick={() => {
                                setChoice({ kind: 'none' });
                                setPickerEpoch((epoch) => epoch + 1);
                            }}
                        >
                            Remove Repository
                        </button>
                    ) : null}
                </div>

                <label
                    className="flex items-center gap-1.5 text-[11px]"
                    style={{ color: hasRepo ? tokens.textSecondary : tokens.textTertiary, cursor: hasRepo ? 'pointer' : 'default' }}
                >
                    <input
                        type="checkbox"
                        data-testid="group-repo-create-worktree"
                        disabled={!hasRepo}
                        checked={hasRepo && createWorktree}
                        onChange={(event) => {
                            setCreateWorktree(event.target.checked);
                        }}
                    />
                    New workspaces create a worktree from latest main
                </label>

                <div className="mt-1 flex items-center">
                    <button
                        type="button"
                        data-testid="group-repo-cancel"
                        className="rounded border px-2.5 py-1 text-[12px]"
                        style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                        onClick={props.onCancel}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        data-testid="group-repo-save"
                        data-default-action="true"
                        disabled={!canSave}
                        className="ml-auto rounded border px-2.5 py-1 text-[12px] font-medium"
                        style={{
                            background: canSave ? tokens.accent : withAlpha(tokens.textPrimary, 0.08),
                            borderColor: canSave ? tokens.accent : 'transparent',
                            color: canSave ? '#fff' : tokens.textTertiary
                        }}
                        onClick={() => {
                            save();
                        }}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>,
        container
    );
}
