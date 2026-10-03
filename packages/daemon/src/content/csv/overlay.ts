/**
 * The csv edit overlay (#324, docs/csv-pane.md): a piece table over LOGICAL rows.
 *
 * Logical rows are the document's rows in file order as they will be written. They are a list of
 * segments, each either a range of untouched base rows (`{base: [start, end)}`, read from the
 * indexed file on demand) or materialised rows (`{rows}`) carrying per-column overrides. Columns
 * are a display-ordered list of STABLE ids, each mapped to a base field index (or none, for an
 * inserted column), so a client's column address survives inserts, deletes and saves.
 *
 * Everything here is synchronous and pure (no I/O): the document reads base values before it
 * calls in, and the writer walks the segments. Saves REBASE: the written file becomes the new
 * base and the overlay goes back to identity, so the segment count is bounded by the edits made
 * since the last save.
 *
 * Rows are copy-on-write. A clone shares row objects with its source, inserted rows may be
 * shared (with undo history, or one frozen `EMPTY_ROW` for every blank row), and an overlay
 * copies a row the first time it changes one it does not own. So a clone is cheap (no per-row
 * copies), and neither side of a clone ever sees the other's later edits. A `rows` segment holds
 * at most `MAX_ROWS_SEGMENT` rows, so an insert or split inside one is bounded too.
 */

export interface RowData {
    /** The base row this row derives from, or -1 for a row that was inserted. */
    readonly base: number;
    /** Values by column id that differ from the base record (every value of a new row). */
    cells: Map<number, string> | null;
    /** Column ids written quoted (a restored row keeps its original quoting). */
    quoted: Set<number> | null;
}

export type Segment =
    | { readonly kind: 'base'; readonly start: number; readonly end: number }
    | { readonly kind: 'rows'; readonly rows: RowData[] };

export interface Column {
    readonly id: number;
    /** Field index in the base file, or null for a column inserted since the last save. */
    readonly base: number | null;
}

export type Resolved =
    | { readonly kind: 'base'; readonly base: number }
    | { readonly kind: 'row'; readonly data: RowData };

export type Run =
    | { readonly kind: 'base'; readonly logical: number; readonly start: number; readonly count: number }
    | { readonly kind: 'row'; readonly logical: number; readonly data: RowData };

/** The most rows one `rows` segment holds (bounds the copying an insert or split costs). */
export const MAX_ROWS_SEGMENT = 4096;

/** Every blank inserted row is this one frozen row; an overlay copies it before changing it. */
export const EMPTY_ROW: RowData = Object.freeze({ base: -1, cells: null, quoted: null }) as RowData;

const segmentLength = (segment: Segment): number =>
    segment.kind === 'base' ? segment.end - segment.start : segment.rows.length;

export function newRow(values?: readonly string[], ids?: readonly number[]): RowData {
    if (values === undefined || ids === undefined) return EMPTY_ROW;
    const cells = new Map<number, string>();
    const count = Math.min(values.length, ids.length);
    for (let i = 0; i < count; i += 1) {
        const value = values[i] ?? '';
        if (value !== '') cells.set(ids[i] as number, value);
    }
    return cells.size > 0 ? { base: -1, cells, quoted: null } : EMPTY_ROW;
}

/** `push(...items)` without the argument-count limit a 100k-row paste would hit. */
function appendAll<T>(target: T[], items: readonly T[]): void {
    for (const item of items) target.push(item);
}

/** `rows` as segments of at most `MAX_ROWS_SEGMENT` rows (each a new array). */
function rowSegments(rows: readonly RowData[]): Segment[] {
    const segments: Segment[] = [];
    for (let i = 0; i < rows.length; i += MAX_ROWS_SEGMENT) {
        segments.push({ kind: 'rows', rows: rows.slice(i, i + MAX_ROWS_SEGMENT) });
    }
    return segments;
}

