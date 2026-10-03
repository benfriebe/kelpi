import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    compareAscii,
    compareKey,
    compareText,
    defaultSortCacheRoot,
    makeKeys,
    SortCancelled,
    SortDiskFull,
    sortRows,
    spillDirFor,
    sweepSortSpill,
    type SortSource
} from './sort.js';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-sort-'));
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
});

const source = (values: readonly string[], first = 0): SortSource => ({
    first,
    count: values.length - first,
    read: async (start, count) => values.slice(start, start + count)
});

describe('csv sort keys', () => {
    it('orders numbers before text before empties, empties last in both directions', () => {
        const keys = makeKeys(['10', 'apple', '', '2', '  ', '-3.5e1']);
        expect([...keys.cat]).toEqual([0, 1, 2, 0, 2, 0]);
        expect(keys.num[5]).toBe(-35);
        const cmp = (a: number, b: number, desc: boolean) =>
            compareKey(keys.cat[a] as number, keys.num[a] as number, keys.text[a] ?? null, keys.cat[b] as number, keys.num[b] as number, keys.text[b] ?? null, desc);
        expect(cmp(3, 0, false)).toBeLessThan(0); // 2 < 10 numerically
        expect(cmp(0, 1, false)).toBeLessThan(0); // number < text
        expect(cmp(1, 2, false)).toBeLessThan(0); // text < empty
        expect(cmp(1, 2, true)).toBeLessThan(0); // empty still last descending
        expect(cmp(0, 3, true)).toBeLessThan(0); // 10 before 2 descending
    });

    it('compares ASCII naturally and case-insensitively, other text with the collator', () => {
        expect(compareAscii('file2', 'file10')).toBeLessThan(0);
        expect(compareAscii('File2', 'file2')).toBe(0);
        expect(compareAscii('a007', 'a7')).toBe(0);
        expect(compareAscii('abc', 'abd')).toBeLessThan(0);
        expect(compareText('éclair', 'zebra')).toBeLessThan(0);
        expect(compareText('Ärger', 'arger')).toBe(0);
    });
});

describe('csv sortRows', () => {
    const values = ['header', 'pear', '3', '', 'Apple', '10', 'apple', 'banana', '3', ''];

    it('sorts in memory, stably, keeping the pinned header out', async () => {
        const order = await sortRows(source(values, 1), { direction: 'asc', spillDir: path.join(dir, 'spill') });
        expect([...order].map(row => values[row])).toEqual(['3', '3', '10', 'Apple', 'apple', 'banana', 'pear', '', '']);
        expect([...order]).toEqual([2, 8, 5, 4, 6, 7, 1, 3, 9]);
        const desc = await sortRows(source(values, 1), { direction: 'desc', spillDir: path.join(dir, 'spill') });
        expect([...desc].map(row => values[row])).toEqual(['pear', 'banana', 'Apple', 'apple', '10', '3', '3', '', '']);
    });

    it('an external merge with tiny batches matches the in-memory sort exactly', async () => {
        const random = (seed: number) => () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        const next = random(7);
        const many = Array.from({ length: 503 }, (_, i) => {
            const r = next();
            if (r < 0.1) return '';
            if (r < 0.5) return String(Math.floor(next() * 50));
            if (r < 0.6) return `naïve ${String(i % 7)}`;
            return `item${String(Math.floor(next() * 40))}`;
        });
        for (const direction of ['asc', 'desc'] as const) {
            const memory = await sortRows(source(many, 1), { direction, spillDir: path.join(dir, 'a') });
            const spill = path.join(dir, 'b');
            const external = await sortRows(source(many, 1), { direction, spillDir: spill, batchRows: 17, readRows: 5 });
            expect([...external]).toEqual([...memory]);
            // Spill files are removed after the merge.
            expect(fs.readdirSync(spill)).toEqual([]);
            expect(fs.statSync(spill).mode & 0o777).toBe(0o700);
        }
    });

    it('can be cancelled', async () => {
        const signal = { aborted: false };
        const slow: SortSource = {
            first: 0,
            count: 100,
            read: async (start, count) => {
                signal.aborted = true;
                return Array.from({ length: count }, (_, i) => String(start + i));
            }
        };
        await expect(sortRows(slow, { direction: 'asc', spillDir: dir, batchRows: 10, readRows: 10, signal })).rejects.toBeInstanceOf(SortCancelled);
    });

    it('reports a full disk as a sort error', async () => {
        vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
        await expect(sortRows(source(values), { direction: 'asc', spillDir: path.join(dir, 'full'), batchRows: 2 })).rejects.toBeInstanceOf(SortDiskFull);
    });
});

describe('csv sort spill directories', () => {
    it('sweeps directories of dead daemons only', () => {
        fs.mkdirSync(path.join(dir, '111'));
        fs.mkdirSync(path.join(dir, '222'));
        fs.mkdirSync(spillDirFor(dir));
        fs.mkdirSync(path.join(dir, 'not-a-pid'));
        const removed = sweepSortSpill(dir, pid => pid === 222);
        expect(removed).toEqual([path.join(dir, '111')]);
        expect(fs.readdirSync(dir).sort()).toEqual(['222', String(process.pid), 'not-a-pid'].sort());
    });

    it('lives under the user cache dir', () => {
        expect(defaultSortCacheRoot({}, 'darwin')).toBe(path.join(os.homedir(), 'Library', 'Caches', 'kelpi', 'csv-sort'));
        expect(defaultSortCacheRoot({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe('/xdg/kelpi/csv-sort');
        expect(defaultSortCacheRoot({}, 'linux')).toBe(path.join(os.homedir(), '.cache', 'kelpi', 'csv-sort'));
        expect(defaultSortCacheRoot({}, 'darwin', '/home/x')).toBe('/home/x/Library/Caches/kelpi/csv-sort');
    });
});
