/**
 * #324 CsvService against real temp files and a real store: shared documents, row reads, edits
 * with generation translation, undo across saves, the save pipeline under flush/close/raw
 * pressure, external changes, sorting, find and the store lifecycle.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { csvErrorCode, type CsvPaneState } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findPaneAnywhere } from '../../store/derived.js';
import { harness, id, NOW, seededState, W1, type Harness } from '../../store/testing.js';
import type { WatchFn } from '../watcher.js';
import { CsvDocument } from './document.js';
import { processAlive } from './open.js';
import { CsvService, type CsvNotice, type CsvServiceOptions } from './service.js';

const SHELL = id('dddddddd', 100);
const P1 = id('eeeeeeee', 1);
const P2 = id('eeeeeeee', 2);

interface Setup {
    readonly dir: string;
    readonly file: string;
    readonly h: Harness;
    readonly service: CsvService;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(
    body: string | Buffer,
    options: { name?: string; document?: CsvServiceOptions['document']; service?: Partial<CsvServiceOptions> } = {}
): Setup {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-service-')));
    const file = path.join(dir, options.name ?? 'data.csv');
    fs.writeFileSync(file, body);
    const h = harness(seededState(W1, SHELL));
    const service = new CsvService({
        store: h.store,
        sortCacheRoot: path.join(dir, '.sort'),
        idleDropMs: 3_600_000,
        progressThrottleMs: 0,
        ...options.service,
        document: { watch: false, autosaveSmallMs: 5, diskCheckDelayMs: 1, ...options.document }
    });
    cleanups.push(async () => {
        await service.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { dir, file, h, service };
}

function openPane(s: Setup, paneID: string, file: string = s.file): void {
    s.h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID, filePath: file, now: NOW, paneType: 'csv' });
}

async function ready(s: Setup, paneID: string): Promise<CsvDocument> {
    await s.service.state(paneID);
    const document = s.service.documentFor(paneID);
    if (document === null) throw new Error('document did not open');
    await document.scanDone;
    return document;
}

async function cells(s: Setup, paneID: string, start = 0, count = 500): Promise<string[][]> {
    return (await s.service.rows(paneID, { start, count })).rows.map(row => [...row.cells]);
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise(resolve => setTimeout(resolve, 3));
    }
}

const settled = (document: CsvDocument): Promise<void> => until(() => !document.dirty && !document.isSaving);
const tmpFiles = (dir: string): string[] => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
const code = (error: unknown): string | null => csvErrorCode(error instanceof Error ? error.message : String(error));

type ReadCallback = (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void;

/**
 * Park async reads (`fs.read`, what the scanner and row reads use) until `release`: a
 * deterministic moment inside a read's await. Synchronous reads (saves, fingerprints) still run.
 * `from` holds only reads at or past that file position.
 */
