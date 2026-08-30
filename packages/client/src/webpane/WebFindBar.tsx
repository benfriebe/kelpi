/**
 * ⌘F for a web pane (web-pane.md §10; WEB-059…WEB-065).
 *
 * The bar is styled as the app's one find bar — `grid/PaneSearchOverlay.tsx`, which the terminal
 * and (since §H29) the content panes both mount, and which is `PaneSearchOverlay.swift` — but it
 * cannot BE that component, because that one floats over its pane and nothing in this document
 * can float over a web page (§M38 has the whole argument). Needle, the count inside the field,
 * the chevron pair, ✕, Escape closes.
 *
 * Where a content pane's bar talks to an iframe it owns, this one drives a page it cannot touch:
 * every keystroke is a `web-find` verb, the daemon forwards it to the host's `find` RPC, and the
 * marks are made by the injected script (`#F2D027`, current match `#FF7A00`). So the counter
 * here is whatever the *page* reported.
 *
 * Two rules that only exist because the page is remote:
 *
 *   - **stale counts are dropped** (WEB-063). Every reply names the tab it was measured on; a
 *     reply for a tab that is no longer active is discarded, which is what stops an outgoing
 *     tab's `clear()` (total 0) from overwriting the incoming tab's real count during a switch.
 *   - **a tab switch re-runs the needle** (WEB-064). The active tab changing while the bar is
 *     open re-searches on the new tab rather than leaving a count that describes the old one.
 *
 * Closing clears the marks *and* the daemon's remembered needle, which is what stops later
 * navigations from re-marking the page (WEB-065).
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';

import { Icon } from '../grid/icons';
import { matchCountLabel } from '../grid/PaneSearchOverlay';
import { tokens } from '../grid/tokens';
import type { WebPaneCommands } from './commands';
import { WEB_CHROME_TEXT_ATTRIBUTE } from './priority';

export interface WebFindBarProps {
    readonly paneID: string;
    /** The tab the search runs against; a change re-runs the needle (WEB-064). */
    readonly activeTabID: string | null;
    readonly commands: WebPaneCommands;
    readonly onClose: () => void;
}

/**
 * Nothing measured yet. `total: null` is the Swift's `total: Int?` before a pass has run, and it
 * is what keeps the counter OFF the bar until the page has answered (M38).
 */
const EMPTY: { total: number | null; current: number } = { total: null, current: -1 };

function countsOf(reply: unknown, tabID: string): { total: number; current: number } | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true) return null;
    // WEB-063: the reply names its tab, so a count for a tab we have left is not ours.
    if (typeof record['tab_id'] === 'string' && record['tab_id'] !== tabID) return null;
    return {
        total: typeof record['total'] === 'number' ? record['total'] : 0,
        current: typeof record['current'] === 'number' ? record['current'] : -1
    };
}

