/**
 * The command palette (shell-ui.md §7, app-state-core.md §10).
 *
 * Overlay over the content row with an almost-invisible backdrop; clicking outside dismisses.
 * The panel is 440 wide, pinned 40 from the top, results capped at 300px and scrollable, with
 * a "No results" row for a non-empty query that matches nothing.
 *
 * The two behaviors worth calling out, because they are contracts rather than styling:
 *
 *   - **Matching is `palette.ts`'s substring rule**, not a fuzzy match, and the `w:`/`p:`
 *     scope prefixes are honored. This component only renders it — as ONE FLAT LIST in the
 *     universe's own order (UI-FIDELITY M54), so each workspace is followed by its own panes.
 *   - **The 200ms focus handoff** (§10.4). Closing the palette — confirm, Escape, backdrop —
 *     must hand keyboard focus back to a terminal, but only after the fade-out has released
 *     the text field: wait 200ms, then focus the destination pane. Exactly one handoff can be
 *     pending; a newer interaction supersedes it and re-opening cancels it outright. That is
 *     why this component stays MOUNTED while closed (it renders null) — an unmounted component
 *     cannot honor a pending timer.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';

import { ChromeIcon, iconGlyph } from './icons';
import { clampSelection, matchPaletteQuery, paletteNavigationOrder, type PaletteItem } from './palette';
import { withAlpha, workspaceColorHex, type ChromeBucket } from './theme';
import { tokens } from './tokens';

/** §10.4: "wait 200 ms, then imperatively focus the target pane's surface". */
export const FOCUS_HANDOFF_MS = 200;

/**
 * UI-FIDELITY H19 — how long the palette takes to arrive and to leave.
 *
 * `ContentView.swift:283, 286`: `.transition(.move(edge: .top).combined(with: .opacity))` under
 * `.animation(.easeOut(duration: 0.15), value: store.isCommandPaletteVisible)`. It slides down
 * from the top edge while fading, over 150 ms, and leaves the same way — the port hard-mounted
 * and hard-unmounted, so the app's most-used overlay POPPED instead of arriving.
 *
 * The enter half is a CSS keyframe (`nex-palette-enter` in `styles.css`). The exit half needs
 * this constant too, because an unmounted component cannot animate: the panel is held on screen
 * for exactly this long after `open` goes false, playing `nex-palette-exit`, and then dropped.
 */
export const PALETTE_TRANSITION_MS = 150;

export interface CommandPaletteProps {
    readonly open: boolean;
    readonly query: string;
    readonly onQueryChange: (query: string) => void;
    /** The whole universe; the palette applies the matching rule itself. */
    readonly items: readonly PaletteItem[];
    readonly onConfirm: (item: PaletteItem) => void;
    readonly onDismiss: () => void;
    /** Called `handoffDelayMs` after any close, with the pane focus should land on. */
    readonly onFocusHandoff?: ((paneID: string | null) => void) | undefined;
    /** The active workspace's focused pane — the handoff target for dismiss paths. */
    readonly fallbackPaneID?: string | null | undefined;
    readonly bucket?: ChromeBucket | undefined;
    readonly handoffDelayMs?: number | undefined;
}

