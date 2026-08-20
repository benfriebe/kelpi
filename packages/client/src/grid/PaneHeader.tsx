/**
 * The per-pane header bar (shell-ui.md §4.2).
 *
 * Left → right: type glyph / status dot, label chip, path or title, ZOOM badge, SYNC
 * badges, spacer, agent badge, git branch badge, per-type buttons, split buttons, close.
 * Focus is drawn by the pane's ring, never by the header itself.
 *
 * The component is `memo`ised and purely props-driven: agent activity mutates pane fields
 * every second (shell-ui.md §4.2 "Menu-stability requirement"), so nothing here may own
 * state that a tick would blow away — the only local state is the inline-rename draft, and
 * a tick cannot touch it because the header re-renders in place rather than remounting.
 */

import {
    memo,
    useEffect,
    useRef,
    useState,
    type KeyboardEvent,
    type MouseEvent,
    type PointerEvent,
    type ReactElement
} from 'react';

import { chromeElapsedLabel, useSecondsTicker } from './elapsed';
import { Icon, type IconName } from './icons';
import { pill, tokens } from './tokens';
import type { PaneActions, PaneModel } from './types';

/** Header content 20px + 2px vertical padding each side (shell-ui.md §4.2). */
export const PANE_HEADER_HEIGHT = 24;

// ── display strings ─────────────────────────────────────────────────────────────────

/** `/Users/x` → `~`, `/Users/x/a` → `~/a`; unrelated paths pass through (shell-ui.md §2). */
export function homeAbbreviated(path: string, home: string): string {
    if (home.length === 0) return path;
    const root = home.endsWith('/') ? home.slice(0, -1) : home;
    if (path === root) return '~';
    if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`;
    return path;
}

export function basename(path: string): string {
    const parts = path.split('/').filter((part) => part.length > 0);
    return parts.length === 0 ? path : (parts[parts.length - 1] as string);
}

/**
 * Split a header title so CSS can truncate it in the MIDDLE (§4.2 item 3).
 *
 * `text-overflow: ellipsis` only ever cuts the tail, which for a path throws away the only
 * informative part — the audit's `/var/folders/5x/k7q6qbys3p35wb8dcn0dl…` names a temp
 * directory and nothing else (run-B m9), while the status footer, describing the same pane,
 * middle-truncates. A character budget cannot be used here: the pane header's width is whatever
 * the split left it. So the string is split into a head that may ellipsize and a tail that
 * never does — the last path segment (with its separator), capped so a single monstrous segment
 * cannot eat the whole line. Titles with no separator, and short ones, keep the plain behaviour.
 */
export interface TruncatedTitle {
    readonly head: string;
    readonly tail: string;
}

export const HEADER_TAIL_MAX = 24;

export function splitHeaderTitle(title: string, tailMax = HEADER_TAIL_MAX): TruncatedTitle {
    const cut = title.lastIndexOf('/');
    // Nothing to protect: no separator, or the separator is the very first/last character.
    if (cut <= 0 || cut === title.length - 1) return { head: title, tail: '' };
    const tail = title.slice(cut);
    if (tail.length > tailMax) return { head: title, tail: '' };
    return { head: title.slice(0, cut), tail };
}

/** The header's path/title string, by pane type (shell-ui.md §4.2 item 3). */
export function paneDisplayTitle(pane: PaneModel, homeDirectory = ''): string {
    switch (pane.type) {
        case 'scratchpad':
            return 'Scratchpad';
        case 'markdown':
            return basename(pane.filePath ?? pane.workingDirectory);
        case 'diff':
            return `diff: ${basename(pane.filePath ?? pane.workingDirectory)}`;
        case 'shell':
        case 'web':
            return homeAbbreviated(pane.title ?? pane.workingDirectory, homeDirectory);
    }
}

const TYPE_GLYPHS: Record<Exclude<PaneModel['type'], 'shell'>, IconName> = {
    markdown: 'document',
    scratchpad: 'note',
    diff: 'plusminus',
    web: 'globe'
};

// ── agent badge ─────────────────────────────────────────────────────────────────────

export type AgentBadgeTone = 'running' | 'waiting';

export interface AgentBadgeModel {
    readonly text: string;
    readonly tone: AgentBadgeTone;
}

/**
 * The right-aligned agent badge (agent-lifecycle.md §5.9 / §9.4). Shell panes with an
 * attached session only: running → `<kind>[ · <elapsed>][ · N running]` in amber,
 * waiting → `awaiting input` in blue, idle → nothing.
 *
 * `pane.agentStartedAt` is epoch **milliseconds** (the agent state machine stamps it with the
 * handler's `Date.now()`), while the shared ticker publishes whole **seconds** — the mismatch
 * is converted here, not in the formatter, which stays unit-agnostic.
 */
export function agentBadge(pane: PaneModel, nowSeconds: number): AgentBadgeModel | null {
    if (pane.type !== 'shell') return null;
    if (pane.agentSessionID === null) return null;
    if (pane.status === 'waitingForInput') return { text: 'awaiting input', tone: 'waiting' };
    if (pane.status !== 'running') return null;
    let text: string = pane.agentKind ?? 'claude';
    if (pane.agentStartedAt !== null) {
        text += ` · ${chromeElapsedLabel(pane.agentStartedAt / 1000, nowSeconds)}`;
    }
    if (pane.backgroundTaskCount > 0) text += ` · ${pane.backgroundTaskCount} running`;
    return { text, tone: 'running' };
}

function statusDotColor(status: PaneModel['status']): string {
    switch (status) {
        case 'running':
            return tokens.statusRunning;
        case 'waitingForInput':
            return tokens.statusWaiting;
        case 'idle':
            return tokens.textTertiary;
    }
}

// ── pieces ──────────────────────────────────────────────────────────────────────────

interface BadgeProps {
    readonly testID: string;
    readonly color: string;
    readonly icon?: IconName | undefined;
    readonly text: string;
    readonly title?: string | undefined;
    readonly onClick?: (() => void) | undefined;
}

function Badge({ testID, color, icon, text, title, onClick }: BadgeProps): ReactElement {
    const content = (
        <>
            {icon === undefined ? null : <Icon name={icon} size={9} />}
            <span>{text}</span>
        </>
    );
    const style = { color, background: pill(color), borderRadius: 4 };
    const className = 'flex shrink-0 items-center gap-1 px-1 py-px font-mono text-[10px] leading-none';
    if (onClick === undefined) {
        return (
            <span data-testid={testID} className={className} style={style} {...(title === undefined ? {} : { title })}>
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-testid={testID}
            className={className}
            style={style}
            {...(title === undefined ? {} : { title })}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
        >
            {content}
        </button>
    );
}

interface HeaderButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly icon: IconName;
    /** Dimmed and inert, but still in the row: a control that vanishes reflows the header. */
    readonly disabled?: boolean | undefined;
    readonly onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}

function HeaderButton({ testID, label, icon, disabled, onClick }: HeaderButtonProps): ReactElement {
    const off = disabled === true;
    return (
        <button
            type="button"
            data-testid={testID}
            aria-label={label}
            title={label}
            disabled={off}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                off ? 'opacity-25' : 'opacity-60 hover:opacity-100'
            }`}
            style={{ color: tokens.textSecondary, cursor: off ? 'default' : 'pointer' }}
            onPointerDown={(event) => {
                // Never let a button press start a pane-move drag.
                event.stopPropagation();
            }}
            onClick={(event) => {
                event.stopPropagation();
                onClick?.(event);
            }}
        >
            <Icon name={icon} size={10} />
        </button>
    );
}

