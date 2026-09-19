/**
 * What a pane's chrome IS, what a pane chrome control IS, and what may be said about either.
 *
 * The sibling of `settings/contract.ts` and `interaction/contract.ts`, written to the same three
 * rules:
 *
 *   1. **No React, no store, no socket.** Everything here is data or a pure function over data, so
 *      the rules can be asserted without mounting a window. `surface.ts` owns the behaviour,
 *      `model.ts` owns the per-pane projection, `height.ts` owns the band, this owns the
 *      vocabulary. The two type-only imports (`PaneModel`'s field names, `IconName`'s glyph names)
 *      are erased at compile time and bring nothing with them at runtime.
 *   2. **Descriptors out, ids in.** A control descriptor carries its key, its display name, its
 *      icon, its enabled flag and the `data-testid` the button already had. It does NOT carry the
 *      verb it runs, the owning `pluginID`, or any closure - the run targets are a private table
 *      `model.ts` keeps beside the descriptor and `surface.ts` re-resolves against, exactly as
 *      `settings/sections.ts` keeps a field's config key private and takes an id back.
 *   3. **The native header's own vocabulary, unchanged.** Every string, every test id and every
 *      truncation rule here is the one `grid/PaneHeader.tsx` already shipped. A descriptor that
 *      reworded a control would be a fidelity regression wearing a refactor's clothes, and the
 *      existing PaneHeader and grid suites are what says so.
 *
 * Phase A introduces no presenter and mounts nothing new: the placement is declared, the model is
 * shared, the band is the host's, and the frame in `projection.ts` is built and bounded but never
 * published. The budgets below are copied forward from `interaction/contract.ts` so phase B adds a
 * presenter rather than a second set of numbers.
 */

import type { IconName } from '../grid/icons';
import type { PaneModel } from '../grid/types';

// ── the placement ───────────────────────────────────────────────────────────────────

/**
 * One placement for every pane kind (ratified decision 1).
 *
 * Per-kind placements would let the header change shape mid-grid: a shell pane drawn by one
 * presenter beside a markdown pane drawn by another, with two answers to how tall a band is and
 * no single frame to bound. The string is a `PLUGIN_PLACEMENTS` entry, so a manifest can declare
 * it; it is deliberately absent from `plugins/Workbench.tsx`'s `ROOT_SLOTS`, so nothing can be
 * selected into it until phase B registers the slot.
 */
export const PANE_CHROME_PLACEMENT = 'pane.chrome';

export type PaneChromePlacement = typeof PANE_CHROME_PLACEMENT;

// ── budgets ─────────────────────────────────────────────────────────────────────────

