/**
 * The workspace sidebar (WP3.4) — shell-ui.md §5.
 *
 * Structure: filter field → list (or the flat filtered list) → footer, on
 * `theme.sidebarBackground`. Rows render in daemon order (`topLevelOrder` + each group's
 * `childOrder`, delivered as `entries`); ⌘1..9 badges index `visibleWorkspaceOrder`.
 *
 * Three things here are deliberate ports of a spec subtlety rather than obvious UI code:
 *
 *   1. **Collapse is client-local-first.** There is no `group-collapse` wire verb yet, so a
 *      click would otherwise do nothing until the daemon grows one. The row toggles a local
 *      override *and* raises `onToggleGroupCollapse`; when the verb lands, assembly wires it
 *      and the override is simply confirmed by the next delta.
 *   2. **Drag live-applies to a client-local shadow and commits ONCE** (§15). Every
 *      intermediate order lives in `shadow`; `mouseup` derives a single
 *      `{workspaceID, groupID, index}` (post-remove semantics) and calls `onMoveWorkspace`
 *      exactly once. `ontoGroupHeader` stays preview-only during the drag, exactly as the
 *      Swift app does, because the cursor transits headers constantly.
 *   3. **Menus are portals** (§15 "Menu stability"): an open menu/submenu must survive the
 *      1-second agent-status re-render of the row underneath it, which it does because its
 *      state lives on the sidebar and its DOM lives on `document.body`.
 *
 * Everything else is props/callbacks — the sidebar never reads the store or sends a command.
 */

import type { KeyBindingMap, NexAction } from '@nex/core/config';
import type { IconRef, WorkspaceColor } from '@nex/daemon/store';
import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactElement
} from 'react';
import { createPortal } from 'react-dom';

import { ContextMenu, menuAnchorFromEvent, type MenuItemSpec } from './ContextMenu';
import {
    ChromeIcon,
    CURATED_EMOJI,
    CURATED_SYMBOL_ICONS,
    avatarLetter,
    iconGlyph,
    iconIsTintable,
    normalizeEmojiInput
} from './icons';
import { shortcutForAction } from './keys';
import {
    applyGroupDrop,
    applyWorkspaceDrop,
    buildDropZones,
    buildGroupSpans,
    filteredRows,
    groupCommit,
    isGroupCollapsed,
    locateWorkspace,
    orderModelFromEntries,
    projectEntries,
    renderedRows,
    resolveDropTarget,
    resolveGroupDropIndex,
    visibleOrderFromEntries,
    workspaceCommit,
    type CollapseState,
    type DropTarget,
    type SidebarOrderModel
} from './sidebar-model';
import {
    SIDEBAR_TINT_VARS,
    resolveLabelStyle,
    tintedColor,
    withAlpha,
    workspaceColorHex,
    type ChromeBucket
} from './theme';
import { tokens } from './tokens';
import {
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeLabelPreset,
    type ChromeRepo,
    type ChromeSidebarEntry,
    type ChromeWorkspace,
    type SidebarCallbacks,
    type WorkspaceWorktreeRequest
} from './types';
import { worktreePreview } from './worktree';

const DRAG_THRESHOLD_PX = 5;
const DEFAULT_ROW_HEIGHT = 34;
const CONTENT_TOP_PADDING = 4;

/**
 * §5.5's drag timers, verbatim from the timer inventory (§15):
 *
 *   - hovering a COLLAPSED group for 650 ms transiently expands it for the rest of the drag
 *     (its persisted `isCollapsed` is untouched — leaving cancels, releasing collapses again);
 *   - within 40 px of the viewport's top/bottom edge the list scrolls 3 px every 15 ms, and
 *     each tick re-derives the content-space cursor and re-runs the whole target resolution,
 *     because a stationary pointer emits no further mousemove events.
 */
export const SPRING_LOAD_MS = 650;
export const AUTO_SCROLL_EDGE_PX = 40;
export const AUTO_SCROLL_STEP_PX = 3;
export const AUTO_SCROLL_INTERVAL_MS = 15;

// ── small pieces ────────────────────────────────────────────────────────────────────

/**
 * The bounds of the row a context-menu event was raised on — what `menuAnchorFromEvent` needs
 * in order to keep the menu off it (run-B m7). Degrades to `null` where there is no layout
 * (jsdom has no box model), which puts the menu back at the pointer.
 */
function rowRect(event: React.MouseEvent): { top: number; bottom: number } | null {
    const element = event.currentTarget;
    const rect = element instanceof Element ? element.getBoundingClientRect() : undefined;
    if (rect === undefined || (rect.top === 0 && rect.bottom === 0)) return null;
    return { top: rect.top, bottom: rect.bottom };
}

interface AgentCounts {
    readonly running: number;
    readonly waiting: number;
}

function agentCounts(workspaces: readonly ChromeWorkspace[]): AgentCounts {
    let running = 0;
    let waiting = 0;
    for (const workspace of workspaces) {
        for (const pane of workspace.panes) {
            if (pane.status === 'running') running += 1;
            else if (pane.status === 'waitingForInput') waiting += 1;
        }
    }
    return { running, waiting };
}

/** §5.3: waiting wins over running; nothing when neither. */
function statusDotColor(counts: AgentCounts): string | null {
    if (counts.waiting > 0) return tokens.statusWaiting;
    if (counts.running > 0) return tokens.statusRunning;
    return null;
}

function StatusDot({ counts }: { readonly counts: AgentCounts }): ReactElement | null {
    const color = statusDotColor(counts);
    if (color === null) return null;
    return (
        <span
            data-testid="status-dot"
            data-status={counts.waiting > 0 ? 'waiting' : 'running'}
            className="absolute -right-[3px] -top-[3px] h-[9px] w-[9px] rounded-full"
            style={{ background: color, boxShadow: `0 0 0 1.5px ${tokens.sidebarBackground}` }}
        />
    );
}

interface AvatarProps {
    readonly name: string;
    readonly color: WorkspaceColor;
    readonly icon: ChromeWorkspace['icon'];
    readonly bucket: ChromeBucket;
    readonly counts: AgentCounts;
}

function Avatar(props: AvatarProps): ReactElement {
    const hex = workspaceColorHex(props.color, props.bucket);
    const glyph = iconGlyph(props.icon);
    return (
        <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-[11px] font-semibold">
            <span
                aria-hidden
                className="absolute inset-0 rounded-[5px]"
                // SET-038: the fill and border opacities are user settings, published as CSS
                // variables by the theme container (`sidebarTintCssVars`) rather than threaded
                // down as props — see `tintedColor`. The literals are the shipped defaults and
                // the fallback for a fixture mounted outside a provider.
                style={{
                    background: tintedColor(hex, SIDEBAR_TINT_VARS.avatarFill, 0.2),
                    border: `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.avatarStroke, 0.45)}`
                }}
            />
            <span
                className="relative"
                style={iconIsTintable(props.icon) || glyph === null ? { color: hex } : undefined}
            >
                {glyph ?? avatarLetter(props.name)}
            </span>
            <StatusDot counts={props.counts} />
        </span>
    );
}

interface LabelChipsProps {
    readonly labels: readonly string[];
    readonly presets: readonly ChromeLabelPreset[];
    readonly bucket: ChromeBucket;
}

/** §5.3: up to 3 chips + a `+N` overflow indicator. */
function LabelChips(props: LabelChipsProps): ReactElement | null {
    if (props.labels.length === 0) return null;
    const shown = props.labels.slice(0, 3);
    const overflow = props.labels.length - shown.length;
    return (
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
            {shown.map((label) => {
                const style = resolveLabelStyle(label, props.presets, props.bucket);
                return (
                    <span
                        key={label}
                        data-testid="label-chip"
                        className="rounded-full px-[5px] py-px text-[9px] font-medium"
                        style={{ background: style.background, color: style.text }}
                    >
                        {label}
                    </span>
                );
            })}
            {overflow > 0 ? (
                <span className="text-[9px]" style={{ color: tokens.textTertiary }}>
                    +{overflow}
                </span>
            ) : null}
        </span>
    );
}

interface InlineEditorProps {
    readonly value: string;
    readonly onCommit: (value: string) => void;
    readonly onCancel: () => void;
    readonly label: string;
}

/**
 * §5.4: auto-focused, Enter commits a non-empty trimmed value, Esc cancels, blur commits
 * silently (empty/unchanged → cancel). Focus is assigned on mount, never stolen by a
 * re-render (§15 "inline editors are never robbed of focus").
 */
function InlineEditor(props: InlineEditorProps): ReactElement {
    const [value, setValue] = useState(props.value);
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);
    const commit = (): void => {
        const trimmed = value.trim();
        if (trimmed.length === 0 || trimmed === props.value) props.onCancel();
        else props.onCommit(trimmed);
    };
    return (
        <input
            ref={ref}
            aria-label={props.label}
            className="w-full rounded border bg-transparent px-1 py-0.5 text-[13px] outline-none"
            style={{ borderColor: tokens.accent, color: tokens.textPrimary }}
            value={value}
            onChange={(event) => {
                setValue(event.target.value);
            }}
            onClick={(event) => {
                event.stopPropagation();
            }}
            onMouseDown={(event) => {
                event.stopPropagation();
            }}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                    return;
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onCancel();
                }
            }}
        />
    );
}

// ── workspace row ───────────────────────────────────────────────────────────────────

interface WorkspaceRowProps {
    readonly workspace: ChromeWorkspace;
    readonly depth: 0 | 1;
    readonly active: boolean;
    readonly selected: boolean;
    /** Index in `visibleWorkspaceOrder`; -1 suppresses the badge (filtered list). */
    readonly badgeIndex: number;
    readonly bucket: ChromeBucket;
    readonly presets: readonly ChromeLabelPreset[];
    readonly renaming: boolean;
    readonly dragging: boolean;
    /** §5.5 multi-drag: the other selected rows collapse to zero height for the drag. */
    readonly dragHidden?: boolean | undefined;
    /** §5.5 multi-drag: the `+N` capsule on the grabbed row (0 = no capsule). */
    readonly dragExtra?: number | undefined;
    readonly groupCaption: string | null;
    readonly onActivate: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onContextMenu: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onDragStart: (workspaceID: string, event: React.MouseEvent) => void;
    readonly onCommitRename: (workspaceID: string, name: string) => void;
    readonly onCancelRename: () => void;
    readonly registerRow: (key: string, element: HTMLElement | null) => void;
}

