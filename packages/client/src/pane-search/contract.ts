/**
 * What a pane SEARCH is, for a presenter's purposes, and what may be said about one.
 *
 * The sibling of `settings/contract.ts`, `interaction/contract.ts` and `pane-chrome/contract.ts`,
 * written to the same rules: no React, no store, no socket, so every rule here can be asserted
 * without mounting a window; descriptors out and ids in; and the native bar's own vocabulary,
 * unchanged, because a presenter that reworded the counter would be a fidelity regression wearing
 * a refactor's clothes.
 *
 * ── Why the daemon stays the authority ──────────────────────────────────────────────
 *
 * `searchingPaneID`, `searchNeedle`, `searchTotal` and `searchSelected` are WORKSPACE state on the
 * delta stream (`daemon/src/ws/search.ts`), so two windows looking at the same pane read the same
 * "3/17" and closing the bar in one closes it in both. A presenter therefore holds none of it: it
 * asks for changes through calls and reads the answer back in the next frame. That is also why the
 * fallback in `presenter-slot.tsx` can put the NATIVE bar back with the needle intact - the state
 * was never the presenter's to lose.
 *
 * The one search option that is not the daemon's is CASE SENSITIVITY, and it is worth being exact
 * about. `terminal-search` takes `case_sensitive` per request and stores nothing
 * (`daemon/src/ws/search.ts:189`), so there is no workspace field to read it back from. The host
 * holds it per window for the length of one search session and sends it with every request, which
 * means the TOTAL a second window sees is the one this window last published (counts are workspace
 * state) while the toggle itself is local. Stated here rather than papered over: making it
 * workspace state is a daemon reducer, an envelope field and a wire change, none of which this
 * placement needs, and `docs/plugin-ui.md` records it as the one thing two windows can disagree
 * about.
 *
 * ── Shell panes only, in phase one ──────────────────────────────────────────────────
 *
 * The daemon computes counts for a SHELL pane and for nothing else: a markdown or diff preview's
 * find runs inside its own sandboxed frame and a web pane's runs in the host's `webContents`, so
 * for those the daemon publishes `total: null` and the client's own backend counts. A presenter
 * handed a frame it cannot count for would be a presenter drawing "-/-" over somebody's page, so
 * those two keep their native bars and this placement never opens on them.
 */

import type { PaneModel } from '../grid/types';

// ── the placement ───────────────────────────────────────────────────────────────────

/**
 * One placement (ratified decision 1). Phase one covers shell panes only, the only backend whose
 * match counts the daemon owns; markdown and diff previews (iframe counts) and web panes (native
 * `findInPage`, and nothing in the document can float over the page) keep their native bars.
 */
export const PANE_SEARCH_PLACEMENT = 'pane.search';

export type PaneSearchPlacement = typeof PANE_SEARCH_PLACEMENT;

/** The pane kinds this placement can open on. One, in phase one, and it is stated as a type. */
export type PaneSearchKind = Extract<PaneModel['type'], 'shell'>;

export function isPaneSearchKind(kind: PaneModel['type']): kind is PaneSearchKind {
    return kind === 'shell';
}

// ── budgets ─────────────────────────────────────────────────────────────────────────

