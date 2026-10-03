/**
 * Per-pane csv view sort (#324, docs/csv-pane.md §sort).
 *
 * The result is a permutation of LOGICAL rows (a `Uint32Array`); the file and every other pane
 * are untouched. Keys are pre-parsed once: a category (number < text < empty, empties last in
 * both directions), numbers in a `Float64Array`, text compared with a case-insensitive natural
 * order on an ASCII fast path and `Intl.Collator({numeric})` only when a string is not ASCII.
 * Ties keep file order, so the sort is stable.
 *
 * Big files sort externally: keys are read in batches of `batchRows`; one batch sorts in memory,
 * more batches are sorted and spilled to a 0700 per-pid directory under the user cache dir, then
 * k-way merged. Out of disk space is a sort error, never a crash. Cancellable between batches.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { CsvSortDirection } from '@kelpi/protocol';

import { processAlive } from './open.js';

export const SORT_BATCH_ROWS = 200_000;
/** Keys read per request while collecting a batch. */
export const SORT_READ_ROWS = 20_000;

const CAT_NUMBER = 0;
const CAT_TEXT = 1;
const CAT_EMPTY = 2;

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ASCII = /^[\x00-\x7f]*$/;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class SortCancelled extends Error {
    constructor() {
        super('csv sort cancelled');
        this.name = 'SortCancelled';
    }
}

export class SortDiskFull extends Error {
    constructor() {
        super('There is not enough disk space to sort this file.');
        this.name = 'SortDiskFull';
    }
}

/** Keys for a contiguous run of rows. */
export interface SortKeys {
    readonly cat: Uint8Array;
    readonly num: Float64Array;
    readonly text: (string | null)[];
}

export function makeKeys(values: readonly string[]): SortKeys {
    const cat = new Uint8Array(values.length);
    const num = new Float64Array(values.length);
    const text: (string | null)[] = new Array<string | null>(values.length).fill(null);
    for (let i = 0; i < values.length; i += 1) {
        const trimmed = (values[i] ?? '').trim();
        if (trimmed === '') cat[i] = CAT_EMPTY;
        else if (NUMBER.test(trimmed)) {
            cat[i] = CAT_NUMBER;
            num[i] = Number(trimmed);
        } else {
            cat[i] = CAT_TEXT;
            text[i] = trimmed;
        }
    }
    return { cat, num, text };
}

const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const lower = (code: number): number => (code >= 65 && code <= 90 ? code + 32 : code);

/** Case-insensitive natural order for ASCII strings (digit runs compare by value). */
export function compareAscii(a: string, b: string): number {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const ca = a.charCodeAt(i);
        const cb = b.charCodeAt(j);
        if (isDigit(ca) && isDigit(cb)) {
            let ie = i;
            while (ie < a.length && isDigit(a.charCodeAt(ie))) ie += 1;
            let je = j;
            while (je < b.length && isDigit(b.charCodeAt(je))) je += 1;
            // Strip leading zeros, then the longer run is the bigger number.
            let is = i;
            while (is < ie - 1 && a.charCodeAt(is) === 48) is += 1;
            let js = j;
            while (js < je - 1 && b.charCodeAt(js) === 48) js += 1;
            const la = ie - is;
            const lb = je - js;
            if (la !== lb) return la - lb;
            for (let k = 0; k < la; k += 1) {
                const d = a.charCodeAt(is + k) - b.charCodeAt(js + k);
                if (d !== 0) return d;
            }
            i = ie;
            j = je;
            continue;
        }
        const d = lower(ca) - lower(cb);
        if (d !== 0) return d;
        i += 1;
        j += 1;
    }
    return (a.length - i) - (b.length - j);
}

export function compareText(a: string, b: string): number {
    if (ASCII.test(a) && ASCII.test(b)) return compareAscii(a, b);
    return collator.compare(a, b);
}

/** Compare two keys; `desc` flips everything except that empties stay last. */
export function compareKey(
    catA: number, numA: number, textA: string | null,
    catB: number, numB: number, textB: string | null,
    desc: boolean
): number {
    if (catA === CAT_EMPTY || catB === CAT_EMPTY) {
        if (catA === catB) return 0;
        return catA === CAT_EMPTY ? 1 : -1;
    }
    let result: number;
    if (catA !== catB) result = catA - catB;
    else if (catA === CAT_NUMBER) result = numA < numB ? -1 : numA > numB ? 1 : 0;
    else result = compareText(textA ?? '', textB ?? '');
    return desc ? -result : result;
}

export interface SortSource {
    /** First logical row to sort (1 when a header row is pinned). */
    readonly first: number;
    /** Rows to sort from `first`. */
    readonly count: number;
    /** The sort column's values for logical rows `[start, start + count)`. */
    read(start: number, count: number): Promise<string[]>;
}

