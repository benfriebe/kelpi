/**
 * vendor 0.4.0-kelpi.16: the search-highlight layer.
 *
 * Upstream ghostty-web has no find at all, so an embedder that searches the buffer elsewhere
 * (Kelpi searches its daemon's copy of the scrollback) could only show a hit by SELECTING it:
 * one match at a time, sharing the copy path and the user's own selection, and (until this
 * version fixed `SelectionManager.select`) on the wrong row in any terminal with scrollback.
 * Native Ghostty paints every visible match and the selected one in a stronger colour
 * (`search-background` / `search-selected-background`); this is that, for the canvas renderer.
 *
 * The embedder hands over a needle, never match positions. The rows that are painted are the
 * rows that are searched, at paint time, so a highlight follows the text through a scroll, new
 * output and a resize without a round trip. The one match the embedder DOES position is the
 * current one, because only it knows which occurrence its counter is on.
 *
 * Each row's text is built the way xterm.js's `translateToString(true)` builds it, because that
 * is what the embedder's matcher read: one string per cell, a wide character's spacer skipped,
 * a never-written cell a space, the never-written tail trimmed. A match therefore starts at the
 * same UTF-16 offset in both, which is how the current match is recognised among the rest, and
 * each offset maps back to the CELL it came from, so a match to the right of a wide character
 * is painted on the cells that show it.
 *
 * The current match is pinned to an absolute row, which output appended below leaves alone. Two
 * things move rows under it: history trimmed at the scrollback cap (every retained row shifts
 * down by the trimmed amount, and nothing in the WASM reports how many) and a replay that
 * rebuilds the buffer. So the pin records the row's text, and a row that no longer reads the same
 * is looked for nearby and re-pinned where it went, or the current match is dropped. It is never
 * painted on text that is not the needle.
 *
 * Known limit, stated rather than hidden: the WASM reports soft-wrap linkage for screen rows
 * only (`ghostty_terminal_is_row_wrapped`; `buffer.ts` assumes "not wrapped" for scrollback for
 * the same reason), so a wrap is known only where its continuation row is on the screen. A needle
 * straddling the wrap point of a line that has scrolled further into history is therefore not
 * painted as an ordinary match. The current match is still painted there, because it is located
 * from its own anchor rather than found by the scan (see `coveredSpans`).
 */

import type { GhosttyCell } from './types';

/** What to highlight: every occurrence of `needle` in the rows on screen. */
export interface ISearchHighlight {
  needle: string;
  /** Default false: the needle and the text are both case-folded before matching. */
  caseSensitive?: boolean;
}

/**
 * The selected match, as an embedder that searched elsewhere states it: counted up from the
 * bottom of the buffer (`linesFromBottom` 1 is the last row), `col` a UTF-16 offset into that
 * row's text and `length` the needle's length in the same units.
 */
export interface ISearchCurrentMatch {
  linesFromBottom: number;
  col: number;
  length: number;
}

/** The selected match pinned to an absolute row (scrollback rows first, then the screen). */
export interface SearchCurrentAnchor {
  absoluteRow: number;
  offset: number;
  length: number;
  /** The anchored row's whole text when it was pinned: how a moved row is recognised. */
  rowText: string;
}

/** One painted run of cells, in viewport coordinates, end column inclusive. */
export interface ISearchHighlightSpan {
  row: number;
  startCol: number;
  endCol: number;
  current: boolean;
}

/** The renderer's rows, addressed absolutely: `[0, scrollbackLength)` history, then the screen. */
export interface SearchRowSource {
  readonly scrollbackLength: number;
  readonly rows: number;
  readonly cols: number;
  line(absoluteRow: number): readonly GhosttyCell[] | null;
  /** Does this row soft-wrap onto the next one? False wherever the engine cannot tell. */
  wraps(absoluteRow: number): boolean;
  /** A multi-codepoint cell's whole cluster; null falls back to the cell's first codepoint. */
  grapheme(absoluteRow: number, col: number): string | null;
}