export const PANE_CHROME_LIMITS = {
    /**
     * The band the native header draws, and the height every pane keeps until something declares
     * otherwise (ratified decision 4). `grid/PaneHeader.tsx`'s `PANE_HEADER_HEIGHT` is the same
     * 24 px stated where it is painted; this is the same number stated where it is clamped, and
     * `contract.test.ts` asserts the two agree.
     */
    nativeHeight: 24,
    /**
     * The absolute ceiling on a DECLARED band, in px.
     *
     * A pane header is chrome over somebody's shell. 96 px is four native bands: enough for the
     * two-line header the audit's example asks for and nowhere near enough to take a terminal's
     * visible lines away from it.
     */
    maxHeight: 96,
    /**
     * The other ceiling: a share of the pane the band sits on.
     *
     * The fixed ceiling alone is not enough, because a 96 px band over a 140 px pane is a pane
     * that is mostly chrome. The notification box makes the same pair of arguments in the other
     * order (`interaction/presenter.ts`'s `notificationBoxHeight`: a window fraction and a
     * per-notice content ceiling), and the smaller of the two wins there too.
     */
    heightFraction: 0.25,
    /**
     * The frame's byte budget (ratified decision 3), the same 256 KiB every other frame is bounded
     * at. `projection.ts` explains why a burst frame is worse than a dropped pane.
     */
    payloadBytes: 256 * 1024,
    /**
     * Headroom inside the budget for the frame's own envelope - the placement, the form factor,
     * the workspace id, the focused pane and the withheld count - so the pane list is measured
     * against what is actually left for it.
     */
    frameMargin: 2 * 1024,
    /**
     * The presenter's call budget, per rolling second. The interaction and Settings numbers
     * verbatim (`settings/contract.ts`, `interaction/contract.ts`), so the four replaceable
     * surfaces cannot come to disagree about what a runaway presenter is.
     *
     * A breach FAILS the placement as well as rejecting the call: a call loop is not a recoverable
     * error, and with pane chrome it is a call loop holding every pane's band.
     */
    presenterCalls: 240,
    presenterCallWindowMs: 1_000,
    /** How long a newly mounted presenter has to report that it has painted. */
    presenterReadyMs: 5_000,
    /** How long it has to acknowledge a frame that moves the user (a pane added, removed or renamed). */
    presenterAckMs: 5_000,
    /**
     * The inset, in px, between a declared band and the presenter's own frame over it.
     *
     * `webpane/WebPageSurface.tsx` insets its page hole by the same 2 px for the same reason: the
     * focus ring is painted on the pane WRAPPER, around the band and the body together, so a
     * presenter frame drawn edge to edge over the band would paint over the ring's top and side
     * runs. The host keeps the band itself (its fill, its hairline and the ring around it) and
     * hands the presenter the rectangle inside the ring.
     */
    frameInset: 2
} as const;

// ── what a pane IS, for chrome's purposes ───────────────────────────────────────────

/** The pane kinds, which are `PaneModel`'s own. A presenter draws all six or none (decision 8). */
export type PaneChromeKind = PaneModel['type'];

export type PaneChromeStatus = PaneModel['status'];

/**
 * A title split so CSS can truncate it in the MIDDLE, which is `splitHeaderTitle`'s answer and
 * stays the host's: a presenter may redraw the title but the SPLIT is a measured behaviour of the
 * native header (§4.2 item 3, M19) and travels with the fact rather than being re-derived.
 */
export interface PaneChromeTitleParts {
    readonly head: string;
    readonly tail: string;
}

/**
 * The working tree's change counts, as the status footer already computes them
 * (`chrome/StatusFooter.tsx`'s `FooterGitStats`).
 *
 * `null` today for every pane, and deliberately so: the native header draws a branch chip and no
 * counts, so a model that invented them would be describing chrome that does not exist. The field
 * is named here because the frame the audit specified carries "branch and change counts" and the
 * host already holds the second half keyed by working directory - phase B fills it from the same
 * associations the footer reads, and the native header is unaffected either way.
 */
export interface PaneChromeChanges {
    readonly changedFiles: number;
    readonly additions: number;
    readonly deletions: number;
}

/** The right-aligned agent badge, as text and a tone (agent-lifecycle.md §5.9 / §9.4). */
export type PaneChromeAgentTone = 'running' | 'waiting';

export interface PaneChromeAgent {
    /** `claude` / `codex`, or null when the pane never recorded one. */
    readonly kind: string | null;
    /** Whole seconds since the agent started, or null when there is no start time to run from. */
    readonly elapsedSeconds: number | null;
    readonly backgroundTasks: number;
    /** What the badge reads, composed by the host: `<kind> · <elapsed> · N running`. */
    readonly text: string;
    readonly tone: PaneChromeAgentTone;
}

export interface PaneChromeZoom {
    readonly zoomed: boolean;
    /** The workspace has more than one pane, so the ZOOM badge means something. */
    readonly available: boolean;
}

export interface PaneChromeSync {
    readonly active: boolean;
    readonly excluded: boolean;
}

/** Which of the three user-data badges this header's width can seat (`PaneHeader`'s `badgeFit`). */
export interface PaneChromeBadgeFit {
    readonly label: boolean;
    readonly agent: boolean;
    readonly branch: boolean;
}

