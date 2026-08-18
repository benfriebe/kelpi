import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRunPaths } from '../lifecycle/index.js';
import { clearPortFile, portFilePath, readPortFile, writePortFile } from './port.js';

const temporaries: string[] = [];

function runPaths() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-port-'));
    temporaries.push(dir);
    return resolveRunPaths({ dir, protocol: 7 });
}

afterEach(() => {
    while (temporaries.length > 0) {
        const dir = temporaries.pop();
        if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('port file', () => {
    it('is protocol-versioned next to the socket', () => {
        const paths = runPaths();
        expect(portFilePath(paths)).toBe(path.join(paths.dir, 'daemon-v7.port'));
    });

    it('round-trips the bound port at 0600', () => {
        const paths = runPaths();
        expect(readPortFile(paths)).toBeUndefined();

        writePortFile(paths, 51234);
        expect(readPortFile(paths)).toBe(51234);
        expect(fs.statSync(portFilePath(paths)).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(portFilePath(paths), 'utf8')).toBe('51234\n');
    });

    it('overwrites a previous port and clears cleanly', () => {
        const paths = runPaths();
        writePortFile(paths, 1);
        writePortFile(paths, 2);
        expect(readPortFile(paths)).toBe(2);
        clearPortFile(paths);
        expect(readPortFile(paths)).toBeUndefined();
        // Clearing twice is the desired end state, not an error.
        expect(() => clearPortFile(paths)).not.toThrow();
    });

    it('reads garbage, an empty file and out-of-range values as "no preference"', () => {
        const paths = runPaths();
        for (const contents of ['', '   ', 'nope', '0', '-1', '70000', '80.5']) {
            fs.mkdirSync(paths.dir, { recursive: true });
            fs.writeFileSync(portFilePath(paths), contents);
            expect(readPortFile(paths)).toBeUndefined();
        }
    });
});
