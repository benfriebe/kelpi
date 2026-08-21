/**
 * The line-number gutter's model — a port of `LineNumberRulerView`'s cache
 * (content-panes.md §4.2, `LineNumberRulerView.swift:41-84,136-161`).
 *
 * The Swift ruler does three things that are cheap for a reason, and the port used to do none
 * of them: it keeps a **cached array of line starts** rebuilt only when the text changes, it
 * answers "which line is this character on" with a **binary search** rather than a scan, and it
 * draws numbers **only for the visible rect** rather than for the whole document. Without them
 * a 200k-line buffer recounts every newline on every keystroke and materializes one DOM node
 * per line; with them the per-scroll cost is a binary search and a slice.
 *
 * The port keeps the Swift shape rather than inventing pixel-only arithmetic: `AppKit` hands
 * the ruler a visible CHARACTER RANGE, so the window resolver here also goes
 * rect → character offset → `lineNumberAt`. With uniform rows the first step is arithmetic,
 * and the binary search is what keeps the answer anchored to the document — including a
 * `scrollTop` past the end of the text, which rounds to a row that does not exist.
 *
 * Everything here is pure and framework-free so it can be tested without a DOM.
 */

/**
 * Offsets of every line's first character, Swift's `lineStarts`: always begins with 0, so its
 * length IS the line count (`\n` count + 1 — a trailing newline opens one more line, an empty
 * document has one).
 */
export function lineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === '\n') starts.push(index + 1);
    }
    return starts;
}

/**
 * The 1-based number of the line containing `charIndex` — Swift's `lineNumber(for:)`, the same
 * upper-bound binary search (O(log n), not a scan from the top of the buffer).
 */
export function lineNumberAt(starts: readonly number[], charIndex: number): number {
    let low = 0;
    let high = starts.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if ((starts[mid] as number) <= charIndex) low = mid + 1;
        else high = mid;
    }
    // `starts[0] === 0`, so `low` has already overshot by one: it is the 1-based number.
    return Math.max(1, low);
}

/**
 * The cache itself: one slot, keyed on the buffer's identity.
 *
 * A React re-render that did not change the text (a scroll, a focus, a prop change on a sibling)
 * must not rescan the buffer, which is exactly what `invalidateLineCount` buys the Swift ruler.
 * One slot is enough because a keystroke replaces the previous buffer outright, and holding
 * more would keep dead documents alive.
 */
let cachedText: string | null = null;
let cachedStarts: number[] = [0];

export function cachedLineStarts(text: string): number[] {
    if (cachedText === text) return cachedStarts;
    cachedText = text;
    cachedStarts = lineStarts(text);
    return cachedStarts;
}

/** Test seam: forget the cached buffer (nothing in the app needs to). */
export function resetLineStartCache(): void {
    cachedText = null;
    cachedStarts = [0];
}

/** 1-based, inclusive; `first === last` is a one-line window. */
export interface LineWindow {
    readonly first: number;
    readonly last: number;
}

export interface LineWindowInput {
    readonly starts: readonly number[];
    readonly scrollTop: number;
    /** The textarea's `clientHeight`. 0 (jsdom, pre-measure) means "draw everything". */
    readonly viewportHeight: number;
    readonly lineHeight: number;
    /** The editor's top padding: the first row does not start at y = 0. */
    readonly paddingTop: number;
    /** Rows drawn beyond each edge so a fast scroll never shows a gap. */
    readonly overscan?: number;
}

export const DEFAULT_GUTTER_OVERSCAN = 8;

/**
 * Which line numbers the gutter must draw for the current scroll position.
 *
 * An unmeasured viewport (height 0 — jsdom, and the first paint before layout) returns the
 * WHOLE document: a gutter that guessed a window before it knew its own height would draw the
 * wrong rows, and a short document costs nothing to draw in full.
 */
export function visibleLineWindow(input: LineWindowInput): LineWindow {
    const count = Math.max(1, input.starts.length);
    if (input.viewportHeight <= 0 || input.lineHeight <= 0) return { first: 1, last: count };

    const overscan = input.overscan ?? DEFAULT_GUTTER_OVERSCAN;
    const row = Math.floor((input.scrollTop - input.paddingTop) / input.lineHeight);
    const clamped = Math.min(Math.max(row, 0), count - 1);
    // rect → character offset → binary search, the Swift pipeline (see the module header).
    const topLine = lineNumberAt(input.starts, input.starts[clamped] as number);
    const visibleRows = Math.ceil(input.viewportHeight / input.lineHeight);
    return {
        first: Math.max(1, topLine - overscan),
        last: Math.min(count, topLine + visibleRows + overscan)
    };
}
