/**
 * The csv save pipeline (#324, docs/csv-pane.md §save).
 *
 * One generator (`csvWriter`) yields the new file as Buffers. Untouched base rows are byte-copied
 * from the base fd; edited and inserted rows are serialised in the file's dialect; a column map
 * that is no longer the identity re-serialises every row. It builds the NEW row index as it goes,
 * so after the rename the document swaps to the written file without rescanning it (REBASE).
 *
 * Two drivers share it: `saveAsync` (autosave; awaits each write, abortable) and `saveSync` (the
 * SIGTERM flush and small-file closes, which must finish inside a synchronous handler). Both:
 *
 *   1. check the base before writing: `fstat` of the base fd must still match what was indexed
 *      (an in-place rewrite would make every byte copy wrong) and the path must not have become a
 *      symlink. A path that now names ANOTHER file (an external atomic save) is fine: the base
 *      inode is intact and our save wins, the same last-writer rule markdown has;
 *   2. write `.<base>.kelpi-<pid>-<n>.tmp` beside the real file (`wx`, 0600, then the base mode);
 *   3. check again right before the rename; rename; open the new file and confirm its inode is the
 *      one written. A failure removes the temp file.
 */

import fs from 'node:fs';

import type { CsvDialect } from '@kelpi/protocol';

import { closeQuietly, identityOf, openRealpathSync, tempPathFor, type FileIdentity, type OpenedCsvFile } from './open.js';
import type { Column, Overlay, RowData } from './overlay.js';
import { parseRecord, serialiseRecord, stripTerminator, type ParsedRecord } from './record.js';
import { RowIndex } from './scan.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** The indexed file a save copies from. */
export interface WriterBase {
    readonly fd: number;
    readonly index: RowIndex;
    /** Bytes indexed (the size at open / the last save). */
    readonly size: number;
    readonly trailingNewline: boolean;
}

export interface WriterPlan {
    readonly base: WriterBase;
    /** A snapshot the caller will not mutate while the generator runs. */
    readonly overlay: Overlay;
    readonly dialect: CsvDialect;
    /** Copy/flush granularity (tests use tiny values). */
    readonly chunkBytes?: number | undefined;
}

export interface WriterOutput {
    readonly index: RowIndex;
    readonly size: number;
    readonly trailingNewline: boolean;
    /** Column ids by field index in the written file. */
    readonly columnIDs: readonly number[];
    readonly nextColumnID: number;
}

export const WRITER_CHUNK_BYTES = 1024 * 1024;

export function readRangeSync(fd: number, start: number, end: number): Buffer {
    const length = Math.max(0, end - start);
    const buffer = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
        const got = fs.readSync(fd, buffer, done, length - done, start + done);
        if (got <= 0) throw new CsvSaveConflict('base-modified', 'The file shrank on disk while it was being saved.');
        done += got;
    }
    return buffer;
}

export function recordEnd(base: WriterBase, row: number): number {
    return row + 1 < base.index.length ? base.index.get(row + 1) : base.size;
}

export function parseBytes(bytes: Buffer, delimiter: string): ParsedRecord {
    return parseRecord(stripTerminator(bytes.toString('utf8')), delimiter);
}

/**
 * The fields a row writes. `identity` keeps a base row's own field count (ragged rows stay
 * ragged); otherwise every row gets one field per display column. A blank base line with no
 * overrides stays blank.
 */
