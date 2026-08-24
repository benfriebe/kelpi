/**
 * The trailing **workspace inspector** (workspaces-sidebar.md §WS-137…§WS-150).
 *
 * A fixed 280 px panel scoped to the ACTIVE workspace, opened from the top bar's button or the
 * `toggle_inspector` binding and closed from its own header. Three sections, in the shipped
 * app's order:
 *
 *   1. **Workspace** — colour bar + name (rename in place), pane count, the ten-colour row, the
 *      label chips, and the profile picker. The picker leads with the built-in `default` and
 *      keeps an assigned-but-missing profile selectable, so it never renders blank after a
 *      profile leaves the config (§WS-138).
 *   2. **Repositories** — associations grouped per repo in registration order, the main checkout
 *      first with its worktrees indented under it (§WS-139); each row carries a git-status dot
 *      (gray unknown / green clean / red dirty), a branch or repo label, dirty diff stats, and
 *      the two actions the shipped app has: open a diff pane for that path, and open a terminal
 *      there (Shift = split vertically) (§WS-140/§WS-141). Removal — plain, and "Remove & Delete
 *      Worktree" for a linked worktree — is on the row's menu (§WS-142).
 *   3. **Panes** — the workspace's panes by title/label, the focused one marked, and a close
 *      button only when more than one exists (§WS-149).
 *
 * Nothing here reads the store or a socket: state arrives as props and intent leaves as
 * callbacks, so the whole panel renders from a fixture. The two sheets (add a repository,
 * create a worktree) live at the bottom of this file for the same reason.
 *
 * Deliberate divergence, recorded rather than hidden: the shipped app disables the whole "Add"
 * menu when the repo registry is empty, because its registry is filled by a Scan Directory flow
 * this port does not have (PARITY ▸ Known gaps, repo registry UI). Disabling it here would make
 * an empty registry permanent, so "Add Repository…" stays live — it is the port's only way to
 * register one — while "New Worktree" is the item that dims, since it genuinely needs a repo.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ContextMenu, menuAnchorFromEvent, type MenuItemSpec } from './ContextMenu';
import { GraftOrphanBanner, GraftSwapDialog, GraftToggleButton } from './GraftControls';
import { ChromeIcon, iconGlyph, type ChromeIconName } from './icons';
import { useModalPresence } from './modal-presence';
import { RepoPicker, type RepoPickerEntry } from './RepoPicker';
import { resolveLabelStyle, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';
import {
    DEFAULT_PROFILE_NAME,
    WORKSPACE_COLORS,
    type ChromeLabelPreset,
    type ChromePane,
    type ChromeRepo,
    type ChromeWorkspace
} from './types';
import { worktreePreview } from './worktree';
import {
    graftTooltip,
    type GraftOrphanView,
    type GraftSessionView,
    type GraftSwapPrompt
} from '../state/graft';

export { DEFAULT_PROFILE_NAME } from './types';

export const INSPECTOR_WIDTH_PX = 280;

export interface InspectorGitStatus {
    readonly kind: 'unknown' | 'clean' | 'dirty';
    readonly changedFiles: number;
    readonly additions: number;
    readonly deletions: number;
}

/** One repo association, joined with its repo and its last known git status. */
export interface InspectorAssociation {
    readonly id: string;
    readonly repoID: string;
    readonly repoName: string;
    readonly repoPath: string | null;
    readonly worktreePath: string;
    /**
     * §APP-071 / §GIT-092 — `worktreePath` with symlinks resolved, computed daemon-side
     * (`ws/repos.ts` ▸ `serializeAssociation`). The status footer matches a pane's canonical
     * cwd against this; absent or `''` means "no canonical form", fall back to `worktreePath`.
     */
    readonly worktreePathReal?: string | undefined;
    readonly branch: string | null;
    /** False = this row IS the registered repo's main checkout. */
    readonly isWorktree: boolean;
    readonly status: InspectorGitStatus;
}

/** A registry entry, with the base path the daemon resolved for it (`types.ts`'s `ChromeRepo`). */
export type InspectorRepo = ChromeRepo;

export interface WorktreeRequest {
    readonly repoID: string;
    readonly name: string;
    readonly branch: string;
    readonly updateMain: boolean;
}

/** A failed mutation answers with the daemon's message; `null` = it worked. */
export type InspectorResult = Promise<string | null> | string | null | void;

export interface InspectorProps {
    /** `profileName` lives on `ChromeWorkspace` itself now that §WS-049's row menu reads it too. */
    readonly workspace: ChromeWorkspace;
    readonly focusedPaneID?: string | null | undefined;
    readonly associations?: readonly InspectorAssociation[] | undefined;
    readonly repos?: readonly InspectorRepo[] | undefined;
    /** Config-defined profile names; `default` is prepended here, never expected in this list. */
    readonly profiles?: readonly string[] | undefined;
    readonly labelPresets?: readonly ChromeLabelPreset[] | undefined;
    readonly bucket?: ChromeBucket | undefined;
    /** True while a `workspace-repo-status` read is in flight (the header shows it). */
    readonly refreshing?: boolean | undefined;
    readonly onClose?: (() => void) | undefined;
    readonly onRenameWorkspace?: ((name: string) => void) | undefined;
    readonly onSetWorkspaceColor?: ((color: (typeof WORKSPACE_COLORS)[number]) => void) | undefined;
    /** `null` = back to the built-in `default` baseline. */
    readonly onSetProfile?: ((profile: string | null) => void) | undefined;
    readonly onOpenDiff?: ((repoPath: string) => void) | undefined;
    /** Shift-click asks for a vertical split, matching the shipped tooltip. */
    readonly onOpenTerminal?: ((repoPath: string, options: { vertical: boolean }) => void) | undefined;
    readonly onRemoveAssociation?: ((associationID: string, deleteWorktree: boolean) => void) | undefined;
    readonly onAddAssociation?: ((path: string) => InspectorResult) | undefined;
    readonly onCreateWorktree?: ((request: WorktreeRequest) => InspectorResult) | undefined;
    readonly onFocusPane?: ((paneID: string) => void) | undefined;
    readonly onClosePane?: ((paneID: string) => void) | undefined;
    /**
     * Electron only: a native directory chooser. Absent (a browser) = the sheet is a text field,
     * which is the v1 the brief calls for and works everywhere.
     */
    readonly onBrowseForFolder?: (() => Promise<string | null>) | undefined;
    /**
     * `repo-scan` from inside the Add Repository picker (§GIT-066/§GIT-073): the daemon walks
     * the folder and registers what it finds, and the rows arrive with the next `repos` prop.
     * Absent = the picker offers no scan row, which is what it did before.
     */
    readonly onScanForRepos?: ((path: string) => void) | undefined;

