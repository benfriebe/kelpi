/**
 * The hover underline over a terminal link (#303).
 *
 * A ⌘-click is a daemon round trip (`open-terminal-target`, `daemon/src/ws/desktop.ts`): the
 * daemon reads its own buffer and decides whether the cell is an http(s) link, an OSC 8 link or
 * an existing `.md` path, and refuses everything else. The engine's own link detection used to
 * underline on different rules (any scheme, half of a wrapped URL, never a path), so the hover
 * promised links the click then refused. This asks the daemon the click's question instead
 * (`probe-terminal-target`) and underlines exactly the cells the answer names.
 *
 * Pure state, no DOM: the pane feeds it the hovered cell and tells it when the screen changed,
 * and it decides when to ask and what to paint.
 *
 *   - **One question at a time.** A probe for the cell under the pointer; if the pointer moves
 *     on while it is out, the cell it is on when the answer lands is asked about next, and every
 *     cell crossed in between is skipped.
 *   - **No question it already has the answer to.** A cell inside the underline on screen is the
 *     same link (so is the cell that was asked about, even where the answer trimmed it off, like
 *     the full stop after a URL), and a cell the daemon said is not a link stays one while its row
 *     reads the same, for a couple of seconds (`missMs`): a `.md` path an agent has just written
 *     becomes a link without its row changing.
 *   - **Output that does not touch the rows it is looking at changes nothing.** An agent's pane
 *     prints several times a second (a spinner, a timer); asking again on every frame would be a
 *     round trip per frame for an answer that cannot have changed. So `snapshot` reads the text
 *     of the hovered row and the underlined rows, and only a change there counts.
 *   - **A change there takes the underline down and asks again.** An underline left on rows
 *     whose text moved is drawn under the wrong text. The comparison runs a moment after the
 *     output arrives (`checkMs`), because the engine may parse it a beat later (a mount flush or
 *     a replay is fed in chunks), and a burst of output is one comparison, not one per frame.
 *   - **Leaving clears at once.** Off the link, off the grid, a scroll or a resize.
 */

import type { TerminalCellRun } from './renderer';

export interface LinkHoverCell {
    readonly row: number;
    readonly col: number;
}

export interface LinkHoverOptions {
    /** What a ⌘-click at this cell would open, as the cells to underline; null for nothing. */
    probe(row: number, col: number): Promise<readonly TerminalCellRun[] | null>;
    /** Draw the underline, or clear it (`null`). */
    paint(cells: readonly TerminalCellRun[] | null): void;
    /**
     * The text of these viewport rows as the pane shows them now, as one string to compare, or
     * null when it cannot be read. Without it every output frame counts as a change.
     */
    snapshot?(rows: readonly number[]): string | null;
    /** How long after output the watched rows are compared (see the module comment). */
    readonly checkMs?: number | undefined;
    /** How long a "not a link" answer is trusted while its row reads the same. */
    readonly missMs?: number | undefined;
    /** The clock for `missMs`, injectable for tests. */
    readonly now?: (() => number) | undefined;
    /** `setTimeout`, injectable for tests. Returns the cancel. */
    readonly schedule?: ((run: () => void, ms: number) => () => void) | undefined;
}

export interface LinkHover {
    /** The pointer is over this cell, or not over the grid at all (`null`). */
    hover(cell: LinkHoverCell | null): void;
    /** The screen changed (output, a replay). */
    contentChanged(): void;
    /** Forget everything and take the underline down (leave, scroll, resize, hidden). */
    clear(): void;
    dispose(): void;
}

/** Two frames: long enough for the engine to have parsed the output, short enough to be unseen. */
export const LINK_HOVER_CHECK_MS = 32;

/** Long enough that a sweep across prose asks each cell once, short enough to catch a new file. */
export const LINK_HOVER_MISS_MS = 2_000;

const keyOf = (cell: LinkHoverCell): string => `${String(cell.row)}:${String(cell.col)}`;

function covers(cells: readonly TerminalCellRun[] | null, cell: LinkHoverCell): boolean {
    if (cells === null) return false;
    return cells.some((run) => run.row === cell.row && cell.col >= run.col && cell.col < run.col + run.width);
}

function sameCells(a: readonly TerminalCellRun[] | null, b: readonly TerminalCellRun[] | null): boolean {
    if (a === null || b === null) return a === b;
    return (
        a.length === b.length &&
        a.every((run, index) => {
            const other = b[index] as TerminalCellRun;
            return run.row === other.row && run.col === other.col && run.width === other.width;
        })
    );
}

/**
 * The `span` of a `probe-terminal-target` reply, or null (#303). Anything malformed, including
 * a reply from a daemon that predates the verb (an error, no span), reads as "no link".
 */
export function linkSpanFromReply(reply: unknown): readonly TerminalCellRun[] | null {
    if (typeof reply !== 'object' || reply === null) return null;
    const record = reply as Record<string, unknown>;
    if (record['ok'] !== true || !Array.isArray(record['span'])) return null;
    const runs: TerminalCellRun[] = [];
    for (const run of record['span'] as unknown[]) {
        if (typeof run !== 'object' || run === null) return null;
        const { row, col, width } = run as Record<string, unknown>;
        if (!Number.isInteger(row) || !Number.isInteger(col) || !Number.isInteger(width)) return null;
        if ((row as number) < 0 || (col as number) < 0 || (width as number) <= 0) return null;
        runs.push({ row: row as number, col: col as number, width: width as number });
    }
    return runs.length === 0 ? null : runs;
}

