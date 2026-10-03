/**
 * `CsvDocument` (#324, docs/csv-pane.md): one open csv file, shared by every pane showing it.
 *
 * It owns the base file (fd + row index), the edit overlay, undo history, the save pipeline, the
 * file watcher and the find cache. Per-pane view state (sort, header flag) lives in the service.
 *
 * Ordering: one serial queue runs edits, save starts and finishes, disk checks, reloads and the
 * raw-text hand-off, so none of them interleave across an await. Saves themselves run outside
 * the queue: a save writes a SNAPSHOT of the overlay while edits keep going on a clone, every op
 * applied meanwhile is logged, and the queued finish rebases (new base, identity overlay, the
 * logged ops replayed). Reads (rows, find, sort keys) never queue; each pins the base it started
 * on so a rebase cannot close the fd under it.
 *
 * Addressing: edits use LOGICAL rows and stable column ids. `generation` counts structural
 * changes within an `incarnation` (one per open/reload); a stale edit is translated forward
 * through the last 64 structural ops, or refused (`CSV_STALE` / `CSV_GONE`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    CSV_LIMITS,
    csvError,
    type CsvDialect,
    type CsvEditOp,
    type CsvReadOnly,
    type CsvScanProgress
} from '@kelpi/protocol';

import { watchFile, type FileWatcher, type WatchFn } from '../watcher.js';
import { detectBom, extensionOf, sniffDialect, SNIFF_BYTES } from './dialect.js';
import { cellMatches, FindCache, MatchCollector, needleOf, type FindIndex } from './find.js';
import {
    extendFingerprint,
    FingerprintBuilder,
    fingerprintMatches,
    readFingerprint,
    sampleRanges,
    type Fingerprint
} from './fingerprint.js';
import {
    closeQuietly,
    identityOf,
    openRealpathSync,
    sweepOrphanTemps,
    type FileIdentity,
    type OpenedCsvFile
} from './open.js';
import { EMPTY_ROW, newRow, Overlay, type Column, type RowData } from './overlay.js';
import { extractField, parseRecord, stripTerminator, type ParsedRecord } from './record.js';
import { readAt, RowIndex, ScanCancelled, scanFile, SCAN_CHUNK_BYTES } from './scan.js';
import { entryBytes, UndoHistory, type AppliedOp, type HistorySnapshot } from './undo.js';
import {
    CsvSaveAborted,
    CsvSaveConflict,
    saveAsync,
    saveSync,
    type AsyncSave,
    type SaveResult,
    type WriterBase
} from './writer.js';

/** What changed, so the service knows whether pane sorts survive it. */
export type CsvChange =
    /** Scan progress (throttled by the service). */
    | 'progress'
    /** The first scan finished. */
    | 'loaded'
    /** Cell values changed; row indices and columns did not. */
    | 'content'
    /** Rows or columns were inserted or deleted (sorts are dropped). */
    | 'structure'
    /** Reopened from disk: a new incarnation (sorts are dropped). */
    | 'reload'
    /** dirty / saving / error / notice / read-only changed. */
    | 'status';

export interface CsvDocumentOptions {
    readonly onChange: (document: CsvDocument, change: CsvChange) => void;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Scan / read / copy granularity (tests use tiny values). */
    readonly chunkBytes?: number | undefined;
    readonly maxRecordBytes?: number | undefined;
    readonly undoBudgetBytes?: number | undefined;
    readonly largeFileBytes?: number | undefined;
    /** Autosave: idle debounce under / over `largeFileBytes`, and the max interval when large. */
    readonly autosaveSmallMs?: number | undefined;
    readonly autosaveLargeMs?: number | undefined;
    readonly autosaveMaxMs?: number | undefined;
    /** false disables watching; a function replaces `fs.watch` (tests). */
    readonly watch?: WatchFn | false | undefined;
    /**
     * Unsaved edits were dropped because the file changed on disk (the service tells the user
     * when no pane is left to show the notice).
     */
    readonly onDiscarded?: ((document: CsvDocument, edits: number) => void) | undefined;
    readonly reattachDelayMs?: number | undefined;
    /** Coalescing delay for watcher events. */
    readonly diskCheckDelayMs?: number | undefined;
    readonly rawEditLimitBytes?: number | undefined;
    readonly findCap?: number | undefined;
}

interface Base extends WriterBase {
    fd: number;
    identity: FileIdentity;
    index: RowIndex;
    size: number;
    dataStart: number;
    trailingNewline: boolean;
    readonly epoch: number;
    refs: number;
    retired: boolean;
    /**
     * A sample of the indexed bytes (`./fingerprint.ts`): growth on the same inode is an append
     * only when every window still matches. Null when unknown (growth then reloads).
     */
    fingerprint: Fingerprint | null;
}

interface SaveState {
    job: AsyncSave | null;
    /** Ops applied to the live overlay since the snapshot (replayed after the rebase). */
    readonly log: AppliedOp[];
    readonly edits: number;
}

interface StructEntry {
    /** The generation number this op produced. */
    readonly n: number;
    readonly op:
        | { readonly kind: 'insert-rows'; readonly at: number; readonly count: number }
        | { readonly kind: 'delete-rows'; readonly start: number; readonly count: number }
        | { readonly kind: 'insert-column'; readonly id: number }
        | { readonly kind: 'delete-column'; readonly id: number };
}

/** How many structural ops a stale edit can be translated through. */
export const STRUCT_LOG_SIZE = 64;
const READ_BLOCK_BYTES = 1024 * 1024;
export const AUTOSAVE_SMALL_MS = 500;
export const AUTOSAVE_LARGE_MS = 5000;
export const AUTOSAVE_MAX_MS = 30_000;

let epochCounter = 0;

/** A record read for a logical row. */
export interface RecordRead {
    readonly parsed: ParsedRecord | null;
    readonly data: RowData | null;
    /** The record was longer than the read cap and was cut. */
    readonly cut: boolean;
}

/** One row of a view read, before the service adds its view index. */
export interface ViewRow {
    readonly row: number;
    readonly cells: string[];
    readonly truncated?: number[];
    readonly fieldCount: number;
}

/** Every edit op except undo/redo. */
type DataEditOp = Exclude<CsvEditOp, { op: 'undo' } | { op: 'redo' }>;

/**
 * One batch being applied. Ops go to a WORKING COPY of the overlay over a pinned base, so the
 * live overlay (what readers and a synchronous save see) only ever holds whole batches: a
 * failing op drops the copy, and nothing of the batch was ever applied.
 */
interface Batch {
    readonly overlay: Overlay;
    readonly base: Base;
    /** An op's inverse did not fit the undo budget: history is cleared when the batch commits. */
    noUndo: boolean;
    /** Every op applied, in order (replayed after a mid-batch rebase; logged for a running save). */
    readonly log: AppliedOp[];
    /** Structural ops, entered in the translation log when the batch commits. */
    readonly structs: StructEntry['op'][];
    /** An undo/redo entry failed to apply: history is cleared even though the batch is dropped. */
    historyBroken: boolean;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function cutUtf8(value: string, limit: number): string | null {
    if (value.length * 3 <= limit) return null;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= limit) return null;
    // Cut on a character boundary: decoding a cut slice drops a partial trailing character.
    const slice = Buffer.from(value, 'utf8').subarray(0, limit);
    const text = slice.toString('utf8');
    return text.endsWith('�') ? text.slice(0, -1) : text;
}

const approxBytes = (value: string): number => (value.length > 64 ? Buffer.byteLength(value, 'utf8') : value.length);

