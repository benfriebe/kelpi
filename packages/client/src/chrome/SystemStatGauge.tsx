/**
 * One footer stat: icon + value in a fixed slot, an optional inline sparkline, and a hover
 * popover with the verbose breakdown and a larger history graph.
 *
 * Ported from `Nex/Features/StatusBar/SystemStatGauge.swift`. Three behaviours here are
 * contracts rather than styling, and each has a checklist item behind it:
 *
 *   - **APP-081, the fixed slot.** The icon+value cluster is right-aligned inside a per-kind
 *     fixed width (44 / 50 / 60 px). The value therefore abuts its sparkline with no internal
 *     gap and the slack falls *before* the icon, reading as inter-metric spacing — so the
 *     value's right edge, and everything to the right of it, never moves as `9%` becomes
 *     `100%`. A footer whose clock shuffles sideways once a second is the failure this avoids.
 *   - **APP-082, the two scales.** Percentage metrics plot against a fixed 0…100 so an idle
 *     CPU looks idle; rate metrics auto-scale to the window max so a flat non-zero trace is
 *     still legible. Fewer than two samples draws nothing (there is no line through one point).
 *   - **APP-083, the popover.** Name, breakdown, a large FILLED graph, now/min/max/avg over the
 *     retained window, and a "last N samples · ~Ns" footnote derived from the daemon's cadence.
 *
 * The popover opens on hover *and* on focus, and the gauge is a `button`: the Swift version is
 * mouse-only, which leaves the detail unreachable by keyboard. Same content, one more way in.
 */

import { useId, useRef, useState, type ReactElement } from 'react';

import { ChromeIcon } from './icons';
import { useOverlayPresence } from './modal-presence';
import {
    compactStatLabel,
    detailStatLabel,
    historyFootnote,
    sparklineRange,
    summarizeHistory,
    summaryStatValue,
    systemStatMeta,
    type SystemStatKind
} from './stats';
import { withAlpha } from './theme';
import { tokens } from './tokens';
import type { WsSystemStats } from '@kelpi/protocol';

export type SparklineStyle = 'line' | 'dots';

export interface SparklineProps {
    readonly values: readonly number[];
    readonly isPercentage: boolean;
    readonly color: string;
    readonly style?: SparklineStyle | undefined;
    readonly filled?: boolean | undefined;
    readonly width: number;
    readonly height: number;
    readonly label?: string | undefined;
    readonly testID?: string | undefined;
}

/**
 * `Sparkline` — the `.line` (optionally area-filled) and `.dots` (a column of stacked dots per
 * sample, height tracking the value) styles from the Swift `Canvas`.
 *
 * Rendered as inline SVG rather than a canvas: it must take the chrome's own colours, scale
 * with the device pixel ratio for free, and be inspectable by the audit harness — a `<canvas>`
 * would be an opaque rectangle to every assertion in `scripts/ui-audit`.
 */