const defaultSchedule = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

export function createLinkHover(options: LinkHoverOptions): LinkHover {
    const schedule = options.schedule ?? defaultSchedule;
    const checkMs = options.checkMs ?? LINK_HOVER_CHECK_MS;
    const missMs = options.missMs ?? LINK_HOVER_MISS_MS;
    const now = options.now ?? Date.now;
    const read = (rows: readonly number[]): string | null => options.snapshot?.(rows) ?? null;

    let cell: LinkHoverCell | null = null;
    let shown: readonly TerminalCellRun[] | null = null;
    /** The cell whose answer is `shown`: on the link even if the answer trimmed it off. */
    let shownFor: string | null = null;
    /** Cells the daemon said hold no link, with their row's key and when it said so. */
    const misses = new Map<string, { readonly key: string | null; readonly at: number }>();
    /** The rows the current answer depends on (the hovered row and the underlined rows). */
    let watched: { readonly rows: readonly number[]; readonly text: string | null } | null = null;
    let inFlight = false;
    /** Bumped by `clear`: an answer from before it is never painted. */
    let generation = 0;
    let cancelCheck: (() => void) | null = null;
    let disposed = false;

    const show = (cells: readonly TerminalCellRun[] | null, anchor: string | null = null): void => {
        const next = cells === null || cells.length === 0 ? null : cells;
        shownFor = next === null ? null : anchor;
        if (sameCells(shown, next)) return;
        shown = next;
        options.paint(next);
    };

    /** Is this cell on the link that is underlined now? */
    const onShown = (target: LinkHoverCell): boolean => covers(shown, target) || (shown !== null && shownFor === keyOf(target));

    /** A remembered "not a link" holds while its row reads as it did, for `missMs`. */
    const isMiss = (target: LinkHoverCell): boolean => {
        const miss = misses.get(keyOf(target));
        if (miss === undefined) return false;
        if (now() - miss.at < missMs && (miss.key === null || read([target.row]) === miss.key)) return true;
        misses.delete(keyOf(target));
        return false;
    };

    /** Have the rows the current answer rests on changed since it was given? */
    const moved = (): boolean => watched === null || watched.text === null || read(watched.rows) !== watched.text;

    const watch = (target: LinkHoverCell): void => {
        const rows = [...new Set([target.row, ...(shown ?? []).map((run) => run.row)])];
        watched = { rows, text: read(rows) };
    };

    const ask = (): void => {
        if (disposed || cell === null || inFlight) return;
        const target = cell;
        const asked = generation;
        const before = read([target.row]);
        inFlight = true;
        options
            .probe(target.row, target.col)
            .catch(() => null)
            .then((cells) => {
                inFlight = false;
                if (disposed) return;
                const current = cell;
                if (asked !== generation) {
                    // Cleared while out: the answer is void, but a pointer that came back needs one.
                    if (current !== null && !onShown(current) && !isMiss(current)) ask();
                    return;
                }
                // The row changed while the question was out, so the answer may be about text
                // that is gone. Ask again once the output settles rather than paint it.
                if (before !== null && read([target.row]) !== before) {
                    show(null);
                    watched = null;
                    scheduleCheck();
                    return;
                }
                const answer = cells === null || cells.length === 0 ? null : cells;
                if (answer === null) misses.set(keyOf(target), { key: before, at: now() });
                if (current === null) return;
                // Painted only while the pointer is still on what was asked about: on the cell
                // itself, or anywhere on the link the answer names.
                if (keyOf(current) === keyOf(target) || covers(answer, current)) {
                    show(answer, keyOf(target));
                    watch(current);
                    return;
                }
                if (onShown(current)) return;
                if (isMiss(current)) watch(current);
                else ask();
            });
    };

    /**
     * Did output move what the answer rested on? Nothing it does not watch counts. A change takes
     * the underline down and asks again; an answer still out checks its own row when it lands.
     */
    const check = (): void => {
        if (disposed || cell === null || inFlight) return;
        if (!moved()) return;
        show(null);
        watched = null;
        misses.delete(keyOf(cell));
        ask();
    };

    const scheduleCheck = (): void => {
        if (cancelCheck !== null) return;
        cancelCheck = schedule(() => {
            cancelCheck = null;
            check();
        }, checkMs);
    };

    return {
        hover(next): void {
            if (disposed) return;
            if (next === null) {
                cell = null;
                watched = null;
                show(null);
                return;
            }
            if (cell !== null && keyOf(cell) === keyOf(next)) return;
            cell = next;
            if (onShown(next)) {
                // Along the same link: nothing to ask, unless what it rests on moved without
                // anyone saying so, in which case it is not trusted for this cell either.
                if (!moved()) return;
                misses.delete(keyOf(next));
            }
            show(null);
            watched = null;
            if (isMiss(next)) {
                watch(next);
                return;
            }
            ask();
        },
        contentChanged(): void {
            if (disposed || cell === null) return;
            scheduleCheck();
        },
        clear(): void {
            if (disposed) return;
            generation += 1;
            cell = null;
            watched = null;
            misses.clear();
            cancelCheck?.();
            cancelCheck = null;
            show(null);
        },
        dispose(): void {
            if (disposed) return;
            this.clear();
            disposed = true;
        }
    };
}