function holdReads(from = 0): { held(): number; release(): void } {
    const original = fs.read.bind(fs) as (...args: unknown[]) => void;
    const parked: (() => void)[] = [];
    let holding = true;
    const spy = vi.spyOn(fs, 'read').mockImplementation(((...args: unknown[]) => {
        const callback = args[args.length - 1] as ReadCallback;
        const position = typeof args[4] === 'number' ? args[4] : 0;
        original(...args.slice(0, -1), (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => {
            if (holding && position >= from) parked.push(() => callback(error, bytesRead, buffer));
            else callback(error, bytesRead, buffer);
        });
    }) as unknown as typeof fs.read);
    cleanups.push(() => spy.mockRestore());
    return {
        held: () => parked.length,
        release() {
            holding = false;
            spy.mockRestore();
            for (const run of parked.splice(0)) run();
        }
    };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('expected a rejection');
}

describe('CsvService reads', () => {
    it('opens, indexes and serves rows in view order', async () => {
        const s = setup('name,qty\nb,2\na,10\nc,1\n');
        openPane(s, P1);
        await ready(s, P1);
        const state = await s.service.state(P1);
        expect(state).toMatchObject({ loaded: true, scanning: null, rowCount: 4, columns: [0, 1], headerRow: true, dirty: false, readOnly: null, rawEditable: true });
        expect(state.dialect).toEqual({ delimiter: ',', lineEnding: '\n', bom: false, quoteAll: false });
        expect(state.generation).toBe(`${state.incarnation}:0`);
        expect(await cells(s, P1)).toEqual([['name', 'qty'], ['b', '2'], ['a', '10'], ['c', '1']]);
        const window = await s.service.rows(P1, { start: 1, count: 2, columnStart: 1, columnCount: 1 });
        expect(window).toMatchObject({ start: 1, columnStart: 1, columnIDs: [1], nextStart: null });
        expect(window.rows.map(row => [row.view, row.row, row.cells, row.fieldCount])).toEqual([[1, 1, ['2'], 2], [2, 2, ['10'], 2]]);
        expect((await s.service.rows(P1, { start: 10, count: 5 })).rows).toEqual([]);
    });

    it('stops at the byte budget with nextStart and flags truncated cells', async () => {
        const big = 'x'.repeat(70 * 1024);
        const s = setup(`a,b\n${big},1\nshort,2\n`);
        openPane(s, P1);
        await ready(s, P1);
        const reply = await s.service.rows(P1, { start: 0, count: 3 }, 100);
        expect(reply.rows.length).toBe(1);
        expect(reply.nextStart).toBe(1);
        const second = await s.service.rows(P1, { start: 1, count: 1 });
        expect(second.rows[0]?.truncated).toEqual([0]);
        expect(Buffer.byteLength(second.rows[0]?.cells[0] ?? '')).toBe(64 * 1024);
        const clamped = await s.service.rows(P1, { start: 0, count: 10_000 });
        expect(clamped.rows.length).toBe(3);
    });

    it('serves rows while the first scan is still running and refuses edits until it ends', async () => {
        const body = 'id,value\n' + Array.from({ length: 20_000 }, (_, i) => `${String(i)},v${String(i)}`).join('\n') + '\n';
        const s = setup(body, { document: { chunkBytes: 64 } });
        openPane(s, P1);
        const state = await s.service.state(P1);
        expect(state.scanning).not.toBeNull();
        const error = await failure(s.service.edit(P1, state.generation, [{ op: 'set-cell', row: 1, column: 1, value: 'x' }]));
        expect(code(error)).toBe('CSV_BUSY');
        await until(() => (s.service.documentFor(P1)?.rowCount ?? 0) > 2);
        expect((await cells(s, P1, 0, 2))[1]).toEqual(['0', 'v0']);
        await s.service.documentFor(P1)?.scanDone;
        expect((await s.service.state(P1)).rowCount).toBe(20_001);
    });

    it('refuses directories and FIFOs with an error state', async () => {
        const s = setup('a\n');
        const folder = path.join(s.dir, 'folder.csv');
        fs.mkdirSync(folder);
        openPane(s, P1, folder);
        const state = await s.service.state(P1);
        expect(state.loaded).toBe(false);
        expect(state.error).toContain('is a directory');
        await expect(s.service.rows(P1, { start: 0, count: 1 })).rejects.toThrow('is a directory');
        const fifo = path.join(s.dir, 'pipe.csv');
        try {
            execFileSync('mkfifo', [fifo]);
        } catch {
            return;
        }
        openPane(s, P2, fifo);
        expect((await s.service.state(P2)).error).toContain('is a named pipe');
    });

    it('makes UTF-16, invalid UTF-8 and unbalanced-quote files read-only', async () => {
        const utf16 = setup(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a,b\n', 'utf16le')]));
        openPane(utf16, P1);
        await ready(utf16, P1);
        const u16 = await utf16.service.state(P1);
        expect(u16.readOnly?.code).toBe('utf16');
        expect(u16.rawEditable).toBe(false);
        expect(code(await failure(utf16.service.edit(P1, u16.generation, [{ op: 'insert-rows', at: 0, count: 1 }])))).toBe('CSV_READ_ONLY');

        const latin = setup(Buffer.concat([Buffer.from('a,b\n'), Buffer.from([0x63, 0xe9, 0x2c, 0x64, 0x0a])]));
        openPane(latin, P1);
        await ready(latin, P1);
        const bad = await latin.service.state(P1);
        expect(bad.readOnly?.code).toBe('not-utf8');
        expect((await cells(latin, P1))[1]?.[0]).toBe('c�');

        const quote = setup('a,b\n"never closed,x\n' + 'y,z\n'.repeat(20), { document: { maxRecordBytes: 32 } });
        openPane(quote, P1);
        await ready(quote, P1);
        expect((await quote.service.state(P1)).readOnly?.code).toBe('oversized-record');
        // Reads and find stop at the record cap instead of loading the whole runaway record.
        const runaway = (await quote.service.rows(P1, { start: 1, count: 1 })).rows[0];
        expect(runaway?.cells[0]?.length).toBeLessThanOrEqual(32);
        expect((await quote.service.find(P1, 'y,z')).total).toBe(1); // within the first 32 bytes of the cut record
        expect((await quote.service.find(P1, 'never')).total).toBe(1);
    });

    it('sweeps orphaned temp files of dead daemons when a file opens', async () => {
        const s = setup('a\n');
        let pid = 99_990;
        while (processAlive(pid) && pid > 90_000) pid -= 1;
        const orphan = path.join(s.dir, `.data.csv.kelpi-${String(pid)}-7.tmp`);
        fs.writeFileSync(orphan, 'half');
        openPane(s, P1);
        await ready(s, P1);
        expect(fs.existsSync(orphan)).toBe(false);
    });
});

describe('CsvService edits and saves', () => {
    const source = 'id,name,note\r\n1,"Smith, J","said ""hi"""\r\n2,plain,\r\n3,"multi\nline",x\r\n';

    it('autosaves an edit and leaves every untouched row byte-identical', async () => {
        const s = setup(source);
        openPane(s, P1);
        const document = await ready(s, P1);
        const before = await s.service.state(P1);
        const after = await s.service.edit(P1, before.generation, [{ op: 'set-cell', row: 2, column: 1, value: 'edited, now' }]);
        expect(after.dirty).toBe(true);
        expect(after.generation).toBe(before.generation);
        expect(after.canUndo).toBe(true);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('id,name,note\r\n1,"Smith, J","said ""hi"""\r\n2,"edited, now",\r\n3,"multi\nline",x\r\n');
        const saved = await s.service.state(P1);
        expect(saved.incarnation).toBe(before.incarnation);
        expect(saved.generation).toBe(before.generation);
        expect(tmpFiles(s.dir)).toEqual([]);
        // Logical rows survive the rebase: the next edit with the same generation lands.
        await s.service.edit(P1, before.generation, [{ op: 'set-cell', row: 3, column: 2, value: 'y' }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8').endsWith('3,"multi\nline",y\r\n')).toBe(true);
    });

    it('takes the line ending from the scan when the first record is longer than the sniff sample', async () => {
        const long = 'h'.repeat(70 * 1024);
        const s = setup(`${long},b\r\n1,2\r\n`, { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        await ready(s, P1);
        const state = await s.service.state(P1);
        expect(state.dialect?.lineEnding).toBe('\r\n');
        await s.service.edit(P1, state.generation, [{ op: 'insert-rows', at: 2, count: 1, rows: [['3', '4']] }]);
        s.service.flushSync();
        expect(fs.readFileSync(s.file, 'utf8')).toBe(`${long},b\r\n1,2\r\n3,4\r\n`);
    });

    it('applies a batch in order, structural ops bump the generation, undo/redo cross saves', async () => {
        const s = setup('a,b\n1,2\n3,4\n');
        openPane(s, P1);
        const document = await ready(s, P1);
        const start = await s.service.state(P1);
        const batch = await s.service.edit(P1, start.generation, [
            { op: 'insert-rows', at: 3, count: 2, rows: [['5', '6'], ['7']] },
            { op: 'set-cell', row: 4, column: 1, value: '8' },
            { op: 'insert-column', at: 1 }
        ]);
        expect(batch.generation).toBe(`${start.incarnation}:2`);
        expect(batch.columns).toEqual([0, 2, 1]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,,b\n1,,2\n3,,4\n5,,6\n7,,8\n');
        // One undo reverts the whole batch, even though a save rebased the file in between.
        await s.service.edit(P1, batch.generation, [{ op: 'undo' }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,b\n1,2\n3,4\n');
        const redone = await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'redo' }]);
        expect(redone.canRedo).toBe(false);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,,b\n1,,2\n3,,4\n5,,6\n7,,8\n');
    });

    it('undoes a column delete and a row delete after the file was rebased', async () => {
        const s = setup('a,b,c\n1,"2,5",3\n4,5,6\n');
        openPane(s, P1);
        const document = await ready(s, P1);
        let state = await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'delete-column', column: 1 }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,c\n1,3\n4,6\n');
        state = await s.service.edit(P1, state.generation, [{ op: 'delete-rows', start: 1, count: 1 }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,c\n4,6\n');
        await s.service.edit(P1, state.generation, [{ op: 'undo' }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,c\n1,3\n4,6\n');
        state = await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'undo' }]);
        expect(state.columns).toEqual([0, 1, 2]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,b,c\n1,"2,5",3\n4,5,6\n');
    });

    it('an over-budget delete clears history and says so', async () => {
        const s = setup('a\n' + 'row\n'.repeat(50), { document: { undoBudgetBytes: 200 } });
        openPane(s, P1);
        await ready(s, P1);
        const state = await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'delete-rows', start: 1, count: 40 }]);
        expect(state.canUndo).toBe(false);
        expect(state.notice).toContain('too large to undo');
        expect(state.rowCount).toBe(11);
    });

    it('rolls a failing batch back and validates bounds against the document', async () => {
        const s = setup('a,b\n1,2\n');
        openPane(s, P1);
        const document = await ready(s, P1);
        const generation = (await s.service.state(P1)).generation;
        const outOfRange = await failure(s.service.edit(P1, generation, [
            { op: 'set-cell', row: 1, column: 0, value: 'kept?' },
            { op: 'set-cell', row: 9, column: 0, value: 'x' }
        ]));
        expect(code(outOfRange)).toBe('CSV_INVALID');
        expect(await cells(s, P1)).toEqual([['a', 'b'], ['1', '2']]);
        expect(code(await failure(s.service.edit(P1, generation, [{ op: 'set-cell', row: 0, column: 7, value: 'x' }])))).toBe('CSV_INVALID');
        const deleted = await s.service.edit(P1, generation, [{ op: 'delete-column', column: 1 }]);
        expect(code(await failure(s.service.edit(P1, deleted.generation, [{ op: 'set-cell', row: 0, column: 1, value: 'x' }])))).toBe('CSV_GONE');
        expect(code(await failure(s.service.edit(P1, deleted.generation, [{ op: 'insert-rows', at: 0, count: 1, rows: [['a', 'b', 'c']] }])))).toBe('CSV_INVALID');
        await settled(document);
    });

    it('a failing batch applies nothing, even after an op too large to undo or an undo', async () => {
        const rows = Array.from({ length: 50 }, (_, i) => `r${String(i)}`);
        const s = setup(['a', ...rows].join('\n') + '\n', { document: { undoBudgetBytes: 2000, autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const generation = (await s.service.state(P1)).generation;
        await s.service.edit(P1, generation, [{ op: 'set-cell', row: 10, column: 0, value: 'edited' }]);
        const before = await s.service.state(P1);
        // The delete is over the undo budget (no inverse); the set-cell after it fails.
        const error = await failure(s.service.edit(P1, generation, [
            { op: 'delete-rows', start: 1, count: 40 },
            { op: 'set-cell', row: 9_000_000, column: 0, value: 'x' }
        ]));
        expect(code(error)).toBe('CSV_INVALID');
        let after = await s.service.state(P1);
        expect(after.rowCount).toBe(51);
        expect(after.generation).toBe(before.generation);
        expect(after.canUndo).toBe(true);
        expect(after.notice).toBeNull();
        expect(document.editsSinceSave).toBe(1);
        expect((await cells(s, P1, 10, 1))[0]).toEqual(['edited']);
        // An undo in a failing batch is put back too.
        expect(code(await failure(s.service.edit(P1, generation, [{ op: 'undo' }, { op: 'delete-rows', start: 60, count: 1 }])))).toBe('CSV_INVALID');
        after = await s.service.state(P1);
        expect(after.canUndo).toBe(true);
        expect(after.canRedo).toBe(false);
        expect((await cells(s, P1, 10, 1))[0]).toEqual(['edited']);
        // History still points at the right row.
        await s.service.edit(P1, after.generation, [{ op: 'undo' }]);
        expect((await cells(s, P1)).map(row => row[0])).toEqual(['a', ...rows]);
    });

    it('a synchronous save during a batch writes only whole batches, and the batch still lands', async () => {
        const s = setup('k\n' + Array.from({ length: 20 }, (_, i) => `r${String(i)}`).join('\n') + '\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const generation = (await s.service.state(P1)).generation;
        await s.service.edit(P1, generation, [{ op: 'set-cell', row: 1, column: 0, value: 'before' }]);
        const reads = holdReads();
        // The insert applies at once; the set-cell after it waits on a read of row 5.
        const batch = s.service.edit(P1, generation, [
            { op: 'insert-rows', at: 3, count: 1, rows: [['inserted']] },
            { op: 'set-cell', row: 5, column: 0, value: 'during' }
        ]);
        await until(() => reads.held() > 0);
        s.service.flushSync(); // a pane close, quit or SIGTERM in the middle of the batch
        const flushed = fs.readFileSync(s.file, 'utf8');
        reads.release();
        await batch;
        expect(flushed.split('\n').slice(0, 4)).toEqual(['k', 'before', 'r1', 'r2']);
        expect(flushed).not.toContain('inserted');
        expect(document.dirty).toBe(true);
        expect((await cells(s, P1, 0, 6)).map(row => row[0])).toEqual(['k', 'before', 'r1', 'inserted', 'r2', 'during']);
        s.service.flushSync();
        expect(fs.readFileSync(s.file, 'utf8').split('\n').slice(0, 6)).toEqual(['k', 'before', 'r1', 'inserted', 'r2', 'during']);
    });

    it('translates a stale edit through inserts and deletes, refuses deleted targets and other incarnations', async () => {
        const s = setup('h\nr1\nr2\nr3\nr4\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        await ready(s, P1);
        const old = (await s.service.state(P1)).generation;
        await s.service.edit(P1, old, [{ op: 'insert-rows', at: 1, count: 2, rows: [['n1'], ['n2']] }]);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'delete-rows', start: 0, count: 1 }]);
        // `old` row 3 ("r3") is now logical row 4.
        await s.service.edit(P1, old, [{ op: 'set-cell', row: 3, column: 0, value: 'R3' }]);
        expect((await cells(s, P1)).map(row => row[0])).toEqual(['n1', 'n2', 'r1', 'r2', 'R3', 'r4']);
        expect(code(await failure(s.service.edit(P1, old, [{ op: 'set-cell', row: 0, column: 0, value: 'x' }])))).toBe('CSV_GONE');
        await s.service.discard(P1);
        await s.service.documentFor(P1)?.scanDone;
        expect(code(await failure(s.service.edit(P1, old, [{ op: 'set-cell', row: 0, column: 0, value: 'x' }])))).toBe('CSV_STALE');
        // More structural ops than the translation log holds.
        const fresh = (await s.service.state(P1)).generation;
        for (let i = 0; i < 70; i += 1) {
            await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'insert-rows', at: 0, count: 1 }]);
        }
        expect(code(await failure(s.service.edit(P1, fresh, [{ op: 'set-cell', row: 0, column: 0, value: 'x' }])))).toBe('CSV_STALE');
        expect(code(await failure(s.service.edit(P1, 'garbage', [{ op: 'undo' }])))).toBe('CSV_INVALID');
    });

    it('edits made during an async save are replayed onto the rebased file', async () => {
        const body = 'k,v\n' + Array.from({ length: 3000 }, (_, i) => `${String(i)},x`).join('\n') + '\n';
        const s = setup(body, { document: { autosaveSmallMs: 60_000, chunkBytes: 64 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const generation = (await s.service.state(P1)).generation;
        await s.service.edit(P1, generation, [{ op: 'set-cell', row: 1, column: 1, value: 'first' }]);
        await document.startSave();
        expect(document.isSaving).toBe(true);
        await s.service.edit(P1, generation, [{ op: 'insert-rows', at: 1, count: 1, rows: [['new', 'row']] }]);
        await until(() => !document.isSaving);
        expect(document.dirty).toBe(true);
        expect((await cells(s, P1, 0, 3))).toEqual([['k', 'v'], ['new', 'row'], ['0', 'first']]);
        await document.startSave();
        await settled(document);
        const lines = fs.readFileSync(s.file, 'utf8').split('\n');
        expect(lines.slice(0, 3)).toEqual(['k,v', 'new,row', '0,first']);
        expect(lines.length).toBe(3003);
    });

    it('flushSync aborts an in-flight async save and writes everything synchronously', async () => {
        const body = 'k\n' + 'abcdefgh\n'.repeat(4000);
        const s = setup(body, { document: { autosaveSmallMs: 60_000, chunkBytes: 32 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const generation = (await s.service.state(P1)).generation;
        await s.service.edit(P1, generation, [{ op: 'set-cell', row: 1, column: 0, value: 'one' }]);
        await document.startSave();
        expect(document.isSaving).toBe(true);
        // Not awaited: the edit queues behind nothing and lands before the flush below.
        await s.service.edit(P1, generation, [{ op: 'set-cell', row: 2, column: 0, value: 'two' }]);
        s.service.flushSync();
        expect(document.dirty).toBe(false);
        expect(document.isSaving).toBe(false);
        expect(fs.readFileSync(s.file, 'utf8').startsWith('k\none\ntwo\nabcdefgh\n')).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(tmpFiles(s.dir)).toEqual([]);
        expect(fs.readFileSync(s.file, 'utf8').startsWith('k\none\ntwo\nabcdefgh\n')).toBe(true);
        expect(await cells(s, P1, 0, 3)).toEqual([['k'], ['one'], ['two']]);
    });

    it('prepareClose saves a small file synchronously and a large one in the background', async () => {
        const small = setup('a\n1\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(small, P1);
        await ready(small, P1);
        await small.service.edit(P1, (await small.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'closed' }]);
        small.service.prepareClose(P1);
        expect(fs.readFileSync(small.file, 'utf8')).toBe('a\nclosed\n');

        const large = setup('a\n1\n', { document: { largeFileBytes: 1, autosaveLargeMs: 60_000, autosaveMaxMs: 60_000 } });
        openPane(large, P1);
        await ready(large, P1);
        await large.service.edit(P1, (await large.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'background' }]);
        large.service.prepareClose(P1);
        large.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await until(() => large.service.openDocuments.length === 0);
        expect(fs.readFileSync(large.file, 'utf8')).toBe('a\nbackground\n');
    });

    it('flushForQuit saves small files synchronously', async () => {
        const s = setup('a\n1\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'quit' }]);
        s.service.flushForQuit();
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a\nquit\n');
    });

    it('a failed save is reported and keeps the edits; discard drops them', async () => {
        const s = setup('a\n1\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'x' }]);
        fs.chmodSync(s.dir, 0o500);
        try {
            expect(() => s.service.prepareClose(P1)).toThrow("Couldn't save");
            const state = await s.service.state(P1);
            expect(state.dirty).toBe(true);
            expect(state.error).toContain("Couldn't save");
        } finally {
            fs.chmodSync(s.dir, 0o700);
        }
        const discarded = await s.service.discard(P1);
        expect(discarded.dirty).toBe(false);
        expect(discarded.error).toBeNull();
        await document.scanDone;
        expect(await cells(s, P1)).toEqual([['a'], ['1']]);
        expect(document.closed).toBe(false);
    });
});

describe('CsvService background save notices', () => {
    const large = { largeFileBytes: 1, autosaveLargeMs: 60_000, autosaveMaxMs: 60_000 };

    it('tells the user when a background save fails after the last pane closed, and retries on the next flush', async () => {
        const notices: CsvNotice[] = [];
        const s = setup('a\n1\n', { document: large, service: { notify: notice => notices.push(notice) } });
        openPane(s, P1);
        const document = await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'x' }]);
        fs.chmodSync(s.dir, 0o500);
        try {
            s.service.prepareClose(P1);
            s.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
            await until(() => notices.length > 0);
        } finally {
            fs.chmodSync(s.dir, 0o700);
        }
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({ paneID: P1, workspaceID: W1, realpath: s.file, title: "Couldn't save data.csv" });
        expect(notices[0]?.body).toMatch(/permission denied/i);
        expect(notices[0]?.body).toContain('saving is retried when Kelpi shuts down');
        expect(document.closed).toBe(false);
        expect(document.dirty).toBe(true);
        s.service.flushSync();
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a\nx\n');
    });

    it('tells the user when edits are discarded after the last pane closed', async () => {
        const notices: CsvNotice[] = [];
        const s = setup('a,b\n1,2\n', { document: large, service: { notify: notice => notices.push(notice) } });
        openPane(s, P1);
        await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'mine' }]);
        // Rewritten in place before the background save starts: the save refuses, edits are dropped.
        fs.writeFileSync(s.file, 'x,y\n9,8\n7,6\n');
        s.service.prepareClose(P1);
        s.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await until(() => notices.length > 0);
        expect(notices[0]).toMatchObject({ paneID: P1, title: 'data.csv changed on disk', body: '1 unsaved edit was discarded.' });
        await until(() => s.service.openDocuments.length === 0);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('x,y\n9,8\n7,6\n');
    });

    it('a pane with the file open shows the discard in its own notice instead', async () => {
        const notices: CsvNotice[] = [];
        const s = setup('a\n1\n', { document: { autosaveSmallMs: 60_000 }, service: { notify: notice => notices.push(notice) } });
        openPane(s, P1);
        const document = await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'mine' }]);
        fs.writeFileSync(s.file, 'b\n2\n3\n');
        await document.enqueue(() => document.checkDisk());
        expect((await s.service.state(P1)).notice).toContain('discarded');
        expect(notices).toEqual([]);
    });
});

describe('CsvService shared documents and raw text', () => {
    it('two panes on one file share a document, hear each other, and sort independently', async () => {
        const s = setup('n,v\nb,2\na,3\nc,1\n');
        openPane(s, P1);
        openPane(s, P2);
        const document = await ready(s, P1);
        await ready(s, P2);
        expect(s.service.documentFor(P2)).toBe(document);
        const heard: CsvPaneState[] = [];
        const sub1 = await s.service.subscribe(P1, state => heard.push(state));
        const sub2 = await s.service.subscribe(P2, state => heard.push(state));
        await s.service.edit(P1, sub1.state.generation, [{ op: 'set-cell', row: 1, column: 0, value: 'B' }]);
        expect(heard.map(state => state.paneID)).toEqual(expect.arrayContaining([P1, P2]));
        expect((await cells(s, P2))[1]).toEqual(['B', '2']);
        const sorted = await s.service.sort(P2, 1, 'asc');
        expect(sorted.sort).toEqual({ column: 1, direction: 'asc', pending: false });
        expect((await cells(s, P2)).map(row => row[0])).toEqual(['n', 'c', 'B', 'a']);
        expect((await cells(s, P1)).map(row => row[0])).toEqual(['n', 'B', 'a', 'c']);
        expect((await s.service.state(P1)).sort).toBeNull();
        sub1.unsubscribe();
        sub2.unsubscribe();
    });

    it('hands the file to raw text while a save is in flight, and takes it back', async () => {
        const body = 'k\n' + 'abcdefgh\n'.repeat(3000);
        const s = setup(body, { document: { autosaveSmallMs: 60_000, chunkBytes: 32 } });
        openPane(s, P1);
        openPane(s, P2);
        const document = await ready(s, P1);
        await ready(s, P2);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'saved' }]);
        await document.startSave();
        expect(document.isSaving).toBe(true);
        await s.service.prepareRaw(P1);
        expect(document.isSaving).toBe(false);
        expect(fs.readFileSync(s.file, 'utf8').startsWith('k\nsaved\n')).toBe(true);
        const other = await s.service.state(P2);
        expect(other.readOnly?.code).toBe('raw-elsewhere');
        expect(other.rawEditable).toBe(false);
        expect(code(await failure(s.service.edit(P2, other.generation, [{ op: 'set-cell', row: 1, column: 0, value: 'x' }])))).toBe('CSV_READ_ONLY');
        expect((await s.service.state(P1)).readOnly).toBeNull();
        // The raw editor writes the file (atomically, like writeFileAtomic).
        const temp = path.join(s.dir, '.raw.tmp');
        fs.writeFileSync(temp, 'k\nfrom raw\n');
        fs.renameSync(temp, s.file);
        await s.service.afterRaw(P1);
        await document.scanDone;
        const back = await s.service.state(P2);
        expect(back.readOnly).toBeNull();
        expect(back.incarnation).not.toBe(other.incarnation);
        expect(await cells(s, P2)).toEqual([['k'], ['from raw']]);
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(tmpFiles(s.dir)).toEqual([]);
    });

    it('refuses raw text above the limit and for read-only files', async () => {
        const s = setup('a\n' + 'x\n'.repeat(100), { document: { rawEditLimitBytes: 50 } });
        openPane(s, P1);
        await ready(s, P1);
        expect((await s.service.state(P1)).rawEditable).toBe(false);
        await expect(s.service.prepareRaw(P1)).rejects.toThrow('too large to edit as raw text');
        const bad = setup(Buffer.from([0xff, 0xfe, 0x61, 0x00]));
        openPane(bad, P1);
        await ready(bad, P1);
        expect(code(await failure(bad.service.prepareRaw(P1)))).toBe('CSV_READ_ONLY');
    });

    it('grid edits are refused while the pane itself shows raw text', async () => {
        const s = setup('a\n1\n');
        openPane(s, P1);
        await ready(s, P1);
        s.h.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: P1, editing: true });
        expect(code(await failure(s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'undo' }])))).toBe('CSV_READ_ONLY');
    });
});

