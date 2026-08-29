/**
 * The bottom status bar (shell-ui.md §8, agent-lifecycle.md §9).
 *
 * Left cluster = the focused pane of the active workspace: home-abbreviated + middle-truncated
 * cwd, git branch, then the agent segment (running → `<kind> <elapsed>` in amber with a 1s
 * ticker; waiting → `awaiting input` in the waiting color; idle → nothing).
 *
 * Right cluster = the system-stat gauges (APP-078…085), then the three global agent counts,
 * then a live `HH:MM` clock. The stats are sampled by the DAEMON in this architecture (§15 /
 * `@nex/protocol` `ws/stats.ts`): this renders the broadcast it is handed, in the enabled set's
 * canonical order, and renders nothing at all when the master toggle is off — the gauge row
 * simply is not there, exactly as `enabledStatKinds` returning `[]` produces in the Swift view.
 *
 * The counts are exactly agent-lifecycle.md §9.3, and they come from the daemon's own
 * `chromeStatusSummary` via `selectAgentSummary` rather than being recounted here:
 * running = status `running`, waiting = `waitingForInput`, inactive = an attached session id
 * with `idle` status, summed over every workspace's VISIBLE panes. A zero count is inert; a
 * non-zero count is a button that opens the bucket popover.
 */

import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type RefObject } from 'react';

import { useSecondsTicker } from './clock';
import { useDismissable } from './dismissable';
import { hoverFill, hoverText, useHoverKey } from './hover';
import { ChromeIcon } from './icons';
import { useOverlayPresence } from './modal-presence';
import { Sparkline, SystemStatGauge, type SparklineStyle } from './SystemStatGauge';
import { systemStatMeta, visibleStatKinds } from './stats';
import {
    chromeElapsedLabel,
    clockLabel,
    homeAbbreviated,
    middleTruncate,
    workspaceColorHex,
    type ChromeBucket
} from './theme';
import { tokens } from './tokens';
import type { ChromePane } from './types';
import type { WorkspaceColor } from '@nex/daemon/store';
import { SYSTEM_STATS_INTERVAL_MS, ZERO_SYSTEM_STATS, type WsSystemStats } from '@nex/protocol';

export type AgentBucket = 'running' | 'waiting' | 'inactive';

/** The slice of an inspector association the footer's longest-prefix match needs. */
export interface FooterAssociation {
    readonly worktreePath: string;
    /**
     * `worktreePath` with symlinks resolved, computed daemon-side (`ws/repos.ts` ▸
     * `serializeAssociation`). Absent / `''` = fall back to `worktreePath`.
     */
    readonly worktreePathReal?: string | undefined;
    readonly status: {
        readonly kind: 'unknown' | 'clean' | 'dirty';
        readonly changedFiles: number;
        readonly additions: number;
        readonly deletions: number;
    };
}

export interface FooterGitStats {
    readonly changedFiles: number;
    readonly additions: number;
    readonly deletions: number;
}

/**
 * Trailing separators removed, so `/repo/` and `/repo` are the same root. `/` survives as
 * itself — it is a legitimate (if silly) worktree root and must not collapse to `''`.
 */
function normalizePathForMatch(value: string | undefined): string {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (trimmed === '') return '';
    const stripped = trimmed.replace(/\/+$/, '');
    return stripped === '' ? '/' : stripped;
}

/**
 * Is `candidate` the directory `root`, or somewhere beneath it?
 *
 * Boundary-correct on purpose: `/repo2` is NOT inside `/repo`, which a bare `startsWith` would
 * claim. Case-sensitive on purpose too — a case-insensitive match would make `/Repo` and
 * `/repo` the same tree on a case-sensitive volume where they are two different repositories.
 */
function isInsideRoot(candidate: string, root: string): boolean {
    if (candidate === '' || root === '') return false;
    if (candidate === root) return true;
    return candidate.startsWith(root === '/' ? '/' : `${root}/`);
}

/** The distinct, normalized forms of one path — literal and symlink-resolved. */
function pathForms(literal: string, canonical: string | undefined): readonly string[] {
    const a = normalizePathForMatch(canonical);
    const b = normalizePathForMatch(literal);
    if (a === '') return b === '' ? EMPTY_FORMS : [b];
    if (b === '' || a === b) return [a];
    return [a, b];
}

/**
 * §APP-071 / §GIT-092 — what `doc N +A -B` is computed from.
 *
 * The pane carries no association id, so the Swift matches its cwd to the repo association it
 * sits INSIDE, longest worktree path winning (a workspace can hold a repo and a worktree nested
 * under it; the deeper one is the one the pane is actually in). `null` when the pane is outside
 * every tracked worktree, or the tree it is in is clean — the two cases the Swift hides.
 *
 * **The match runs on CANONICAL paths** (audit ledger **N5**). The two sides are produced by
 * different subsystems and disagree about the same directory: an association carries git's
 * answer to `rev-parse --show-toplevel`, which is the physical path (`/private/var/…`), while a
 * pane carries the logical cwd its shell reported (`/var/…`). Every repo under a symlinked
 * ancestor — all of `/tmp` and `/var` on macOS, a symlinked `$HOME` — therefore failed the
 * prefix test, and the segment silently drew nothing. The daemon now ships the symlink-resolved
 * twin of both (`workingDirectoryReal`, `worktree_path_real`), and this compares those.
 *
 * Both forms of both sides are still tried, so an unresolvable path on one side (a deleted
 * directory whose realpath could not be taken) degrades to the old literal comparison rather
 * than to nothing. Ranking, however, is always on the canonical root: a nested worktree must
 * beat the repo it sits inside, and mixing `/var/x/wt` against `/private/var/x` would compare
 * two different measuring sticks.
 */
export function footerGitStats(
    associations: readonly FooterAssociation[],
    workingDirectory: string,
    workingDirectoryReal?: string | undefined
): FooterGitStats | null {
    const cwds = pathForms(workingDirectory, workingDirectoryReal);
    if (cwds.length === 0) return null;
    let best: FooterAssociation | null = null;
    let bestDepth = -1;
    for (const association of associations) {
        const roots = pathForms(association.worktreePath, association.worktreePathReal);
        if (roots.length === 0) continue;
        if (!roots.some((root) => cwds.some((cwd) => isInsideRoot(cwd, root)))) continue;
        // roots[0] is the canonical form when there is one (see `pathForms`).
        const depth = (roots[0] ?? '').length;
        if (depth > bestDepth) {
            best = association;
            bestDepth = depth;
        }
    }
    if (best === null || best.status.kind !== 'dirty') return null;
    const { changedFiles, additions, deletions } = best.status;
    return { changedFiles, additions, deletions };
}