// ── the header ──────────────────────────────────────────────────────────────────────

export interface PaneHeaderProps extends PaneActions {
    readonly pane: PaneModel;
    readonly focused: boolean;
    /** This pane is the workspace's zoomed pane. */
    readonly zoomed?: boolean | undefined;
    /** The workspace has more than one pane, so the ZOOM badge is meaningful. */
    readonly zoomAvailable?: boolean | undefined;
    readonly syncActive?: boolean | undefined;
    readonly syncExcluded?: boolean | undefined;
    readonly homeDirectory?: string | undefined;
    /** Pins the elapsed clock (tests); omit to subscribe to the shared 1 s ticker. */
    readonly nowSeconds?: number | undefined;
    readonly height?: number | undefined;
    /**
     * Bumped to open the inline rename field from OUTSIDE the header — the context menu's
     * "Rename…" (TERM-106), which in the Swift app raised a sheet and here reuses the field
     * that is already the port's rename affordance (TERM-112's accepted divergence).
     *
     * A counter rather than a boolean, so asking twice in a row re-opens the field after the
     * first edit was committed.
     */
    readonly renameToken?: number | undefined;
    /** The grid's pane-move drag hook (shell-ui.md §4.3). */
    readonly onHeaderPointerDown?: ((paneID: string, event: PointerEvent<HTMLElement>) => void) | undefined;
}