/** A row's text and, for every UTF-16 unit of it, the first and last cell that unit covers. */
export interface SearchRowText {
  text: string;
  firstCell: number[];
  lastCell: number[];
}

export const SEARCH_KIND_NONE = 0;
export const SEARCH_KIND_MATCH = 1;
export const SEARCH_KIND_CURRENT = 2;

/**
 * Rows walked past the viewport's edge to finish a wrapped line or a current match that starts
 * above it. A bound, not a tuning knob: it stops a degenerate buffer turning one frame into a walk
 * of the whole screen.
 */
const MAX_EXTRA_ROWS = 64;

/**
 * How far a current match is looked for when its row no longer reads as it did. A trim drops
 * whole pages of history (589 rows of an 80-column terminal per page, measured for #170), so the
 * reach has to cover a few pages; it is paid once, by the frame that notices.
 */
const MAX_RELOCATE_ROWS = 4096;

/**
 * Case folding that never changes a string's length: `toLowerCase` per character, except where
 * that would lengthen it (U+0130 `İ` lowercases to two units), where the character is kept.
 *
 * Offsets in the folded text are then offsets in the text, which is what lets a match found in one
 * be painted on the cells of the other. The daemon's matcher folds the same way
 * (`packages/daemon/src/term/search.ts`), so the two still agree about every offset.
 */