/**
 * UI-FIDELITY L52 — the diff counts follow the appearance.
 *
 * `StatusBarView.swift:143-148` paints them with the SYSTEM `.green` / `.red`, which are dynamic
 * colours: they resolve differently in light and dark. The port had two literal hexes, so the
 * light chrome got the dark tones. This is the same pair resolved per bucket — the dark column is
 * unchanged (it is also the inspector's, and the audit's `footer-git-stats` reads those exact
 * values), and the light column is the chrome palette's own light green / red
 * (`WORKSPACE_COLOR_HEX`, light bucket). The one thing that does NOT survive the port is the
 * accessibility half: a renderer cannot see macOS's "Increase contrast", so these shift with
 * appearance only.
 */
export const FOOTER_DIFF_TONES: Readonly<Record<ChromeBucket, { readonly add: string; readonly del: string }>> = {
    dark: { add: '#5FBE89', del: '#E0655C' },
    light: { add: '#3F9457', del: '#D0453C' }
};

/** The Swift's `gitStatsLabel`: `doc N`, then `+A` in green and `-B` in red, 10 pt monospaced. */
function GitStats({
    stats,
    bucket
}: {
    readonly stats: FooterGitStats;
    readonly bucket: ChromeBucket;
}): ReactElement {
    const tone = FOOTER_DIFF_TONES[bucket];
    const label =
        `${String(stats.changedFiles)} file${stats.changedFiles === 1 ? '' : 's'} changed, ` +
        `${String(stats.additions)} added, ${String(stats.deletions)} removed`;
    return (
        <span
            data-testid="footer-git-stats"
            className="flex shrink-0 items-center gap-1 font-mono text-[10px]"
            aria-label={label}
            title={label}
        >
            <span className="flex items-center gap-0.5" style={{ color: tokens.textTertiary }}>
                <ChromeIcon name="document" size={9} />
                {stats.changedFiles}
            </span>
            {stats.additions > 0 ? <span style={{ color: tone.add }}>+{stats.additions}</span> : null}
            {stats.deletions > 0 ? <span style={{ color: tone.del }}>-{stats.deletions}</span> : null}
        </span>
    );
}

export interface AgentCountSummary {
    readonly running: number;
    readonly waiting: number;
    readonly inactive: number;
}

/** One row of a bucket popover (agent-lifecycle.md §9.3 / §8.1 `StatusBarItem`). */
export interface StatusBarItem {
    readonly paneID: string;
    readonly workspaceID: string;
    readonly workspaceName: string;
    readonly workspaceColor: WorkspaceColor;
    readonly paneTitle: string;
    readonly status: ChromePane['status'];
    /** Epoch MILLISECONDS (the daemon stamps `agentStartedAt` with `Date.now()`). */
    readonly agentStartedAt?: number | null | undefined;
}

export interface StatusFooterProps {
    readonly summary: AgentCountSummary;
    readonly focusedPane?: ChromePane | null | undefined;
    readonly homeDirectory?: string | undefined;
    readonly bucket?: ChromeBucket | undefined;
    /** Rows for the open bucket popover; assembly derives them from the mirror. */
    readonly bucketItems?: ((bucket: AgentBucket) => readonly StatusBarItem[]) | undefined;
    readonly onSelectPane?: ((workspaceID: string, paneID: string) => void) | undefined;
    /** System-stat samples (daemon-sampled, §15). Empty renders the placeholder. */
    readonly sparklineSamples?: readonly number[] | undefined;
    readonly sparklineLabel?: string | undefined;
    /**
     * The daemon's latest `system-stats` broadcast plus the settings that shape it (APP-080).
     * Absent = no sampler has spoken yet, which renders the same nothing the master toggle
     * being off renders — a footer must not invent a 0 % CPU it was never told about.
     */
    readonly systemStats?: SystemStatsView | undefined;
    /**
     * §APP-071 / §GIT-092: the ACTIVE workspace's repo associations, with their last known
     * dirtiness. The footer matches the focused pane's cwd against them (longest prefix) and
     * renders `doc N +A -B` for the one it lands in. Absent/empty = no stats segment, which is
     * also what a pane outside every tracked worktree gets.
     */
    readonly associations?: readonly FooterAssociation[] | undefined;
    /** Frozen clock for tests; defaults to the live 1s ticker. */
    readonly now?: number | undefined;
}

/** Everything the gauge row needs, assembled by `App.tsx` from the store + settings. */
export interface SystemStatsView {
    readonly stats: WsSystemStats;
    readonly history: Readonly<Record<string, readonly number[]>>;
    readonly intervalMs: number;
    /** The master toggle (SET-042). */
    readonly showSystemStats: boolean;
    /** The enabled metric ids (SET-043); order is imposed here, not by the caller. */
    readonly enabled: readonly string[];
    readonly showGraphs: boolean;
    readonly graphStyle: SparklineStyle;
    /** `''` = the adaptive chrome tone. */
    readonly graphColor: string;
    readonly graphWidth: number;
}

const BUCKET_LABEL: Readonly<Record<AgentBucket, string>> = {
    running: 'Running agents',
    waiting: 'Awaiting input',
    inactive: 'Inactive agents'
};

function bucketColor(bucket: AgentBucket): string {
    if (bucket === 'running') return tokens.statusRunning;
    if (bucket === 'waiting') return tokens.statusWaiting;
    return tokens.statusInactive;
}

/**
 * The standalone sparkline slot that predates the gauge row.
 *
 * Kept as a thin wrapper over `Sparkline` (which now owns both styles, the fill and the
 * percentage-vs-rate rule) rather than deleted: it is the shape `sparklineSamples` feeds, and
 * the sub-2-sample placeholder behaviour it documents is still the contract every gauge obeys.
 * A caller that only has a bare series of numbers still has somewhere to put them.
 */
