/// <reference types="node" />

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DATABASE_FILENAME,
    DB_DIR_MODE,
    DB_PATH_ENV,
    ensureDatabaseDir,
    expandTilde,
    legacyMacAppDatabasePath,
    MEMORY_DATABASE_PATH,
    prepareDatabaseFile,
    resolveDatabasePath,
    resolveDataDir
} from './location.js';

const HOME = '/Users/tester';

describe('database location', () => {
    it('uses ~/Library/Application Support/nexd on darwin', () => {
        expect(resolveDatabasePath({ env: {}, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'Library', 'Application Support', 'nexd', DATABASE_FILENAME)
        );
    });

    it('prefers XDG_DATA_HOME on linux', () => {
        expect(
            resolveDatabasePath({ env: { XDG_DATA_HOME: '/var/data' }, platform: 'linux', home: HOME })
        ).toBe(path.join('/var/data', 'nexd', DATABASE_FILENAME));
    });

    it('falls back to ~/.local/share/nexd on linux', () => {
        expect(resolveDatabasePath({ env: {}, platform: 'linux', home: HOME })).toBe(
            path.join(HOME, '.local', 'share', 'nexd', DATABASE_FILENAME)
        );
    });

    it('expands ~ in XDG_DATA_HOME', () => {
        expect(resolveDataDir({ env: { XDG_DATA_HOME: '~/data' }, platform: 'linux', home: HOME })).toBe(
            path.join(HOME, 'data', 'nexd')
        );
    });

    it('lets KELPID_DB_PATH win on every platform', () => {
        for (const platform of ['darwin', 'linux'] as const) {
            expect(
                resolveDatabasePath({ env: { [DB_PATH_ENV]: '/tmp/custom/nex.db' }, platform, home: HOME })
            ).toBe('/tmp/custom/nex.db');
        }
    });

    it('expands ~ and honours :memory: in KELPID_DB_PATH', () => {
        expect(resolveDatabasePath({ env: { [DB_PATH_ENV]: '~/db/nex.db' }, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'db', 'nex.db')
        );
        expect(
            resolveDatabasePath({ env: { [DB_PATH_ENV]: MEMORY_DATABASE_PATH }, platform: 'darwin', home: HOME })
        ).toBe(MEMORY_DATABASE_PATH);
    });

    it('ignores a blank KELPID_DB_PATH', () => {
        expect(resolveDatabasePath({ env: { [DB_PATH_ENV]: '   ' }, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'Library', 'Application Support', 'nexd', DATABASE_FILENAME)
        );
    });

    it('keeps its own directory, never the Swift app\'s (which stays available for M8 import)', () => {
        expect(resolveDatabasePath({ env: {}, platform: 'darwin', home: HOME })).not.toBe(
            legacyMacAppDatabasePath(HOME)
        );
        expect(legacyMacAppDatabasePath(HOME)).toBe(
            path.join(HOME, 'Library', 'Application Support', 'Nex', DATABASE_FILENAME)
        );
    });

    it('expands ~ forms only', () => {
        expect(expandTilde('~', HOME)).toBe(HOME);
        expect(expandTilde('~/x', HOME)).toBe(path.join(HOME, 'x'));
        expect(expandTilde('~x', HOME)).toBe('~x');
        expect(expandTilde('/abs', HOME)).toBe('/abs');
    });
});

describe('ensureDatabaseDir', () => {
    let root = '';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-loc-'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('creates the parent directory 0700, recursively', () => {
        const target = path.join(root, 'a', 'b', DATABASE_FILENAME);
        const dir = ensureDatabaseDir(target);
        expect(dir).toBe(path.join(root, 'a', 'b'));
        expect(fs.statSync(dir).isDirectory()).toBe(true);
        expect(fs.statSync(dir).mode & 0o777).toBe(DB_DIR_MODE);
    });

    it('is idempotent', () => {
        const target = path.join(root, 'c', DATABASE_FILENAME);
        ensureDatabaseDir(target);
        expect(() => ensureDatabaseDir(target)).not.toThrow();
    });

    // ── the P0 ──────────────────────────────────────────────────────────────
    //
    // `KELPID_DB_PATH=/tmp/kelpid-dev.db` used to make this function chmod('/tmp', 0700). /tmp is
    // root-owned and mode 1777, so a normal user gets EPERM, which was thrown out of
    // `createPersistence`'s open path, caught, and turned into a daemon that ran all day with
    // persistence quietly disabled. Nothing here may touch a directory it did not create.

    it('uses an existing shared parent as-is — no chmod, no throw (the /tmp case)', () => {
        const before = fs.statSync('/tmp').mode & 0o7777;
        expect(() => ensureDatabaseDir('/tmp/kelpid-location-test.db')).not.toThrow();
        expect(ensureDatabaseDir('/tmp/kelpid-location-test.db')).toBe('/tmp');
        // Unchanged, and specifically NOT 0700.
        expect(fs.statSync('/tmp').mode & 0o7777).toBe(before);
        expect(fs.existsSync('/tmp/kelpid-location-test.db')).toBe(false);
    });

    it('leaves the permissions of any pre-existing parent alone', () => {
        const shared = path.join(root, 'shared');
        fs.mkdirSync(shared, { recursive: true });
        fs.chmodSync(shared, 0o755);

        ensureDatabaseDir(path.join(shared, DATABASE_FILENAME));

        expect(fs.statSync(shared).mode & 0o777).toBe(0o755);
    });

    it('still locks down every level it creates itself', () => {
        const target = path.join(root, 'deep', 'nested', 'tree', DATABASE_FILENAME);
        ensureDatabaseDir(target);
        for (const dir of [
            path.join(root, 'deep'),
            path.join(root, 'deep', 'nested'),
            path.join(root, 'deep', 'nested', 'tree')
        ]) {
            expect(fs.statSync(dir).mode & 0o777).toBe(DB_DIR_MODE);
        }
    });

    it('creates a 0700 directory under a world-writable shared parent', () => {
        // The fixture for "a directory several tools share", e.g. /tmp itself.
        const shared = path.join(root, 'shared-1777');
        fs.mkdirSync(shared);
        fs.chmodSync(shared, 0o1777);

        const dir = ensureDatabaseDir(path.join(shared, 'nexd', DATABASE_FILENAME));

        expect(fs.statSync(dir).mode & 0o777).toBe(DB_DIR_MODE);
        expect(fs.statSync(shared).mode & 0o7777).toBe(0o1777);
    });
});

describe('prepareDatabaseFile', () => {
    let root = '';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-prep-'));
    });

    afterEach(() => {
        // Restore anything the tests locked down, or the rm fails.
        for (const entry of fs.readdirSync(root)) {
            try {
                fs.chmodSync(path.join(root, entry), 0o700);
            } catch {
                // not a directory we changed
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('returns the resolved path for a usable location', () => {
        const target = path.join(root, 'a', DATABASE_FILENAME);
        expect(prepareDatabaseFile(target)).toBe(target);
        expect(fs.existsSync(path.join(root, 'a'))).toBe(true);
    });

    it('fails with the real errno and the real path when the parent is unwritable', () => {
        const locked = path.join(root, 'locked');
        fs.mkdirSync(locked);
        fs.chmodSync(locked, 0o500);

        // node:sqlite would have said only "unable to open database file" — no code, no path.
        expect(() => prepareDatabaseFile(path.join(locked, DATABASE_FILENAME))).toThrow(
            expect.objectContaining({ code: 'EACCES' }) as Error
        );
        expect(() => prepareDatabaseFile(path.join(locked, DATABASE_FILENAME))).toThrow(locked);
    });

    it('fails when the file itself is not writable', () => {
        const target = path.join(root, DATABASE_FILENAME);
        fs.writeFileSync(target, '');
        fs.chmodSync(target, 0o444);

        expect(() => prepareDatabaseFile(target)).toThrow(
            expect.objectContaining({ code: 'EACCES' }) as Error
        );
        fs.chmodSync(target, 0o600);
    });

    it('fails when a path component is a file', () => {
        const file = path.join(root, 'not-a-dir');
        fs.writeFileSync(file, 'x');

        expect(() => prepareDatabaseFile(path.join(file, DATABASE_FILENAME))).toThrow(
            expect.objectContaining({ code: expect.stringMatching(/ENOTDIR|EEXIST/) as unknown as string }) as Error
        );
    });
});
