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

    it('lets NEXD_DB_PATH win on every platform', () => {
        for (const platform of ['darwin', 'linux'] as const) {
            expect(
                resolveDatabasePath({ env: { [DB_PATH_ENV]: '/tmp/custom/nex.db' }, platform, home: HOME })
            ).toBe('/tmp/custom/nex.db');
        }
    });

    it('expands ~ and honours :memory: in NEXD_DB_PATH', () => {
        expect(resolveDatabasePath({ env: { [DB_PATH_ENV]: '~/db/nex.db' }, platform: 'darwin', home: HOME })).toBe(
            path.join(HOME, 'db', 'nex.db')
        );
        expect(
            resolveDatabasePath({ env: { [DB_PATH_ENV]: MEMORY_DATABASE_PATH }, platform: 'darwin', home: HOME })
        ).toBe(MEMORY_DATABASE_PATH);
    });

    it('ignores a blank NEXD_DB_PATH', () => {
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
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-loc-'));
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
});
