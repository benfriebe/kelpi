/**
 * The open search, as the one bounded frame a presenter receives.
 *
 * Field by field, never by spread, for the reason every other projection in this client is written
 * that way: a frame built by copying a host object is a frame that grows whenever the host object
 * does, and the withheld list stops being a promise the moment somebody adds a field upstream.
 * `projection.test.ts` walks the result recursively and asserts that no key outside the declared
 * set is reachable at any depth, which is the machine-checkable half of the same rule.
 *
 * ── What a presenter is told ────────────────────────────────────────────────────────
 *
 * The daemon's state for the searched pane (needle, case sensitivity, total, selected index and
 * where the selected match sits), the pane's id and kind, the form factor, and the rectangle the
 * host has cleared for the bar. That is the whole frame: it is one bar over one pane, not a model
 * of the workspace.
 *
 * ── What is withheld, and why each one ──────────────────────────────────────────────
 *
 *   - **Scrollback contents.** The one thing a find bar is obviously near and the one thing it must
 *     not be handed for free. A presenter that wants the text reads it through `capture(pane, {
 *     scrollback })` under its OWN plugin identity, where it is an auditable call by a named plugin
 *     rather than a standing grant riding in on a UI placement.
 *   - **Every other pane's state.** One search is open at a time and this frame is about that one.
 *     A presenter learns nothing about the panes beside it, which is also why it cannot be used as
 *     a workspace probe.
 *   - **Paths.** Not even home-abbreviated, unlike pane chrome: a find bar draws a needle and a
 *     counter, and there is nothing in it a directory belongs to.
 *   - **Plugin ids, the workspace id, run closures and test ids.** The calls take a pane id the
 *     host re-validates, so nothing else is needed to act, and a `pluginID` in a frame names the
 *     owner of whatever else is in the window.
 *
 * ── Why the needle is truncated rather than refused ─────────────────────────────────
 *
 * A call carrying a needle longer than the cap is refused outright (`presenter.ts`), but the needle
 * already in the daemon's state did not have to arrive through this placement: any plugin can set
 * one with `terminal.search(workspaceID, 'set', { needle })`, and the daemon stores what it is
 * given. An oversized frame is undeliverable and an undeliverable frame fails the placement - which
 * would latch the user's chosen presenter out over somebody else's string. So the frame carries the
 * first `needleChars` characters and says `needleTruncated`, exactly as pane chrome's frame carries
 * a prefix of the workspace and counts the rest.
 */

import { PANE_SEARCH_LIMITS, type PaneSearchKind, type PaneSearchPlacement, type PaneSearchRect } from './contract';

/** Where the selected match sits, as `TerminalSearch` states it (`plugin-sdk/domain.d.ts`). */
export interface PaneSearchMatch {
    /** The absolute buffer line, as the daemon numbers it, or null when it stated none. */
    readonly line: number | null;
    readonly col: number;
    readonly length: number;
    /**
     * How far above the buffer's bottom the match is.
     *
     * The daemon reports this rather than an absolute row because a client's scrollback depth need
     * not be the daemon's, and an absolute row would scroll a window to the wrong line.
     */
    readonly linesFromBottom: number;
}

/** The host's own view of the open session, before it is projected. */
export interface PaneSearchSession {
    readonly paneID: string;
    readonly kind: PaneSearchKind;
    readonly needle: string;
    readonly caseSensitive: boolean;
    readonly total: number | null;
    readonly selected: number | null;
    readonly match: PaneSearchMatch | null;
}

