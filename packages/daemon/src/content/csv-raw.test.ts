/**
 * #324: a csv pane in the content service. It holds text only in raw mode (⌘E), the csv
 * document service is asked to stand down BEFORE anything is dispatched and to reopen AFTER the
 * buffer is written, and the plugin `document()` view of it is cut to fit the JSON cap.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CSV_LIMITS, PLUGIN_MAX_JSON_BYTES, type CsvPaneState, type DocumentSnapshot } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findPaneAnywhere } from '../store/derived.js';
import { harness, id, NOW, seededState, W1 } from '../store/testing.js';
import type { CsvChannel, CsvRawTarget } from './csv/channel.js';
import { createContentService, fitPluginDocument, type ContentService } from './service.js';

const CSV = id('eeeeeeee', 9);
const SHELL = id('dddddddd', 100);
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function csvState(paneID: string, overrides: Partial<CsvPaneState> = {}): CsvPaneState {
    return {
        paneID, incarnation: 'i', revision: 1, generation: 'i:0', filePath: null, loaded: true, scanning: null,
        rowCount: 0, columns: [], bytes: 0, dialect: null, headerRow: true, sort: null, dirty: false, saving: false,
        canUndo: false, canRedo: false, rawEditable: true, readOnly: null, error: null, notice: null, ...overrides
    };
}

interface Fixture {
    readonly store: ReturnType<typeof harness>;
    readonly service: ContentService;
    readonly file: string;
    /** Every csv seam call and every `set-markdown-editing` dispatch, in order. */
    readonly log: string[];
    csvDirty: boolean;
    prepareFail: Error | null;
    /** What `prepareRaw` answers (default: the file as it is when asked). */
    prepareTarget: CsvRawTarget | null;
}

function fixture(body = 'a,b\n1,2\n', options: { csv?: boolean } = {}): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-raw-'));
    dirs.push(dir);
    const file = path.join(dir, 'data.csv');
    fs.writeFileSync(file, body);
    const store = harness(seededState(W1, SHELL));
    const log: string[] = [];
    const f = { csvDirty: false, prepareFail: null as Error | null, prepareTarget: null as CsvRawTarget | null };
    const csv: Partial<CsvChannel> = {
        async prepareRaw(paneID) {
            log.push(`prepareRaw:${paneID === CSV ? 'csv' : paneID}`);
            if (f.prepareFail !== null) throw f.prepareFail;
            if (f.prepareTarget !== null) return f.prepareTarget;
            const stat = fs.statSync(file);
            return { realpath: fs.realpathSync(file), dev: stat.dev, ino: stat.ino };
        },
        async afterRaw(paneID) {
            log.push(`afterRaw:${paneID === CSV ? 'csv' : paneID}`);
        },
        async state(paneID) {
            return csvState(paneID, { dirty: f.csvDirty });
        }
    };
    store.store.subscribe((events) => {
        for (const event of events) {
            if (event.kind === 'pane-upserted' && event.paneID === CSV) log.push(`editing:${String(event.pane.isEditing)}`);
        }
    });
    const service = createContentService({
        store: store.store,
        git: { getDiff: async () => '' },
        debounceMs: 20,
        ...(options.csv === false ? {} : { csv: csv as CsvChannel })
    });
    store.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: CSV, filePath: file, now: NOW, paneType: 'csv' });
    log.length = 0;
    return {
        store, service, file, log,
        get csvDirty() { return f.csvDirty; },
        set csvDirty(value: boolean) { f.csvDirty = value; },
        get prepareFail() { return f.prepareFail; },
        set prepareFail(value: Error | null) { f.prepareFail = value; },
        get prepareTarget() { return f.prepareTarget; },
        set prepareTarget(value: CsvRawTarget | null) { f.prepareTarget = value; }
    };
}

const editing = (f: Fixture): boolean | undefined => findPaneAnywhere(f.store.state(), CSV)?.pane.isEditing;