    // ── graft (§GIT-046…§GIT-051, §WS-143…§WS-145) ────────────────────────────────
    //
    // The panel stays a pure view here too: the state machine is `state/graft.ts`, its effects
    // are `app/graft.ts`, and this is the surface that renders one and calls the other.

    /** Live sessions keyed by association id, including this client's optimistic placeholders. */
    readonly graftSessions?: Readonly<Record<string, GraftSessionView>> | undefined;
    /** Every known interrupted graft; the banner shows only those matching THIS workspace. */
    readonly graftOrphans?: readonly GraftOrphanView[] | undefined;
    readonly graftSwapPrompt?: GraftSwapPrompt | null | undefined;
    readonly onToggleGraft?: ((association: InspectorAssociation) => void) | undefined;
    readonly onConfirmGraftSwap?: ((prompt: GraftSwapPrompt) => void) | undefined;
    readonly onCancelGraftSwap?: (() => void) | undefined;
    readonly onRestoreGraftOrphan?: ((orphan: GraftOrphanView) => void) | undefined;
    readonly onDismissGraftOrphan?: ((orphan: GraftOrphanView) => void) | undefined;
    /** Test seam for the swap dialog's portal. */
    readonly dialogContainer?: HTMLElement | null | undefined;
}

// ── small parts ─────────────────────────────────────────────────────────────────────

/**
 * §WS-150: `.buttonStyle(.plain)` gives a SwiftUI button no affordance at all, so the shipped
 * app adds the hover background, the brightened glyph, the tooltip and the pointing-hand cursor
 * by hand. Same four things here, for the same reason.
 */
export function InspectorIconButton(props: {
    readonly icon: ChromeIconName;
    readonly tooltip: string;
    readonly testID?: string | undefined;
    readonly onClick: (event: React.MouseEvent) => void;
}): ReactElement {
    const [hover, setHover] = useState(false);
    return (
        <button
            type="button"
            aria-label={props.tooltip}
            title={props.tooltip}
            {...(props.testID === undefined ? {} : { 'data-testid': props.testID })}
            className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-[3px]"
            style={{
                color: hover ? tokens.textPrimary : tokens.textSecondary,
                background: hover ? tokens.selectionFill : 'transparent'
            }}
            onMouseEnter={() => {
                setHover(true);
            }}
            onMouseLeave={() => {
                setHover(false);
            }}
            onClick={(event) => {
                event.stopPropagation();
                props.onClick(event);
            }}
        >
            <ChromeIcon name={props.icon} />
        </button>
    );
}

function SectionLabel(props: { readonly icon: ChromeIconName; readonly text: string }): ReactElement {
    return (
        <div
            className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: tokens.textSecondary }}
        >
            <ChromeIcon name={props.icon} />
            {props.text}
        </div>
    );
}

const STATUS_DOT_COLORS: Readonly<Record<InspectorGitStatus['kind'], string>> = {
    unknown: '#8A8A92',
    clean: '#5FBE89',
    dirty: '#E0655C'
};

function statusTitle(status: InspectorGitStatus): string {
    if (status.kind === 'clean') return 'Clean working tree';
    if (status.kind === 'unknown') return 'Git status unknown';
    return `${String(status.changedFiles)} file${status.changedFiles === 1 ? '' : 's'} changed`;
}

function StatusDot({ status }: { readonly status: InspectorGitStatus }): ReactElement {
    return (
        <span
            data-testid="inspector-status-dot"
            data-status={status.kind}
            role="img"
            aria-label={statusTitle(status)}
            title={statusTitle(status)}
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: STATUS_DOT_COLORS[status.kind] }}
        />
    );
}

/** §WS-140's diff stats: file count, then `+adds` green and `-dels` red — dirty rows only. */
function DiffStats({ status }: { readonly status: InspectorGitStatus }): ReactElement | null {
    if (status.kind !== 'dirty') return null;
    return (
        <span data-testid="inspector-stats" className="flex items-center gap-1 font-mono text-[10px]">
            <span style={{ color: tokens.textSecondary }}>
                {status.changedFiles} file{status.changedFiles === 1 ? '' : 's'}
            </span>
            {status.additions > 0 ? <span style={{ color: '#5FBE89' }}>+{status.additions}</span> : null}
            {status.deletions > 0 ? <span style={{ color: '#E0655C' }}>-{status.deletions}</span> : null}
        </span>
    );
}