export interface PaneSearchFrame {
    readonly placement: PaneSearchPlacement;
    /** Desktop only in this release; a phone window keeps the native bar (decision 9). */
    readonly formFactor: 'desktop' | 'phone';
    /**
     * A search is open on a pane this presenter may draw for, and the host is painting it.
     *
     * False means present nothing, and every mutating call is refused while it is false: no search
     * is open, the window is showing another workspace, the grid is gone, or the native bar has the
     * box back.
     */
    readonly visible: boolean;
    /** The searched pane, or null while nothing is being searched. */
    readonly paneID: string | null;
    readonly kind: PaneSearchKind | null;
    /** The daemon's needle, at most `PANE_SEARCH_LIMITS.needleChars` characters. */
    readonly needle: string;
    /** The daemon's needle was longer than the cap and this frame carries a prefix of it. */
    readonly needleTruncated: boolean;
    /** The host's case flag for this session. See `contract.ts` on why it is not the daemon's. */
    readonly caseSensitive: boolean;
    /** The daemon's match count, or null before it has counted anything. */
    readonly total: number | null;
    /** 0-based index of the selected match, or null before one is selected (the `-/N` state). */
    readonly selected: number | null;
    readonly match: PaneSearchMatch | null;
    /**
     * The rectangle the bar may occupy, in the presenter frame's own coordinate space (the grid's,
     * origin at its top left), already clamped. Null when nothing is open or the grid has not
     * measured itself yet.
     */
    readonly box: PaneSearchRect | null;
}

export interface PaneSearchProjectionInput {
    readonly formFactor: 'desktop' | 'phone';
    readonly visible: boolean;
    readonly session: PaneSearchSession | null;
    readonly rect: PaneSearchRect | null;
}

export interface PaneSearchProjection {
    readonly frame: PaneSearchFrame;
}

/** A finite integer, or null. Everything that reaches a frame is checked, counters included. */
function count(value: number | null): number | null {
    if (value === null) return null;
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
}

function rect(value: PaneSearchRect | null): PaneSearchRect | null {
    if (value === null) return null;
    if (![value.x, value.y, value.width, value.height].every((part) => Number.isFinite(part))) return null;
    return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function match(value: PaneSearchMatch | null): PaneSearchMatch | null {
    if (value === null) return null;
    if (![value.col, value.length, value.linesFromBottom].every((part) => Number.isFinite(part))) {
        return null;
    }
    return {
        line: value.line === null || !Number.isFinite(value.line) ? null : Math.trunc(value.line),
        col: Math.trunc(value.col),
        length: Math.trunc(value.length),
        linesFromBottom: Math.trunc(value.linesFromBottom)
    };
}

export const PANE_SEARCH_FRAME_BUDGET = PANE_SEARCH_LIMITS.payloadBytes;

/** The frame's size on the wire, for the bound's own tests. */
export function paneSearchBytes(frame: PaneSearchFrame): number {
    return new TextEncoder().encode(JSON.stringify(frame)).length;
}

export function projectPaneSearch(input: PaneSearchProjectionInput): PaneSearchProjection {
    const { session } = input;
    if (session === null) {
        return {
            frame: {
                placement: 'pane.search',
                formFactor: input.formFactor,
                // No open search is "present nothing" whatever the host's own paint decision was.
                visible: false,
                paneID: null,
                kind: null,
                needle: '',
                needleTruncated: false,
                caseSensitive: false,
                total: null,
                selected: null,
                match: null,
                box: null
            }
        };
    }
    const truncated = session.needle.length > PANE_SEARCH_LIMITS.needleChars;
    const total = count(session.total);
    const selected = count(session.selected);
    return {
        frame: {
            placement: 'pane.search',
            formFactor: input.formFactor,
            visible: input.visible,
            paneID: session.paneID,
            kind: session.kind,
            needle: truncated ? session.needle.slice(0, PANE_SEARCH_LIMITS.needleChars) : session.needle,
            needleTruncated: truncated,
            caseSensitive: session.caseSensitive === true,
            total,
            /*
             * A selection with no total behind it cannot be drawn honestly.
             *
             * The daemon drops the selection when the total goes to zero (`ws/search.ts`), so
             * "3/0" is not a state it can publish; this is the same rule stated where the frame is
             * built, so a presenter never has to invent a counter for a pair that cannot happen.
             */
            selected: total === null || total === 0 ? null : selected,
            match: match(session.match),
            box: rect(input.rect)
        }
    };
}