describe('CsvService external changes', () => {
    it('drops unsaved edits with a notice when the file is rewritten in place', async () => {
        const s = setup('a,b\n1,2\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const before = await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'mine' }, { op: 'set-cell', row: 1, column: 1, value: 'too' }]);
        expect(before.dirty).toBe(true);
        fs.writeFileSync(s.file, 'x,y\n9,8\n7,6\n');
        await document.enqueue(() => document.checkDisk());
        await document.scanDone;
        const after = await s.service.state(P1);
        expect(after.dirty).toBe(false);
        expect(after.notice).toBe('The file changed on disk; 2 unsaved edits were discarded.');
        expect(after.incarnation).not.toBe(before.incarnation);
        expect(await cells(s, P1)).toEqual([['x', 'y'], ['9', '8'], ['7', '6']]);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('x,y\n9,8\n7,6\n');
    });

    it('reloads a clean document rewritten in place, without a notice', async () => {
        const s = setup('a,b\n1,2\n');
        openPane(s, P1);
        const document = await ready(s, P1);
        fs.writeFileSync(s.file, 'c\n');
        await document.enqueue(() => document.checkDisk());
        await document.scanDone;
        const state = await s.service.state(P1);
        expect(state.notice).toBeNull();
        expect(await cells(s, P1)).toEqual([['c']]);
    });

    it('a replaced file: a clean document follows it, a dirty one keeps its edits and wins', async () => {
        const s = setup('a\n1\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const replace = (text: string): void => {
            const temp = path.join(s.dir, 'next.tmp');
            fs.writeFileSync(temp, text);
            fs.renameSync(temp, s.file);
        };
        replace('b\n2\n');
        await document.enqueue(() => document.checkDisk());
        await document.scanDone;
        expect(await cells(s, P1)).toEqual([['b'], ['2']]);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 0, value: 'ours' }]);
        replace('theirs\n');
        await document.enqueue(() => document.checkDisk());
        expect(await cells(s, P1)).toEqual([['b'], ['ours']]);
        s.service.flushSync();
        expect(fs.readFileSync(s.file, 'utf8')).toBe('b\nours\n');
    });

    it('indexes only the appended tail when a clean file grows on the same inode', async () => {
        const s = setup('a,b\n1,2');
        openPane(s, P1);
        const document = await ready(s, P1);
        const before = await s.service.state(P1);
        fs.appendFileSync(s.file, '3\n4,5,6\n');
        await document.enqueue(() => document.checkDisk());
        await until(() => document.scanning === null);
        const after = await s.service.state(P1);
        expect(after.incarnation).toBe(before.incarnation);
        expect(after.generation).not.toBe(before.generation);
        expect(after.rowCount).toBe(3);
        expect(after.columns).toEqual([0, 1, 2]);
        expect(await cells(s, P1)).toEqual([['a', 'b', ''], ['1', '23', ''], ['4', '5', '6']]);
        // An edit computed before the append still lands (rows only grew at the end).
        await s.service.edit(P1, before.generation, [{ op: 'set-cell', row: 1, column: 0, value: 'one' }]);
        await settled(document);
        expect(fs.readFileSync(s.file, 'utf8')).toBe('a,b\none,23\n4,5,6\n');
    });

    it('a same-inode rewrite that keeps the old tail and grows is not taken for an append', async () => {
        const tail = 'x'.repeat(63) + '\n';
        const s = setup('id\na,1\nb,2\n' + tail);
        openPane(s, P1);
        const document = await ready(s, P1);
        const before = await s.service.state(P1);
        // Same length up to the old tail (so the last 64 indexed bytes are unchanged), different
        // record boundaries before it, then more rows.
        fs.writeFileSync(s.file, 'id\nab,123\n\n' + tail + 'c,3\n');
        await document.enqueue(() => document.checkDisk());
        await document.scanDone;
        await until(() => document.scanning === null);
        const after = await s.service.state(P1);
        expect(after.incarnation).not.toBe(before.incarnation);
        const rows = await cells(s, P1);
        expect(rows.map(row => row[0])).toEqual(['id', 'ab', '', 'x'.repeat(63), 'c']);
        expect(rows[1]).toEqual(['ab', '123']);
    });

    it('an append during the first scan is indexed after it, without restarting the scan', async () => {
        const body = 'id,v\n' + Array.from({ length: 2000 }, (_, i) => `${String(i)},x`).join('\n') + '\n';
        const s = setup(body, { document: { chunkBytes: 256 } });
        openPane(s, P1);
        // The head read (for the dialect) and the scan's first chunk pass; the scan stops after.
        const reads = holdReads(1);
        void s.service.state(P1);
        await until(() => reads.held() > 0 && s.service.documentFor(P1) !== null);
        const document = s.service.documentFor(P1) as CsvDocument;
        const incarnation = document.incarnation;
        expect(document.scanning).not.toBeNull();
        fs.appendFileSync(s.file, '2000,appended\n');
        await document.enqueue(() => document.checkDisk()); // what the watcher's event runs
        expect(document.incarnation).toBe(incarnation);
        reads.release();
        await document.scanDone;
        await until(() => document.rowCount === 2002 && document.scanning === null);
        expect(document.incarnation).toBe(incarnation);
        expect((await cells(s, P1, 2000, 2))).toEqual([['1999', 'x'], ['2000', 'appended']]);
    });

    it('recognises its own saves through the watcher and reloads on an external write', async () => {
        const listeners: ((event: string, filename: string | null) => void)[] = [];
        const watch: WatchFn = (_path, listener) => {
            listeners.push(listener);
            return { close: () => undefined, on: () => undefined };
        };
        const s = setup('a\n1\n', { document: { watch, reattachDelayMs: 1 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const fire = (event: string): void => {
            for (const listener of [...listeners]) listener(event, null);
        };
        const start = await s.service.state(P1);
        await s.service.edit(P1, start.generation, [{ op: 'set-cell', row: 1, column: 0, value: 'self' }]);
        await settled(document);
        fire('rename');
        await new Promise(resolve => setTimeout(resolve, 30));
        await document.enqueue(() => undefined);
        const afterSelf = await s.service.state(P1);
        expect(afterSelf.incarnation).toBe(start.incarnation);
        expect(afterSelf.notice).toBeNull();
        fs.writeFileSync(s.file, 'external\n');
        fire('change');
        await until(() => document.incarnation !== start.incarnation);
        await document.scanDone;
        expect(await cells(s, P1)).toEqual([['external']]);
    });
});

describe('CsvService sort and find', () => {
    const body = 'name,score\n' + ['delta,4', 'alpha,10', 'echo,', 'bravo,2', 'charlie,10', 'foxtrot,x'].join('\n') + '\n';

    it('sorts with an external merge, pins the header row and drops the sort on a structural edit', async () => {
        const s = setup(body, { service: { sortBatchRows: 2, sortReadRows: 2 } });
        openPane(s, P1);
        await ready(s, P1);
        const state = await s.service.sort(P1, 1, 'asc');
        expect(state.sort).toEqual({ column: 1, direction: 'asc', pending: false });
        const rows = await s.service.rows(P1, { start: 0, count: 10 });
        expect(rows.rows.map(row => row.cells[0])).toEqual(['name', 'bravo', 'delta', 'alpha', 'charlie', 'foxtrot', 'echo']);
        expect(rows.rows.map(row => row.row)).toEqual([0, 4, 1, 2, 5, 6, 3]);
        const desc = await s.service.sort(P1, 0, 'desc');
        expect(desc.sort?.direction).toBe('desc');
        expect((await cells(s, P1)).map(row => row[0])).toEqual(['name', 'foxtrot', 'echo', 'delta', 'charlie', 'bravo', 'alpha']);
        // Header off: row 0 sorts with the rest.
        const off = await s.service.setHeaderRow(P1, false);
        expect(off.headerRow).toBe(false);
        expect(findPaneAnywhere(s.h.state(), P1)?.pane.csvHeaderRow).toBe(false);
        await until(() => s.service.documentFor(P1) !== null && (s.service as unknown as { entries: Map<string, { sort: { pending: boolean } | null }> }).entries.get(P1)?.sort?.pending === false);
        expect((await cells(s, P1)).map(row => row[0])).toEqual(['name', 'foxtrot', 'echo', 'delta', 'charlie', 'bravo', 'alpha']);
        const edited = await s.service.edit(P1, desc.generation, [{ op: 'insert-rows', at: 1, count: 1 }]);
        expect(edited.sort).toBeNull();
        const cleared = await s.service.sort(P1, null, 'asc');
        expect(cleared.sort).toBeNull();
        expect(code(await failure(s.service.sort(P1, 99, 'asc')))).toBe('CSV_GONE');
    });

    it('finds case-insensitively, caps the count and steps in the pane view order', async () => {
        const s = setup(body, { document: { findCap: 3 } });
        openPane(s, P1);
        await ready(s, P1);
        expect(await s.service.find(P1, 'A')).toEqual({ query: 'A', total: 3, complete: true, truncated: true });
        const uncapped = setup(body);
        openPane(uncapped, P1);
        await ready(uncapped, P1);
        expect(await uncapped.service.find(P1, '10')).toEqual({ query: '10', total: 2, complete: true, truncated: false });
        const first = await uncapped.service.findStep(P1, '10', 'next', null);
        expect(first.match).toEqual({ view: 2, row: 2, column: 1 });
        expect(first.index).toBe(1);
        const wrapped = await uncapped.service.findStep(P1, '10', 'next', { view: 5, column: 1 });
        expect(wrapped.match?.row).toBe(2);
        await uncapped.service.sort(P1, 0, 'desc');
        const sortedFirst = await uncapped.service.findStep(P1, '10', 'next', null);
        // Descending by name: name | foxtrot echo delta charlie bravo alpha.
        expect(sortedFirst.match).toEqual({ view: 4, row: 5, column: 1 });
        const previous = await uncapped.service.findStep(P1, '10', 'previous', null);
        expect(previous.match).toEqual({ view: 6, row: 2, column: 1 });
        expect((await uncapped.service.find(P1, '')).total).toBe(0);
        // An edit invalidates the index.
        await uncapped.service.edit(P1, (await uncapped.service.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 1, value: '10' }]);
        expect((await uncapped.service.find(P1, '10')).total).toBe(3);
    });
});

