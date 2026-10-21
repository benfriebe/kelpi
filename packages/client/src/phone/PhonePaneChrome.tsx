/**
 * What frames a pane on the phone, above and below it.
 *
 *   header  the pane's name, what it is doing ("waiting · 4m", "running"), where it is working,
 *           the one-pane / full-layout toggle, and ⋯ for the pane's actions
 *   strip   between the pane and the location bar: previous and next pane with a dot per pane,
 *           and the attention pill when something on any host is waiting
 *
 * The strip is always the same height while a workspace is on screen, pill or no pill, so a wait
 * starting somewhere else never resizes the terminal under the person's thumb.
 */

import { useRef, type ReactElement, type TouchEvent } from 'react';

import { tokens } from '../chrome/tokens';
import { PhoneGlyph } from './glyphs';
import { AttentionPill } from './parts';
import { ReplyChips, WaitedFor, useWaitingPrompt, type PhoneReplyTarget } from './PhoneReplies';
import { phoneStyle } from './style';
import { PHONE_ROW_MIN_PX, PHONE_SAFE_AREA } from './ui';

export const PHONE_STRIP_HEIGHT_PX = 52;
/** More panes than this and the pager shows "3 / 12" instead of dots. */
const MAX_PANE_DOTS = 8;
/** How far a finger travels sideways on the strip before it is a swipe to the next pane. */
const SWIPE_MIN_PX = 48;

export interface PhonePaneHeaderProps {
    readonly title: string;
    /** "waiting · 4m" (from the wait's item key), "running", or null for an idle pane. */
    readonly status: { readonly text: string; readonly waitingKey: string | null } | null;
    readonly subtitle: string | null;
    readonly layout: boolean;
    readonly onToggleLayout: () => void;
    readonly menuOpen: boolean;
    readonly onMenu: () => void;
    readonly onHome: () => void;
}

export function PhonePaneHeader(props: PhonePaneHeaderProps): ReactElement {
    return (
        <div
            data-testid="phone-header"
            className="flex shrink-0 items-center gap-1 border-b pr-1"
            style={{ borderColor: tokens.divider, paddingTop: PHONE_SAFE_AREA.top, minHeight: `calc(${PHONE_SAFE_AREA.top} + 52px)` }}
        >
            {/* Home, one tap from any pane: the bar's host picker gets there too, in two. */}
            <button
                type="button"
                data-testid="phone-open-landing"
                aria-label="Home"
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center"
                style={{ color: tokens.textSecondary }}
                onClick={props.onHome}
            >
                <PhoneGlyph name="chevron-left" size={22} weight={2} />
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-[1px]">
                <span className="flex min-w-0 items-center gap-2 text-[16px] font-semibold" style={{ color: tokens.textPrimary }}>
                    <span className="truncate" data-testid="phone-pane-title">
                        {props.title}
                    </span>
                    {props.status === null ? null : (
                        <span
                            data-testid="phone-pane-status"
                            data-waiting={props.status.waitingKey !== null ? 'true' : 'false'}
                            className="flex h-[20px] shrink-0 items-center rounded-full px-[7px] text-[11px] font-semibold"
                            style={{
                                background: props.status.waitingKey !== null ? phoneStyle.waitingCard : `color-mix(in srgb, ${tokens.statusRunning} 12%, ${tokens.windowBackground})`,
                                color: props.status.waitingKey !== null ? phoneStyle.waitingText : tokens.statusRunning
                            }}
                        >
                            {props.status.text}
                            {props.status.waitingKey === null ? null : (
                                <>
                                    {' · '}
                                    <WaitedFor itemKey={props.status.waitingKey} />
                                </>
                            )}
                        </span>
                    )}
                </span>
                {props.subtitle === null ? null : (
                    <span className="truncate text-[12px]" style={{ color: tokens.textSecondary }} data-testid="phone-pane-subtitle">
                        {props.subtitle}
                    </span>
                )}
            </div>
            <button
                type="button"
                data-testid="phone-view-toggle"
                aria-label={props.layout ? 'Show one pane' : 'Show full layout'}
                aria-pressed={props.layout}
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-[12px]"
                style={{ color: props.layout ? tokens.accent : tokens.textSecondary, background: props.layout ? phoneStyle.selected : 'transparent' }}
                onClick={props.onToggleLayout}
            >
                <PhoneGlyph name="layout" size={19} />
            </button>
            <button
                type="button"
                data-testid="phone-more"
                aria-label="Pane actions"
                aria-expanded={props.menuOpen}
                className="flex shrink-0 items-center justify-center"
                style={{ color: tokens.textPrimary, width: PHONE_ROW_MIN_PX, height: PHONE_ROW_MIN_PX }}
                onClick={props.onMenu}
            >
                <PhoneGlyph name="ellipsis" size={22} />
            </button>
        </div>
    );
}

