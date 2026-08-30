/// <reference types="node" />

/**
 * Regression suite for the P0: **the daemon ran with persistence silently doing nothing.**
 *
 * What actually happened, in order:
 *
 *   1. `KELPID_DB_PATH=/tmp/kelpid-dev.db` → `ensureDatabaseDir` called `chmod('/tmp', 0700)`;
 *   2. /tmp is root-owned mode 1777, so a normal user got `EPERM`;
 *   3. that threw out of `createPersistence`'s open path into its catch, which set `db = null`
 *      and carried on — the documented "a broken DB must not take the daemon down";
 *   4. `load()` then returned null, which boot reads as "fresh install";
 *   5. `scheduleSave()` returned early on every dispatch from then on, silently, forever;
 *   6. `ping`, `kelpid status` and `kelpid stop` all reported perfect health.
 *
 * Every existing suite missed it because they all put the database under a fresh `mkdtemp`
 * directory — one the daemon itself creates, and can therefore chmod. The entire failure lives
 * in the one case nobody wrote: a parent that already exists and belongs to somebody else.
 *
 * So this file is deliberately filesystem-heavy: real directories with real modes, real SQLite
 * files, assertions on bytes on disk. `isAvailable === true` was never the bug.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PersistenceHealth } from '../seams.js';
import { createStore, emptyDaemonState, toSnapshot, type PersistedSnapshot } from '../store/index.js';
import { openSqliteDatabase, type SqlDatabase } from './adapter.js';
import {
    assertPersistenceUsable,
    createPersistence,
    PersistenceUnavailableError,
    type SqlitePersistence
} from './persistence.js';

const W1 = 'A4E8A251-9D7C-4427-8358-6377F67E6B35';
const P1 = 'B5EDDB88-1B61-412D-8D02-E62026261A9E';

let root = '';
const restore: (() => void)[] = [];

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpid-dur-'));
});

afterEach(() => {
    while (restore.length > 0) restore.pop()?.();
    fs.rmSync(root, { recursive: true, force: true });
});

/** A directory that already exists and is world-writable — a /tmp stand-in. */
function sharedParent(name = 'shared'): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o1777);
    return dir;
}

/** A directory this user cannot write into. Reopened in `afterEach` so cleanup works. */
function lockedParent(name = 'locked'): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.chmodSync(dir, 0o500);
    restore.push(() => {
        try {
            fs.chmodSync(dir, 0o700);
        } catch {
            // already gone
        }
    });
    return dir;
}

/** A real snapshot, built the way the daemon builds one: dispatch, then `toSnapshot`. */
function snapshotWith(name: string): PersistedSnapshot {
    const store = createStore(emptyDaemonState('/home/tester'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: P1,
        name,
        color: 'blue',
        now: 1_755_500_000_000
    });
    return toSnapshot(store.getState());
}

/** Read the workspace names straight out of the file, through a fresh connection. */
function workspaceNamesIn(dbPath: string): string[] {
    const db = openSqliteDatabase(dbPath);
    try {
        return db.all('SELECT "name" FROM "workspace"').map((row) => String(row['name']));
    } finally {
        db.close();
    }
}

describe('persistence under a pre-existing shared parent (the /tmp case)', () => {
    it('opens, saves and reloads through a world-writable parent it did not create', () => {
        const dbPath = path.join(sharedParent(), 'nex.db');

        const store = createPersistence({ path: dbPath });
        expect(store.isAvailable).toBe(true);
        expect(store.health().degraded).toBe(false);
        expect(store.saveNow(snapshotWith('survivor'))).toBe(true);
        store.close();

        // The real assertion is BYTES ON DISK: the broken build also had opinions.
        expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
        expect(workspaceNamesIn(dbPath)).toEqual(['survivor']);

        const reopened = createPersistence({ path: dbPath });
        expect(reopened.load()?.workspaces.map((workspace) => workspace.name)).toEqual(['survivor']);
        reopened.close();
    });

    it('opens a database directly under /tmp itself', () => {
        // The literal reported configuration. /tmp is root-owned 1777 on every machine this
        // runs on, which is exactly why the old unconditional chmod could never succeed.
        const dbPath = path.join('/tmp', `kelpid-durability-${String(process.pid)}-${String(Date.now())}.db`);
        restore.push(() => {
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
        });

        const store = createPersistence({ path: dbPath });
        expect(store.health()).toMatchObject({ available: true, degraded: false, path: dbPath });
        expect(store.saveNow(snapshotWith('tmp-canary'))).toBe(true);
        store.close();

        expect(fs.statSync(dbPath).size).toBeGreaterThan(0);
        expect(workspaceNamesIn(dbPath)).toEqual(['tmp-canary']);
    });
});

