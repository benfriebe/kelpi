import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CsvDialect } from '@kelpi/protocol';

import { identityOf, openRealpathSync } from './open.js';
import { newRow, Overlay } from './overlay.js';
import { RowIndex, scanFile } from './scan.js';
import { checkBase, CsvSaveAborted, CsvSaveConflict, csvWriter, saveAsync, saveSync, type WriterBase } from './writer.js';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-writer-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const dialect = (overrides: Partial<CsvDialect> = {}): CsvDialect => ({ delimiter: ',', lineEnding: '\n', bom: false, quoteAll: false, ...overrides });

interface Indexed {
    readonly file: string;
    readonly base: WriterBase & { identity: ReturnType<typeof identityOf> };
    readonly maxFields: number;
}

async function indexed(content: string | Buffer, name = 'data.csv', from = 0): Promise<Indexed> {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const opened = openRealpathSync(fs.realpathSync(file));
    const index = new RowIndex();
    const result = await scanFile({ fd: opened.fd, from, to: opened.identity.size, delimiter: ',', index, chunkSize: 5 });
    return {
        file,
        maxFields: result.maxFields,
        base: { fd: opened.fd, index, size: opened.identity.size, trailingNewline: result.trailingNewline, identity: opened.identity }
    };
}

function render(plan: Parameters<typeof csvWriter>[0]): { text: string; output: ReturnType<typeof collect>['output'] } {
    const { chunks, output } = collect(plan);
    return { text: Buffer.concat(chunks).toString('utf8'), output };
}

function collect(plan: Parameters<typeof csvWriter>[0]) {
    const chunks: Buffer[] = [];
    const writer = csvWriter(plan);
    let step = writer.next();
    while (step.done !== true) {
        chunks.push(Buffer.from(step.value));
        step = writer.next();
    }
    return { chunks, output: step.value };
}

const target = (doc: Indexed) => ({ realpath: fs.realpathSync(doc.file), baseFd: doc.base.fd, baseIdentity: doc.base.identity });

async function rescanStarts(file: string): Promise<number[]> {
    const fd = fs.openSync(file, 'r');
    try {
        const index = new RowIndex();
        await scanFile({ fd, from: 0, to: fs.fstatSync(fd).size, delimiter: ',', index });
        return Array.from({ length: index.length }, (_, i) => index.get(i));
    } finally {
        fs.closeSync(fd);
    }
}