export class CsvDocument {
    readonly realpath: string;
    readonly extension: string;
    /** Pane ids attached (managed by the service). */
    readonly panes = new Set<string>();
    incarnation: string = randomUUID();
    /** Bumps on every content change (edits, reloads, appends); find indexes key on it. */
    revision = 0;
    base!: Base;
    dialect!: CsvDialect;
    /** Null until the first scan completes; reads use an identity view meanwhile. */
    overlay: Overlay | null = null;
    scanning: CsvScanProgress | null = null;
    loaded = false;
    fileReadOnly: CsvReadOnly | null = null;
    /** The pane that has this file open as raw text (⌘E), if any. */
    rawOwner: string | null = null;
    error: string | null = null;
    editsSinceSave = 0;
    closed = false;
    readonly findCache = new FindCache();
    /** Resolves when the current scan settles (immediately when there is none). */
    scanDone: Promise<void> = Promise.resolve();

    private generationN = 0;
    private structLog: StructEntry[] = [];
    private readonly history: UndoHistory;
    private saving: SaveState | null = null;
    private pendingSave = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private maxTimer: ReturnType<typeof setTimeout> | null = null;
    private scanAbort: { aborted: boolean } | null = null;
    /** The file grew while a scan ran: check it again once the scan ends. */
    private recheckAfterScan = false;
    private liveFields = 0;
    private queueTail: Promise<unknown> = Promise.resolve();
    private watcher: FileWatcher | null = null;
    private checkTimer: ReturnType<typeof setTimeout> | null = null;
    private notice: string | null = null;
    private noticeSeq = -1;
    /** Bumps on edits, reloads and appends: what ends a notice's life. */
    private changeSeq = 0;
    /** A notice an edit raised, published with the revision bump that follows it. */
    private setNoticeAfterBump: string | null = null;
    private readonly options: CsvDocumentOptions;
    private readonly chunkBytes: number;
    private readonly maxRecordBytes: number;
    private readonly largeFileBytes: number;

    private constructor(realpath: string, options: CsvDocumentOptions) {
        this.realpath = realpath;
        this.extension = extensionOf(realpath);
        this.options = options;
        this.chunkBytes = options.chunkBytes ?? SCAN_CHUNK_BYTES;
        this.maxRecordBytes = options.maxRecordBytes ?? CSV_LIMITS.maxRecordBytes;
        this.largeFileBytes = options.largeFileBytes ?? CSV_LIMITS.largeFileBytes;
        this.history = new UndoHistory(options.undoBudgetBytes ?? CSV_LIMITS.undoBudgetBytes);
    }

    /**
     * Open an already-opened file (the service resolved and opened it to key by realpath). On
     * failure the file is closed: nothing else holds `opened.fd`.
     */
    static async create(opened: OpenedCsvFile, options: CsvDocumentOptions): Promise<CsvDocument> {
        const document = new CsvDocument(opened.realpath, options);
        try {
            sweepOrphanTemps(opened.realpath);
        } catch (error) {
            options.onError?.(toError(error), `csv temp sweep ${opened.realpath}`);
        }
        try {
            await document.initialise(opened);
            document.startWatch();
        } catch (error) {
            const adopted = (document.base as Base | undefined)?.fd === opened.fd;
            document.close();
            if (!adopted) closeQuietly(opened.fd);
            throw error;
        }
        return document;
    }

    // ── state ────────────────────────────────────────────────────────────────────

    get generation(): string {
        return `${this.incarnation}:${String(this.generationN)}`;
    }

    get dirty(): boolean {
        return this.editsSinceSave > 0;
    }

    get isSaving(): boolean {
        return this.saving !== null;
    }

    get canUndo(): boolean {
        return this.history.canUndo;
    }

    get canRedo(): boolean {
        return this.history.canRedo;
    }

    get bytes(): number {
        return this.base.identity.size;
    }

    /** A notice lasts until the next edit or reload (a scan finishing does not clear it). */
    get currentNotice(): string | null {
        return this.notice !== null && this.noticeSeq === this.changeSeq ? this.notice : null;
    }

    /** Rows a reader may ask for (the last record of a running scan is not complete yet). */
    get rowCount(): number {
        if (this.overlay !== null) return this.overlay.rowCount;
        return Math.max(0, this.base.index.length - 1);
    }

    /** Display columns (an identity list while the first scan runs). */
    get columns(): readonly Column[] {
        if (this.overlay !== null) return this.overlay.columns;
        const count = Math.max(1, this.liveFields);
        const columns: Column[] = [];
        for (let i = 0; i < count; i += 1) columns.push({ id: i, base: i });
        return columns;
    }

    get rawEditable(): boolean {
        return this.overlay !== null && this.scanning === null && this.fileReadOnly === null &&
            this.rawOwner === null && this.bytes <= (this.options.rawEditLimitBytes ?? CSV_LIMITS.rawEditLimitBytes);
    }

    private setNotice(message: string): void {
        this.notice = message;
        this.noticeSeq = this.changeSeq;
    }

    private changed(change: CsvChange): void {
        if (this.closed) return;
        try {
            this.options.onChange(this, change);
        } catch (error) {
            this.report(error, 'csv change listener');
        }
    }

    private report(error: unknown, context: string): void {
        this.options.onError?.(toError(error), `${context} ${this.realpath}`);
    }

    /** Run `task` after everything queued before it. */
    enqueue<T>(task: () => Promise<T> | T): Promise<T> {
        const run = this.queueTail.then(() => task());
        this.queueTail = run.catch(() => undefined);
        return run;
    }

    // ── opening and scanning ─────────────────────────────────────────────────────

    private makeBase(opened: OpenedCsvFile, index: RowIndex, size: number, dataStart: number, trailingNewline: boolean): Base {
        epochCounter += 1;
        return {
            fd: opened.fd,
            identity: opened.identity,
            index,
            size,
            dataStart,
            trailingNewline,
            epoch: epochCounter,
            refs: 0,
            retired: false,
            fingerprint: null
        };
    }

    private retire(base: Base | undefined): void {
        if (base === undefined || base.retired) return;
        base.retired = true;
        if (base.refs === 0) closeQuietly(base.fd);
    }

    private acquire(): Base {
        const base = this.base;
        base.refs += 1;
        return base;
    }

    private release(base: Base): void {
        base.refs -= 1;
        if (base.refs === 0 && base.retired) closeQuietly(base.fd);
    }

    /** Read the head, detect the dialect, start the scan (not awaited). */
    private async initialise(opened: OpenedCsvFile): Promise<void> {
        const size = opened.identity.size;
        const head = Buffer.alloc(Math.min(size, SNIFF_BYTES + 4));
        const got = head.length > 0 ? await readAt(opened.fd, head, head.length, 0) : 0;
        const sample = head.subarray(0, got);
        const bom = detectBom(sample);
        const previous = this.base as Base | undefined;
        this.recheckAfterScan = false;
        if (bom.kind !== null && bom.kind !== 'utf8') {
            this.base = this.makeBase(opened, new RowIndex(), size, bom.length, true);
            this.retire(previous);
            this.dialect = { delimiter: this.extension === 'tsv' ? '\t' : ',', lineEnding: '\n', bom: false, quoteAll: false };
            this.fileReadOnly = { code: 'utf16', message: 'This file is UTF-16 or UTF-32 encoded; only UTF-8 csv files can be shown.' };
            this.overlay = Overlay.identity(0, 1);
            this.loaded = true;
            this.scanning = null;
            this.scanDone = Promise.resolve();
            return;
        }
        const dataStart = bom.length;
        this.dialect = sniffDialect(sample.subarray(dataStart), {
            extension: this.extension,
            bom: bom.kind === 'utf8',
            whole: got >= size
        });
        this.base = this.makeBase(opened, new RowIndex(), size, dataStart, true);
        this.retire(previous);
        this.overlay = null;
        this.liveFields = 0;
        this.loaded = size <= dataStart;
        this.scanDone = this.runScan(dataStart, size);
    }