interface RepoGroup {
    readonly repoID: string;
    readonly repoName: string;
    readonly main: InspectorAssociation | null;
    readonly worktrees: readonly InspectorAssociation[];
}

/**
 * §WS-139: bucket by repo in **registration order** (first encounter wins the slot), then split
 * each bucket into the main checkout and its worktrees. A workspace that references only
 * worktrees has `main === null` and gets the non-interactive repo header instead.
 */
export function groupAssociations(associations: readonly InspectorAssociation[]): readonly RepoGroup[] {
    const order: string[] = [];
    const buckets = new Map<string, InspectorAssociation[]>();
    for (const association of associations) {
        const bucket = buckets.get(association.repoID);
        if (bucket === undefined) {
            order.push(association.repoID);
            buckets.set(association.repoID, [association]);
        } else bucket.push(association);
    }
    return order.map((repoID) => {
        const entries = buckets.get(repoID) ?? [];
        const main = entries.find((entry) => !entry.isWorktree) ?? null;
        return {
            repoID,
            repoName: entries[0]?.repoName ?? 'repo',
            main,
            worktrees: entries.filter((entry) => entry.id !== main?.id)
        };
    });
}

// ── the panel ───────────────────────────────────────────────────────────────────────

type SheetState =
    | { readonly kind: 'add-repo' }
    | { readonly kind: 'worktree'; readonly repoID: string }
    | { readonly kind: 'pick-repo' };

