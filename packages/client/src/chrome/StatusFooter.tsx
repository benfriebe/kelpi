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

import { useState, type ReactElement } from 'react';

import { useSecondsTicker } from './clock';
import { ChromeIcon } from './icons';
import { Sparkline, SystemStatGauge, type SparklineStyle } from './SystemStatGauge';
import { visibleStatKinds } from './stats';
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

/** The Swift's `gitStatsLabel`: `doc N`, then `+A` in green and `-B` in red, 10 pt monospaced. */
function GitStats({ stats }: { readonly stats: FooterGitStats }): ReactElement {
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
            {stats.additions > 0 ? <span style={{ color: '#5FBE89' }}>+{stats.additions}</span> : null}
            {stats.deletions > 0 ? <span style={{ color: '#E0655C' }}>-{stats.deletions}</span> : null}
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
}

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
                className="flex items-center gap-1"
                style={{ color: tokens.textTertiary }}
            >
                {content}
            </span>
        );
    }
    return (
        <button
            type="button"
            data-testid={`count-${props.bucket}`}
            data-count={props.count}
            aria-label={`${props.count} ${BUCKET_LABEL[props.bucket]}`}
            aria-expanded={props.open}
            className="flex items-center gap-1"
            style={{ color: tokens.textSecondary }}
            onClick={props.onToggle}
        >
            {content}
        </button>
    );
}