/**
 * The size-control state: what the pane's own width has already decided.
 *
 * §S8 seats the badges and §S40 folds the button tail, both from the pane's measured width, and
 * both are decisions a presenter has to be able to READ rather than re-derive - it cannot measure
 * a header it has not drawn yet, and a presenter that disagreed with the host about which badges
 * fit would disagree about where the buttons start.
 */
export interface PaneChromeSize {
    /** The pane's width in CSS px, or null in a render that has not been measured (jsdom, mount). */
    readonly width: number | null;
    readonly badges: PaneChromeBadgeFit;
    /**
     * What the two ladders charge for: every trailing button the header would draw, the ✕
     * included, PLUS the four button-widths the contributions box is charged (`PaneHeader.tsx`'s
     * `headerExtras ? 4 : 0`) precisely because the host cannot measure what a plugin draws. It is
     * a width budget in button units, not a count of `controls`, and the two differ by that charge.
     */
    readonly buttons: number;
    /** How many of them fold into the `•••` (§S40). The ✕ is never a candidate. */
    readonly folded: number;
}

// ── controls ────────────────────────────────────────────────────────────────────────

/**
 * The host's own trailing controls, by id.
 *
 * These are `PaneHeaderView.swift:177-273`'s row, which the port already draws: the per-type
 * buttons, then split-right, split-down, the globe, and the ✕. The ids are stable strings rather
 * than the `data-testid`s they carry, because a test id names one pane's button and an id names
 * the ACTION - which is what a presenter activates and what `surface.ts` re-resolves.
 *
 * They are the header's OWN existing keys, verbatim, rather than longer names invented for this
 * vocabulary: the `•••` menu publishes a row's key as `data-menu-item`, so a rename here would be
 * a DOM change dressed as a refactor. The same rule the settings catalog follows with its copied
 * labels and test ids.
 */
export const PANE_CHROME_ACTION_IDS = [
    'copy',
    'edit',
    'refresh',
    'split-right',
    'split-down',
    'new-web',
    'close'
] as const;

export type PaneChromeActionID = (typeof PANE_CHROME_ACTION_IDS)[number];

export function isPaneChromeActionID(value: string): value is PaneChromeActionID {
    return (PANE_CHROME_ACTION_IDS as readonly string[]).includes(value);
}

/**
 * Where a control came from.
 *
 * `action` is the host's own; `item` is another plugin's `pane.header` menu command, reaching the
 * model as a descriptor with an opaque ref and no run closure (ratified decision 7). The
 * distinction matters to exactly one reader - `surface.ts`, which re-resolves the two against
 * different tables - and to nobody who draws.
 */
export type PaneChromeControlKind = 'action' | 'item';

export interface PaneChromeControlDescriptor {
    /**
     * The control's identity within its pane: a `PaneChromeActionID` for a host action, the
     * contribution's own id for a plugin one. It is the React key, the `•••` menu row id, and the
     * argument `runControl` takes back.
     */
    readonly key: string;
    readonly kind: PaneChromeControlKind;
    /** The button's accessible name and its tooltip, verbatim from the row it replaced. */
    readonly label: string;
    readonly icon: IconName;
    /** The `data-testid` the button already had, so the audit selectors do not have to learn one. */
    readonly testID: string;
    /** Dimmed and inert, but still in the row: a control that vanishes reflows the header. */
    readonly enabled: boolean;
    /** The ✕, and only the ✕: it is the last control a narrowing pane loses, never the first. */
    readonly pinned: boolean;
}

/**
 * Another plugin's `pane.header` ITEM, as a descriptor (ratified decision 7).
 *
 * Display name, badge, tone, enabled flag and an opaque ref. No `pluginID`, no command name, no
 * run closure - the same projection `interaction/contract.ts` makes of a palette row and
 * `docs/plugin-ui.md`'s owner rule makes of a prompt's owner. The host draws these itself today
 * (`plugins/contributions-ui.tsx`, native controls with bounded widths and plugin text rendered as
 * text), which is why the descriptor exists in phase A only to be carried: it is what a pane chrome
 * presenter will be handed so that replacing the header does not delete another plugin's extension
 * point.
 */
