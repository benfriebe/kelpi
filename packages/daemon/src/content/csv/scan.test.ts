import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { incompleteUtf8Tail, RowIndex, scanFile, ScanCancelled, Utf8Validator } from './scan.js';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-scan-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

async function scan(content: string | Buffer, options: { chunkSize?: number; from?: number; maxRecordBytes?: number; delimiter?: string } = {}) {
    const file = path.join(dir, 'f.csv');
    fs.writeFileSync(file, content);
    const fd = fs.openSync(file, 'r');
    try {
        const index = new RowIndex();
        const size = fs.fstatSync(fd).size;
        const result = await scanFile({
            fd,
            from: options.from ?? 0,
            to: size,
            delimiter: options.delimiter ?? ',',
            index,
            chunkSize: options.chunkSize ?? 3,
            maxRecordBytes: options.maxRecordBytes
        });
        const starts: number[] = [];
        for (let i = 0; i < index.length; i += 1) starts.push(index.get(i));
        return { result, starts };
    } finally {
        fs.closeSync(fd);
    }
}

/** Record starts computed the slow, obvious way (for comparing chunked scans). */
function expectedStarts(content: string): number[] {
    const bytes = Buffer.from(content);
    const starts = bytes.length > 0 ? [0] : [];
    let inQuotes = false;
    let fieldStart = true;
    for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (inQuotes) {
            if (b === 0x22) {
                if (bytes[i + 1] === 0x22) i += 1;
                else inQuotes = false;
            }
            continue;
        }
        if (b === 0x0a) {
            if (i + 1 < bytes.length) starts.push(i + 1);
            fieldStart = true;
            continue;
        }
        if (b === 0x2c) {
            fieldStart = true;
            continue;
        }
        if (fieldStart && b === 0x22) inQuotes = true;
        fieldStart = false;
    }
    return starts;
}

describe('RowIndex', () => {
    it('grows across chunks without losing values', () => {
        const index = new RowIndex();
        const n = RowIndex.CHUNK * 2 + 17;
        for (let i = 0; i < n; i += 1) index.push(i * 3);
        expect(index.length).toBe(n);
        expect(index.get(RowIndex.CHUNK)).toBe(RowIndex.CHUNK * 3);
        expect(index.get(n - 1)).toBe((n - 1) * 3);
        expect(index.pop()).toBe((n - 1) * 3);
        index.truncate(5);
        expect(index.length).toBe(5);
        expect(() => index.get(5)).toThrow(RangeError);
        expect(index.get(4)).toBe(12);
    });
});

describe('csv scan', () => {
    const tricky = 'h1,h2,h3\n"quoted\nnewline",b,c\n"a ""q"" b",x\r\nplain,"x,y",z\n5" pipe,"",\n';

    it('finds every record start at every chunk size, quotes and CRLF split across chunks', async () => {
        const want = expectedStarts(tricky);
        for (const chunkSize of [1, 2, 3, 5, 7, 64]) {
            const { starts, result } = await scan(tricky, { chunkSize });
            expect(starts, `chunk ${String(chunkSize)}`).toEqual(want);
            expect(result.maxFields).toBe(3);
            expect(result.trailingNewline).toBe(true);
            expect(result.utf8).toBe(true);
        }
    });

    it('handles an empty file and a file without a trailing newline', async () => {
        expect((await scan('')).starts).toEqual([]);
        const noNewline = await scan('a,b\nc,d');
        expect(noNewline.starts).toEqual([0, 4]);
        expect(noNewline.result.trailingNewline).toBe(false);
    });

    it('starts after a BOM and counts ragged rows by their own fields', async () => {
        const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a,b,c\n1\n2,3\n\n')]);
        const { starts, result } = await scan(bom, { from: 3 });
        expect(starts).toEqual([3, 9, 11, 15]);
        expect(result.maxFields).toBe(3);
    });

    it('detects the first line ending and CRLF blank lines have no fields', async () => {
        const { result, starts } = await scan('a,b\r\n\r\nc,d\r\n', { chunkSize: 2 });
        expect(result.firstLineEnding).toBe('\r\n');
        expect(starts).toEqual([0, 5, 7]);
    });

    it('flags a record longer than maxRecordBytes (an unbalanced quote)', async () => {
        const { result, starts } = await scan('a,b\n"never closed,x\ny,z\nmore\n', { maxRecordBytes: 8 });
        expect(result.oversized).toBe(true);
        expect(starts).toEqual([0, 4]);
    });

    it('validates UTF-8 across chunk boundaries and flags invalid bytes', async () => {
        const good = 'é,日本,🎉\n';
        for (const chunkSize of [1, 2, 3, 4]) {
            expect((await scan(good, { chunkSize })).result.utf8).toBe(true);
        }
        const bad = Buffer.concat([Buffer.from('a,'), Buffer.from([0xc3, 0x28]), Buffer.from('\n')]);
        expect((await scan(bad, { chunkSize: 2 })).result.utf8).toBe(false);
        const truncated = Buffer.from([0x61, 0x2c, 0xe6, 0x97]);
        expect((await scan(truncated)).result.utf8).toBe(false);
    });

    it('can be cancelled between chunks', async () => {
        const file = path.join(dir, 'big.csv');
        fs.writeFileSync(file, 'a,b\n'.repeat(1000));
        const fd = fs.openSync(file, 'r');
        const signal = { aborted: false };
        try {
            const run = scanFile({
                fd, from: 0, to: 4000, delimiter: ',', index: new RowIndex(), chunkSize: 16, signal,
                onProgress: () => { signal.aborted = true; }
            });
            await expect(run).rejects.toBeInstanceOf(ScanCancelled);
        } finally {
            fs.closeSync(fd);
        }
    });

    it('uses the delimiter for the quote-at-field-start rule', async () => {
        const { starts } = await scan('a;"b\nc";d\ne;f\n', { delimiter: ';', chunkSize: 4 });
        expect(starts).toEqual([0, 10]);
    });
});

describe('utf-8 helpers', () => {
    it('measures an incomplete trailing sequence', () => {
        expect(incompleteUtf8Tail(Buffer.from([0x61]))).toBe(0);
        expect(incompleteUtf8Tail(Buffer.from([0x61, 0xe6]))).toBe(1);
        expect(incompleteUtf8Tail(Buffer.from([0x61, 0xe6, 0x97]))).toBe(2);
        expect(incompleteUtf8Tail(Buffer.from('日'))).toBe(0);
        expect(incompleteUtf8Tail(Buffer.from([0xf0, 0x9f, 0x8e]))).toBe(3);
    });

    it('validates chunk by chunk', () => {
        const validator = new Utf8Validator();
        const bytes = Buffer.from('🎉é');
        for (const byte of bytes) validator.feed(Buffer.from([byte]));
        expect(validator.finish()).toBe(true);
    });
});
