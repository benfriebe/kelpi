import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { canonicalizePath, canonicalizeUserPath, directoryExists, lastPathComponent } from './paths.js';

const roots: string[] = [];

function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kelpi-graft-paths-${prefix}-`));
    roots.push(dir);
    return dir;
}

afterAll(() => {
    for (const root of roots) {
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best effort
        }
    }
});

describe('canonicalizePath', () => {
    it('resolves symlinks so /tmp and /private/tmp name the same repo (macOS)', () => {
        const dir = tmpDir('symlink');
        const real = fs.realpathSync(dir);
        expect(canonicalizePath(dir)).toBe(real);
        // The whole point: two spellings of the same directory must compare equal.
        expect(canonicalizePath(dir)).toBe(canonicalizePath(real));
    });

    it('tolerates a missing suffix by resolving the longest existing prefix', () => {
        const dir = tmpDir('missing');
        const real = fs.realpathSync(dir);
        const missing = path.join(dir, 'not-there', 'nested');
        expect(canonicalizePath(missing)).toBe(path.join(real, 'not-there', 'nested'));
    });

    it('collapses . and .. before resolving', () => {
        const dir = tmpDir('dots');
        const real = fs.realpathSync(dir);
        fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
        expect(canonicalizePath(path.join(dir, 'a', '..', 'a', 'b'))).toBe(
            path.join(real, 'a', 'b')
        );
    });

    it('is stable for a path whose every component is missing', () => {
        const absent = '/definitely/not/a/real/path/anywhere';
        expect(canonicalizePath(absent)).toBe(absent);
    });

    it('returns the empty string untouched', () => {
        expect(canonicalizePath('')).toBe('');
        expect(canonicalizePath('   ')).toBe('');
    });

    it('uses the injected realpath when one is supplied', () => {
        const fake = (input: string): string =>
            input === '/tmp' ? '/private/tmp' : (() => { throw new Error('ENOENT'); })();
        expect(canonicalizePath('/tmp/worktrees/x', fake)).toBe('/private/tmp/worktrees/x');
    });
});

describe('canonicalizeUserPath', () => {
    it('expands ~ before resolving, so a CLI --repo matches a recorded session', () => {
        const dir = tmpDir('home');
        const real = fs.realpathSync(dir);
        fs.mkdirSync(path.join(dir, 'code', 'kelpi'), { recursive: true });
        expect(canonicalizeUserPath('~/code/kelpi', dir)).toBe(path.join(real, 'code', 'kelpi'));
    });
});

describe('lastPathComponent', () => {
    it('names the folder, ignoring trailing separators', () => {
        expect(lastPathComponent('/Users/ben/nex/worktrees/my-feature')).toBe('my-feature');
        expect(lastPathComponent('/Users/ben/nex/worktrees/my-feature/')).toBe('my-feature');
        expect(lastPathComponent('my-feature')).toBe('my-feature');
        expect(lastPathComponent('')).toBe('');
    });
});

describe('directoryExists', () => {
    it('is false for a missing path and for a regular file', () => {
        const dir = tmpDir('exists');
        const file = path.join(dir, 'f.txt');
        fs.writeFileSync(file, 'x');
        expect(directoryExists(dir)).toBe(true);
        expect(directoryExists(file)).toBe(false);
        expect(directoryExists(path.join(dir, 'nope'))).toBe(false);
    });
});