export function Sparkline(props: SparklineProps): ReactElement {
    const { values, width, height } = props;
    const style = props.style ?? 'line';
    if (values.length < 2) {
        // §8.1 gates every gauge on the master toggle, so with no data there is nothing for a
        // user to see: the slot stays (the numbers beside it must not jump when data lands)
        // but paints nothing. run-B nit m2 was exactly this chip being visible and empty.
        return (
            <span
                data-testid={props.testID ?? 'sparkline-placeholder'}
                aria-hidden
                className="inline-block"
                style={{ width, height, background: 'transparent' }}
            />
        );
    }
    const range = sparklineRange(props.isPercentage, values);
    const common = {
        width,
        height,
        viewBox: `0 0 ${String(width)} ${String(height)}`,
        role: props.label === undefined ? ('presentation' as const) : ('img' as const),
        'aria-label': props.label,
        'data-testid': props.testID ?? 'sparkline',
        'data-samples': String(values.length)
    };

    if (style === 'dots') {
        // The Swift geometry verbatim: 3pt columns, 2.6pt rows, r=1, most recent flush right.
        const columnSpacing = 3;
        const rowSpacing = 2.6;
        const radius = 1;
        const rows = Math.max(1, Math.floor(height / rowSpacing));
        const columns = Math.max(1, Math.floor(width / columnSpacing));
        const recent = values.slice(Math.max(0, values.length - columns));
        const dots: ReactElement[] = [];
        recent.forEach((value, index) => {
            const norm = Math.min(1, Math.max(0, value / range));
            const litRows = Math.round(norm * rows);
            const x = width - (recent.length - index) * columnSpacing + columnSpacing / 2;
            for (let row = 0; row < rows; row += 1) {
                const y = height - (row + 0.5) * rowSpacing;
                dots.push(
                    <circle
                        key={`${String(index)}-${String(row)}`}
                        cx={x}
                        cy={y}
                        r={radius}
                        fill={row < litRows ? props.color : withAlpha(props.color, 0.12)}
                    />
                );
            }
        });
        return <svg {...common}>{dots}</svg>;
    }

    const stepX = width / (values.length - 1);
    const point = (index: number): string => {
        const norm = Math.min(1, Math.max(0, (values[index] as number) / range));
        const y = height - norm * (height - 1) - 0.5;
        return `${(index * stepX).toFixed(2)},${y.toFixed(2)}`;
    };
    const points = values.map((_, index) => point(index)).join(' ');
    return (
        <svg {...common}>
            {props.filled === true ? (
                <polygon
                    points={`0,${String(height)} ${points} ${String(width)},${String(height)}`}
                    fill={withAlpha(props.color, 0.15)}
                    stroke="none"
                />
            ) : null}
            <polyline points={points} fill="none" stroke={props.color} strokeWidth={1} strokeLinejoin="round" />
        </svg>
    );
}

export interface SystemStatGaugeProps {
    readonly kind: SystemStatKind;
    readonly stats: WsSystemStats;
    readonly history: readonly number[];
    readonly showGraph: boolean;
    readonly graphColor: string;
    readonly graphWidth: number;
    readonly graphStyle: SparklineStyle;
    readonly intervalMs: number;
}