/**
 * Drop empty segments, join contiguous base ranges, and join neighbouring `rows` segments while
 * they fit `MAX_ROWS_SEGMENT`. Joining appends into the earlier segment's array, which belongs
 * to the overlay being normalised.
 */
function mergeSegments(segments: readonly Segment[]): Segment[] {
    const merged: Segment[] = [];
    for (const segment of segments) {
        if (segmentLength(segment) === 0) continue;
        const previous = merged[merged.length - 1];
        if (previous?.kind === 'rows' && segment.kind === 'rows' && previous.rows.length + segment.rows.length <= MAX_ROWS_SEGMENT) {
            appendAll(previous.rows, segment.rows);
            continue;
        }
        if (previous?.kind === 'base' && segment.kind === 'base' && previous.end === segment.start) {
            merged[merged.length - 1] = { kind: 'base', start: previous.start, end: segment.end };
            continue;
        }
        merged.push(segment);
    }
    return merged;
}

export function cloneRow(row: RowData): RowData {
    return {
        base: row.base,
        cells: row.cells === null ? null : new Map(row.cells),
        quoted: row.quoted === null ? null : new Set(row.quoted)
    };
}

export class Overlay {
    segments: Segment[];
    columns: Column[];
    nextColumnID: number;
    readonly baseRows: number;
    readonly baseColumns: number;
    /**
     * Columns deleted since the last rebase, by id → base field. Rows materialised for undo
     * (a row delete's inverse) keep these values too, so undoing an earlier column delete by
     * reference still finds them in rows that were deleted and restored in between.
     */
    deletedColumns: Map<number, number | null> = new Map();
    private starts: number[] | null = null;
    private total = 0;
    /** Rows this overlay created or copied, so it may change them in place. */
    private owned = new WeakSet<RowData>();

    private constructor(baseRows: number, baseColumns: number, segments: Segment[], columns: Column[], nextColumnID: number) {
        this.baseRows = baseRows;
        this.baseColumns = baseColumns;
        this.segments = segments;
        this.columns = columns;
        this.nextColumnID = nextColumnID;
    }

    /**
     * Every base row in order, every base field as a column. `columns` gives the ids (by base
     * field index) when the base is a rebased save; otherwise ids are `0..baseColumns-1`.
     */
    static identity(baseRows: number, baseColumns: number, ids?: readonly number[], nextColumnID?: number): Overlay {
        const columns: Column[] = [];
        for (let i = 0; i < baseColumns; i += 1) columns.push({ id: ids?.[i] ?? i, base: i });
        const next = Math.max(nextColumnID ?? 0, ...columns.map(column => column.id + 1), 0);
        return new Overlay(baseRows, baseColumns, baseRows > 0 ? [{ kind: 'base', start: 0, end: baseRows }] : [], columns, next);
    }

    /**
     * An independent copy. Row objects are shared, not copied: from now on both sides copy a row
     * before they change it, so neither sees the other's later edits.
     */
    clone(): Overlay {
        const segments = this.segments.map((segment): Segment =>
            segment.kind === 'base' ? segment : { kind: 'rows', rows: segment.rows.slice() }
        );
        const copy = new Overlay(this.baseRows, this.baseColumns, segments, [...this.columns], this.nextColumnID);
        copy.deletedColumns = new Map(this.deletedColumns);
        this.owned = new WeakSet();
        return copy;
    }

    get rowCount(): number {
        this.ensureStarts();
        return this.total;
    }

    /** Columns map 1:1 onto base fields in order, so untouched rows can be byte-copied. */
    identityColumns(): boolean {
        if (this.columns.length !== this.baseColumns) return false;
        for (let i = 0; i < this.columns.length; i += 1) if (this.columns[i]?.base !== i) return false;
        return true;
    }

    columnPosition(id: number): number {
        for (let i = 0; i < this.columns.length; i += 1) if (this.columns[i]?.id === id) return i;
        return -1;
    }

