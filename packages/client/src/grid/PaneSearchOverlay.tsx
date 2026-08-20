/**
 * The pane search overlay — the port of `Nex/Features/PaneGrid/PaneSearchOverlay.swift`.
 *
 * A floating bar at the pane's top-trailing corner: an auto-focused monospace field, a live
 * `selected+1/total` counter tucked inside its trailing edge, up/down chevrons that are dimmed
 * and inert while the needle is empty, and a ✕. Return jumps to the next match, ⇧Return to the
 * previous, Escape closes.
 *
 * Everything it renders is somebody else's state:
 *
 *  - the **counter** is the daemon's (`searchTotal` / `searchSelected` on the workspace, fed by
 *    `daemon/src/ws/search.ts`), so two windows looking at the same pane read the same "3/17";
 *  - the **needle** is echoed locally as you type so the field never lags a round trip, and the
 *    daemon's value is what survives a reconnect — `needle` re-seeds the draft whenever the bar
 *    moves to a different pane.
 *
 * The counter's rule is the Swift one verbatim (TERM-118): `selected+1/total` once something is
 * selected, `-/total` before that, and nothing at all while the field is empty. A total of 0
 * with a stale selection cannot render "3/0" because the daemon drops the selection when the
 * total goes to zero.
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';

import { Icon } from './icons';
import { tokens } from './tokens';

export interface PaneSearchOverlayProps {
    readonly paneID: string;
    /** The daemon's needle for this pane; re-seeds the field when the bar moves. */
    readonly needle: string;
    readonly total: number | null;
    /** 0-based index of the selected match, or null before anything is selected. */
    readonly selected: number | null;
    readonly onNeedleChange: (needle: string) => void;
    readonly onNext: () => void;
    readonly onPrevious: () => void;
    readonly onClose: () => void;
    /** Skip the mount autofocus (tests that assert focus elsewhere). */
    readonly autoFocus?: boolean | undefined;
}

/** `selected+1/total`, `-/total`, or nothing at all (Swift `matchCountLabel`). */
export function matchCountLabel(
    needle: string,
    total: number | null,
    selected: number | null
): string | null {
    if (needle.length === 0 || total === null) return null;
    if (selected === null) return `-/${String(total)}`;
    return `${String(selected + 1)}/${String(total)}`;
}

interface StepButtonProps {
    readonly testID: string;
    readonly label: string;
    readonly icon: 'chevron-up' | 'chevron-down';
    readonly disabled: boolean;
    readonly onClick: () => void;
}

function StepButton({ testID, label, icon, disabled, onClick }: StepButtonProps): ReactElement {
    return (
        <button
            type="button"
            data-testid={testID}
            aria-label={label}
            title={label}
            disabled={disabled}
            // Swift dims the pair to 0.3 while the field is empty and 0.7 otherwise; the same
            // two states, expressed as opacity so the control never leaves the row (a control
            // that vanishes reflows the bar under the cursor).
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded ${
                disabled ? 'opacity-30' : 'opacity-70 hover:opacity-100'
            }`}
            style={{ color: tokens.textPrimary, cursor: disabled ? 'default' : 'pointer' }}
            onMouseDown={(event) => {
                // Keep the caret in the field: a chevron click must not blur it, or the next
                // Return goes to the button instead of the search.
                event.preventDefault();
            }}
            onClick={onClick}
        >
            <Icon name={icon} size={11} />
        </button>
    );
}

export function PaneSearchOverlay(props: PaneSearchOverlayProps): ReactElement {
    const { paneID, needle, total, selected } = props;
    const inputRef = useRef<HTMLInputElement | null>(null);
    const [draft, setDraft] = useState(needle);

    // Re-seed when the bar MOVES (a different pane) rather than on every needle delta: the
    // daemon echoes back what was just typed, and re-seeding on that would fight the caret.
    const seededFor = useRef(paneID);
    useEffect(() => {
        if (seededFor.current === paneID) return;
        seededFor.current = paneID;
        setDraft(needle);
    }, [paneID, needle]);

    useEffect(() => {
        if (props.autoFocus === false) return;
        inputRef.current?.focus();
        inputRef.current?.select();
        // Mount-only: re-focusing on every needle change would fight a user who tabbed away.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const count = matchCountLabel(draft, total, selected);
    const empty = draft.length === 0;

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
        if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (event.shiftKey) props.onPrevious();
            else props.onNext();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            // The app's key dispatcher also binds Escape (`close_search`) but declines while a
            // text field has focus, so this handler is the one that runs — and stopping here
            // keeps one keystroke from closing the bar twice if that ever changes.
            event.stopPropagation();
            props.onClose();
            return;
        }
        // §7.14: a second ⌘F closes the bar. It has to be caught HERE rather than by the
        // binding map, because the dispatcher refuses every non-menu-bar action while a text
        // field has focus (`chrome/keys.ts`) — and the field is where focus is. That makes this
        // the one place in the client that hard-codes a chord instead of reading the map; a
        // rebound `toggle_search` still closes the bar from the pane, and Escape and the ✕
        // always work.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
        }
    };

    return (
        <div
            data-testid={`pane-search-${paneID}`}
            data-search-total={total === null ? '' : String(total)}
            data-search-selected={selected === null ? '' : String(selected)}
            role="search"
            aria-label="Search terminal output"
            className="pointer-events-auto absolute right-2 top-2 z-30 flex items-center gap-1 rounded-lg px-1.5 py-1"
            style={{
                background: tokens.headerBackground,
                border: `1px solid ${tokens.divider}`,
                boxShadow: '0 4px 12px rgba(0,0,0,0.35)'
            }}
            // A click in the bar is not a click in the terminal: without this the grid's
            // focus-on-press would pull the caret straight back out of the field.
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="relative flex items-center">
                <input
                    ref={inputRef}
                    data-testid={`pane-search-input-${paneID}`}
                    aria-label="Search"
                    placeholder="Search"
                    value={draft}
                    className="w-[160px] rounded px-2 py-1 font-mono text-[12px] leading-none outline-none"
                    style={{
                        background: tokens.surfaceBackground,
                        color: tokens.textPrimary,
                        // Room for the counter, which floats over the field's trailing edge.
                        paddingRight: count === null ? undefined : `${String(count.length * 7 + 12)}px`
                    }}
                    onChange={(event) => {
                        setDraft(event.target.value);
                        props.onNeedleChange(event.target.value);
                    }}
                    onKeyDown={onKeyDown}
                />
                {count === null ? null : (
                    <span
                        data-testid={`pane-search-count-${paneID}`}
                        className="pointer-events-none absolute right-1.5 font-mono text-[10px] tabular-nums"
                        style={{ color: tokens.textSecondary }}
                    >
                        {count}
                    </span>
                )}
            </div>
            <StepButton
                testID={`pane-search-prev-${paneID}`}
                label="Previous match (⇧Return)"
                icon="chevron-up"
                disabled={empty}
                onClick={props.onPrevious}
            />
            <StepButton
                testID={`pane-search-next-${paneID}`}
                label="Next match (Return)"
                icon="chevron-down"
                disabled={empty}
                onClick={props.onNext}
            />
            <button
                type="button"
                data-testid={`pane-search-close-${paneID}`}
                aria-label="Close search (Escape)"
                title="Close search (Escape)"
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded opacity-70 hover:opacity-100"
                style={{ color: tokens.textPrimary }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={props.onClose}
            >
                <Icon name="close" size={10} />
            </button>
        </div>
    );
}
