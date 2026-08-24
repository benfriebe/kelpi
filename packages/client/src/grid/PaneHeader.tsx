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
import { Icon, type IconName, type IconWeight } from './icons';
import { pill, tokens } from './tokens';
import type { PaneActions, PaneModel } from './types';

/** Header content 20px + 2px vertical padding each side (shell-ui.md §4.2). */
export const PANE_HEADER_HEIGHT = 24;

/**
 * The path/title's flex-shrink weight (TERM-102/104).
 *
 * The Swift header was an `HStack` of fixed-size badges and buttons around one flexible
 * middle-truncating `Text`, so narrowing a pane ate the PATH and nothing else until there was
 * no path left. Flexbox has no notion of "shrink this one first", but it does share negative
 * space in proportion to `flex-shrink × flex-basis` — so a large weight here reproduces the
 * order: the title gives ground, then the user-data badges (label, agent, branch), and the
 * buttons never do.
 */
export const TITLE_SHRINK = 100;

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
 *
 * M19 — the cap **clamps** the tail; it does not abandon it. The first version returned
 * `{ head: title, tail: '' }` for any segment longer than the budget, which handed the whole
 * string back to plain tail-ellipsis in exactly the case middle truncation exists for:
 * `~/code/some-really-long-directory-name` threw away the directory name and kept `~/code/some-r…`.
 * Over budget, the tail becomes the LAST `tailMax` characters of the title and the head is
 * everything before them — so the head still ellipsizes from its right and the informative end
 * survives, which is what `.truncationMode(.middle)` does. The two spans are adjacent, so when
 * the header is wide enough they still read as one unbroken string.
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
    // M19: over budget, keep the tail's END rather than dropping the tail entirely — a long last
    // segment is the case middle truncation is FOR. `title.length > tailMax` is guaranteed here
    // (`tail` is a suffix of `title` and is itself longer than the budget), so the split is safe.
    if (tail.length > tailMax) {
        return { head: title.slice(0, title.length - tailMax), tail: title.slice(title.length - tailMax) };
    }
    return { head: title.slice(0, cut), tail };
}