export type PaneChromeItemTone = 'default' | 'info' | 'success' | 'warning' | 'error';

export interface PaneChromeItemDescriptor {
    readonly id: string;
    readonly text: string;
    readonly tooltip: string | null;
    readonly badge: string | null;
    readonly tone: PaneChromeItemTone;
    readonly enabled: boolean;
}

/**
 * The host-drawn box those items sit in.
 *
 * Native by decision, like the rename field and every destructive confirmation: the items are
 * other plugins' text and the host renders it as text, never as HTML, inside a clamped 96 px box
 * it measures itself (`PaneHeader.tsx`'s `pane-contributions-…`). The descriptor names the box and
 * says how many chips are in it; it does not hand the drawing over.
 */
export interface PaneChromeContributions {
    readonly testID: string;
    readonly count: number;
}

// ── the descriptor ──────────────────────────────────────────────────────────────────

/**
 * One pane's chrome, closure-free.
 *
 * Everything the native header draws is in here and nothing else is: no `PaneModel`, no callbacks,
 * no absolute path beyond the home abbreviation, no PTY handle, no agent session id. It is plain
 * JSON by construction - `contract.test.ts` proves it by round-tripping one - which is what lets
 * `projection.ts` measure a frame of them in bytes and phase B put one on the wire.
 */
export interface PaneChromeDescriptor {
    readonly paneID: string;
    readonly kind: PaneChromeKind;
    readonly status: PaneChromeStatus;
    readonly focused: boolean;
    /** The header's path/title string (`paneDisplayTitle`), home-abbreviated where it is a path. */
    readonly title: string;
    readonly titleParts: PaneChromeTitleParts;
    /** The pane's working directory, home-abbreviated. The absolute form never leaves the host. */
    readonly directory: string;
    readonly label: string | null;
    readonly branch: string | null;
    readonly changes: PaneChromeChanges | null;
    readonly agent: PaneChromeAgent | null;
    readonly zoom: PaneChromeZoom;
    readonly sync: PaneChromeSync;
    /** The band this pane is painting at right now, already clamped (`height.ts`). */
    readonly height: number;
    readonly size: PaneChromeSize;
    /** Every trailing control in row order, the ✕ last. `paneChromeRow` splits it at the fold. */
    readonly controls: readonly PaneChromeControlDescriptor[];
    readonly items: readonly PaneChromeItemDescriptor[];
    readonly contributions: PaneChromeContributions | null;
    /** Whether the inline rename field is up. The FIELD is the host's (ratified decision 6). */
    readonly renaming: boolean;
}

// ── pure functions over the vocabulary ──────────────────────────────────────────────

/**
 * The trailing row, split where §S40 folds it.
 *
 * The descriptor carries the row and the fold COUNT rather than three lists, because the count is
 * the size-control state a presenter reads and the split is arithmetic anyone can redo. The ✕ is
 * pulled out by its `pinned` flag rather than by its position, so a future pinned control cannot
 * silently become foldable by being appended after it.
 */
export interface PaneChromeRow {
    readonly inline: readonly PaneChromeControlDescriptor[];
    readonly overflow: readonly PaneChromeControlDescriptor[];
    readonly pinned: readonly PaneChromeControlDescriptor[];
}

export function paneChromeRow(descriptor: PaneChromeDescriptor): PaneChromeRow {
    const foldable = descriptor.controls.filter((control) => !control.pinned);
    const pinned = descriptor.controls.filter((control) => control.pinned);
    const folded = Math.min(Math.max(0, Math.trunc(descriptor.size.folded)), foldable.length);
    const cut = foldable.length - folded;
    return { inline: foldable.slice(0, cut), overflow: foldable.slice(cut), pinned };
}