export function Inspector(props: InspectorProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const workspace = props.workspace;
    const associations = props.associations ?? EMPTY_ASSOCIATIONS;
    const repos = props.repos ?? EMPTY_REPOS;
    const presets = props.labelPresets ?? EMPTY_PRESETS;
    const panes = workspace.panes;

    const [renaming, setRenaming] = useState(false);
    const [sheet, setSheet] = useState<SheetState | null>(null);
    const [menu, setMenu] = useState<{ id: string; isWorktree: boolean; x: number; y: number } | null>(null);
    const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);

    const groups = useMemo(() => groupAssociations(associations), [associations]);

    /** Repos this workspace already points at: dimmed "Added" rows in the picker (§GIT-073). */
    const associatedRepoIDs = useMemo(
        () => new Set(associations.map((association) => association.repoID)),
        [associations]
    );

    const graftSessions = props.graftSessions ?? EMPTY_GRAFT_SESSIONS;
    /**
     * §GIT-051's scoping rule, verbatim: an orphan is shown only when its worktree path matches
     * an association of the workspace on screen.
     */
    const relevantOrphans = useMemo(() => {
        const paths = new Set(associations.map((association) => association.worktreePath));
        return (props.graftOrphans ?? EMPTY_GRAFT_ORPHANS).filter((orphan) => paths.has(orphan.worktreePath));
    }, [associations, props.graftOrphans]);

    /** §WS-138: `default` leads, then the config's profiles, then an assigned-but-missing name. */
    const profileOptions = useMemo(() => {
        const list = [DEFAULT_PROFILE_NAME, ...(props.profiles ?? []).filter((name) => name !== DEFAULT_PROFILE_NAME)];
        const assigned = workspace.profileName ?? null;
        if (assigned !== null && assigned !== '' && !list.includes(assigned)) list.push(assigned);
        return list;
    }, [props.profiles, workspace.profileName]);

    /** The repo "New Worktree" picks itself when there is exactly one candidate (§GIT-098). */
    const worktreeCandidate = (): string | null => {
        const workspaceRepoIDs = new Set(associations.map((association) => association.repoID));
        if (workspaceRepoIDs.size === 1) return [...workspaceRepoIDs][0] ?? null;
        if (repos.length === 1) return repos[0]?.id ?? null;
        return null;
    };

    const openWorktreeSheet = (): void => {
        const candidate = worktreeCandidate();
        setSheet(candidate === null ? { kind: 'pick-repo' } : { kind: 'worktree', repoID: candidate });
    };

    const sheetRepo = sheet?.kind === 'worktree' ? repos.find((repo) => repo.id === sheet.repoID) ?? null : null;

    return (
        <div
            data-testid="inspector"
            className="flex h-full min-h-0 shrink-0 flex-col border-l"
            style={{
                width: INSPECTOR_WIDTH_PX,
                borderColor: tokens.divider,
                background: tokens.sidebarBackground,
                color: tokens.textPrimary
            }}
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <span className="flex-1 text-[13px] font-semibold">Inspector</span>
                {props.refreshing === true ? (
                    <span data-testid="inspector-refreshing" className="text-[10px]" style={{ color: tokens.textTertiary }}>
                        reading git…
                    </span>
                ) : null}
                <InspectorIconButton
                    icon="clear"
                    tooltip="Close inspector"
                    testID="inspector-close"
                    onClick={() => props.onClose?.()}
                />
            </div>
            <div className="h-px shrink-0" style={{ background: tokens.divider }} />

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {/* ── workspace ──────────────────────────────────────────────────── */}
                <section className="flex flex-col gap-1.5" data-testid="inspector-workspace">
                    <SectionLabel icon="stack" text="Workspace" />
                    <div className="flex items-center gap-2">
                        <span
                            className="h-4 w-1 shrink-0 rounded-[2px]"
                            data-testid="inspector-workspace-color"
                            style={{ background: workspaceColorHex(workspace.color, bucket) }}
                        />
                        {renaming ? (
                            <InlineName
                                value={workspace.name}
                                onCommit={(name) => {
                                    setRenaming(false);
                                    if (name !== '' && name !== workspace.name) props.onRenameWorkspace?.(name);
                                }}
                                onCancel={() => {
                                    setRenaming(false);
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                data-testid="inspector-workspace-name"
                                title="Rename workspace"
                                className="min-w-0 flex-1 cursor-text truncate text-left text-[13px]"
                                style={{ color: tokens.textPrimary }}
                                onClick={() => {
                                    setRenaming(props.onRenameWorkspace !== undefined);
                                }}
                            >
                                {workspace.name}
                            </button>
                        )}
                        <span
                            className="shrink-0 text-[15px] leading-none"
                            aria-hidden
                            style={{ color: tokens.textSecondary }}
                        >
                            {iconGlyph(workspace.icon) ?? ''}
                        </span>
                    </div>
                    <div className="text-[11px]" style={{ color: tokens.textTertiary }}>
                        {panes.length} pane{panes.length === 1 ? '' : 's'}
                    </div>

                    <div className="flex flex-wrap items-center gap-1 pt-0.5" data-testid="inspector-colors">
                        {WORKSPACE_COLORS.map((color) => (
                            <button
                                key={color}
                                type="button"
                                aria-label={`Color ${color}`}
                                title={color}
                                data-testid={`inspector-color-${color}`}
                                className="h-3.5 w-3.5 cursor-pointer rounded-full"
                                style={{
                                    background: workspaceColorHex(color, bucket),
                                    outline: workspace.color === color ? `2px solid ${tokens.textPrimary}` : 'none',
                                    outlineOffset: '1px'
                                }}
                                onClick={() => props.onSetWorkspaceColor?.(color)}
                            />
                        ))}
                    </div>

                    {workspace.labels.length === 0 ? null : (
                        <div className="flex flex-wrap gap-1 pt-0.5" data-testid="inspector-labels">
                            {workspace.labels.map((label) => {
                                const style = resolveLabelStyle(label, presets, bucket);
                                return (
                                    <span
                                        key={label}
                                        className="rounded px-1 py-[1px] text-[10px]"
                                        style={{ background: style.background, color: style.text }}
                                    >
                                        {label}
                                    </span>
                                );
                            })}
                        </div>
                    )}

                    <label className="flex items-center gap-2 pt-1 text-[11px]" style={{ color: tokens.textSecondary }}>
                        Profile
                        <select
                            data-testid="inspector-profile"
                            className="min-w-0 flex-1 rounded border bg-transparent px-1 py-[2px] text-[11px]"
                            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                            value={workspace.profileName ?? DEFAULT_PROFILE_NAME}
                            onChange={(event) => {
                                const chosen = event.target.value;
                                props.onSetProfile?.(chosen === DEFAULT_PROFILE_NAME ? null : chosen);
                            }}
                        >
                            {profileOptions.map((name) => (
                                <option key={name} value={name} style={{ color: '#000' }}>
                                    {name}
                                </option>
                            ))}
                        </select>
                    </label>
                </section>

                <Divider />

                {/* ── repositories ───────────────────────────────────────────────── */}
                <section className="flex flex-col gap-2" data-testid="inspector-repos">
                    <div className="flex items-center gap-2">
                        <div className="flex-1">
                            <SectionLabel icon="folder" text="Repositories" />
                        </div>
                        <InspectorIconButton
                            icon="plus"
                            tooltip="Add repository or worktree"
                            testID="inspector-add-repo"
                            onClick={(event) => {
                                const anchor = menuAnchorFromEvent(event);
                                setAddMenu({ x: anchor.x, y: anchor.y });
                            }}
                        />
                    </div>

                    {/*
                      * §GIT-051 / §WS-145: the interrupted-graft banner sits ABOVE the repo
                      * list, and only for orphans whose worktree this workspace actually
                      * associates — another workspace's crashed graft is not this panel's
                      * business.
                      */}
                    {relevantOrphans.map((orphan) => (
                        <GraftOrphanBanner
                            key={orphan.associationID}
                            orphan={orphan}
                            onRestore={() => props.onRestoreGraftOrphan?.(orphan)}
                            onDismiss={() => props.onDismissGraftOrphan?.(orphan)}
                        />
                    ))}

                    {associations.length === 0 ? (
                        <div className="text-[11px]" style={{ color: tokens.textTertiary }}>
                            No repositories associated
                        </div>
                    ) : (
                        groups.map((group) => (
                            <div key={group.repoID} className="flex flex-col gap-1">
                                {group.main === null ? (
                                    <div className="flex items-center gap-1.5 text-[12px]" style={{ color: tokens.textSecondary }}>
                                        <ChromeIcon name="folder" />
                                        <span className="truncate font-medium">{group.repoName}</span>
                                    </div>
                                ) : (
                                    <AssociationRow
                                        association={group.main}
                                        onMenu={(association, event) => {
                                            const anchor = menuAnchorFromEvent(event);
                                            setMenu({
                                                id: association.id,
                                                isWorktree: association.isWorktree,
                                                x: anchor.x,
                                                y: anchor.y
                                            });
                                        }}
                                        {...(props.onOpenDiff === undefined ? {} : { onOpenDiff: props.onOpenDiff })}
                                        {...(props.onOpenTerminal === undefined
                                            ? {}
                                            : { onOpenTerminal: props.onOpenTerminal })}
                                    />
                                )}
                                {group.worktrees.map((association) => (
                                    <div key={association.id} className="pl-3">
                                        <AssociationRow
                                            association={association}
                                            {...(graftSessions[association.id] === undefined
                                                ? {}
                                                : { graftSession: graftSessions[association.id] })}
                                            {...(props.onToggleGraft === undefined
                                                ? {}
                                                : { onToggleGraft: props.onToggleGraft })}
                                            onMenu={(entry, event) => {
                                                const anchor = menuAnchorFromEvent(event);
                                                setMenu({
                                                    id: entry.id,
                                                    isWorktree: entry.isWorktree,
                                                    x: anchor.x,
                                                    y: anchor.y
                                                });
                                            }}
                                            {...(props.onOpenDiff === undefined ? {} : { onOpenDiff: props.onOpenDiff })}
                                            {...(props.onOpenTerminal === undefined
                                                ? {}
                                                : { onOpenTerminal: props.onOpenTerminal })}
                                        />
                                    </div>
                                ))}
                            </div>
                        ))
                    )}
                </section>

                <Divider />

                {/* ── panes ──────────────────────────────────────────────────────── */}
                <section className="flex flex-col gap-1" data-testid="inspector-panes">
                    <SectionLabel icon="layout" text="Panes" />
                    {panes.map((pane) => (
                        <PaneRow
                            key={pane.id}
                            pane={pane}
                            focused={pane.id === (props.focusedPaneID ?? null)}
                            closable={panes.length > 1}
                            {...(props.onFocusPane === undefined ? {} : { onFocus: props.onFocusPane })}
                            {...(props.onClosePane === undefined ? {} : { onClose: props.onClosePane })}
                        />
                    ))}
                </section>
            </div>

            {addMenu === null ? null : (
                <ContextMenu
                    x={addMenu.x}
                    y={addMenu.y}
                    label="Add repository menu"
                    items={[
                        {
                            id: 'add-repo',
                            label: 'Add Repository…',
                            onSelect: () => {
                                setSheet({ kind: 'add-repo' });
                            }
                        },
                        {
                            id: 'new-worktree',
                            label: 'New Worktree…',
                            disabled: repos.length === 0,
                            onSelect: openWorktreeSheet
                        }
                    ]}
                    onClose={() => {
                        setAddMenu(null);
                    }}
                />
            )}

            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label="Repository menu"
                    items={
                        [
                            {
                                id: 'remove',
                                label: 'Remove',
                                danger: true,
                                onSelect: () => props.onRemoveAssociation?.(menu.id, false)
                            },
                            ...(menu.isWorktree
                                ? [
                                      {
                                          id: 'remove-delete',
                                          label: 'Remove & Delete Worktree',
                                          danger: true,
                                          onSelect: () => props.onRemoveAssociation?.(menu.id, true)
                                      } satisfies MenuItemSpec
                                  ]
                                : [])
                        ] satisfies MenuItemSpec[]
                    }
                    onClose={() => {
                        setMenu(null);
                    }}
                />
            )}

            {sheet?.kind === 'add-repo' ? (
                <AddRepositorySheet
                    repos={repos}
                    associatedRepoIDs={associatedRepoIDs}
                    onCancel={() => {
                        setSheet(null);
                    }}
                    onSubmit={async (paths) => {
                        // §GIT-082: ONE association per chosen repo, at the repo's own path.
                        // The first refusal stops the run and keeps the sheet open with the
                        // daemon's message — a half-applied batch with a generic error would
                        // leave the user guessing which row failed.
                        for (const path of paths) {
                            const error = await props.onAddAssociation?.(path);
                            if (typeof error === 'string') return error;
                        }
                        setSheet(null);
                        return null;
                    }}
                    {...(props.onBrowseForFolder === undefined ? {} : { onBrowse: props.onBrowseForFolder })}
                    {...(props.onScanForRepos === undefined ? {} : { onScan: props.onScanForRepos })}
                />
            ) : null}

            {sheet?.kind === 'pick-repo' ? (
                <RepoPickerSheet
                    repos={repos}
                    onCancel={() => {
                        setSheet(null);
                    }}
                    onChoose={(repoID) => {
                        setSheet({ kind: 'worktree', repoID });
                    }}
                />
            ) : null}

            {/* §GIT-050 / §WS-144: two worktrees, one parent repo — the user picks. */}
            {props.graftSwapPrompt === undefined || props.graftSwapPrompt === null ? null : (
                <GraftSwapDialog
                    prompt={props.graftSwapPrompt}
                    onConfirm={() => {
                        const prompt = props.graftSwapPrompt;
                        if (prompt !== undefined && prompt !== null) props.onConfirmGraftSwap?.(prompt);
                    }}
                    onCancel={() => props.onCancelGraftSwap?.()}
                    {...(props.dialogContainer === undefined ? {} : { container: props.dialogContainer })}
                />
            )}

            {sheet?.kind === 'worktree' && sheetRepo !== null ? (
                <CreateWorktreeSheet
                    repo={sheetRepo}
                    canChangeRepo={repos.length > 1}
                    onChangeRepo={() => {
                        setSheet({ kind: 'pick-repo' });
                    }}
                    onCancel={() => {
                        setSheet(null);
                    }}
                    onCreate={async (request) => {
                        const error = await props.onCreateWorktree?.(request);
                        if (typeof error === 'string') return error;
                        setSheet(null);
                        return null;
                    }}
                />
            ) : null}
        </div>
    );
}