/** The header's path/title string, by pane type (shell-ui.md §4.2 item 3). */
export function paneDisplayTitle(pane: PaneModel, homeDirectory = ''): string {
    switch (pane.type) {
        case 'scratchpad':
            return 'Scratchpad';
        case 'markdown':
            return basename(pane.filePath ?? pane.workingDirectory);
        case 'diff': {
            // §L48: empty-as-unscoped, the Swift's own test (`PaneHeaderView.swift:496-502` reads
            // `target.isEmpty`, not `target == nil`). `??` alone keeps an empty STRING, and a diff
            // pane whose scope the daemon stored as `''` titled itself `diff: ` — the repo's
            // directory name is what the shipped app falls back to.
            const target = pane.filePath ?? '';
            return `diff: ${basename(target === '' ? pane.workingDirectory : target)}`;
        }
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
    /**
     * M14 — the pill fill, in percent. `PaneHeaderView.swift` draws **three** tones, not one:
     * the label chip / ZOOM / SYNC at 12 (`:91`, `:112`, `:137`), SYNC OFF and the branch chip
     * at 10 (`:153`, `:174`), the agent badge at 14 (`:329`, `:336`). The port had flattened all
     * six to `pill()`'s single 14%, which read the branch and SYNC OFF ~40% stronger than the
     * shipped app draws them. Required rather than defaulted, so a new badge has to state its
     * tone instead of silently inheriting the loudest one.
     */
    readonly fill: number;
    /**
     * M15 — `.medium` weight. The Swift gives it to the **fixed-word** badges only (ZOOM `:106`,
     * SYNC `:131`, SYNC OFF `:147`); the label, branch and agent badges carry user data and stay
     * at the regular weight (`:85`, `:168`, `:325`).
     */
    readonly strong?: boolean | undefined;
    /**
     * M15 — SYNC OFF's deliberate 9 pt (`:147`), one point below every other badge's 10. It is
     * how the dimmed "sync is on but this pane opted out" state reads as secondary rather than
     * as another live badge.
     */
    readonly small?: boolean | undefined;
    readonly icon?: IconName | undefined;
    /**
     * L28 — the glyph's point size. `PaneHeaderView.swift` draws the label chip's `tag.fill`,
     * ZOOM's arrows and both SYNC glyphs at **8** (`:83`, `:104`, `:129`, `:145`) and only the
     * branch's `arrow.triangle.branch` at 9 (`:166`). The port had flattened all five to 9.
     */
    readonly iconSize?: number | undefined;
    readonly text: string;
    readonly title?: string | undefined;
    /**
     * TERM-102/104's truncation priority: a badge whose text is USER data (a pane label, a
     * branch name, an agent line) may give ground as the header narrows, after the path has;
     * a fixed-word badge (ZOOM, SYNC) may not, because there is nothing to truncate.
     *
     * The order is enforced with flex-shrink *weights* rather than by hiding anything: the
     * title carries a shrink factor two orders of magnitude larger (see `TITLE_SHRINK`), so it
     * absorbs essentially all of the first squeeze and these only start to give when it has
     * run out. The buttons never shrink at all — a header that drops its close ✕ before its
     * path is the wrong trade.
     */
    readonly shrinkable?: boolean | undefined;
    readonly onClick?: (() => void) | undefined;
}

function Badge({
    testID,
    color,
    fill,
    strong,
    small,
    icon,
    iconSize = 8,
    text,
    title,
    shrinkable,
    onClick
}: BadgeProps): ReactElement {
    const content = (
        <>
            {icon === undefined ? null : <Icon name={icon} size={iconSize} />}
            <span className={shrinkable === true ? 'min-w-0 truncate' : undefined}>{text}</span>
        </>
    );
    const style = {
        color,
        background: pill(color, fill),
        // M14: every badge in `PaneHeaderView.swift` is `RoundedRectangle(cornerRadius: 3)`.
        borderRadius: 3,
        ...(shrinkable === true ? { minWidth: 0, maxWidth: '40%' } : {})
    };
    // Both size classes are spelled out as literals: Tailwind scans SOURCE TEXT, so a class name
    // assembled from an interpolated number would never be generated.
    const sizeClass = small === true ? 'text-[9px]' : 'text-[10px]';
    const weightClass = strong === true ? ' font-medium' : '';
    // L28: `HStack(spacing: 2)` inside every badge (`PaneHeaderView.swift:81`, `:102`, `:127`,
    // `:143`, `:164`) — `gap-1` was 4 px, double the gap, which pushed each glyph off its text
    // far enough that the pill read as two things rather than one chip.
    const className = `flex ${shrinkable === true ? 'shrink' : 'shrink-0'} items-center gap-[2px] px-1 py-px font-mono ${sizeClass}${weightClass} leading-none`;
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
            // L33: the ZOOM badge is a `Button` in the Swift too (`PaneHeaderView.swift:101`), so
            // it consumes its own press — clicking it neither moves focus nor starts a pane drag.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            // A SwiftUI `Button` consumes the whole tap, double taps included, so the header's
            // `.onTapGesture(count: 2)` never sees one that landed on the ZOOM badge. `dblclick`
            // is a separate native event from `click`, so stopping `click` is not enough here.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            {content}
        </button>
    );
}

interface HeaderButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly icon: IconName;
    /**
     * L25 — the glyph's point size. Every button in `PaneHeaderView.swift:177-273` is
     * `.font(.system(size: 10))` **except** close, which is deliberately
     * `.font(.system(size: 9, weight: .semibold))` (`:265`): smaller and bolder than the split
     * icons it sits beside, which is how a row of five same-sized glyphs still ends in a ✕ that
     * reads as the one destructive control.
     */
    readonly iconSize?: number | undefined;
    readonly iconWeight?: IconWeight | undefined;
    /** Dimmed and inert, but still in the row: a control that vanishes reflows the header. */
    readonly disabled?: boolean | undefined;
    readonly onClick?: ((event: MouseEvent<HTMLButtonElement>) => void) | undefined;
}