/**
 * How tall a pane's chrome band is actually painted (ratified decision 4).
 *
 * The notification box's rule, one surface over: **the presenter declares, the host clamps, and
 * the native value applies until something is declared.** `declared === null` therefore returns the
 * native 24 px untouched, without consulting a ceiling at all - which is the difference between
 * this and `notificationBoxHeight`, and it is deliberate. A short pane's ceiling is below 24, so
 * clamping the undeclared default would shrink the bundled header on a pane nobody has asked
 * anything of, and every PTY in a four-way split would resize the moment this function landed.
 *
 * A declared height is clamped to `[0, min(96, 25% of the pane)]`:
 *
 *   - the fixed ceiling keeps a band that is chrome from becoming a band that is the pane;
 *   - the fraction keeps it proportionate, so the same declaration is honoured in full on a tall
 *     pane and cut down on a short one rather than being refused;
 *   - the floor is 0, as the notification box's is, because a presenter drawing nothing should
 *     cost nothing. Phase B's fallback is what returns a pane to 24 px when its presenter dies;
 *     a floor here would instead paint an empty native band under a presenter that meant to draw
 *     none.
 *
 * Every input is treated as hostile, because one of them arrives over a plugin call: NaN and
 * ±Infinity are not heights and fall back to the native band, a negative declaration is 0, and a
 * pane whose measured height is not a finite positive number has no ceiling to compute, so its
 * declaration is refused and the native band stands.
 *
 * `native` is the band the host is painting when nothing is declared. It defaults to the 24 px
 * every pane wears; `grid/PaneGrid.tsx` passes its own `headerHeight` prop instead, so a host (or
 * a test) that has always drawn a different band keeps drawing it.
 */
export function paneChromeHeight(
    declared: number | null,
    paneHeight: number,
    native: number = PANE_CHROME_LIMITS.nativeHeight
): number {
    if (declared === null) return native;
    if (!Number.isFinite(declared)) return native;
    if (!Number.isFinite(paneHeight) || paneHeight <= 0) return native;
    const ceiling = Math.max(
        0,
        Math.min(PANE_CHROME_LIMITS.maxHeight, Math.floor(paneHeight * PANE_CHROME_LIMITS.heightFraction))
    );
    return Math.min(Math.max(0, Math.round(declared)), ceiling);
}

/**
 * Does a band this tall over a pane of this kind have to park the page (ratified decision 5)?
 *
 * Only a web pane has a page to park, and only a band TALLER than the native one can reach where
 * that page currently is. The reasoning is `chrome/modal-presence.ts`'s in miniature: nothing in
 * this document composites above a native `WebContentsView`, so a band drawn into pixels the view
 * still occupies is invisible - and it does still occupy them, for the frames between the header
 * growing and the shell moving the view down. At rest the two boxes are adjacent rather than
 * overlapping (the hole starts where the band ends), so `overlayCovers` stops parking on its own
 * the moment the geometry settles; see `height.ts` for the enrolment and the measurement.
 *
 * **`visible` is not a nicety; without it a hidden pane parks a visible one.** `PaneGrid` never
 * unmounts a pane to hide it (that is its third invariant: a zoomed-out pane, and every pane of a
 * workspace the window is not showing, keeps its DOM at its LAST known rect under
 * `visibility: hidden`). `getBoundingClientRect` still reports that rect, and
 * `chrome/modal-presence.ts` registers boxes rather than elements, so an invisible band would be
 * registered at a real box - and with two web panes declaring a band and one of them zoomed, the
 * hidden one's box lies inside the visible one's page hole and parks it for the length of the
 * zoom. A band nobody can see covers nothing, so it registers nothing.
 */
export function paneChromeParks(
    kind: PaneChromeKind,
    height: number,
    visible: boolean = true
): boolean {
    if (!visible) return false;
    if (kind !== 'web') return false;
    if (!Number.isFinite(height)) return false;
    return height > PANE_CHROME_LIMITS.nativeHeight;
}