export function materialiseFields(
    base: ParsedRecord | null,
    data: RowData | null,
    columns: readonly Column[],
    positions: ReadonlyMap<number, number>,
    identity: boolean
): { fields: string[]; quoted: boolean[] } {
    const cells = data?.cells ?? null;
    if (base !== null && base.fields.length === 0 && cells === null) return { fields: [], quoted: [] };
    if (identity && base !== null) {
        const fields = base.fields.slice();
        const quoted = base.quoted.slice();
        if (cells !== null) {
            for (const [id, value] of cells) {
                const position = positions.get(id);
                if (position === undefined) continue; // a deleted column's leftover override
                while (fields.length <= position) {
                    fields.push('');
                    quoted.push(false);
                }
                fields[position] = value;
            }
        }
        if (data?.quoted) for (const id of data.quoted) {
            const position = positions.get(id);
            if (position !== undefined && position < quoted.length) quoted[position] = true;
        }
        return { fields, quoted };
    }
    const fields: string[] = new Array<string>(columns.length);
    const quoted: boolean[] = new Array<boolean>(columns.length);
    for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i] as Column;
        const override = cells?.get(column.id);
        const fromBase = base !== null && column.base !== null ? base.fields[column.base] : undefined;
        fields[i] = override ?? fromBase ?? '';
        quoted[i] = data?.quoted?.has(column.id) === true || (base !== null && column.base !== null && base.quoted[column.base] === true);
    }
    return { fields, quoted };
}

/** The writer itself. Reads the base synchronously, so both drivers share it unchanged. */
export function* csvWriter(plan: WriterPlan): Generator<Buffer, WriterOutput, void> {
    const { base, overlay, dialect } = plan;
    const chunkBytes = Math.max(1, plan.chunkBytes ?? WRITER_CHUNK_BYTES);
    const columns = overlay.columns;
    const identity = overlay.identityColumns();
    const positions = new Map<number, number>();
    columns.forEach((column, i) => positions.set(column.id, i));
    const total = overlay.rowCount;
    const finalNewline = base.index.length === 0 ? true : base.trailingNewline;
    const lineEnding = Buffer.from(dialect.lineEnding, 'utf8');
    const index = new RowIndex();
    let out = 0;
    let terminated = true;
    let pending: Buffer[] = [];
    let pendingBytes = 0;

    const queue = (buffer: Buffer): void => {
        pending.push(buffer);
        pendingBytes += buffer.length;
        out += buffer.length;
    };
    function* flush(): Generator<Buffer, void, void> {
        if (pendingBytes === 0) return;
        const buffer = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending, pendingBytes);
        pending = [];
        pendingBytes = 0;
        yield buffer;
    }

    /** Bytes of the terminator that ends the base record `[start, end)` (0, 1 for LF, 2 for CRLF). */
    const terminatorBytes = (start: number, end: number): number => {
        const tail = readRangeSync(base.fd, Math.max(start, end - 2), end);
        if (tail.length === 0 || tail[tail.length - 1] !== 0x0a) return 0;
        // The scanner's rule: a CR right before the LF, inside the record, makes it CRLF.
        return tail.length === 2 && tail[0] === 0x0d ? 2 : 1;
    };

    /** Byte-copy base rows `[start, start + count)`; `last` = they end the output. */
    function* emitCopy(start: number, count: number, last: boolean): Generator<Buffer, void, void> {
        if (count <= 0) return;
        if (!terminated) queue(lineEnding);
        yield* flush();
        const startByte = base.index.get(start);
        const endRow = start + count;
        let endByte = endRow < base.index.length ? base.index.get(endRow) : base.size;
        let ends = endRow < base.index.length || base.trailingNewline;
        if (last && !finalNewline && ends) {
            // The file had no trailing newline and this row is now the last one (the rows after
            // it were deleted): copy it up to its terminator, so the file still has none.
            endByte -= terminatorBytes(base.index.get(endRow - 1), endByte);
            ends = false;
        }
        for (let row = start; row < endRow; row += 1) index.push(base.index.get(row) - startByte + out);
        let position = startByte;
        while (position < endByte) {
            const take = Math.min(chunkBytes, endByte - position);
            yield readRangeSync(base.fd, position, position + take);
            position += take;
        }
        out += endByte - startByte;
        terminated = ends;
    }

    function* emitRow(text: string, logical: number): Generator<Buffer, void, void> {
        if (!terminated) queue(lineEnding);
        index.push(out);
        const last = logical === total - 1;
        const terminator = last && !finalNewline ? '' : dialect.lineEnding;
        queue(Buffer.from(text + terminator, 'utf8'));
        terminated = terminator !== '';
        if (pendingBytes >= chunkBytes) yield* flush();
    }

    const serialise = (parsed: ParsedRecord | null, data: RowData | null): string => {
        const { fields, quoted } = materialiseFields(parsed, data, columns, positions, identity);
        return serialiseRecord(fields, quoted, dialect);
    };

    if (dialect.bom) queue(BOM);

    for (const run of overlay.runs(0, total)) {
        if (run.kind === 'base') {
            if (identity) {
                yield* emitCopy(run.start, run.count, run.logical + run.count === total);
                continue;
            }
            // Re-serialise every row of the run, reading it in blocks.
            let row = run.start;
            const end = run.start + run.count;
            while (row < end) {
                const blockStart = base.index.get(row);
                let last = row;
                while (last + 1 < end && recordEnd(base, last + 1) - blockStart <= chunkBytes) last += 1;
                const block = readRangeSync(base.fd, blockStart, recordEnd(base, last));
                for (let r = row; r <= last; r += 1) {
                    const from = base.index.get(r) - blockStart;
                    const to = recordEnd(base, r) - blockStart;
                    yield* emitRow(serialise(parseBytes(block.subarray(from, to), dialect.delimiter), null), run.logical + (r - run.start));
                }
                row = last + 1;
            }
            continue;
        }
        const data = run.data;
        if (data.base >= 0 && data.cells === null && data.quoted === null && identity) {
            yield* emitCopy(data.base, 1, run.logical === total - 1);
            continue;
        }
        const parsed = data.base >= 0
            ? parseBytes(readRangeSync(base.fd, base.index.get(data.base), recordEnd(base, data.base)), dialect.delimiter)
            : null;
        yield* emitRow(serialise(parsed, data), run.logical);
    }
    yield* flush();
    return {
        index,
        size: out,
        trailingNewline: total === 0 ? true : terminated,
        columnIDs: columns.map(column => column.id),
        nextColumnID: overlay.nextColumnID
    };
}