export function SystemStatGauge(props: SystemStatGaugeProps): ReactElement | null {
    const meta = systemStatMeta(props.kind);
    const [open, setOpen] = useState(false);
    const popoverID = useId();
    const popoverRef = useRef<HTMLDivElement | null>(null);
    /*
     * §N26 — a 222 px card that rises off the footer into the grid, so over a bottom web pane it
     * was painted under the page (`docs/audit/n26-popup-layering`, step `05-stat-popover`).
     *
     * This is the surface that decided the shape of the fix. It opens on HOVER: enrolling it the
     * way H1 enrolled the dialogs would blank EVERY page in the window each time the pointer
     * swept the footer, one native attach/detach per pass. Registering its box instead parks
     * only the pane the card is actually over — usually one, often none.
     *
     * Hooks before the `meta === null` guard: an early return above them would make the hook
     * order depend on the stat kind.
     */
    useOverlayPresence(popoverRef, open);
    if (meta === null) return null;

    const value = compactStatLabel(meta.kind, props.stats);
    const summary = summarizeHistory(props.history);

    return (
        <span className="relative flex items-center">
            <button
                type="button"
                data-testid={`stat-gauge-${meta.kind}`}
                data-value={value}
                aria-label={`${meta.displayName} ${value}`}
                aria-expanded={open}
                aria-controls={open ? popoverID : undefined}
                className="flex items-center gap-[3px]"
                style={{ color: tokens.textTertiary }}
                onMouseEnter={() => {
                    setOpen(true);
                }}
                onMouseLeave={() => {
                    setOpen(false);
                }}
                onFocus={() => {
                    setOpen(true);
                }}
                onBlur={() => {
                    setOpen(false);
                }}
            >
                <span
                    className="flex items-center justify-end gap-[3px]"
                    style={{ width: meta.labelWidth }}
                >
                    <ChromeIcon name={meta.icon} size={9} />
                    <span className="font-mono tabular-nums">{value}</span>
                </span>
                {props.showGraph ? (
                    <Sparkline
                        testID={`stat-sparkline-${meta.kind}`}
                        values={props.history}
                        isPercentage={meta.isPercentage}
                        color={props.graphColor}
                        style={props.graphStyle}
                        filled
                        width={props.graphWidth}
                        height={11}
                    />
                ) : null}
            </button>

            {open ? (
                <div
                    ref={popoverRef}
                    id={popoverID}
                    role="dialog"
                    aria-label={meta.displayName}
                    data-testid={`stat-popover-${meta.kind}`}
                    /*
                     * UI-FIDELITY L49 — `StatDetailPopover`'s own metrics.
                     *
                     * `SystemStatGauge.swift:129-162` is `.padding(12).frame(width: 220)`, so its
                     * CONTENT box is 196 pt wide — exactly the width of the graph below. The 220
                     * is measured inside the `NSPopover`'s own chrome; here that chrome is this
                     * card's 1 px border, which `border-box` counts INSIDE the width, so the
                     * declared width carries it: 222 = 220 of Swift + the edge.
                     */
                    className="absolute bottom-6 right-0 z-40 flex w-[222px] flex-col gap-2 rounded-lg p-3 text-[11px]"
                    style={{
                        background: tokens.surfaceBackground,
                        border: `1px solid ${tokens.divider}`,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.38)',
                        color: tokens.textSecondary
                    }}
                >
                    <div className="flex items-center gap-1.5" style={{ color: tokens.textPrimary }}>
                        <ChromeIcon name={meta.icon} size={11} />
                        {/* L49: 13 pt semibold (`.font(.system(size: 13, weight: .semibold))`). */}
                        <span className="text-[13px] font-semibold">{meta.displayName}</span>
                    </div>
                    {/* L49: the breakdown is 12 pt SYSTEM with `.monospacedDigit()` — tabular
                        figures in the UI face, not a monospace face at 11 px. */}
                    <div data-testid={`stat-detail-${meta.kind}`} className="text-[12px] tabular-nums">
                        {detailStatLabel(meta.kind, props.stats)}
                    </div>
                    {/* L49: `.frame(width: 196, height: 52)` with the 6 pt rounded fill/stroke
                        drawn AS that frame — no inset, so the trace fills its box. The stroke is
                        an INSET shadow, not a border: `.strokeBorder` paints inside the frame,
                        where a CSS border would eat 2 px of the 196 the graph needs. */}
                    <div
                        className="rounded-md"
                        style={{
                            background: withAlpha(tokens.textPrimary, 0.04),
                            boxShadow: `inset 0 0 0 1px ${tokens.divider}`,
                            lineHeight: 0
                        }}
                    >
                        <Sparkline
                            testID={`stat-graph-${meta.kind}`}
                            values={props.history}
                            isPercentage={meta.isPercentage}
                            color={props.graphColor}
                            style={props.graphStyle}
                            filled
                            width={196}
                            height={52}
                        />
                    </div>
                    <div className="flex gap-3.5">
                        {(
                            [
                                ['now', summary.now],
                                ['min', summary.min],
                                ['max', summary.max],
                                ['avg', summary.avg]
                            ] as const
                        ).map(([label, number]) => (
                            <span key={label} className="flex flex-col items-center gap-px">
                                <span className="text-[8px]" style={{ color: tokens.textTertiary }}>
                                    {label}
                                </span>
                                <span className="font-mono tabular-nums">
                                    {summaryStatValue(meta.kind, number)}
                                </span>
                            </span>
                        ))}
                    </div>
                    <span className="text-[9px]" style={{ color: tokens.textTertiary }}>
                        {historyFootnote(summary.count, props.intervalMs)}
                    </span>
                </div>
            ) : null}
        </span>
    );
}