const WorkspaceRow = memo(function WorkspaceRow(props: WorkspaceRowProps): ReactElement {
    const { workspace } = props;
    const counts = agentCounts([workspace]);
    const branch = workspace.panes.find((pane) => pane.gitBranch !== null)?.gitBranch ?? null;
    const paneCount = workspace.panes.length;

    const background = props.active
        ? withAlpha(workspaceColorHex(workspace.color, props.bucket), 0.16)
        : props.selected
          ? tokens.selectionFill
          : 'transparent';
    const outline = props.active
        ? `1.5px solid ${tokens.selectionStroke}`
        : props.selected
          ? `1px solid ${withAlpha('#5276B8', 0.7)}`
          : 'none';

    const hidden = props.dragHidden === true;
    const style: CSSProperties = {
        background,
        outline,
        outlineOffset: '-1px',
        marginLeft: props.depth === 1 ? 24 : 0,
        // §5.5: a dragged row lifts to 80% opacity and scales up; the OTHER rows of a
        // multi-selection collapse to zero height so the grid closes over them.
        opacity: hidden ? 0 : props.dragging ? 0.8 : 1,
        ...(props.dragging && !hidden ? { transform: 'scale(1.03)' } : {}),
        ...(hidden
            ? {
                  height: 0,
                  minHeight: 0,
                  marginTop: 0,
                  marginBottom: 0,
                  paddingTop: 0,
                  paddingBottom: 0,
                  overflow: 'hidden',
                  pointerEvents: 'none' as const
              }
            : {})
    };

    return (
        <div
            ref={(element) => {
                props.registerRow(`ws:${workspace.id}`, element);
            }}
            data-drag-hidden={hidden ? 'true' : undefined}
            role="option"
            tabIndex={-1}
            aria-selected={props.active}
            data-testid="workspace-row"
            data-workspace-id={workspace.id}
            data-depth={props.depth}
            data-active={props.active ? 'true' : 'false'}
            className="my-0.5 flex cursor-default items-center gap-2 rounded-[7px] px-2 py-1.5"
            style={style}
            onMouseDown={(event) => {
                props.onDragStart(workspace.id, event);
            }}
            onClick={(event) => {
                props.onActivate(workspace.id, event);
            }}
            onContextMenu={(event) => {
                props.onContextMenu(workspace.id, event);
            }}
        >
            <Avatar
                name={workspace.name}
                color={workspace.color}
                icon={workspace.icon}
                bucket={props.bucket}
                counts={counts}
            />
            <span className="flex min-w-0 flex-1 flex-col">
                {props.renaming ? (
                    <InlineEditor
                        label={`Rename ${workspace.name}`}
                        value={workspace.name}
                        onCommit={(name) => {
                            props.onCommitRename(workspace.id, name);
                        }}
                        onCancel={props.onCancelRename}
                    />
                ) : (
                    <span
                        className="truncate text-[13px] font-semibold"
                        style={{ color: props.active ? tokens.textPrimary : tokens.textSecondary }}
                    >
                        {workspace.name}
                    </span>
                )}
                <LabelChips labels={workspace.labels} presets={props.presets} bucket={props.bucket} />
                <span
                    className="mt-0.5 flex items-center gap-1.5 text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {branch === null ? null : (
                        <span className="flex min-w-0 items-center gap-0.5" data-testid="row-branch">
                            <ChromeIcon name="branch" size={9} />
                            <span className="truncate">{branch}</span>
                        </span>
                    )}
                    <span data-testid="row-pane-count">
                        {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
                    </span>
                    {counts.running > 0 ? (
                        <span data-testid="row-running" style={{ color: tokens.statusRunning }}>
                            ● {counts.running}
                        </span>
                    ) : null}
                    {counts.waiting > 0 ? (
                        <span data-testid="row-waiting" style={{ color: tokens.statusWaiting }}>
                            ● {counts.waiting}
                        </span>
                    ) : null}
                </span>
                {props.groupCaption === null ? null : (
                    <span className="text-[10px]" style={{ color: tokens.textTertiary }}>
                        in {props.groupCaption}
                    </span>
                )}
            </span>
            {props.dragExtra !== undefined && props.dragExtra > 0 ? (
                <span
                    data-testid="drag-count"
                    className="shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold"
                    style={{ background: tokens.accent, color: '#fff' }}
                >
                    +{props.dragExtra}
                </span>
            ) : null}
            {props.badgeIndex >= 0 && props.badgeIndex < 9 ? (
                <span
                    data-testid="cmd-badge"
                    className="shrink-0 font-mono text-[10px]"
                    style={{ color: tokens.textTertiary }}
                >
                    ⌘{props.badgeIndex + 1}
                </span>
            ) : null}
        </div>
    );
});

// ── group header row ────────────────────────────────────────────────────────────────

interface GroupHeaderRowProps {
    readonly group: ChromeGroup;
    readonly collapsed: boolean;
    readonly counts: AgentCounts;
    readonly bucket: ChromeBucket;
    readonly renaming: boolean;
    readonly dropPreview: boolean;
    readonly onToggle: (groupID: string) => void;
    readonly onContextMenu: (groupID: string, event: React.MouseEvent) => void;
    readonly onDragStart: (groupID: string, event: React.MouseEvent) => void;
    readonly onCommitRename: (groupID: string, name: string) => void;
    readonly onCancelRename: () => void;
    readonly registerRow: (key: string, element: HTMLElement | null) => void;
}

const GroupHeaderRow = memo(function GroupHeaderRow(props: GroupHeaderRowProps): ReactElement {
    const { group } = props;
    const hex = group.color === null ? tokens.textTertiary : workspaceColorHex(group.color, props.bucket);
    const glyph = iconGlyph(group.icon);
    return (
        <div
            ref={(element) => {
                props.registerRow(`header:${group.id}`, element);
            }}
            data-testid="group-header"
            data-group-id={group.id}
            data-collapsed={props.collapsed ? 'true' : 'false'}
            data-drop-preview={props.dropPreview ? 'true' : 'false'}
            className="my-0.5 flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5"
            style={{
                background: props.dropPreview
                    ? withAlpha('#6F9BD8', 0.18)
                    : group.color === null
                      ? withAlpha('#8A8A92', 0.16)
                      // SET-038's "Group band fill". The stored `-1` sentinel is resolved to the
                      // appearance preset's band opacity before it reaches the variable, so the
                      // default here is the preset value the band has always used.
                      : tintedColor(hex, SIDEBAR_TINT_VARS.groupFill, 0.22),
                border: props.dropPreview
                    ? `1px solid ${tokens.accent}`
                    : `1px solid ${tintedColor(hex, SIDEBAR_TINT_VARS.groupStroke, 0)}`
            }}
            onMouseDown={(event) => {
                props.onDragStart(group.id, event);
            }}
            onClick={() => {
                if (!props.renaming) props.onToggle(group.id);
            }}
            onContextMenu={(event) => {
                props.onContextMenu(group.id, event);
            }}
        >
            <span className="relative inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center text-[12px]">
                {glyph === null ? (
                    <span style={{ color: hex }}>
                        <ChromeIcon name="folder" size={13} />
                    </span>
                ) : (
                    <span style={iconIsTintable(group.icon) ? { color: hex } : undefined}>{glyph}</span>
                )}
                <StatusDot counts={props.counts} />
            </span>
            <span className="min-w-0 flex-1">
                {props.renaming ? (
                    <InlineEditor
                        label={`Rename ${group.name}`}
                        value={group.name}
                        onCommit={(name) => {
                            props.onCommitRename(group.id, name);
                        }}
                        onCancel={props.onCancelRename}
                    />
                ) : (
                    <span className="truncate text-[13px] font-bold" style={{ color: tokens.textPrimary }}>
                        {group.name}
                    </span>
                )}
            </span>
            <button
                type="button"
                aria-label={props.collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                data-testid="group-chevron"
                className="shrink-0"
                style={{ color: tokens.textSecondary }}
                onClick={(event) => {
                    event.stopPropagation();
                    props.onToggle(group.id);
                }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                }}
            >
                <ChromeIcon name={props.collapsed ? 'chevron-right' : 'chevron-down'} />
            </button>
        </div>
    );
});

// ── the sidebar ─────────────────────────────────────────────────────────────────────

export interface SidebarProps extends SidebarCallbacks {
    /** Daemon order: `selectSidebarEntries(store)`. */
    readonly entries: readonly ChromeSidebarEntry[];
    readonly activeWorkspaceID: string | null;
    readonly filter: string;
    readonly onFilterChange: (filter: string) => void;
    readonly labelPresets?: readonly ChromeLabelPreset[] | undefined;
    readonly bucket?: ChromeBucket | undefined;
    /** Uniform fallback height used for drag geometry before rows are measured. */
    readonly rowHeight?: number | undefined;
    readonly selectedWorkspaceIDs?: ReadonlySet<string> | undefined;
    readonly onSelectionChange?: ((ids: ReadonlySet<string>) => void) | undefined;
    /** Shortcut hints on the menu rows that have one; absent = no hints. */
    readonly keyBindings?: KeyBindingMap | undefined;
    /**
     * §15's one-shot "scroll the new entry into view". Assembly sets it when THIS client's own
     * create lands, and the sidebar clears it through `onScrollHandled` — a delta caused by
     * another client must not yank this one's viewport.
     */
    readonly scrollToWorkspaceID?: string | null | undefined;
    readonly onScrollHandled?: (() => void) | undefined;
    /** Timer overrides so drag tests do not have to wait 650 ms in real time. */
    readonly springLoadMs?: number | undefined;
    readonly autoScrollIntervalMs?: number | undefined;
    /**
     * The footer's gear and the Labels submenu's "Manage Labels…" deep link (M8 Settings,
     * shell-ui.md §5.7). Absent = neither is rendered, which keeps every existing fixture and
     * the Electron shell exactly as before. `'labels'` is the only section the sidebar names —
     * the tab vocabulary lives in `settings/`, not here.
     */
    readonly onOpenSettings?: ((section?: 'labels' | undefined) => void) | undefined;
    /**
     * The repo registry, for the New Workspace form's "Create git worktree" section (§WS-078).
     * Empty (the default) simply hides the section — the form is the plain name field it was.
     */
    readonly repos?: readonly ChromeRepo[] | undefined;
    /**
     * How many agents a workspace still has running (`activeAgentCount` — visible AND parked
     * panes). It turns the delete confirmation into `WorkspaceDeleteGate`'s alert: the count in
     * the message, and a "Don't ask again" that writes `confirm-workspace-delete` (WS-108).
     * Absent = every delete shows the plain confirmation, which is what it did before.
     */
    readonly activeAgentCount?: ((workspaceID: string) => number) | undefined;
    /** The daemon's `confirm-workspace-delete` setting; default true, as the config's is. */
    readonly confirmDeleteWhenActive?: boolean | undefined;
    /** The alert's suppression button — honoured whichever button ended the dialog. */
    readonly onSuppressDeleteConfirm?: (() => void) | undefined;
}