describe('CsvService reads racing changes', () => {
    it('a rows read racing a save that rebases a column delete keeps cells under their column ids', async () => {
        const s = setup('a,b,c\n1,2,3\n4,5,6\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        await ready(s, P1);
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'delete-column', column: 1 }]);
        const reads = holdReads();
        const pending = s.service.rows(P1, { start: 0, count: 10 });
        await until(() => reads.held() > 0);
        s.service.flushSync(); // rebases: the new file has fields a,c
        reads.release();
        const reply = await pending;
        expect(reply.columnIDs).toEqual([0, 2]);
        expect(reply.rows.map(row => row.cells)).toEqual([['a', 'c'], ['1', '3'], ['4', '6']]);
        expect(await cells(s, P1)).toEqual([['a', 'c'], ['1', '3'], ['4', '6']]);
    });

    it('find reports an index the document kept changing under as incomplete', async () => {
        const s = setup('v\nx1\nx2\nx3\nx4\nx5\n', { document: { autosaveSmallMs: 60_000 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        // An edited row splits the scan into runs; the revision is checked between them.
        await s.service.edit(P1, (await s.service.state(P1)).generation, [{ op: 'set-cell', row: 3, column: 0, value: 'x3!' }]);
        const original = fs.read.bind(fs) as (...args: unknown[]) => void;
        const spy = vi.spyOn(fs, 'read').mockImplementation(((...args: unknown[]) => {
            document.revision += 1; // an edit lands during every read
            original(...args);
        }) as unknown as typeof fs.read);
        let reply;
        try {
            reply = await s.service.find(P1, 'x');
        } finally {
            spy.mockRestore();
        }
        expect(reply.complete).toBe(false);
        expect(reply.total).toBeLessThan(5);
        expect(await s.service.find(P1, 'x')).toMatchObject({ complete: true, total: 5 });
    });
});

describe('CsvService lifecycle', () => {
    it('a pane closed while its file opens leaves no document behind', async () => {
        const s = setup('a\n1\n');
        openPane(s, P1);
        const closed = vi.spyOn(CsvDocument.prototype, 'close');
        cleanups.push(() => closed.mockRestore());
        const pending = s.service.state(P1);
        s.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        await expect(pending).rejects.toThrow();
        await until(() => closed.mock.calls.length > 0);
        expect(s.service.openDocuments).toEqual([]);
    });

    it('closes the file when opening the document fails', async () => {
        const s = setup('a\n1\n');
        openPane(s, P1);
        const opened: number[] = [];
        const realOpen = fs.open.bind(fs) as (...args: unknown[]) => void;
        const openSpy = vi.spyOn(fs, 'open').mockImplementation(((...args: unknown[]) => {
            const callback = args[args.length - 1] as (error: NodeJS.ErrnoException | null, fd: number) => void;
            realOpen(...args.slice(0, -1), (error: NodeJS.ErrnoException | null, fd: number) => {
                if (error === null) opened.push(fd);
                callback(error, fd);
            });
        }) as unknown as typeof fs.open);
        const readSpy = vi.spyOn(fs, 'read').mockImplementationOnce(((...args: unknown[]) => {
            const callback = args[args.length - 1] as ReadCallback;
            setImmediate(() => callback(new Error('injected read failure'), 0, Buffer.alloc(0)));
        }) as unknown as typeof fs.read);
        let state: CsvPaneState;
        try {
            state = await s.service.state(P1);
        } finally {
            openSpy.mockRestore();
            readSpy.mockRestore();
        }
        expect(state.error).toContain('injected read failure');
        expect(opened).toHaveLength(1);
        expect(() => fs.fstatSync(opened[0] as number)).toThrow();
    });

    it('persists the header row on the pane and follows store changes', async () => {
        const s = setup('a\n1\n');
        openPane(s, P1);
        await ready(s, P1);
        const heard: boolean[] = [];
        const sub = await s.service.subscribe(P1, state => heard.push(state.headerRow));
        s.h.dispatch({ type: 'set-csv-header-row', workspaceID: W1, paneID: P1, on: false });
        expect(heard).toEqual([false]);
        sub.unsubscribe();
    });

    it('closes the document when its last pane closes, and when the workspace goes', async () => {
        const s = setup('a\n1\n');
        openPane(s, P1);
        openPane(s, P2);
        const document = await ready(s, P1);
        await ready(s, P2);
        s.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        expect(document.closed).toBe(false);
        s.h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P2 });
        expect(document.closed).toBe(true);
        expect(s.service.openDocuments).toEqual([]);
        await expect(s.service.state(P1)).rejects.toThrow("no pane matches");
    });

    it('drops idle clean documents and reopens them on demand', async () => {
        const s = setup('a\n1\n', { service: { idleDropMs: 20 } });
        openPane(s, P1);
        const document = await ready(s, P1);
        const sub = await s.service.subscribe(P1, () => undefined);
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(document.closed).toBe(false);
        sub.unsubscribe();
        await until(() => document.closed);
        await ready(s, P1);
        const state = await s.service.state(P1);
        expect(state.loaded).toBe(true);
        expect(state.incarnation).not.toBe(document.incarnation);
    });

    it('releases unwatched clean documents above the memory budget, least recently used first', async () => {
        const s = setup('a\n1\n', { service: { memoryBudgetBytes: 1 } });
        const second = path.join(s.dir, 'second.csv');
        const third = path.join(s.dir, 'third.csv');
        fs.writeFileSync(second, 'b\n2\n');
        fs.writeFileSync(third, 'c\n3\n');
        const P3 = id('eeeeeeee', 3);
        openPane(s, P1);
        openPane(s, P2, second);
        openPane(s, P3, third);
        const first = await ready(s, P1);
        const sub = await s.service.subscribe(P1, () => undefined);
        const two = await ready(s, P2);
        const three = await ready(s, P3);
        // P1 is watched, so the unwatched P2 went when P3 loaded; P3 itself stays.
        expect(first.closed).toBe(false);
        expect(two.closed).toBe(true);
        expect(three.closed).toBe(false);
        await ready(s, P2);
        expect(s.service.documentFor(P2)).not.toBe(two);
        expect(await cells(s, P2)).toEqual([['b'], ['2']]);
        sub.unsubscribe();
    });

    it('refuses panes that are not csv panes', async () => {
        const s = setup('a\n');
        await expect(s.service.state(SHELL)).rejects.toThrow('is a shell pane, not a csv pane');
    });
});