describe('an unusable database is a hard failure, not a silent downgrade', () => {
    it("reports the errno and the path instead of sqlite's pathless message", () => {
        const locked = lockedParent();
        const dbPath = path.join(locked, 'nex.db');
        const seen: PersistenceHealth[] = [];

        const store = createPersistence({ path: dbPath, onDegraded: (health) => seen.push(health) });

        expect(store.isAvailable).toBe(false);
        expect(store.health()).toMatchObject({ degraded: true, phase: 'open', errno: 'EACCES' });
        expect(store.health().error).toContain(locked);
        // Announced the moment it happened; boot does not have to poll for it.
        expect(seen).toHaveLength(1);
        expect(seen[0]?.errno).toBe('EACCES');
    });

    it('assertPersistenceUsable throws a typed, actionable error', () => {
        const dbPath = path.join(lockedParent(), 'nex.db');
        const store = createPersistence({ path: dbPath });

        let thrown: unknown;
        try {
            assertPersistenceUsable(store);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(PersistenceUnavailableError);
        const failure = thrown as PersistenceUnavailableError;
        expect(failure.code).toBe('ENEXDPERSIST');
        expect(failure.databasePath).toBe(dbPath);
        expect(failure.phase).toBe('open');
        expect(failure.errno).toBe('EACCES');
        // Everything an operator needs, on one line, without reading a stack trace.
        expect(failure.message).toContain(dbPath);
        expect(failure.message).toContain('EACCES');
        expect(failure.repair).toContain('KELPID_DB_PATH');
        expect(failure.repair).toContain('Refusing to start');
    });

    it('does not throw for :memory: — that is a choice, not a failure', () => {
        const store = createPersistence({ path: ':memory:' });
        expect(() => assertPersistenceUsable(store)).not.toThrow();
        expect(store.health()).toMatchObject({ available: true, degraded: false });
        store.close();
    });

    it('refuses a database file the daemon cannot write, and never touches it', () => {
        const dbPath = path.join(root, 'readonly.db');
        const seed = createPersistence({ path: dbPath });
        seed.saveNow(snapshotWith('seeded'));
        seed.close();
        fs.chmodSync(dbPath, 0o444);
        restore.push(() => fs.chmodSync(dbPath, 0o600));

        const store = createPersistence({ path: dbPath });

        expect(store.isAvailable).toBe(false);
        expect(store.health().errno).toBe('EACCES');
        expect(() => assertPersistenceUsable(store)).toThrow(PersistenceUnavailableError);
        // §6.1: an unreadable/unwritable file is never deleted or truncated.
        expect(workspaceNamesIn(dbPath)).toEqual(['seeded']);
    });
});

describe('a mid-run save failure surfaces', () => {
    /**
     * Why `PRAGMA query_only` and not `chmod`: removing write permission after boot does NOT
     * break an already-open handle — SQLite holds the descriptor and keeps writing to the
     * inode, so "chmod it and watch it fail" is not a usable fixture (verified). `query_only`
     * produces the same condition the connection would see from a filesystem going read-only,
     * a revoked grant or a read-only remount: `attempt to write a readonly database`.
     */
    function brokenAfterBoot(dbPath: string): {
        store: SqlitePersistence;
        handle: SqlDatabase;
        degraded: PersistenceHealth[];
    } {
        const handle = openSqliteDatabase(dbPath);
        const degraded: PersistenceHealth[] = [];
        const store = createPersistence({
            db: handle,
            path: dbPath,
            onDegraded: (health) => degraded.push(health)
        });
        return { store, handle, degraded };
    }

    it('flips health to degraded, counts it, and tells the caller immediately', () => {
        const dbPath = path.join(sharedParent(), 'nex.db');
        const { store, handle, degraded } = brokenAfterBoot(dbPath);

        expect(store.saveNow(snapshotWith('before'))).toBe(true);
        expect(store.health()).toMatchObject({ degraded: false, failedSaves: 0 });
        expect(store.health().lastSaveAt).not.toBeNull();

        handle.exec('PRAGMA query_only = ON');

        expect(store.saveNow(snapshotWith('after'))).toBe(false);
        expect(degraded).toHaveLength(1);
        expect(store.health()).toMatchObject({ degraded: true, phase: 'save', failedSaves: 1 });
        expect(store.health().error).toContain('readonly');
        // The transaction rolled back: the file still holds the last good snapshot (§5.3).
        expect(workspaceNamesIn(dbPath)).toEqual(['before']);

        handle.exec('PRAGMA query_only = OFF');
        store.close();
    });

    it('reports a failed DEBOUNCED save too — the path that was silent', () => {
        const dbPath = path.join(sharedParent(), 'nex.db');
        const { store, handle, degraded } = brokenAfterBoot(dbPath);
        handle.exec('PRAGMA query_only = ON');

        // This is the production path: the store dispatches, boot calls scheduleSave, and the
        // write happens 500 ms later with nobody watching its return value.
        store.scheduleSave(snapshotWith('debounced'));
        expect(store.hasPendingSave()).toBe(true);
        expect(store.flush()).toBe(false);

        expect(degraded).toHaveLength(1);
        expect(store.health().degraded).toBe(true);

        handle.exec('PRAGMA query_only = OFF');
        store.close();
    });

    it('flush() reports success honestly, which is what makes `kelpid stop` truthful', () => {
        const dbPath = path.join(sharedParent(), 'nex.db');
        const { store, handle } = brokenAfterBoot(dbPath);

        // Nothing pending, healthy handle → the shutdown claim is true.
        expect(store.flush()).toBe(true);

        store.scheduleSave(snapshotWith('kept'));
        expect(store.flush()).toBe(true);
        expect(workspaceNamesIn(dbPath)).toEqual(['kept']);

        handle.exec('PRAGMA query_only = ON');
        store.scheduleSave(snapshotWith('lost'));
        expect(store.flush()).toBe(false);

        handle.exec('PRAGMA query_only = OFF');
        store.close();
    });

    it('a database that never opened cannot claim a clean flush', () => {
        const store = createPersistence({ path: path.join(lockedParent(), 'nex.db') });
        expect(store.flush()).toBe(false);
        expect(store.health().degraded).toBe(true);
    });

    /**
     * `scheduleSave` used to be `if (closed || db === null) return;` — the quietest line in the
     * codebase, and the one that turned a failed open into a day of lost work. Each drop is now
     * counted, and the warning re-announced on a floor, so a client that attached AFTER the
     * failed open (the open-time announcement had nobody to hear it) still finds out.
     */
    it('counts every save it throws away, and re-announces on a floor', () => {
        const seen: PersistenceHealth[] = [];
        let now = 1_000;
        const store = createPersistence({
            path: path.join(lockedParent(), 'nex.db'),
            onDegraded: (health) => seen.push(health),
            degradedNotifyMs: 100,
            now: () => now
        });
        expect(seen).toHaveLength(1); // the open failure itself

        store.scheduleSave(snapshotWith('a'));
        store.scheduleSave(snapshotWith('b'));
        expect(store.health().failedSaves).toBe(2);
        expect(seen).toHaveLength(1); // inside the floor: counted, not shouted

        now += 200;
        store.scheduleSave(snapshotWith('c'));
        expect(seen).toHaveLength(2);
        expect(seen[1]?.failedSaves).toBe(3);

        // `saveNow` (the `session-end` path) is just as loud.
        now += 200;
        expect(store.saveNow(snapshotWith('d'))).toBe(false);
        expect(seen).toHaveLength(3);
    });

    it('recovers: a later successful save clears the flag but keeps the tally', () => {
        const dbPath = path.join(sharedParent(), 'nex.db');
        const { store, handle } = brokenAfterBoot(dbPath);

        handle.exec('PRAGMA query_only = ON');
        expect(store.saveNow(snapshotWith('failed'))).toBe(false);
        handle.exec('PRAGMA query_only = OFF');

        expect(store.saveNow(snapshotWith('recovered'))).toBe(true);
        expect(store.health()).toMatchObject({ degraded: false, failedSaves: 1 });
        expect(workspaceNamesIn(dbPath)).toEqual(['recovered']);

        store.close();
    });
});