interface DragState {
    readonly kind: 'workspace' | 'group';
    readonly id: string;
    readonly startY: number;
    readonly originModel: SidebarOrderModel;
    /** Every row this drag moves — the grabbed one, or the whole selection it belongs to. */
    readonly ids: readonly string[];
    active: boolean;
    preview: DropTarget | null;
    /** The last cursor position, so an auto-scroll tick can re-resolve without a new event. */
    clientY: number;
    /** The collapsed group the cursor is dwelling over, and when the dwell started. */
    springCandidate: string | null;
    springTimer: ReturnType<typeof setTimeout> | null;
}

type MenuState =
    | { readonly kind: 'workspace'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'group'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'background'; readonly x: number; readonly y: number };

type RenameState = { readonly kind: 'workspace' | 'group'; readonly id: string };
type ConfirmState =
    | {
          readonly kind: 'workspace';
          readonly id: string;
          readonly name: string;
          /**
           * Agents this workspace would terminate. > 0 turns the plain confirmation into
           * `WorkspaceDeleteGate`'s alert — the count in the message plus a "Don't ask again"
           * (WS-108) — and 0 leaves it exactly as it was.
           */
          readonly activeAgents?: number | undefined;
      }
    | { readonly kind: 'group'; readonly id: string; readonly name: string }
    /** §WS-060: one confirmation for the whole selection, never N prompts. */
    | { readonly kind: 'workspaces'; readonly ids: readonly string[] };

