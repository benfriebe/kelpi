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

import type { WorkspaceColor } from '@nex/daemon/store';
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
import { ChromeIcon, avatarLetter, iconGlyph, iconIsTintable } from './icons';
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
import { resolveLabelStyle, withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';
import {
    WORKSPACE_COLORS,
    type ChromeGroup,
    type ChromeLabelPreset,
    type ChromeSidebarEntry,
    type ChromeWorkspace,
    type SidebarCallbacks
} from './types';

const DRAG_THRESHOLD_PX = 5;
const DEFAULT_ROW_HEIGHT = 34;
const CONTENT_TOP_PADDING = 4;

// ── small pieces ────────────────────────────────────────────────────────────────────

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
                style={{ background: withAlpha(hex, 0.2), border: `1px solid ${withAlpha(hex, 0.45)}` }}
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

    const style: CSSProperties = {
        background,
        outline,
        outlineOffset: '-1px',
        marginLeft: props.depth === 1 ? 24 : 0,
        opacity: props.dragging ? 0.8 : 1
    };

    return (
        <div
            ref={(element) => {
                props.registerRow(`ws:${workspace.id}`, element);
            }}
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
                      : withAlpha(hex, 0.22),
                border: props.dropPreview ? `1px solid ${tokens.accent}` : '1px solid transparent'
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
}

interface DragState {
    readonly kind: 'workspace' | 'group';
    readonly id: string;
    readonly startY: number;
    readonly originModel: SidebarOrderModel;
    active: boolean;
    preview: DropTarget | null;
}

type MenuState =
    | { readonly kind: 'workspace'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'group'; readonly id: string; readonly x: number; readonly y: number }
    | { readonly kind: 'background'; readonly x: number; readonly y: number };

type RenameState = { readonly kind: 'workspace' | 'group'; readonly id: string };
type ConfirmState =
    | { readonly kind: 'workspace'; readonly id: string; readonly name: string }
    | { readonly kind: 'group'; readonly id: string; readonly name: string };

export function Sidebar(props: SidebarProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const presets = props.labelPresets ?? EMPTY_PRESETS;
    const rowHeight = props.rowHeight ?? DEFAULT_ROW_HEIGHT;

    const [collapseOverrides, setCollapseOverrides] = useState<ReadonlyMap<string, boolean>>(EMPTY_OVERRIDES);
    const [shadow, setShadow] = useState<SidebarOrderModel | null>(null);
    const [menu, setMenu] = useState<MenuState | null>(null);
    const [rename, setRename] = useState<RenameState | null>(null);
    const [confirm, setConfirm] = useState<ConfirmState | null>(null);
    const [newForm, setNewForm] = useState<{ kind: 'workspace' | 'group'; groupID: string | null } | null>(null);
    const [internalSelection, setInternalSelection] = useState<ReadonlySet<string>>(EMPTY_SELECTION);
    const [dragID, setDragID] = useState<string | null>(null);
    /** The group a preview-only `ontoGroupHeader` target is tinting (§5.5). */
    const [previewGroupID, setPreviewGroupID] = useState<string | null>(null);

    const selection = props.selectedWorkspaceIDs ?? internalSelection;
    const collapse: CollapseState = useMemo(() => ({ overrides: collapseOverrides }), [collapseOverrides]);

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
            dragRef.current = {
                kind,
                id,
                startY: event.clientY,
                originModel: shadowRef.current ?? baseModel,
                active: false,
                preview: null
            };
            setDragID(id);
        },
        [baseModel, rename]
    );

    useEffect(() => {
        if (dragID === null) return;

        const onMove = (event: MouseEvent): void => {
            const drag = dragRef.current;
            if (drag === null) return;
            if (!drag.active) {
                if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
                drag.active = true;
            }
            const current = shadowRef.current ?? drag.originModel;
            const y = contentY(event.clientY);
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
                dragging: new Set([drag.id])
            });
            const target = resolveDropTarget(layout, y);
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

        const onUp = (): void => {
            const drag = dragRef.current;
            dragRef.current = null;
            setDragID(null);
            setPreviewGroupID(null);
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
            if (commit !== null) {
                props.onMoveWorkspace?.({
                    workspaceID: drag.id,
                    groupID: commit.groupID,
                    index: commit.index
                });
            }
        };

        const target = globalThis.window;
        target.addEventListener('mousemove', onMove);
        target.addEventListener('mouseup', onUp);
        return () => {
            target.removeEventListener('mousemove', onMove);
            target.removeEventListener('mouseup', onUp);
        };
    }, [contentY, dragID, measuredHeights, props, rowHeight]);

    // ── menus ───────────────────────────────────────────────────────────────────
    const closeMenu = useCallback((): void => {
        setMenu(null);
    }, []);

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
                    onSelect: () => {
                        setRename({ kind: 'workspace', id: workspaceID });
                    }
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
                    submenu:
                        presetItems.length + freeform.length === 0
                            ? [{ id: 'no-labels', label: 'No presets', kind: 'caption' }]
                            : [...presetItems, ...freeform]
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
                {
                    id: 'delete',
                    label: 'Delete',
                    danger: true,
                    disabled: workspaceByID.size <= 1,
                    onSelect: () => {
                        setConfirm({ kind: 'workspace', id: workspaceID, name: workspace.name });
                    }
                }
            ];
        },
        [baseModel, bucket, groupIDForWorkspace, groups, presets, props, workspaceByID]
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
        [collapseOverrides, groups, toggleCollapse]
    );

    const backgroundMenuItems = useCallback(
        (): MenuItemSpec[] => [
            {
                id: 'new-workspace',
                label: 'New Workspace',
                onSelect: () => {
                    setNewForm({ kind: 'workspace', groupID: null });
                }
            },
            {
                id: 'new-group',
                label: 'New Group',
                onSelect: () => {
                    setNewForm({ kind: 'group', groupID: null });
                }
            }
        ],
        []
    );

    const menuItems = useMemo((): readonly MenuItemSpec[] => {
        if (menu === null) return [];
        if (menu.kind === 'workspace') return workspaceMenuItems(menu.id);
        if (menu.kind === 'group') return groupMenuItems(menu.id);
        return backgroundMenuItems();
    }, [backgroundMenuItems, groupMenuItems, menu, workspaceMenuItems]);

    const onWorkspaceContextMenu = useCallback((workspaceID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event);
        setMenu({ kind: 'workspace', id: workspaceID, x: anchor.x, y: anchor.y });
    }, []);

    const onGroupContextMenu = useCallback((groupID: string, event: React.MouseEvent): void => {
        event.preventDefault();
        event.stopPropagation();
        const anchor = menuAnchorFromEvent(event);
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
                        <button
                            type="button"
                            className="flex items-center gap-1 text-[12px]"
                            style={{ color: tokens.textSecondary }}
                            onClick={() => {
                                setNewForm({ kind: 'workspace', groupID: null });
                            }}
                        >
                            <ChromeIcon name="plus" /> New Workspace
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
                        <span className="ml-auto font-mono text-[10px]" style={{ color: tokens.textTertiary }}>
                            ⌘N
                        </span>
                    </div>
                ) : (
                    <NewEntryForm
                        kind={newForm.kind}
                        onCancel={() => {
                            setNewForm(null);
                        }}
                        onSubmit={(name) => {
                            if (newForm.kind === 'workspace') props.onCreateWorkspace?.(name, newForm.groupID);
                            else props.onCreateGroup?.(name);
                            setNewForm(null);
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

            {confirm === null ? null : (
                <ConfirmDialog
                    confirm={confirm}
                    onCancel={() => {
                        setConfirm(null);
                    }}
                    onConfirm={(cascade) => {
                        if (confirm.kind === 'workspace') props.onDeleteWorkspace?.(confirm.id);
                        else props.onDeleteGroup?.(confirm.id, cascade);
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
    readonly onSubmit: (name: string) => void;
    readonly onCancel: () => void;
}

function NewEntryForm(props: NewEntryFormProps): ReactElement {
    const [value, setValue] = useState('');
    const ref = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
        ref.current?.focus();
    }, []);
    return (
        <form
            data-testid={`new-${props.kind}-form`}
            className="flex items-center gap-1"
            onSubmit={(event) => {
                event.preventDefault();
                props.onSubmit(value.trim());
            }}
        >
            <input
                ref={ref}
                aria-label={props.kind === 'workspace' ? 'New workspace name' : 'New group name'}
                placeholder={props.kind === 'workspace' ? 'Workspace name' : 'Group name'}
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
            <button type="submit" className="text-[12px]" style={{ color: tokens.accent }}>
                Create
            </button>
        </form>
    );
}

interface ConfirmDialogProps {
    readonly confirm: ConfirmState;
    readonly onCancel: () => void;
    readonly onConfirm: (cascade: boolean) => void;
}

function ConfirmDialog(props: ConfirmDialogProps): ReactElement | null {
    const container = globalThis.document?.body;
    if (container === undefined || container === null) return null;
    const isGroup = props.confirm.kind === 'group';
    return createPortal(
        <div
            data-testid="confirm-dialog"
            role="dialog"
            aria-label={isGroup ? 'Delete group' : 'Delete workspace'}
            className="fixed left-1/2 top-1/3 z-50 w-[320px] -translate-x-1/2 rounded-lg p-4 text-[12px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary,
                boxShadow: '0 16px 48px rgba(0,0,0,0.45)'
            }}
        >
            <div className="mb-3">
                {isGroup ? `Delete the group “${props.confirm.name}”?` : `Delete “${props.confirm.name}”?`}
            </div>
            <div className="flex justify-end gap-2">
                <button type="button" style={{ color: tokens.textSecondary }} onClick={props.onCancel}>
                    Cancel
                </button>
                {isGroup ? (
                    <button
                        type="button"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => {
                            props.onConfirm(true);
                        }}
                    >
                        Delete + Workspaces
                    </button>
                ) : null}
                <button
                    type="button"
                    style={{ color: '#E0655C' }}
                    onClick={() => {
                        props.onConfirm(false);
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
const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();
const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map<string, boolean>();