export function SystemSparkline(props: {
    readonly samples: readonly number[];
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly label?: string | undefined;
}): ReactElement {
    return (
        <Sparkline
            values={props.samples}
            isPercentage={false}
            color={tokens.textSecondary}
            width={props.width ?? 28}
            height={props.height ?? 11}
            {...(props.label === undefined ? {} : { label: props.label })}
        />
    );
}

interface CountItemProps {
    readonly bucket: AgentBucket;
    readonly count: number;
    readonly open: boolean;
    readonly onToggle: () => void;
    /** §M20: the popover is anchored to THIS chip, so the row has to be able to measure it. */
    readonly anchorRef?: RefObject<HTMLButtonElement | null> | undefined;
    /** §H11: hovered state and its handlers, from the footer's single hover slot. */
    readonly hovered?: boolean | undefined;
    readonly hoverBinding?: { readonly onMouseEnter: () => void; readonly onMouseLeave: () => void } | undefined;
}

/**
 * SPACING-REVIEW S49 (OWNER-DIRECTED) — the count chips' hit box, and nothing else.
 *
 * `StatusBarView.swift:268-287` is `Button { countLabel }.buttonStyle(.plain)` with no padding of
 * its own, over an `HStack(spacing: 4)` of 11 pt text — so the shipped target is the ~14 pt text
 * band, and the port transcribed that exactly. Measured live: 67.74 / 65.44 / 68.73 × **15.40**
 * at `padding: 0px`, centred in a fixed 24 px footer row (`:669`'s `h-6`), leaving a 4.8 px dead
 * strip above and a 3.8 px one below every clickable count.
 *
 * `4px 0` fills that row: the band goes 15.4 → 23.4 px, and because the padding is symmetric and
 * every ancestor from `footer-keep` up is `items-center`, the dot, the 14 px count slot and the
 * word do not move by a sub-pixel. Nothing horizontal is touched, so §L50's 14 px stack and
 * `bucketPopoverPlacement`'s chip-centre arithmetic (which reads `left`/`width` only) are both
 * unaffected — including S31's five exact-equality placement assertions.
 *
 * `alignSelf: 'stretch'` — the register's other suggestion — was MEASURED and rejected: this
 * chip's parents are content-sized (`footer-keep` is centred inside `footer-right`, which is
 * centred inside the row), so stretching resolves to the 15.4 px line and buys nothing at all.
 *
 * Applied to the `<button>` branch ONLY. The inert `<span>` branch below is what a 0-count chip
 * renders (§M22) and it is not a click target, so padding it would grow a box nobody can press.
 * The two branches therefore differ in box height by 8 px and in painted position by nothing.
 *
 * Measured live with one running agent: the chip's box 67.74 × 15.40 → 67.74 × 23.40 and its
 * probed hit area 67.5 × 15.5 → 67.5 × 22.5, chip content unmoved, and the 488 × 32 picture of
 * the whole chip run pixel-identical (0 of 15 616 px differ).
 *
 * Owner-directed: do not re-report. The parity value is no padding.
 */
const COUNT_CHIP_HIT_BOX = { padding: '4px 0' } as const;

function CountItem(props: CountItemProps): ReactElement {
    const color = bucketColor(props.bucket);
    const inert = props.count === 0;
    const content = (
        <>
            <span aria-hidden className="h-[6px] w-[6px] rounded-full" style={{ background: color }} />
            <span className="w-[14px] text-right font-mono tabular-nums">{props.count}</span>
            <span>{props.bucket}</span>
        </>
    );
    if (inert) {
        return (
            <span
                data-testid={`count-${props.bucket}`}
                data-count={props.count}
                className="flex shrink-0 items-center gap-1 whitespace-nowrap"
                /* §M22: NOT dimmed. `StatusBarView.swift:284-301`'s `countLabel` carries one
                   unconditional `.foregroundStyle(theme.textSecondary)` for both branches, and
                   the source comment beside it spells the rule out — "0-count items stay plain
                   (un-dimmed, non-clickable)". Inert is about the click target, not the tone. */
                style={{ color: tokens.textSecondary }}
            >
                {content}
            </span>
        );
    }
    return (
        <button
            ref={props.anchorRef}
            type="button"
            data-testid={`count-${props.bucket}`}
            data-count={props.count}
            aria-label={`${props.count} ${BUCKET_LABEL[props.bucket]}`}
            aria-expanded={props.open}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap"
            /* §H11: the shipped chip is an AppKit button and answers the pointer; this one
               brightened for nothing at all before. Open counts as hovered, so the chip whose
               popover is up stays lit while the pointer is away in the panel. */
            data-hovered={props.hovered === true || props.open ? 'true' : 'false'}
            style={{
                color: hoverText(props.hovered === true || props.open, tokens.textSecondary),
                // S49, owner-directed — the clickable branch fills the 24 px row. See the constant.
                ...COUNT_CHIP_HIT_BOX
            }}
            {...(props.hoverBinding ?? {})}
            onClick={props.onToggle}
        >
            {content}
        </button>
    );
}

/**
 * The bucket popover's own box.
 *
 * `AgentStatusDetailPopover` is `.padding(12).frame(width: 252)` (`StatusBarView.swift:367-368`),
 * i.e. a **228 pt content box** with the `NSPopover`'s chrome outside that frame. This panel is a
 * `border-box` div with a 1 px border, so 252 here would spend 13 px a side and leave a 226 px
 * row — 2 px narrower than the shipped one on every bucket row. SPACING-REVIEW S31: carry the
 * two edges, exactly as §L49 already settled for the stat popover's `w-[222px]` (220 + the edge).
 */
export const BUCKET_POPOVER_WIDTH_PX = 254;
/** The little arrow that points back at the chip (`arrowEdge: .top`), as a rotated square. */
const BUCKET_POPOVER_ARROW_PX = 8;
/** How close the panel (and the arrow inside it) may come to an edge. */
const BUCKET_POPOVER_MARGIN_PX = 8;

export interface BucketPopoverPlacement {
    /** Offset from the footer row's leading edge, in px. */
    readonly left: number;
    /** The arrow's offset inside the panel, in px. */
    readonly arrowLeft: number;
}

