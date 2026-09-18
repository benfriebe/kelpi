/**
 * Every pane's header, as the SELECTED presenter for `pane.chrome` will see it.
 *
 * **Phase A: declared, not mounted.** The placement exists in `PLUGIN_PLACEMENTS`, the shared
 * model behind this projection is what the bundled header already draws from, and the height
 * authority and parking below are implemented in the host. What does not exist yet is the
 * presenter host: no view can be selected into `pane.chrome`, `ui.selectView` answers "Workbench
 * slot is not registered.", and `WindowPaneChromeAPI` is NOT on `ViewAPI.ui`. These are the types
 * the phase B host will publish, written down now so the shape can be argued about against the
 * model rather than after a presenter is mounted against it.
 *
 * One placement for every pane kind, and one frame for every visible pane of the displayed
 * workspace: the header row is one row, and a presenter drawing four panes has to decide what a
 * narrow pane gives up relative to its neighbours. Selection will be Settings-only, as the
 * interaction and Settings presenters are.
 *
 * ── What is withheld ────────────────────────────────────────────────────────────────
 *
 * Absolute paths beyond the home abbreviation (`directory` is `~/…`; the real path stays with the
 * host), PTY handles and pids, agent session ids, every other plugin's `pluginID`, the command
 * name behind any control or item, connection URLs and the URL of a web pane's page, every run
 * closure, and the `data-testid` of every control (the bundled header's handle on its own DOM is
 * not API).
 *
 * A control and an item are a display name, an icon, an enabled flag and an opaque `ref`. The ref
 * is the whole of that promise: a contribution id is `<pluginID>.<name>`, so publishing a control
 * under its own key would name the owner and the verb in the same breath as saying they are
 * withheld. Refs are minted per frame, scoped to their pane, and mean nothing outside the frame
 * they arrived in; the host keeps the mapping and re-resolves it against a fresh model before
 * anything runs, so a ref from an older frame, from another pane, or invented, activates nothing.
 *
 * ── What stays native ───────────────────────────────────────────────────────────────
 *
 * The focus ring, the pane context menu, the inline rename FIELD, every destructive confirmation,
 * the dividers, the resize badge, the terminal's mirror clip wash and the find bar. A presenter
 * never draws a host-owned text input and never draws a destructive confirmation: `renamePane`
 * opens the host's field and `closePane` routes through the host's confirmation.
 *
 * Pane chrome presenters are desktop-only in this release. A phone window keeps its own header,
 * which owns the software-keyboard inset and the sheet navigation a presenter cannot read, so a
 * frame a presenter receives always reports `formFactor: 'desktop'`.
 */

export type PaneChromePlacement = 'pane.chrome';

/** The pane kinds. A presenter draws all six or none: fallback is all-or-nothing. */
export type PaneChromeKind = 'shell' | 'markdown' | 'scratchpad' | 'diff' | 'web' | 'plugin';

export type PaneChromeStatus = 'idle' | 'running' | 'waitingForInput';

/**
 * The title, split where the host middle-truncates it.
 *
 * `head` may ellipsize; `tail` is the last path segment and never does. The split travels with the
 * fact because it is a measured behaviour of the pane header rather than a presenter's taste, and
 * two implementations of it would truncate the same path two ways in the same window.
 */
export interface PaneChromeTitleParts {
    readonly head: string;
    readonly tail: string;
}

/** The working tree's change counts, or null where the host has none for this pane. */
export interface PaneChromeChanges {
    readonly changedFiles: number;
    readonly additions: number;
    readonly deletions: number;
}

export type PaneChromeAgentTone = 'running' | 'waiting';

/** A shell pane's attached agent. Null for every pane without one. */
export interface PaneChromeAgent {
    /** `claude`, `codex`, or null where the pane never recorded one. No session id. */
    readonly kind: string | null;
    readonly elapsedSeconds: number | null;
    readonly backgroundTasks: number;
    /** The composed badge line, so a presenter that wants the host's wording has it. */
    readonly text: string;
    readonly tone: PaneChromeAgentTone;
}