// ── drivers ──────────────────────────────────────────────────────────────────────────

export type CsvConflictKind = 'base-modified' | 'path-symlink';

export class CsvSaveConflict extends Error {
    constructor(readonly kind: CsvConflictKind, message: string) {
        super(message);
        this.name = 'CsvSaveConflict';
    }
}

export class CsvSaveAborted extends Error {
    constructor() {
        super('csv save aborted');
        this.name = 'CsvSaveAborted';
    }
}

export interface SaveTarget {
    readonly realpath: string;
    readonly baseFd: number;
    /** What the base fd looked like when it was indexed (or last saved). */
    readonly baseIdentity: FileIdentity;
}

export interface SaveResult {
    /** The written file, opened read-only: the new base. */
    readonly opened: OpenedCsvFile;
    readonly output: WriterOutput;
    /** The path named another inode right after the rename (a racing writer): reload. */
    readonly raced: boolean;
}

/** Step 1 and 3: the base inode is unchanged and the path is not a symlink. */
export function checkBase(target: SaveTarget): void {
    const now = identityOf(fs.fstatSync(target.baseFd));
    const was = target.baseIdentity;
    if (now.ino !== was.ino || now.dev !== was.dev || now.size !== was.size || now.mtimeMs !== was.mtimeMs) {
        throw new CsvSaveConflict('base-modified', 'The file changed on disk while it was open.');
    }
    const link = fs.lstatSync(target.realpath, { throwIfNoEntry: false });
    if (link?.isSymbolicLink() === true) {
        throw new CsvSaveConflict('path-symlink', `${target.realpath} was replaced by a symbolic link.`);
    }
}

function writeAllSync(fd: number, buffer: Buffer): void {
    let done = 0;
    while (done < buffer.length) done += fs.writeSync(fd, buffer, done, buffer.length - done);
}

function writeAsync(fd: number, buffer: Buffer, offset: number): Promise<number> {
    return new Promise((resolve, reject) => {
        fs.write(fd, buffer, offset, buffer.length - offset, null, (error, written) => {
            if (error) reject(error);
            else resolve(written);
        });
    });
}

function finishOpen(realpath: string, tempIno: number): { opened: OpenedCsvFile; raced: boolean } {
    const opened = openRealpathSync(realpath);
    return { opened, raced: opened.identity.ino !== tempIno };
}