export function Sidebar(props: SidebarProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const presets = props.labelPresets ?? EMPTY_PRESETS;
    const rowHeight = props.rowHeight ?? DEFAULT_ROW_HEIGHT;
    const springLoadMs = props.springLoadMs ?? SPRING_LOAD_MS;
    const autoScrollIntervalMs = props.autoScrollIntervalMs ?? AUTO_SCROLL_INTERVAL_MS;

    const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(EMPTY_OVERRIDES);
    const [shadow, setShadow] = useState<SidebarOrderModel | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [rename, setRename] = useState<RenameState | null>(null);
    const [confirm, setConfirm] = useState<ConfirmState | null>(null);
    const [newForm, setNewForm] = useState<{
        kind: 'workspace' | 'group';
        groupID: string | null;
        /** Present for the bulk "Group N Workspaces…" flow: the members to create it around. */
        workspaceIDs?: readonly string[];
    } | null>(null);
    const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
    const [dragID, setDragID] = useState<string | null>(null);
    /** The group a preview-only `ontoGroupHeader` target is tinting (§5.5). */
    const [previewGroupID, setPreviewGroupID] = useState<string | null>(null);
    /** §5.5 spring-loading: a collapsed group held open for the rest of THIS drag. */
    const [springLoadedGroupID, setSpringLoadedGroupID] = useState<string | null>(null);
    /** The workspace whose icon is being picked in the custom-emoji sheet. */
    const [emojiSheet, setEmojiSheet] = useState<{ kind: 'workspace' | 'group'; id: string } | null>(null);

    const selection = props.selectedWorkspaceIDs ?? internalSelection;
    const collapse: CollapseState = useMemo(
        () => ({ overrides: collapseOverrides, springLoadedGroupID }),
        [collapseOverrides, springLoadedGroupID]
    );

    const baseModel = useMemo(() => orderModelFromEntries(props.entries), [props.entries]);
    const effectiveEntries = useMemo(
        () => (shadow === null ? props.entries : projectEntries(props.entries, shadow)),
        [props.entries, shadow]
    );
    const rows = useMemo(() => renderedRows(effectiveEntries, collapse), [effectiveEntries, collapse]);
    const visibleOrder = useMemo(
        () => visibleOrderFromEntries(effectiveEntries, collapse),
        [effectiveEntries, collapse]
    );

    const listRef = useRef<HTMLDivElement | null>(null);
    const rowElements = useRef(new Map<string, HTMLElement>());
    const dragRef = useRef<DragState | null>(null);
    /** A finished drag is followed by a `click` on the row; that click must not activate it. */
    const suppressClickRef = useRef(false);
    const shadowRef = useRef<SidebarOrderModel | null>(null);
    const entriesRef = useRef(props.entries);
    const collapseRef = useRef(collapse);
    const rowsRef = useRef(rows);
    shadowRef.current = shadow;
    entriesRef.current = props.entries;
    collapseRef.current = collapse;
    rowsRef.current = rows;

    // A fresh order from the daemon supersedes the local shadow (but never mid-drag).
    useEffect(() => {
        if (dragRef.current !== null) return;
        setShadow(null);
    }, [props.entries]);

    const registerRow = useCallback((key: string, element: HTMLElement | null): void => {
        if (element === null) rowElements.current.delete(key);
        else rowElements.current.set(key, element);
    }, []);

    const workspaceByID = useMemo(() => {
        const map = new Map<string, ChromeWorkspace>();
        for (const entry of props.entries) {
            if (entry.kind === 'workspace') map.set(entry.workspace.id, entry.workspace);
            else for (const workspace of entry.workspaces) map.set(workspace.id, workspace);
        }
        return map;
    }, [props.entries]);

    const groups = useMemo(
        () =>
            props.entries
                .filter((entry): entry is ChromeSidebarEntry & { kind: 'group' } => entry.kind === 'group')
                .map((entry) => entry.group),
        [props.entries]
    );

    // The drag loop reads groups from a ref: it runs from window listeners and timers whose
    // closures must not pin a stale render's entry list.
    const groupsRef = useRef(groups);
    groupsRef.current = groups;

    const groupIDForWorkspace = useCallback(
        (workspaceID: string): string | null => locateWorkspace(baseModel, workspaceID)?.groupID ?? null,
        [baseModel]
    );

    // ── selection ───────────────────────────────────────────────────────────────
    const setSelection = useCallback(
        (ids: ReadonlySet<string>): void => {
            setInternalSelection(ids);
            props.onSelectionChange?.(ids);
        },
        [props]
    );

    // ── activation ──────────────────────────────────────────────────────────────
    const onActivate = useCallback(
        (workspaceID: string, event: React.MouseEvent): void => {
            if (dragRef.current?.active === true) return;
            if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
            }
            if (event.metaKey || event.ctrlKey) {
                const next = new Set(selection);
                if (next.has(workspaceID)) next.delete(workspaceID);
                else next.add(workspaceID);
                setSelection(next);
                return;
            }
            if (event.shiftKey && selection.size > 0) {
                const anchor = [...selection][selection.size - 1] ?? workspaceID;
                const from = visibleOrder.indexOf(anchor);
                const to = visibleOrder.indexOf(workspaceID);
                if (from >= 0 && to >= 0) {
                    const [lo, hi] = from <= to ? [from, to] : [to, from];
                    setSelection(new Set(visibleOrder.slice(lo, hi + 1)));
                    return;
                }
            }
            setSelection(EMPTY_SELECTION);
            props.onActivateWorkspace?.(workspaceID);
        },
        [props, selection, setSelection, visibleOrder]
    );

    // ── collapse ────────────────────────────────────────────────────────────────
    const toggleCollapse = useCallback(
        (groupID: string): void => {
            const group = groups.find((candidate) => candidate.id === groupID);
            if (group === undefined) return;
            const current = isGroupCollapsed(group, { overrides: collapseOverrides });
            const next = new Map(collapseOverrides);
            next.set(groupID, !current);
            setCollapseOverrides(next);
            props.onToggleGroupCollapse?.(groupID, !current);
        },
        [collapseOverrides, groups, props]
    );

    // ── drag ────────────────────────────────────────────────────────────────────
    const contentY = useCallback((clientY: number): number => {
        const list = listRef.current;
        if (list === null) return clientY;
        const rect = list.getBoundingClientRect();
        return clientY - rect.top + list.scrollTop;
    }, []);

    const measuredHeights = useCallback((): ReadonlyMap<string, number> => {
        const heights = new Map<string, number>();
        for (const [key, element] of rowElements.current) {
            const height = element.getBoundingClientRect().height;
            if (height > 0) heights.set(key, height);
        }
        return heights;
    }, []);

    const onDragStart = useCallback(
        (kind: 'workspace' | 'group', id: string, event: React.MouseEvent): void => {
            if (event.button !== 0) return;
            if (rename !== null) return;
            const target = event.target as HTMLElement | null;
            if (target !== null && target.closest('input, button') !== null) return;
            // §5.5 multi-drag: grabbing a row that belongs to a ≥2 selection drags the whole
            // selection. Only the grabbed row live-applies (a single-row gap keeps the target
            // legible); the rest are hidden and land together on release.
            const multi = kind === 'workspace' && selection.size >= 2 && selection.has(id);
            const ids = multi ? visibleOrder.filter((candidate) => selection.has(candidate)) : [id];
            dragRef.current = {
                kind,
                id,
                startY: event.clientY,
                originModel: shadowRef.current ?? baseModel,
                ids,
                active: false,
                preview: null,
                clientY: event.clientY,
                springCandidate: null,
                springTimer: null
            };
            setDragID(id);
        },
        [baseModel, rename, selection, visibleOrder]
    );

    useEffect(() => {
        if (dragID === null) return;

        const cancelSpring = (drag: DragState): void => {
            if (drag.springTimer !== null) clearTimeout(drag.springTimer);
            drag.springTimer = null;
            drag.springCandidate = null;
        };

        /**
         * The group the cursor is currently over, whether it is hovering the header or the band
         * where its children would be — that second case is what makes a spring-load feel like
         * "I am trying to get in here" rather than "I touched a header".
         */
        const groupUnder = (target: DropTarget | null): string | null => {
            if (target === null) return null;
            if (target.kind === 'ontoGroupHeader') return target.groupID;
            if (target.kind === 'intoGroup') return target.groupID;
            return null;
        };

        const updateSpring = (drag: DragState, target: DropTarget | null): void => {
            const groupID = groupUnder(target);
            if (groupID === null) {
                // Left the group: cancel the dwell AND collapse it again (§5.5).
                cancelSpring(drag);
                setSpringLoadedGroupID((current) => (current === null ? current : null));
                return;
            }
            if (drag.springCandidate === groupID) return;
            cancelSpring(drag);
            const group = groupsRef.current.find((candidate) => candidate.id === groupID);
            // Only a COLLAPSED group springs; an expanded one is already open.
            if (group === undefined || !isGroupCollapsed(group, { overrides: collapseRef.current.overrides })) {
                setSpringLoadedGroupID((current) => (current === groupID ? current : null));
                return;
            }
            drag.springCandidate = groupID;
            drag.springTimer = setTimeout(() => {
                drag.springTimer = null;
                if (dragRef.current !== drag || drag.springCandidate !== groupID) return;
                setSpringLoadedGroupID(groupID);
            }, springLoadMs);
        };

        /** Resolve the cursor against the current geometry and apply/preview the result. */
        const resolve = (drag: DragState): void => {
            const current = shadowRef.current ?? drag.originModel;
            const y = contentY(drag.clientY);
            const heights = measuredHeights();
            if (drag.kind === 'group') {
                const spans = buildGroupSpans(current, rowsRef.current, {
                    heights,
                    rowHeight,
                    contentTop: CONTENT_TOP_PADDING
                });
                const index = resolveGroupDropIndex(spans, y, drag.id);
                if (index === null) return;
                setShadow(applyGroupDrop(current, drag.id, index));
                return;
            }
            const layout = buildDropZones(current, rowsRef.current, {
                heights,
                rowHeight,
                contentTop: CONTENT_TOP_PADDING,
                // Every dragged row is omitted as a target and excluded from the post-remove
                // indices, so a multi-drag's arithmetic already describes the bulk landing.
                dragging: new Set(drag.ids)
            });
            const target = resolveDropTarget(layout, y);
            updateSpring(drag, target);
            if (target === null) return;
            if (target.kind === 'ontoGroupHeader') {
                // Preview-only: the cursor transits headers constantly (§5.5), so the order
                // is NOT live-applied — the header is tinted and the move waits for release.
                drag.preview = target;
                setPreviewGroupID(target.groupID);
                return;
            }
            drag.preview = null;
            setPreviewGroupID(null);
            setShadow(applyWorkspaceDrop(current, drag.id, target));
        };

        /**
         * §5.5 auto-scroll. The OS emits no mousemove while the pointer is stationary, so each
         * tick re-derives the content-space cursor from the STORED client position and re-runs
         * the whole resolution — otherwise the list would scroll under a frozen drop target.
         */
        let autoScrollTimer: ReturnType<typeof setInterval> | null = null;
        const stopAutoScroll = (): void => {
            if (autoScrollTimer === null) return;
            clearInterval(autoScrollTimer);
            autoScrollTimer = null;
        };
        const autoScrollDelta = (clientY: number): number => {
            const list = listRef.current;
            if (list === null) return 0;
            const rect = list.getBoundingClientRect();
            if (rect.height <= 0) return 0;
            if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) return -AUTO_SCROLL_STEP_PX;
            if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) return AUTO_SCROLL_STEP_PX;
            return 0;
        };
        const syncAutoScroll = (drag: DragState): void => {
            const delta = autoScrollDelta(drag.clientY);
            if (delta === 0) {
                stopAutoScroll();
                return;
            }
            if (autoScrollTimer !== null) return;
            autoScrollTimer = setInterval(() => {
                const live = dragRef.current;
                const list = listRef.current;
                if (live === null || list === null) {
                    stopAutoScroll();
                    return;
                }
                const step = autoScrollDelta(live.clientY);
                if (step === 0) {
                    stopAutoScroll();
                    return;
                }
                const before = list.scrollTop;
                list.scrollTop = before + step;
                if (list.scrollTop === before) {
                    // Hit an end: nothing more to scroll, so stop burning a timer on it.
                    stopAutoScroll();
                    return;
                }
                resolve(live);
            }, autoScrollIntervalMs);
        };

        const onMove = (event: MouseEvent): void => {
            const drag = dragRef.current;
            if (drag === null) return;
            drag.clientY = event.clientY;
            if (!drag.active) {
                if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
                drag.active = true;
            }
            syncAutoScroll(drag);
            resolve(drag);
        };

        const onUp = (): void => {
            const drag = dragRef.current;
            dragRef.current = null;
            stopAutoScroll();
            if (drag !== null) cancelSpring(drag);
            setDragID(null);
            setPreviewGroupID(null);
            // §5.5: the spring-loaded group stays open through the drop, then collapses.
            setSpringLoadedGroupID(null);
            if (drag === null || !drag.active) return;
            suppressClickRef.current = true;

            let final = shadowRef.current ?? drag.originModel;
            if (drag.preview !== null) final = applyWorkspaceDrop(final, drag.id, drag.preview);
            if (final !== shadowRef.current) setShadow(final);

            if (drag.kind === 'group') {
                const index = groupCommit(drag.originModel, final, drag.id);
                if (index !== null) props.onMoveGroup?.({ groupID: drag.id, index });
                return;
            }
            const commit = workspaceCommit(drag.originModel, final, drag.id);
            if (commit === null) return;
            if (drag.ids.length > 1 && props.onMoveWorkspaces !== undefined) {
                // The grabbed row's landing spot IS the selection's landing spot: the zones it
                // was resolved against already had every dragged row detached.
                props.onMoveWorkspaces({
                    workspaceIDs: drag.ids,
                    groupID: commit.groupID,
                    index: commit.index
                });
                return;
            }
            props.onMoveWorkspace?.({
                workspaceID: drag.id,
                groupID: commit.groupID,
                index: commit.index
            });
        };

        const target = globalThis.window;
        target.addEventListener('mousemove', onMove);
        target.addEventListener('mouseup', onUp);
        return () => {
            target.removeEventListener('mousemove', onMove);
            target.removeEventListener('mouseup', onUp);
            stopAutoScroll();
            const drag = dragRef.current;
            if (drag !== null) cancelSpring(drag);
        };
    }, [autoScrollIntervalMs, contentY, dragID, measuredHeights, props, rowHeight, springLoadMs]);

    // §15: scroll the entry THIS client just created into view, exactly once. A row that has
    // not rendered yet simply waits for the commit that renders it.
    const scrollTarget = props.scrollToWorkspaceID ?? null;
    const onScrollHandled = props.onScrollHandled;
    useEffect(() => {
        if (scrollTarget === null) return;
        const element = rowElements.current.get(`ws:${scrollTarget}`);
        if (element === undefined) return;
        element.scrollIntoView?.({ block: 'nearest' });
        onScrollHandled?.();
    }, [scrollTarget, onScrollHandled, rows]);

    // ── menus ───────────────────────────────────────────────────────────────────
    const closeMenu = useCallback((): void => {
        setMenu(null);
    }, []);

    const shortcut = useCallback(
        (action: NexAction): string | undefined =>
            props.keyBindings === undefined ? undefined : shortcutForAction(props.keyBindings, action),
        [props.keyBindings]
    );

    /**
     * §5.6's "Change Icon ▸" submenu, shared by the workspace and group menus (they differ only
     * in which callback the choice lands on). Tokens pass through verbatim, so this client never
     * has to be able to DRAW a symbol in order to set one.
     *
     * The doc nests a further level ("Symbol ▸", "Emoji ▸"); `ContextMenu` is deliberately one
     * level deep (§5.6/§5.7 are the only menus and nothing else needs two), so the two groups
     * become caption-separated sections of one list instead — same choices, one fewer hover.
     */
    const iconSubmenu = useCallback(
        (kind: 'workspace' | 'group', id: string, current: IconRef | null): MenuItemSpec[] => {
            const apply = (icon: string | null): void => {
                if (kind === 'workspace') props.onSetWorkspaceIcon?.(id, icon);
                else props.onSetGroupIcon?.(id, icon);
            };
            return [
                { id: 'icon:symbols', label: 'Symbol', kind: 'caption' },
                ...CURATED_SYMBOL_ICONS.map(
                    (choice): MenuItemSpec => ({
                        id: `icon:symbol:${choice.name}`,
                        label: `${iconGlyph({ kind: 'system', name: choice.name }) ?? ''}  ${choice.label}`,
                        checked: current?.kind === 'system' && current.name === choice.name,
                        onSelect: () => apply(`system:${choice.name}`)
                    })
                ),
                { id: 'icon:emojis', label: 'Emoji', kind: 'caption' },
                ...CURATED_EMOJI.map(
                    (grapheme): MenuItemSpec => ({
                        id: `icon:emoji:${grapheme}`,
                        label: grapheme,
                        checked: current?.kind === 'emoji' && current.grapheme === grapheme,
                        onSelect: () => apply(`emoji:${grapheme}`)
                    })
                ),
                { id: 'icon:sep', label: '', kind: 'separator' },
                {
                    id: 'icon:custom',
                    label: 'Custom Emoji…',
                    onSelect: () => {
                        setEmojiSheet({ kind, id });
                    }
                },
                {
                    id: 'icon:reset',
                    label: 'Reset to Letter',
                    disabled: current === null,
                    onSelect: () => apply(null)
                }
            ];
        },
        [props]
    );

    /**
     * Selected workspaces in SIDEBAR order, with any selected member the sidebar cannot show
     * (a collapsed group's child) appended. §WS-057: the bulk menu's counts must cover the whole
     * live selection, not just the rows on screen, or the tri-state would lie the moment a group
     * is collapsed.
     */
    const orderedSelection = useCallback((): string[] => {
        const visible = visibleOrder.filter((id) => selection.has(id));
        const hidden = [...selection]
            .filter((id) => !visible.includes(id) && workspaceByID.has(id))
            .sort();
        return [...visible, ...hidden];
    }, [selection, visibleOrder, workspaceByID]);

    /**
     * §5.6's bulk menu variant (§WS-055…§WS-060): right-clicking a row that is part of a ≥2
     * selection swaps the whole menu, headed by an inert "N workspaces selected" caption. Every
     * action here goes out as ONE command for the whole selection.
     */
    const bulkMenuItems = useCallback((): MenuItemSpec[] => {
        const ids = orderedSelection();
        const count = ids.length;
        const total = workspaceByID.size;
        const inAnyGroup = ids.some((id) => groupIDForWorkspace(id) !== null);

        // §WS-057's tri-state: a preset applied to every selected workspace shows a checkmark
        // and clicking REMOVES it; applied to some shows the dash; clicking anything not
        // universally applied applies it to all.
        const labelCount = (label: string): number =>
            ids.reduce((sum, id) => sum + ((workspaceByID.get(id)?.labels.includes(label) ?? false) ? 1 : 0), 0);
        const labelRow = (label: string, swatch: string | undefined): MenuItemSpec => {
            const applied = labelCount(label);
            const all = count > 0 && applied === count;
            const state: boolean | 'mixed' = all ? true : applied > 0 ? 'mixed' : false;
            return {
                id: `bulk-label:${label}`,
                label,
                checked: state,
                ...(swatch === undefined ? {} : { swatch }),
                onSelect: () => {
                    props.onSetBulkLabel?.(ids, label, !all);
                }
            };
        };
        // Free-form labels present on ANY selected workspace, deduped in selection order.
        const presetNames = new Set(presets.map((preset) => preset.name));
        const freeform: string[] = [];
        for (const id of ids) {
            for (const label of workspaceByID.get(id)?.labels ?? []) {
                if (!presetNames.has(label) && !freeform.includes(label)) freeform.push(label);
            }
        }

        return [
            { id: 'bulk-caption', label: `${String(count)} workspaces selected`, kind: 'caption' },
            {
                id: 'bulk-color',
                label: `Color ${String(count)} Workspaces`,
                submenu: WORKSPACE_COLORS.map((color) => ({
                    id: `bulk-color:${color}`,
                    label: color,
                    swatch: workspaceColorHex(color, bucket),
                    onSelect: () => {
                        props.onSetBulkColor?.(ids, color);
                    }
                }))
            },
            {
                id: 'bulk-labels',
                label: `Label ${String(count)} Workspaces`,
                submenu: [
                    ...(presets.length === 0 && freeform.length === 0
                        ? [{ id: 'bulk-no-labels', label: 'No presets', kind: 'caption' } satisfies MenuItemSpec]
                        : []),
                    ...presets.map((preset) =>
                        labelRow(preset.name, resolveLabelStyle(preset.name, presets, bucket).background)
                    ),
                    ...(freeform.length === 0
                        ? []
                        : [
                              { id: 'bulk-label-sep', label: '', kind: 'separator' } satisfies MenuItemSpec,
                              ...freeform.map((label) => labelRow(label, undefined))
                          ]),
                    ...(props.onOpenSettings === undefined
                        ? []
                        : [
                              { id: 'bulk-label-sep2', label: '', kind: 'separator' } satisfies MenuItemSpec,
                              {
                                  id: 'bulk-manage-labels',
                                  label: 'Manage Labels…',
                                  onSelect: () => {
                                      props.onOpenSettings?.('labels');
                                  }
                              } satisfies MenuItemSpec
                          ])
                ]
            },
            {
                id: 'bulk-group',
                label: `Group ${String(count)} Workspaces…`,
                disabled: props.onCreateGroupForWorkspaces === undefined,
                onSelect: () => {
                    setNewForm({ kind: 'group', groupID: null, workspaceIDs: ids });
                }
            },
            ...(groups.length === 0 && !inAnyGroup
                ? []
                : [
                      {
                          id: 'bulk-move',
                          label: `Move ${String(count)} Workspaces to Group`,
                          submenu: [
                              ...(inAnyGroup
                                  ? [
                                        {
                                            id: 'bulk-move:top',
                                            label: 'Remove from Group',
                                            onSelect: () => {
                                                props.onMoveWorkspaces?.({
                                                    workspaceIDs: ids,
                                                    groupID: null,
                                                    index: baseModel.topLevel.length
                                                });
                                            }
                                        } satisfies MenuItemSpec,
                                        { id: 'bulk-move:sep', label: '', kind: 'separator' } satisfies MenuItemSpec
                                    ]
                                  : []),
                              ...groups.map(
                                  (group): MenuItemSpec => ({
                                      id: `bulk-move:${group.id}`,
                                      label: group.name,
                                      // Disabled only when EVERY selected workspace already lives there.
                                      disabled: ids.every((id) => groupIDForWorkspace(id) === group.id),
                                      onSelect: () => {
                                          props.onMoveWorkspaces?.({
                                              workspaceIDs: ids,
                                              groupID: group.id,
                                              index: (baseModel.children.get(group.id) ?? []).length
                                          });
                                      }
                                  })
                              )
                          ]
                      } satisfies MenuItemSpec
                  ]),
            { id: 'bulk-sep', label: '', kind: 'separator' },
            {
                id: 'bulk-select-all',
                label: 'Select All Workspaces',
                disabled: count >= total,
                onSelect: () => {
                    setSelection(new Set(workspaceByID.keys()));
                }
            },
            {
                id: 'bulk-deselect',
                label: 'Deselect All',
                onSelect: () => {
                    setSelection(EMPTY_SELECTION);
                }
            },
            { id: 'bulk-sep2', label: '', kind: 'separator' },
            {
                id: 'bulk-delete',
                label: `Delete ${String(count)} Workspaces…`,
                danger: true,
                // §WS-060: deleting the entire list is refused, not merely discouraged.
                disabled: count >= total,
                onSelect: () => {
                    setConfirm({ kind: 'workspaces', ids });
                }
            }
        ];
    }, [baseModel, bucket, groupIDForWorkspace, groups, orderedSelection, presets, props, setSelection, workspaceByID]);

    const workspaceMenuItems = useCallback(
        (workspaceID: string): MenuItemSpec[] => {
            const workspace = workspaceByID.get(workspaceID);
            if (workspace === undefined) return [];
            const currentGroup = groupIDForWorkspace(workspaceID);
            const applied = new Set(workspace.labels);
            const presetItems: MenuItemSpec[] = presets.map((preset) => ({
                id: `label:${preset.name}`,
                label: preset.name,
                checked: applied.has(preset.name),
                swatch: resolveLabelStyle(preset.name, presets, bucket).background,
                onSelect: () => {
                    props.onToggleWorkspaceLabel?.(workspaceID, preset.name, !applied.has(preset.name));
                }
            }));
            const freeform: MenuItemSpec[] = workspace.labels
                .filter((label) => !presets.some((preset) => preset.name === label))
                .map((label) => ({
                    id: `freelabel:${label}`,
                    label,
                    checked: true,
                    onSelect: () => {
                        props.onToggleWorkspaceLabel?.(workspaceID, label, false);
                    }
                }));

            return [
                {
                    id: 'rename',
                    label: 'Rename…',
                    ...(shortcut('rename_workspace') === undefined
                        ? {}
                        : { shortcut: shortcut('rename_workspace') }),
                    onSelect: () => {
                        setRename({ kind: 'workspace', id: workspaceID });
                    }
                },
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('workspace', workspaceID, workspace.icon)
                },
                {
                    id: 'color',
                    label: 'Color',
                    submenu: WORKSPACE_COLORS.map((color) => ({
                        id: `color:${color}`,
                        label: color,
                        checked: workspace.color === color,
                        swatch: workspaceColorHex(color, bucket),
                        onSelect: () => {
                            props.onSetWorkspaceColor?.(workspaceID, color);
                        }
                    }))
                },
                {
                    id: 'labels',
                    label: 'Labels',
                    submenu: [
                        ...(presetItems.length + freeform.length === 0
                            ? [{ id: 'no-labels', label: 'No presets', kind: 'caption' } satisfies MenuItemSpec]
                            : [...presetItems, ...freeform]),
                        // shell-ui.md §5.7: the submenu offers existing presets only, so this is
                        // the way to CREATE or recolor one.
                        ...(props.onOpenSettings === undefined
                            ? []
                            : [
                                  {
                                      id: 'manage-labels',
                                      label: 'Manage Labels…',
                                      onSelect: () => {
                                          props.onOpenSettings?.('labels');
                                      }
                                  } satisfies MenuItemSpec
                              ])
                    ]
                },
                {
                    id: 'move',
                    label: 'Move to Group',
                    submenu: [
                        ...(currentGroup === null
                            ? []
                            : [
                                  {
                                      id: 'move:top',
                                      label: 'Remove from Group',
                                      onSelect: () => {
                                          props.onMoveWorkspace?.({
                                              workspaceID,
                                              groupID: null,
                                              index: baseModel.topLevel.length
                                          });
                                      }
                                  } satisfies MenuItemSpec
                              ]),
                        ...groups.map(
                            (group): MenuItemSpec => ({
                                id: `move:${group.id}`,
                                label: group.name,
                                disabled: group.id === currentGroup,
                                onSelect: () => {
                                    props.onMoveWorkspace?.({
                                        workspaceID,
                                        groupID: group.id,
                                        index: (baseModel.children.get(group.id) ?? []).length
                                    });
                                }
                            })
                        )
                    ]
                },
                { id: 'sep', label: '', kind: 'separator' },
                // §WS-053: the single-row menu carries the selection verbs too — "Select All"
                // dimmed once everything is selected, "Deselect All" only while a selection
                // exists. Select All covers members hidden inside collapsed groups (§WS-045).
                {
                    id: 'select-all',
                    label: 'Select All Workspaces',
                    disabled: selection.size >= workspaceByID.size,
                    onSelect: () => {
                        setSelection(new Set(workspaceByID.keys()));
                    }
                },
                ...(selection.size === 0
                    ? []
                    : [
                          {
                              id: 'deselect-all',
                              label: 'Deselect All',
                              onSelect: () => {
                                  setSelection(EMPTY_SELECTION);
                              }
                          } satisfies MenuItemSpec
                      ]),
                { id: 'sep2', label: '', kind: 'separator' },
                {
                    id: 'delete',
                    label: 'Delete',
                    danger: true,
                    disabled: workspaceByID.size <= 1,
                    onSelect: () => {
                        // WS-108: the count only enters the dialog while the daemon's
                        // `confirm-workspace-delete` is on — with it off, the delete is the
                        // plain confirmation it has always been, and the alert never fires.
                        const active =
                            props.confirmDeleteWhenActive === false
                                ? 0
                                : (props.activeAgentCount?.(workspaceID) ?? 0);
                        setConfirm({
                            kind: 'workspace',
                            id: workspaceID,
                            name: workspace.name,
                            ...(active > 0 ? { activeAgents: active } : {})
                        });
                    }
                }
            ];
        },
        [
            baseModel,
            bucket,
            groupIDForWorkspace,
            groups,
            iconSubmenu,
            presets,
            props,
            selection,
            setSelection,
            shortcut,
            workspaceByID
        ]
    );

    const groupMenuItems = useCallback(
        (groupID: string): MenuItemSpec[] => {
            const group = groups.find((candidate) => candidate.id === groupID);
            if (group === undefined) return [];
            const collapsed = isGroupCollapsed(group, { overrides: collapseOverrides });
            return [
                {
                    id: 'new-workspace',
                    label: 'New Workspace',
                    ...(shortcut('new_workspace') === undefined ? {} : { shortcut: shortcut('new_workspace') }),
                    onSelect: () => {
                        setNewForm({ kind: 'workspace', groupID });
                    }
                },
                { id: 'sep1', label: '', kind: 'separator' },
                {
                    id: 'rename',
                    label: 'Rename…',
                    onSelect: () => {
                        setRename({ kind: 'group', id: groupID });
                    }
                },
                {
                    id: 'icon',
                    label: 'Change Icon',
                    submenu: iconSubmenu('group', groupID, group.icon)
                },
                {
                    id: 'collapse',
                    label: collapsed ? 'Expand' : 'Collapse',
                    onSelect: () => {
                        toggleCollapse(groupID);
                    }
                },
                { id: 'sep2', label: '', kind: 'separator' },
                {
                    id: 'delete',
                    label: 'Delete Group…',
                    danger: true,
                    onSelect: () => {
                        setConfirm({ kind: 'group', id: groupID, name: group.name });
                    }
                }
            ];
        },
        [collapseOverrides, groups, iconSubmenu, shortcut, toggleCollapse]
    );

    const backgroundMenuItems = useCallback(
        (): MenuItemSpec[] => [
            {
                id: 'new-workspace',
                label: 'New Workspace',
                ...(shortcut('new_workspace') === undefined ? {} : { shortcut: shortcut('new_workspace') }),
                onSelect: () => {
                    setNewForm({ kind: 'workspace', groupID: null });
                }
            },
            {
                id: 'new-group',
                label: 'New Group',
                ...(shortcut('new_group') === undefined ? {} : { shortcut: shortcut('new_group') }),
                onSelect: () => {
                    setNewForm({ kind: 'group', groupID: null });
                }
            }
        ],
        [shortcut]
    );

    const menuItems = useMemo((): readonly MenuItemSpec[] => {
        if (menu === null) return [];
        // §WS-055: a right-click ON a row that belongs to a ≥2 selection is a BULK gesture.
        if (menu.kind === 'workspace' && selection.size > 1 && selection.has(menu.id)) return bulkMenuItems();
        if (menu.kind === 'workspace') return workspaceMenuItems(menu.id);
        if (menu.kind === 'group') return groupMenuItems(menu.id);
        return backgroundMenuItems();
    }, [backgroundMenuItems, bulkMenuItems, groupMenuItems, menu, selection, workspaceMenuItems]);

    /**
     * The row itself is what the menu must not cover (run-B m7): `currentTarget` is the row
     * element the handler is bound to, so its rect is the thing to dodge.
     */
    const onWorkspaceContextMenu = useCallback((workspaceID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event, rowRect(event));
        setMenu({ kind: 'workspace', id: workspaceID, x: anchor.x, y: anchor.y });
    }, []);

    const onGroupContextMenu = useCallback((groupID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event, rowRect(event));
        setMenu({ kind: 'group', id: groupID, x: anchor.x, y: anchor.y });
    }, []);

    const onBackgroundContextMenu = useCallback((event: React.MouseEvent): void => {
        event.preventDefault();
        const anchor = menuAnchorFromEvent(event);
        setMenu({ kind: 'background', x: anchor.x, y: anchor.y });
    }, []);

    // ── rename commits ──────────────────────────────────────────────────────────
    const cancelRename = useCallback((): void => {
        setRename(null);
    }, []);
    const commitWorkspaceRename = useCallback(
        (workspaceID: string, name: string): void => {
            setRename(null);
            props.onRenameWorkspace?.(workspaceID, name);
        },
        [props]
    );
    const commitGroupRename = useCallback(
        (groupID: string, name: string): void => {
            setRename(null);
            props.onRenameGroup?.(groupID, name);
        },
        [props]
    );

    /**
     * §5.5 multi-drag: the selected rows that are NOT the grabbed one. They collapse to zero
     * height for the duration so the list shows a single moving row and one gap, and the
     * grabbed row wears a `+N` capsule for the rest.
     */
    const dragCompanions = useMemo((): ReadonlySet<string> => {
        if (dragID === null) return EMPTY_SELECTION;
        if (!selection.has(dragID) || selection.size < 2) return EMPTY_SELECTION;
        const companions = new Set(selection);
        companions.delete(dragID);
        return companions;
    }, [dragID, selection]);

    // ── filtered list ───────────────────────────────────────────────────────────
    const needle = props.filter.trim();
    const filtered = useMemo(
        () => (needle.length === 0 ? [] : filteredRows(props.entries, needle)),
        [needle, props.entries]
    );

    const dragStartWorkspace = useCallback(
        (workspaceID: string, event: React.MouseEvent) => {
            if (needle.length > 0) return; // §5.1: no drag & drop in the filtered list.
            onDragStart('workspace', workspaceID, event);
        },
        [needle.length, onDragStart]
    );
    const dragStartGroup = useCallback(
        (groupID: string, event: React.MouseEvent) => {
            onDragStart('group', groupID, event);
        },
        [onDragStart]
    );

    const body =
        needle.length > 0 ? (
            <div data-testid="sidebar-filtered">
                {filtered.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[12px]" style={{ color: tokens.textTertiary }}>
                        <div style={{ color: tokens.textSecondary }}>No matches</div>
                        <div>Try a different filter or clear the field.</div>
                    </div>
                ) : (
                    filtered.map((row) => (
                        <WorkspaceRow
                            key={row.workspace.id}
                            workspace={row.workspace}
                            depth={0}
                            active={row.workspace.id === props.activeWorkspaceID}
                            selected={selection.has(row.workspace.id)}
                            badgeIndex={-1}
                            bucket={bucket}
                            presets={presets}
                            renaming={rename?.kind === 'workspace' && rename.id === row.workspace.id}
                            dragging={false}
                            groupCaption={row.groupName}
                            onActivate={(id, event) => {
                                if (event.metaKey || event.ctrlKey || event.shiftKey) {
                                    const next = new Set(selection);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    setSelection(next);
                                    return;
                                }
                                props.onActivateWorkspace?.(id);
                                props.onFilterChange('');
                            }}
                            onContextMenu={onWorkspaceContextMenu}
                            onDragStart={dragStartWorkspace}
                            onCommitRename={commitWorkspaceRename}
                            onCancelRename={cancelRename}
                            registerRow={registerRow}
                        />
                    ))
                )}
            </div>
        ) : (
            <div data-testid="sidebar-list">
                {rows.map((row) => {
                    if (row.kind === 'group-header') {
                        const entry = effectiveEntries.find(
                            (candidate) => candidate.kind === 'group' && candidate.group.id === row.groupID
                        );
                        if (entry === undefined || entry.kind !== 'group') return null;
                        return (
                            <GroupHeaderRow
                                key={row.key}
                                group={entry.group}
                                collapsed={isGroupCollapsed(entry.group, collapse)}
                                counts={agentCounts(entry.workspaces)}
                                bucket={bucket}
                                renaming={rename?.kind === 'group' && rename.id === entry.group.id}
                                dropPreview={previewGroupID === entry.group.id}
                                onToggle={toggleCollapse}
                                onContextMenu={onGroupContextMenu}
                                onDragStart={dragStartGroup}
                                onCommitRename={commitGroupRename}
                                onCancelRename={cancelRename}
                                registerRow={registerRow}
                            />
                        );
                    }
                    if (row.kind === 'group-empty') {
                        return (
                            <div
                                key={row.key}
                                data-testid="group-empty"
                                className="ml-6 py-1.5 pl-2 text-[12px]"
                                style={{ color: tokens.textTertiary }}
                                onContextMenu={(event) => {
                                    onGroupContextMenu(row.groupID, event);
                                }}
                                ref={(element) => {
                                    registerRow(row.key, element);
                                }}
                            >
                                No workspaces
                            </div>
                        );
                    }
                    const workspace = workspaceByID.get(row.workspaceID);
                    if (workspace === undefined) return null;
                    return (
                        <WorkspaceRow
                            key={row.key}
                            workspace={workspace}
                            depth={row.depth}
                            active={workspace.id === props.activeWorkspaceID}
                            selected={selection.has(workspace.id)}
                            badgeIndex={visibleOrder.indexOf(workspace.id)}
                            bucket={bucket}
                            presets={presets}
                            renaming={rename?.kind === 'workspace' && rename.id === workspace.id}
                            dragging={dragID === workspace.id}
                            dragHidden={dragCompanions.has(workspace.id)}
                            dragExtra={dragID === workspace.id ? dragCompanions.size : 0}
                            groupCaption={null}
                            onActivate={onActivate}
                            onContextMenu={onWorkspaceContextMenu}
                            onDragStart={dragStartWorkspace}
                            onCommitRename={commitWorkspaceRename}
                            onCancelRename={cancelRename}
                            registerRow={registerRow}
                        />
                    );
                })}
            </div>
        );

    return (
        <div
            data-testid="sidebar"
            className="flex h-full min-h-0 flex-col"
            style={{ background: tokens.sidebarBackground, color: tokens.textPrimary }}
        >
            <div className="p-2">
                <div
                    className="flex items-center gap-1.5 rounded-[10px] px-2 py-1"
                    style={{
                        background: withAlpha('#E6E6EA', 0.05),
                        border: `1px solid ${withAlpha('#E6E6EA', 0.08)}`
                    }}
                >
                    <span style={{ color: tokens.textTertiary }}>
                        <ChromeIcon name="search" />
                    </span>
                    <input
                        aria-label="Filter workspaces or labels"
                        placeholder="Filter workspaces or labels"
                        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
                        style={{ color: tokens.textPrimary }}
                        value={props.filter}
                        onChange={(event) => {
                            props.onFilterChange(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                                const first = filtered[0];
                                if (first !== undefined) props.onActivateWorkspace?.(first.workspace.id);
                                props.onFilterChange('');
                                event.currentTarget.blur();
                                return;
                            }
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onFilterChange('');
                                event.currentTarget.blur();
                            }
                        }}
                    />
                    {props.filter.length > 0 ? (
                        <button
                            type="button"
                            aria-label="Clear filter"
                            style={{ color: tokens.textTertiary }}
                            onClick={() => {
                                props.onFilterChange('');
                            }}
                        >
                            <ChromeIcon name="clear" />
                        </button>
                    ) : null}
                </div>
            </div>

            {selection.size > 0 ? (
                <div
                    data-testid="selection-header"
                    className="flex items-center gap-2 px-3 py-1 text-[11px]"
                    style={{ background: withAlpha('#6F9BD8', 0.12), color: tokens.textSecondary }}
                >
                    <span className="flex-1">{selection.size} selected</span>
                    <button
                        type="button"
                        onClick={() => {
                            setSelection(new Set(visibleOrder));
                        }}
                    >
                        Select All
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setSelection(EMPTY_SELECTION);
                        }}
                    >
                        Clear
                    </button>
                </div>
            ) : null}

            <div
                ref={listRef}
                className="min-h-0 flex-1 overflow-y-auto px-2 pr-3"
                style={{ paddingTop: CONTENT_TOP_PADDING }}
                onContextMenu={onBackgroundContextMenu}
                role="listbox"
                aria-label="Workspaces"
            >
                {body}
                <div className="h-8" data-testid="sidebar-spacer" />
            </div>

            <div
                className="flex flex-col gap-1 border-t p-2"
                style={{ borderColor: tokens.divider, background: tokens.sidebarBackground }}
            >
                {newForm === null ? (
                    <div className="flex items-center gap-2">
                        {/*
                          * ⌘N is New Workspace's shortcut, so it rides INSIDE that button. It
                          * used to sit `ml-auto` after "New Group", which reads as New Group's
                          * shortcut — the audit's nit list opened with it (run-B).
                          */}
                        <button
                            type="button"
                            data-testid="sidebar-new-workspace"
                            aria-label="New Workspace"
                            title="New Workspace (⌘N)"
                            className="flex items-center gap-1 text-[12px]"
                            style={{ color: tokens.textSecondary }}
                            onClick={() => {
                                setNewForm({ kind: 'workspace', groupID: null });
                            }}
                        >
                            <ChromeIcon name="plus" /> New Workspace
                            <span className="font-mono text-[10px]" style={{ color: tokens.textTertiary }}>
                                ⌘N
                            </span>
                        </button>
                        <button
                            type="button"
                            className="text-[12px]"
                            style={{ color: tokens.textSecondary }}
                            onClick={() => {
                                setNewForm({ kind: 'group', groupID: null });
                            }}
                        >
                            New Group
                        </button>
                        {props.onOpenSettings === undefined ? null : (
                            <button
                                type="button"
                                data-testid="sidebar-settings"
                                aria-label="Settings"
                                title="Settings (⌘,)"
                                className="ml-auto flex items-center"
                                style={{ color: tokens.textSecondary }}
                                onClick={() => {
                                    props.onOpenSettings?.();
                                }}
                            >
                                <ChromeIcon name="gear" />
                            </button>
                        )}
                    </div>
                ) : (
                    <NewEntryForm
                        kind={newForm.kind}
                        repos={props.repos ?? EMPTY_REPOS}
                        {...(newForm.workspaceIDs === undefined
                            ? {}
                            : { workspaceCount: newForm.workspaceIDs.length })}
                        onCancel={() => {
                            setNewForm(null);
                        }}
                        onSubmit={async (name, worktree) => {
                            const members = newForm.workspaceIDs;
                            if (newForm.kind === 'group') {
                                // §WS-058: a group raised from the bulk menu is created AROUND
                                // the selection, in one command, and the selection is released.
                                if (members !== undefined && props.onCreateGroupForWorkspaces !== undefined) {
                                    props.onCreateGroupForWorkspaces(name, members);
                                    setSelection(EMPTY_SELECTION);
                                } else props.onCreateGroup?.(name);
                                setNewForm(null);
                                return null;
                            }
                            const result = await props.onCreateWorkspace?.(name, newForm.groupID, worktree);
                            // §WS-079: a failed worktree create keeps the form open, inline.
                            if (typeof result === 'string') return result;
                            setNewForm(null);
                            return null;
                        }}
                    />
                )}
            </div>

            {menu === null ? null : (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    items={menuItems}
                    onClose={closeMenu}
                    label={menu.kind === 'group' ? 'Group menu' : 'Workspace menu'}
                />
            )}

            {emojiSheet === null ? null : (
                <CustomEmojiSheet
                    onCancel={() => {
                        setEmojiSheet(null);
                    }}
                    onSubmit={(grapheme) => {
                        if (emojiSheet.kind === 'workspace') {
                            props.onSetWorkspaceIcon?.(emojiSheet.id, `emoji:${grapheme}`);
                        } else {
                            props.onSetGroupIcon?.(emojiSheet.id, `emoji:${grapheme}`);
                        }
                        setEmojiSheet(null);
                    }}
                />
            )}

            {confirm === null ? null : (
                <ConfirmDialog
                    confirm={confirm}
                    onCancel={(suppress) => {
                        // macOS HIG (`WorkspaceDeleteGate.swift:78`): the suppression box is
                        // honoured whichever button ended the dialog, Cancel included.
                        if (suppress) props.onSuppressDeleteConfirm?.();
                        setConfirm(null);
                    }}
                    onConfirm={(cascade, suppress) => {
                        if (suppress) props.onSuppressDeleteConfirm?.();
                        if (confirm.kind === 'workspace') props.onDeleteWorkspace?.(confirm.id);
                        else if (confirm.kind === 'group') props.onDeleteGroup?.(confirm.id, cascade);
                        else if (props.onDeleteWorkspaces !== undefined) props.onDeleteWorkspaces(confirm.ids);
                        // No bulk callback wired: N single deletes still beat doing nothing.
                        else for (const id of confirm.ids) props.onDeleteWorkspace?.(id);
                        if (confirm.kind === 'workspaces') setSelection(EMPTY_SELECTION);
                        setConfirm(null);
                    }}
                />
            )}
        </div>
    );
}

