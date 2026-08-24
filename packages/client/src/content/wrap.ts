/**
 * §M60 — per-line wrapped heights for the line-number gutter.
 *
 * `MarkdownEditorView.swift:38-40` lets the text container track the view's width, so a markdown
 * buffer soft-wraps; `LineNumberRulerView.swift:88-133` then draws each logical line's number at
 * `layoutManager.lineFragmentRect(forGlyphAt:)` — its FIRST fragment — so a wrapped line is one
 * number beside its first visual row and every number below it stays on the line it names. The
 * port's gutter emitted one node per logical line at a FIXED pitch, which is exact only while
 * nothing wraps: after M29 turned wrapping on for the markdown editor, every wrapped line shifted
 * the whole column below it by a row (`run-R/21-markdown-edit-toggle-edit.png` — `12` beside line
 * 11).
 *
 * A `<textarea>` exposes no equivalent of `NSLayoutManager`, so the heights are MEASURED, in a
 * hidden node styled to the textarea's content box — the standard textarea-mirror technique.
 * What keeps that affordable, and keeps `CONT-078`'s bounded node count intact:
 *
 *   - a **cheap refusal**: a plain-ASCII line narrower than the content box cannot wrap, so it
 *     costs one comparison and never touches the DOM. Only lines that *might* wrap are measured;
 *   - a **cache keyed by (text, content width)**: an edit changes one line's text, so only that
 *     line is re-measured; a resize changes the width, which drops the whole cache;
 *   - **prefix sums** over the per-line row counts, so the window's first line and its
 *     `padding-top` are a binary search and a lookup rather than a walk.
 *
 * Everything here is pure except the two clearly-named DOM helpers at the bottom, so the model
 * can be tested without a browser.
 */

import { DEFAULT_GUTTER_OVERSCAN, lineNumberAt, type LineWindow } from './gutter';

/** How many visual rows one logical line occupies at the cached width. */
export type RowMeasure = (text: string) => number;

export interface WrapMetrics {
    /** The content-box width these rows were measured at; a change invalidates all of them. */
    readonly width: number;
    /** Visual rows per LOGICAL line, index-aligned with the buffer's lines. */
    readonly rows: readonly number[];
    /** Prefix sums in ROWS: `offsets[i]` is the first visual row of line `i + 1`. */
    readonly offsets: readonly number[];
}

export interface WrapCache {
    width: number;
    charWidth: number;
    /** text → rows, valid only for the current `width` / `charWidth`. */
    readonly rows: Map<string, number>;
}

/**
 * A ceiling on the cache, so a 200k-line document of long lines cannot pin a copy of the whole
 * buffer in a Map. Dropping the lot is fine: the next pass re-measures, and the lines that
 * actually matter are the ones in and above the window.
 */
export const MAX_CACHED_LINES = 4096;

export function createWrapCache(): WrapCache {
    return { width: -1, charWidth: -1, rows: new Map<string, number>() };
}

/**
 * The buffer's logical lines, matching `gutter.ts`'s `lineStarts` exactly: a trailing newline
 * opens one more (empty) line, and an empty document is one line.
 */
export function splitLines(text: string): string[] {
    return text.split('\n');
}

/**
 * True when the line is narrow enough that it CANNOT wrap, so measuring it would be waste.
 *
 * Deliberately conservative in both directions: only plain printable ASCII counts (a CJK glyph or
 * an emoji is wider than the monospace advance, a combining mark narrower), and the line must fit
 * with one character of slack, because `charWidth` is itself a measurement.
 */
export function cannotWrap(text: string, width: number, charWidth: number): boolean {
    if (text.length === 0) return true;
    if (!(charWidth > 0) || !(width > 0)) return false;
    if (text.length * charWidth > width - charWidth) return false;
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        // A tab is printable but not one advance wide (`tab-size: 4`), so it disqualifies too.
        if (code < 0x20 || code > 0x7e) return false;
    }
    return true;
}

/** Prefix sums, `[0, …, total]` — one longer than `rows`. */
export function prefixSums(rows: readonly number[]): number[] {
    const offsets: number[] = new Array<number>(rows.length + 1);
    offsets[0] = 0;
    let total = 0;
    for (let index = 0; index < rows.length; index += 1) {
        total += rows[index] as number;
        offsets[index + 1] = total;
    }
    return offsets;
}

export interface WrapMetricsInput {
    readonly lines: readonly string[];
    /** The textarea's CONTENT box width. `<= 0` (unmeasured) means "no metrics". */
    readonly width: number;
    /** One monospace advance, for the cheap refusal; `<= 0` disables it. */
    readonly charWidth: number;
    readonly measure: RowMeasure;
    /** The previous answer, returned unchanged when nothing moved (identity = "no re-render"). */
    readonly previous?: WrapMetrics | null | undefined;
}

/**
 * The per-line row counts and their prefix sums, reusing the cache for every line whose text is
 * unchanged.
 *
 * Returns `previous` **by identity** when the width and every row count match, which is what lets
 * the component drive this from a layout effect without looping: a re-render that changed nothing
 * produces the object it already holds.
 */