    private async runScan(from: number, to: number): Promise<void> {
        const base = this.base;
        const signal = { aborted: false };
        if (this.scanAbort !== null) this.scanAbort.aborted = true;
        this.scanAbort = signal;
        this.scanning = { rows: 0, bytes: 0, totalBytes: Math.max(0, to - from) };
        this.changed('progress');
        // The fingerprint is taken from the bytes as they are scanned, never re-read afterwards.
        const fingerprint = new FingerprintBuilder(sampleRanges(from, to, true));
        try {
            const result = await scanFile({
                fd: base.fd,
                from,
                to,
                delimiter: this.dialect.delimiter,
                index: base.index,
                chunkSize: this.chunkBytes,
                maxRecordBytes: this.maxRecordBytes,
                signal,
                onChunk: (chunk, position) => fingerprint.feed(chunk, position),
                onProgress: (rows, bytes, maxFields) => {
                    if (signal.aborted || this.base !== base) return;
                    this.liveFields = Math.max(this.liveFields, maxFields);
                    this.scanning = { rows: Math.max(0, rows - 1), bytes, totalBytes: Math.max(0, to - from) };
                    this.loaded = true;
                    this.changed('progress');
                }
            });
            if (signal.aborted || this.base !== base || this.closed) return;
            base.trailingNewline = result.trailingNewline;
            base.size = to;
            base.fingerprint = fingerprint.finish();
            // The sniff sample may hold no terminator (a first record over 64 KiB): the scan saw it.
            if (result.firstLineEnding !== null && result.firstLineEnding !== this.dialect.lineEnding) {
                this.dialect = { ...this.dialect, lineEnding: result.firstLineEnding };
            }
            const fields = Math.max(1, result.maxFields);
            this.overlay = Overlay.identity(base.index.length, fields);
            this.applyScanVerdict(result.utf8, result.oversized);
            this.scanning = null;
            this.loaded = true;
            this.revision += 1;
            this.changed('loaded');
            this.afterScan();
        } catch (error) {
            if (error instanceof ScanCancelled || signal.aborted || this.base !== base) return;
            this.scanning = null;
            this.loaded = true;
            this.error = `Couldn't read ${path.basename(this.realpath)}: ${toError(error).message}`;
            this.overlay = Overlay.identity(base.index.length, Math.max(1, this.liveFields));
            this.fileReadOnly ??= { code: 'not-regular', message: this.error };
            this.changed('status');
            this.afterScan();
        } finally {
            if (this.scanAbort === signal) this.scanAbort = null;
        }
    }

    /** A growth seen while the scan ran was deferred to now (`checkDisk`). */
    private afterScan(): void {
        if (!this.recheckAfterScan) return;
        this.recheckAfterScan = false;
        this.requestDiskCheck();
    }

    private applyScanVerdict(utf8: boolean, oversized: boolean): void {
        if (oversized) {
            this.fileReadOnly = {
                code: 'oversized-record',
                message: `A record is over ${String(Math.round(this.maxRecordBytes / (1024 * 1024)))} MiB (probably an unbalanced quote), so the file is read-only.`
            };
        } else if (!utf8) {
            this.fileReadOnly = { code: 'not-utf8', message: 'This file is not valid UTF-8, so it is read-only.' };
        }
    }

    /** Append detected: index only the new bytes (the document is clean). */
    private async tailScan(now: fs.Stats): Promise<void> {
        const base = this.base;
        const overlay = this.overlay;
        if (overlay === null) return;
        const oldRows = base.index.length;
        const oldSize = base.size;
        let from = oldSize;
        if (!base.trailingNewline && oldRows > 0) {
            // The last record had no terminator, so the append continues it: rescan it whole.
            from = base.index.get(oldRows - 1);
            base.index.truncate(oldRows - 1);
        }
        base.identity = identityOf(now);
        const signal = { aborted: false };
        this.scanAbort = signal;
        this.scanning = { rows: oldRows, bytes: 0, totalBytes: now.size - from };
        this.changed('progress');
        const fingerprint = new FingerprintBuilder(sampleRanges(from, now.size, false));
        try {
            const result = await scanFile({
                fd: base.fd,
                from,
                to: now.size,
                delimiter: this.dialect.delimiter,
                index: base.index,
                chunkSize: this.chunkBytes,
                maxRecordBytes: this.maxRecordBytes,
                signal,
                onChunk: (chunk, position) => fingerprint.feed(chunk, position)
            });
            if (signal.aborted || this.base !== base || this.closed) return;
            base.size = now.size;
            base.trailingNewline = result.trailingNewline;
            const added = fingerprint.finish();
            base.fingerprint = added === null || base.fingerprint === null ? null : extendFingerprint(base.fingerprint, added);
            const newRows = base.index.length;
            const ids = overlay.columns.map(column => column.id);
            let next = overlay.nextColumnID;
            const fields = Math.max(ids.length, result.maxFields);
            while (ids.length < fields) ids.push(next++);
            const rebuilt = Overlay.identity(newRows, fields, ids, next);
            const addedColumns = fields - overlay.columns.length;
            this.overlay = rebuilt;
            if (newRows > oldRows) this.logStruct({ kind: 'insert-rows', at: oldRows, count: newRows - oldRows });
            for (let i = 0; i < addedColumns; i += 1) this.logStruct({ kind: 'insert-column', id: ids[ids.length - addedColumns + i] as number });
            this.applyScanVerdict(result.utf8, result.oversized);
            this.scanning = null;
            this.revision += 1;
            this.changeSeq += 1;
            this.findCache.clear();
            this.changed('structure');
        } catch (error) {
            if (error instanceof ScanCancelled || signal.aborted) return;
            this.scanning = null;
            this.report(error, 'csv tail scan');
            await this.reload();
        } finally {
            if (this.scanAbort === signal) this.scanAbort = null;
        }
    }

    // ── watching and external changes ────────────────────────────────────────────

    startWatch(): void {
        if (this.closed || this.options.watch === false || this.watcher !== null || this.rawOwner !== null) return;
        this.watcher = watchFile({
            path: this.realpath,
            onChange: () => this.requestDiskCheck(),
            ...(typeof this.options.watch === 'function' ? { watch: this.options.watch } : {}),
            ...(this.options.reattachDelayMs !== undefined ? { reattachDelayMs: this.options.reattachDelayMs } : {}),
            onError: (error, context) => this.options.onError?.(error, context)
        });
    }

    private stopWatch(): void {
        this.watcher?.close();
        this.watcher = null;
    }

    /** Watcher events (and a read that saw the base change) coalesce into one queued check. */
    requestDiskCheck(): void {
        if (this.closed || this.rawOwner !== null || this.checkTimer !== null) return;
        this.checkTimer = setTimeout(() => {
            this.checkTimer = null;
            void this.enqueue(() => this.checkDisk()).catch((error: unknown) => this.report(error, 'csv disk check'));
        }, this.options.diskCheckDelayMs ?? 30);
        this.checkTimer.unref?.();
    }

    /** Every byte indexed is still what was scanned (sampled: `./fingerprint.ts`). */
    private prefixUnchanged(base: Base): boolean {
        return base.fingerprint !== null && fingerprintMatches(base.fd, base.fingerprint);
    }

    /** Compare the base fd and the path with what was indexed; react (queued). */
    async checkDisk(): Promise<void> {
        if (this.closed || this.rawOwner !== null) return;
        const base = this.base;
        let fdStat: fs.Stats;
        try {
            fdStat = fs.fstatSync(base.fd);
        } catch (error) {
            this.report(error, 'csv fstat');
            return;
        }
        const pathStat = fs.statSync(this.realpath, { throwIfNoEntry: false });
        const was = base.identity;
        const inPlace = fdStat.size !== was.size || fdStat.mtimeMs !== was.mtimeMs;
        if (inPlace) {
            const grew = fdStat.size > was.size && pathStat?.ino === was.ino && pathStat.dev === was.dev;
            if (grew && this.scanning !== null) {
                // The scan stops at the size it started with. Restarting it on every append would
                // never let a file an agent keeps appending to finish indexing: look once it ends.
                this.recheckAfterScan = true;
                return;
            }
            const clean = this.editsSinceSave === 0 && this.saving === null;
            if (grew && clean && this.overlay !== null && this.prefixUnchanged(base)) await this.tailScan(fdStat);
            else await this.reloadDroppingEdits();
            return;
        }
        if (pathStat === undefined) {
            const message = `${path.basename(this.realpath)} was deleted or moved on disk.`;
            if (this.error !== message) {
                this.error = message;
                this.changed('status');
            }
            return;
        }
        if (pathStat.ino !== was.ino || pathStat.dev !== was.dev) {
            // Replaced by another file (an atomic save elsewhere). Unsaved edits win; a clean
            // document follows the new file.
            if (this.editsSinceSave > 0 || this.saving !== null) return;
            await this.reload();
            return;
        }
        if (this.error !== null && this.error.endsWith('was deleted or moved on disk.')) {
            this.error = null;
            this.changed('status');
        }
    }