describe('csv writer', () => {
    const source = 'id,name,note\r\n1,"Smith, J","said ""hi"""\r\n2,plain,\r\n3,"multi\nline",x\r\n4,last,y\r\n';

    it('writes an untouched document byte for byte', async () => {
        const doc = await indexed(source);
        const { text, output } = render({ base: doc.base, overlay: Overlay.identity(doc.base.index.length, doc.maxFields), dialect: dialect({ lineEnding: '\r\n' }), chunkBytes: 7 });
        expect(text).toBe(source);
        expect(output.size).toBe(Buffer.byteLength(source));
        expect(Array.from({ length: output.index.length }, (_, i) => output.index.get(i))).toEqual(await rescanStarts(doc.file));
    });

    it('keeps untouched rows byte-identical around edits, inserts and deletes', async () => {
        const doc = await indexed(source);
        const overlay = Overlay.identity(doc.base.index.length, doc.maxFields);
        overlay.setCell(2, 1, 'edited', 'plain');
        overlay.insertRows(4, [newRow(['new', 'row, with comma', ''], [0, 1, 2])]);
        overlay.deleteRows(3, 1); // the multi-line row
        const { text, output } = render({ base: doc.base, overlay, dialect: dialect({ lineEnding: '\r\n' }), chunkBytes: 4 });
        expect(text).toBe('id,name,note\r\n1,"Smith, J","said ""hi"""\r\n2,edited,\r\nnew,"row, with comma",\r\n4,last,y\r\n');
        const out = path.join(dir, 'out.csv');
        fs.writeFileSync(out, text);
        expect(Array.from({ length: output.index.length }, (_, i) => output.index.get(i))).toEqual(await rescanStarts(out));
    });

    it('re-serialises every row when the column map changes, keeping original quoting', async () => {
        const doc = await indexed('a,b\n"1",2\n3,4\n');
        const overlay = Overlay.identity(3, 2);
        overlay.insertColumn(1, { id: overlay.nextColumnID, base: null });
        overlay.setCell(0, 2, 'mid', '');
        const { text, output } = render({ base: doc.base, overlay, dialect: dialect() });
        expect(text).toBe('a,mid,b\n"1",,2\n3,,4\n');
        expect(output.columnIDs).toEqual([0, 2, 1]);
        const deleted = Overlay.identity(3, 2);
        deleted.deleteColumn(0);
        expect(render({ base: doc.base, overlay: deleted, dialect: dialect() }).text).toBe('b\n2\n4\n');
    });

    it('adds a terminator after a last row that had none when rows follow it, and keeps its absence at the end', async () => {
        const doc = await indexed('a,b\nc,d');
        const appended = Overlay.identity(2, 2);
        appended.insertRows(2, [newRow(['e', 'f'], [0, 1])]);
        const { text, output } = render({ base: doc.base, overlay: appended, dialect: dialect() });
        expect(text).toBe('a,b\nc,d\ne,f');
        expect(output.trailingNewline).toBe(false);
        const edited = Overlay.identity(2, 2);
        edited.setCell(1, 0, 'C', 'c');
        expect(render({ base: doc.base, overlay: edited, dialect: dialect() }).text).toBe('a,b\nC,d');
    });

    it('keeps a missing trailing newline when the rows after the new last row are deleted', async () => {
        const lf = await indexed('a\nb\nc', 'lf.csv');
        const dropLast = Overlay.identity(3, 1);
        dropLast.deleteRows(2, 1);
        const { text, output } = render({ base: lf.base, overlay: dropLast, dialect: dialect(), chunkBytes: 1 });
        expect(text).toBe('a\nb');
        expect(output.trailingNewline).toBe(false);
        expect(output.size).toBe(3);
        // CRLF terminators are dropped whole.
        const crlf = await indexed('a\r\nb\r\nc', 'crlf.csv');
        const dropTwo = Overlay.identity(3, 1);
        dropTwo.deleteRows(1, 2);
        expect(render({ base: crlf.base, overlay: dropTwo, dialect: dialect({ lineEnding: '\r\n' }) }).text).toBe('a');
        // A materialised but unchanged row that ends the file is copied the same way.
        const materialised = Overlay.identity(3, 1);
        materialised.setCell(1, 0, 'b', 'b');
        materialised.deleteRows(2, 1);
        expect(render({ base: lf.base, overlay: materialised, dialect: dialect() }).text).toBe('a\nb');
        // A file that ended in a newline keeps it.
        const terminated = await indexed('a\nb\nc\n', 'terminated.csv');
        const kept = Overlay.identity(3, 1);
        kept.deleteRows(2, 1);
        expect(render({ base: terminated.base, overlay: kept, dialect: dialect() }).text).toBe('a\nb\n');
    });

    it('writes a UTF-8 BOM back and indexes past it', async () => {
        const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b\n1,2\n')]);
        const doc = await indexed(content, 'bom.csv', 3);
        const overlay = Overlay.identity(2, 2);
        overlay.setCell(1, 1, 'x', '2');
        const { chunks, output } = collect({ base: doc.base, overlay, dialect: dialect({ bom: true }) });
        const bytes = Buffer.concat(chunks);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(bytes.subarray(3).toString()).toBe('a,b\n1,x\n');
        expect(output.index.get(0)).toBe(3);
    });

    it('quote-all files quote every field of edited rows', async () => {
        const doc = await indexed('"a","b"\n"1","2"\n');
        const overlay = Overlay.identity(2, 2);
        overlay.setCell(1, 0, 'z', '1');
        expect(render({ base: doc.base, overlay, dialect: dialect({ quoteAll: true }) }).text).toBe('"a","b"\n"z","2"\n');
    });

    it('keeps ragged rows ragged with identity columns and pads them otherwise', async () => {
        const doc = await indexed('a,b,c\n1\n\n');
        const overlay = Overlay.identity(3, 3);
        overlay.setCell(1, 1, 'x', '');
        expect(render({ base: doc.base, overlay, dialect: dialect() }).text).toBe('a,b,c\n1,x\n\n');
        const moved = Overlay.identity(3, 3);
        moved.deleteColumn(2);
        expect(render({ base: doc.base, overlay: moved, dialect: dialect() }).text).toBe('a,b\n1,\n\n');
    });

    it('sync and async drivers write the same bytes and index', async () => {
        const make = async (name: string) => {
            const doc = await indexed(source, name);
            const overlay = Overlay.identity(doc.base.index.length, doc.maxFields);
            overlay.setCell(1, 2, 'changed "note"', '');
            overlay.insertRows(0, [newRow(['top'], [0])]);
            return { doc, overlay };
        };
        const a = await make('sync.csv');
        const b = await make('async.csv');
        const syncResult = saveSync({ base: a.doc.base, overlay: a.overlay, dialect: dialect({ lineEnding: '\r\n' }), chunkBytes: 3 }, target(a.doc));
        const job = saveAsync({ base: b.doc.base, overlay: b.overlay, dialect: dialect({ lineEnding: '\r\n' }), chunkBytes: 3 }, target(b.doc));
        const asyncResult = await job.done;
        expect(fs.readFileSync(a.doc.file)).toEqual(fs.readFileSync(b.doc.file));
        const starts = (result: typeof syncResult) => Array.from({ length: result.output.index.length }, (_, i) => result.output.index.get(i));
        expect(starts(syncResult)).toEqual(starts(asyncResult));
        expect(starts(syncResult)).toEqual(await rescanStarts(a.doc.file));
        expect(syncResult.raced).toBe(false);
        expect(syncResult.opened.identity.ino).toBe(fs.statSync(a.doc.file).ino);
        fs.closeSync(syncResult.opened.fd);
        fs.closeSync(asyncResult.opened.fd);
        expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });

    it('copies the file mode and saves through a symlink to its target', async () => {
        const doc = await indexed('a\n1\n', 'real.csv');
        fs.chmodSync(doc.file, 0o640);
        const link = path.join(dir, 'link.csv');
        fs.symlinkSync(doc.file, link);
        const base = { ...doc.base, identity: identityOf(fs.fstatSync(doc.base.fd)) };
        const overlay = Overlay.identity(2, 1);
        overlay.setCell(1, 0, '2', '1');
        const result = saveSync({ base, overlay, dialect: dialect() }, { realpath: fs.realpathSync(link), baseFd: base.fd, baseIdentity: base.identity });
        fs.closeSync(result.opened.fd);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(link, 'utf8')).toBe('a\n2\n');
        expect(fs.statSync(doc.file).mode & 0o777).toBe(0o640);
    });

    it('refuses to write when the base was modified in place, and cleans up', async () => {
        const doc = await indexed('a\n1\n');
        fs.appendFileSync(doc.file, '2\n');
        const overlay = Overlay.identity(2, 1);
        overlay.setCell(1, 0, 'x', '1');
        expect(() => saveSync({ base: doc.base, overlay, dialect: dialect() }, target(doc))).toThrow(CsvSaveConflict);
        expect(fs.readFileSync(doc.file, 'utf8')).toBe('a\n1\n2\n');
        expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });

    it('wins over a file that replaced the path (the base inode is intact)', async () => {
        const doc = await indexed('a\n1\n');
        const other = path.join(dir, 'other.csv');
        fs.writeFileSync(other, 'z\n9\n');
        fs.renameSync(other, doc.file);
        expect(() => checkBase(target(doc))).not.toThrow();
        const overlay = Overlay.identity(2, 1);
        overlay.setCell(1, 0, 'mine', '1');
        const result = saveSync({ base: doc.base, overlay, dialect: dialect() }, target(doc));
        fs.closeSync(result.opened.fd);
        expect(fs.readFileSync(doc.file, 'utf8')).toBe('a\nmine\n');
    });

    it('an aborted async save removes its temp file and never renames', async () => {
        const doc = await indexed('a\n'.repeat(2000));
        const overlay = Overlay.identity(2000, 1);
        overlay.setCell(0, 0, 'x', 'a');
        const job = saveAsync({ base: doc.base, overlay, dialect: dialect(), chunkBytes: 16 }, target(doc));
        job.abort();
        await expect(job.done).rejects.toBeInstanceOf(CsvSaveAborted);
        expect(fs.readFileSync(doc.file, 'utf8').startsWith('a\n')).toBe(true);
        expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    });
});