export function wrapMetrics(cache: WrapCache, input: WrapMetricsInput): WrapMetrics | null {
    if (!(input.width > 0)) return null;

    if (cache.width !== input.width || cache.charWidth !== input.charWidth) {
        cache.rows.clear();
        cache.width = input.width;
        cache.charWidth = input.charWidth;
    }
    if (cache.rows.size > MAX_CACHED_LINES) cache.rows.clear();

    const rows: number[] = new Array<number>(input.lines.length);
    for (let index = 0; index < input.lines.length; index += 1) {
        const text = input.lines[index] as string;
        if (cannotWrap(text, input.width, input.charWidth)) {
            rows[index] = 1;
            continue;
        }
        const cached = cache.rows.get(text);
        if (cached !== undefined) {
            rows[index] = cached;
            continue;
        }
        const measured = Math.max(1, Math.round(input.measure(text)));
        cache.rows.set(text, measured);
        rows[index] = measured;
    }

    const previous = input.previous ?? null;
    if (previous !== null && previous.width === input.width && previous.rows.length === rows.length) {
        let same = true;
        for (let index = 0; index < rows.length; index += 1) {
            if (previous.rows[index] !== rows[index]) {
                same = false;
                break;
            }
        }
        if (same) return previous;
    }

    return { width: input.width, rows, offsets: prefixSums(rows) };
}

/**
 * The 1-based logical line that owns visual row `row` — the same upper-bound binary search
 * `lineNumberAt` runs over character offsets, clamped so a row past the end of the document
 * resolves to the last line rather than to one that is not there.
 */
export function lineAtRow(offsets: readonly number[], row: number): number {
    const count = Math.max(1, offsets.length - 1);
    return Math.min(count, lineNumberAt(offsets, row));
}

export interface WrappedWindowInput {
    readonly offsets: readonly number[];
    readonly scrollTop: number;
    /** The textarea's `clientHeight`. 0 (jsdom, pre-measure) means "draw everything". */
    readonly viewportHeight: number;
    readonly lineHeight: number;
    readonly paddingTop: number;
    readonly overscan?: number;
}

/**
 * `visibleLineWindow`'s wrapped twin: rows → line, through the prefix sums instead of through a
 * fixed pitch. Same contract — 1-based, inclusive, overscanned, clamped at both ends.
 */
export function wrappedLineWindow(input: WrappedWindowInput): LineWindow {
    const count = Math.max(1, input.offsets.length - 1);
    if (input.viewportHeight <= 0 || input.lineHeight <= 0) return { first: 1, last: count };

    const overscan = input.overscan ?? DEFAULT_GUTTER_OVERSCAN;
    const totalRows = Math.max(1, input.offsets[count] ?? count);
    const clamp = (row: number): number => Math.min(Math.max(row, 0), totalRows - 1);
    const top = Math.floor((input.scrollTop - input.paddingTop) / input.lineHeight);
    const bottom = Math.ceil((input.scrollTop - input.paddingTop + input.viewportHeight) / input.lineHeight);

    return {
        first: Math.max(1, lineAtRow(input.offsets, clamp(top)) - overscan),
        last: Math.min(count, lineAtRow(input.offsets, clamp(bottom)) + overscan)
    };
}

// ---------------------------------------------------------------------------
// The DOM half: the mirror node itself
// ---------------------------------------------------------------------------

/** The textarea's CONTENT box width (`clientWidth` already excludes any scrollbar). */
export function contentBoxWidth(area: HTMLElement): number {
    const computed = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(area) : null;
    const left = computed === null ? 0 : Number.parseFloat(computed.paddingLeft || '0');
    const right = computed === null ? 0 : Number.parseFloat(computed.paddingRight || '0');
    const padding = (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0);
    return area.clientWidth - padding;
}

/**
 * Give the mirror the textarea's own typography, so a wrap in one is a wrap in the other. Copied
 * from computed style rather than restated, because a face that falls back differently would
 * measure differently.
 *
 * `width` is optional and omitted for the character probe: the probe measures ITS OWN width, so
 * constraining it to the content box would clamp the very number being read.
 */
export function syncMirrorStyle(mirror: HTMLElement, area: HTMLElement, width?: number): void {
    if (width !== undefined) mirror.style.width = `${String(width)}px`;
    const computed = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(area) : null;
    if (computed === null) return;
    const style = mirror.style;
    if (computed.fontFamily !== '') style.fontFamily = computed.fontFamily;
    if (computed.fontSize !== '') style.fontSize = computed.fontSize;
    if (computed.fontWeight !== '') style.fontWeight = computed.fontWeight;
    if (computed.fontStyle !== '') style.fontStyle = computed.fontStyle;
    if (computed.letterSpacing !== '') style.letterSpacing = computed.letterSpacing;
    if (computed.wordSpacing !== '') style.wordSpacing = computed.wordSpacing;
    if (computed.lineHeight !== '') style.lineHeight = computed.lineHeight;
    if (computed.tabSize !== '') style.tabSize = computed.tabSize;
}

/** One monospace advance, averaged over a 64-character probe so rounding cannot dominate. */
export const CHAR_PROBE = '0'.repeat(64);

export function measureCharWidth(probe: HTMLElement): number {
    const width = probe.getBoundingClientRect().width || probe.offsetWidth;
    return width > 0 ? width / CHAR_PROBE.length : 0;
}

/** Rows one logical line takes in the mirror. An empty line is one row, never zero. */
export function measureRows(mirror: HTMLElement, text: string, lineHeight: number): number {
    if (text === '' || !(lineHeight > 0)) return 1;
    mirror.textContent = text;
    const height = mirror.offsetHeight || mirror.getBoundingClientRect().height;
    if (!(height > 0)) return 1;
    return Math.max(1, Math.round(height / lineHeight));
}
