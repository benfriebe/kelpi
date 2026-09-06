/**
 * The shell log's file sink (#77).
 *
 * Every path here is under an `mkdtemp` root: a test that wrote to the real
 * `~/Library/Application Support/Kelpi/logs` would rotate away the log of whatever shell the
 * developer running the suite has open, which is the exact evidence this feature exists to keep.
 *
 * The cases are the three promises the module makes: it stays inside its bound, it keeps the
 * generations it says it keeps, and it never throws whatever the filesystem does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_GENERATIONS,
    DEFAULT_MAX_BYTES,
    createFileSink,
    shellLogFile
} from './log-file.js';
import { log, logFilePath, setLogStreams, startLogFile, stopLogFile, warn } from './log.js';

let root = '';
let file = '';
let stdout: string[] = [];

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-log-sink-'));
    file = path.join(root, 'logs', 'shell.log');
    // The suite's own output stays readable, and the file's bytes can be compared with what
    // stdout was handed rather than with what the test hoped it was handed.
    stdout = [];
    setLogStreams({ out: { write: (chunk) => stdout.push(chunk) }, err: { write: (chunk) => stdout.push(chunk) } });
});

afterEach(() => {
    stopLogFile();
    setLogStreams({ out: process.stdout, err: process.stderr });
    fs.rmSync(root, { recursive: true, force: true });
});

const read = (name: string): string => (fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : '');

describe('shellLogFile', () => {
    it('lands under the app state directory, in a logs/ subdirectory', () => {
        expect(shellLogFile('/tmp/some-user-data')).toBe('/tmp/some-user-data/logs/shell.log');
    });
});

describe('createFileSink', () => {
    it('creates the directory it was pointed at and appends what it is given', () => {
        const sink = createFileSink(file);
        sink.write('[shell] one\n');
        sink.write('[shell] two\n');
        sink.close();
        expect(read(file)).toBe('[shell] one\n[shell] two\n');
    });

    it('appends to an existing file rather than truncating it, and counts what is already there', () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'from the last session\n');
        const sink = createFileSink(file);
        expect(sink.bytes).toBe('from the last session\n'.length);
        sink.write('and this one\n');
        sink.close();
        expect(read(file)).toBe('from the last session\nand this one\n');
    });

    it('rotates when a write would take the file past the cap, and the live file starts empty', () => {
        const sink = createFileSink(file, { maxBytes: 20, generations: 2 });
        sink.write('0123456789\n'); // 11 bytes
        expect(sink.bytes).toBe(11);
        sink.write('abcdefghij\n'); // 11 more would be 22 > 20: rotate first
        expect(sink.bytes).toBe(11);
        sink.close();
        expect(read(`${file}.1`)).toBe('0123456789\n');
        expect(read(file)).toBe('abcdefghij\n');
    });

    it('never keeps more generations than it was asked for', () => {
        const sink = createFileSink(file, { maxBytes: 12, generations: 2 });
        for (const line of ['a\n', 'b\n', 'c\n', 'd\n']) sink.write(line.repeat(6)); // 12 bytes each
        sink.close();
        expect(read(file)).toBe('d\n'.repeat(6));
        expect(read(`${file}.1`)).toBe('c\n'.repeat(6));
        expect(fs.existsSync(`${file}.2`)).toBe(false);
        // The whole sink, at its documented bound: two files of twelve bytes.
        const total = [file, `${file}.1`].reduce((sum, name) => sum + fs.statSync(name).size, 0);
        expect(total).toBeLessThanOrEqual(12 * 2);
    });

    it('shifts every generation up when it is asked for more than two', () => {
        const sink = createFileSink(file, { maxBytes: 4, generations: 3 });
        sink.write('aaa\n');
        sink.write('bbb\n');
        sink.write('ccc\n');
        sink.write('ddd\n');
        sink.close();
        expect(read(file)).toBe('ddd\n');
        expect(read(`${file}.1`)).toBe('ccc\n');
        expect(read(`${file}.2`)).toBe('bbb\n');
        expect(fs.existsSync(`${file}.3`)).toBe(false);
    });

    it('keeps only the live file when asked for one generation', () => {
        const sink = createFileSink(file, { maxBytes: 4, generations: 1 });
        sink.write('aaa\n');
        sink.write('bbb\n');
        sink.close();
        expect(read(file)).toBe('bbb\n');
        expect(fs.existsSync(`${file}.1`)).toBe(false);
    });

    it('counts bytes rather than characters, so a multi-byte line cannot overshoot the cap', () => {
        const sink = createFileSink(file, { maxBytes: 10, generations: 2 });
        sink.write('×××\n'); // 7 bytes, 4 characters
        sink.write('×××\n'); // 7 more would be 14 > 10
        sink.close();
        expect(read(`${file}.1`)).toBe('×××\n');
        expect(read(file)).toBe('×××\n');
    });

    it('writes a line larger than the whole cap rather than dropping it', () => {
        const sink = createFileSink(file, { maxBytes: 4, generations: 2 });
        sink.write('start\n');
        const huge = `${'x'.repeat(500)}\n`;
        sink.write(huge);
        sink.close();
        expect(read(file)).toBe(huge);
        expect(read(`${file}.1`)).toBe('start\n');
    });

    it('comes back dead, and does not throw, when the directory cannot be created', () => {
        const blocked = path.join(root, 'a-file');
        fs.writeFileSync(blocked, 'not a directory');
        const errors: unknown[] = [];
        const sink = createFileSink(path.join(blocked, 'logs', 'shell.log'), {
            onError: (error) => errors.push(error)
        });
        expect(sink.live).toBe(false);
        expect(() => sink.write('[shell] anything\n')).not.toThrow();
        expect(errors).toHaveLength(1);
    });

    it('survives the file being deleted under it, and the next sink starts a fresh one', () => {
        const sink = createFileSink(file);
        sink.write('before\n');
        fs.rmSync(file);
        // A descriptor on an unlinked inode still accepts writes, so this neither throws nor
        // recovers: the lines go somewhere nobody can read until the shell restarts. That is
        // the documented limit of a sink that must never cost the app a line on stdout.
        expect(() => sink.write('after\n')).not.toThrow();
        expect(sink.live).toBe(true);
        sink.close();
        const next = createFileSink(file);
        next.write('a new session\n');
        next.close();
        expect(read(file)).toBe('a new session\n');
    });

    it('is inert after close', () => {
        const sink = createFileSink(file);
        sink.write('one\n');
        sink.close();
        sink.write('two\n');
        expect(read(file)).toBe('one\n');
        expect(sink.live).toBe(false);
    });

    it('ships a bound a user would recognise: a few MB, two generations', () => {
        expect(DEFAULT_MAX_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(DEFAULT_GENERATIONS).toBe(2);
    });
});

describe('log() through the file sink', () => {
    it('writes the same bytes to the file that stdout gets, and nothing else has to know', () => {
        const written = startLogFile(root);
        expect(written).toBe(file);
        expect(logFilePath()).toBe(file);
        log('web pane 1234 view owner=main bounds=0,0 100×100 (attached)');
        warn('something to look at later');
        stopLogFile();
        const contents = read(file);
        expect(contents).toBe(stdout.join(''));
        expect(contents).toContain('[shell] web pane 1234 view owner=main bounds=0,0 100×100 (attached)\n');
        expect(contents).toContain('[shell] warning: something to look at later\n');
        expect(logFilePath()).toBeNull();
    });

    it('a second start closes the first sink instead of leaking a descriptor', () => {
        startLogFile(root);
        const second = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-log-sink-2-'));
        try {
            startLogFile(second);
            log('after the swap');
            expect(read(file)).not.toContain('after the swap');
            expect(read(path.join(second, 'logs', 'shell.log'))).toContain('after the swap');
        } finally {
            stopLogFile();
            fs.rmSync(second, { recursive: true, force: true });
        }
    });

    it('reports no path, and keeps logging, when the sink cannot be opened', () => {
        const blocked = path.join(root, 'blocked-file');
        fs.writeFileSync(blocked, 'not a directory');
        expect(startLogFile(blocked)).toBeNull();
        expect(logFilePath()).toBeNull();
        expect(() => log('still fine')).not.toThrow();
    });
});