function Divider(): ReactElement {
    return <div className="my-3 h-px" style={{ background: tokens.divider }} />;
}

function InlineName(props: {
    readonly value: string;
    readonly onCommit: (name: string) => void;
    readonly onCancel: () => void;
}): ReactElement {
    const [value, setValue] = useState(props.value);
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    return (
        <input
            ref={ref}
            aria-label="Rename workspace"
            data-testid="inspector-rename-input"
            className="min-w-0 flex-1 rounded border bg-transparent px-1 py-[1px] text-[13px] outline-none"
            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
            value={value}
            onChange={(event) => {
                setValue(event.target.value);
            }}
            onBlur={() => {
                props.onCommit(value.trim());
            }}
            onKeyDown={(event) => {
                if (event.key === 'Enter') props.onCommit(value.trim());
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    props.onCancel();
                }
            }}
        />
    );
}

function AssociationRow(props: {
    readonly association: InspectorAssociation;
    readonly onMenu: (association: InspectorAssociation, event: React.MouseEvent) => void;
    readonly onOpenDiff?: ((repoPath: string) => void) | undefined;
    readonly onOpenTerminal?: ((repoPath: string, options: { vertical: boolean }) => void) | undefined;
    /** Present only on a WORKTREE row — §GIT-049 keeps the toggle off the main checkout. */
    readonly graftSession?: GraftSessionView | undefined;
    readonly onToggleGraft?: ((association: InspectorAssociation) => void) | undefined;
}): ReactElement {
    const { association } = props;
    const title = association.isWorktree ? (association.branch ?? 'worktree') : association.repoName;
    return (
        <div
            data-testid={`inspector-assoc-${association.id}`}
            data-worktree={association.isWorktree ? 'true' : 'false'}
            className="flex items-center gap-1.5"
            title={association.worktreePath}
            onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onMenu(association, event);
            }}
        >
            <StatusDot status={association.status} />
            <span style={{ color: tokens.textSecondary }}>
                <ChromeIcon name={association.isWorktree ? 'branch' : 'folder'} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[12px] font-medium">{title}</span>
                <span className="flex items-center gap-1.5">
                    {!association.isWorktree && association.branch !== null ? (
                        <span className="truncate text-[10px]" style={{ color: tokens.textSecondary }}>
                            {association.branch}
                        </span>
                    ) : null}
                    <DiffStats status={association.status} />
                </span>
            </span>
            {/*
              * §GIT-049: graft mirrors a linked worktree INTO its parent, so the toggle is
              * meaningless on the parent's own row and is not rendered there at all. (The
              * engine refuses the main checkout too — that is the CLI-side backstop, §GIT-002.)
              */}
            {association.isWorktree && props.onToggleGraft !== undefined ? (
                <GraftToggleButton
                    associationID={association.id}
                    session={props.graftSession}
                    tooltip={graftTooltip({ session: props.graftSession, branch: association.branch })}
                    onToggle={() => props.onToggleGraft?.(association)}
                />
            ) : null}
            <InspectorIconButton
                icon="plusminus"
                tooltip="Show diff for this repo"
                testID={`inspector-diff-${association.id}`}
                onClick={() => props.onOpenDiff?.(association.worktreePath)}
            />
            <InspectorIconButton
                icon="terminal"
                tooltip="Open terminal at this path (Shift: split vertical)"
                testID={`inspector-terminal-${association.id}`}
                onClick={(event) => props.onOpenTerminal?.(association.worktreePath, { vertical: event.shiftKey })}
            />
            <InspectorIconButton
                icon="ellipsis"
                tooltip="Repository actions"
                testID={`inspector-assoc-menu-${association.id}`}
                onClick={(event) => {
                    props.onMenu(association, event);
                }}
            />
        </div>
    );
}

