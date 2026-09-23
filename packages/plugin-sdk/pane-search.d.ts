/**
 * The find bar over the pane Kelpi is searching, as the SELECTED presenter for `pane.search` sees
 * it.
 *
 * A view selected for `pane.search` in Settings ▸ Plugins ▸ Workbench views draws the bar that ⌘F
 * opens over a shell pane. Selection is Settings-only: the placement appears in
 * `ui.getWorkbench().slots` and `ui.selectView` refuses it, because this presenter owns a TEXT INPUT
 * and the caret for as long as the search is open, and a plugin that could select itself into it
 * could take the keyboard from a chord the user pressed over their own shell.
 *
 * ── Shell panes only ────────────────────────────────────────────────────────────────
 *
 * Kelpi's daemon computes match counts for a shell pane and for nothing else: a markdown or diff
 * preview's find runs inside its own sandboxed frame, and a web pane's runs in the page's own
 * `findInPage` with nothing in the document able to float above it. Those two keep their native
 * bars, and a frame you receive is always about a shell pane.
 *
 * ── The state is Kelpi's, not yours ─────────────────────────────────────────────────
 *
 * The needle, the total and the selected match are WORKSPACE state on Kelpi's delta stream, so two
 * windows looking at the same pane read the same counter and closing the bar in one closes it in
 * both. You never hold them: you ask for a change with a call and read the answer in the next frame.
 * That is also what makes the fallback cheap - if your presenter fails, the native bar comes back
 * with the needle intact and its field focused, because none of it was ever yours to lose.
 *
 * Case sensitivity is the one exception, and it is stated rather than hidden: Kelpi's search verb
 * takes it per request and stores nothing, so the host holds it for the window for the length of one
 * search session. Two windows agree on the needle, the total and the selection; the case toggle is
 * local to the window whose bar you are drawing.
 *
 * ── The caret, and the chords ───────────────────────────────────────────────────────
 *
 * Your frame holds the caret while the bar is up, exactly as the native bar's autofocus does. It is
 * not contained: a click on the terminal underneath moves the caret to the terminal, because a find
 * bar is not modal.
 *
 * The host relays four chords into the window and no others: **Escape** and the rebindable
 * **toggle-search chord** (⌘F by default), which close the search; and **⌘G** / **⇧⌘G**, which step
 * the selection forwards and backwards (**Ctrl-G** / **Shift-Ctrl-G** where Ctrl is the primary
 * modifier). ⌘G steps while your frame or the searched pane holds the caret, and nowhere else. Everything else you press inside the frame - typing, arrows,
 * Return, Tab, your own shortcuts - stays in your document and reaches nothing in the window. That
 * is deliberate: a keystroke meant for a search field must never arrive in somebody's shell.
 *
 * Return and ⇧Return are yours to bind if you want the native bar's behaviour; call `searchNext` and
 * `searchPrevious` from your own handler.
 *
 * ── What is withheld ────────────────────────────────────────────────────────────────
 *
 * Scrollback contents (read them with `capture(pane, { scrollback })` under your own plugin
 * identity, where it is an auditable call rather than a standing grant), every other pane's state,
 * paths, the workspace id, every other plugin's `pluginID`, every run closure, and the
 * `data-testid` of the bar you replaced.
 *
 * The counts are not withheld, and they say something about the buffer: a needle you set and the
 * `total` that comes back tell you whether that text is in the searched pane's scrollback. That is
 * what a find bar is, and it is why this placement is Settings-only and why an installed plugin is
 * trusted with the window in the first place; it is not a way around `capture`, which returns the
 * text itself.
 *
 * ── What stays native ───────────────────────────────────────────────────────────────
 *
 * **Opening a search.** ⌘F, the menu, the palette row and the `terminal.search(workspaceID,
 * 'toggle')` domain call are the ways a search opens. There is no presenter call for it: a presenter
 * that could open the bar could put a text field over any pane at any moment.
 *
 * **The reveal and the highlight.** Scrolling to a match and painting it belong to the terminal
 * renderer - including a replacement terminal renderer, which receives search through its own
 * contract. `searchNext` moves Kelpi's selection and the renderer follows.
 *
 * **The markdown, diff and web find bars**, and the caret hand-back when the search closes.
 *
 * Pane search presenters are desktop-only in this release. A phone window keeps the native bar,
 * which lives inside a shell that owns the software-keyboard inset a presenter cannot read, so a
 * frame you receive always reports `formFactor: 'desktop'`.
 */

export type PaneSearchPlacement = 'pane.search';

/** The pane kinds this placement opens on. One, in this release. */
export type PaneSearchKind = 'shell';

/**
 * Where your bar goes, inside your own frame.
 *
 * The host mounts ONE view over the whole pane grid and clips it to this rectangle, so you position
 * the bar with `position: absolute` and these four numbers, in CSS px, with the origin at the grid's
 * top left. The clip is the host's: pixels outside it are removed from paint and from hit testing,
 * so you cannot draw over a pane body and a click below the bar reaches the terminal under it.
 *
 * It is the pane's top-trailing corner, which is where the native bar sits, already inset by the
 * bar's own margin. `null` when no search is open or the grid has not measured itself yet: draw
 * nothing.
 */
export interface PaneSearchRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** Where the selected match sits, as `TerminalSearch` states it. Null before one is selected. */
export interface PaneSearchMatch {
    /** The absolute buffer line Kelpi numbers the match at, or null when it stated none. */
    readonly line: number | null;
    readonly col: number;
    readonly length: number;
    /**
     * How far above the buffer's bottom the match is.
     *
     * Kelpi reports this rather than an absolute row because a client's scrollback depth need not be
     * the daemon's. The reveal is native, so this is for display - "match 12 lines up" - rather than
     * for scrolling anything yourself.
     */
    readonly linesFromBottom: number;
}