export function foldSearchCase(value: string): string {
  const lowered = value.toLowerCase();
  // No character lowercases to something SHORTER, so equal lengths mean nothing grew.
  if (lowered.length === value.length) return lowered;
  let folded = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/** One row's text, as `translateToString(true, 0, cols)` would produce it (see the header). */
export function searchRowText(
  cells: readonly GhosttyCell[],
  cols: number,
  grapheme: (col: number) => string | null
): SearchRowText {
  const width = Math.min(cols, cells.length);
  // The never-written tail is trimmed; a written space is content and stays.
  let end = 0;
  for (let col = 0; col < width; col++) {
    const cell = cells[col];
    if (cell.codepoint !== 0 && cell.width !== 0) end = Math.min(width, col + cell.width);
  }
  let text = '';
  const firstCell: number[] = [];
  const lastCell: number[] = [];
  let col = 0;
  while (col < end) {
    const cell = cells[col];
    if (cell.width === 0) {
      // A wide character's spacer: its head already spoke for it.
      col++;
      continue;
    }
    const span = Math.max(1, cell.width);
    const char =
      cell.codepoint === 0
        ? ' '
        : ((cell.grapheme_len > 0 ? grapheme(col) : null) ?? String.fromCodePoint(cell.codepoint));
    for (let unit = 0; unit < char.length; unit++) {
      firstCell.push(col);
      lastCell.push(Math.min(width, col + span) - 1);
    }
    text += char;
    col += span;
  }
  return { text, firstCell, lastCell };
}

/** A row reader that turns each row into text once, however often it is asked. */
function rowReader(source: SearchRowSource): (row: number) => SearchRowText | null {
  const total = source.scrollbackLength + source.rows;
  const texts = new Map<number, SearchRowText | null>();
  return (row) => {
    if (texts.has(row)) return texts.get(row) ?? null;
    const cells = row >= 0 && row < total ? source.line(row) : null;
    const text =
      cells === null ? null : searchRowText(cells, source.cols, (col) => source.grapheme(row, col));
    texts.set(row, text);
    return text;
  };
}

function caseFold(query: ISearchHighlight): (value: string) => string {
  return query.caseSensitive === true ? (value) => value : foldSearchCase;
}

/**
 * The rows a match of `length` starting at `offset` of `row` covers, continuing onto the rows
 * below, provided the text there IS the needle; null otherwise.
 *
 * Rows are joined whether or not the engine knows them to be wrapped: an anchor is only ever made
 * from the embedder's word that the needle starts there, and history cannot say whether it wraps.
 */
function coveredSpans(
  read: (row: number) => SearchRowText | null,
  row: number,
  offset: number,
  length: number,
  target: string,
  fold: (value: string) => string
): { row: number; text: SearchRowText; from: number; to: number }[] | null {
  if (length === 0 || length !== target.length) return null;
  const pieces: { row: number; text: SearchRowText; from: number; to: number }[] = [];
  let covered = '';
  let from = offset;
  for (let at = row; covered.length < length; at++) {
    if (at - row > MAX_EXTRA_ROWS) return null;
    const text = read(at);
    if (text === null || from < 0 || from >= text.text.length) return null;
    const take = Math.min(text.text.length - from, length - covered.length);
    pieces.push({ row: at, text, from, to: from + take - 1 });
    covered += text.text.slice(from, from + take);
    from = 0;
  }
  return fold(covered) === target ? pieces : null;
}

/**
 * Pin a bottom-relative match to the absolute row it names in this buffer, if the needle is
 * really there; null when it is not (the buffer is not the one the match was counted in: a
 * replay still arriving, output not yet parsed, history the embedder kept and this engine did not).
 */
export function pinSearchCurrent(
  source: SearchRowSource,
  query: ISearchHighlight,
  match: ISearchCurrentMatch
): SearchCurrentAnchor | null {
  const absoluteRow = source.scrollbackLength + source.rows - match.linesFromBottom;
  const read = rowReader(source);
  const fold = caseFold(query);
  const pieces = coveredSpans(read, absoluteRow, match.col, match.length, fold(query.needle), fold);
  const text = read(absoluteRow);
  if (pieces === null || text === null) return null;
  return { absoluteRow, offset: match.col, length: match.length, rowText: text.text };
}

/**
 * Where a pinned match's row went, if it moved: the same row, or the nearest row that still reads
 * exactly as the pinned one did (older rows first, which is where a trim moves them). Null when
 * nothing within reach does, which ends the current match.
 */
function relocateSearchCurrent(
  read: (row: number) => SearchRowText | null,
  total: number,
  anchor: SearchCurrentAnchor
): SearchCurrentAnchor | null {
  const reads = (row: number): boolean => read(row)?.text === anchor.rowText;
  if (reads(anchor.absoluteRow)) return anchor;
  for (let distance = 1; distance <= MAX_RELOCATE_ROWS; distance++) {
    const older = anchor.absoluteRow - distance;
    const newer = anchor.absoluteRow + distance;
    if (older < 0 && newer >= total) break;
    if (older >= 0 && reads(older)) return { ...anchor, absoluteRow: older };
    if (newer < total && reads(newer)) return { ...anchor, absoluteRow: newer };
  }
  return null;
}

/**
 * Every highlight for the viewport whose first row is `top` (an absolute row).
 *
 * Pure: the renderer calls it when something on screen changed and the embedder's diagnostics
 * call it whenever they like, and both get the same answer from the same rows.
 */
export function computeSearchHighlights(
  source: SearchRowSource,
  top: number,
  query: ISearchHighlight,
  current: SearchCurrentAnchor | null,
  read: (row: number) => SearchRowText | null = rowReader(source)
): ISearchHighlightSpan[] {
  const needle = query.needle;
  if (needle.length === 0) return [];
  const fold = caseFold(query);
  const target = fold(needle);
  const total = source.scrollbackLength + source.rows;
  const bottom = Math.min(total - 1, top + source.rows - 1);
  if (bottom < top) return [];

  // Whole logical lines: back to the start of the one the top row ends, on to the end of the one
  // the bottom row starts.
  let first = top;
  while (first > 0 && top - first < MAX_EXTRA_ROWS && source.wraps(first - 1)) first--;
  let last = bottom;
  while (last < total - 1 && last - bottom < MAX_EXTRA_ROWS && source.wraps(last)) last++;

  const spans: ISearchHighlightSpan[] = [];
  const push = (row: number, text: SearchRowText, from: number, to: number, isCurrent: boolean) => {
    if (from > to || row < top || row > bottom) return;
    spans.push({
      row: row - top,
      startCol: text.firstCell[from],
      endCol: text.lastCell[to],
      current: isCurrent,
    });
  };

  // The current match first, from its own anchor: it is painted even where the scan below cannot
  // see it (it starts above the viewport, or straddles a wrap in history).
  const currentPieces =
    current === null
      ? null
      : coveredSpans(read, current.absoluteRow, current.offset, current.length, target, fold);
  const isCurrentStart = (row: number, offset: number): boolean =>
    currentPieces !== null &&
    current !== null &&
    current.absoluteRow === row &&
    current.offset === offset;
  if (currentPieces !== null) {
    for (const piece of currentPieces) push(piece.row, piece.text, piece.from, piece.to, true);
  }

  let row = first;
  while (row <= last) {
    // One logical line: this row plus every row it wraps onto.
    const pieces: { row: number; text: SearchRowText; offset: number }[] = [];
    let joined = '';
    for (;;) {
      const text = read(row);
      if (text !== null) {
        pieces.push({ row, text, offset: joined.length });
        joined += text.text;
      }
      const continues = row < last && source.wraps(row);
      row++;
      if (!continues) break;
    }
    // Folding keeps every offset (`foldSearchCase`), so `at` is an offset into `joined` too.
    const haystack = fold(joined);
    for (let at = haystack.indexOf(target); at >= 0; at = haystack.indexOf(target, at + 1)) {
      // The row the match STARTS on and the offset inside it: the embedder's coordinates.
      let start = pieces[0];
      for (const piece of pieces) if (piece.offset <= at) start = piece;
      if (start !== undefined && isCurrentStart(start.row, at - start.offset)) continue;
      for (const piece of pieces) {
        const from = Math.max(at, piece.offset) - piece.offset;
        const to = Math.min(at + needle.length, piece.offset + piece.text.text.length) - piece.offset - 1;
        push(piece.row, piece.text, from, to, false);
      }
    }
  }
  return spans.sort((a, b) => a.row - b.row || a.startCol - b.startCol);
}

/** What one `SearchHighlighter.update` changed. */
export interface SearchHighlightUpdate {
  /** Viewport rows whose painted highlight changed: the renderer repaints them. */
  repaint: Set<number>;
  /** Whether the spans themselves changed (they can while the painted cells do not). */
  spansChanged: boolean;
}

const NO_UPDATE: SearchHighlightUpdate = { repaint: new Set(), spansChanged: false };

/**
 * Per-renderer state: what is being highlighted, what was last painted, and which rows a change
 * between the two has to repaint.
 */
export class SearchHighlighter {
  private query: ISearchHighlight | null = null;
  private current: SearchCurrentAnchor | null = null;
  /** Set by every change of query or anchor; the next `update` recomputes regardless. */
  private stale = true;
  /** Viewport row → the kind of every cell in it, as last painted. Absent rows paint nothing. */
  private kinds = new Map<number, Uint8Array>();
  /** The spans those kinds were built from, and their identity for change detection. */
  private spans: ISearchHighlightSpan[] = [];
  private spansKey = '';
  /** What the buffer looked like at the last recompute, beyond its dirty rows. */
  private shape = '';

  isActive(): boolean {
    return this.query !== null || this.kinds.size > 0;
  }

  getQuery(): ISearchHighlight | null {
    return this.query;
  }

  getCurrent(): SearchCurrentAnchor | null {
    return this.current;
  }

  /** The spans behind the last `update`: what is on screen once that frame has painted. */
  getSpans(): readonly ISearchHighlightSpan[] {
    return this.spans;
  }

  setQuery(query: ISearchHighlight | null): void {
    const next =
      query === null || query.needle.length === 0
        ? null
        : { needle: query.needle, caseSensitive: query.caseSensitive === true };
    const same =
      next?.needle === this.query?.needle && next?.caseSensitive === this.query?.caseSensitive;
    if (same) return;
    this.query = next;
    // A current match belongs to the needle it was counted for.
    this.current = null;
    this.stale = true;
  }

  setCurrent(anchor: SearchCurrentAnchor | null): void {
    const same =
      anchor?.absoluteRow === this.current?.absoluteRow &&
      anchor?.offset === this.current?.offset &&
      anchor?.length === this.current?.length &&
      anchor?.rowText === this.current?.rowText;
    if (same) return;
    this.current = anchor;
    this.stale = true;
  }

  /**
   * Recompute if anything that decides the highlights moved, and say what changed.
   *
   * `changed` is the renderer's own knowledge: a forced frame, a viewport move or a dirty row.
   * The shape string catches the rest: history erased or trimmed under a viewport that did not
   * move, and a resize that left every row clean. The source is only built once a recompute is
   * certain, so an idle frame with a search open costs a string comparison.
   */
  update(
    shape: { scrollbackLength: number; rows: number; cols: number },
    top: number,
    changed: boolean,
    makeSource: () => SearchRowSource
  ): SearchHighlightUpdate {
    const key = `${shape.scrollbackLength}:${shape.rows}:${shape.cols}:${top}`;
    if (!changed && !this.stale && key === this.shape) return NO_UPDATE;
    this.stale = false;
    this.shape = key;

    const source = makeSource();
    const read = rowReader(source);
    if (this.current !== null) {
      this.current = relocateSearchCurrent(read, source.scrollbackLength + source.rows, this.current);
    }
    const spans =
      this.query === null
        ? []
        : computeSearchHighlights(source, top, this.query, this.current, read);

    const next = new Map<number, Uint8Array>();
    for (const span of spans) {
      let kinds = next.get(span.row);
      if (kinds === undefined) {
        kinds = new Uint8Array(source.cols);
        next.set(span.row, kinds);
      }
      const kind = span.current ? SEARCH_KIND_CURRENT : SEARCH_KIND_MATCH;
      for (let col = span.startCol; col <= span.endCol && col < source.cols; col++) {
        // The current match wins a cell it shares with an overlapping ordinary one.
        if (kinds[col] !== SEARCH_KIND_CURRENT) kinds[col] = kind;
      }
    }
    const repaint = new Set<number>();
    for (const [row, kinds] of next) {
      const before = this.kinds.get(row);
      if (before === undefined || !sameKinds(before, kinds)) repaint.add(row);
    }
    for (const row of this.kinds.keys()) if (!next.has(row)) repaint.add(row);
    this.kinds = next;

    const spansKey = spans
      .map((span) => `${span.row},${span.startCol},${span.endCol},${span.current ? 1 : 0}`)
      .join(';');
    const spansChanged = spansKey !== this.spansKey;
    this.spansKey = spansKey;
    this.spans = spans;
    return { repaint, spansChanged };
  }

  /**
   * What the next frame would paint over the viewport whose first row is `top`, without painting:
   * the current match is followed to wherever its row went first, exactly as `update` does.
   */
  peek(source: SearchRowSource, top: number): ISearchHighlightSpan[] {
    if (this.query === null) return [];
    const read = rowReader(source);
    if (this.current !== null) {
      const moved = relocateSearchCurrent(read, source.scrollbackLength + source.rows, this.current);
      if (moved !== this.current) {
        this.current = moved;
        this.stale = true;
      }
    }
    return computeSearchHighlights(source, top, this.query, this.current, read);
  }

  /** The kind of one painted cell, in viewport coordinates. */
  kindAt(col: number, row: number): number {
    return this.kinds.get(row)?.[col] ?? SEARCH_KIND_NONE;
  }
}

function sameKinds(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