describe('csv panes in the content service', () => {
    it('holds no text and renders no HTML in grid mode', async () => {
        const f = fixture();
        const state = await f.service.state(CSV);
        expect(state.type).toBe('csv');
        expect(state.mode).toBe('view');
        expect(state.text).toBe('');
        expect(state.html).toBeNull();
        expect(state.loaded).toBe(true);
        f.service.dispose();
    });

    it('rejects setText, save and refresh outside raw mode', async () => {
        const f = fixture();
        await expect(f.service.setText(CSV, 'x')).rejects.toThrow('is not in edit mode');
        await expect(f.service.save(CSV)).rejects.toThrow('is not in edit mode');
        await expect(f.service.refresh(CSV)).rejects.toThrow('is not in edit mode');
        expect(fs.readFileSync(f.file, 'utf8')).toBe('a,b\n1,2\n');
        f.service.dispose();
    });

    it('view → edit asks the csv service to stand down before dispatching, then loads the text', async () => {
        const f = fixture();
        const state = await f.service.setMode(CSV, 'edit');
        expect(f.log).toEqual(['prepareRaw:csv', 'editing:true']);
        expect(state.mode).toBe('edit');
        expect(state.text).toBe('a,b\n1,2\n');
        expect(state.html).toBeNull();
        expect(editing(f)).toBe(true);
        f.service.dispose();
    });

    it('a refused prepareRaw leaves the pane in grid mode and dispatches nothing', async () => {
        const f = fixture();
        f.prepareFail = new Error('The file is too large to edit as raw text.');
        await expect(f.service.setMode(CSV, 'edit')).rejects.toThrow('too large');
        expect(f.log).toEqual(['prepareRaw:csv']);
        expect(editing(f)).toBe(false);
        expect((await f.service.state(CSV)).mode).toBe('view');
        f.service.dispose();
    });

    it('refuses raw mode for a file over the raw limit and hands the file back to the grid', async () => {
        const f = fixture('x'.repeat(CSV_LIMITS.rawEditLimitBytes + 1));
        await expect(f.service.setMode(CSV, 'edit')).rejects.toThrow('too large to edit as raw text');
        expect(f.log).toEqual(['prepareRaw:csv', 'afterRaw:csv']);
        expect(editing(f)).toBe(false);
        f.service.dispose();
    });

    it('refuses raw text that grew past the limit after its size was checked', async () => {
        const f = fixture('x'.repeat(CSV_LIMITS.rawEditLimitBytes + 10));
        // The descriptor's stat says small; the bytes behind it are not.
        const probe = await fs.promises.open(f.file, 'r');
        const proto = Object.getPrototypeOf(probe) as { stat(...args: unknown[]): Promise<fs.Stats> };
        await probe.close();
        const realStat = proto.stat;
        const spy = vi.spyOn(proto, 'stat').mockImplementation(async function (this: unknown, ...args: unknown[]) {
            const stat = await realStat.apply(this, args);
            Object.defineProperty(stat, 'size', { value: 10 });
            return stat;
        });
        try {
            await expect(f.service.setMode(CSV, 'edit')).rejects.toThrow('too large to edit as raw text');
        } finally {
            spy.mockRestore();
        }
        expect(f.log).toEqual(['prepareRaw:csv', 'afterRaw:csv']);
        expect(editing(f)).toBe(false);
        f.service.dispose();
    });

    it('refuses raw text when the file was replaced after the grid stood down', async () => {
        const f = fixture();
        const temp = `${f.file}.next`;
        fs.writeFileSync(temp, 'other\n');
        // prepareRaw answers with the inode it handed off; the path now names another one.
        const stat = fs.statSync(f.file);
        fs.renameSync(temp, f.file);
        f.prepareTarget = { realpath: fs.realpathSync(f.file), dev: stat.dev, ino: stat.ino };
        await expect(f.service.setMode(CSV, 'edit')).rejects.toThrow('replaced on disk');
        expect(f.log).toEqual(['prepareRaw:csv', 'afterRaw:csv']);
        expect(editing(f)).toBe(false);
        f.service.dispose();
    });

    it('edits and saves the raw text, then edit → view flushes, dispatches, and only then calls afterRaw', async () => {
        const f = fixture();
        await f.service.setMode(CSV, 'edit');
        await f.service.setText(CSV, 'a,b\n3,4\n');
        f.log.length = 0;
        const state = await f.service.setMode(CSV, 'view');
        // Written synchronously by the flush, before the dispatch and the grid's reopen.
        expect(fs.readFileSync(f.file, 'utf8')).toBe('a,b\n3,4\n');
        expect(f.log).toEqual(['editing:false', 'afterRaw:csv']);
        expect(state.mode).toBe('view');
        expect(state.text).toBe('');
        expect(state.dirty).toBe(false);
        f.service.dispose();
    });

    it('debounced raw saves land on disk; refresh re-reads a clean buffer', async () => {
        const f = fixture();
        await f.service.setMode(CSV, 'edit');
        await f.service.setText(CSV, 'z\n');
        await tick(60);
        expect(fs.readFileSync(f.file, 'utf8')).toBe('z\n');
        fs.writeFileSync(f.file, 'outside\n');
        const state = await f.service.refresh(CSV);
        expect(state.text).toBe('outside\n');
        f.service.dispose();
    });

    it('works without a csv service (raw mode on the file alone)', async () => {
        const f = fixture('q\n', { csv: false });
        const state = await f.service.setMode(CSV, 'edit');
        expect(state.text).toBe('q\n');
        expect(f.log).toEqual(['editing:true']);
        f.service.dispose();
    });

    it('document() reports kind csv, text only in raw mode, and the grid dirty flag', async () => {
        const f = fixture();
        f.csvDirty = true;
        const grid = await f.service.document(CSV);
        expect(grid).toMatchObject({ kind: 'csv', mode: 'view', text: '', loaded: true, dirty: true, path: f.file });
        expect(grid.truncated).toBeUndefined();
        await f.service.setMode(CSV, 'edit');
        const raw = await f.service.document(CSV);
        expect(raw).toMatchObject({ kind: 'csv', mode: 'edit', text: 'a,b\n1,2\n', dirty: false });
        f.service.dispose();
    });

    it('document() cuts raw text that would not fit the plugin JSON cap', async () => {
        const f = fixture('"' + 'é'.repeat(700_000) + '"\n');
        await f.service.setMode(CSV, 'edit');
        const doc = await f.service.document(CSV);
        expect(doc.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(doc), 'utf8')).toBeLessThanOrEqual(PLUGIN_MAX_JSON_BYTES - 256);
        expect(doc.text.length).toBeGreaterThan(50_000);
        expect('"' + 'é'.repeat(700_000)).toContain(doc.text);
        f.service.dispose();
    });
});

describe('fitPluginDocument', () => {
    const base: DocumentSnapshot = {
        paneID: 'p', workspaceID: 'w', kind: 'csv', mode: 'edit', path: '/a.csv', text: '',
        loaded: true, dirty: false, error: null, revision: 'r:1'
    };

    it('leaves a document that fits alone', () => {
        const doc = { ...base, text: 'small' };
        expect(fitPluginDocument(doc)).toBe(doc);
    });

    it('never splits a surrogate pair and fits the limit exactly', () => {
        const doc = { ...base, text: '😀'.repeat(400) };
        const fitted = fitPluginDocument(doc, 1000);
        expect(fitted.truncated).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(1000);
        expect(fitted.text.length % 2).toBe(0);
        expect(fitted.text).toBe('😀'.repeat(fitted.text.length / 2));
    });

    it('counts JSON escaping (quotes and newlines) against the cap', () => {
        const doc = { ...base, text: '"\n'.repeat(1000) };
        const fitted = fitPluginDocument(doc, 900);
        expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(900);
    });
});