    column(id: number): Column | null {
        const position = this.columnPosition(id);
        return position < 0 ? null : (this.columns[position] as Column);
    }

    private invalidate(): void {
        this.starts = null;
    }

    private ensureStarts(): void {
        if (this.starts !== null) return;
        const starts: number[] = new Array<number>(this.segments.length);
        let total = 0;
        for (let i = 0; i < this.segments.length; i += 1) {
            starts[i] = total;
            total += segmentLength(this.segments[i] as Segment);
        }
        this.starts = starts;
        this.total = total;
    }

    /** The segment holding logical `row` (which must be in range). */
    private locate(row: number): { readonly segment: number; readonly offset: number } {
        this.ensureStarts();
        const starts = this.starts as number[];
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >>> 1;
            if ((starts[mid] as number) <= row) lo = mid;
            else hi = mid - 1;
        }
        return { segment: lo, offset: row - (starts[lo] as number) };
    }

    resolve(row: number): Resolved {
        if (row < 0 || row >= this.rowCount) throw new RangeError(`row ${String(row)} is out of range`);
        const { segment, offset } = this.locate(row);
        const found = this.segments[segment] as Segment;
        return found.kind === 'base'
            ? { kind: 'base', base: found.start + offset }
            : { kind: 'row', data: found.rows[offset] as RowData };
    }

    /** Logical rows `[start, start + count)` as base runs and materialised rows, in order. */
    *runs(start: number, count: number): Generator<Run> {
        const end = Math.min(this.rowCount, start + count);
        if (start >= end) return;
        let { segment, offset } = this.locate(start);
        let logical = start;
        while (logical < end && segment < this.segments.length) {
            const found = this.segments[segment] as Segment;
            const available = segmentLength(found) - offset;
            const take = Math.min(available, end - logical);
            if (found.kind === 'base') {
                yield { kind: 'base', logical, start: found.start + offset, count: take };
            } else {
                for (let i = 0; i < take; i += 1) {
                    yield { kind: 'row', logical: logical + i, data: found.rows[offset + i] as RowData };
                }
            }
            logical += take;
            segment += 1;
            offset = 0;
        }
    }

    /** Make logical `row` a materialised row (splitting a base run) and return it for mutation. */
    editableRow(row: number): RowData {
        if (row < 0 || row >= this.rowCount) throw new RangeError(`row ${String(row)} is out of range`);
        const { segment, offset } = this.locate(row);
        const found = this.segments[segment] as Segment;
        if (found.kind === 'rows') {
            const current = found.rows[offset] as RowData;
            if (this.owned.has(current)) return current;
            const copy = cloneRow(current);
            found.rows[offset] = copy;
            this.owned.add(copy);
            return copy;
        }
        const data: RowData = { base: found.start + offset, cells: null, quoted: null };
        this.owned.add(data);
        const pieces: Segment[] = [];
        if (offset > 0) pieces.push({ kind: 'base', start: found.start, end: found.start + offset });
        pieces.push({ kind: 'rows', rows: [data] });
        if (found.start + offset + 1 < found.end) pieces.push({ kind: 'base', start: found.start + offset + 1, end: found.end });
        this.segments.splice(segment, 1, ...pieces);
        this.normaliseAround(segment, pieces.length);
        return data;
    }

    /**
     * Set one cell. `baseValue` is what the row's base record holds in that column ('' for an
     * inserted column or a new row); setting it back drops the override, so an undone edit
     * leaves the row byte-identical to the file again. `undefined` (a replay, which has no base
     * value at hand) always keeps the override.
     */
    setCell(row: number, columnID: number, value: string, baseValue: string | undefined): void {
        const data = this.editableRow(row);
        if (baseValue !== undefined && value === baseValue) {
            data.cells?.delete(columnID);
            if (data.cells !== null && data.cells.size === 0) data.cells = null;
        } else {
            data.cells ??= new Map<number, string>();
            data.cells.set(columnID, value);
        }
    }

    /** Insert `rows` before logical row `at`. The rows are shared, never changed in place. */
    insertRows(at: number, rows: readonly RowData[]): void {
        if (rows.length === 0) return;
        const total = this.rowCount;
        if (at < 0 || at > total) throw new RangeError(`insert position ${String(at)} is out of range`);
        const added = rowSegments(rows);
        if (at === total) {
            const index = this.segments.length;
            appendAll(this.segments, added);
            this.normaliseAround(index, added.length);
            return;
        }
        const { segment, offset } = this.locate(at);
        const found = this.segments[segment] as Segment;
        const pieces: Segment[] = [];
        if (found.kind === 'rows') {
            // Bounded: a rows segment holds at most MAX_ROWS_SEGMENT rows.
            if (offset > 0) pieces.push({ kind: 'rows', rows: found.rows.slice(0, offset) });
            appendAll(pieces, added);
            pieces.push({ kind: 'rows', rows: found.rows.slice(offset) });
        } else {
            if (offset > 0) pieces.push({ kind: 'base', start: found.start, end: found.start + offset });
            appendAll(pieces, added);
            pieces.push({ kind: 'base', start: found.start + offset, end: found.end });
        }
        this.segments.splice(segment, 1, ...pieces);
        this.normaliseAround(segment, pieces.length);
    }

    /** Remove logical rows `[start, start + count)`. */
    deleteRows(start: number, count: number): void {
        const end = start + count;
        if (start < 0 || count <= 0 || end > this.rowCount) throw new RangeError('delete range is out of range');
        this.ensureStarts();
        const starts = this.starts as number[];
        const next: Segment[] = [];
        for (let i = 0; i < this.segments.length; i += 1) {
            const found = this.segments[i] as Segment;
            const from = starts[i] as number;
            const to = from + segmentLength(found);
            if (to <= start || from >= end) {
                next.push(found);
                continue;
            }
            const cutFrom = Math.max(start, from) - from;
            const cutTo = Math.min(end, to) - from;
            if (found.kind === 'base') {
                if (cutFrom > 0) next.push({ kind: 'base', start: found.start, end: found.start + cutFrom });
                if (found.start + cutTo < found.end) next.push({ kind: 'base', start: found.start + cutTo, end: found.end });
            } else {
                const kept = found.rows.slice(0, cutFrom).concat(found.rows.slice(cutTo));
                if (kept.length > 0) next.push({ kind: 'rows', rows: kept });
            }
        }
        this.segments = next;
        this.normaliseAll();
    }

    insertColumn(at: number, column: Column): void {
        if (at < 0 || at > this.columns.length) throw new RangeError('column position is out of range');
        this.columns.splice(at, 0, column);
        this.deletedColumns.delete(column.id);
        if (column.id >= this.nextColumnID) this.nextColumnID = column.id + 1;
    }

    /** Remove a column from the display list; returns its position (-1 when unknown). */
    deleteColumn(id: number): number {
        const position = this.columnPosition(id);
        if (position >= 0) {
            this.deletedColumns.set(id, (this.columns[position] as Column).base);
            this.columns.splice(position, 1);
        }
        return position;
    }

    /** Count of materialised rows (memory / dirty heuristics). */
    materialisedRows(): number {
        let count = 0;
        for (const segment of this.segments) if (segment.kind === 'rows') count += segment.rows.length;
        return count;
    }

    /** Normalise `segments[index, index + length)` and its two neighbours only. */
    private normaliseAround(index: number, length: number): void {
        const from = Math.max(0, index - 1);
        const to = Math.min(this.segments.length, index + length + 1);
        const merged = mergeSegments(this.segments.slice(from, to));
        this.segments.splice(from, to - from, ...merged);
        this.invalidate();
    }

    private normaliseAll(): void {
        this.segments = mergeSegments(this.segments);
        this.invalidate();
    }
}
