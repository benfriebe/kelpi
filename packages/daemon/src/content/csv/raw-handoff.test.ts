/**
 * #324 end to end: ⌘E on a csv pane with the REAL content service driving the REAL csv service.
 * Unsaved grid edits reach the disk before the text editor loads, the grid refuses edits while
 * the pane shows raw text, and leaving raw text reopens what the editor wrote.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { csvErrorCode } from '@kelpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { findPaneAnywhere } from '../../store/derived.js';
import { harness, id, NOW, seededState, W1 } from '../../store/testing.js';
import { createContentService } from '../service.js';
import { CsvService } from './service.js';

const SHELL = id('dddddddd', 100);
const P1 = id('eeeeeeee', 11);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('csv raw-text hand-off (content service + csv service)', () => {
    it('flushes grid edits before raw text and reloads after it', async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-raw-e2e-')));
        const file = path.join(dir, 'data.csv');
        fs.writeFileSync(file, 'a,b\n1,2\n');
        const h = harness(seededState(W1, SHELL));
        const csv = new CsvService({ store: h.store, sortCacheRoot: path.join(dir, '.sort'), document: { watch: false, autosaveSmallMs: 60_000 } });
        const content = createContentService({ store: h.store, csv, git: { getDiff: async () => '' }, watch: false, debounceMs: 5 });
        cleanups.push(async () => {
            content.dispose();
            await csv.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        });
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: P1, filePath: file, now: NOW, paneType: 'csv' });
        await csv.state(P1);
        const document = csv.documentFor(P1);
        await document?.scanDone;
        const before = await csv.edit(P1, (await csv.state(P1)).generation, [{ op: 'set-cell', row: 1, column: 1, value: 'grid' }]);
        expect(before.dirty).toBe(true);

        const raw = await content.setMode(P1, 'edit');
        expect(findPaneAnywhere(h.state(), P1)?.pane.isEditing).toBe(true);
        expect(raw.text).toBe('a,b\n1,grid\n');
        expect(fs.readFileSync(file, 'utf8')).toBe('a,b\n1,grid\n');
        const blocked = await csv.edit(P1, before.generation, [{ op: 'undo' }]).catch((error: unknown) => error);
        expect(csvErrorCode(String((blocked as Error).message))).toBe('CSV_READ_ONLY');

        await content.setText(P1, 'a,b\n1,typed\n3,4\n');
        await content.setMode(P1, 'view');
        expect(findPaneAnywhere(h.state(), P1)?.pane.isEditing).toBe(false);
        expect(fs.readFileSync(file, 'utf8')).toBe('a,b\n1,typed\n3,4\n');
        await csv.documentFor(P1)?.scanDone;
        const after = await csv.state(P1);
        expect(after.rowCount).toBe(3);
        expect(after.incarnation).not.toBe(before.incarnation);
        expect((await csv.rows(P1, { start: 0, count: 10 })).rows.map(row => row.cells)).toEqual([['a', 'b'], ['1', 'typed'], ['3', '4']]);
    });

    it('raw text edits the file the grid has open, even after its symlink is retargeted', async () => {
        const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-raw-link-')));
        const a = path.join(dir, 'a.csv');
        const b = path.join(dir, 'b.csv');
        const link = path.join(dir, 'link.csv');
        fs.writeFileSync(a, 'a\n1\n');
        fs.writeFileSync(b, 'b\n2\n');
        fs.symlinkSync(a, link);
        const h = harness(seededState(W1, SHELL));
        const csv = new CsvService({ store: h.store, sortCacheRoot: path.join(dir, '.sort'), document: { watch: false, autosaveSmallMs: 60_000 } });
        const content = createContentService({ store: h.store, csv, git: { getDiff: async () => '' }, watch: false, debounceMs: 5 });
        cleanups.push(async () => {
            content.dispose();
            await csv.dispose();
            fs.rmSync(dir, { recursive: true, force: true });
        });
        h.dispatch({ type: 'open-markdown-pane', workspaceID: W1, paneID: P1, filePath: link, now: NOW, paneType: 'csv' });
        await csv.state(P1);
        await csv.documentFor(P1)?.scanDone;
        expect(csv.documentFor(P1)?.realpath).toBe(a);
        // Retargeted after the grid opened the file.
        fs.unlinkSync(link);
        fs.symlinkSync(b, link);

        const raw = await content.setMode(P1, 'edit');
        expect(raw.text).toBe('a\n1\n');
        await content.setText(P1, 'a\nraw\n');
        await content.setMode(P1, 'view');
        expect(fs.readFileSync(a, 'utf8')).toBe('a\nraw\n');
        expect(fs.readFileSync(b, 'utf8')).toBe('b\n2\n');
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        await csv.documentFor(P1)?.scanDone;
        expect((await csv.rows(P1, { start: 0, count: 10 })).rows.map(row => row.cells)).toEqual([['a'], ['raw']]);
    });
});
