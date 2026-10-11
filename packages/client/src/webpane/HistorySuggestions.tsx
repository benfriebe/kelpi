/**
 * The URL bar's suggestion list (#375): pages from history and favourites that match what is
 * being typed, under the field.
 *
 * It drops onto its own pane's page, and that page is a native `WebContentsView` composited above
 * this document, so the list registers its box with `chrome/modal-presence` the way the bookmarks
 * menu does: the pane parks behind a still frame of its page (the poster, `./poster.ts`) while the
 * list is up, and a web pane beside it keeps its live page.
 *
 * **Registered for the whole typed edit, not just while it has rows.** A list that came and went
 * as the matches ran out would re-park the page on every reappearance, and each park holds the
 * view on screen for a capture first (up to `POSTER_DEADLINE_MS`), which reads as flicker. So
 * while the user is typing an address the list is mounted even when empty, as an invisible box
 * one row tall under the field: it has a real rect, so it parks this pane and nothing else, and
 * the page is photographed once per edit.
 *
 * Rows never take focus: they act on `mousedown` with the default prevented, so the URL bar keeps
 * the caret (and its blur, which ends the edit, never fires mid-click).
 */

import { useRef, useState, type ReactElement } from 'react';

import { useOverlayPresence } from '../chrome/modal-presence';
import { pill, tokens } from '../grid/tokens';
import type { WebHistorySuggestion } from './history';
import { truncateMiddle } from './state';

/** The empty list's footprint: one row, so its rect is real and covers this pane only. */
const EMPTY_LIST_HEIGHT = 28;

export interface HistorySuggestionsProps {
    readonly paneID: string;
    /** The user is typing an address: the list is mounted (and the page parked) for all of it. */
    readonly active: boolean;
    readonly rows: readonly WebHistorySuggestion[];
    /** The highlighted row, or -1 for none (Enter then opens what is in the field). */
    readonly highlight: number;
    readonly onPick: (row: WebHistorySuggestion) => void;
    readonly onRemove: (row: WebHistorySuggestion) => void;
}

export function HistorySuggestions(props: HistorySuggestionsProps): ReactElement | null {
    const listRef = useRef<HTMLDivElement | null>(null);
    useOverlayPresence(listRef, props.active);
    if (!props.active) return null;

    const empty = props.rows.length === 0;
    return (
        <div
            ref={listRef}
            id={`web-history-list-${props.paneID}`}
            data-testid={`web-history-list-${props.paneID}`}
            data-empty={empty ? 'true' : 'false'}
            role="listbox"
            aria-label="Suggestions"
            aria-hidden={empty ? true : undefined}
            className="absolute left-0 right-0 top-[calc(100%+4px)] z-20 flex min-w-[220px] flex-col gap-0.5 rounded-md p-1 text-[11px]"
            style={{
                background: tokens.surfaceBackground,
                border: `1px solid ${tokens.divider}`,
                boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
                color: tokens.textPrimary,
                ...(empty ? { visibility: 'hidden', height: EMPTY_LIST_HEIGHT, pointerEvents: 'none' } : {})
            }}
        >
            {props.rows.map((row, index) => (
                <SuggestionRow
                    key={`${row.favourite ? 'f' : 'h'}:${row.url}`}
                    paneID={props.paneID}
                    index={index}
                    row={row}
                    highlighted={index === props.highlight}
                    onPick={props.onPick}
                    onRemove={props.onRemove}
                />
            ))}
        </div>
    );
}

function SuggestionRow(props: {
    readonly paneID: string;
    readonly index: number;
    readonly row: WebHistorySuggestion;
    readonly highlighted: boolean;
    readonly onPick: (row: WebHistorySuggestion) => void;
    readonly onRemove: (row: WebHistorySuggestion) => void;
}): ReactElement {
    const { row } = props;
    const [hovered, setHovered] = useState(false);
    const label = row.title.trim() === '' ? row.url : row.title;
    return (
        <div
            id={`web-history-row-${props.paneID}-${String(props.index)}`}
            data-testid={`web-history-row-${props.paneID}-${String(props.index)}`}
            data-favourite={row.favourite ? 'true' : 'false'}
            role="option"
            aria-selected={props.highlighted}
            title={row.url}
            className="relative flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1"
            /*
             * The tab strip's pill fills (§16.4): the accent for the highlight Return opens, the
             * faint one for the pointer. Hover does NOT move the highlight: a list that opens under
             * a resting pointer would otherwise change what Return does without a keystroke.
             */
            style={{
                background: props.highlighted
                    ? pill(tokens.accent, 18)
                    : hovered
                      ? pill(tokens.textSecondary, 8)
                      : 'transparent'
            }}
            onMouseDown={(event) => {
                // Keep the caret in the URL bar: a focused row would blur it and end the edit.
                event.preventDefault();
                if (event.button !== 0) return;
                props.onPick(row);
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
        >
            <span
                aria-hidden="true"
                className="w-[12px] shrink-0 text-center"
                style={{ color: row.favourite ? '#F2C230' : tokens.textTertiary }}
            >
                {row.favourite ? '★' : '↻'}
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{label}</span>
                {label === row.url ? null : (
                    <span className="truncate font-mono text-[10px]" style={{ color: tokens.textSecondary }}>
                        {truncateMiddle(row.url, 80)}
                    </span>
                )}
            </div>
            {/* History only: a favourite is removed from its star or Settings, not from here. */}
            {row.favourite || !(hovered || props.highlighted) ? null : (
                <button
                    type="button"
                    data-testid={`web-history-remove-${props.paneID}-${String(props.index)}`}
                    aria-label={`Remove ${row.url} from history`}
                    title="Remove from history (⇧⌫)"
                    tabIndex={-1}
                    className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded text-[10px]"
                    style={{ color: tokens.textSecondary }}
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.button !== 0) return;
                        props.onRemove(row);
                    }}
                >
                    ✕
                </button>
            )}
        </div>
    );
}