/**
 * Where the bucket popover sits: centred on the chip that opened it (§M20).
 *
 * `StatusBarView.swift:269-283` attaches the popover per `StatusCountItem` with
 * `arrowEdge: .top`, so it rises out of the chip that was clicked. The port pinned one shared
 * node at `bottom-7 right-3`, which put the panel over by the clock however far to the left the
 * chip was — clicking "running" opened a panel nowhere near it.
 *
 * Pure, and separately tested, because the measurement it works from does not exist in jsdom: a
 * row with no width returns `null` and the caller keeps the old trailing placement rather than
 * clamping the panel to a nonsense left edge.
 */
export function bucketPopoverPlacement(
    chip: { readonly left: number; readonly width: number },
    row: { readonly left: number; readonly width: number },
    options: { readonly width?: number | undefined; readonly margin?: number | undefined } = {}
): BucketPopoverPlacement | null {
    const width = options.width ?? BUCKET_POPOVER_WIDTH_PX;
    const margin = options.margin ?? BUCKET_POPOVER_MARGIN_PX;
    // No usable measurement (jsdom, a row that has not been laid out yet).
    if (row.width < width + 2 * margin) return null;
    const centre = chip.left + chip.width / 2 - row.left;
    const maxLeft = row.width - width - margin;
    const left = Math.round(Math.min(Math.max(centre - width / 2, margin), maxLeft));
    const arrowInset = margin + BUCKET_POPOVER_ARROW_PX;
    const arrowLeft = Math.round(
        Math.min(Math.max(centre - left - BUCKET_POPOVER_ARROW_PX / 2, arrowInset), width - arrowInset)
    );
    return { left, arrowLeft };
}

/** Layout constants the fit calculation and the row's own CSS have to agree on. */
const FOOTER_ROW_PADDING_PX = 24; // `px-3`, both sides
/**
 * UI-FIDELITY L50 — the two clusters are ≥28 px apart, and the right half is one 14 px stack.
 *
 * `StatusBarView.swift:56` is `HStack(spacing: 10)` with `Spacer(minLength: 8)` between the two
 * sections, and SwiftUI applies the stack's spacing on BOTH sides of a `Spacer` — so the floor is
 * 10 + 8 + 10 = 28. `rightSection` (`:181-208`) is then a single `HStack(spacing: 14)` over the
 * gauges, the three counts and the clock, so every gap in that half is 14. The port had 12 px
 * everywhere except between gauges, which read as one undifferentiated right-hand run.
 */
const FOOTER_CLUSTER_GAP_PX = 28; // `gap-2.5` + the 8 px spacer + `gap-2.5`
const FOOTER_LEFT_GAP_PX = 8; // `gap-2` between the left cluster's segments
const GAUGE_GAP_PX = 14; // `gap-3.5` between gauges — and between every segment of the right half
const GAUGE_GRAPH_GAP_PX = 3; // `gap-[3px]` between a gauge's value slot and its sparkline
/**
 * What the left cluster keeps before a gauge may claim the space: enough for a middle-truncated
 * path AND the chips beside it. The Swift row has no equivalent because its right cluster simply
 * overflows; this is the number that stops the port doing the same thing (§N7).
 *
 * The floor matters: the branch chip (~32) + `doc N +A -B` (~49) + two 8 px gaps already need
 * 97, and both are `shrink-0`, so any reserve at or below that starves the path to 0 px at
 * every width — the N7 residue run-N measured. 97 for the chips + ~120 for a legible
 * middle-truncated path. Footers holding less than this (a bare `~`) still reserve only what
 * they want, via the `min(reserve, wanted)` below.
 */
const FOOTER_LEFT_RESERVE_PX = 220;

/** One gauge's rendered width: the fixed per-kind slot (§APP-081) plus its optional sparkline. */
export function statGaugeWidth(
    kind: string,
    options: { readonly showGraph: boolean; readonly graphWidth: number }
): number {
    const meta = systemStatMeta(kind);
    if (meta === null) return 0;
    return meta.labelWidth + (options.showGraph ? GAUGE_GRAPH_GAP_PX + options.graphWidth : 0);
}

/**
 * §N7 — the gauges the row can afford, in canonical order, dropping from the tail.
 *
 * A prefix, deliberately: the canonical order is the priority order (cpu, memory, load, …), so
 * the reading that survives a squeeze is the one nearest the top of the list rather than
 * whichever one happens to fit. An infinite budget (no measurement yet) keeps all of them.
 */
export function fitStatGauges<T extends string>(
    kinds: readonly T[],
    budget: number,
    widthOf: (kind: T) => number
): readonly T[] {
    if (!Number.isFinite(budget)) return kinds;
    const shown: T[] = [];
    let used = 0;
    for (const kind of kinds) {
        const next = used + (shown.length === 0 ? 0 : GAUGE_GAP_PX) + widthOf(kind);
        if (next > budget) break;
        shown.push(kind);
        used = next;
    }
    return shown;
}

/**
 * How much room the gauge row has, measured off the real boxes.
 *
 * Everything else in this file is CSS, and this is the one thing CSS cannot express: a flex
 * container's min-content size counts its children's min-content sizes whatever their
 * `min-width`, so the gauge row's intrinsic width propagates all the way out to the row and
 * makes the right cluster unshrinkable below it. The measurement replaces that with a decision:
 * available width, minus what the counts and the clock need (they never shrink), minus the
 * slice the left cluster keeps — and `fitStatGauges` spends what is left.
 *
 * Only the ROW is observed. The other two are read synchronously inside the callback: the keep
 * group never changes size on its own, and observing the left cluster would feed the effect the
 * output of its own decision.
 */