export function saveSync(plan: WriterPlan, target: SaveTarget): SaveResult {
    checkBase(target);
    const temp = tempPathFor(target.realpath);
    let fd: number | null = fs.openSync(temp, 'wx', 0o600);
    try {
        const writer = csvWriter(plan);
        let step = writer.next();
        while (step.done !== true) {
            writeAllSync(fd, step.value);
            step = writer.next();
        }
        const output = step.value;
        try {
            fs.fchmodSync(fd, target.baseIdentity.mode & 0o777);
        } catch {
            // The default 0600 is safe.
        }
        const tempIno = fs.fstatSync(fd).ino;
        fs.closeSync(fd);
        fd = null;
        checkBase(target);
        fs.renameSync(temp, target.realpath);
        return { ...finishOpen(target.realpath, tempIno), output };
    } catch (error) {
        closeQuietly(fd);
        try {
            fs.rmSync(temp, { force: true });
        } catch {
            // Best effort; the original error is the one that matters.
        }
        throw error;
    }
}

export interface AsyncSave {
    readonly tempPath: string;
    readonly done: Promise<SaveResult>;
    readonly aborted: boolean;
    /**
     * Stop and remove the temp file NOW (synchronously): the SIGTERM flush is about to write the
     * same document itself. The temp fd is left for the job to close (closing it here could hand
     * its number to the flush's own open while a write is still queued against it).
     */
    abort(): void;
}

/** Yield to the event loop every this many bytes (keeps the daemon responsive on big saves). */
const YIELD_BYTES = 8 * 1024 * 1024;

export function saveAsync(plan: WriterPlan, target: SaveTarget): AsyncSave {
    const temp = tempPathFor(target.realpath);
    let aborted = false;
    const removeTemp = (): void => {
        try {
            fs.rmSync(temp, { force: true });
        } catch {
            // Best effort.
        }
    };
    const run = async (): Promise<SaveResult> => {
        await Promise.resolve();
        if (aborted) throw new CsvSaveAborted();
        checkBase(target);
        const fd = await new Promise<number>((resolve, reject) => {
            fs.open(temp, 'wx', 0o600, (error, opened) => {
                if (error) reject(error);
                else resolve(opened);
            });
        });
        let open = true;
        const close = async (): Promise<void> => {
            if (!open) return;
            open = false;
            await new Promise<void>(resolve => fs.close(fd, () => resolve()));
        };
        try {
            const writer = csvWriter(plan);
            let sinceYield = 0;
            let step = writer.next();
            while (step.done !== true) {
                if (aborted) throw new CsvSaveAborted();
                const buffer = step.value;
                let done = 0;
                while (done < buffer.length) done += await writeAsync(fd, buffer, done);
                sinceYield += buffer.length;
                if (sinceYield >= YIELD_BYTES) {
                    sinceYield = 0;
                    await new Promise<void>(resolve => setImmediate(resolve));
                }
                step = writer.next();
            }
            const output = step.value;
            if (aborted) throw new CsvSaveAborted();
            await new Promise<void>(resolve => fs.fchmod(fd, target.baseIdentity.mode & 0o777, () => resolve()));
            const tempIno = await new Promise<number>((resolve, reject) => {
                fs.fstat(fd, (error, stat) => {
                    if (error) reject(error);
                    else resolve(stat.ino);
                });
            });
            await close();
            if (aborted) throw new CsvSaveAborted();
            checkBase(target);
            // Synchronous on purpose: between the check and the rename nothing may interleave.
            fs.renameSync(temp, target.realpath);
            return { ...finishOpen(target.realpath, tempIno), output };
        } catch (error) {
            await close();
            removeTemp();
            throw error;
        }
    };
    const done = run();
    // The caller observes `done`; never leave an unhandled rejection behind if it does not.
    done.catch(() => undefined);
    return {
        tempPath: temp,
        done,
        get aborted() {
            return aborted;
        },
        abort() {
            if (aborted) return;
            aborted = true;
            removeTemp();
        }
    };
}
