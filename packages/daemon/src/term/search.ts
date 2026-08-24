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
 *    reason (`service.ts` `readRegion`). Every row is read bounded to the GRID
 *    (`min(cols, line.length)`) and joined as the text it actually produced; each row's start
 *    offset in the join is recorded as it goes (`LogicalLine.rows`), and a match offset maps
 *    back to a buffer row through that map. Not by `floor(offset / cols)`: under `NO_REFLOW`
 *    (`service.ts`) a column shrink leaves rows WIDER than the grid and a widen leaves them
 *    narrower, so "every row contributed exactly `cols` characters" is false in both
 *    directions — the division walked a match onto a row its own logical line never touched,
 *    and the `% cols` pad that propped it up injected spaces that were never on the screen (a
 *    needle spanning a stale wrap could then not match at all). The bound matters just as
 *    much: cells a shrink stranded past the grid are unreachable by any program and drawn by
 *    no renderer, so a match inside one is a counter that reveals nothing.
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

/** One buffer row's contribution to a logical line: which row, and where its text begins. */
export interface LogicalRow {
    /** Buffer row index, counted from the top of the scrollback. */
    readonly line: number;
    /** Offset in the logical line's `text` at which this row's characters start. */
    readonly offset: number;
}

/** A logical (wrap-joined) line plus where it started and which rows built it. */
export interface LogicalLine {
    readonly text: string;
    readonly startLine: number;
    /**
     * Grid width the rows were bounded to when they were read. Informational: match positions
     * come from `rows`, never from arithmetic over this (see the header).
     */
    readonly cols: number;
    /** Every row that contributed, in buffer order — the map a match offset resolves through. */
    readonly rows: readonly LogicalRow[];
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
 *
 * Each row is read bounded to the grid and appended as-is; the offset it landed at is recorded
 * in `rows`, so nothing downstream has to assume a row is `cols` characters wide (see the
 * header for why that assumption is false in both resize directions).
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
    let rows: LogicalRow[] = [];
    for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        // The GRID, never the row's allocation: a column shrink leaves rows wider than the
        // grid under `NO_REFLOW`, and those cells are unreachable and undrawn.
        const rowText = line === undefined ? '' : line.translateToString(true, 0, Math.min(cols, line.length));
        if (text !== null && line?.isWrapped === true) {
            // A continued row: it starts exactly where the text built so far ends. No pad —
            // the join is the characters the rows actually produced.
            rows.push({ line: y, offset: text.length });
            text += rowText;
            continue;
        }
        if (text !== null) lines.push({ text, startLine, cols, rows });
        startLine = y;
        rows = [{ line: y, offset: 0 }];
        text = rowText;
    }
    if (text !== null) lines.push({ text, startLine, cols, rows });
    return lines;
}

/**
 * Which buffer row an offset into a logical line lands on, and the column inside that row.
 *
 * A binary search over the row map `collectLogicalLines` built from the text it actually
 * produced. An empty map (a hand-built line) degrades to the line's own start.
 */
function locate(line: LogicalLine, offset: number): { line: number; col: number } {
    const rows = line.rows;
    let lo = 0;
    let hi = rows.length - 1;
    let found: LogicalRow | undefined;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const row = rows[mid];
        if (row === undefined) break;
        if (row.offset <= offset) {
            found = row;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (found === undefined) return { line: line.startLine, col: offset };
    return { line: found.line, col: offset - found.offset };
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
            const where = locate(line, at);
            matches.push({
                line: where.line,
                col: where.col,
                length: needle.length,
                linesFromBottom: options.bufferLength - where.line
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
