/**
 * The batch "element pickup" panel (web-pane.md §12; WEB-129…WEB-136).
 *
 * The Swift original was a SwiftUI overlay on the pane; this is the same panel in DOM, over the
 * page hole. What it draws is entirely daemon state (`webpane/batch.ts`) — the client keeps no
 * copy — so a second window looking at this pane shows the same numbered rows in the same order,
 * with the same one focused.
 *
 * The behaviours that are contracts rather than styling:
 *
 *   - each row carries a **numbered accent chip matching the page badge** (they are both
 *     `index + 1`), the element's tag + middle-truncated selector, an editable comment and a
 *     remove button; the focused row gets accent fill and border (WEB-129);
 *   - **focus is bidirectional** (WEB-130): clicking a row (or its comment field) focuses the
 *     item with *panel* origin, which scrolls the page to the element and pulses its badge;
 *     clicking a page badge focuses with *page* origin, which does NOT scroll — and the panel
 *     answers by scrolling that row into view and moving the caret into its comment field;
 *   - each row is **two lines** — tag + selector over a full-width comment field — and the list
 *     is **3 rows tall then scrolls**, with an empty batch showing the hint (WEB-129/WEB-131);
 *   - the destination picker is seeded from the session's remembered target, Send is disabled
 *     until a destination has been **deliberately picked** and the batch is non-empty, and a
 *     target that disappeared resets the picker (WEB-132/WEB-133);
 *   - hovering the panel forces the arrow cursor back, because the page sets `cursor:crosshair`
 *     on its own document while the picker is armed (WEB-145 — the same defect, one layer up).
 *
 * **It is a row, not an overlay.** The Swift panel floated over the pane because a `WKWebView` is
 * an ordinary view in the same hierarchy. Here the page is a native `WebContentsView` composited
 * ON TOP of this document — nothing in the DOM can be drawn above it (App.tsx says the same of
 * the settings sheet, which is why a modal parks the view). So the panel sits *below* the page
 * area as a sibling, and the page hole shrinks by exactly its height: the run that found this
 * had two numbered badges visible in the page and no panel anywhere on screen.
 */

import { useCallback, useEffect, useRef, type ReactElement } from 'react';

import { withAlpha } from '../chrome';
import { tokens } from '../grid/tokens';
import type { WebPaneCommands } from './commands';
import { WEB_CHROME_TEXT_ATTRIBUTE } from './priority';
import {
    BATCH_LOCAL_DESTINATION,
    isPaneDestination,
    seededDestination,
    truncateMiddle,
    type BatchDestination,
    type WebBatchSession
} from './state';

export interface BatchPanelProps {
    readonly paneID: string;
    readonly session: WebBatchSession;
    readonly activeTabID: string | null;
    /** Other shell panes in this workspace (WEB-133). */
    readonly destinations: readonly BatchDestination[];
    readonly commands: WebPaneCommands;
    /** The chosen destination, lifted so the seeding rule stays in one place. */
    readonly destination: string | null;
    readonly onDestinationChange: (paneID: string | null) => void;
}

/** WEB-131: the empty-state hint, verbatim. */
export const BATCH_EMPTY_HINT = 'Click elements in the page to add them. Esc cancels.';

/**
 * Three rows plus the list's own padding: the list grows to this and then scrolls.
 *
 * `WebBatchInspectPanel.swift:44-47` sizes it as `visibleRowCap * rowHeight + listVerticalPadding`
 * = 3 × 64 + 12. A row is 64 pt there because it is **two lines** (chip + selector over a
 * full-width comment field), which is the shape this panel draws too — a 148 px cap was three
 * rows of the one-line row that squeezed the comment into 128 px.
 */
const LIST_MAX_HEIGHT = 3 * 64 + 12;