// ── inline forms & dialogs ──────────────────────────────────────────────────────────

interface NewEntryFormProps {
    readonly kind: 'workspace' | 'group';
    /** Registry entries offered by the "Create git worktree" section (§WS-078). */
    readonly repos?: readonly ChromeRepo[] | undefined;
    /** Set when the bulk menu raised this form: "New Group for N workspaces". */
    readonly workspaceCount?: number | undefined;
    readonly onSubmit: (name: string, worktree?: WorkspaceWorktreeRequest | undefined) => Promise<string | null>;
    readonly onCancel: () => void;
}

/**
 * The footer's New Workspace / New Group form, plus §WS-078's inline **Create git worktree**
 * section — the GUI half of `nex workspace create --worktree`.
 *
 * Everything the shipped sheet does, in the port's inline form: the branch mirrors the worktree
 * name until the branch is hand-edited, "Update main first" rides through as `--update-main`,
 * the preview shows the SANITIZED folder and branch so an unusable name is visible before git
 * refuses it (issue #218), Create is disabled until both sanitize, a second submit is refused
 * while `git worktree add` is running, and a failure is rendered inline with the form still
 * open and Create live again (§WS-079).
 */
function NewEntryForm(props: NewEntryFormProps): ReactElement {
    const repos = props.repos ?? EMPTY_REPOS;
    const [value, setValue] = useState('');
    const [worktree, setWorktree] = useState(false);
    const [repoID, setRepoID] = useState<string>(repos[0]?.id ?? '');
    const [worktreeName, setWorktreeName] = useState('');
    const [branch, setBranch] = useState('');
    const [branchEdited, setBranchEdited] = useState(false);
    const [updateMain, setUpdateMain] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);

    const repo = repos.find((candidate) => candidate.id === repoID) ?? repos[0] ?? null;
    const preview = worktreePreview({
        name: worktreeName,
        branch,
        base: repo?.worktreeBase ?? ''
    });
    const worktreeOn = props.kind === 'workspace' && worktree && repo !== null;
    const canSubmit = value.trim() !== '' && !busy && (!worktreeOn || preview.valid);

    const submit = async (): Promise<void> => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        const failure = await props.onSubmit(
            value.trim(),
            worktreeOn && repo !== null
                ? { repoID: repo.id, name: worktreeName, branch, updateMain }
                : undefined
        );
        setBusy(false);
        if (failure !== null) setError(failure);
    };

    return (
        <form
            data-testid={`new-${props.kind}-form`}
            className="flex flex-col gap-1"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <div className="flex items-center gap-1">
                <input
                    ref={ref}
                    aria-label={props.kind === 'workspace' ? 'New workspace name' : 'New group name'}
                    placeholder={
                        props.kind === 'workspace'
                            ? 'Workspace name'
                            : props.workspaceCount === undefined
                              ? 'Group name'
                              : `Group name (${String(props.workspaceCount)} workspaces)`
                    }
                    className="min-w-0 flex-1 rounded border bg-transparent px-1.5 py-1 text-[12px] outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                            event.stopPropagation();
                            props.onCancel();
                        }
                    }}
                />
                <button
                    type="submit"
                    data-testid={`new-${props.kind}-submit`}
                    disabled={!canSubmit}
                    className="text-[12px]"
                    style={{ color: canSubmit ? tokens.accent : tokens.textTertiary }}
                >
                    {busy ? 'Creating…' : 'Create'}
                </button>
            </div>

            {props.kind === 'workspace' && repos.length > 0 ? (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: tokens.textSecondary }}>
                    <input
                        type="checkbox"
                        data-testid="new-workspace-worktree-toggle"
                        checked={worktree}
                        onChange={(event) => {
                            setWorktree(event.target.checked);
                        }}
                    />
                    Create git worktree
                </label>
            ) : null}

            {worktreeOn && repo !== null ? (
                <div className="flex flex-col gap-1 pl-4" data-testid="new-workspace-worktree">
                    {repos.length > 1 ? (
                        <select
                            aria-label="Worktree repository"
                            data-testid="new-workspace-worktree-repo"
                            className="w-full rounded border bg-transparent px-1 py-[2px] text-[11px]"
                            style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                            value={repo.id}
                            onChange={(event) => {
                                setRepoID(event.target.value);
                            }}
                        >
                            {repos.map((candidate) => (
                                <option key={candidate.id} value={candidate.id} style={{ color: '#000' }}>
                                    {candidate.name}
                                </option>
                            ))}
                        </select>
                    ) : null}
                    <input
                        aria-label="Worktree name"
                        data-testid="new-workspace-worktree-name"
                        placeholder="Worktree name"
                        className="w-full rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={worktreeName}
                        onChange={(event) => {
                            const next = event.target.value;
                            setWorktreeName(next);
                            if (!branchEdited) setBranch(next);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onCancel();
                            }
                        }}
                    />
                    <input
                        aria-label="Branch name"
                        data-testid="new-workspace-worktree-branch"
                        placeholder="Branch name"
                        className="w-full rounded border bg-transparent px-1.5 py-1 text-[11px] outline-none"
                        style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                        value={branch}
                        onChange={(event) => {
                            setBranch(event.target.value);
                            setBranchEdited(event.target.value !== worktreeName);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                event.stopPropagation();
                                props.onCancel();
                            }
                        }}
                    />
                    <label className="flex cursor-pointer items-center gap-1.5 text-[11px]" style={{ color: tokens.textSecondary }}>
                        <input
                            type="checkbox"
                            data-testid="new-workspace-worktree-update-main"
                            checked={updateMain}
                            onChange={(event) => {
                                setUpdateMain(event.target.checked);
                            }}
                        />
                        Update main first (fetch + branch off origin)
                    </label>
                    <div data-testid="new-workspace-worktree-preview" className="text-[10px]" style={{ color: tokens.textTertiary }}>
                        <div className="truncate">{preview.path}</div>
                        <div>{preview.branchLine}</div>
                    </div>
                </div>
            ) : null}

            {error === null ? null : (
                <div data-testid="new-workspace-error" className="text-[11px]" style={{ color: '#E0655C' }}>
                    {error}
                </div>
            )}
        </form>
    );
}

