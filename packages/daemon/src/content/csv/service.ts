/**
 * `CsvService`: the daemon's owner of csv panes (#324, docs/csv-pane.md), implementing the
 * `CsvChannel` seam the WS hub, the plugin documents API, the content service (raw text) and
 * boot (flush paths) call.
 *
 * Panes map to SHARED documents: two panes on one file (by realpath) see one index, one overlay,
 * one undo history and one save pipeline. Per-pane view state lives here: the sort permutation,
 * the header-row flag (persisted on the pane) and the find view order.
 *
 * Lifecycle: a pane entry is created on first use and lives until the pane is removed (a
 * workspace switch does not release it). A document stays open while any pane uses it; a clean
 * document nobody has subscribed to for `idleDropMs` (10 min) is closed and reopened on demand.
 * When the last pane on a dirty document closes, the document finishes saving first; if that
 * save fails, or the edits are dropped because the file changed on disk, there is no pane left
 * to say so, and the user is told through `notify` (a desktop notification / toast).
 *
 * Raw text (⌘E) has one owner, the content service's `setMode`: it calls `prepareRaw` before it
 * dispatches `set-markdown-editing` and `afterRaw` after it leaves. This service only reads
 * `isEditing` as a gate that refuses grid edits.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    CSV_LIMITS,
    csvError,
    type CsvEditOp,
    type CsvFindDirection,
    type CsvFindReply,
    type CsvFindStepReply,
    type CsvPaneState,
    type CsvRow,
    type CsvRowsReply,
    type CsvRowsRequest,
    type CsvSortDirection
} from '@kelpi/protocol';

import type { DomainStore } from '../../seams.js';
import { findPaneAnywhere } from '../../store/derived.js';
import type { DaemonState, DomainAction, DomainEvent } from '../../store/types.js';
import type { CsvChannel, CsvRawTarget, CsvSubscription } from './channel.js';
import { CsvDocument, type CsvChange, type CsvDocumentOptions } from './document.js';
import { stepIndex, toViewOrder, type FindIndex, type ViewOrder } from './find.js';
import { openCsvFile, openFailureMessage } from './open.js';
import { defaultSortCacheRoot, SortCancelled, sortRows, spillDirFor, sweepSortSpill } from './sort.js';

export const CSV_IDLE_DROP_MS = 10 * 60 * 1000;
/** Row indexes of unwatched clean documents are released, least recently used first, above this. */
export const CSV_MEMORY_BUDGET_BYTES = 1024 * 1024 * 1024;
export const CSV_PROGRESS_THROTTLE_MS = 200;

/** Something the user must hear about that no pane is left to show (`CsvServiceOptions.notify`). */
export interface CsvNotice {
    /** The pane that last showed the file, and its workspace (the pane is usually gone). */
    readonly paneID: string;
    readonly workspaceID: string;
    readonly realpath: string;
    readonly title: string;
    readonly body: string;
}

export interface CsvServiceOptions {
    readonly store: DomainStore<DaemonState, DomainAction, DomainEvent>;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /**
     * A background save failed, or unsaved edits were discarded, after the file's last pane
     * closed. Boot broadcasts it as a client `notification`; without it the event is only logged.
     */
    readonly notify?: ((notice: CsvNotice) => void) | undefined;
    /** Engine tuning (tests and the bench); `onChange`/`onError` are the service's own. */
    readonly document?: Omit<CsvDocumentOptions, 'onChange' | 'onError'> | undefined;
    readonly sortBatchRows?: number | undefined;
    readonly sortReadRows?: number | undefined;
    /** Spill root for external sorts (default: the user cache dir). Swept at construction. */
    readonly sortCacheRoot?: string | undefined;
    readonly idleDropMs?: number | undefined;
    readonly memoryBudgetBytes?: number | undefined;
    readonly progressThrottleMs?: number | undefined;
}

interface PaneSort {
    readonly column: number;
    readonly direction: CsvSortDirection;
    readonly headerRow: boolean;
    pending: boolean;
    /** View index → logical row, covering every row (header pinned at 0 when on). */
    perm: Uint32Array | null;
    /** Logical row → view index (built on first find step). */
    inverse: Uint32Array | null;
    readonly signal: { aborted: boolean };
    done: Promise<void>;
}

