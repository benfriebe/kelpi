/**
 * ⌘F for a web pane (web-pane.md §10; WEB-059…WEB-065).
 *
 * The bar looks and behaves like a markdown pane's (`content/ContentFrame.tsx` §3.13) — needle,
 * `n/N`, ↑ ↓, ✕, Escape closes — but where that one talks to an iframe it owns, this one drives
 * a page it cannot touch: every keystroke is a `web-find` verb, the daemon forwards it to the
 * host's `find` RPC, and the marks are made by the injected script (`#F2D027`, current match
 * `#FF7A00`). So the counter here is whatever the *page* reported.
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

/** §3.13's readout, shared with the content panes: 0 matches reads `0/0`, never `3/0`. */
export function findCountLabel(total: number, current: number): string {
    if (total <= 0) return '0/0';
    return `${String(current < 0 ? 0 : current + 1)}/${String(total)}`;
}

const EMPTY = { total: 0, current: -1 } as const;

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
    const [matches, setMatches] = useState<{ total: number; current: number }>(EMPTY);
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

    return (
        <div
            data-testid={`web-find-${paneID}`}
            className="flex shrink-0 items-center gap-1 px-1.5 py-1 text-[11px]"
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
            <input
                ref={inputRef}
                aria-label="Find in page"
                placeholder="Find in page"
                data-testid={`web-find-input-${paneID}`}
                // The priority layer defers ⌘←/⌘→ and tab cycling while this has the caret.
                {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                className="w-48 rounded px-2 py-[3px] outline-none"
                style={{
                    background: tokens.surfaceBackground,
                    border: `1px solid ${tokens.divider}`,
                    color: tokens.textPrimary
                }}
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    drive(event.shiftKey ? 'prev' : 'next');
                }}
            />
            <span data-testid={`web-find-count-${paneID}`} className="tabular-nums opacity-60">
                {findCountLabel(matches.total, matches.current)}
            </span>
            <button
                type="button"
                aria-label="Previous match"
                data-testid={`web-find-prev-${paneID}`}
                style={{ color: tokens.textSecondary }}
                onClick={() => drive('prev')}
            >
                ↑
            </button>
            <button
                type="button"
                aria-label="Next match"
                data-testid={`web-find-next-${paneID}`}
                style={{ color: tokens.textSecondary }}
                onClick={() => drive('next')}
            >
                ↓
            </button>
            <button
                type="button"
                aria-label="Close find"
                data-testid={`web-find-close-${paneID}`}
                className="ml-auto"
                style={{ color: tokens.textTertiary }}
                onClick={close}
            >
                ✕
            </button>
        </div>
    );
}