interface CustomEmojiSheetProps {
    readonly onSubmit: (grapheme: string) => void;
    readonly onCancel: () => void;
}

/**
 * §5.6's "Custom Emoji…" sheet. The only rule it enforces is the one that matters: exactly one
 * grapheme cluster, checked with `Intl.Segmenter` so a ZWJ family or a flag counts as one and
 * `ab` does not. Submit stays disabled until the field holds one.
 */
function CustomEmojiSheet(props: CustomEmojiSheetProps): ReactElement | null {
    const [value, setValue] = useState('');
    const container = globalThis.document?.body;
    const normalized = normalizeEmojiInput(value);
    if (container === undefined || container === null) return null;

    return createPortal(
        <div
            data-testid="emoji-sheet"
            role="dialog"
            aria-label="Custom emoji"
            className="fixed left-1/2 top-1/3 z-50 w-[280px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    if (normalized !== null) props.onSubmit(normalized);
                }}
            >
                <label className="mb-2 block" htmlFor="nex-custom-emoji">
                    Paste or type one emoji
                </label>
                <input
                    id="nex-custom-emoji"
                    autoFocus
                    aria-label="Custom emoji"
                    data-testid="emoji-input"
                    className="mb-1 w-full rounded border bg-transparent px-2 py-1 text-center text-[20px] outline-none"
                    style={{ borderColor: tokens.divider, color: tokens.textPrimary }}
                    value={value}
                    onChange={(event) => {
                        setValue(event.target.value);
                    }}
                    onKeyDown={(event) => {
                        if (event.key !== 'Escape') return;
                        event.stopPropagation();
                        props.onCancel();
                    }}
                />
                <div
                    data-testid="emoji-hint"
                    className="mb-3 h-4 text-[10px]"
                    style={{ color: value.length > 0 && normalized === null ? '#E0655C' : tokens.textTertiary }}
                >
                    {value.length > 0 && normalized === null ? 'Enter exactly one character' : ''}
                </div>
                <div className="flex justify-end gap-2">
                    <button type="button" style={{ color: tokens.textSecondary }} onClick={props.onCancel}>
                        Cancel
                    </button>
                    <button
                        type="submit"
                        data-testid="emoji-submit"
                        disabled={normalized === null}
                        style={{ color: normalized === null ? tokens.textTertiary : tokens.accent }}
                    >
                        Set Icon
                    </button>
                </div>
            </form>
        </div>,
        container
    );
}

