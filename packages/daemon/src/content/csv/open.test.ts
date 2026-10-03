import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CsvNotRegularError, openCsvFile, openFailureMessage, processAlive, sweepOrphanTemps, tempPathFor } from './open.js';

let dir: string;

beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-csv-open-')));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('csv open', () => {
    it('opens a regular file by its realpath and records its identity', async () => {
        const file = path.join(dir, 'a.csv');
        fs.writeFileSync(file, 'x,y\n');
        const link = path.join(dir, 'link.csv');
        fs.symlinkSync(file, link);
        const opened = await openCsvFile(link);
        try {
            expect(opened.realpath).toBe(file);
            expect(opened.identity.size).toBe(4);
            expect(opened.identity.ino).toBe(fs.statSync(file).ino);
        } finally {
            fs.closeSync(opened.fd);
        }
    });

    it('refuses a directory', async () => {
        const target = path.join(dir, 'folder.csv');
        fs.mkdirSync(target);
        await expect(openCsvFile(target)).rejects.toBeInstanceOf(CsvNotRegularError);
        await expect(openCsvFile(target)).rejects.toThrow('is a directory');
    });

    it('refuses a FIFO without blocking on it', async () => {
        const fifo = path.join(dir, 'pipe.csv');
        try {
            execFileSync('mkfifo', [fifo]);
        } catch {
            return; // no mkfifo on this system
        }
        await expect(openCsvFile(fifo)).rejects.toThrow('is a named pipe');
    });

    it('explains failures in a sentence', () => {
        expect(openFailureMessage('/x.csv', Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe('/x.csv does not exist.');
        expect(openFailureMessage('/x.csv', Object.assign(new Error('nope'), { code: 'EACCES' }))).toContain('permission denied');
    });

    it('names temp files like writeFileAtomic and sweeps only dead owners', () => {
        const file = path.join(dir, 'data.csv');
        fs.writeFileSync(file, 'a\n');
        const temp = tempPathFor(file);
        expect(path.basename(temp)).toMatch(new RegExp(`^\\.data\\.csv\\.kelpi-${String(process.pid)}-\\d+\\.tmp$`));
        const dead = path.join(dir, '.data.csv.kelpi-999991-3.tmp');
        const alive = path.join(dir, '.data.csv.kelpi-999992-4.tmp');
        const mine = path.join(dir, `.data.csv.kelpi-${String(process.pid)}-5.tmp`);
        const other = path.join(dir, '.other.csv.kelpi-999991-6.tmp');
        for (const name of [dead, alive, mine, other]) fs.writeFileSync(name, 'partial');
        const removed = sweepOrphanTemps(file, pid => pid === 999992);
        expect(removed).toEqual([dead]);
        expect(fs.existsSync(alive)).toBe(true);
        expect(fs.existsSync(mine)).toBe(true);
        expect(fs.existsSync(other)).toBe(true);
    });

    it('knows its own process is alive', () => {
        expect(processAlive(process.pid)).toBe(true);
    });
});
