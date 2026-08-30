/**
 * The pane search overlay — the port of `Nex/Features/PaneGrid/PaneSearchOverlay.swift`.
 *
 * A floating bar at the pane's top-trailing corner: an auto-focused monospace field, a live
 * `selected+1/total` counter tucked inside its trailing edge, up/down chevrons that are dimmed
 * and inert while the needle is empty, and a ✕. Return jumps to the next match, ⇧Return to the
 * previous, Escape closes. **Up is next and down is previous**, because that is how the Swift
 * wires them (`:48-66`) and muscle memory is the whole point of a find bar.
 *
 * `PaneGridView.swift:356-370` draws this ONE bar over every pane type, with no type test, so
 * this component is the port's single find-bar recipe too: the grid mounts it over the pane the
 * daemon is searching, and `content/ContentFrame.tsx` mounts the same component over a markdown
 * or diff preview, pointed at the sandboxed frame's own find instead of the daemon's counter
 * (`testIDPrefix` / `label` are what keep the two addressable apart).
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
    /**
     * The landmark's accessible name. The default describes the terminal, which is where the
     * daemon-counted bar lives; a content pane passes its own ("Find in markdown preview").
     */
    readonly label?: string | undefined;
    /**
     * The `data-testid` stem, so the two surfaces that mount this bar stay addressable apart
     * (`pane-search-…` = the terminal's, driven by the daemon's counter; `content-find-…` = a
     * markdown/diff pane's, driven by the sandboxed frame's own find). Same bar, same recipe,
     * two backends — see `content/ContentFrame.tsx`.
     */
    readonly testIDPrefix?: string | undefined;
    /**
     * §S9 / §S63 — where the bar floats, for a surface whose mount point is not the pane
     * wrapper's own top-trailing corner.
     *
     * The grid mounts this over a terminal at the wrapper's corner, which is `right-2 top-2`
     * and needs no override. A content pane mounts it from INSIDE the pane body (the frame owns
     * the find, because only the sandboxed document can count its own matches), so it passes a
     * negative `top` to reach back over the 24 px header the way
     * `PaneGridView.swift:356,367-368`'s single pane-level `.overlay(alignment: .topTrailing)`
     * does, and the content overlays' 14 px inset so it lines up with the Copy menu that opens
     * in the same corner.
     */
    readonly top?: number | undefined;
    readonly right?: number | undefined;
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
            //
            // L24: TWO states, not three. `PaneSearchOverlay.swift:54-56,64-66` sets the opacity
            // from `localNeedle.isEmpty` alone — there is no `.onHover`, so the shipped chevrons
            // do not brighten under the cursor. The port's `hover:opacity-100` was invented
            // chrome, and it is gone.
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded ${
                disabled ? 'opacity-30' : 'opacity-70'
            }`}
            style={{ color: tokens.textPrimary, cursor: disabled ? 'default' : 'pointer' }}
            onMouseDown={(event) => {
                // Keep the caret in the field: a chevron click must not blur it, or the next
                // Return goes to the button instead of the search.
                event.preventDefault();
            }}
            onClick={onClick}
        >
            {/* L37: `chevron.up` / `chevron.down` at `.font(.system(size: 10, weight: .medium))`
                (`PaneSearchOverlay.swift:50,60`) — 10, not 11, and medium rather than the
                default stroke, so shrinking it does not also thin it. */}
            <Icon name={icon} size={10} weight="medium" />
        </button>
    );
}

export function PaneSearchOverlay(props: PaneSearchOverlayProps): ReactElement {
    const { paneID, needle, total, selected } = props;
    const prefix = props.testIDPrefix ?? 'pane-search';
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
        // L29: focus and NOTHING else. `PaneSearchOverlay.swift:82-85` sets `localNeedle` and
        // flips `isFieldFocused` — SwiftUI leaves the caret at the end of the seeded text, so a
        // re-opened bar is something you keep typing into. The port also `select()`ed, which
        // made the first keystroke silently replace the needle you had just come back to.
        const field = inputRef.current;
        if (field === null) return;
        field.focus();
        // "Caret at the end" is stated rather than left to the browser: a programmatic `focus()`
        // puts it at offset 0 in Chromium and selects the whole value in Gecko, and neither is
        // what SwiftUI does.
        const end = field.value.length;
        field.setSelectionRange(end, end);
        // Mount-only: re-focusing on every needle change would fight a user who tabbed away.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const count = matchCountLabel(draft, total, selected);
    const empty = draft.length === 0;

    /*
     * §S16 — the bar may not outgrow the pane it floats in (OWNER-DIRECTED, 2026-08-29).
     *
     * `PaneSearchOverlay.swift:20-33` frames the `TextField` at a flat 160 and pads OUTSIDE it,
     * so the BAR grows to hold the counter, and `PaneGridView.swift:354-355` simply clips
     * whatever will not fit. The port reproduces both, and the pair has a consequence the
     * shipped app shares: the bar is anchored to the pane's TRAILING edge, so it grows LEFTWARD
     * — and past ~264 px of pane with a three-digit counter up the field's left edge is outside
     * the pane. Measured at the 264.5 px pane this register uses as its reference, with a
     * `2/303` counter: a 305 px bar of which 250 px survived, the needle you had just typed off
     * the pane, and the well, the counter and the three chevrons all that was left on screen.
     *
     * So the bar takes a maximum width — its own trailing inset mirrored as a leading gutter —
     * and the field is allowed to yield inside it (`min-w-0` on the field's wrapper, `minWidth:
     * 0` below). Everything else is untouched: the 22 × 22 buttons never shrink, the counter
     * keeps its reserve, and above the crossover the field is the Swift's flat 160 content box,
     * so a roomy pane is byte-identical. What changes is only which end gets cut when there is
     * not enough pane — the tail of the needle rather than its head.
     *
     * Owner-directed: do not re-report. The parity value is no maximum at all.
     */
    const inset = props.right ?? 8;
    const maxWidth = `calc(100% - ${String(inset * 2)}px)`;

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
            data-testid={`${prefix}-${paneID}`}
            data-search-total={total === null ? '' : String(total)}
            data-search-selected={selected === null ? '' : String(selected)}
            role="search"
            aria-label={props.label ?? 'Search terminal output'}
            className="pointer-events-auto absolute right-2 top-2 z-30 flex items-center gap-1 rounded-lg px-1.5 py-1"
            style={{
                background: tokens.headerBackground,
                // L23: no border. `PaneSearchOverlay.swift:79-81` is background → `clipShape` →
                // `shadow`, and nothing strokes the edge; the port's 1 px divider outline drew a
                // rectangle around a bar the shipped app floats. The shadow is the Swift's
                // `.shadow(color: .black.opacity(0.2), radius: 4, y: 2)` on the same conversion
                // `ResizeBadge` uses (a SwiftUI shadow radius is ~half a CSS blur radius), not
                // the heavier 0.35/12 px drop that was here.
                boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                // §S16 (owner-directed): the ceiling, so the bar cannot grow off the pane's
                // leading edge. See the block above `inset`.
                maxWidth,
                // §S9/§S63: the mount's own offsets, when it has any. `right-2 top-2` above is
                // the default (and the terminal's), so a bar with no override is byte-identical.
                ...(props.top === undefined ? {} : { top: props.top }),
                ...(props.right === undefined ? {} : { right: props.right })
            }}
            // A click in the bar is not a click in the terminal: without this the grid's
            // focus-on-press would pull the caret straight back out of the field.
            onPointerDown={(event) => event.stopPropagation()}
        >
            {/* §S16 (owner-directed): `min-w-0` — a flex item's automatic minimum is its
                content, so without this the wrapper refused to give ground and the bar's
                `maxWidth` above would have been overflowed rather than honoured. */}
            <div className="relative flex min-w-0 items-center">
                <input
                    ref={inputRef}
                    data-testid={`${prefix}-input-${paneID}`}
                    aria-label="Search"
                    placeholder="Search"
                    value={draft}
                    /*
                     * No `leading-none`. It was inert while `input { font: inherit }` was
                     * unlayered — the line box was the body's 1.4 (16.8 px at 12), and the 5 px
                     * insets below put the field at the 26.8 px L22/TERM-114 measured off this
                     * bar. S1/S17 layered the reset's font half, which would have let this class
                     * finally collapse the line box to 12 px and shrink a settled field to 25.5
                     * for nothing. `PaneSearchOverlay.swift:22`'s `TextField` has no collapsed
                     * leading either, so the class went rather than the measurement.
                     */
                    className="w-[160px] px-2 font-mono text-[12px] outline-none"
                    style={{
                        /*
                         * §S16 — 160 is the TEXT column, not the box.
                         *
                         * `PaneSearchOverlay.swift:20-33` puts `.frame(width: 160)` on the
                         * `TextField` itself and applies `.padding(.leading, 8)`, the counter's
                         * trailing reserve and `.padding(.vertical, 5)` OUTSIDE it — the
                         * background paints the padded box, so the needle you can see is a flat
                         * 160 pt in every state and the BAR grows to hold the counter. Under
                         * Tailwind's global `border-box` the same 160 was the outer box, so both
                         * paddings came out of it: 8/8 left 144 px of text empty, and a live
                         * `1/3` counter reserved 33 px on the right and left **119** — a field
                         * that shrinks as you find more matches. `content-box` restores the
                         * Swift's arithmetic without moving a single declared value.
                         */
                        boxSizing: 'content-box',
                        /*
                         * §S16 (owner-directed) — 160 is the column the Swift states, and it is
                         * now also a CEILING rather than a floor. `width` above still sizes the
                         * field wherever the pane can seat it (a roomy pane measures 160.00
                         * exactly, as it did before), but a pane too narrow for the padded box
                         * lets it shrink instead of pushing the needle off the pane's leading
                         * edge. An `<input>`'s automatic minimum is its default 20-character
                         * size, which would have pinned the field open.
                         */
                        minWidth: 0,
                        // L22/L40: `Color.primary.opacity(0.08)` (`PaneSearchOverlay.swift:27`) —
                        // an inset well tinted with the LABEL colour, so it is lighter than the
                        // header bar on dark and darker than it on light. `surfaceBackground`
                        // (#101013) is darker than the #13131A bar in both, which inverted the
                        // contrast: the field read as a hole punched in the bar rather than a
                        // well set into it. Same transcription the empty grid uses for
                        // `.quaternary` — the primary text token at a percentage.
                        background: `color-mix(in srgb, ${tokens.textPrimary} 8%, transparent)`,
                        // L22: `.cornerRadius(5)` (`:28`), not Tailwind's 4 px `rounded`.
                        borderRadius: 5,
                        // L22/L37: `.padding(.vertical, 5)` (`:26`), not `py-1`'s 4 px.
                        paddingTop: 5,
                        paddingBottom: 5,
                        color: tokens.textPrimary,
                        // The face and size stay INLINE even though S1/S17 moved `input { font:
                        // inherit }` into `@layer base` and `font-mono text-[12px]` would now
                        // reach the screen on its own. Inline is the authority for the value the
                        // Swift states — `.font(.system(size: 12, design: .monospaced))` (`:22`) —
                        // and the test below asserts it there; the classes are kept in step.
                        fontFamily: 'var(--kelpi-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                        fontSize: 12,
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
                        data-testid={`${prefix}-count-${paneID}`}
                        className="pointer-events-none absolute right-1.5 font-mono text-[10px] tabular-nums"
                        style={{ color: tokens.textSecondary }}
                    >
                        {count}
                    </span>
                )}
            </div>
            {/*
              * Up is KELPIT and down is PREVIOUS — `PaneSearchOverlay.swift:48-66` wires
              * `chevron.up` to `onNavigateNext` and `chevron.down` to `onNavigatePrevious`, in
              * that order. It reads backwards written down, and it is what the shipped app's
              * users have in their fingers, so the glyph order and the stepping order both
              * follow the Swift rather than the intuition.
              */}
            <StepButton
                testID={`${prefix}-next-${paneID}`}
                label="Next match (Return)"
                icon="chevron-up"
                disabled={empty}
                onClick={props.onNext}
            />
            <StepButton
                testID={`${prefix}-prev-${paneID}`}
                label="Previous match (⇧Return)"
                icon="chevron-down"
                disabled={empty}
                onClick={props.onPrevious}
            />
            <button
                type="button"
                data-testid={`${prefix}-close-${paneID}`}
                aria-label="Close search (Escape)"
                title="Close search (Escape)"
                // L24: `PaneSearchOverlay.swift:74-75` is a flat `.opacity(0.7)` with no hover
                // branch, so the ✕ does not brighten under the cursor either.
                className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded opacity-70"
                style={{ color: tokens.textPrimary }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={props.onClose}
            >
                {/* L37: `.font(.system(size: 9, weight: .semibold))` (`:70`) — the bar's ✕ is a
                    point smaller than the chevrons and bolder than both, the same pairing the
                    pane header's close button uses. */}
                <Icon name="close" size={9} weight="semibold" />
            </button>
        </div>
    );
}