function useFooterGaugeBudget(
    rowRef: React.RefObject<HTMLDivElement | null>,
    leftRef: React.RefObject<HTMLDivElement | null>,
    keepRef: React.RefObject<HTMLDivElement | null>,
    deps: readonly string[]
): number | null {
    const [budget, setBudget] = useState<number | null>(null);
    const key = deps.join('|');
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (row === null || typeof ResizeObserver === 'undefined') return undefined;
        const measure = (): void => {
            const width = row.getBoundingClientRect().width;
            if (width <= 0) return;
            const keep = keepRef.current?.getBoundingClientRect().width ?? 0;
            /*
             * What the left cluster WANTS is the sum of its children's intrinsic widths, not
             * the container's `scrollWidth`. The children SHRINK (the path truncates toward
             * 0 px, the branch chip has `min-w-0`), so the container never overflows and its
             * scrollWidth merely echoes its current box — which made the reserve "whatever the
             * cluster already has", a circular measurement that kept the gauges at whatever
             * budget they took first (run-O attempts 1-2: path 0 px wide at every width). A
             * truncated child, by contrast, still reports its full content as ITS scrollWidth,
             * so summing children + gaps recovers the real want. This is intrinsic to the
             * content, not to the layout's current split, so it cannot feed the effect its own
             * output.
             */
            const left = leftRef.current;
            let wanted = 0;
            if (left !== null) {
                const children = Array.from(left.children) as HTMLElement[];
                for (const child of children) {
                    wanted += Math.max(child.scrollWidth, child.getBoundingClientRect().width);
                }
                wanted += Math.max(0, children.length - 1) * FOOTER_LEFT_GAP_PX;
            }
            const reserve = Math.min(FOOTER_LEFT_RESERVE_PX, wanted);
            const next = Math.round(
                // L50: the gap between the clusters (28) plus the one INSIDE the right half,
                // between the gauge row and the counts (14).
                width - FOOTER_ROW_PADDING_PX - keep - FOOTER_CLUSTER_GAP_PX - GAUGE_GAP_PX - reserve
            );
            setBudget((current) => (current === next ? current : next));
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(row);
        return () => {
            observer.disconnect();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, rowRef, leftRef, keepRef]);
    return budget;
}