export interface PaneChromeZoom {
    readonly zoomed: boolean;
    /** The workspace has more than one pane, so zoom means something. */
    readonly available: boolean;
}

export interface PaneChromeSync {
    readonly active: boolean;
    readonly excluded: boolean;
}

/** Which of the three user-data badges the host's ladder seated at this width. */
export interface PaneChromeBadgeFit {
    readonly label: boolean;
    readonly agent: boolean;
    readonly branch: boolean;
}

/**
 * What the pane's own width has already decided.
 *
 * Read it rather than re-deriving it: a presenter cannot measure a header it has not drawn yet,
 * and a presenter that disagreed with the host about which badges fit would disagree about where
 * the controls start. `width` is null in a frame taken before the pane was measured.
 */
export interface PaneChromeSize {
    readonly width: number | null;
    readonly badges: PaneChromeBadgeFit;
    /** The width budget in button units, including the fixed charge for the host's item box. */
    readonly buttons: number;
    /** How many trailing controls the host folded into its overflow menu. */
    readonly folded: number;
}

export type PaneChromeControlKind = 'action' | 'item';

/** One trailing control: the host's own, or another plugin's `pane.header` command. */
export interface PaneChromeControl {
    /** The opaque, pane-scoped ref `activatePaneControl` takes back. Never a contribution id. */
    readonly ref: string;
    readonly kind: PaneChromeControlKind;
    readonly label: string;
    /** An SF Symbol-style name. The presenter supplies its own drawing. */
    readonly icon: string;
    readonly enabled: boolean;
    /** The close control: the host never folds it away, and neither should a presenter. */
    readonly pinned: boolean;
}

export type PaneChromeItemTone = 'default' | 'info' | 'success' | 'warning' | 'error';

/**
 * Another plugin's `pane.header` item: a display name, a badge, a tone, an enabled flag and an
 * opaque ref. No `pluginID` and no command name, which is the palette's rule and the prompt
 * owner's rule. Draw these, or a replaced header deletes somebody else's extension point.
 */
export interface PaneChromeItem {
    /** The opaque, pane-scoped ref `runPaneHeaderItem` takes back. Never a contribution id. */
    readonly ref: string;
    readonly text: string;
    readonly tooltip: string | null;
    readonly badge: string | null;
    readonly tone: PaneChromeItemTone;
    readonly enabled: boolean;
}

/** One pane's chrome. */
export interface PaneChromePane {
    readonly paneID: string;
    readonly kind: PaneChromeKind;
    readonly status: PaneChromeStatus;
    readonly focused: boolean;
    readonly title: string;
    readonly titleParts: PaneChromeTitleParts;
    /** Home-abbreviated: `~/code/kelpi`. The absolute path never leaves the host. */
    readonly directory: string;
    readonly label: string | null;
    readonly branch: string | null;
    readonly changes: PaneChromeChanges | null;
    readonly agent: PaneChromeAgent | null;
    readonly zoom: PaneChromeZoom;
    readonly sync: PaneChromeSync;
    /** The band this pane is painting at right now, already clamped. */
    readonly height: number;
    readonly size: PaneChromeSize;
    readonly controls: readonly PaneChromeControl[];
    readonly items: readonly PaneChromeItem[];
    /** How many of those items the HOST is already drawing in its own box beside the controls. */
    readonly contributions: number;
    /** The host's inline rename field is up on this pane. Leave the title to it. */
    readonly renaming: boolean;
}

/**
 * One frame for the whole workspace, bounded at 256 KiB.
 *
 * A pane's title is whatever its shell last wrote to the terminal's OSC, so a workspace CAN
 * overrun the budget. An oversized frame is undeliverable and an undeliverable frame fails the
 * placement, which would latch the user's chosen presenter out over somebody else's window title.
 * So the frame carries the panes that fit, in the workspace's own order, and counts the rest in
 * `withheld`; a withheld pane keeps its native header and arrives in a later frame.
 */