/** One frame: the open search, or the absence of one. */
export interface PaneSearchSnapshot {
    readonly placement: PaneSearchPlacement;
    /** Always `desktop` in a frame a presenter receives. */
    readonly formFactor: 'desktop' | 'phone';
    /**
     * A search is open and you are the one drawing it.
     *
     * `false` means present nothing: nothing is being searched, the window is showing another
     * workspace, the grid is hidden, or the native bar has the box back. **Every call is refused
     * while it is false**, which is also what stops a presenter opening a search of its own.
     */
    readonly visible: boolean;
    /** The searched pane, or null while nothing is being searched. Every call takes this id. */
    readonly paneID: string | null;
    readonly kind: PaneSearchKind | null;
    /**
     * The needle, at most 1,024 characters: Kelpi's, or while one this window typed is still on its
     * way there, that one (it leads by at most the 300 ms short-needle debounce and a round trip).
     *
     * That is the needle the native bar's own field shows, and it is the one to seed from. When the
     * native bar hands the search to you mid-word - ⌘F pressed before your view had painted - what
     * was typed in its last 300 ms is here and not yet in Kelpi's state; seed from it and keep
     * following it until the user types into your field, and nothing typed is lost.
     */
    readonly needle: string;
    /**
     * Kelpi's needle was longer than 1,024 characters and this frame carries a prefix of it.
     *
     * Only reachable when another plugin set a longer needle through `terminal.search`; a needle you
     * send is refused past the cap rather than truncated. Say so in your bar rather than presenting
     * the prefix as the whole string.
     */
    readonly needleTruncated: boolean;
    readonly caseSensitive: boolean;
    /** Kelpi's match count, or null before it has counted anything. */
    readonly total: number | null;
    /**
     * 0-based index of the selected match, or null before one is selected.
     *
     * The native bar reads `selected+1/total` once something is selected, `-/total` before that, and
     * nothing at all while the field is empty. A selection with a total of 0 behind it is not a state
     * Kelpi can publish.
     */
    readonly selected: number | null;
    readonly match: PaneSearchMatch | null;
    readonly box: PaneSearchRect | null;
}

export interface PaneSearchSize {
    readonly width: number;
    readonly height: number;
}

/**
 * Every presenter method, on `kelpi.ui` for a view selected into `pane.search`.
 *
 * Each call is checked against the placement this view was selected into AND against the pane the
 * current frame names: a pane id that was right one frame ago and is not now - the search closed, or
 * moved - is refused and does nothing. `reportPresenterReady` is shared with the interaction,
 * Settings and pane chrome presenters.
 */
export interface WindowPaneSearchAPI {
    getPaneSearch(): Promise<PaneSearchSnapshot>;
    /** Initial/latest frames with bounded acknowledged delivery, as onInteraction.
     * A frame exceeding 256 KiB calls onError, or reports a view error if omitted. */
    onPaneSearch(
        listener: (value: PaneSearchSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): () => void;
    /** Confirms this presenter has painted. Required within 5 seconds of the first frame. */
    reportPresenterReady(): Promise<void>;
    /**
     * Set the needle Kelpi searches for.
     *
     * A single line of at most 1,024 characters; anything else is refused. Kelpi debounces a short
     * needle exactly as the native field does (a one-character needle typed into a full buffer is one
     * full scan per keystroke), so echo what you typed in your own field rather than waiting for the
     * frame - the frame is the authority, not the display latency.
     *
     * A new needle drops the selection: the counter goes back to `-/N` until something steps.
     */
    setSearchNeedle(paneID: string, text: string): Promise<void>;
    /** Recount with or without case sensitivity. Local to this window (see the note at the top). */
    setSearchCaseSensitive(paneID: string, on: boolean): Promise<void>;
    /** Advance the selection. It wraps, and with nothing selected it lands on the FIRST match. */
    searchNext(paneID: string): Promise<void>;
    /** Step back. It wraps, and with nothing selected it lands on the LAST match. */
    searchPrevious(paneID: string): Promise<void>;
    /**
     * Close the search.
     *
     * Kelpi clears the needle and every count for the workspace and hands the caret back to the pane,
     * so the next keystroke lands in the shell. Escape and the toggle-search chord do the same thing
     * through the relay; this is the call behind your own close control.
     */
    closeSearch(paneID: string): Promise<void>;
    /**
     * Declare how big your bar is, in CSS pixels.
     *
     * The host clamps the width to the smaller of 480 px and the pane's inner width, and the height
     * to the smaller of 96 px and a quarter of the pane, then clips your frame to the result at the
     * pane's top-trailing corner. Until something is declared the box is the native bar's own
     * measured box, so a presenter that declares nothing is drawn in exactly the space the bar it
     * replaced occupied.
     *
     * Measure what you drew and re-declare when it changes - a count going from `3/9` to `312/4096`
     * is a wider bar.
     *
     * `null` withdraws: the box goes back to the native default on the next frame, and you can hand
     * it back without being torn down. A negative number is 0, which is a legal box; a non-finite one
     * is refused and the current box stands. A declaration belongs to the view that made it, so a
     * reload, a different selection or a fallback drops it.
     */
    setSearchBoxSize(paneID: string, size: PaneSearchSize | null): Promise<void>;
}