const PANE_ICONS: Readonly<Record<ChromePane['type'], ChromeIconName>> = {
    shell: 'terminal',
    markdown: 'document',
    scratchpad: 'note',
    diff: 'plusminus',
    web: 'globe'
};

function PaneRow(props: {
    readonly pane: ChromePane;
    readonly focused: boolean;
    readonly closable: boolean;
    readonly onFocus?: ((paneID: string) => void) | undefined;
    readonly onClose?: ((paneID: string) => void) | undefined;
}): ReactElement {
    const { pane } = props;
    const title = pane.label ?? pane.title ?? 'Shell';
    return (
        <div className="flex items-center gap-1.5" data-testid={`inspector-pane-${pane.id}`}>
            <span style={{ color: tokens.textTertiary }}>
                <ChromeIcon name={PANE_ICONS[pane.type]} />
            </span>
            <button
                type="button"
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12px]"
                title={`Focus ${title}`}
                style={{ color: props.focused ? tokens.textPrimary : tokens.textSecondary }}
                onClick={() => props.onFocus?.(pane.id)}
            >
                {title}
            </button>
            <span className="shrink-0 text-[10px] uppercase" style={{ color: tokens.textTertiary }}>
                {pane.status === 'idle' ? '' : pane.status}
            </span>
            {props.focused ? (
                <span
                    data-testid={`inspector-pane-focused-${pane.id}`}
                    aria-label="Focused pane"
                    title="Focused pane"
                    className="shrink-0 text-[10px]"
                    style={{ color: tokens.accent }}
                >
                    ▶
                </span>
            ) : null}
            {props.closable ? (
                <InspectorIconButton
                    icon="clear"
                    tooltip={`Close ${title}`}
                    testID={`inspector-close-pane-${pane.id}`}
                    onClick={() => props.onClose?.(pane.id)}
                />
            ) : null}
        </div>
    );
}

// ── sheets ──────────────────────────────────────────────────────────────────────────