    private async reloadDroppingEdits(): Promise<void> {
        const dropped = this.editsSinceSave;
        await this.reload();
        if (dropped > 0 && !this.closed) {
            this.setNotice(`The file changed on disk; ${String(dropped)} unsaved edit${dropped === 1 ? ' was' : 's were'} discarded.`);
            this.changed('status');
            try {
                this.options.onDiscarded?.(this, dropped);
            } catch (error) {
                this.report(error, 'csv discard listener');
            }
        }
    }

    /** Reopen the path from scratch: a new incarnation, edits and history dropped. */
    async reload(): Promise<void> {
        if (this.closed) return;
        if (this.scanAbort !== null) this.scanAbort.aborted = true;
        this.abortSave();
        this.clearSaveTimers();
        let opened: OpenedCsvFile;
        try {
            opened = openRealpathSync(this.realpath);
        } catch (error) {
            this.error = `Couldn't reopen ${path.basename(this.realpath)}: ${toError(error).message}`;
            this.changed('status');
            return;
        }
        this.incarnation = randomUUID();
        this.generationN = 0;
        this.structLog = [];
        this.history.clear();
        this.editsSinceSave = 0;
        this.fileReadOnly = null;
        this.error = null;
        this.findCache.clear();
        this.revision += 1;
        this.changeSeq += 1;
        await this.initialise(opened);
        this.changed('reload');
    }

    // ── reads ────────────────────────────────────────────────────────────────────

    /** The overlay to read through: the live one, or an identity view while scanning. */
    private readOverlay(): Overlay {
        return this.overlay ?? Overlay.identity(this.rowCount, this.columns.length);
    }

    /** A read noticed the base fd changed under it: check (queued, coalesced). */
    private verifyBase(base: Base): void {
        try {
            const now = fs.fstatSync(base.fd);
            if (now.size !== base.identity.size || now.mtimeMs !== base.identity.mtimeMs) this.requestDiskCheck();
        } catch {
            // A retired fd; nothing to check.
        }
    }

    private recordEnd(base: Base, row: number): number {
        return row + 1 < base.index.length ? base.index.get(row + 1) : base.size;
    }

    /** Read and parse base records `rows` (sorted ascending, unique) from `base`. */
    private async readBaseRecords(base: Base, rows: readonly number[]): Promise<Map<number, { parsed: ParsedRecord; cut: boolean }>> {
        const out = new Map<number, { parsed: ParsedRecord; cut: boolean }>();
        const delimiter = this.dialect.delimiter;
        const cap = this.maxRecordBytes;
        let i = 0;
        while (i < rows.length) {
            const first = rows[i] as number;
            const start = base.index.get(first);
            let last = i;
            // Extend the block over consecutive rows while it stays under the block size.
            while (last + 1 < rows.length && rows[last + 1] === (rows[last] as number) + 1 &&
                this.recordEnd(base, rows[last + 1] as number) - start <= READ_BLOCK_BYTES) last += 1;
            const lastRow = rows[last] as number;
            const fullEnd = this.recordEnd(base, lastRow);
            const end = last === i ? Math.min(fullEnd, start + cap) : fullEnd;
            const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
            let got = 0;
            while (got < buffer.length) {
                const n = await readAt(base.fd, buffer.subarray(got), buffer.length - got, start + got);
                if (n <= 0) break;
                got += n;
            }
            const block = buffer.subarray(0, got);
            for (let k = i; k <= last; k += 1) {
                const row = rows[k] as number;
                const from = base.index.get(row) - start;
                const to = Math.min(this.recordEnd(base, row) - start, block.length);
                const text = from < to ? block.toString('utf8', from, to) : '';
                out.set(row, { parsed: parseRecord(stripTerminator(text), delimiter), cut: last === i && end < fullEnd });
            }
            i = last + 1;
        }
        return out;
    }

    /** Records for logical rows (any order) of `overlay`, whose base is `base` (pinned by the caller). */
    private async readRecords(base: Base, overlay: Overlay, rows: readonly number[]): Promise<RecordRead[]> {
        const resolved = rows.map(row => overlay.resolve(row));
        const needed = new Set<number>();
        for (const entry of resolved) {
            const baseRow = entry.kind === 'base' ? entry.base : entry.data.base;
            if (baseRow >= 0) needed.add(baseRow);
        }
        const records = await this.readBaseRecords(base, [...needed].sort((a, b) => a - b));
        return resolved.map((entry): RecordRead => {
            const data = entry.kind === 'row' ? entry.data : null;
            const baseRow = entry.kind === 'base' ? entry.base : entry.data.base;
            const record = baseRow >= 0 ? records.get(baseRow) : undefined;
            return { parsed: record?.parsed ?? null, data, cut: record?.cut ?? false };
        });
    }

    /**
     * Records for logical rows (any order) through `overlay` (default: the live one). The base is
     * taken in the same synchronous step as the overlay, so the two always belong together.
     */
    async readLogical(rows: readonly number[], overlay: Overlay = this.readOverlay()): Promise<RecordRead[]> {
        const base = this.acquire();
        try {
            this.verifyBase(base);
            return await this.readRecords(base, overlay, rows);
        } finally {
            this.release(base);
        }
    }

    /**
     * Rows for a pane's view: `logical[i]` is the logical row at view `start + i`. Stops adding
     * rows once `budget` cell bytes (plus a little JSON overhead per cell) are used. The columns
     * (and the ids returned with the rows) come from the same overlay the records were read
     * through, so a save or column edit landing during the read cannot shift cells under them.
     */
    async readView(
        logical: readonly number[],
        columnStart: number,
        columnCount: number,
        budget: number
    ): Promise<{ readonly columnIDs: number[]; readonly rows: ViewRow[] }> {
        const overlay = this.readOverlay();
        const columns = overlay.columns;
        const window = columns.slice(columnStart, columnStart + columnCount);
        const identity = overlay.identityColumns();
        const positions = new Map<number, number>();
        columns.forEach((column, i) => positions.set(column.id, i));
        const reads = await this.readLogical(logical, overlay);
        const limit = CSV_LIMITS.truncatedCellBytes;
        const out: ViewRow[] = [];
        let used = 0;
        for (let r = 0; r < reads.length; r += 1) {
            const { parsed, data, cut } = reads[r] as RecordRead;
            const cells: string[] = new Array<string>(window.length);
            let truncated: number[] | undefined;
            let bytes = 0;
            for (let c = 0; c < window.length; c += 1) {
                const column = window[c] as Column;
                let value = data?.cells?.get(column.id) ?? (parsed !== null && column.base !== null ? parsed.fields[column.base] ?? '' : '');
                const shortened = cutUtf8(value, limit);
                if (shortened !== null) {
                    value = shortened;
                    (truncated ??= []).push(c);
                } else if (cut && parsed !== null && column.base !== null && column.base === parsed.fields.length - 1) {
                    (truncated ??= []).push(c);
                }
                cells[c] = value;
                bytes += approxBytes(value) + 4;
            }
            let fieldCount: number;
            if (parsed !== null && parsed.fields.length === 0 && (data?.cells ?? null) === null) fieldCount = 0;
            else if (identity && parsed !== null) {
                fieldCount = parsed.fields.length;
                if (data?.cells) for (const id of data.cells.keys()) {
                    const position = positions.get(id);
                    if (position !== undefined) fieldCount = Math.max(fieldCount, position + 1);
                }
            } else fieldCount = columns.length;
            if (out.length > 0 && used + bytes > budget) break;
            used += bytes;
            out.push({ row: logical[r] as number, cells, ...(truncated ? { truncated } : {}), fieldCount });
        }
        return { columnIDs: window.map(column => column.id), rows: out };
    }