export function CommandPalette(props: CommandPaletteProps): ReactElement | null {
    const bucket = props.bucket ?? 'dark';
    const delay = props.handoffDelayMs ?? FOCUS_HANDOFF_MS;
    const [selected, setSelected] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const handoffRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    const matched = matchPaletteQuery(props.items, props.query);
    const order = paletteNavigationOrder(matched);
    const index = clampSelection(selected, order.length);

    /**
     * UI-FIDELITY M59 — scroll-to-selection follows the KEYBOARD, not the pointer.
     *
     * `CommandPaletteView.swift:67-74` guards `proxy.scrollTo` on a `scrollToSelection` flag that
     * only the two `.onKeyPress` arrow handlers raise, and consumes it on the next selection
     * change. The port scrolled on every `[index, open]` change, so **hovering** a row scrolled
     * the list under the pointer — a mouse-driven selection is already on screen by definition,
     * and moving it is how you end up chasing a row with the cursor.
     */
    const scrollOnSelectRef = useRef(false);

    const cancelHandoff = (): void => {
        if (handoffRef.current === null) return;
        clearTimeout(handoffRef.current);
        handoffRef.current = null;
    };

    const scheduleHandoff = (paneID: string | null): void => {
        cancelHandoff();
        const handler = props.onFocusHandoff;
        if (handler === undefined) return;
        handoffRef.current = setTimeout(() => {
            handoffRef.current = null;
            handler(paneID);
        }, delay);
    };

    // Opening resets the query selection and cancels any handoff from a prior close (§10.3).
    useEffect(() => {
        if (!props.open) return;
        cancelHandoff();
        setSelected(0);
        // M59: the Swift's flag is `@State` on a view that is created fresh on every open, so it
        // is false on arrival. This component stays mounted, so the open edge clears it by hand.
        scrollOnSelectRef.current = false;
        inputRef.current?.focus();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- open-edge only, by design
    }, [props.open]);

    // A pending handoff must not outlive the app.
    useEffect(() => cancelHandoff, []);

    useEffect(() => {
        setSelected(0);
    }, [props.query]);

    useEffect(() => {
        if (!props.open) return;
        // M59: a pointer-driven selection is already under the pointer; only ↑/↓ scroll, and
        // `anchor: .center` / `withAnimation(.easeOut(0.1))` are what the shipped list does.
        if (!scrollOnSelectRef.current) return;
        scrollOnSelectRef.current = false;
        const row = listRef.current?.querySelector('[data-selected="true"]');
        (row as { scrollIntoView?: (options?: unknown) => void } | null)?.scrollIntoView?.({
            block: 'center',
            behavior: 'smooth'
        });
    }, [index, props.open]);

    /*
     * §H19's exit. `open` going false starts a 150 ms window in which the overlay is still
     * mounted and playing `nex-palette-exit`; when it closes, the component unmounts as before.
     * Tracked off the OPEN EDGE rather than from a `useEffect` on every render so a re-render
     * while closed cannot restart it, and re-opening inside the window cancels it outright
     * (which is also what makes ⌘P-⌘P-⌘P behave).
     */
    const [exiting, setExiting] = useState(false);
    const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const wasOpen = useRef(props.open);
    useEffect(() => {
        if (props.open === wasOpen.current) return;
        wasOpen.current = props.open;
        if (exitTimer.current !== null) {
            clearTimeout(exitTimer.current);
            exitTimer.current = null;
        }
        if (props.open) {
            setExiting(false);
            return;
        }
        // The field keeps DOM focus while the panel plays out, which would put a keystroke typed
        // straight after Escape into a palette that is already leaving. The handoff (§10.4) is
        // what decides where focus lands; this only makes sure it is not still here.
        inputRef.current?.blur();
        setExiting(true);
        exitTimer.current = setTimeout(() => {
            exitTimer.current = null;
            setExiting(false);
        }, PALETTE_TRANSITION_MS);
    }, [props.open]);
    useEffect(
        () => () => {
            if (exitTimer.current !== null) clearTimeout(exitTimer.current);
        },
        []
    );

    if (!props.open && !exiting) return null;
    const phase = props.open ? 'entering' : 'exiting';

    /*
     * UI-FIDELITY L101 — what sits under the search row, and whether there is a line at all.
     *
     * `CommandPaletteView.swift:41-82`: `if !items.isEmpty` → `Divider()` + the list; `else if
     * !query.isEmpty` → `Divider()` + "No results"; otherwise NEITHER — an empty query with
     * nothing to show is a bare field. The port drew the divider unconditionally and always
     * rendered the "No results" row, so an empty universe read as a failed search.
     */
    const showResults = order.length > 0;
    const showNoResults = order.length === 0 && props.query.length > 0;
    const showDivider = showResults || showNoResults;

    const confirm = (item: PaletteItem | undefined): void => {
        if (item === undefined) {
            // §10.3: an out-of-range selection (zero matches) still closes AND hands off, so
            // the window is never left without keyboard focus.
            props.onDismiss();
            scheduleHandoff(props.fallbackPaneID ?? null);
            return;
        }
        item.run?.();
        props.onConfirm(item);
        scheduleHandoff(item.paneID ?? props.fallbackPaneID ?? null);
    };

    const dismiss = (): void => {
        props.onDismiss();
        scheduleHandoff(props.fallbackPaneID ?? null);
    };

    /**
     * UI-FIDELITY M55 — the keys belong to the PANEL, not to the text field.
     *
     * `CommandPaletteView.swift:92-105` hangs `.onKeyPress(.upArrow/.downArrow/.escape)` on the
     * view **body**, so they answer wherever focus sits inside the palette. The port bound them
     * to the `<input>` alone, and the global dispatcher deliberately stands down while the
     * palette is open (`keys.ts:230-232`) — so a mousedown that took focus off the field left the
     * palette with no keyboard dismiss and no navigation at all, only a backdrop click.
     *
     * Hung as a CAPTURE-phase handler on the panel: it sees a key aimed at the field, at a row
     * button, or at the card's own chrome, and it runs before the field would have. Everything it
     * does not name (typing, ⌘A, the caret keys) falls through to the field untouched.
     */
    const handleKey = (event: { key: string; preventDefault: () => void; stopPropagation: () => void }): void => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            scrollOnSelectRef.current = true;
            setSelected(clampSelection(index + 1, order.length));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            scrollOnSelectRef.current = true;
            setSelected(clampSelection(index - 1, order.length));
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            confirm(order[index]);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        }
    };

    return (
        <div
            data-testid="palette-backdrop"
            data-palette-phase={phase}
            className="nex-palette-scrim absolute inset-0 z-40 flex justify-center"
            style={{
                /*
                 * UI-FIDELITY M56 — the shipped backdrop is INVISIBLE.
                 *
                 * `ContentView.swift:264` is `Color.black.opacity(0.001)`: not a scrim, a hit
                 * target, because a fully clear SwiftUI view takes no taps. A DOM element with a
                 * transparent background still hit-tests, so the dismiss click needs no tint at
                 * all — and the 8% wash the port had dimmed the whole content row every ⌘P.
                 */
                background: 'transparent',
                // On the way out it is a picture, not a control: a click during the 150 ms goes
                // to whatever is behind, exactly as it would have with the old hard unmount.
                ...(phase === 'exiting' ? { pointerEvents: 'none' as const } : {})
            }}
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) dismiss();
            }}
        >
            <div
                data-testid="command-palette"
                role="dialog"
                aria-label="Command palette"
                className="nex-palette-panel mt-10 h-fit w-[440px] overflow-hidden rounded-[10px]"
                /*
                 * UI-FIDELITY L94 / L95 — the shipped card is a fill, a clip and one soft shadow.
                 *
                 * `CommandPaletteView.swift:85-87` is `.background(surfaceBackground)
                 * .clipShape(RoundedRectangle(cornerRadius: 10)).shadow(black@0.25, radius 12,
                 * y 4)`. There is no stroke on it at all, and the shadow is a lift off the pane
                 * behind it — the port's `0 20px 60px rgba(0,0,0,0.45)` was 5× the offset, 5× the
                 * blur and nearly twice the alpha, a dark halo plainly visible in run-O/104.
                 */
                style={{
                    background: tokens.surfaceBackground,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                    color: tokens.textPrimary
                }}
                onKeyDownCapture={handleKey}
                /*
                 * M55's other half: the card's own chrome must not be able to take focus OUT of
                 * the palette. A mousedown on the list padding or the header row would blur the
                 * field to `document.body`, where no handler in this component can see the next
                 * keystroke. Default-prevented, so the caret stays where it was; and if focus has
                 * already left, the field takes it back rather than the palette going deaf.
                 */
                onMouseDown={(event) => {
                    const target = event.target as HTMLElement | null;
                    if (target !== null && target.closest('input, button, [tabindex]') !== null) return;
                    event.preventDefault();
                    if (!event.currentTarget.contains(globalThis.document?.activeElement ?? null)) {
                        inputRef.current?.focus();
                    }
                }}
            >
                <div
                    /*
                     * UI-FIDELITY L97 / L101 — the search row's own metrics, and its divider.
                     *
                     * `CommandPaletteView.swift:22-39`: `HStack(spacing: 8)` with a 14 pt
                     * `magnifyingglass` in `.secondary`, `.padding(.vertical, 10)`. And the
                     * `Divider()` at `:42` / `:77` is drawn only when something follows it — an
                     * empty query with nothing to list is a bare field, not a field with a line
                     * under it.
                     */
                    className={`flex items-center gap-2 px-3 py-[10px] ${showDivider ? 'border-b' : ''}`}
                    style={{ borderColor: tokens.divider }}
                >
                    {/* L97: the app's own magnifier at the shipped 14 pt, in `.secondary` — the
                        `⌕` text glyph it replaced sat small inside its em box whatever size it
                        was given, which is the "reads noticeably smaller" half of the finding.
                        Same glyph the sidebar's filter field draws. */}
                    <span
                        data-testid="palette-search-glyph"
                        className="flex shrink-0 items-center"
                        style={{ color: tokens.textSecondary }}
                    >
                        <ChromeIcon name="search" size={14} />
                    </span>
                    <input
                        ref={inputRef}
                        autoFocus
                        aria-label="Jump to workspace or pane"
                        placeholder="Jump to workspace or pane..."
                        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
                        style={{ color: tokens.textPrimary }}
                        value={props.query}
                        onChange={(event) => {
                            props.onQueryChange(event.target.value);
                        }}
                    />
                </div>

                {/*
                  * L101: 13 pt `.secondary`, `.padding(.vertical, 16)` and NOT inside the list —
                  * `CommandPaletteView.swift:76-82` is a sibling branch of the `ScrollView`, so it
                  * carries none of the list's own 4 pt inset.
                  */}
                {showNoResults ? (
                    <div
                        data-testid="palette-no-results"
                        className="px-3 py-4 text-center text-[13px]"
                        style={{ color: tokens.textSecondary }}
                    >
                        No results
                    </div>
                ) : null}

                {/* L98: `.padding(.vertical, 4)` on the list and nothing horizontal — the row's
                    own 12 pt inset is what indents the content, so a selected row's fill is a
                    full-bleed band across the card rather than an inset pill. */}
                {showResults ? (
                    <div ref={listRef} className="max-h-[300px] overflow-y-auto py-1">
                        {(
                        /*
                         * M54 — one flat list, in the universe's own order: a workspace, then
                         * ITS panes, then the next workspace. `CommandPaletteView.swift:47`
                         * is a single `ForEach(items)` over `AppReducer.swift:192-240`'s
                         * `buildCommandPaletteItems`, which appends a workspace and walks that
                         * workspace's layout before moving on. Grouping them into
                         * WORKSPACES / PANES headers put every workspace above every pane,
                         * which is an ORDERING change, not chrome: the pane you want stops
                         * sitting under the workspace it belongs to. The kind is still legible
                         * per row — the trailing chip is "workspace" or the owning workspace's
                         * name, exactly as `CommandPaletteRow.swift:139-155` draws it.
                         */
                        order.map((item, rowIndex) => {
                            const isSelected = rowIndex === index;
                            return (
                                <button
                                    key={item.id}
                                    type="button"
                                    data-testid="palette-row"
                                    data-item-id={item.id}
                                    data-item-kind={item.kind}
                                    data-selected={isSelected ? 'true' : 'false'}
                                    /* L98 / L99: `CommandPaletteRow`'s `HStack(spacing: 10)` with
                                       `.padding(.horizontal, 12).padding(.vertical, 6)`, and a
                                       selection background with NO radius — a band, not a pill. */
                                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
                                    style={{
                                        background: isSelected ? withAlpha('#6F9BD8', 0.2) : 'transparent'
                                    }}
                                    onMouseEnter={() => {
                                        setSelected(rowIndex);
                                    }}
                                    onClick={() => {
                                        confirm(item);
                                    }}
                                >
                                    {item.workspaceColor === null ? null : (
                                        <span
                                            aria-hidden
                                            className="h-[8px] w-[8px] shrink-0 rounded-full"
                                            style={{
                                                background: workspaceColorHex(item.workspaceColor, bucket)
                                            }}
                                        />
                                    )}
                                    {/* L99: `.frame(width: 16)` around a 12 pt glyph. */}
                                    <span
                                        aria-hidden
                                        className="w-4 shrink-0 text-center text-[12px]"
                                        style={{ color: tokens.textSecondary }}
                                    >
                                        {iconGlyph({ kind: 'system', name: item.icon })}
                                    </span>
                                    {/* L99: `VStack(alignment: .leading, spacing: 1)`. */}
                                    <span className="flex min-w-0 flex-1 flex-col gap-px">
                                        <span className="truncate text-[13px]">{item.title}</span>
                                        {item.subtitle.length === 0 ? null : (
                                            <span
                                                className="truncate text-[11px]"
                                                style={{ color: tokens.textSecondary }}
                                            >
                                                {item.subtitle}
                                            </span>
                                        )}
                                    </span>
                                    {item.shortcut === undefined ? null : (
                                        <span
                                            data-testid="palette-shortcut"
                                            className="shrink-0 font-mono text-[10px]"
                                            style={{ color: tokens.textTertiary }}
                                        >
                                            {item.shortcut}
                                        </span>
                                    )}
                                    {/* L100: the neutral pill is `.tertiary`, and the workspace
                                        pill's name is white at 90 %, not flat white
                                        (`CommandPaletteRow.swift:139-155`). */}
                                    {item.kind === 'workspace' ? (
                                        <span
                                            className="shrink-0 rounded px-1.5 py-px text-[10px]"
                                            style={{
                                                background: withAlpha('#E6E6EA', 0.08),
                                                color: tokens.textTertiary
                                            }}
                                        >
                                            workspace
                                        </span>
                                    ) : item.kind === 'pane' && item.workspaceColor !== null ? (
                                        <span
                                            className="shrink-0 rounded px-1.5 py-px text-[10px]"
                                            style={{
                                                color: 'rgba(255,255,255,0.9)',
                                                background: withAlpha(
                                                    workspaceColorHex(item.workspaceColor, bucket),
                                                    0.7
                                                )
                                            }}
                                        >
                                            {item.workspaceName}
                                        </span>
                                    ) : null}
                                </button>
                            );
                        })
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
