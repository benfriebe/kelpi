/**
 * The bottom status bar (shell-ui.md §8, agent-lifecycle.md §9).
 *
 * Left cluster = the focused pane of the active workspace: home-abbreviated + middle-truncated
 * cwd, git branch, then the agent segment (running → `<kind> <elapsed>` in amber with a 1s
 * ticker; waiting → `awaiting input` in the waiting color; idle → nothing).
 *
 * Right cluster = the sparkline slot (system stats are sampled by the DAEMON in this
 * architecture — §15 — so this renders whatever samples assembly hands it and a placeholder
 * until then), then the three global agent counts, then a live `HH:MM` clock.
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
import {
    chromeElapsedLabel,
    clockLabel,
    homeAbbreviated,
    middleTruncate,
    withAlpha,
    workspaceColorHex,
    type ChromeBucket
} from './theme';
import { tokens } from './tokens';
import type { ChromePane } from './types';
import type { WorkspaceColor } from '@nex/daemon/store';

export type AgentBucket = 'running' | 'waiting' | 'inactive';

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
    /** Frozen clock for tests; defaults to the live 1s ticker. */
    readonly now?: number | undefined;
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
 * A tiny SVG trace. Percentage-bounded metrics scale 0–100; anything else auto-scales to the
 * window max (§8.1). With fewer than two samples the spec keeps the slot but draws nothing —
 * that empty slot is the placeholder.
 */
export function SystemSparkline(props: {
    readonly samples: readonly number[];
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly label?: string | undefined;
}): ReactElement {
    const width = props.width ?? 28;
    const height = props.height ?? 11;
    const samples = props.samples;
    if (samples.length < 2) {
        return (
            <span
                data-testid="sparkline-placeholder"
                aria-hidden
                className="inline-block rounded-[2px]"
                style={{ width, height, background: withAlpha('#E6E6EA', 0.06) }}
            />
        );
    }
    const max = Math.max(...samples, 1);
    const step = width / (samples.length - 1);
    const points = samples
        .map((value, index) => `${(index * step).toFixed(2)},${(height - (value / max) * height).toFixed(2)}`)
        .join(' ');
    return (
        <svg
            data-testid="sparkline"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role={props.label === undefined ? 'presentation' : 'img'}
            aria-label={props.label}
        >
            <polyline
                points={points}
                fill="none"
                stroke={tokens.textSecondary}
                strokeWidth={1}
                strokeLinejoin="round"
            />
        </svg>
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
            <div className="flex min-w-0 flex-1 items-center gap-2">
                {pane === null ? null : (
                    <>
                        <span data-testid="footer-cwd" className="truncate">
                            {middleTruncate(homeAbbreviated(pane.workingDirectory, home), 48)}
                        </span>
                        {pane.gitBranch === null ? null : (
                            <span
                                data-testid="footer-branch"
                                className="flex items-center gap-1"
                                style={{ color: tokens.textTertiary }}
                            >
                                <ChromeIcon name="branch" size={10} />
                                {pane.gitBranch}
                            </span>
                        )}
                        {pane.agentSessionID === null ? null : paneRunning ? (
                            <span data-testid="footer-agent" style={{ color: tokens.activeAgent }}>
                                {pane.agentKind ?? 'agent'}
                                {pane.agentStartedAt === null || pane.agentStartedAt === undefined
                                    ? ''
                                    : ` ${chromeElapsedLabel(pane.agentStartedAt, nowMs)}`}
                                {pane.backgroundTaskCount > 0 ? ` · ${pane.backgroundTaskCount} running` : ''}
                            </span>
                        ) : pane.status === 'waitingForInput' ? (
                            <span data-testid="footer-agent" style={{ color: tokens.statusWaiting }}>
                                awaiting input
                            </span>
                        ) : null}
                    </>
                )}
            </div>

            <div className="flex shrink-0 items-center gap-3">
                <SystemSparkline
                    samples={props.sparklineSamples ?? EMPTY_SAMPLES}
                    label={props.sparklineLabel}
                />
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