    /** One column's values for logical rows `[start, start + count)` (sort keys). */
    async columnValues(columnID: number, start: number, count: number): Promise<string[]> {
        const overlay = this.readOverlay();
        const base = this.acquire();
        try {
            return await this.columnValuesOf(base, overlay, columnID, start, count);
        } finally {
            this.release(base);
        }
    }

    /** `columnValues` through `overlay` over `base` (pinned by the caller; also undo capture). */
    private async columnValuesOf(base: Base, overlay: Overlay, columnID: number, start: number, count: number): Promise<string[]> {
        const column = overlay.column(columnID) ?? (overlay.deletedColumns.has(columnID) ? { id: columnID, base: overlay.deletedColumns.get(columnID) ?? null } : null);
        if (column === null) throw csvError('CSV_GONE', `column ${String(columnID)} no longer exists`);
        const runs = [...overlay.runs(start, count)];
        const values: string[] = [];
        const delimiter = this.dialect.delimiter;
        for (const run of runs) {
            if (run.kind === 'base') {
                if (column.base === null) {
                    for (let i = 0; i < run.count; i += 1) values.push('');
                    continue;
                }
                let row = run.start;
                const end = run.start + run.count;
                while (row < end) {
                    const blockStart = base.index.get(row);
                    let last = row;
                    while (last + 1 < end && this.recordEnd(base, last + 1) - blockStart <= READ_BLOCK_BYTES) last += 1;
                    const blockEnd = Math.min(this.recordEnd(base, last), blockStart + Math.max(READ_BLOCK_BYTES, this.maxRecordBytes));
                    const buffer = Buffer.allocUnsafe(blockEnd - blockStart);
                    let got = 0;
                    while (got < buffer.length) {
                        const n = await readAt(base.fd, buffer.subarray(got), buffer.length - got, blockStart + got);
                        if (n <= 0) break;
                        got += n;
                    }
                    for (let r = row; r <= last; r += 1) {
                        const from = base.index.get(r) - blockStart;
                        const to = Math.min(this.recordEnd(base, r) - blockStart, got);
                        values.push(from < to ? extractField(stripTerminator(buffer.toString('utf8', from, to)), delimiter, column.base) : '');
                    }
                    row = last + 1;
                }
                continue;
            }
            const data = run.data;
            const override = data.cells?.get(columnID);
            if (override !== undefined) {
                values.push(override);
                continue;
            }
            if (data.base < 0 || column.base === null) {
                values.push('');
                continue;
            }
            const record = (await this.readBaseRecords(base, [data.base])).get(data.base);
            values.push(record?.parsed.fields[column.base] ?? '');
        }
        return values;
    }

    // ── find ─────────────────────────────────────────────────────────────────────

    /**
     * The match index for `query` at the current revision (built once, shared). A build the
     * document keeps changing under is retried twice, then returned with `complete: false`.
     */
    async find(query: string): Promise<FindIndex> {
        await this.scanDone;
        for (let attempt = 0; ; attempt += 1) {
            const revision = this.revision;
            const cached = this.findCache.get(query, revision);
            if (cached !== null) return cached;
            const build = this.findCache.building(query, revision) ??
                this.findCache.track(query, revision, this.buildFind(query, revision));
            const index = await build;
            if (index.revision === this.revision || attempt >= 2) {
                if (index.revision === this.revision) this.findCache.set(index);
                return index;
            }
        }
    }