/**
 * The inspector's sheet shell — the three repo sheets' backdrop, and their modal contract
 * (UI-FIDELITY H12).
 *
 * `RepoPickerView.swift:100-102` presents these through SwiftUI's `.sheet()`: system-dimmed,
 * app-modal, click-through blocked. The port drew the panel and nothing else — no `inset-0`
 * wrapper, no outside-click cancel — so the window behind stayed fully lit and fully
 * interactive, and the two sheets that DO get it right (`SettingsOverlay`'s 0.62 scrim,
 * `NewWorkspaceSheet`'s 0.45) made the inconsistency an internal one. This is
 * `NewWorkspaceSheet`'s contract, in the one place all three sheets share:
 *
 *   · a 0.45 scrim over the whole window, so the panes behind read as unreachable;
 *   · `onMouseDown` on the scrim ITSELF (`target === currentTarget`) cancels — a drag that
 *     starts inside the panel and ends on the backdrop must not dismiss;
 *   · `aria-modal`, which the bare panel never claimed;
 *   · and `useModalPresence`, so a live web pane's native view is parked while it is up (H1).
 */
function Sheet(props: {
    readonly testID: string;
    readonly label: string;
    readonly onDismiss: () => void;
    readonly children: ReactNode;
}): ReactElement | null {
    useModalPresence();
    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    return createPortal(
        <div
            data-testid={`${props.testID}-backdrop`}
            className="fixed inset-0 z-50"
            style={{ background: 'rgba(0,0,0,0.45)' }}
            onMouseDown={(event) => {
                if (event.target !== event.currentTarget) return;
                props.onDismiss();
            }}
        >
            <div
                data-testid={props.testID}
                role="dialog"
                aria-modal="true"
                aria-label={props.label}
                className="fixed left-1/2 top-1/4 z-50 w-[340px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary,
                    boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
                }}
            >
                {props.children}
            </div>
        </div>,
        container
    );
}

function SheetError({ message }: { readonly message: string | null }): ReactElement | null {
    if (message === null) return null;
    return (
        <div data-testid="sheet-error" className="mb-2 text-[11px]" style={{ color: '#E0655C' }}>
            {message}
        </div>
    );
}

/**
 * Add ▸ "Add Repository…" (§GIT-082).
 *
 * Two ways in, one submit. The typed path is still there — it is the only way to associate a
 * repo the registry has never seen — and §GIT-073's multi-select picker sits under it for the
 * ones it HAS seen, with the workspace's existing repos dimmed as "Added". Confirm associates
 * every chosen repo at its own path plus the typed path if there is one, in order, stopping at
 * the daemon's first refusal so the message is the one that matters.
 */
function AddRepositorySheet(props: {
    readonly onSubmit: (paths: readonly string[]) => Promise<string | null>;
    readonly onCancel: () => void;
    readonly onBrowse?: (() => Promise<string | null>) | undefined;
    readonly repos?: readonly InspectorRepo[] | undefined;
    readonly associatedRepoIDs?: ReadonlySet<string> | undefined;
    readonly onScan?: ((path: string) => void) | undefined;
}): ReactElement | null {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [picked, setPicked] = useState<readonly RepoPickerEntry[]>(EMPTY_PICKED);
    const repos = props.repos ?? [];
    const paths = [...picked.map((repo) => repo.path), ...(value.trim() === '' ? [] : [value.trim()])];
    const submit = async (): Promise<void> => {
        if (paths.length === 0 || busy) return;
        setBusy(true);
        setError(null);
        const failure = await props.onSubmit(paths);
        setBusy(false);
        if (failure !== null) setError(failure);
    };
    return (
        <Sheet testID="add-repo-sheet" label="Add repository" onDismiss={props.onCancel}>
            <div className="mb-3 text-[13px] font-semibold">Add Repository</div>
            <div className="mb-1 text-[11px]" style={{ color: tokens.textSecondary }}>
                Path to a repository or worktree
            </div>
            <div className="mb-3 flex items-center gap-2">
                <input
                    autoFocus
                    aria-label="Repository path"
                    data-testid="add-repo-path"
                    placeholder="/path/to/repo"
                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') void submit();
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            props.onCancel();
                        }
                    }}
                />
                {props.onBrowse === undefined ? null : (
                    <button
                        type="button"
                        data-testid="add-repo-browse"
                        className="shrink-0 cursor-pointer text-[12px]"
                        style={{ color: tokens.accent }}
                        onClick={() => {
                            void props.onBrowse?.().then((chosen) => {
                                if (chosen !== null) setValue(chosen);
                            });
                        }}
                    >
                        Choose…
                    </button>
                )}
            </div>
            {repos.length === 0 ? null : (
                <>
                    <div className="mb-1 text-[11px]" style={{ color: tokens.textSecondary }}>
                        …or pick from the registry
                    </div>
                    <div className="mb-3">
                        <RepoPicker
                            repos={repos}
                            mode="multiple"
                            hideFooter
                            {...(props.associatedRepoIDs === undefined
                                ? {}
                                : { disabledRepoIDs: props.associatedRepoIDs })}
                            {...(props.onScan === undefined ? {} : { onScan: props.onScan })}
                            onSelectionChange={setPicked}
                            onConfirm={() => void submit()}
                            onCancel={props.onCancel}
                        />
                    </div>
                </>
            )}
            <SheetError message={error} />
            <div className="flex justify-end gap-2">
                <button type="button" style={{ color: tokens.textSecondary }} onClick={props.onCancel}>
                    Cancel
                </button>
                <button
                    type="button"
                    data-testid="add-repo-submit"
                    disabled={paths.length === 0 || busy}
                    style={{ color: paths.length === 0 || busy ? tokens.textTertiary : tokens.accent }}
                    onClick={() => void submit()}
                >
                    {paths.length > 1 ? `Add ${String(paths.length)}` : 'Add'}
                </button>
            </div>
        </Sheet>
    );
}