function HeaderButton({
    testID,
    label,
    icon,
    iconSize = 10,
    iconWeight = 'regular',
    disabled,
    onClick
}: HeaderButtonProps): ReactElement {
    const off = disabled === true;
    return (
        <button
            type="button"
            data-testid={testID}
            aria-label={label}
            title={label}
            disabled={off}
            // L24: `.opacity(0.6)` and nothing else (`PaneHeaderView.swift:192`, `:205`, `:218`,
            // `:230`, `:241`, `:259`, `:271`) — the shipped header buttons carry no `.onHover`,
            // so they never brighten under the cursor. The port's `hover:opacity-100` was
            // invented chrome, and it is gone.
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
                off ? 'opacity-25' : 'opacity-60'
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
            // The Swift header hangs `.onTapGesture(count: 2) { onToggleZoom }` off the HStack,
            // and every control inside it is a SwiftUI `Button`, which swallows its own taps —
            // so a double-click on Split Right there is two splits and NOTHING else. In the DOM
            // `dblclick` is a separate native event from `click`: stopping `click` leaves it
            // bubbling to the header's `onDoubleClick`, which is two splits *and* a zoom toggle.
            onDoubleClick={(event) => event.stopPropagation()}
        >
            <Icon name={icon} size={iconSize} weight={iconWeight} />
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
        onCopyDocument,
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

    // The context menu's "Rename…" is now the ONLY way in (M30 dropped the header's own pencil,
    // which the Swift never had): it reaches the field through a bumped token, and the effect
    // runs only on a CHANGE, so a re-render caused by an agent tick can never re-open it.
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
            // M17: `HStack(spacing: 4)` + `.padding(.horizontal, 8)` (`PaneHeaderView.swift:52,274`).
            // The port's `gap-1.5` was 6 px — 50% wider, across a button tail plus three or four
            // badges, which is why this header ran out of room sooner than the shipped one.
            className="flex w-full shrink-0 select-none items-center gap-1 px-2"
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
                <Badge
                    testID={`pane-label-${pane.id}`}
                    // M13: `PaneHeaderView.swift:88,91` is `Color.accentColor` — the macOS system
                    // accent, not the chrome theme's `accent`. See `tokens.ts` for the seam and
                    // the standing divergence.
                    color={tokens.systemAccent}
                    fill={12}
                    icon="tag"
                    text={pane.label}
                    shrinkable
                />
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
                    // M11 — no `flex-1`. The Swift's `Text(displayPath)` sizes to its content and
                    // the free space belongs to the `Spacer()` at `PaneHeaderView.swift:157`,
                    // AFTER the ZOOM and SYNC badges; a `flex-1` title absorbed every pixel of
                    // slack instead, which pushed ZOOM and SYNC out of the left cluster (where
                    // they hug the path) and over to the right one. Grow 0, shrink `TITLE_SHRINK`.
                    className="flex min-w-0 font-mono text-[11px] leading-none"
                    // TERM-102/104's truncation priority, expressed the only way flexbox can:
                    // negative space is shared out in proportion to (shrink factor × base size),
                    // so a title weighted `TITLE_SHRINK` against the badges' 1 takes effectively
                    // the whole squeeze first, and the badges only give when it has nothing left.
                    // The spacer below carries `flex-basis: 0`, so it contributes nothing to that
                    // share-out and cannot steal the squeeze from the title.
                    // L32: no `title=`. `PaneHeaderView.swift:94-98` is a bare `Text(displayPath)`
                    // with `.truncationMode(.middle)` and no `.help()`, so hovering a truncated
                    // path in the shipped app shows nothing at all. The native tooltip was a port
                    // invention — and a misleading one, since it was the ONLY header element that
                    // answered a hover, which implied the truncation was recoverable here and
                    // nowhere else. The full path is still in the status footer and the
                    // inspector, which is where the shipped app puts it.
                    style={{ color: focused ? tokens.textPrimary : tokens.textSecondary, flexShrink: TITLE_SHRINK }}
                >
                    <span className="min-w-0 truncate">{titleParts.head}</span>
                    {titleParts.tail === '' ? null : <span className="shrink-0">{titleParts.tail}</span>}
                </span>
            )}

            {/* 4 — ZOOM badge */}
            {zoomed && zoomAvailable ? (
                <Badge
                    testID={`pane-zoom-badge-${pane.id}`}
                    // L27: `.orange` (`PaneHeaderView.swift:109,112`), as a token — the hex that
                    // was here was the only colour in the grid outside `--nex-*`, so it ignored
                    // the light/dark swap.
                    color={tokens.orange}
                    fill={12}
                    strong
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
                    // L27: `.orange` too (`PaneHeaderView.swift:134,137`) — the SAME orange as
                    // ZOOM. Painted with `--nex-agent` it was the agent amber, so a synced pane
                    // read as a pane with an agent running in it.
                    color={tokens.orange}
                    fill={12}
                    strong
                    icon="broadcast"
                    text="SYNC"
                    title="Synchronise input is on — keystrokes mirror to peer panes"
                />
            ) : null}
            {syncActive && syncExcluded ? (
                <Badge
                    testID={`pane-sync-off-badge-${pane.id}`}
                    color={tokens.textTertiary}
                    fill={10}
                    strong
                    small
                    icon="broadcast-off"
                    text="SYNC OFF"
                    title="Excluded from the workspace sync group"
                />
            ) : null}

            {/* 6 — spacer.
                M11: `Spacer()` at `PaneHeaderView.swift:157`, and it is the reason ZOOM and SYNC
                belong to the LEFT cluster. `flex-1` here (basis 0) takes the slack the title no
                longer does, and contributes nothing to the negative-space share-out that decides
                the truncation order. It is skipped while the inline rename field is up: that
                field is `flex-1` too, and Swift has no counterpart to split the slack with, so
                the field keeps the whole run of the header exactly as it did before.

                The test id is deliberately NOT `pane-header-spacer-…`: the audit harness counts
                panes and extracts pane ids with `[data-testid^="pane-header-"]` in eleven places
                (`scripts/ui-audit/audit.mjs:530,533`), so a second element under that prefix would
                read as a second pane in every one of them. */}
            {renaming ? null : <div data-testid={`pane-spacer-${pane.id}`} aria-hidden="true" className="flex-1" />}

            {/* 7 — agent badge */}
            {badge === null ? null : (
                <Badge
                    testID={`pane-agent-badge-${pane.id}`}
                    color={badge.tone === 'running' ? tokens.activeAgent : tokens.statusWaiting}
                    fill={14}
                    text={badge.text}
                    shrinkable
                />
            )}

            {/* 8 — git branch */}
            {pane.gitBranch === null || pane.gitBranch.length === 0 ? null : (
                <Badge
                    testID={`pane-branch-${pane.id}`}
                    color={tokens.textSecondary}
                    fill={10}
                    icon="branch"
                    // L28: the one badge glyph the Swift draws at 9 (`PaneHeaderView.swift:166`);
                    // the other four are 8.
                    iconSize={9}
                    text={pane.gitBranch}
                    shrinkable
                />
            )}

            {/* 9 — per-type buttons.
                M30: no `A−` / `A+` pair. `PaneHeaderView.swift:177-273` is the complete per-type
                block — markdown-copy, markdown-edit, diff-refresh — and the shipped app exposes
                preview font size ONLY through ⌘= / ⌘- / ⌘0. The pair existed here partly because
                a focused preview could not receive those chords (§H9); that reason expired when
                H9's chord relay landed — `content/bridge.ts` now posts a `focus` on any press
                inside the frame and replays every chord the binding map claims, and
                `increase/decrease/reset_markdown_font_size` are bound by default
                (`core/config/bindings.ts:68-70` → `App.tsx:2565-2567`). The capability itself is
                untouched: `PaneActions.onSetFontSize` and the `set-font-size` path stay, exactly
                as `onRestartAgent` does below. */}
            {/* §TERM-103: the Swift's header copy menu — markdown, preview mode only (there is
                no rendered document to copy while the editor is up). The menu is drawn by the
                content frame; this asks it to open. */}
            {pane.type === 'markdown' && pane.isEditing !== true && onCopyDocument !== undefined ? (
                <HeaderButton
                    testID={`pane-copy-${pane.id}`}
                    // L26: `.help("Copy whole file")` (`PaneHeaderView.swift:193`), verbatim. It
                    // was the one header tooltip the port had reworded — every other string in
                    // this row is already the Swift's — and the rewrite also became the button's
                    // accessible name, so a screen reader read a label the shipped app does not
                    // have. Which two formats the menu then offers is the MENU's business.
                    label="Copy whole file"
                    icon="copy"
                    onClick={() => onCopyDocument(pane.id)}
                />
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
            {/* No `.shell` branch, deliberately. `PaneHeaderView.swift:177-272`'s per-type block
                is markdown-copy / markdown-edit / diff-refresh and then the shared tail; the
                shipped app has no restart control anywhere (`grep -rn restartAgent Nex/` is
                empty), and a one-click restart of a live agent sitting between Split Down and
                Close is a mis-click nobody asked for. The capability itself stays: the
                `restart-pane-agent` verb, its daemon channel and `PaneActions.onRestartAgent`
                are untouched, so any client — or a later context-menu item — can still reach it. */}

            {/* 10–13 — splits, new web pane, close.
                M30: no rename button. `PaneHeaderView.swift:222-272` is split-right, split-down,
                globe, close and nothing else; the shipped app's rename lives in the header's
                CONTEXT menu (`:354-356`, "Rename…"), which the port already offers and drives
                through `renameToken`. The pencil also sat immediately beside the markdown
                edit-toggle's near-identical pencil, so the two glyphs read as one control
                repeated. The inline field itself is unchanged — it is still the port's rename
                affordance (TERM-112), just reached the way the Swift reaches it. */}
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
            {/* L25: the one button in the row that is not 10 pt regular — 9 pt semibold. */}
            <HeaderButton
                testID={`pane-close-${pane.id}`}
                label="Close pane (⌘W)"
                icon="close"
                iconSize={9}
                iconWeight="semibold"
                onClick={() => onClosePane?.(pane.id)}
            />
        </div>
    );
}

export const PaneHeader = memo(PaneHeaderImpl);
PaneHeader.displayName = 'PaneHeader';