export const PANE_SEARCH_LIMITS = {
    /**
     * The native bar's own measured box, in CSS px, and the default every search opens at until a
     * presenter declares otherwise (ratified decision 5).
     *
     * `grid/PaneSearchOverlay.tsx` is a `px-1.5 py-1` row of a 160 px content-box field (plus its
     * own `px-2`) and three 22 px buttons separated by `gap-1`: 6 + 8 + 160 + 8 + 4 + 22 + 4 + 22 +
     * 4 + 22 + 6 = **266** wide, and `py-1` around a 26.8 px field = **35** high. Measured on the
     * live window rather than trusted from the arithmetic; `docs/plugin-validation.md` records the
     * measurement and this pair is what it settled on.
     */
    nativeWidth: 266,
    nativeHeight: 35,
    /**
     * The bar's inset from the pane's trailing and top edges - `right-2 top-2` on the wrapper.
     *
     * It is charged TWICE against the pane's width, because the native bar's own ceiling is
     * `calc(100% - 16px)`: its trailing inset mirrored as a leading gutter, so a bar anchored to
     * the trailing edge cannot grow off the leading one (§S16, owner-directed).
     */
    margin: 8,
    /**
     * The absolute ceiling on a DECLARED width, in px.
     *
     * A find bar is chrome over somebody's shell. 480 px is not quite twice the native bar and
     * still leaves a 1,000 px pane more than half its width; wider than that and the bar is the
     * pane rather than a control in its corner.
     */
    maxWidth: 480,
    /**
     * The fixed ceiling on a DECLARED height, and the share of the pane it is also held to.
     *
     * Pane chrome's pair verbatim, and for the same two arguments: 96 px is enough for a two-line
     * bar with a case toggle and a count, and nowhere near enough to take a terminal's visible
     * lines; and 96 px over a 140 px pane is a pane that is mostly find bar, so the same
     * declaration is honoured in full on a tall pane and cut down on a short one rather than
     * refused.
     */
    maxHeight: 96,
    heightFraction: 0.25,
    /**
     * The longest needle the host will carry or accept.
     *
     * The native field enforces no `maxlength`, so this is the limit the SURROUNDING system already
     * has: the palette's query cap (`interaction/contract.ts`), for the same reason - every
     * keystroke is a daemon round trip that flushes a pane's write queue and sweeps up to 10,000
     * lines, and an unbounded needle is an unbounded scan. A call carrying more is refused; a
     * needle already in the daemon's state that is longer (another plugin can set one through
     * `terminal.search`) is carried TRUNCATED with `needleTruncated` set, because an undeliverable
     * frame would fail a presenter for somebody else's string.
     */
    needleChars: 1_024,
    /** The frame's byte budget, the same 256 KiB every other frame is bounded at. */
    payloadBytes: 256 * 1024,
    /**
     * The presenter's call budget, per rolling second. The interaction, Settings and pane chrome
     * numbers verbatim, so the six replaceable surfaces cannot come to disagree about what a
     * runaway presenter is. A breach FAILS the placement as well as rejecting the call.
     */
    presenterCalls: 240,
    presenterCallWindowMs: 1_000,
    /** How long a newly mounted presenter has to report that it has painted. */
    presenterReadyMs: 5_000,
    /**
     * How long it has to acknowledge a frame that OPENS a search session.
     *
     * Only that one. A needle delta moves on every keystroke and a total moves whenever the shell
     * writes another line; holding a presenter to a 5 s deadline for one of those would fail a
     * working presenter for being busy, exactly as the pane chrome watchdog refuses to wait on a
     * divider drag.
     */
    presenterAckMs: 5_000
} as const;

// ── geometry ────────────────────────────────────────────────────────────────────────

/** A rectangle in the pane grid's own coordinate space, origin at the grid's top left. */
export interface PaneSearchRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface PaneSearchSize {
    readonly width: number;
    readonly height: number;
}

/**
 * How big the search box actually is (ratified decision 5).
 *
 * The notification box's rule and pane chrome's, one surface over: **the presenter declares, the
 * host clamps, and the native value applies until something is declared.** `declared === null`
 * returns the native bar's own box, with its WIDTH held to the same `calc(100% - 16px)` ceiling the
 * native bar holds itself to and its height untouched - which is the one deliberate asymmetry.
 * Clamping the undeclared height too would shrink the bundled bar on a short pane that nobody has
 * declared anything for, and the bar nobody declared anything for has to be byte-identical to the
 * one that shipped.
 *
 * A DECLARED box is clamped in both axes:
 *
 *   - width to the smaller of 480 px and the pane's inner width (its own width less the bar's
 *     trailing inset mirrored as a leading gutter);
 *   - height to the smaller of 96 px and a quarter of the pane.
 *
 * Every input is treated as hostile, because one of them arrives over a plugin call: a non-finite
 * declaration is not a size and falls back to the native box, a negative one is 0 (a legal box, and
 * a presenter drawing nothing should cost nothing), and a pane whose measured box is not two finite
 * positive numbers has no ceiling to compute, so its declaration is refused and the native box
 * stands.
 */