interface PaneEntry {
    readonly paneID: string;
    workspaceID: string;
    filePath: string | null;
    headerRow: boolean;
    doc: CsvDocument | null;
    opening: Promise<void> | null;
    openError: string | null;
    sort: PaneSort | null;
    sortError: string | null;
    readonly listeners: Set<(state: CsvPaneState) => void>;
    revision: number;
    findView: { readonly index: FindIndex; readonly sort: PaneSort | null; readonly order: ViewOrder } | null;
    emitTimer: ReturnType<typeof setTimeout> | null;
    lastEmit: number;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export class CsvService implements CsvChannel {
    private readonly store: CsvServiceOptions['store'];
    private readonly entries = new Map<string, PaneEntry>();
    /** Open documents by realpath. */
    private readonly documents = new Map<string, CsvDocument>();
    /** Opens in flight by realpath, so two panes on one file share one open. */
    private readonly opening = new Map<string, Promise<CsvDocument>>();
    private readonly idleTimers = new Map<CsvDocument, ReturnType<typeof setTimeout>>();
    /** The pane (and workspace) that last showed each document, for a notice after it closed. */
    private readonly lastPane = new Map<CsvDocument, { readonly paneID: string; readonly workspaceID: string }>();
    /** When each document was last asked for (the memory budget's LRU order). */
    private readonly lastUsed = new Map<CsvDocument, number>();
    private useClock = 0;
    private readonly unsubscribeStore: () => void;
    private readonly sortRoot: string;
    private revisionSeq = 0;
    private disposed = false;

    constructor(private readonly options: CsvServiceOptions) {
        this.store = options.store;
        this.sortRoot = options.sortCacheRoot ?? defaultSortCacheRoot();
        try {
            sweepSortSpill(this.sortRoot);
        } catch (error) {
            this.report(error, 'csv sort spill sweep');
        }
        this.unsubscribeStore = this.store.subscribe(events => this.onStoreEvents(events));
    }

    private report(error: unknown, context: string): void {
        this.options.onError?.(toError(error), context);
    }

    private get largeFileBytes(): number {
        return this.options.document?.largeFileBytes ?? CSV_LIMITS.largeFileBytes;
    }

    // ── entries and documents ────────────────────────────────────────────────────

    private locate(paneID: string): { workspaceID: string; filePath: string | null; headerRow: boolean; isEditing: boolean } {
        const found = findPaneAnywhere(this.store.getState(), paneID);
        if (found === null) throw new Error(`no pane matches '${paneID}'`);
        if (found.pane.type !== 'csv') throw new Error(`pane '${paneID}' is a ${found.pane.type} pane, not a csv pane`);
        return {
            workspaceID: found.workspaceID,
            filePath: found.pane.filePath,
            headerRow: found.pane.csvHeaderRow !== false,
            isEditing: found.pane.isEditing
        };
    }

    private async ensure(paneID: string): Promise<PaneEntry> {
        if (this.disposed) throw new Error('csv service is shut down');
        const pane = this.locate(paneID);
        let entry = this.entries.get(paneID);
        if (entry === undefined) {
            entry = {
                paneID,
                workspaceID: pane.workspaceID,
                filePath: pane.filePath,
                headerRow: pane.headerRow,
                doc: null,
                opening: null,
                openError: null,
                sort: null,
                sortError: null,
                listeners: new Set(),
                revision: 0,
                findView: null,
                emitTimer: null,
                lastEmit: 0
            };
            this.entries.set(paneID, entry);
        }
        entry.workspaceID = pane.workspaceID;
        entry.headerRow = pane.headerRow;
        if (entry.filePath !== pane.filePath) {
            this.detach(entry);
            entry.filePath = pane.filePath;
            entry.openError = null;
        }
        while (entry.doc === null || entry.doc.closed) {
            if (entry.doc?.closed === true) entry.doc = null;
            if (entry.opening === null) {
                const opening: Promise<void> = this.attach(entry).finally(() => {
                    if (entry.opening === opening) entry.opening = null;
                });
                entry.opening = opening;
            }
            await entry.opening;
            if (entry.doc === null) break;
        }
        if (this.entries.get(paneID) !== entry) throw new Error('csv pane was closed while loading');
        if (entry.doc !== null) this.lastUsed.set(entry.doc, ++this.useClock);
        return entry;
    }

    private documentOptions(): CsvDocumentOptions {
        return {
            ...(this.options.document ?? {}),
            onChange: (document, change) => this.onDocumentChange(document, change),
            onError: (error, context) => this.report(error, context),
            onDiscarded: (document, edits) => {
                // With a pane open, the pane's own notice says it (`state.notice`).
                if (document.panes.size > 0) return;
                const name = path.basename(document.realpath);
                this.notify(document, `${name} changed on disk`, `${String(edits)} unsaved edit${edits === 1 ? ' was' : 's were'} discarded.`);
            }
        };
    }

    /** Tell the user about a document no pane shows any more (logged too). */
    private notify(document: CsvDocument, title: string, body: string): void {
        this.report(new Error(`${title}: ${body}`), `csv ${document.realpath}`);
        const origin = this.lastPane.get(document);
        if (origin === undefined || this.options.notify === undefined) return;
        try {
            this.options.notify({ ...origin, realpath: document.realpath, title, body });
        } catch (error) {
            this.report(error, 'csv notify');
        }
    }

    private async attach(entry: PaneEntry): Promise<void> {
        const filePath = entry.filePath;
        if (filePath === null) {
            entry.openError = 'csv pane has no file path';
            return;
        }
        try {
            const realpath = await fs.promises.realpath(filePath);
            let document = this.documents.get(realpath);
            if (document === undefined || document.closed) {
                let pending = this.opening.get(realpath);
                if (pending === undefined) {
                    // `create` closes the file itself when it fails.
                    pending = (async () => CsvDocument.create(await openCsvFile(realpath), this.documentOptions()))();
                    this.opening.set(realpath, pending);
                    const settle = (): void => {
                        if (this.opening.get(realpath) === pending) this.opening.delete(realpath);
                    };
                    pending.then(settle, settle);
                }
                document = await pending;
                if (this.disposed) {
                    document.close();
                    return;
                }
                const existing = this.documents.get(realpath);
                if (existing !== undefined && existing !== document && !existing.closed) {
                    document.close();
                    document = existing;
                }
            }
            if (this.entries.get(entry.paneID) !== entry || entry.filePath !== filePath) {
                // The pane closed (or moved to another file) while the file opened: never cache a
                // document nobody claims, or its fd, watcher and scan outlive every pane.
                this.releaseUnclaimed(document);
                return;
            }
            this.documents.set(realpath, document);
            entry.doc = document;
            entry.openError = null;
            document.panes.add(entry.paneID);
            this.cancelIdle(document);
            this.scheduleIdleCheck(document);
        } catch (error) {
            entry.openError = openFailureMessage(filePath, error);
        }
    }

    /**
     * Close a document this open no longer wants, unless a pane claims it: another pane waiting
     * on the same open resumes in this same turn, so the check waits for the next one.
     */
    private releaseUnclaimed(document: CsvDocument): void {
        setImmediate(() => {
            if (document.closed || document.panes.size > 0 || this.documents.get(document.realpath) === document) return;
            document.close();
        });
    }

    private requireDoc(entry: PaneEntry): CsvDocument {
        if (entry.doc === null) throw new Error(entry.openError ?? 'csv file is not open');
        return entry.doc;
    }

    /** Detach a pane from its document (file path changed, pane closed, idle drop). */
    private detach(entry: PaneEntry): void {
        this.cancelSort(entry);
        entry.findView = null;
        const document = entry.doc;
        entry.doc = null;
        if (document === null) return;
        document.panes.delete(entry.paneID);
        this.lastPane.set(document, { paneID: entry.paneID, workspaceID: entry.workspaceID });
        if (document.rawOwner === entry.paneID) {
            void document.exitRaw(entry.paneID).catch((error: unknown) => this.report(error, 'csv raw exit'));
        }
        if (document.panes.size === 0) this.retire(document);
        else this.scheduleIdleCheck(document);
    }

    /** No pane uses `document` any more: close it, after its edits are on disk. */
    private retire(document: CsvDocument): void {
        this.cancelIdle(document);
        if (!document.dirty && !document.isSaving) {
            this.closeDocument(document);
            return;
        }
        void (async () => {
            for (let attempt = 0; attempt < 3 && (document.dirty || document.isSaving) && document.panes.size === 0 && !document.closed; attempt += 1) {
                await document.startSave();
                await document.whenSaved();
            }
            if (document.panes.size > 0 || document.closed) return;
            if (document.dirty) {
                // Kept open: the next flush (quit, SIGTERM) tries again.
                const name = path.basename(document.realpath);
                const prefix = `Couldn't save ${name}: `;
                const error = document.error ?? 'the unsaved edits could not be written';
                const reason = (error.startsWith(prefix) ? error.slice(prefix.length) : error).replace(/\.?$/, '.');
                this.notify(document, `Couldn't save ${name}`, `${reason} The edits are kept in memory and saving is retried when Kelpi shuts down.`);
                return;
            }
            this.closeDocument(document);
        })().catch((error: unknown) => this.report(error, `csv close ${document.realpath}`));
    }

    private closeDocument(document: CsvDocument): void {
        this.cancelIdle(document);
        this.lastUsed.delete(document);
        this.lastPane.delete(document);
        if (this.documents.get(document.realpath) === document) this.documents.delete(document.realpath);
        document.close();
    }

    /** Can this document be closed without anyone noticing (reopened on the next request)? */
    private droppable(document: CsvDocument): boolean {
        return !this.watched(document) && !document.dirty && !document.isSaving && document.rawOwner === null && !document.closed;
    }

    /** Close a document its panes are not watching; they reopen it on demand. */
    private drop(document: CsvDocument): void {
        for (const paneID of [...document.panes]) {
            const entry = this.entries.get(paneID);
            if (entry === undefined) continue;
            this.cancelSort(entry);
            entry.findView = null;
            entry.doc = null;
        }
        document.panes.clear();
        this.closeDocument(document);
    }

    /** Above the memory budget, release unwatched clean documents, least recently used first. */
    private enforceMemoryBudget(except: CsvDocument): void {
        const budget = this.options.memoryBudgetBytes ?? CSV_MEMORY_BUDGET_BYTES;
        let total = 0;
        for (const document of this.documents.values()) total += document.indexBytes;
        if (total <= budget) return;
        const candidates = [...this.documents.values()]
            .filter(document => document !== except && this.droppable(document))
            .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
        for (const document of candidates) {
            if (total <= budget) return;
            total -= document.indexBytes;
            this.drop(document);
        }
    }

    private closeEntry(paneID: string): void {
        const entry = this.entries.get(paneID);
        if (entry === undefined) return;
        this.entries.delete(paneID);
        if (entry.emitTimer !== null) clearTimeout(entry.emitTimer);
        entry.listeners.clear();
        this.detach(entry);
    }

    // ── idle drop ────────────────────────────────────────────────────────────────

    private cancelIdle(document: CsvDocument): void {
        const timer = this.idleTimers.get(document);
        if (timer !== undefined) clearTimeout(timer);
        this.idleTimers.delete(document);
    }

    private watched(document: CsvDocument): boolean {
        for (const paneID of document.panes) {
            const entry = this.entries.get(paneID);
            if (entry !== undefined && (entry.listeners.size > 0 || entry.sort?.pending === true)) return true;
        }
        return false;
    }

    /** A clean document nobody watches is closed after `idleDropMs`; panes reopen on demand. */
    private scheduleIdleCheck(document: CsvDocument): void {
        if (this.watched(document) || document.closed) {
            this.cancelIdle(document);
            return;
        }
        if (this.idleTimers.has(document)) return;
        const timer = setTimeout(() => {
            this.idleTimers.delete(document);
            if (this.droppable(document)) this.drop(document);
        }, this.options.idleDropMs ?? CSV_IDLE_DROP_MS);
        timer.unref?.();
        this.idleTimers.set(document, timer);
    }

    // ── state and fan-out ────────────────────────────────────────────────────────

    private snapshot(entry: PaneEntry): CsvPaneState {
        const document = entry.doc;
        if (document === null) {
            return {
                paneID: entry.paneID,
                incarnation: 'unopened',
                revision: entry.revision,
                generation: '',
                filePath: entry.filePath,
                loaded: false,
                scanning: null,
                rowCount: 0,
                columns: [],
                bytes: 0,
                dialect: null,
                headerRow: entry.headerRow,
                sort: null,
                dirty: false,
                saving: false,
                canUndo: false,
                canRedo: false,
                rawEditable: false,
                readOnly: null,
                error: entry.openError,
                notice: null
            };
        }
        const readOnly = document.fileReadOnly ??
            (document.rawOwner !== null && document.rawOwner !== entry.paneID
                ? { code: 'raw-elsewhere' as const, message: 'This file is open as raw text in another pane.' }
                : null);
        return {
            paneID: entry.paneID,
            incarnation: document.incarnation,
            revision: entry.revision,
            generation: document.generation,
            filePath: entry.filePath,
            loaded: document.loaded,
            scanning: document.scanning,
            rowCount: document.rowCount,
            columns: document.columns.map(column => column.id),
            bytes: document.bytes,
            dialect: document.dialect,
            headerRow: entry.headerRow,
            sort: entry.sort === null ? null : { column: entry.sort.column, direction: entry.sort.direction, pending: entry.sort.pending },
            dirty: document.dirty,
            saving: document.isSaving,
            canUndo: document.canUndo,
            canRedo: document.canRedo,
            rawEditable: document.rawEditable,
            readOnly,
            error: entry.sortError ?? document.error,
            notice: document.currentNotice
        };
    }

    private emit(entry: PaneEntry): void {
        if (entry.emitTimer !== null) {
            clearTimeout(entry.emitTimer);
            entry.emitTimer = null;
        }
        this.revisionSeq += 1;
        entry.revision = this.revisionSeq;
        entry.lastEmit = Date.now();
        if (entry.listeners.size === 0) return;
        const state = this.snapshot(entry);
        for (const listener of [...entry.listeners]) {
            try {
                listener(state);
            } catch (error) {
                this.report(error, `csv listener ${entry.paneID}`);
            }
        }
    }

    /** Scan progress: at most one push per `progressThrottleMs`. */
    private emitThrottled(entry: PaneEntry): void {
        const throttle = this.options.progressThrottleMs ?? CSV_PROGRESS_THROTTLE_MS;
        const wait = entry.lastEmit + throttle - Date.now();
        if (wait <= 0) {
            this.emit(entry);
            return;
        }
        if (entry.emitTimer !== null) return;
        entry.emitTimer = setTimeout(() => {
            entry.emitTimer = null;
            if (this.entries.get(entry.paneID) === entry) this.emit(entry);
        }, wait);
        entry.emitTimer.unref?.();
    }

    private onDocumentChange(document: CsvDocument, change: CsvChange): void {
        if (change === 'loaded' || change === 'structure') this.enforceMemoryBudget(document);
        for (const paneID of document.panes) {
            const entry = this.entries.get(paneID);
            if (entry === undefined || entry.doc !== document) continue;
            if (change === 'structure' || change === 'reload') {
                this.cancelSort(entry);
                entry.sort = null;
                entry.sortError = null;
            }
            if (change !== 'progress' && change !== 'status') entry.findView = null;
            if (change === 'progress') this.emitThrottled(entry);
            else this.emit(entry);
        }
    }

    // ── store ────────────────────────────────────────────────────────────────────

    private onStoreEvents(events: readonly DomainEvent[]): void {
        if (this.disposed) return;
        for (const event of events) {
            if (event.kind === 'pane-removed') {
                this.closeEntry(event.paneID);
                continue;
            }
            if (event.kind === 'workspace-removed') {
                for (const entry of [...this.entries.values()]) {
                    if (entry.workspaceID === event.id) this.closeEntry(entry.paneID);
                }
                continue;
            }
            if (event.kind !== 'pane-upserted') continue;
            const entry = this.entries.get(event.paneID);
            if (entry === undefined) continue;
            const pane = event.pane;
            if (pane.type !== 'csv') {
                this.closeEntry(event.paneID);
                continue;
            }
            entry.workspaceID = event.workspaceID;
            if (pane.filePath !== entry.filePath) {
                // The pane now shows another file: reopen and tell its subscribers.
                this.detach(entry);
                entry.filePath = pane.filePath;
                entry.openError = null;
                void this.ensure(entry.paneID).then(
                    reopened => this.emit(reopened),
                    (error: unknown) => {
                        this.report(error, `csv reopen ${event.paneID}`);
                        if (this.entries.get(event.paneID) === entry) this.emit(entry);
                    }
                );
                continue;
            }
            const headerRow = pane.csvHeaderRow !== false;
            if (headerRow !== entry.headerRow) this.applyHeaderRow(entry, headerRow);
        }
    }

    private applyHeaderRow(entry: PaneEntry, on: boolean): void {
        entry.headerRow = on;
        entry.findView = null;
        const sort = entry.sort;
        if (sort !== null && sort.headerRow !== on && entry.doc !== null) {
            // The pinned row changed: rebuild the permutation (rows show unsorted meanwhile).
            this.startSort(entry, entry.doc, sort.column, sort.direction).catch((error: unknown) => this.report(error, 'csv re-sort'));
        }
        this.emit(entry);
    }

    // ── sorting ──────────────────────────────────────────────────────────────────

    private cancelSort(entry: PaneEntry): void {
        if (entry.sort !== null) entry.sort.signal.aborted = true;
    }

    private startSort(entry: PaneEntry, document: CsvDocument, column: number, direction: CsvSortDirection): Promise<void> {
        this.cancelSort(entry);
        const sort: PaneSort = {
            column,
            direction,
            headerRow: entry.headerRow,
            pending: true,
            perm: null,
            inverse: null,
            signal: { aborted: false },
            done: Promise.resolve()
        };
        entry.sort = sort;
        entry.sortError = null;
        entry.findView = null;
        this.emit(entry);
        sort.done = (async () => {
            await document.scanDone;
            const total = document.rowCount;
            const first = sort.headerRow && total > 0 ? 1 : 0;
            try {
                const sorted = await sortRows(
                    { first, count: total - first, read: (start, count) => document.columnValues(column, start, count) },
                    {
                        direction,
                        spillDir: spillDirFor(this.sortRoot),
                        signal: sort.signal,
                        ...(this.options.sortBatchRows !== undefined ? { batchRows: this.options.sortBatchRows } : {}),
                        ...(this.options.sortReadRows !== undefined ? { readRows: this.options.sortReadRows } : {})
                    }
                );
                if (sort.signal.aborted || entry.sort !== sort) return;
                if (document.rowCount !== total) {
                    // Rows came or went while sorting (the structural change cancels the sort,
                    // so this is a belt-and-braces check): drop it rather than misalign.
                    entry.sort = null;
                } else {
                    const perm = new Uint32Array(total);
                    if (first === 1) perm[0] = 0;
                    perm.set(sorted, first);
                    sort.perm = perm;
                    sort.pending = false;
                }
            } catch (error) {
                if (error instanceof SortCancelled || sort.signal.aborted || entry.sort !== sort) return;
                entry.sort = null;
                entry.sortError = toError(error).message;
            }
            if (this.entries.get(entry.paneID) === entry) this.emit(entry);
            if (entry.doc !== null) this.scheduleIdleCheck(entry.doc);
        })();
        return sort.done;
    }

    /** The permutation to read through, when a finished sort covers every row. */
    private activePerm(entry: PaneEntry, rowCount: number): Uint32Array | null {
        const perm = entry.sort?.perm ?? null;
        return perm !== null && perm.length === rowCount ? perm : null;
    }

    // ── CsvChannel ───────────────────────────────────────────────────────────────

    async subscribe(paneID: string, listener: (state: CsvPaneState) => void): Promise<CsvSubscription> {
        const entry = await this.ensure(paneID);
        entry.listeners.add(listener);
        if (entry.doc !== null) this.cancelIdle(entry.doc);
        let released = false;
        return {
            state: this.snapshot(entry),
            unsubscribe: () => {
                if (released) return;
                released = true;
                entry.listeners.delete(listener);
                if (entry.doc !== null) this.scheduleIdleCheck(entry.doc);
            }
        };
    }

    async state(paneID: string): Promise<CsvPaneState> {
        return this.snapshot(await this.ensure(paneID));
    }

    async rows(paneID: string, request: CsvRowsRequest, budgetBytes: number = CSV_LIMITS.rowsReplyBudgetBytes): Promise<CsvRowsReply> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        const total = document.rowCount;
        const columns = document.columns;
        const start = request.start;
        const columnStart = Math.min(request.columnStart ?? 0, columns.length);
        const columnCount = Math.max(0, Math.min(request.columnCount ?? CSV_LIMITS.maxColumnsPerRequest, CSV_LIMITS.maxColumnsPerRequest, columns.length - columnStart));
        const count = Math.max(0, Math.min(request.count, CSV_LIMITS.maxRowsPerRequest, total - start));
        const generation = document.generation;
        const revision = entry.revision;
        const perm = this.activePerm(entry, total);
        const logical: number[] = [];
        for (let view = start; view < start + count; view += 1) logical.push(perm === null ? view : (perm[view] as number));
        // The ids come with the cells, from the overlay the records were read through.
        const read = count > 0
            ? await document.readView(logical, columnStart, columnCount, budgetBytes)
            : { columnIDs: columns.slice(columnStart, columnStart + columnCount).map(column => column.id), rows: [] };
        const rows: CsvRow[] = read.rows.map((row, i) => ({
            view: start + i,
            row: row.row,
            cells: row.cells,
            ...(row.truncated !== undefined ? { truncated: row.truncated } : {}),
            fieldCount: row.fieldCount
        }));
        return {
            generation,
            revision,
            start,
            columnStart,
            columnIDs: read.columnIDs,
            rows,
            nextStart: rows.length < count ? start + rows.length : null
        };
    }