export interface SortOptions {
    readonly direction: CsvSortDirection;
    readonly batchRows?: number | undefined;
    readonly readRows?: number | undefined;
    /** Where spill files go; created 0700 on first use. */
    readonly spillDir: string;
    readonly signal?: { readonly aborted: boolean } | undefined;
    readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

function sortBatch(keys: SortKeys, desc: boolean): Uint32Array {
    const order = new Uint32Array(keys.cat.length);
    for (let i = 0; i < order.length; i += 1) order[i] = i;
    const { cat, num, text } = keys;
    order.sort((a, b) => compareKey(cat[a] as number, num[a] as number, text[a] ?? null, cat[b] as number, num[b] as number, text[b] ?? null, desc) || a - b);
    return order;
}

async function readKeys(source: SortSource, start: number, count: number, readRows: number, signal?: { readonly aborted: boolean }): Promise<string[]> {
    const values: string[] = [];
    for (let at = start; at < start + count; at += readRows) {
        if (signal?.aborted) throw new SortCancelled();
        const chunk = await source.read(at, Math.min(readRows, start + count - at));
        for (const value of chunk) values.push(value);
    }
    if (signal?.aborted) throw new SortCancelled();
    return values;
}

// ── spill format: [u32 row][u8 cat][f64 num][u32 textBytes][text] ────────────────────

function encodeBatch(order: Uint32Array, keys: SortKeys, rowBase: number): Buffer {
    const texts: (Buffer | null)[] = new Array<Buffer | null>(order.length);
    let size = 0;
    for (let k = 0; k < order.length; k += 1) {
        const i = order[k] as number;
        const text = keys.text[i];
        const bytes = text === null || text === undefined ? null : Buffer.from(text, 'utf8');
        texts[k] = bytes;
        size += 17 + (bytes?.length ?? 0);
    }
    const out = Buffer.allocUnsafe(size);
    let at = 0;
    for (let k = 0; k < order.length; k += 1) {
        const i = order[k] as number;
        out.writeUInt32LE(rowBase + i, at);
        out.writeUInt8(keys.cat[i] as number, at + 4);
        out.writeDoubleLE(keys.num[i] as number, at + 5);
        const bytes = texts[k];
        out.writeUInt32LE(bytes?.length ?? 0, at + 13);
        at += 17;
        if (bytes) {
            bytes.copy(out, at);
            at += bytes.length;
        }
    }
    return out;
}

interface SpillHead {
    row: number;
    cat: number;
    num: number;
    text: string | null;
}

/** Sequential reader over one spill file. */
class SpillReader {
    private fd: number;
    private buffer = Buffer.alloc(0);
    private offset = 0;
    private position = 0;
    private eof = false;
    head: SpillHead | null = null;

    constructor(file: string, readonly batch: number, private readonly blockBytes: number) {
        this.fd = fs.openSync(file, 'r');
        this.advance();
    }

    private fill(need: number): boolean {
        while (this.buffer.length - this.offset < need && !this.eof) {
            const block = Buffer.allocUnsafe(Math.max(this.blockBytes, need));
            const got = fs.readSync(this.fd, block, 0, block.length, this.position);
            if (got <= 0) {
                this.eof = true;
                break;
            }
            this.position += got;
            this.buffer = Buffer.concat([this.buffer.subarray(this.offset), block.subarray(0, got)]);
            this.offset = 0;
        }
        return this.buffer.length - this.offset >= need;
    }

    advance(): void {
        if (!this.fill(17)) {
            this.head = null;
            return;
        }
        const at = this.offset;
        const row = this.buffer.readUInt32LE(at);
        const cat = this.buffer.readUInt8(at + 4);
        const num = this.buffer.readDoubleLE(at + 5);
        const length = this.buffer.readUInt32LE(at + 13);
        this.offset += 17;
        let text: string | null = null;
        if (length > 0) {
            if (!this.fill(length)) throw new Error('csv sort spill file is truncated');
            text = this.buffer.toString('utf8', this.offset, this.offset + length);
            this.offset += length;
        } else if (cat === CAT_TEXT) text = '';
        this.head = { row, cat, num, text };
    }