interface ConfirmDialogProps {
    readonly confirm: ConfirmState;
    readonly onCancel: (suppress: boolean) => void;
    readonly onConfirm: (cascade: boolean, suppress: boolean) => void;
}

function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
    // Hooks before the container guard: a conditional early return above `useState` would make
    // the hook order depend on the DOM being present.
    const [suppress, setSuppress] = useState(false);
    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    const isGroup = props.confirm.kind === 'group';
    const isBulk = props.confirm.kind === 'workspaces';
    const count = props.confirm.kind === 'workspaces' ? props.confirm.ids.length : 0;
    /**
     * WS-108: a workspace with running agents gets `WorkspaceDeleteGate`'s alert instead of the
     * plain confirmation — the count in the message and a "Don't ask again" that writes the
     * daemon's `confirm-workspace-delete`. The caller has already applied the setting (0 when
     * it is off), so this only renders what it was handed.
     */
    const activeAgents = props.confirm.kind === 'workspace' ? (props.confirm.activeAgents ?? 0) : 0;
    const noun = activeAgents === 1 ? 'agent' : 'agents';
    const them = activeAgents === 1 ? 'it' : 'them';
    return createPortal(
        <div
            data-testid="confirm-dialog"
            data-active-agents={String(activeAgents)}
            role="dialog"
            aria-label={isGroup ? 'Delete group' : isBulk ? 'Delete workspaces' : 'Delete workspace'}
            className="fixed left-1/2 top-1/3 z-50 w-[320px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <div className="mb-3">
                {props.confirm.kind === 'group'
                    ? `Delete the group “${props.confirm.name}”?`
                    : props.confirm.kind === 'workspace'
                      ? `Delete “${props.confirm.name}”?`
                      : `Delete ${String(count)} workspace${count === 1 ? '' : 's'}?`}
                {isBulk ? (
                    <div className="mt-1 text-[11px]" style={{ color: tokens.textSecondary }}>
                        This cannot be undone. Panes and surfaces in these workspaces will be closed.
                    </div>
                ) : null}
                {activeAgents > 0 ? (
                    <div
                        data-testid="confirm-active-agents"
                        className="mt-1 text-[11px]"
                        style={{ color: tokens.textSecondary }}
                    >
                        {`This workspace has ${String(activeAgents)} active ${noun}. Deleting it will terminate ${them}.`}
                    </div>
                ) : null}
            </div>
            {activeAgents > 0 ? (
                <label className="mb-3 flex items-center gap-2 text-[11px]" style={{ color: tokens.textSecondary }}>
                    <input
                        type="checkbox"
                        data-testid="confirm-suppress"
                        checked={suppress}
                        onChange={(event) => setSuppress(event.target.checked)}
                    />
                    Don&apos;t ask again
                </label>
            ) : null}
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    data-testid="confirm-cancel"
                    style={{ color: tokens.textSecondary }}
                    onClick={() => props.onCancel(suppress)}
                >
                    Cancel
                </button>
                {isGroup ? (
                    <button
                        type="button"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => {
                            props.onConfirm(true, suppress);
                        }}
                    >
                        Delete + Workspaces
                    </button>
                ) : null}
                <button
                    type="button"
                    data-testid="confirm-delete"
                    style={{ color: '#E0655C' }}
                    onClick={() => {
                        props.onConfirm(false, suppress);
                    }}
                >
                    Delete
                </button>
            </div>
        </div>,
        container
    );
}

const EMPTY_PRESETS: readonly ChromeLabelPreset[] = [];
const EMPTY_REPOS: readonly ChromeRepo[] = [];
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map<string, boolean>();
