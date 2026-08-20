/**
 * Scrollback search over a pane's server-side terminal buffer.
 *
 * The Swift app pushed the needle straight into libghostty (`search:<needle>` /
 * `navigate_search:next`) and read the counts back out of the surface
 * (`WorkspaceFeature.swift:1742-1835`, `GhosttyApp.swift:294-352`). Neither renderer this port
 * can ship has that: `TerminalRenderer` is coded to the xterm.js API surface and exposes no
 * find (`client/src/terminal/renderer.ts`). So search moves to the side of the wire that
 * already holds the whole scrollback — the `@xterm/headless` buffer behind
 * `TerminalStateService` — and the client becomes a viewer of the daemon's answer.
 *
 * That is strictly better for a multi-client daemon: one buffer, one match list, identical
 * counts in every attached window, and search works for a pane whose renderer was evicted by
 * the mount cap.
 *
 * Two details of the buffer read matter:
 *
 *  - **Soft wraps are re-joined before matching.** A needle straddling the wrap point of a
 *    long command line is a real match and `capture()` already joins wrapped rows for the same
 *    reason (`service.ts` `readRegion`). Rows are joined at FULL width (`translateToString(false)`)
 *    for every row but the last of a logical line, so an offset inside the joined string maps
 *    back to a buffer row by integer division: `row = start + floor(offset / cols)`.
 *  - **Match positions are reported from the BOTTOM of the buffer**, not the top. The client's
 *    renderer has its own scrollback (ghostty-web's is bounded in BYTES, xterm.js's in lines,
 *    and a fresh client replays a possibly-capped snapshot), so absolute line indices do not
 *    survive the crossing. What both sides agree on is the bottom: `linesFromBottom =
 *    bufferLength - line` is stable, and each engine's adapter turns it back into its own
 *    viewport coordinates.
 *
 * Known limits, stated honestly: a double-width cell (CJK, some emoji) counts as one character
 * here and two cells in the renderer, so a match to the right of one on the same row can land a
 * column or two off; and a needle that spans the boundary between the alternate screen and the
 * scrollback cannot match, because the alternate screen has no scrollback to span into.
 */

import type { Terminal as HeadlessTerminal } from '@xterm/headless';

/** One match, in buffer coordinates. `line` counts from the top of the scrollback. */
export interface TerminalMatch {
    readonly line: number;
    readonly col: number;
    readonly length: number;
    /** `bufferLength - line`: the position the client can actually resolve (see the header). */
    readonly linesFromBottom: number;
}

/** A logical (wrap-joined) line plus where it started and how wide its rows are. */
export interface LogicalLine {
    readonly text: string;
    readonly startLine: number;
    readonly cols: number;
}

/**
 * How many matches a single search may return. A needle like `e` against 10 000 lines of
 * scrollback is otherwise a multi-megabyte reply for a counter nobody reads past the total.
 * The total reported is the number of matches FOUND, so it is never a lie about the cap being
 * hit — it is simply not more than this.
 */
export const MAX_TERMINAL_MATCHES = 5000;

/**
 * Walk the active buffer, joining soft-wrapped rows into logical lines.
 *
 * `includeScrollback: false` reads only the viewport, which is what a search over an
 * alternate-screen app (vim, less) should see — that buffer has no history anyway.
 */
export function collectLogicalLines(
    term: Pick<HeadlessTerminal, 'buffer' | 'rows' | 'cols'>,
    includeScrollback = true
): LogicalLine[] {
    const buffer = term.buffer.active;
    const cols = Math.max(1, term.cols);
    const start = includeScrollback ? 0 : Math.max(0, buffer.baseY);
    const end = includeScrollback
        ? buffer.length
        : Math.min(buffer.length, buffer.baseY + term.rows);

    const lines: LogicalLine[] = [];
    let text: string | null = null;
    let startLine = start;
    for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        const wrapped = line?.isWrapped === true;
        if (text !== null && wrapped) {
            // A continued row: the PREVIOUS row was full width, so pad the accumulated text
            // back out to a multiple of `cols` before appending. (`translateToString(true)`
            // trimmed it; re-reading untrimmed is not possible once appended.)
            const short = text.length % cols;
            if (short !== 0) text += ' '.repeat(cols - short);
            text += line === undefined ? '' : line.translateToString(true);
            continue;
        }
        if (text !== null) lines.push({ text, startLine, cols });
        startLine = y;
        text = line === undefined ? '' : line.translateToString(true);
    }
    if (text !== null) lines.push({ text, startLine, cols });
    return lines;
}

/**
 * Every occurrence of `needle`, in buffer order (top → bottom, left → right).
 *
 * Case-insensitive by default — the Swift overlay drove ghostty's own search, which is
 * case-insensitive for a lowercase needle; a plain find bar that is case-sensitive by surprise
 * is the more astonishing of the two, so insensitivity is the default here and `caseSensitive`
 * is the opt-in.
 */
export function findMatches(
    lines: readonly LogicalLine[],
    needle: string,
    options: { caseSensitive?: boolean | undefined; bufferLength: number; limit?: number | undefined }
): TerminalMatch[] {
    const matches: TerminalMatch[] = [];
    if (needle.length === 0) return matches;
    const caseSensitive = options.caseSensitive === true;
    const target = caseSensitive ? needle : needle.toLowerCase();
    const limit = options.limit ?? MAX_TERMINAL_MATCHES;

    for (const line of lines) {
        const haystack = caseSensitive ? line.text : line.text.toLowerCase();
        let from = 0;
        for (;;) {
            const at = haystack.indexOf(target, from);
            if (at < 0) break;
            const row = line.startLine + Math.floor(at / line.cols);
            matches.push({
                line: row,
                col: at % line.cols,
                length: needle.length,
                linesFromBottom: options.bufferLength - row
            });
            if (matches.length >= limit) return matches;
            // Overlapping occurrences count separately ("aa" in "aaa" is two matches), which is
            // what every find bar does.
            from = at + 1;
        }
    }
    return matches;
}

/** The number of lines in the pane's active buffer — the anchor `linesFromBottom` is taken from. */
export function bufferLength(term: Pick<HeadlessTerminal, 'buffer'>): number {
    return term.buffer.active.length;
}

export interface SearchOptions {
    readonly caseSensitive?: boolean | undefined;
    readonly scrollback?: boolean | undefined;
    readonly limit?: number | undefined;
}

/** `collectLogicalLines` + `findMatches` over one terminal. */
export function searchTerminal(
    term: Pick<HeadlessTerminal, 'buffer' | 'rows' | 'cols'>,
    needle: string,
    options: SearchOptions = {}
): TerminalMatch[] {
    if (needle.length === 0) return [];
    const lines = collectLogicalLines(term, options.scrollback !== false);
    return findMatches(lines, needle, {
        caseSensitive: options.caseSensitive,
        bufferLength: bufferLength(term),
        limit: options.limit
    });
}