export function BatchPanel(props: BatchPanelProps): ReactElement {
    const { paneID, session, commands, destinations, destination } = props;
    const rowRefs = useRef(new Map<string, HTMLDivElement>());
    const commentRefs = useRef(new Map<string, HTMLInputElement>());
    /** The focus we have already reacted to, so re-renders do not re-steal the caret. */
    const appliedFocus = useRef<string | null>(null);

    const onDestinationChange = props.onDestinationChange;
    // WEB-132: a remembered target that no longer exists must not stay selected.
    useEffect(() => {
        const seeded = seededDestination(session, destinations);
        if (destination === null && seeded !== null) {
            onDestinationChange(seeded);
            return;
        }
        // The local queue is not a pane, so it can never go stale — only a pane pick is checked.
        if (isPaneDestination(destination) && !destinations.some((entry) => entry.paneID === destination)) {
            onDestinationChange(null);
        }
    }, [session, destinations, destination, onDestinationChange]);

    /**
     * WEB-130's page → panel half: a badge click focuses the item daemon-side, and the panel
     * reacts by scrolling the row in and putting the caret in its comment field. Guarded on the
     * *change* of `focused_id`, or every unrelated re-render would yank the caret back.
     */
    useEffect(() => {
        const focused = session.focused_id;
        if (focused === appliedFocus.current) return;
        appliedFocus.current = focused;
        if (focused === null) return;
        const row = rowRefs.current.get(focused);
        // `scrollIntoView` is not implemented in jsdom, and a browser that lacks it is not worth
        // crashing the panel over — the caret move below is the part that matters.
        if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
        commentRefs.current.get(focused)?.focus();
    }, [session.focused_id]);

    const focusItem = useCallback(
        (itemID: string): void => {
            if (session.focused_id === itemID) return;
            // Panel origin: the page scrolls the element to centre and pulses its badge.
            appliedFocus.current = itemID;
            void commands.batchFocus(paneID, itemID, 'panel');
        },
        [commands, paneID, session.focused_id]
    );

    /**
     * WEB-132 verbatim: `.disabled(items.isEmpty || selection == .unselected)`. A batch with no
     * destination is not sendable — it used to dispatch into the CLI-only queue on a click the
     * Swift refuses outright.
     */
    const canSend = session.items.length > 0 && destination !== null;

    return (
        <div
            data-testid={`web-batch-panel-${paneID}`}
            className="flex shrink-0 flex-col gap-1.5 p-2"
            // WEB-145: the page document is `cursor:crosshair` while armed; the panel is chrome.
            style={{
                cursor: 'default',
                background: tokens.surfaceBackground,
                borderTop: `1px solid ${tokens.divider}`,
                color: tokens.textPrimary
            }}
        >
            <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium">Element pickup</span>
                <span style={{ color: tokens.textTertiary }}>
                    {session.items.length === 1 ? '1 item' : `${String(session.items.length)} items`}
                </span>
                <button
                    type="button"
                    data-testid={`web-batch-cancel-${paneID}`}
                    className="ml-auto rounded border px-1.5 py-[1px] text-[10px]"
                    style={{ borderColor: tokens.divider, color: tokens.textSecondary }}
                    onClick={() => void commands.batchCancel(paneID)}
                >
                    Cancel
                </button>
            </div>

            {session.items.length === 0 ? (
                <p
                    data-testid={`web-batch-empty-${paneID}`}
                    className="px-1 py-2 text-[11px]"
                    style={{ color: tokens.textTertiary }}
                >
                    {BATCH_EMPTY_HINT}
                </p>
            ) : (
                <div
                    data-testid={`web-batch-items-${paneID}`}
                    className="flex flex-col gap-1 overflow-y-auto"
                    style={{ maxHeight: LIST_MAX_HEIGHT }}
                >
                    {session.items.map((item, index) => {
                        const focused = item.id === session.focused_id;
                        return (
                            <div
                                key={item.id}
                                ref={(node) => {
                                    if (node === null) rowRefs.current.delete(item.id);
                                    else rowRefs.current.set(item.id, node);
                                }}
                                data-testid={`web-batch-item-${item.id}`}
                                data-focused={focused ? 'true' : 'false'}
                                // Two lines, top-aligned, exactly as the Swift row is
                                // (`HStack(alignment: .top) { chip; VStack { selector; comment }; ✕ }`).
                                className="flex items-start gap-1.5 rounded px-1.5 py-1"
                                style={{
                                    background: focused ? withAlpha(tokens.accent, 0.16) : 'transparent',
                                    border: `1px solid ${focused ? tokens.accent : tokens.divider}`
                                }}
                                onClick={() => focusItem(item.id)}
                            >
                                <span
                                    data-testid={`web-batch-chip-${item.id}`}
                                    className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-full px-1 text-[9px] font-semibold"
                                    style={{ background: tokens.accent, color: '#fff' }}
                                >
                                    {index + 1}
                                </span>
                                {/*
                                 * H28 — the comment gets its OWN full-width line, under the
                                 * tag+selector line, because annotating is the panel's whole
                                 * purpose. It used to be a `w-32` input squeezed between the
                                 * selector and the ✕: a third of the width for the one field
                                 * the user is here to type into.
                                 */}
                                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                                    <div
                                        data-testid={`web-batch-head-${item.id}`}
                                        className="flex min-w-0 items-center gap-1"
                                    >
                                        <span
                                            className="shrink-0 font-mono text-[10px]"
                                            style={{ color: tokens.textSecondary }}
                                        >
                                            {item.tag}
                                        </span>
                                        <span
                                            data-testid={`web-batch-selector-${item.id}`}
                                            title={item.selector}
                                            className="min-w-0 flex-1 truncate font-mono text-[10px]"
                                            style={{ color: tokens.textTertiary }}
                                        >
                                            {truncateMiddle(item.selector, 42)}
                                        </span>
                                    </div>
                                    <input
                                        ref={(node) => {
                                            if (node === null) commentRefs.current.delete(item.id);
                                            else commentRefs.current.set(item.id, node);
                                        }}
                                        aria-label={`Comment for element ${String(index + 1)}`}
                                        // The Swift placeholder, verbatim
                                        // (`TextField("Comment (optional)")`).
                                        placeholder="Comment (optional)"
                                        data-testid={`web-batch-comment-${item.id}`}
                                        {...{ [WEB_CHROME_TEXT_ATTRIBUTE]: 'true' }}
                                        className="w-full min-w-0 rounded px-1.5 py-[2px] text-[11px] outline-none"
                                        style={{
                                            background: tokens.windowBackground,
                                            border: `1px solid ${tokens.divider}`,
                                            color: tokens.textPrimary
                                        }}
                                        value={item.comment}
                                        onFocus={() => focusItem(item.id)}
                                        onChange={(event) => {
                                            // Streams on every keystroke; the daemon pushes it
                                            // into the page popover, which refuses to overwrite
                                            // a focused textarea (WEB-141).
                                            void commands.batchComment(
                                                paneID,
                                                item.id,
                                                event.target.value,
                                                props.activeTabID
                                            );
                                        }}
                                    />
                                </div>
                                <button
                                    type="button"
                                    aria-label={`Remove element ${String(index + 1)}`}
                                    data-testid={`web-batch-remove-${item.id}`}
                                    className="shrink-0 px-1 text-[11px]"
                                    style={{ color: tokens.textTertiary }}
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        void commands.batchRemove(paneID, item.id);
                                    }}
                                >
                                    ✕
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="flex items-center gap-1.5">
                <select
                    aria-label="Send to pane"
                    data-testid={`web-batch-destination-${paneID}`}
                    className="min-w-0 flex-1 rounded px-1.5 py-[3px] text-[11px] outline-none"
                    style={{
                        background: tokens.windowBackground,
                        // Unselected demands a pick, the way the Swift picker's accent
                        // `strokeBorder` does (`WebBatchInspectPanel.swift:290-298`).
                        border: `1px solid ${destination === null ? withAlpha(tokens.accent, 0.6) : tokens.divider}`,
                        color: destination === null ? tokens.textSecondary : tokens.textPrimary
                    }}
                    value={destination ?? ''}
                    onChange={(event) => {
                        props.onDestinationChange(event.target.value === '' ? null : event.target.value);
                    }}
                >
                    {/*
                     * H16 — the empty value is "not picked yet", and it says so
                     * (`currentTargetLabel` → "Select destination…"). It used to read "Queue
                     * locally", which made the *default* a CLI-only queue the user had to know
                     * about to drain — a silent dispatch on a click the Swift refuses.
                     */}
                    <option value="">Select destination…</option>
                    {destinations.length === 0 ? (
                        <option value="" disabled>
                            No other panes open in this workspace
                        </option>
                    ) : (
                        destinations.map((entry) => (
                            <option key={entry.paneID} value={entry.paneID}>
                                {entry.label}
                            </option>
                        ))
                    )}
                    {/*
                     * The local queue survives as an EXPLICIT choice below the panes (the Swift
                     * picker has no such row — its `onSend(nil)` is reserved for exactly this —
                     * but `nex web inspect-result` is a real port capability, so it keeps a
                     * gesture; it simply stops being what "unselected" means).
                     */}
                    <option value={BATCH_LOCAL_DESTINATION}>Queue locally (nex web inspect-result)</option>
                </select>
                <button
                    type="button"
                    data-testid={`web-batch-send-${paneID}`}
                    disabled={!canSend}
                    className="shrink-0 rounded border px-2 py-[3px] text-[11px] disabled:opacity-40"
                    style={{
                        borderColor: tokens.accent,
                        color: tokens.accent,
                        cursor: canSend ? 'pointer' : 'default'
                    }}
                    // The wire's `sendTo` is still `null` for the local queue — that branch is
                    // the daemon's `inspect-result` queue — but now only an explicit pick of
                    // the local row can produce it.
                    onClick={() =>
                        void commands.batchSend(paneID, isPaneDestination(destination) ? destination : null)
                    }
                >
                    Send
                </button>
            </div>
        </div>
    );
}