export function StatusFooter(props: StatusFooterProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const home = props.homeDirectory ?? '';
    const [openBucket, setOpenBucket] = useState<AgentBucket | null>(null);
    const rowRef = useRef<HTMLDivElement | null>(null);
    const leftRef = useRef<HTMLDivElement | null>(null);
    const keepRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    /** One anchor per chip: what §M20 measures, and what an outside-click must not dismiss through. */
    const runningRef = useRef<HTMLButtonElement | null>(null);
    const waitingRef = useRef<HTMLButtonElement | null>(null);
    const inactiveRef = useRef<HTMLButtonElement | null>(null);
    const chipRefs: Readonly<Record<AgentBucket, RefObject<HTMLButtonElement | null>>> = {
        running: runningRef,
        waiting: waitingRef,
        inactive: inactiveRef
    };
    /** §H11: one hover slot for the whole footer (see `hover.ts`). */
    const [hovered, hover] = useHoverKey();

    const closeBucket = useCallback(() => {
        setOpenBucket(null);
    }, []);
    /*
     * §H15 — an `NSPopover` closes on any outside click and on Escape. This panel closed only
     * when the same chip was clicked again or a row was picked, so it sat over the pane grid
     * while the user typed. The chips are in the keep-list because a `mousedown` on the open
     * chip would otherwise dismiss the panel a moment before that chip's own click re-opened it.
     */
    useDismissable(openBucket !== null, closeBucket, [popoverRef, runningRef, waitingRef, inactiveRef]);
    /*
     * §N26 — the panel rises off the footer INTO the grid, so over a bottom web pane it was
     * painted under the page. It registers its box with `modal-presence`, which parks the panes
     * it actually covers — and only those — for as long as it is open.
     */
    useOverlayPresence(popoverRef, openBucket !== null);

    /*
     * §M20 — and it is anchored to the chip that opened it, measured off the real boxes. Null
     * (no measurement: jsdom, or a row narrower than the panel) keeps the trailing placement.
     */
    const [placement, setPlacement] = useState<BucketPopoverPlacement | null>(null);
    useLayoutEffect(() => {
        if (openBucket === null) {
            setPlacement(null);
            return;
        }
        const chip = chipRefs[openBucket].current;
        const row = rowRef.current;
        if (chip === null || row === null) {
            setPlacement(null);
            return;
        }
        const chipBox = chip.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        setPlacement(
            bucketPopoverPlacement(
                { left: chipBox.left, width: chipBox.width },
                { left: rowBox.left, width: rowBox.width }
            )
        );
        // The chip refs are stable boxes; the open bucket is the whole input.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openBucket]);

    const pane = props.focusedPane ?? null;
    const paneRunning = pane !== null && pane.status === 'running';
    // The ticker is only held open while something is actually showing a clock.
    const tickerSecond = useSecondsTicker(props.now === undefined);
    const nowMs = props.now ?? tickerSecond * 1000;

    const items = openBucket === null ? [] : (props.bucketItems?.(openBucket) ?? []);
    // §APP-071: the focused pane's working tree, resolved against the workspace's associations.
    const treeStats =
        pane === null
            ? null
            : footerGitStats(
                  props.associations ?? EMPTY_ASSOCIATIONS,
                  pane.workingDirectory,
                  pane.workingDirectoryReal
              );

    // The enabled set in canonical order, gated by the master toggle (`enabledStatKinds`).
    const stats = props.systemStats;
    const enabledGauges = stats === undefined ? [] : visibleStatKinds(stats.showSystemStats, stats.enabled);
    /*
     * §N7 — and then only the ones the row can afford.
     *
     * The gauges are the segment the status bar gives up first when it runs out of room, and
     * "gives up" has to mean UNMOUNTED rather than clipped: every gauge owns a hover popover
     * that is drawn above the footer, so an `overflow: hidden` anywhere over this row would cut
     * the popovers off at the window's bottom edge. Clipping is also not available on the row
     * itself (the bucket popover) — so the only honest way to drop a segment is to not render
     * it, which is what the Swift status bar's own `enabledStatKinds` does one level up.
     *
     * `gaugeBudget` is null until a measurement exists (and stays null wherever ResizeObserver
     * does not, e.g. jsdom), and null means "render them all" — the pre-measurement behaviour.
     */
    const gaugeBudget = useFooterGaugeBudget(rowRef, leftRef, keepRef, [
        enabledGauges.join(','),
        String(stats?.showGraphs === true),
        String(stats?.graphWidth ?? 28),
        `${String(props.summary.running)}/${String(props.summary.waiting)}/${String(props.summary.inactive)}`,
        /*
         * §N7 residue — the LEFT cluster's content is an input to the measurement, not only the
         * row's size. Focusing a repo pane swaps `~` for a long path plus the branch and stats
         * chips without the row ever resizing, so without this key the budget keeps the reserve
         * it took when the cluster held almost nothing and the gauges never yield — the path
         * stays 0 px wide at every width (run-O attempt 1, `footer-git-stats`). The key is
         * derived from props, not from the measurement, so it cannot feed the effect its own
         * output.
         */
        `${home}|${pane?.workingDirectory ?? ''}|${pane?.gitBranch ?? ''}|${treeStats === null ? 0 : 1}`
    ]);
    const gaugeWidth = (kind: string): number =>
        statGaugeWidth(kind, {
            showGraph: stats?.showGraphs === true,
            graphWidth: stats?.graphWidth ?? 28
        });
    const gauges = fitStatGauges(enabledGauges, gaugeBudget ?? Number.POSITIVE_INFINITY, gaugeWidth);
    // SET-044: an empty hex means "the adaptive chrome default", which is the footer's own
    // secondary tone — so a user who resets the colour follows the palette rather than being
    // stuck on whatever hex the theme they imported happened to carry.
    const graphColor =
        stats === undefined || stats.graphColor === '' ? tokens.textSecondary : stats.graphColor;

    return (
        <div
            ref={rowRef}
            data-testid="status-footer"
            // L50: `HStack(spacing: 10)`, with the `Spacer(minLength: 8)` below.
            className="relative flex h-6 shrink-0 items-center gap-2.5 border-t px-3 text-[11px]"
            style={{
                background: tokens.footerBackground,
                borderColor: tokens.divider,
                color: tokens.textSecondary
            }}
        >
            {/*
              * §N6 — the left cluster CLIPS, it does not spill.
              *
              * This row can shrink, but its children were fixed-size (`shrink-0`, or text with
              * no `min-w-0` to shrink into) inside a box with no `overflow-hidden`. At the width
              * the full audit run gives the footer — sidebar and inspector open, six system
              * stats on — the segments simply overflowed the box and were PAINTED OVER the
              * system-stat gauges beside them: `⑂ main 🗎 2 +5 -5` on top of the CPU chip
              * (docs/audit/run-L/52-footer-git-stats.png).
              *
              * Two rules fix it, and both are needed:
              *   1. `overflow-hidden` here — the hard guarantee. Whatever does not fit is
              *      clipped at this box's edge and can never reach the right cluster.
              *   2. an explicit shrink ORDER among the children, so the clipping is a last
              *      resort rather than the normal state: the path gives up its width first
              *      (it is the one segment that is already middle-truncated and still readable
              *      shortened), then the branch name, and the fixed little `doc N +A -B` and
              *      agent segments hold their size. That is the same priority SwiftUI's
              *      `HStack` + `.lineLimit(1)` produces for `leftSection` in the shipped app.
              *
              * §N7 — and the basis is `auto`, not `0`, which is the half N6 could not see.
              *
              * It used to be `flex-1` (`flex: 1 1 0%`). With a ZERO basis this cluster asks the
              * row for nothing, so the moment the row is over-subscribed — which it was at every
              * realistic width, because the right cluster's natural size was ~840 px — flexbox
              * hands it exactly its basis: 0 px. The path, the branch chip and `doc N +A -B`
              * were all clipped out of existence while the right cluster ran 485 px past the
              * footer's own box (run-M/56-footer-git-stats.png). `flex-auto` (`flex: 1 1 auto`)
              * makes the basis the content's own size, so the cluster STARTS from what it wants
              * to show and gives width up under pressure — after the gauges have gone, because
              * the gauge row is dropped by measurement before this cluster is asked for
              * anything (see `useFooterGaugeBudget`).
              */}
            <div
                ref={leftRef}
                data-testid="footer-left"
                className="flex min-w-0 flex-auto items-center gap-2 overflow-hidden"
            >
                {pane === null ? null : (
                    <>
                        <span
                            data-testid="footer-cwd"
                            className="min-w-0 truncate"
                            // Shrinks ~100× faster than the branch chip beside it, so the path
                            // is what gives way when the footer runs out of room. It is also the
                            // only segment that survives being shortened — hence the tooltip,
                            // which is where the whole path goes once the row is crowded.
                            //
                            // UI-FIDELITY L53 — and it gives way from the HEAD.
                            //
                            // `StatusBarView.swift:93-95` is `.truncationMode(.middle)`: the path
                            // loses its middle at the rendered width and keeps both ends. The port
                            // middle-truncated the STRING at 48 chars and then handed the result to
                            // a CSS tail ellipsis, so at the widths where the path actually gives
                            // way it kept `~/Users/be…` and threw away the leaf — the half that
                            // says which worktree the pane is in. CSS has no middle ellipsis, so
                            // the box truncates from its start instead (`direction: rtl` puts the
                            // ellipsis at the line's visual start; the `<bdi>` keeps the path
                            // itself laid out left-to-right, or a leading `~` would migrate to the
                            // far end). STATED DIVERGENCE: the ellipsis is at the head rather than
                            // in the middle — the 48-char cap still middle-truncates a pathological
                            // path — but the meaningful tail is what survives a squeeze, which is
                            // the property the shipped truncation is there for.
                            style={{
                                flexShrink: 100,
                                direction: 'rtl',
                                textAlign: 'left'
                            }}
                            title={homeAbbreviated(pane.workingDirectory, home)}
                        >
                            <bdi>{middleTruncate(homeAbbreviated(pane.workingDirectory, home), 48)}</bdi>
                        </span>
                        {pane.gitBranch === null ? null : (
                            <span
                                data-testid="footer-branch"
                                // L51: `HStack(spacing: 3)` around a 9 pt `arrow.triangle.branch`.
                                className="flex min-w-0 items-center gap-[3px]"
                                style={{ color: tokens.textTertiary, flexShrink: 1 }}
                            >
                                <span className="flex shrink-0 items-center">
                                    <ChromeIcon name="branch" size={9} />
                                </span>
                                <span className="truncate">{pane.gitBranch}</span>
                            </span>
                        )}
                        {treeStats === null ? null : <GitStats stats={treeStats} bucket={bucket} />}
                        {pane.agentSessionID === null ? null : paneRunning ? (
                            <span
                                data-testid="footer-agent"
                                className="shrink-0 whitespace-nowrap"
                                style={{ color: tokens.activeAgent }}
                            >
                                {/* §AGNT-063 / §APP-072: the Swift's literal default is "claude". */}
                                {pane.agentKind ?? 'claude'}
                                {/* L54: the elapsed is `.monospacedDigit()` — tabular figures, so
                                    a label that reticks every second does not jitter as `1` and
                                    `4` swap widths. Its own span: only the DIGITS are tabular. */}
                                {pane.agentStartedAt === null || pane.agentStartedAt === undefined ? (
                                    ''
                                ) : (
                                    <span className="tabular-nums">{` ${chromeElapsedLabel(pane.agentStartedAt, nowMs)}`}</span>
                                )}
                                {pane.backgroundTaskCount > 0 ? ` · ${pane.backgroundTaskCount} running` : ''}
                            </span>
                        ) : pane.status === 'waitingForInput' ? (
                            <span
                                data-testid="footer-agent"
                                className="shrink-0 whitespace-nowrap"
                                style={{ color: tokens.statusWaiting }}
                            >
                                awaiting input
                            </span>
                        ) : null}
                    </>
                )}
            </div>

            {/* L50: `Spacer(minLength: 8)`. `shrink-0` and no grow — the left cluster is the half
                that takes the slack here (its content is leading-aligned, so the picture is the
                same), and this only guarantees the floor the shipped row has: 10 + 8 + 10. */}
            <span aria-hidden data-testid="footer-cluster-gap" className="w-2 shrink-0" />

            {/* The right half of the row: gauges, counts, clock. Named so the audit can measure
              * the left cluster against it and prove §N6's overlap cannot come back.
              *
              * §N7 — it is no longer `shrink-0`, and the gauges are DROPPED rather than squashed.
              *
              * `shrink-0` on a cluster whose natural width is ~840 px meant the row could never
              * balance: the left cluster was starved to 0 px and the right one still overran the
              * footer's own box by 485 px, sideways under the inspector. Three rules replace it:
              *
              *   · the gauge row is unmounted a reading at a time as the row narrows
              *     (`useFooterGaugeBudget` + `fitStatGauges`), because a flex container's
              *     min-content size counts its children whatever their `min-width` — CSS alone
              *     cannot make this segment yield — and because CLIPPING it is not available:
              *     every gauge owns a hover popover drawn above the footer;
              *   · what is left is the counts and the clock, which are `shrink-0`, so this
              *     cluster's automatic minimum IS them — hence no `min-w-0` here, which would
              *     let the row crush `3 running` into nothing;
              *   · and a large shrink factor, so during the frame between a resize and the next
              *     measurement it gives way toward that minimum instead of overflowing.
              *
              * The result at the audit's three widths: the gauges thin out and then go; the
              * counts and clock stay whole; the left cluster keeps a real width throughout; and
              * nothing leaves the footer's box.
              */}
            <div
                data-testid="footer-right"
                // L50: one 14 px stack, gauges through clock (`rightSection`'s `HStack(spacing: 14)`).
                className="flex items-center gap-3.5"
                style={{ flexShrink: 1000 }}
            >
                {gauges.length > 0 ? (
                    // Spacing-separated, no dot separators — the gaps carry the grouping
                    // (`rightSection`'s `HStack(spacing: 14)`). `shrink-0`: a gauge is either
                    // rendered at its own size or not rendered at all.
                    <div data-testid="system-stats" className="flex shrink-0 items-center gap-3.5">
                        {gauges.map((kind) => (
                            <SystemStatGauge
                                key={kind}
                                kind={kind}
                                stats={stats?.stats ?? ZERO_SYSTEM_STATS}
                                history={stats?.history[kind] ?? EMPTY_SAMPLES}
                                showGraph={stats?.showGraphs === true}
                                graphColor={graphColor}
                                graphWidth={stats?.graphWidth ?? 28}
                                graphStyle={stats?.graphStyle ?? 'line'}
                                intervalMs={stats?.intervalMs ?? SYSTEM_STATS_INTERVAL_MS}
                            />
                        ))}
                    </div>
                ) : props.sparklineSamples === undefined ? null : (
                    <span className="flex shrink-0 items-center">
                        <SystemSparkline samples={props.sparklineSamples} label={props.sparklineLabel} />
                    </span>
                )}
                {/* The segments the row keeps at any width, grouped so the budget above can
                  * measure exactly what it must leave room for. */}
                <div
                    ref={keepRef}
                    data-testid="footer-keep"
                    // L50: the counts and the clock are part of the same 14 px stack.
                    className="flex shrink-0 items-center gap-3.5"
                >
                    <CountItem
                        bucket="running"
                        count={props.summary.running}
                        open={openBucket === 'running'}
                        anchorRef={runningRef}
                        hovered={hovered === 'count:running'}
                        hoverBinding={hover('count:running')}
                        onToggle={() => {
                            setOpenBucket(openBucket === 'running' ? null : 'running');
                        }}
                    />
                    <CountItem
                        bucket="waiting"
                        count={props.summary.waiting}
                        open={openBucket === 'waiting'}
                        anchorRef={waitingRef}
                        hovered={hovered === 'count:waiting'}
                        hoverBinding={hover('count:waiting')}
                        onToggle={() => {
                            setOpenBucket(openBucket === 'waiting' ? null : 'waiting');
                        }}
                    />
                    <CountItem
                        bucket="inactive"
                        count={props.summary.inactive}
                        open={openBucket === 'inactive'}
                        anchorRef={inactiveRef}
                        hovered={hovered === 'count:inactive'}
                        hoverBinding={hover('count:inactive')}
                        onToggle={() => {
                            setOpenBucket(openBucket === 'inactive' ? null : 'inactive');
                        }}
                    />
                    {/* §N7: the clock is the last thing the row would give up — it never does. */}
                    <span data-testid="footer-clock" className="shrink-0 font-mono tabular-nums">
                        {clockLabel(new Date(nowMs))}
                    </span>
                </div>
            </div>

            {openBucket === null ? null : (
                <div
                    ref={popoverRef}
                    data-testid="bucket-popover"
                    role="dialog"
                    aria-label={BUCKET_LABEL[openBucket]}
                    data-anchored={placement === null ? 'false' : 'true'}
                    /*
                     * §M21 — `AgentStatusDetailPopover`'s own metrics, not the footer's.
                     *
                     * `StatusBarView.swift:340-408` is `VStack(alignment: .leading, spacing: 6)`
                     * inside `.padding(12)`, and its rows are 12 pt — a popover is a surface of
                     * its own, so it does not inherit the 11 px the status row is drawn at. The
                     * port padded 8 px and let everything inherit, which flattened the title
                     * into the rows and the rows into the chips behind them.
                     */
                    className={`absolute bottom-7 z-40 flex w-[254px] flex-col gap-1.5 rounded-lg p-3 text-[12px] ${
                        placement === null ? 'right-3' : ''
                    }`}
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)',
                        ...(placement === null ? {} : { left: placement.left })
                    }}
                >
                    {/* `arrowEdge: .top` — the panel rises out of the chip and points back at
                        it. A rotated square with two borders is the DOM's version of the
                        `NSPopover` beak; `aria-hidden` because it is pure decoration. */}
                    {placement === null ? null : (
                        <span
                            aria-hidden
                            data-testid="bucket-popover-arrow"
                            className="absolute h-[8px] w-[8px] rotate-45"
                            style={{
                                left: placement.arrowLeft,
                                bottom: -5,
                                background: tokens.surfaceBackground,
                                borderRight: `1px solid ${tokens.divider}`,
                                borderBottom: `1px solid ${tokens.divider}`
                            }}
                        />
                    )}
                    {/* §M21: `HStack(spacing: 6)` — a 7 px dot beside a 13 pt semibold title,
                        with the header's own `.padding(.bottom, 2)` on top of the stack's 6. */}
                    <div
                        data-testid="bucket-popover-title"
                        className="flex items-center gap-1.5 pb-[2px] text-[13px] font-semibold"
                        style={{ color: tokens.textPrimary }}
                    >
                        <span
                            aria-hidden
                            className="h-[7px] w-[7px] rounded-full"
                            style={{ background: bucketColor(openBucket) }}
                        />
                        {BUCKET_LABEL[openBucket]}
                    </div>
                    {items.length === 0 ? (
                        <div style={{ color: tokens.textTertiary }}>None.</div>
                    ) : (
                        // §M21: `VStack(alignment: .leading, spacing: 2)` — the rows are a stack
                        // of their own, so they sit 2 px apart rather than flush against each
                        // other the way bare siblings of the header did.
                        <div data-testid="bucket-popover-rows" className="flex flex-col gap-[2px]">
                            {items.map((item) => (
                                <button
                                    key={item.paneID}
                                    type="button"
                                    data-testid="bucket-row"
                                    className="flex w-full items-center gap-1.5 rounded text-left"
                                    /* §H11: the row under the pointer is the row a click acts on,
                                       so it is painted — `ContextMenu`'s rule, same fill. */
                                    data-hovered={hovered === `bucket:${item.paneID}` ? 'true' : 'false'}
                                    style={{
                                        background: hoverFill(hovered === `bucket:${item.paneID}`),
                                        /*
                                         * §M21: `rowContent`'s `.padding(.vertical, 3)
                                         * .padding(.horizontal, 4)`.
                                         *
                                         * Inline, not `px-1 py-[3px]`. It had to be: `styles.css`'s
                                         * `button { padding: 0 }` was UNLAYERED and outranked
                                         * Tailwind's layered utilities, so the classes this row
                                         * carried drew NOTHING — the audit measured `padding-top:
                                         * 0px` through a `py-1`. S1/S17 has since moved that reset
                                         * into `@layer base`, so a class would land now; 3/4 stays
                                         * inline because it is §M21's stated number, asserted on
                                         * the style in `footer-popover.test.tsx`.
                                         */
                                        padding: '3px 4px'
                                    }}
                                    {...hover(`bucket:${item.paneID}`)}
                                    onClick={() => {
                                        setOpenBucket(null);
                                        props.onSelectPane?.(item.workspaceID, item.paneID);
                                    }}
                                >
                                    <span
                                        aria-hidden
                                        className="h-[7px] w-[7px] shrink-0 rounded-full"
                                        style={{ background: workspaceColorHex(item.workspaceColor, bucket) }}
                                    />
                                    <span className="shrink-0" style={{ color: tokens.textSecondary }}>
                                        {item.workspaceName}
                                    </span>
                                    <span style={{ color: tokens.textTertiary }}>·</span>
                                    {/*
                                      * UI-FIDELITY L56 — the title gives way to the WIDTH, not to
                                      * a character count.
                                      *
                                      * `rowContent` (`StatusBarView.swift:390-394`) is
                                      * `.lineLimit(1).truncationMode(.middle)`: the title is
                                      * shortened only when the 252 pt panel actually runs out of
                                      * room. The port cut every title at 24 characters first, so a
                                      * pane called `claude · refactor the parser` was ellipsised
                                      * with 60 px of panel to spare. Truncation is CSS's now, and
                                      * it starts at the head so the distinguishing tail survives —
                                      * L53's rule, and the same stated divergence (a head ellipsis
                                      * where SwiftUI puts a middle one).
                                      */}
                                    <span
                                        data-testid="bucket-row-title"
                                        className="min-w-0 shrink truncate"
                                        style={{
                                            color: tokens.textPrimary,
                                            direction: 'rtl',
                                            textAlign: 'left'
                                        }}
                                    >
                                        <bdi>{item.paneTitle}</bdi>
                                    </span>
                                    {/* L56: `Spacer(minLength: 10)` — the row's flexible gap, with
                                        a floor, so the title can never abut the elapsed. */}
                                    <span aria-hidden className="min-w-[10px] flex-1" />
                                    {openBucket === 'running' &&
                                    item.agentStartedAt !== null &&
                                    item.agentStartedAt !== undefined ? (
                                        // L54: `.monospacedDigit()` here too — this label reticks
                                        // every second while the popover is open.
                                        <span
                                            className="shrink-0 tabular-nums"
                                            style={{ color: tokens.activeAgent }}
                                        >
                                            {chromeElapsedLabel(item.agentStartedAt, nowMs)}
                                        </span>
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

const EMPTY_SAMPLES: readonly number[] = [];
const EMPTY_ASSOCIATIONS: readonly FooterAssociation[] = [];
const EMPTY_FORMS: readonly string[] = [];