export function WebFindBar(props: WebFindBarProps): ReactElement {
    const { paneID, activeTabID, commands, onClose } = props;
    const [needle, setNeedle] = useState('');
    const [matches, setMatches] = useState<{ total: number | null; current: number }>(EMPTY);
    const inputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        // The bar mounts on ⌘F and claims the caret in the same commit.
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const drive = useCallback(
        (op: 'search' | 'next' | 'prev', value?: string): void => {
            if (activeTabID === null) return;
            const tabID = activeTabID;
            void commands.find(paneID, tabID, op, value).then((reply) => {
                const counts = countsOf(reply, tabID);
                if (counts !== null) setMatches(counts);
            });
        },
        [activeTabID, commands, paneID]
    );

    /** True once something has actually been marked, so mounting empty clears nothing. */
    const marked = useRef(false);

    // No debounce, for the reason §3.13 gives: a lagging highlight reads as a broken one. A
    // change of `activeTabID` re-runs the same needle on the new tab (WEB-064).
    useEffect(() => {
        if (activeTabID === null) return;
        if (needle === '') {
            setMatches(EMPTY);
            // Only if there is something to unmark: a `clear` on mount would be a wasted round
            // trip, and (worse) would be the first reply a caller sees.
            if (!marked.current) return;
            marked.current = false;
            void commands.find(paneID, activeTabID, 'clear', '');
            return;
        }
        marked.current = true;
        drive('search', needle);
    }, [needle, activeTabID, drive, commands, paneID]);

    const close = useCallback((): void => {
        if (activeTabID !== null) void commands.find(paneID, activeTabID, 'clear', '');
        onClose();
    }, [activeTabID, commands, paneID, onClose]);

    const count = matchCountLabel(needle, matches.total, matches.current < 0 ? null : matches.current);
    const empty = needle.length === 0;

    return (
        <div
            data-testid={`web-find-${paneID}`}
            role="search"
            aria-label="Find in page"
            className="flex shrink-0 items-center gap-1 px-1.5 py-1"
            style={{
                background: tokens.headerBackground,
                borderBottom: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary
            }}
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                close();
            }}
        >
            {/*
             * M38 — the bar's TYPE, FILL and DISABLED rules are `grid/PaneSearchOverlay.tsx`'s,
             * which are `PaneSearchOverlay.swift:18-86`'s: a 160 px 12 px-monospace "Search"
             * field, the count tucked INSIDE its trailing edge and absent until the page has
             * answered, 22×22 chevrons dimmed to 0.3 and inert while the needle is empty, and
             * the ✕ immediately after them rather than shoved to the far edge.
             *
             * What is NOT copied is the placement: the Swift floats this as a radius-8 shadowed
             * card over the pane's top-right corner, and nothing in this document can float over
             * a web pane — the page is a native `WebContentsView` composited on top of it (the
             * same constraint that makes the pickup and storage panels rows). So the bar stays an
             * inline row that shrinks the page hole, and the styling is what comes across.
             */}
            <div className="relative flex items-center">
                <input
                    ref={inputRef}
                    aria-label="Search"
                    placeholder="Search"
                    data-testid={`web-find-input-${paneID}`}
                    // The priority layer defers ⌘←/⌘→ and tab cycling while this has the caret.
                    {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                    // No `leading-none`, for the reason the terminal bar states: the class was
                    // inert under the unlayered `input { font: inherit }`, and S1/S17's layering
                    // would have let it collapse this field's line box (24.8 → 23.5 px) with
                    // nothing in the Swift asking for it.
                    className="w-[160px] px-2 outline-none"
                    style={{
                        /*
                         * S36 — the three values L22 already settled on the terminal/content bar
                         * (`grid/PaneSearchOverlay.tsx`), which this bar had a pre-L22 copy of,
                         * so the app carried two find-field recipes.
                         *
                         * `PaneSearchOverlay.swift:27` is `Color.primary.opacity(0.08)` — the
                         * LABEL colour at 8 %, so the well is lighter than the bar on dark and
                         * darker on light. `surfaceBackground` (#101013) is darker than the
                         * #13131A header bar in BOTH, which inverted the contrast: the field read
                         * as a hole punched in the bar rather than a well set into it.
                         */
                        background: `color-mix(in srgb, ${tokens.textPrimary} 8%, transparent)`,
                        // `.cornerRadius(5)` (`:28`), not Tailwind's 4 px `rounded`.
                        borderRadius: 5,
                        // `.padding(.vertical, 5)` (`:26`), not `py-1`'s 4 px.
                        paddingTop: 5,
                        paddingBottom: 5,
                        color: tokens.textPrimary,
                        // Face and size INLINE, for the reason the terminal bar states: inline is
                        // the authority for the value, and it stays so now that S1/S17 has moved
                        // `input { font: inherit }` into `@layer base` and the classes also land.
                        fontFamily: 'var(--kelpi-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                        fontSize: 12,
                        paddingRight: count === null ? undefined : `${String(count.length * 7 + 12)}px`
                    }}
                    value={needle}
                    onChange={(event) => setNeedle(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        drive(event.shiftKey ? 'prev' : 'next');
                    }}
                />
                {count === null ? null : (
                    <span
                        data-testid={`web-find-count-${paneID}`}
                        className="pointer-events-none absolute right-1.5 font-mono text-[10px] tabular-nums"
                        style={{ color: tokens.textSecondary }}
                    >
                        {count}
                    </span>
                )}
            </div>
            {/*
              * Up is KELPIT, down is PREVIOUS, matching `PaneSearchOverlay.swift:48-66` (the
              * shipped app draws ONE find bar for terminal, markdown and web panes, and that is
              * how its chevrons are wired). The port's terminal bar follows the same order, so
              * the two find surfaces step the same way under the same glyph.
              */}
            <FindStepButton
                testID={`web-find-next-${paneID}`}
                label="Next match"
                icon="chevron-up"
                disabled={empty}
                onClick={() => drive('next')}
            />
            <FindStepButton
                testID={`web-find-prev-${paneID}`}
                label="Previous match"
                icon="chevron-down"
                disabled={empty}
                onClick={() => drive('prev')}
            />
            <button
                type="button"
                aria-label="Close find"
                title="Close find"
                data-testid={`web-find-close-${paneID}`}
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100"
                style={{ color: tokens.textPrimary }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={close}
            >
                <Icon name="close" size={10} />
            </button>
        </div>
    );
}

/**
 * The Swift's chevron pair: `.opacity(needle.isEmpty ? 0.3 : 0.7)` **and** `.disabled(…)`, so an
 * empty needle leaves them visibly inert instead of live-looking controls that step nothing. The
 * mouse-down guard keeps the caret in the field, exactly as the terminal bar's does.
 */
function FindStepButton(props: {
    readonly testID: string;
    readonly label: string;
    readonly icon: 'chevron-up' | 'chevron-down';
    readonly disabled: boolean;
    readonly onClick: () => void;
}): ReactElement {
    return (
        <button
            type="button"
            data-testid={props.testID}
            aria-label={props.label}
            title={props.label}
            disabled={props.disabled}
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded ${
                props.disabled ? 'opacity-30' : 'opacity-70 hover:opacity-100'
            }`}
            style={{ color: tokens.textPrimary, cursor: props.disabled ? 'default' : 'pointer' }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onClick}
        >
            <Icon name={props.icon} size={11} />
        </button>
    );
}