export interface PaneChromeSnapshot {
    readonly placement: PaneChromePlacement;
    /** Always `desktop` in a frame a presenter receives. */
    readonly formFactor: 'desktop' | 'phone';
    readonly workspaceID: string;
    readonly focusedPaneID: string | null;
    readonly zoomedPaneID: string | null;
    /** Every visible pane of the displayed workspace that fits the budget, in its own order. */
    readonly panes: readonly PaneChromePane[];
    /** Visible panes the budget could not carry. They keep their native header. */
    readonly withheld: number;
}

export type PaneChromeSplitDirection = 'horizontal' | 'vertical';

/**
 * Every presenter method, on `kelpi.ui` once phase B mounts the placement.
 *
 * Each call is checked against the placement this view was selected into, and every id is
 * re-resolved against the published projection: a pane the current frame did not publish, or a
 * control that is gone or disabled, is refused and does nothing. `reportPresenterReady` is shared
 * with the interaction and Settings presenters.
 */
export interface WindowPaneChromeAPI {
    getPaneChrome(): Promise<PaneChromeSnapshot>;
    /** Initial/latest frames with bounded acknowledged delivery, as onInteraction.
     * A frame exceeding 256 KiB calls onError, or reports a view error if omitted. */
    onPaneChrome(
        listener: (value: PaneChromeSnapshot) => void | Promise<void>,
        onError?: (error: Error) => void | Promise<void>
    ): () => void;
    /** Confirms this presenter has painted. Required within 5 seconds of the first frame. */
    reportPresenterReady(): Promise<void>;
    focusPane(paneID: string): Promise<void>;
    splitPane(paneID: string, direction: PaneChromeSplitDirection): Promise<void>;
    toggleZoom(paneID: string): Promise<void>;
    /** Opens the HOST's inline rename field on that pane. It never takes a name. */
    renamePane(paneID: string): Promise<void>;
    /** Routes through the host's existing confirmation. A presenter never draws one. */
    closePane(paneID: string): Promise<void>;
    /**
     * Press one of the pane's trailing controls: the host's own (`copy`, `edit`, `refresh`, the
     * splits, the globe, the ✕) or another plugin's `pane.header` command button.
     *
     * Two calls rather than one, because the frame has two lists and they are not the same kind of
     * thing: `controls` is the button ROW a presenter redraws, and `items` is the box of another
     * plugin's chips beside it, which the host keeps drawing itself. A control's ref activates
     * only through this call and an item's only through `runPaneHeaderItem`, so neither list can
     * be used to reach into the other.
     *
     * `close` routes through the host's confirmation like every other close.
     */
    activatePaneControl(paneID: string, ref: string): Promise<void>;
    /** Activate one of another plugin's `pane.header` items by its opaque ref. */
    runPaneHeaderItem(paneID: string, ref: string): Promise<void>;
    /** Opens the host's own pane context menu, which stays native. */
    openPaneMenu(paneID: string): Promise<void>;
    /**
     * Declare how tall this presenter's band needs to be, in CSS pixels.
     *
     * The host clamps it to the smaller of 96 px and a quarter of that pane's height, lays the
     * pane's body out under the clamped value, and the terminal's cols and rows and a web pane's
     * native bounds follow. The native 24 px applies until something is declared, and a
     * declaration belongs to the view that made it: a reload, a different selection or a fallback
     * drops every one of them at once.
     *
     * `null` withdraws: the pane goes back to the native band on the next frame, and a presenter
     * that wants a pane to keep the bundled header can say so without being torn down. A negative
     * number is 0, which is a legal band; a non-finite one is refused and the current band stands.
     *
     * Over a WEB pane a declared band taller than the native one enrols in the host's overlay
     * registry and parks the page while the two overlap, because nothing in the document can
     * composite above a native page view. A band on a pane that is not on screen (zoomed out, or
     * in a workspace the window is not showing) registers nothing at all.
     */
    setPaneChromeHeight(paneID: string, pixels: number | null): Promise<void>;
}