function PaneHeaderImpl(props: PaneHeaderProps): ReactElement {
    const {
        pane,
        focused,
        zoomed = false,
        zoomAvailable = false,
        syncActive = false,
        syncExcluded = false,
        homeDirectory = '',
        nowSeconds,
        height = PANE_HEADER_HEIGHT,
        renameToken = 0,
        onHeaderPointerDown,
        onFocusPane,
        onClosePane,
        onRenamePane,
        onSplitPane,
        onToggleZoom,
        onToggleMarkdownEdit,
        onRefreshDiff,
        onSetFontSize,
        onRestartAgent,
        onNewWebPane,
        onPaneContextMenu
    } = props;

    const running = pane.type === 'shell' && pane.agentSessionID !== null && pane.status === 'running';
    // Only a running agent with a known start time needs the clock; everything else is static.
    const wantsTick = running && pane.agentStartedAt !== null && nowSeconds === undefined;
    const ticked = useSecondsTicker(wantsTick);
    const now = nowSeconds ?? ticked;

    // `null` = not renaming; a string is the live draft. Commit is idempotent, so the
    // blur that follows an Enter (or an unmount) can never fire the callback twice.
    const [renameDraft, setRenameDraft] = useState<string | null>(null);
    const renaming = renameDraft !== null;

    const startRename = (): void => setRenameDraft(pane.label ?? '');

    // The context menu's "Rename…" reaches the field through a bumped token; the effect runs
    // only on a CHANGE, so a re-render caused by an agent tick can never re-open it.
    const lastRenameToken = useRef(renameToken);
    useEffect(() => {
        if (renameToken === lastRenameToken.current) return;
        lastRenameToken.current = renameToken;
        if (renameToken > 0) setRenameDraft(pane.label ?? '');
    }, [renameToken, pane.label]);

    const commitRename = (): void => {
        if (renameDraft === null) return;
        setRenameDraft(null);
        onRenamePane?.(pane.id, renameDraft.trim());
    };

    const cancelRename = (): void => setRenameDraft(null);

    const onRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            commitRename();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            cancelRename();
        }
    };

    const badge = agentBadge(pane, now);
    const title = paneDisplayTitle(pane, homeDirectory);
    const titleParts = splitHeaderTitle(title);

    return (
        <div
            data-testid={`pane-header-${pane.id}`}
            data-focused={focused ? 'true' : 'false'}
            className="flex w-full shrink-0 select-none items-center gap-1.5 px-2"
            style={{
                height,
                background: tokens.headerBackground,
                borderBottom: `1px solid ${tokens.divider}`,
                cursor: renaming ? 'text' : 'default'
            }}
            onPointerDown={(event) => {
                // shell-ui.md §4.1: clicking anywhere in a pane focuses it.
                onFocusPane?.(pane.id);
                if (renaming) return;
                onHeaderPointerDown?.(pane.id, event);
            }}
            onDoubleClick={(event) => {
                if (renaming) return;
                event.preventDefault();
                onToggleZoom?.(pane.id);
            }}
            onContextMenu={(event) => {
                if (onPaneContextMenu === undefined) return;
                event.preventDefault();
                onPaneContextMenu(pane.id, event);
            }}
        >
            {/* 1 — type glyph / status dot */}
            {pane.type === 'shell' ? (
                <span
                    data-testid={`pane-status-dot-${pane.id}`}
                    data-status={pane.status}
                    className="h-2.5 w-2.5 shrink-0 rounded-full transition-colors duration-300"
                    style={{
                        background: statusDotColor(pane.status),
                        opacity: pane.status === 'idle' && !focused ? 0.5 : 1
                    }}
                />
            ) : (
                <span className="shrink-0" style={{ color: tokens.textSecondary }}>
                    <Icon name={TYPE_GLYPHS[pane.type]} size={10} />
                </span>
            )}

            {/* 2 — label chip */}
            {pane.label !== null && pane.label.length > 0 && pane.type !== 'markdown' ? (
                <Badge testID={`pane-label-${pane.id}`} color={tokens.accent} icon="tag" text={pane.label} />
            ) : null}

            {/* 3 — path / title, or the inline rename field */}
            {renaming ? (
                <input
                    data-testid={`pane-rename-input-${pane.id}`}
                    aria-label="Pane name"
                    autoFocus
                    value={renameDraft}
                    className="min-w-0 flex-1 rounded px-1 font-mono text-[11px] leading-none outline-none"
                    style={{ background: tokens.surfaceBackground, color: tokens.textPrimary }}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={onRenameKeyDown}
                    onBlur={commitRename}
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : (
                <span
                    data-testid={`pane-title-${pane.id}`}
                    className="flex min-w-0 flex-1 font-mono text-[11px] leading-none"
                    style={{ color: focused ? tokens.textPrimary : tokens.textSecondary }}
                    title={title}
                >
                    <span className="min-w-0 truncate">{titleParts.head}</span>
                    {titleParts.tail === '' ? null : <span className="shrink-0">{titleParts.tail}</span>}
                </span>
            )}

            {/* 4 — ZOOM badge */}
            {zoomed && zoomAvailable ? (
                <Badge
                    testID={`pane-zoom-badge-${pane.id}`}
                    color="#D08237"
                    icon="zoom"
                    text="ZOOM"
                    title="Toggle zoom"
                    onClick={() => onToggleZoom?.(pane.id)}
                />
            ) : null}

            {/* 5 — SYNC badges */}
            {syncActive && !syncExcluded ? (
                <Badge
                    testID={`pane-sync-badge-${pane.id}`}
                    color={tokens.activeAgent}
                    icon="broadcast"
                    text="SYNC"
                    title="Synchronise input is on — keystrokes mirror to peer panes"
                />
            ) : null}
            {syncActive && syncExcluded ? (
                <Badge
                    testID={`pane-sync-off-badge-${pane.id}`}
                    color={tokens.textTertiary}
                    icon="broadcast-off"
                    text="SYNC OFF"
                    title="Excluded from the workspace sync group"
                />
            ) : null}

            {/* 7 — agent badge */}
            {badge === null ? null : (
                <Badge
                    testID={`pane-agent-badge-${pane.id}`}
                    color={badge.tone === 'running' ? tokens.activeAgent : tokens.statusWaiting}
                    text={badge.text}
                />
            )}

            {/* 8 — git branch */}
            {pane.gitBranch === null || pane.gitBranch.length === 0 ? null : (
                <Badge
                    testID={`pane-branch-${pane.id}`}
                    color={tokens.textSecondary}
                    icon="branch"
                    text={pane.gitBranch}
                />
            )}

            {/* 9 — per-type buttons */}
            {/* §3.16: font size is a PREVIEW control — the built-in editor is a fixed 13 px
                monospace, so the pair cannot act in edit mode. It stays in the row DISABLED
                rather than unmounting (run-B nit): a control that vanishes reflows every button
                beside it on ⌘E, and the affordance goes undiscoverable in the mode you are in.
                ⌥-click either one resets to 14 — the ⌘0 binding without a second pair. */}
            {pane.type === 'markdown' ? (
                <>
                    <HeaderButton
                        testID={`pane-font-smaller-${pane.id}`}
                        label={
                            pane.isEditing
                                ? 'Font size applies to the preview (⌘E)'
                                : 'Decrease font size (⌘-, ⌥-click resets)'
                        }
                        icon="font-smaller"
                        disabled={pane.isEditing === true}
                        onClick={(event) => onSetFontSize?.(pane.id, event.altKey ? 'reset' : 'decrease')}
                    />
                    <HeaderButton
                        testID={`pane-font-larger-${pane.id}`}
                        label={
                            pane.isEditing
                                ? 'Font size applies to the preview (⌘E)'
                                : 'Increase font size (⌘=, ⌥-click resets)'
                        }
                        icon="font-larger"
                        disabled={pane.isEditing === true}
                        onClick={(event) => onSetFontSize?.(pane.id, event.altKey ? 'reset' : 'increase')}
                    />
                </>
            ) : null}
            {pane.type === 'markdown' ? (
                <HeaderButton
                    testID={`pane-edit-toggle-${pane.id}`}
                    label={pane.isEditing ? 'Preview (⌘E)' : 'Edit (⌘E)'}
                    icon={pane.isEditing ? 'eye' : 'pencil'}
                    onClick={() => onToggleMarkdownEdit?.(pane.id)}
                />
            ) : null}
            {pane.type === 'diff' ? (
                <HeaderButton
                    testID={`pane-refresh-${pane.id}`}
                    label="Refresh diff"
                    icon="refresh"
                    onClick={() => onRefreshDiff?.(pane.id)}
                />
            ) : null}
            {pane.type === 'shell' && pane.agentSessionID !== null ? (
                <HeaderButton
                    testID={`pane-restart-${pane.id}`}
                    label="Restart agent"
                    icon="restart"
                    onClick={() => onRestartAgent?.(pane.id)}
                />
            ) : null}

            {/* 10–13 — rename, splits, close */}
            <HeaderButton
                testID={`pane-rename-${pane.id}`}
                label="Rename pane"
                icon="rename"
                onClick={startRename}
            />
            <HeaderButton
                testID={`pane-split-right-${pane.id}`}
                label="Split right (⌘D)"
                icon="split-right"
                onClick={() => onSplitPane?.(pane.id, 'horizontal')}
            />
            <HeaderButton
                testID={`pane-split-down-${pane.id}`}
                label="Split down (⌘⇧D)"
                icon="split-down"
                onClick={() => onSplitPane?.(pane.id, 'vertical')}
            />
            <HeaderButton
                testID={`pane-new-web-${pane.id}`}
                label="New web pane (⇧-click splits down)"
                icon="globe"
                onClick={(event) => onNewWebPane?.(pane.id, event.shiftKey ? 'vertical' : 'horizontal')}
            />
            <HeaderButton
                testID={`pane-close-${pane.id}`}
                label="Close pane (⌘W)"
                icon="close"
                onClick={() => onClosePane?.(pane.id)}
            />
        </div>
    );
}

export const PaneHeader = memo(PaneHeaderImpl);
PaneHeader.displayName = 'PaneHeader';
