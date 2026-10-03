/**
 * The csv indexer (#324, docs/csv-pane.md): one pass over the file that records where every
 * record starts, so any row can later be read with one positioned read.
 *
 * The quote rule is the parser's (`./record.ts`): a quote opens a quoted field only at the start
 * of a field. The scanner and the parser MUST agree, or a stray quote mid-field would make the
 * index split records the parser then reads differently.
 *
 * Offsets go into a chunked `Float64Array` (`RowIndex`): 8 bytes a row, no per-row objects, and
 * growth never copies what is already there. UTF-8 is validated on boundary-aligned slices with
 * `buffer.isUtf8`, and a record longer than `maxRecordBytes` (almost always an unbalanced quote
 * swallowing the rest of the file) is reported so the document can go read-only.
 */

import fs from 'node:fs';
import { isUtf8 } from 'node:buffer';

import { CSV_LIMITS, type CsvLineEnding } from '@kelpi/protocol';

/** Row start offsets, chunked so a 10M-row index never reallocates a 80 MB array. */
export class RowIndex {
    static readonly CHUNK = 1 << 16;
    private readonly chunks: Float64Array[] = [];
    private count = 0;

    get length(): number {
        return this.count;
    }

    /** Approximate memory held, for budgets. */
    get bytes(): number {
        return this.chunks.length * RowIndex.CHUNK * 8;
    }

    push(offset: number): void {
        const chunk = this.count >>> 16;
        let target = this.chunks[chunk];
        if (target === undefined) {
            target = new Float64Array(RowIndex.CHUNK);
            this.chunks.push(target);
        }
        target[this.count & 0xffff] = offset;
        this.count += 1;
    }

    get(row: number): number {
        if (row < 0 || row >= this.count) throw new RangeError(`row ${String(row)} is outside the index`);
        return (this.chunks[row >>> 16] as Float64Array)[row & 0xffff] as number;
    }

    last(): number | undefined {
        return this.count === 0 ? undefined : this.get(this.count - 1);
    }

    pop(): number | undefined {
        if (this.count === 0) return undefined;
        const value = this.get(this.count - 1);
        this.count -= 1;
        return value;
    }

    truncate(length: number): void {
        if (length < this.count) this.count = Math.max(0, length);
    }
}

const LF = 0x0a;
const CR = 0x0d;
const QUOTE = 0x22;

const FIELD_START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
const QUOTE_IN_QUOTED = 3;

export interface ScanStats {
    /** Most fields in any record seen (0 for a file of blank lines). */
    maxFields: number;
    /** A record longer than `maxRecordBytes`. */
    oversized: boolean;
    /** The first record terminator's style, null until one is seen. */
    firstLineEnding: CsvLineEnding | null;
}

/**
 * The byte-level state machine, resumable across chunks. `feed` appends the start offset of
 * every record AFTER the first (the caller pushes the first) to `index`.
 */
export class CsvScanner {
    private state = FIELD_START;
    private fields = 0;
    private recordStart: number;
    private lastByte = -1;
    readonly stats: ScanStats = { maxFields: 0, oversized: false, firstLineEnding: null };

    constructor(
        private readonly delimiter: number,
        start: number,
        private readonly index: RowIndex | null,
        private readonly maxRecordBytes: number = CSV_LIMITS.maxRecordBytes,
        /** Sniffing only: every completed record's `(start, end, fields)`. */
        private readonly onRecord?: (start: number, end: number, fields: number) => void
    ) {
        this.recordStart = start;
    }

    feed(buf: Buffer, base: number): void {
        let state = this.state;
        let fields = this.fields;
        let recordStart = this.recordStart;
        const delim = this.delimiter;
        const index = this.index;
        const stats = this.stats;
        const maxRecord = this.maxRecordBytes;
        const n = buf.length;
        for (let i = 0; i < n; i += 1) {
            if (state === QUOTED) {
                const q = buf.indexOf(QUOTE, i);
                if (q < 0) break;
                i = q;
                state = QUOTE_IN_QUOTED;
                continue;
            }
            const b = buf[i] as number;
            if (b === LF) {
                const end = base + i + 1;
                const prev = i > 0 ? (buf[i - 1] as number) : this.lastByte;
                let content = end - 1 - recordStart;
                const crlf = prev === CR && content > 0;
                if (crlf) content -= 1;
                const recordFields = content === 0 ? 0 : fields + 1;
                if (recordFields > stats.maxFields) stats.maxFields = recordFields;
                if (end - recordStart > maxRecord) stats.oversized = true;
                if (stats.firstLineEnding === null) stats.firstLineEnding = crlf ? '\r\n' : '\n';
                this.onRecord?.(recordStart, end, recordFields);
                index?.push(end);
                recordStart = end;
                fields = 0;
                state = FIELD_START;
                continue;
            }
            if (b === delim) {
                fields += 1;
                state = FIELD_START;
                continue;
            }
            if (state === FIELD_START) state = b === QUOTE ? QUOTED : UNQUOTED;
            else if (state === QUOTE_IN_QUOTED) state = b === QUOTE ? QUOTED : UNQUOTED;
        }
        if (n > 0) this.lastByte = buf[n - 1] as number;
        if (base + n - recordStart > maxRecord) stats.oversized = true;
        this.state = state;
        this.fields = fields;
        this.recordStart = recordStart;
    }