    private async buildFind(query: string, revision: number): Promise<FindIndex> {
        const collector = new MatchCollector(this.options.findCap ?? CSV_LIMITS.maxFindMatches);
        const needle = needleOf(query);
        if (needle === '' || this.overlay === null) return collector.finish(query, revision);
        const overlay = this.overlay;
        const columns = overlay.columns.slice();
        const delimiter = this.dialect.delimiter;
        // A raw-text prefilter skips blocks that cannot match. It is exact only when the needle
        // cannot be split by quoting or record structure.
        const prefilter = !/["\r\n]/.test(needle) && !needle.includes(delimiter);
        const base = this.acquire();
        try {
            const runs = [...overlay.runs(0, overlay.rowCount)];
            const matchRow = (row: number, parsed: ParsedRecord | null, data: RowData | null): boolean => {
                for (const column of columns) {
                    const value = data?.cells?.get(column.id) ?? (parsed !== null && column.base !== null ? parsed.fields[column.base] ?? '' : '');
                    if (cellMatches(value, needle) && !collector.add(row, column.id)) return false;
                }
                return true;
            };
            let stale = false;
            for (const run of runs) {
                if (this.revision !== revision || this.closed) {
                    stale = true;
                    break;
                }
                if (run.kind === 'row') {
                    const data = run.data;
                    const parsed = data.base >= 0 ? ((await this.readBaseRecords(base, [data.base])).get(data.base)?.parsed ?? null) : null;
                    if (!matchRow(run.logical, parsed, data)) break;
                    continue;
                }
                let row = run.start;
                const end = run.start + run.count;
                let stop = false;
                while (row < end && !stop) {
                    if (this.revision !== revision || this.closed) {
                        stale = true;
                        break;
                    }
                    const blockStart = base.index.get(row);
                    let last = row;
                    while (last + 1 < end && this.recordEnd(base, last + 1) - blockStart <= READ_BLOCK_BYTES) last += 1;
                    // A single record is read up to the record cap (an unbalanced quote can make
                    // one "record" the whole file; such files are read-only and cut here).
                    const blockEnd = Math.min(this.recordEnd(base, last), blockStart + Math.max(READ_BLOCK_BYTES, this.maxRecordBytes));
                    const buffer = Buffer.allocUnsafe(blockEnd - blockStart);
                    let got = 0;
                    while (got < buffer.length) {
                        const n = await readAt(base.fd, buffer.subarray(got), buffer.length - got, blockStart + got);
                        if (n <= 0) break;
                        got += n;
                    }
                    const text = buffer.toString('utf8', 0, got);
                    if (!prefilter || text.toLowerCase().includes(needle)) {
                        for (let r = row; r <= last; r += 1) {
                            const from = base.index.get(r) - blockStart;
                            const to = Math.min(this.recordEnd(base, r) - blockStart, got);
                            const parsed = parseRecord(stripTerminator(from < to ? buffer.toString('utf8', from, to) : ''), delimiter);
                            if (!matchRow(run.logical + (r - run.start), parsed, null)) {
                                stop = true;
                                break;
                            }
                        }
                    }
                    row = last + 1;
                }
                if (stop || stale) break;
            }
            return collector.finish(query, revision, !stale);
        } finally {
            this.release(base);
        }
    }

    // ── edits ────────────────────────────────────────────────────────────────────

    private assertEditable(): Overlay {
        if (this.closed) throw new Error('csv document is closed');
        if (this.overlay === null || this.scanning !== null) throw csvError('CSV_BUSY', 'The file is still being indexed.');
        if (this.rawOwner !== null) throw csvError('CSV_READ_ONLY', 'This file is open as raw text in another pane.');
        if (this.fileReadOnly !== null) throw csvError('CSV_READ_ONLY', this.fileReadOnly.message);
        return this.overlay;
    }

    private logStruct(op: StructEntry['op']): void {
        this.generationN += 1;
        this.structLog.push({ n: this.generationN, op });
        if (this.structLog.length > STRUCT_LOG_SIZE) this.structLog.shift();
    }

    /** Translate a row through structural ops in `(from, to]`. null = the row was deleted. */
    private translateRow(row: number, entries: readonly StructEntry[], insertionPoint: boolean): number | null {
        let current = row;
        for (const { op } of entries) {
            if (op.kind === 'insert-rows') {
                // A row at or after the insertion point moved down; so does an insertion point
                // (a concurrent insert at the same place lands first).
                if (current >= op.at) current += op.count;
            } else if (op.kind === 'delete-rows') {
                if (current >= op.start + op.count) current -= op.count;
                else if (current >= op.start) {
                    if (!insertionPoint) return null;
                    current = op.start;
                }
            }
        }
        return current;
    }

    private columnDeleted(column: number, entries: readonly StructEntry[]): boolean {
        return entries.some(entry => entry.op.kind === 'delete-column' && entry.op.id === column);
    }

    /** Bring an op computed at generation `from` forward to `to` (the batch's start). */
    private translate(op: DataEditOp, from: number, to: number): DataEditOp {
        if (from === to) return op;
        const entries = this.structLog.filter(entry => entry.n > from && entry.n <= to);
        if (entries.length !== to - from) throw csvError('CSV_STALE', 'The edit is too old to apply; reload the rows and try again.');
        const gone = (): Error => csvError('CSV_GONE', 'The row or column this edit targets was deleted.');
        switch (op.op) {
            case 'set-cell': {
                if (this.columnDeleted(op.column, entries)) throw gone();
                const row = this.translateRow(op.row, entries, false);
                if (row === null) throw gone();
                return { ...op, row };
            }
            case 'insert-rows': {
                const at = this.translateRow(op.at, entries, true) as number;
                return { ...op, at };
            }
            case 'delete-rows': {
                const first = this.translateRow(op.start, entries, false);
                const last = this.translateRow(op.start + op.count - 1, entries, false);
                if (first === null || last === null || last - first !== op.count - 1) throw gone();
                return { ...op, start: first };
            }
            case 'delete-column':
                if (this.columnDeleted(op.column, entries)) throw gone();
                return op;
            default:
                return op;
        }
    }

    private parseGeneration(generation: string): number {
        const colon = generation.lastIndexOf(':');
        const incarnation = colon > 0 ? generation.slice(0, colon) : '';
        const n = Number(generation.slice(colon + 1));
        if (colon <= 0 || !Number.isSafeInteger(n) || n < 0) throw csvError('CSV_INVALID', 'generation is malformed');
        if (incarnation !== this.incarnation) throw csvError('CSV_STALE', 'The file was reloaded since these rows were read.');
        if (n > this.generationN) throw csvError('CSV_STALE', 'generation is from the future');
        return n;
    }

    /** The current value and the base record's value of one cell, in the batch's working copy. */
    private async cellValues(batch: Batch, row: number, column: Column): Promise<{ current: string; baseValue: string }> {
        const [read] = await this.readRecords(batch.base, batch.overlay, [row]);
        const parsed = read?.parsed ?? null;
        const baseValue = parsed !== null && column.base !== null ? parsed.fields[column.base] ?? '' : '';
        const current = read?.data?.cells?.get(column.id) ?? baseValue;
        return { current, baseValue };
    }

    /** Rows `[start, start + count)` as standalone rows (a delete's inverse). */
    private async materialiseRows(batch: Batch, start: number, count: number): Promise<RowData[]> {
        const overlay = batch.overlay;
        const rows: number[] = [];
        for (let r = start; r < start + count; r += 1) rows.push(r);
        const reads = await this.readRecords(batch.base, overlay, rows);
        const columns: Column[] = [...overlay.columns];
        for (const [id, baseIndex] of overlay.deletedColumns) columns.push({ id, base: baseIndex });
        return reads.map(({ parsed, data }) => {
            const cells = new Map<number, string>();
            const quoted = new Set<number>();
            for (const column of columns) {
                const value = data?.cells?.get(column.id) ?? (parsed !== null && column.base !== null ? parsed.fields[column.base] ?? '' : '');
                if (value !== '') cells.set(column.id, value);
                if ((parsed !== null && column.base !== null && parsed.quoted[column.base] === true) || data?.quoted?.has(column.id) === true) quoted.add(column.id);
            }
            if (cells.size === 0 && quoted.size === 0) return EMPTY_ROW;
            return { base: -1, cells: cells.size > 0 ? cells : null, quoted: quoted.size > 0 ? quoted : null };
        });
    }

    private estimateRows(batch: Batch, start: number, count: number): number {
        const { overlay, base } = batch;
        let bytes = 0;
        for (const run of overlay.runs(start, count)) {
            if (run.kind === 'base') {
                bytes += (this.recordEnd(base, run.start + run.count - 1) - base.index.get(run.start)) * 2 + run.count * 96;
            } else {
                bytes += 96;
                if (run.data.cells) for (const value of run.data.cells.values()) bytes += value.length * 2 + 56;
                if (run.data.base >= 0) bytes += (this.recordEnd(base, run.data.base) - base.index.get(run.data.base)) * 2;
            }
        }
        return bytes;
    }

    /** Turn a client op (already translated) into its concrete, replayable form. */
    private concrete(op: DataEditOp, batch: Batch): AppliedOp {
        const overlay = batch.overlay;
        switch (op.op) {
            case 'set-cell':
                return op;
            case 'insert-rows': {
                const ids = overlay.columns.map(column => column.id);
                const rows: RowData[] = [];
                for (let i = 0; i < op.count; i += 1) {
                    const values = op.rows?.[i];
                    if (values !== undefined && values.length > ids.length) {
                        throw csvError('CSV_INVALID', 'insert-rows row has more cells than the file has columns');
                    }
                    // Blank rows are all one shared frozen row (`EMPTY_ROW`), not one object each.
                    rows.push(values === undefined ? EMPTY_ROW : newRow(values, ids));
                }
                return { op: 'insert-rows', at: op.at, rows };
            }
            case 'delete-rows':
                return op;
            case 'insert-column':
                return { op: 'insert-column', at: op.at, id: overlay.nextColumnID, base: null, epoch: batch.base.epoch, values: null };
            case 'delete-column':
                return { op: 'delete-column', id: op.column };
        }
    }

    /**
     * Apply one concrete op to the batch's working copy. Returns its inverse when asked (null when
     * the inverse would not fit the undo budget: `batch.noUndo` is set).
     */
    private async applyOp(op: AppliedOp, wantInverse: boolean, batch: Batch): Promise<AppliedOp | null> {
        let inverse: AppliedOp | null = null;
        const overlay = batch.overlay;
        switch (op.op) {
            case 'set-cell': {
                if (op.row >= overlay.rowCount) throw csvError('CSV_INVALID', `row ${String(op.row)} is out of range`);
                const column = overlay.column(op.column);
                if (column === null) {
                    throw op.column < overlay.nextColumnID
                        ? csvError('CSV_GONE', `column ${String(op.column)} was deleted`)
                        : csvError('CSV_INVALID', `column ${String(op.column)} does not exist`);
                }
                const { current, baseValue } = await this.cellValues(batch, op.row, column);
                overlay.setCell(op.row, op.column, op.value, baseValue);
                if (wantInverse) inverse = { op: 'set-cell', row: op.row, column: op.column, value: current };
                break;
            }
            case 'insert-rows': {
                if (op.at > overlay.rowCount) throw csvError('CSV_INVALID', `row ${String(op.at)} is out of range`);
                // Shared, not copied: the overlay copies a row before it changes one.
                overlay.insertRows(op.at, op.rows);
                batch.structs.push({ kind: 'insert-rows', at: op.at, count: op.rows.length });
                if (wantInverse) inverse = { op: 'delete-rows', start: op.at, count: op.rows.length };
                break;
            }
            case 'delete-rows': {
                if (op.start + op.count > overlay.rowCount) throw csvError('CSV_INVALID', 'delete-rows range is out of range');
                if (wantInverse && !batch.noUndo) {
                    if (this.estimateRows(batch, op.start, op.count) > this.history.budget) batch.noUndo = true;
                    else inverse = { op: 'insert-rows', at: op.start, rows: await this.materialiseRows(batch, op.start, op.count) };
                }
                overlay.deleteRows(op.start, op.count);
                batch.structs.push({ kind: 'delete-rows', start: op.start, count: op.count });
                break;
            }
            case 'insert-column': {
                if (op.at > overlay.columns.length) throw csvError('CSV_INVALID', `column position ${String(op.at)} is out of range`);
                if (overlay.column(op.id) !== null) throw csvError('CSV_INVALID', `column ${String(op.id)} already exists`);
                if (op.epoch === batch.base.epoch || op.values === null) {
                    overlay.insertColumn(op.at, { id: op.id, base: op.epoch === batch.base.epoch ? op.base : null });
                } else {
                    overlay.insertColumn(op.at, { id: op.id, base: null });
                    const rows = Math.min(op.values.length, overlay.rowCount);
                    for (let row = 0; row < rows; row += 1) {
                        const value = op.values[row] as string;
                        if (value !== '') overlay.setCell(row, op.id, value, '');
                    }
                }
                batch.structs.push({ kind: 'insert-column', id: op.id });
                if (wantInverse) inverse = { op: 'delete-column', id: op.id };
                break;
            }
            case 'delete-column': {
                const column = overlay.column(op.id);
                if (column === null) {
                    throw op.id < overlay.nextColumnID
                        ? csvError('CSV_GONE', `column ${String(op.id)} was deleted`)
                        : csvError('CSV_INVALID', `column ${String(op.id)} does not exist`);
                }
                const at = overlay.columnPosition(op.id);
                if (wantInverse && !batch.noUndo) {
                    if (batch.base.size * 2 + overlay.materialisedRows() * 64 > this.history.budget) batch.noUndo = true;
                    else {
                        const values = await this.columnValuesOf(batch.base, overlay, op.id, 0, overlay.rowCount);
                        inverse = { op: 'insert-column', at, id: op.id, base: column.base, epoch: batch.base.epoch, values };
                    }
                }
                overlay.deleteColumn(op.id);
                batch.structs.push({ kind: 'delete-column', id: op.id });
                break;
            }
        }
        batch.log.push(op);
        return inverse;
    }

    /** Replay a logged op onto a freshly rebased overlay (no reads: pure). */
    private static replay(overlay: Overlay, op: AppliedOp, epoch: number): void {
        switch (op.op) {
            case 'set-cell':
                overlay.setCell(op.row, op.column, op.value, undefined);
                return;
            case 'insert-rows':
                overlay.insertRows(op.at, op.rows);
                return;
            case 'delete-rows':
                overlay.deleteRows(op.start, op.count);
                return;
            case 'insert-column':
                if (op.epoch === epoch) {
                    overlay.insertColumn(op.at, { id: op.id, base: op.base });
                    return;
                }
                overlay.insertColumn(op.at, { id: op.id, base: null });
                if (op.values !== null) {
                    const rows = Math.min(op.values.length, overlay.rowCount);
                    for (let row = 0; row < rows; row += 1) {
                        const value = op.values[row] as string;
                        if (value !== '') overlay.setCell(row, op.id, value, '');
                    }
                }
                return;
            case 'delete-column':
                overlay.deleteColumn(op.id);
                return;
        }
    }

    private isStructural(op: AppliedOp): boolean {
        return op.op !== 'set-cell';
    }

    /**
     * Apply a client batch in order (queued). `generation` is the one the batch was computed
     * against; a stale batch is translated or refused. The batch is ATOMIC: it runs on a working
     * copy of the overlay, and a failing op drops the copy, so nothing of it is applied, the
     * undo history is as it was and no save sees part of it.
     */
    edit(generation: string, ops: readonly CsvEditOp[]): Promise<void> {
        return this.enqueue(async () => {
            const committed = this.assertEditable();
            const from = this.parseGeneration(generation);
            const to = this.generationN;
            const base = this.acquire();
            const batch: Batch = { overlay: committed.clone(), base, noUndo: false, log: [], structs: [], historyBroken: false };
            // Only undo/redo touch the history before the batch commits.
            const history: HistorySnapshot | null = ops.some(op => op.op === 'undo' || op.op === 'redo') ? this.history.snapshot() : null;
            const applied: { forward: AppliedOp; inverse: AppliedOp | null }[] = [];
            let changes = 0;
            let structural = false;
            try {
                for (const op of ops) {
                    if (op.op === 'undo' || op.op === 'redo') {
                        const moved = op.op === 'undo' ? await this.undoOnce(batch) : await this.redoOnce(batch);
                        if (moved !== null) {
                            changes += 1;
                            structural ||= moved;
                        }
                        continue;
                    }
                    const forward = this.concrete(this.translate(op, from, to), batch);
                    const inverse = await this.applyOp(forward, true, batch);
                    applied.push({ forward, inverse });
                    structural ||= this.isStructural(forward);
                }
                if (this.closed) throw new Error('csv document is closed');
            } catch (error) {
                if (history !== null) this.history.restore(history);
                if (batch.historyBroken) {
                    this.history.clear();
                    this.changed('status');
                }
                throw error;
            } finally {
                this.release(base);
            }
            this.commit(batch);
            if (applied.length > 0) {
                changes += applied.length;
                if (batch.noUndo) {
                    this.history.clear();
                    this.setNoticeAfterBump = 'That change was too large to undo, so undo history was cleared.';
                } else {
                    const forward = applied.map(step => step.forward);
                    const inverse = applied.map(step => step.inverse as AppliedOp).reverse();
                    if (!this.history.push({ forward, inverse, bytes: entryBytes(forward, inverse) })) {
                        this.setNoticeAfterBump = 'That change was too large to undo, so undo history was cleared.';
                    }
                }
            }
            if (changes > 0) this.afterEdit(changes, structural);
        });
    }

    /** Make a finished batch live (synchronous: nothing can see half of it). */
    private commit(batch: Batch): void {
        if (this.base === batch.base) {
            this.overlay = batch.overlay;
        } else {
            // A synchronous save (pane close, quit, SIGTERM) wrote the committed state and rebased
            // while this batch was reading: its ops are pure, so they replay onto the new overlay
            // (a copy: readers may hold the live one, which is never changed in place).
            const overlay = (this.overlay as Overlay).clone();
            for (const op of batch.log) CsvDocument.replay(overlay, op, this.base.epoch);
            this.overlay = overlay;
        }
        for (const op of batch.structs) this.logStruct(op);
        // A running async save wrote the state before this batch: replay it after the rebase.
        if (this.saving !== null) for (const op of batch.log) this.saving.log.push(op);
    }

    /** Undo one entry. Returns whether it was structural, or null when there was nothing. */
    private async undoOnce(batch: Batch): Promise<boolean | null> {
        const entry = this.history.takeUndo();
        if (entry === null) return null;
        try {
            for (const op of entry.inverse) await this.applyOp(op, false, batch);
        } catch (error) {
            batch.historyBroken = true;
            throw error;
        }
        this.history.undone(entry);
        return entry.inverse.some(op => this.isStructural(op));
    }

    private async redoOnce(batch: Batch): Promise<boolean | null> {
        const entry = this.history.takeRedo();
        if (entry === null) return null;
        try {
            for (const op of entry.forward) await this.applyOp(op, false, batch);
        } catch (error) {
            batch.historyBroken = true;
            throw error;
        }
        this.history.redone(entry);
        return entry.forward.some(op => this.isStructural(op));
    }

    private afterEdit(changes: number, structural: boolean): void {
        this.editsSinceSave += changes;
        this.revision += 1;
        this.changeSeq += 1;
        this.findCache.clear();
        if (this.setNoticeAfterBump !== null) {
            this.setNotice(this.setNoticeAfterBump);
            this.setNoticeAfterBump = null;
        }
        this.scheduleSave();
        this.changed(structural ? 'structure' : 'content');
    }

    // ── saving ───────────────────────────────────────────────────────────────────

    private clearSaveTimers(): void {
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        if (this.maxTimer !== null) clearTimeout(this.maxTimer);
        this.saveTimer = null;
        this.maxTimer = null;
    }

    /** Autosave: 500 ms idle under `largeFileBytes`; 5 s idle with a 30 s cap above it. */
    scheduleSave(): void {
        if (this.closed || this.editsSinceSave === 0 || this.rawOwner !== null) return;
        const large = this.bytes >= this.largeFileBytes;
        const delay = large ? (this.options.autosaveLargeMs ?? AUTOSAVE_LARGE_MS) : (this.options.autosaveSmallMs ?? AUTOSAVE_SMALL_MS);
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.startSave();
        }, delay);
        this.saveTimer.unref?.();
        if (large && this.maxTimer === null) {
            this.maxTimer = setTimeout(() => {
                this.maxTimer = null;
                void this.startSave();
            }, this.options.autosaveMaxMs ?? AUTOSAVE_MAX_MS);
            this.maxTimer.unref?.();
        }
    }

    private target(base: Base): { realpath: string; baseFd: number; baseIdentity: FileIdentity } {
        return { realpath: this.realpath, baseFd: base.fd, baseIdentity: base.identity };
    }

    /** Start an async save now (queued so it never splits an edit). Resolves once started. */
    startSave(): Promise<void> {
        return this.enqueue(() => {
            this.beginSave();
        });
    }

    private savePromise: Promise<void> | null = null;

    private beginSave(): void {
        this.clearSaveTimers();
        if (this.closed || this.rawOwner !== null || this.overlay === null || this.scanning !== null) return;
        if (this.saving !== null) {
            this.pendingSave = true;
            return;
        }
        if (this.editsSinceSave === 0) return;
        const snapshot = this.overlay;
        this.overlay = snapshot.clone();
        const state: SaveState = { job: null, log: [], edits: this.editsSinceSave };
        this.saving = state;
        // Pinned: the writer reads the base fd until the job settles, whatever happens meanwhile.
        const base = this.acquire();
        const job = saveAsync({ base, overlay: snapshot, dialect: this.dialect, chunkBytes: this.chunkBytes }, this.target(base));
        state.job = job;
        this.changed('status');
        this.savePromise = job.done.then(
            result => this.enqueue(() => this.finishSave(state, result)),
            (error: unknown) => this.enqueue(() => this.failSave(state, error))
        ).finally(() => this.release(base));
    }

    /** Resolves when no save is running (immediately when none is). */
    async whenSaved(): Promise<void> {
        while (this.savePromise !== null && this.saving !== null) await this.savePromise;
    }

    private swapBase(result: SaveResult): Base {
        const old = this.base;
        const base = this.makeBase(result.opened, result.output.index, result.output.size, old.dataStart, result.output.trailingNewline);
        base.fingerprint = readFingerprint(base.fd, sampleRanges(base.dataStart, base.size, true));
        this.base = base;
        this.retire(old);
        return base;
    }

    private async finishSave(state: SaveState, result: SaveResult): Promise<void> {
        if (this.saving !== state || this.closed) {
            closeQuietly(result.opened.fd);
            return;
        }
        this.saving = null;
        if (result.raced) {
            // Something replaced the file between our rename and reopen: follow the disk.
            closeQuietly(result.opened.fd);
            await this.reloadDroppingEdits();
            return;
        }
        const base = this.swapBase(result);
        const overlay = Overlay.identity(result.output.index.length, result.output.columnIDs.length, result.output.columnIDs, result.output.nextColumnID);
        for (const op of state.log) CsvDocument.replay(overlay, op, base.epoch);
        this.overlay = overlay;
        this.editsSinceSave = Math.max(0, this.editsSinceSave - state.edits);
        this.error = null;
        this.changed('status');
        if (this.pendingSave || this.editsSinceSave > 0) {
            this.pendingSave = false;
            this.scheduleSave();
        }
    }

    private async failSave(state: SaveState, error: unknown): Promise<void> {
        if (this.saving !== state) return;
        this.saving = null;
        this.pendingSave = false;
        if (error instanceof CsvSaveAborted) return;
        if (error instanceof CsvSaveConflict && error.kind === 'base-modified') {
            await this.reloadDroppingEdits();
            return;
        }
        this.error = `Couldn't save ${path.basename(this.realpath)}: ${toError(error).message}`;
        this.report(error, 'csv save');
        this.changed('status');
    }

    private abortSave(): void {
        const state = this.saving;
        if (state === null) return;
        this.saving = null;
        state.job?.abort();
    }

    /**
     * Save NOW, synchronously (SIGTERM, a small file's close, the raw hand-off). Aborts an async
     * save first; the live overlay already holds everything it was writing plus what came after.
     * Throws when the save fails (the document stays dirty).
     */
    saveNowSync(): void {
        if (this.closed || this.overlay === null) return;
        this.abortSave();
        this.clearSaveTimers();
        if (this.editsSinceSave === 0) return;
        let result: SaveResult;
        try {
            result = saveSync({ base: this.base, overlay: this.overlay, dialect: this.dialect, chunkBytes: this.chunkBytes }, this.target(this.base));
        } catch (error) {
            if (error instanceof CsvSaveConflict && error.kind === 'base-modified') {
                this.requestDiskCheck();
            }
            this.error = `Couldn't save ${path.basename(this.realpath)}: ${toError(error).message}`;
            this.changed('status');
            throw new Error(this.error);
        }
        if (result.raced) {
            closeQuietly(result.opened.fd);
            this.editsSinceSave = 0;
            this.requestDiskCheck();
            return;
        }
        this.swapBase(result);
        this.overlay = Overlay.identity(result.output.index.length, result.output.columnIDs.length, result.output.columnIDs, result.output.nextColumnID);
        this.editsSinceSave = 0;
        this.error = null;
        this.changed('status');
    }

    /** Drop unsaved edits and reload from disk (`csv-discard`). */
    discard(): Promise<void> {
        return this.enqueue(async () => {
            this.abortSave();
            await this.reload();
        });
    }

    // ── raw-text hand-off ────────────────────────────────────────────────────────

    /** ⌘E: flush, stop watching, and hand the file to `paneID`'s text editor. */
    enterRaw(paneID: string): Promise<void> {
        return this.enqueue(async () => {
            await this.scanDone;
            if (this.closed) throw new Error('csv document is closed');
            if (this.rawOwner !== null && this.rawOwner !== paneID) {
                throw csvError('CSV_READ_ONLY', 'This file is already open as raw text in another pane.');
            }
            if (this.fileReadOnly !== null) throw csvError('CSV_READ_ONLY', this.fileReadOnly.message);
            const limit = this.options.rawEditLimitBytes ?? CSV_LIMITS.rawEditLimitBytes;
            if (this.bytes > limit) {
                throw new Error(`This file is too large to edit as raw text (over ${String(Math.round(limit / (1024 * 1024)))} MiB).`);
            }
            this.saveNowSync();
            this.rawOwner = paneID;
            this.stopWatch();
            if (this.checkTimer !== null) clearTimeout(this.checkTimer);
            this.checkTimer = null;
            this.changed('status');
        });
    }

    /** Back to the grid: reopen what the text editor wrote and watch again. */
    exitRaw(paneID: string): Promise<void> {
        return this.enqueue(async () => {
            if (this.rawOwner !== paneID) return;
            this.rawOwner = null;
            await this.reload();
            this.startWatch();
        });
    }

    // ── teardown ─────────────────────────────────────────────────────────────────

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.stopWatch();
        this.clearSaveTimers();
        if (this.checkTimer !== null) clearTimeout(this.checkTimer);
        this.checkTimer = null;
        if (this.scanAbort !== null) this.scanAbort.aborted = true;
        this.abortSave();
        this.findCache.clear();
        this.retire(this.base);
    }

    /** Memory held by the index (for the bench and budgets). */
    get indexBytes(): number {
        return this.base.index.bytes;
    }
}