export function StatusFooter(props: StatusFooterProps): ReactElement {
    const bucket = props.bucket ?? 'dark';
    const home = props.homeDirectory ?? '';
    const [openBucket, setOpenBucket] = useState<AgentBucket | null>(null);

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
    const gauges = stats === undefined ? [] : visibleStatKinds(stats.showSystemStats, stats.enabled);
    // SET-044: an empty hex means "the adaptive chrome default", which is the footer's own
    // secondary tone — so a user who resets the colour follows the palette rather than being
    // stuck on whatever hex the theme they imported happened to carry.
    const graphColor =
        stats === undefined || stats.graphColor === '' ? tokens.textSecondary : stats.graphColor;

    return (
        <div
            data-testid="status-footer"
            className="relative flex h-6 shrink-0 items-center gap-3 border-t px-3 text-[11px]"
            style={{
                background: tokens.footerBackground,
                borderColor: tokens.divider,
                color: tokens.textSecondary
            }}
        >
            {/*
              * §N6 — the left cluster CLIPS, it does not spill.
              *
              * This row is `flex-1 min-w-0` so it can shrink, but its children were fixed-size
              * (`shrink-0`, or text with no `min-w-0` to shrink into) inside a box with no
              * `overflow-hidden`. At the width the full audit run gives the footer — sidebar and
              * inspector open, six system stats on — the segments simply overflowed the box and
              * were PAINTED OVER the system-stat gauges beside them: `⑂ main 🗎 2 +5 -5` on top
              * of the CPU chip (docs/audit/run-L/52-footer-git-stats.png).
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
              */}
            <div
                data-testid="footer-left"
                className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
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
                            style={{ flexShrink: 100 }}
                            title={homeAbbreviated(pane.workingDirectory, home)}
                        >
                            {middleTruncate(homeAbbreviated(pane.workingDirectory, home), 48)}
                        </span>
                        {pane.gitBranch === null ? null : (
                            <span
                                data-testid="footer-branch"
                                className="flex min-w-0 items-center gap-1"
                                style={{ color: tokens.textTertiary, flexShrink: 1 }}
                            >
                                <span className="flex shrink-0 items-center">
                                    <ChromeIcon name="branch" size={10} />
                                </span>
                                <span className="truncate">{pane.gitBranch}</span>
                            </span>
                        )}
                        {treeStats === null ? null : <GitStats stats={treeStats} />}
                        {pane.agentSessionID === null ? null : paneRunning ? (
                            <span
                                data-testid="footer-agent"
                                className="shrink-0 whitespace-nowrap"
                                style={{ color: tokens.activeAgent }}
                            >
                                {/* §AGNT-063 / §APP-072: the Swift's literal default is "claude". */}
                                {pane.agentKind ?? 'claude'}
                                {pane.agentStartedAt === null || pane.agentStartedAt === undefined
                                    ? ''
                                    : ` ${chromeElapsedLabel(pane.agentStartedAt, nowMs)}`}
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

            {/* The fixed half of the row: gauges, counts, clock. Named so the audit can measure
              * the left cluster against it and prove §N6's overlap cannot come back. */}
            <div data-testid="footer-right" className="flex shrink-0 items-center gap-3">
                {gauges.length > 0 ? (
                    // Spacing-separated, no dot separators — the gaps carry the grouping
                    // (`rightSection`'s `HStack(spacing: 14)`).
                    <div data-testid="system-stats" className="flex items-center gap-3.5">
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
                    <SystemSparkline samples={props.sparklineSamples} label={props.sparklineLabel} />
                )}
                <CountItem
                    bucket="running"
                    count={props.summary.running}
                    open={openBucket === 'running'}
                    onToggle={() => {
                        setOpenBucket(openBucket === 'running' ? null : 'running');
                    }}
                />
                <CountItem
                    bucket="waiting"
                    count={props.summary.waiting}
                    open={openBucket === 'waiting'}
                    onToggle={() => {
                        setOpenBucket(openBucket === 'waiting' ? null : 'waiting');
                    }}
                />
                <CountItem
                    bucket="inactive"
                    count={props.summary.inactive}
                    open={openBucket === 'inactive'}
                    onToggle={() => {
                        setOpenBucket(openBucket === 'inactive' ? null : 'inactive');
                    }}
                />
                <span data-testid="footer-clock" className="font-mono tabular-nums">
                    {clockLabel(new Date(nowMs))}
                </span>
            </div>

            {openBucket === null ? null : (
                <div
                    data-testid="bucket-popover"
                    role="dialog"
                    aria-label={BUCKET_LABEL[openBucket]}
                    className="absolute bottom-7 right-3 z-40 w-[252px] rounded-lg p-2"
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)'
                    }}
                >
                    <div className="mb-1 flex items-center gap-1.5" style={{ color: tokens.textPrimary }}>
                        <span
                            aria-hidden
                            className="h-[6px] w-[6px] rounded-full"
                            style={{ background: bucketColor(openBucket) }}
                        />
                        {BUCKET_LABEL[openBucket]}
                    </div>
                    {items.length === 0 ? (
                        <div style={{ color: tokens.textTertiary }}>None.</div>
                    ) : (
                        items.map((item) => (
                            <button
                                key={item.paneID}
                                type="button"
                                data-testid="bucket-row"
                                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left"
                                onClick={() => {
                                    setOpenBucket(null);
                                    props.onSelectPane?.(item.workspaceID, item.paneID);
                                }}
                            >
                                <span
                                    aria-hidden
                                    className="h-[6px] w-[6px] shrink-0 rounded-full"
                                    style={{ background: workspaceColorHex(item.workspaceColor, bucket) }}
                                />
                                <span className="shrink-0" style={{ color: tokens.textSecondary }}>
                                    {item.workspaceName}
                                </span>
                                <span style={{ color: tokens.textTertiary }}>·</span>
                                <span className="min-w-0 flex-1 truncate" style={{ color: tokens.textPrimary }}>
                                    {middleTruncate(item.paneTitle, 24)}
                                </span>
                                {openBucket === 'running' &&
                                item.agentStartedAt !== null &&
                                item.agentStartedAt !== undefined ? (
                                    <span className="shrink-0" style={{ color: tokens.activeAgent }}>
                                        {chromeElapsedLabel(item.agentStartedAt, nowMs)}
                                    </span>
                                ) : null}
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}

const EMPTY_SAMPLES: readonly number[] = [];
const EMPTY_ASSOCIATIONS: readonly FooterAssociation[] = [];
const EMPTY_FORMS: readonly string[] = [];