export interface PhonePaneStripProps {
    readonly paneCount: number;
    /** Where the shown pane is in layout order; -1 when none is shown. */
    readonly paneIndex: number;
    readonly onStep: (delta: 1 | -1) => void;
    readonly waiting: number;
    readonly waitingHosts: number;
    readonly onAttention: () => void;
    /** The pane on screen, when it is waiting: its answers take the pager's place. */
    readonly replyTarget: PhoneReplyTarget | null;
}

export function PhonePaneStrip(props: PhonePaneStripProps): ReactElement {
    const entry = useWaitingPrompt(props.replyTarget);
    const replies = props.replyTarget !== null && (entry?.prompt?.choices.length ?? 0) > 0;
    const pager = props.paneCount > 1 && !replies;
    /*
     * A sideways swipe ON THE STRIP steps through the panes, the way the dots suggest. Not on the
     * pane itself: a terminal's touch is its own scrollback and selection, and the screen's edges
     * are the system's back gesture.
     */
    const swipe = useRef<{ readonly x: number; readonly y: number } | null>(null);
    const onTouchStart = (event: TouchEvent<HTMLDivElement>): void => {
        const touch = event.touches[0];
        swipe.current = touch === undefined || !pager ? null : { x: touch.clientX, y: touch.clientY };
    };
    const onTouchEnd = (event: TouchEvent<HTMLDivElement>): void => {
        const start = swipe.current;
        swipe.current = null;
        const touch = event.changedTouches[0];
        if (start === null || touch === undefined) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        props.onStep(dx < 0 ? 1 : -1);
    };
    return (
        <div
            data-testid="phone-pane-strip"
            className="flex shrink-0 items-center gap-2 pr-3 pl-1"
            style={{ height: PHONE_STRIP_HEIGHT_PX }}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
        >
            {replies && props.replyTarget !== null ? (
                <div className="min-w-0 flex-1 pl-2">
                    <ReplyChips target={props.replyTarget} entry={entry} />
                </div>
            ) : null}
            {pager ? (
                <>
                    <button
                        type="button"
                        data-testid="phone-pane-prev"
                        aria-label="Previous pane"
                        className="flex h-[44px] w-[44px] items-center justify-center"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => props.onStep(-1)}
                    >
                        <PhoneGlyph name="chevron-left" size={20} weight={2} />
                    </button>
                    <span role="img" aria-label={`Pane ${String(props.paneIndex + 1)} of ${String(props.paneCount)}`} data-testid="phone-pane-dots" className="flex items-center gap-[5px]">
                        {props.paneCount > MAX_PANE_DOTS ? (
                            // Past a row of dots, a count says it better than dots that cannot.
                            <span className="text-[12px] tabular-nums" style={{ color: tokens.textSecondary }}>
                                {`${String(props.paneIndex + 1)} / ${String(props.paneCount)}`}
                            </span>
                        ) : (
                            Array.from({ length: props.paneCount }, (_, at) => (
                                <span
                                    key={at}
                                    className="h-[5px] rounded-[3px]"
                                    style={{ width: at === props.paneIndex ? 16 : 5, background: at === props.paneIndex ? tokens.textPrimary : tokens.textTertiary }}
                                />
                            ))
                        )}
                    </span>
                    <button
                        type="button"
                        data-testid="phone-pane-next"
                        aria-label="Next pane"
                        className="flex h-[44px] w-[44px] items-center justify-center"
                        style={{ color: tokens.textSecondary }}
                        onClick={() => props.onStep(1)}
                    >
                        <PhoneGlyph name="chevron-right" size={20} weight={2} />
                    </button>
                </>
            ) : null}
            {replies ? null : <span className="flex-1" />}
            <AttentionPill waiting={props.waiting} hosts={props.waitingHosts} onOpen={props.onAttention} />
        </div>
    );
}