    /** End of input at `end`: account for a final record with no terminator. */
    finish(end: number): void {
        if (end > this.recordStart) {
            let content = end - this.recordStart;
            if (this.lastByte === CR) content -= 1;
            const recordFields = content <= 0 ? 0 : this.fields + 1;
            if (recordFields > this.stats.maxFields) this.stats.maxFields = recordFields;
            if (end - this.recordStart > this.maxRecordBytes) this.stats.oversized = true;
            this.onRecord?.(this.recordStart, end, recordFields);
        }
    }
}

/** How many bytes at the end of `buf` belong to a UTF-8 sequence that continues past it. */
export function incompleteUtf8Tail(buf: Uint8Array): number {
    const n = buf.length;
    for (let back = 1; back <= Math.min(4, n); back += 1) {
        const b = buf[n - back] as number;
        if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead
        const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
        return need > back ? back : 0;
    }
    return 0;
}

/** Incremental `isUtf8` over chunks that may split a character. */
export class Utf8Validator {
    private carry: Buffer | null = null;
    valid = true;

    feed(chunk: Buffer): void {
        if (!this.valid) return;
        const data = this.carry === null ? chunk : Buffer.concat([this.carry, chunk]);
        const tail = incompleteUtf8Tail(data);
        const body = tail === 0 ? data : data.subarray(0, data.length - tail);
        if (body.length > 0 && !isUtf8(body)) {
            this.valid = false;
            this.carry = null;
            return;
        }
        this.carry = tail === 0 ? null : Buffer.from(data.subarray(data.length - tail));
    }

    finish(): boolean {
        if (this.valid && this.carry !== null && this.carry.length > 0) this.valid = false;
        this.carry = null;
        return this.valid;
    }
}

export class ScanCancelled extends Error {
    constructor() {
        super('csv scan cancelled');
        this.name = 'ScanCancelled';
    }
}

export interface ScanOptions {
    readonly fd: number;
    /** Offset of the first record to scan (after a BOM, or a tail scan's last record). */
    readonly from: number;
    /** End offset (exclusive): the size recorded at open, never beyond it. */
    readonly to: number;
    readonly delimiter: string;
    /** Appended to; the caller has NOT pushed `from` yet. */
    readonly index: RowIndex;
    readonly chunkSize?: number | undefined;
    readonly maxRecordBytes?: number | undefined;
    readonly signal?: { readonly aborted: boolean } | undefined;
    /** After every chunk: rows indexed, bytes scanned, most fields seen so far. */
    readonly onProgress?: ((rows: number, bytes: number, maxFields: number) => void) | undefined;
    /** Every chunk as it is read (`chunk` is reused afterwards): the fingerprint rides along. */
    readonly onChunk?: ((chunk: Buffer, position: number) => void) | undefined;
    /** Skip validation (it already failed, or a tail scan of a file known bad). */
    readonly validateUtf8?: boolean | undefined;
}

export interface ScanResult {
    readonly maxFields: number;
    readonly oversized: boolean;
    readonly utf8: boolean;
    /** The last record ends with a line terminator (true for an empty range). */
    readonly trailingNewline: boolean;
    readonly firstLineEnding: CsvLineEnding | null;
}

export const SCAN_CHUNK_BYTES = 1024 * 1024;

export function readAt(fd: number, buffer: Buffer, length: number, position: number): Promise<number> {
    return new Promise((resolve, reject) => {
        fs.read(fd, buffer, 0, length, position, (error, bytesRead) => {
            if (error) reject(error);
            else resolve(bytesRead);
        });
    });
}

/**
 * Index `[from, to)` of `fd`, yielding to the event loop between chunks. Rows become readable
 * as soon as their start is pushed, so a caller can serve the first screen while this runs.
 */
export async function scanFile(options: ScanOptions): Promise<ScanResult> {
    const chunkSize = options.chunkSize ?? SCAN_CHUNK_BYTES;
    const maxRecord = options.maxRecordBytes ?? CSV_LIMITS.maxRecordBytes;
    const scanner = new CsvScanner(options.delimiter.charCodeAt(0), options.from, options.index, maxRecord);
    const validator = options.validateUtf8 === false ? null : new Utf8Validator();
    const { from, to, index } = options;
    if (to <= from) return { maxFields: 0, oversized: false, utf8: true, trailingNewline: true, firstLineEnding: null };
    index.push(from);
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, to - from));
    let position = from;
    let lastByte = -1;
    while (position < to) {
        if (options.signal?.aborted) throw new ScanCancelled();
        const want = Math.min(buffer.length, to - position);
        const got = await readAt(options.fd, buffer, want, position);
        if (options.signal?.aborted) throw new ScanCancelled();
        if (got <= 0) break; // the file shrank under us; the caller's fstat check notices
        const chunk = buffer.subarray(0, got);
        options.onChunk?.(chunk, position);
        validator?.feed(chunk);
        scanner.feed(chunk, position);
        lastByte = chunk[got - 1] as number;
        position += got;
        options.onProgress?.(index.length, position - from, scanner.stats.maxFields);
    }
    scanner.finish(position);
    // A file ending in a terminator pushed the start of a record that does not exist.
    if (index.length > 0 && index.last() === position) index.pop();
    const utf8 = validator === null ? true : validator.finish();
    return {
        maxFields: scanner.stats.maxFields,
        oversized: scanner.stats.oversized,
        utf8,
        trailingNewline: lastByte === LF,
        firstLineEnding: scanner.stats.firstLineEnding
    };
}