/**
 * "Which repo?" for the worktree flow — §GIT-073's picker in `single` mode, so it gains the
 * search filter, the roving keyboard anchor and double-click-to-choose without this sheet
 * having to know how any of that works.
 */
function RepoPickerSheet(props: {
    readonly repos: readonly InspectorRepo[];
    readonly onChoose: (repoID: string) => void;
    readonly onCancel: () => void;
}): ReactElement | null {
    return (
        <Sheet testID="repo-picker-sheet" label="Choose repository" onDismiss={props.onCancel}>
            {/* M50: no headline here — `RepoPickerView.swift:62-63` draws the picker's own
                ("Add Repository"), so a host that named it a third thing names nothing now. */}
            <RepoPicker
                repos={props.repos}
                mode="single"
                confirmLabel="Choose"
                onConfirm={(chosen) => {
                    const first = chosen[0];
                    if (first !== undefined) props.onChoose(first.id);
                }}
                onCancel={props.onCancel}
            />
        </Sheet>
    );
}

/**
 * §WS-147 / §GIT-099. The worktree name mirrors into the branch until the branch is hand-edited,
 * the preview shows the SANITIZED folder and branch (so a name git would reject is visible
 * before the failure, issue #218), Create stays disabled until both sanitize, Return submits,
 * and a second Create is refused while the first `git worktree add` is still running (§WS-079).
 * A failure keeps the sheet open with the daemon's own message and re-enables Create (§WS-148).
 */
export function CreateWorktreeSheet(props: {
    readonly repo: InspectorRepo;
    readonly canChangeRepo?: boolean | undefined;
    readonly onChangeRepo?: (() => void) | undefined;
    readonly onCreate: (request: WorktreeRequest) => Promise<string | null>;
    readonly onCancel: () => void;
}): ReactElement | null {
    const [name, setName] = useState('');
    const [branch, setBranch] = useState('');
    const [branchEdited, setBranchEdited] = useState(false);
    const [updateMain, setUpdateMain] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const preview = worktreePreview({ name, branch, base: props.repo.worktreeBase });

    const submit = async (): Promise<void> => {
        if (!preview.valid || busy) return;
        setBusy(true);
        setError(null);
        const failure = await props.onCreate({
            repoID: props.repo.id,
            name,
            branch,
            updateMain
        });
        setBusy(false);
        if (failure !== null) setError(failure);
    };

    return (
        <Sheet testID="worktree-sheet" label="New worktree" onDismiss={props.onCancel}>
            <div className="mb-2 text-[13px] font-semibold">New Worktree</div>
            <div className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: tokens.textSecondary }}>
                <span className="truncate">
                    Create a worktree for <b style={{ color: tokens.textPrimary }}>{props.repo.name}</b>
                </span>
                {props.canChangeRepo === true ? (
                    <button
                        type="button"
                        data-testid="worktree-change-repo"
                        className="shrink-0 cursor-pointer"
                        style={{ color: tokens.accent }}
                        onClick={props.onChangeRepo}
                    >
                        Change
                    </button>
                ) : null}
            </div>

            <label className="mb-1 block text-[11px]" style={{ color: tokens.textSecondary }}>
                Worktree name
            </label>
            <input
                autoFocus
                aria-label="Worktree name"
                data-testid="worktree-name"
                className="mb-2 w-full rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                value={name}
                onChange={(event) => {
                    const next = event.target.value;
                    setName(next);
                    if (!branchEdited) setBranch(next);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        props.onCancel();
                    }
                }}
            />

            <label className="mb-1 block text-[11px]" style={{ color: tokens.textSecondary }}>
                Branch name
            </label>
            <input
                aria-label="Branch name"
                data-testid="worktree-branch"
                className="mb-2 w-full rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                value={branch}
                onChange={(event) => {
                    setBranch(event.target.value);
                    setBranchEdited(event.target.value !== name);
                }}
                onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                    if (event.key === 'Escape') {
                        event.stopPropagation();
                        props.onCancel();
                    }
                }}
            />

            <label className="mb-2 flex cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                    type="checkbox"
                    data-testid="worktree-update-main"
                    checked={updateMain}
                    onChange={(event) => {
                        setUpdateMain(event.target.checked);
                    }}
                />
                Update main first (fetch + branch off origin)
            </label>

            <div data-testid="worktree-preview" className="mb-3 text-[10px]" style={{ color: tokens.textTertiary }}>
                <div className="truncate">{preview.path}</div>
                <div>{preview.branchLine}</div>
            </div>

            <SheetError message={error} />

            <div className="flex justify-end gap-2">
                <button type="button" style={{ color: tokens.textSecondary }} onClick={props.onCancel}>
                    Cancel
                </button>
                <button
                    type="button"
                    data-testid="worktree-create"
                    disabled={!preview.valid || busy}
                    style={{ color: !preview.valid || busy ? tokens.textTertiary : tokens.accent }}
                    onClick={() => void submit()}
                >
                    {busy ? 'Creating…' : 'Create'}
                </button>
            </div>
        </Sheet>
    );
}

const EMPTY_GRAFT_SESSIONS: Readonly<Record<string, GraftSessionView>> = {};
const EMPTY_GRAFT_ORPHANS: readonly GraftOrphanView[] = [];
const EMPTY_ASSOCIATIONS: readonly InspectorAssociation[] = [];
const EMPTY_REPOS: readonly InspectorRepo[] = [];
const EMPTY_PRESETS: readonly ChromeLabelPreset[] = [];
const EMPTY_PICKED: readonly RepoPickerEntry[] = [];