    close(): void {
        try {
            fs.closeSync(this.fd);
        } catch {
            // Already closed.
        }
    }
}

function isDiskFull(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOSPC' || code === 'EDQUOT';
}

let spillSequence = 0;

/**
 * Sort `source`'s rows. Returns their LOGICAL row numbers in sorted order (length `count`).
 */
export async function sortRows(source: SortSource, options: SortOptions): Promise<Uint32Array> {
    const desc = options.direction === 'desc';
    const batchRows = Math.max(1, options.batchRows ?? SORT_BATCH_ROWS);
    const readRows = Math.max(1, options.readRows ?? SORT_READ_ROWS);
    const { first, count } = source;
    const result = new Uint32Array(count);
    if (count === 0) return result;

    if (count <= batchRows) {
        const keys = makeKeys(await readKeys(source, first, count, readRows, options.signal));
        const order = sortBatch(keys, desc);
        for (let k = 0; k < count; k += 1) result[k] = first + (order[k] as number);
        options.onProgress?.(count, count);
        return result;
    }

    spillSequence += 1;
    const sequence = spillSequence;
    const files: string[] = [];
    const readers: SpillReader[] = [];
    try {
        try {
            fs.mkdirSync(options.spillDir, { recursive: true, mode: 0o700 });
            fs.chmodSync(options.spillDir, 0o700);
        } catch (error) {
            if (isDiskFull(error)) throw new SortDiskFull();
            throw error;
        }
        let done = 0;
        for (let start = 0, batch = 0; start < count; start += batchRows, batch += 1) {
            const take = Math.min(batchRows, count - start);
            const keys = makeKeys(await readKeys(source, first + start, take, readRows, options.signal));
            const order = sortBatch(keys, desc);
            const file = path.join(options.spillDir, `sort-${String(sequence)}-${String(batch)}.bin`);
            files.push(file);
            try {
                await fs.promises.writeFile(file, encodeBatch(order, keys, first + start), { mode: 0o600 });
            } catch (error) {
                if (isDiskFull(error)) throw new SortDiskFull();
                throw error;
            }
            done += take;
            options.onProgress?.(Math.floor(done / 2), count);
        }
        for (let batch = 0; batch < files.length; batch += 1) {
            readers.push(new SpillReader(files[batch] as string, batch, 256 * 1024));
        }
        // k-way merge on a binary heap; ties go to the lower batch (file order), so it is stable.
        const heap: SpillReader[] = readers.filter(reader => reader.head !== null);
        const less = (a: SpillReader, b: SpillReader): boolean => {
            const ha = a.head as SpillHead;
            const hb = b.head as SpillHead;
            const order = compareKey(ha.cat, ha.num, ha.text, hb.cat, hb.num, hb.text, desc);
            return order < 0 || (order === 0 && ha.row < hb.row);
        };
        const siftDown = (index: number): void => {
            for (;;) {
                const left = index * 2 + 1;
                const right = left + 1;
                let smallest = index;
                if (left < heap.length && less(heap[left] as SpillReader, heap[smallest] as SpillReader)) smallest = left;
                if (right < heap.length && less(heap[right] as SpillReader, heap[smallest] as SpillReader)) smallest = right;
                if (smallest === index) return;
                const swap = heap[index] as SpillReader;
                heap[index] = heap[smallest] as SpillReader;
                heap[smallest] = swap;
                index = smallest;
            }
        };
        for (let i = (heap.length >> 1) - 1; i >= 0; i -= 1) siftDown(i);
        let written = 0;
        while (heap.length > 0) {
            const top = heap[0] as SpillReader;
            result[written] = (top.head as SpillHead).row;
            written += 1;
            top.advance();
            if (top.head === null) {
                const last = heap.pop() as SpillReader;
                if (heap.length > 0 && last !== top) heap[0] = last;
            }
            if (heap.length > 0) siftDown(0);
            if ((written & 0xffff) === 0) {
                if (options.signal?.aborted) throw new SortCancelled();
                options.onProgress?.(Math.floor(count / 2 + written / 2), count);
                await new Promise<void>(resolve => setImmediate(resolve));
            }
        }
        if (options.signal?.aborted) throw new SortCancelled();
        options.onProgress?.(count, count);
        return result;
    } finally {
        for (const reader of readers) reader.close();
        for (const file of files) {
            try {
                fs.rmSync(file, { force: true });
            } catch {
                // Swept at the next boot.
            }
        }
    }
}

/** `~/Library/Caches/kelpi/csv-sort` on macOS, `$XDG_CACHE_HOME/kelpi/csv-sort` elsewhere. */
export function defaultSortCacheRoot(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
    home: string = os.homedir()
): string {
    if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'kelpi', 'csv-sort');
    const xdg = env['XDG_CACHE_HOME'];
    const cache = xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.cache');
    return path.join(cache, 'kelpi', 'csv-sort');
}

/** This process's spill directory under `root`. */
export function spillDirFor(root: string, pid: number = process.pid): string {
    return path.join(root, String(pid));
}

/** Boot: remove spill directories left by daemons that are gone. Returns what was removed. */
export function sweepSortSpill(root: string, alive: (pid: number) => boolean = processAlive): string[] {
    const removed: string[] = [];
    let names: string[];
    try {
        names = fs.readdirSync(root);
    } catch {
        return removed;
    }
    for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid === process.pid || alive(pid)) continue;
        const target = path.join(root, name);
        try {
            fs.rmSync(target, { recursive: true, force: true });
            removed.push(target);
        } catch {
            // Not ours to remove, or already gone.
        }
    }
    return removed;
}