    async edit(paneID: string, generation: string, ops: readonly CsvEditOp[]): Promise<CsvPaneState> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        if (this.locate(paneID).isEditing) throw csvError('CSV_READ_ONLY', 'This pane is showing raw text.');
        await document.edit(generation, ops);
        return this.snapshot(entry);
    }

    async sort(paneID: string, column: number | null, direction: CsvSortDirection): Promise<CsvPaneState> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        if (column === null) {
            this.cancelSort(entry);
            entry.sort = null;
            entry.sortError = null;
            entry.findView = null;
            this.emit(entry);
            return this.snapshot(entry);
        }
        await document.scanDone;
        if (!document.columns.some(candidate => candidate.id === column)) {
            throw csvError('CSV_GONE', `column ${String(column)} does not exist`);
        }
        await this.startSort(entry, document, column, direction);
        return this.snapshot(entry);
    }

    private async viewOrder(entry: PaneEntry, document: CsvDocument, query: string): Promise<{ index: FindIndex; order: ViewOrder }> {
        const index = await document.find(query);
        const sort = entry.sort !== null && entry.sort.perm !== null && !entry.sort.pending ? entry.sort : null;
        const cached = entry.findView;
        if (cached !== null && cached.index === index && cached.sort === sort) return { index, order: cached.order };
        let inverse: Uint32Array | null = null;
        if (sort !== null && sort.perm !== null) {
            if (sort.inverse === null) {
                const built = new Uint32Array(sort.perm.length);
                for (let view = 0; view < sort.perm.length; view += 1) built[sort.perm[view] as number] = view;
                sort.inverse = built;
            }
            inverse = sort.inverse;
        }
        const positions = new Map<number, number>();
        document.columns.forEach((column, i) => positions.set(column.id, i));
        const order = toViewOrder(index, inverse, positions);
        entry.findView = { index, sort, order };
        return { index, order };
    }

    async find(paneID: string, query: string): Promise<CsvFindReply> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        const index = await document.find(query);
        return { query, total: index.total, complete: index.complete, truncated: index.truncated };
    }

    async findStep(
        paneID: string,
        query: string,
        direction: CsvFindDirection,
        from: { view: number; column: number } | null
    ): Promise<CsvFindStepReply> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        const { index, order } = await this.viewOrder(entry, document, query);
        let position: { view: number; position: number } | null = null;
        if (from !== null) {
            const column = document.columns.findIndex(candidate => candidate.id === from.column);
            position = { view: from.view, position: column < 0 ? 0 : column };
        }
        const at = stepIndex(order, position, direction);
        return {
            query,
            match: at < 0 ? null : { view: order.views[at] as number, row: order.rows[at] as number, column: order.columns[at] as number },
            index: at < 0 ? null : at + 1,
            total: index.total,
            complete: index.complete,
            truncated: index.truncated
        };
    }

    async setHeaderRow(paneID: string, on: boolean): Promise<CsvPaneState> {
        const entry = await this.ensure(paneID);
        this.store.dispatch({ type: 'set-csv-header-row', workspaceID: entry.workspaceID, paneID, on });
        // The store event applies it too; an unchanged value produces no event.
        if (entry.headerRow !== on) this.applyHeaderRow(entry, on);
        return this.snapshot(entry);
    }

    async discard(paneID: string): Promise<CsvPaneState> {
        const entry = await this.ensure(paneID);
        await this.requireDoc(entry).discard();
        return this.snapshot(entry);
    }

    async prepareRaw(paneID: string): Promise<CsvRawTarget> {
        const entry = await this.ensure(paneID);
        const document = this.requireDoc(entry);
        await document.enterRaw(paneID);
        const { dev, ino } = document.base.identity;
        return { realpath: document.realpath, dev, ino };
    }

    async afterRaw(paneID: string): Promise<void> {
        const entry = this.entries.get(paneID) ?? await this.ensure(paneID);
        const document = entry.doc;
        if (document === null) return;
        await document.exitRaw(paneID);
    }

    flushSync(): void {
        for (const document of [...this.documents.values()]) {
            if (!document.dirty && !document.isSaving) continue;
            try {
                document.saveNowSync();
            } catch (error) {
                this.report(error, `csv flush ${document.realpath}`);
            }
        }
    }

    flushForQuit(): void {
        const failures: string[] = [];
        for (const document of [...this.documents.values()]) {
            if (!document.dirty && !document.isSaving) continue;
            if (document.bytes < this.largeFileBytes) {
                try {
                    document.saveNowSync();
                } catch (error) {
                    failures.push(toError(error).message);
                }
            } else {
                void document.startSave().catch((error: unknown) => this.report(error, `csv quit save ${document.realpath}`));
            }
        }
        if (failures.length > 0) throw new Error(failures.join(' '));
    }

    prepareClose(paneID: string): void {
        const document = this.entries.get(paneID)?.doc ?? null;
        if (document === null || (!document.dirty && !document.isSaving)) return;
        if (document.bytes < this.largeFileBytes) {
            // Throws on failure, which refuses the close (the markdown rule).
            document.saveNowSync();
            return;
        }
        // Large: keep saving in the background; `retire` keeps the document until it lands.
        void document.startSave().catch((error: unknown) => this.report(error, `csv close save ${document.realpath}`));
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        this.unsubscribeStore();
        for (const entry of this.entries.values()) {
            this.cancelSort(entry);
            if (entry.emitTimer !== null) clearTimeout(entry.emitTimer);
            entry.listeners.clear();
        }
        this.entries.clear();
        for (const timer of this.idleTimers.values()) clearTimeout(timer);
        this.idleTimers.clear();
        for (const document of this.documents.values()) document.close();
        this.documents.clear();
    }

    /** Diagnostics for the bench and tests. */
    get openDocuments(): readonly CsvDocument[] {
        return [...this.documents.values()];
    }

    documentFor(paneID: string): CsvDocument | null {
        return this.entries.get(paneID)?.doc ?? null;
    }
}

export function createCsvService(options: CsvServiceOptions): CsvService {
    return new CsvService(options);
}