export function paneSearchBox(
    declared: PaneSearchSize | null,
    pane: { readonly width: number; readonly height: number }
): PaneSearchSize {
    const native: PaneSearchSize = {
        width: PANE_SEARCH_LIMITS.nativeWidth,
        height: PANE_SEARCH_LIMITS.nativeHeight
    };
    const measured = Number.isFinite(pane.width) && Number.isFinite(pane.height) && pane.width > 0 && pane.height > 0;
    // The native bar's own ceiling, applied whoever is drawing: `maxWidth: calc(100% - 16px)`.
    const room = measured ? Math.max(0, Math.floor(pane.width - PANE_SEARCH_LIMITS.margin * 2)) : null;
    if (declared === null || !measured || room === null) {
        return room === null ? native : { width: Math.min(native.width, room), height: native.height };
    }
    if (!Number.isFinite(declared.width) || !Number.isFinite(declared.height)) {
        return { width: Math.min(native.width, room), height: native.height };
    }
    const widthCeiling = Math.min(PANE_SEARCH_LIMITS.maxWidth, room);
    const heightCeiling = Math.max(
        0,
        Math.min(PANE_SEARCH_LIMITS.maxHeight, Math.floor(pane.height * PANE_SEARCH_LIMITS.heightFraction))
    );
    return {
        width: Math.min(Math.max(0, Math.round(declared.width)), Math.max(0, widthCeiling)),
        height: Math.min(Math.max(0, Math.round(declared.height)), heightCeiling)
    };
}

/**
 * Where that box sits: the searched pane's top-trailing corner, which is where the native bar sits.
 *
 * `grid/PaneSearchOverlay.tsx` is `absolute right-2 top-2` inside the pane WRAPPER, so the bar
 * floats over the header band's trailing end rather than under it - `PaneGridView.swift:356-370`
 * attaches it to the whole pane view, after the frame, for exactly that reason. The rectangle
 * returned here is in the GRID's coordinate space, because the presenter is one frame over the grid
 * (`presenter-slot.tsx`), so the pane's own origin is added in.
 *
 * The leading edge is never crossed: `paneSearchBox` has already held the width to the pane's inner
 * width, and the `max` below is what says so even when a caller passes a box it did not clamp.
 */
export function paneSearchRect(
    pane: PaneSearchRect,
    box: PaneSearchSize,
    margin: number = PANE_SEARCH_LIMITS.margin
): PaneSearchRect {
    const width = Math.max(0, Math.min(box.width, Math.max(0, pane.width - margin * 2)));
    const height = Math.max(0, Math.min(box.height, Math.max(0, pane.height - margin)));
    return {
        x: Math.max(pane.x, pane.x + pane.width - margin - width),
        y: pane.y + margin,
        width,
        height
    };
}

/**
 * The `clip-path` the host applies to the presenter's frame.
 *
 * One subpath, because one search is open at a time (`searchingPaneID` is a single field on the
 * workspace). Everything outside it is removed from paint AND from hit testing, so a click below
 * the bar reaches the terminal under it and a press on a divider reaches the divider - the same
 * property pane chrome's multi-band clip has, with the arithmetic that much simpler. A null
 * rectangle clips to nothing, which is a mounted, attached presenter drawing no pixels: the state
 * a window with no open search is in.
 */
export function paneSearchClipPath(rect: PaneSearchRect | null): string {
    if (rect === null || rect.width <= 0 || rect.height <= 0) return `path('M0 0Z')`;
    const { x, y, width, height } = rect;
    return `path('M${String(x)} ${String(y)}H${String(x + width)}V${String(y + height)}H${String(x)}Z')`;
}

/**
 * Is this a needle the host will accept over a call?
 *
 * A string, within the cap, and with no line separators - the native field is a single-line
 * `<input>`, so a needle with a newline in it is not something the surface it replaces can express,
 * and the daemon would scan for a run that can never match a terminal line.
 */
export function paneSearchNeedle(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    if (value.length > PANE_SEARCH_LIMITS.needleChars) return null;
    // The four line separators JavaScript recognises, by code point rather than as literals: a
    // source file carrying a raw U+2028 is a source file some parsers refuse.
    if ([0x0a, 0x0d, 0x2028, 0x2029].some((code) => value.includes(String.fromCharCode(code)))) return null;
    return value;
}
