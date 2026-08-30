/// <reference types="node" />

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    columnNames,
    hasColumn,
    openSqliteDatabase,
    tableExists,
    tableNames,
    type SqlDatabase
} from './adapter.js';

let db: SqlDatabase;

beforeEach(() => {
    db = openSqliteDatabase(':memory:');
    db.exec('CREATE TABLE t ("id" TEXT PRIMARY KEY NOT NULL, "flag" BOOLEAN, "note" TEXT, "at" DOUBLE)');
});

afterEach(() => {
    db.close();
});

describe('parameter binding', () => {
    it('binds booleans as 0/1 and undefined as NULL (both drivers reject them raw)', () => {
        db.run('INSERT INTO t VALUES (?,?,?,?)', 'a', true, undefined, 1_755_500_000.5);
        db.run('INSERT INTO t VALUES (?,?,?,?)', 'b', false, 'x', 1);
        expect(db.all('SELECT * FROM t ORDER BY id')).toEqual([
            { id: 'a', flag: 1, note: null, at: 1_755_500_000.5 },
            { id: 'b', flag: 0, note: 'x', at: 1 }
        ]);
    });

    it('preserves float precision in DOUBLE columns', () => {
        db.run('INSERT INTO t VALUES (?,?,?,?)', 'a', null, null, 1_778_541_556.089_057_9);
        expect(db.get('SELECT "at" FROM t')?.['at']).toBe(1_778_541_556.089_057_9);
    });
});

describe('transactions', () => {
    it('commits on return', () => {
        db.transaction(() => {
            db.run('INSERT INTO t VALUES (?,?,?,?)', 'a', null, null, 1);
        });
        expect(db.all('SELECT "id" FROM t')).toEqual([{ id: 'a' }]);
    });

    it('rolls back everything on throw and rethrows', () => {
        db.run('INSERT INTO t VALUES (?,?,?,?)', 'pre', null, null, 1);
        expect(() =>
            db.transaction(() => {
                db.run('INSERT INTO t VALUES (?,?,?,?)', 'a', null, null, 1);
                throw new Error('boom');
            })
        ).toThrow('boom');
        expect(db.all('SELECT "id" FROM t')).toEqual([{ id: 'pre' }]);
    });

    it('recovers: a rolled-back transaction does not poison the next one', () => {
        expect(() =>
            db.transaction(() => {
                throw new Error('boom');
            })
        ).toThrow();
        db.transaction(() => {
            db.run('INSERT INTO t VALUES (?,?,?,?)', 'a', null, null, 1);
        });
        expect(db.all('SELECT "id" FROM t')).toEqual([{ id: 'a' }]);
    });

    it('nests via savepoints: an inner failure keeps the outer work', () => {
        db.transaction(() => {
            db.run('INSERT INTO t VALUES (?,?,?,?)', 'outer', null, null, 1);
            try {
                db.transaction(() => {
                    db.run('INSERT INTO t VALUES (?,?,?,?)', 'inner', null, null, 1);
                    throw new Error('nested boom');
                });
            } catch {
                // swallowed by the outer body
            }
        });
        expect(db.all('SELECT "id" FROM t')).toEqual([{ id: 'outer' }]);
    });

    it('returns the body result', () => {
        expect(db.transaction(() => 42)).toBe(42);
    });
});

describe('statements + lifecycle', () => {
    it('caches prepared statements by SQL text', () => {
        expect(db.prepare('SELECT 1')).toBe(db.prepare('SELECT 1'));
    });

    it('close() is idempotent and flips isOpen', () => {
        expect(db.isOpen).toBe(true);
        db.close();
        expect(db.isOpen).toBe(false);
        expect(() => db.close()).not.toThrow();
    });
});

describe('introspection', () => {
    it('reports tables and columns', () => {
        expect(tableExists(db, 't')).toBe(true);
        expect(tableExists(db, 'nope')).toBe(false);
        expect(columnNames(db, 't')).toEqual(['id', 'flag', 'note', 'at']);
        expect(columnNames(db, 'nope')).toEqual([]);
        expect(hasColumn(db, 't', 'flag')).toBe(true);
        expect(hasColumn(db, 't', 'missing')).toBe(false);
        db.exec('CREATE TABLE other ("x" TEXT)');
        expect(tableNames(db)).toEqual(['other', 't']);
    });
});

describe('file databases', () => {
    let dir = '';

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-adapter-'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('opens in WAL with foreign keys on (§1)', () => {
        const file = path.join(dir, 'x.db');
        const handle = openSqliteDatabase(file);
        expect(handle.get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
        expect(handle.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
        handle.close();
        expect(fs.existsSync(file)).toBe(true);
    });

    it('honours the foreignKeys:false escape hatch', () => {
        const handle = openSqliteDatabase(path.join(dir, 'y.db'), { foreignKeys: false });
        expect(handle.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 0 });
        handle.close();
    });

    it('throws while opening a file that is not a database, leaving the file alone', () => {
        const file = path.join(dir, 'corrupt.db');
        fs.writeFileSync(file, 'not sqlite');
        // SQLite defers the header check to the first statement, so this surfaces on the
        // opening pragma; `createPersistence` turns it into `isAvailable === false`.
        expect(() => openSqliteDatabase(file)).toThrow(/not a database/i);
        expect(fs.readFileSync(file, 'utf8')).toBe('not sqlite');
    });
});
