/**
 * The geometry cache: what a shell is BORN at.
 *
 * These are not bookkeeping tests. A pane spawned at 80×24 and resized after the fact keeps
 * its first, wrongly-wrapped prompt forever (`@xterm/headless` never reflows), which is the
 * stacked half-width prompt history a reattach used to show — so "remembered, persisted, and
 * never able to throw into a spawn" is the whole contract.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GEOMETRY_FILE_NAME, createPaneGeometryStore } from './geometry.js';

const PANE_A = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_B = 'AAAAAAAA-0000-4000-8000-000000000002';

const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nex-geometry-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length > 0) {
        const dir = dirs.pop();
        if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('pane geometry store', () => {
    it('remembers a pane grid and hands it back', () => {
        const store = createPaneGeometryStore();
        store.record(PANE_A, 213, 56);
        expect(store.get(PANE_A)).toEqual({ cols: 213, rows: 56 });
        expect(store.sizeFor(PANE_A)).toEqual({ cols: 213, rows: 56 });
    });

    it('falls back to the most recent grid for a pane it has never seen', () => {
        const store = createPaneGeometryStore();
        store.record(PANE_A, 213, 56);
        // A pane created by a split has no history of its own; the window it will appear in
        // is a far better guess than 80×24, and the client corrects it on attach.
        expect(store.get(PANE_B)).toBeNull();
        expect(store.sizeFor(PANE_B)).toEqual({ cols: 213, rows: 56 });
        expect(store.latest()).toEqual({ cols: 213, rows: 56 });
    });

    it('has nothing to say before anything is recorded', () => {
        const store = createPaneGeometryStore();
        expect(store.sizeFor(PANE_A)).toBeNull();
        expect(store.latest()).toBeNull();
    });

    it('rejects a degenerate grid rather than poisoning the next spawn', () => {
        const store = createPaneGeometryStore();
        store.record(PANE_A, 0, 0);
        store.record(PANE_A, Number.NaN, 24);
        store.record(PANE_A, -5, 10);
        store.record(PANE_A, 1e9, 1e9);
        expect(store.sizeFor(PANE_A)).toBeNull();
    });

    it('forgets a pane on request', () => {
        const store = createPaneGeometryStore();
        store.record(PANE_A, 100, 30);
        store.forget(PANE_A);
        expect(store.get(PANE_A)).toBeNull();
    });

    it('prunes the oldest entries past its limit', () => {
        let clock = 1000;
        const store = createPaneGeometryStore({ limit: 2, now: () => clock++ });
        store.record('a', 10, 10);
        store.record('b', 20, 20);
        store.record('c', 30, 30);
        expect(store.get('a')).toBeNull();
        expect(store.get('b')).toEqual({ cols: 20, rows: 20 });
        expect(store.get('c')).toEqual({ cols: 30, rows: 30 });
    });
});

describe('pane geometry persistence', () => {
    it('survives a restart — which is the entire point', () => {
        const dir = tempDir();
        const file = path.join(dir, GEOMETRY_FILE_NAME);

        const first = createPaneGeometryStore({ path: file, writeDelayMs: 0 });
        first.record(PANE_A, 213, 56);
        first.close();
        expect(fs.existsSync(file)).toBe(true);

        const second = createPaneGeometryStore({ path: file });
        expect(second.get(PANE_A)).toEqual({ cols: 213, rows: 56 });
        expect(second.latest()).toEqual({ cols: 213, rows: 56 });
    });

    it('debounces writes and flushes on close', () => {
        const dir = tempDir();
        const file = path.join(dir, GEOMETRY_FILE_NAME);
        const store = createPaneGeometryStore({ path: file, writeDelayMs: 10_000 });
        store.record(PANE_A, 120, 40);
        expect(fs.existsSync(file)).toBe(false); // a resize drag must not be a write storm
        store.flush();
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).panes[PANE_A]).toMatchObject({
            cols: 120,
            rows: 40
        });
    });

    it('treats a corrupt cache as an empty one', () => {
        const dir = tempDir();
        const file = path.join(dir, GEOMETRY_FILE_NAME);
        fs.writeFileSync(file, '{ not json');
        const errors: string[] = [];
        const store = createPaneGeometryStore({ path: file, onError: (_, context) => errors.push(context) });
        expect(store.sizeFor(PANE_A)).toBeNull();
        expect(errors).toEqual(['geometry-read']);
    });

    it('ignores entries a future/older format wrote', () => {
        const dir = tempDir();
        const file = path.join(dir, GEOMETRY_FILE_NAME);
        fs.writeFileSync(file, JSON.stringify({ version: 99, panes: { [PANE_A]: { cols: 10, rows: 10 } } }));
        const store = createPaneGeometryStore({ path: file });
        expect(store.get(PANE_A)).toBeNull();
    });

    it('drops persisted junk without throwing', () => {
        const dir = tempDir();
        const file = path.join(dir, GEOMETRY_FILE_NAME);
        fs.writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                panes: { [PANE_A]: { cols: 'wide', rows: null }, [PANE_B]: { cols: 100, rows: 30 } }
            })
        );
        const store = createPaneGeometryStore({ path: file });
        expect(store.get(PANE_A)).toBeNull();
        expect(store.get(PANE_B)).toEqual({ cols: 100, rows: 30 });
    });

    it('reports a write failure instead of throwing into a resize', () => {
        const dir = tempDir();
        // A directory where the file should be: every write fails, nothing may escape.
        const file = path.join(dir, GEOMETRY_FILE_NAME);
        fs.mkdirSync(file);
        const errors: string[] = [];
        const store = createPaneGeometryStore({
            path: file,
            writeDelayMs: 0,
            onError: (_, context) => errors.push(context)
        });
        expect(() => {
            store.record(PANE_A, 100, 30);
            store.flush();
        }).not.toThrow();
        expect(errors).toContain('geometry-write');
        // Still usable in memory — the cache degrades, the pane does not.
        expect(store.get(PANE_A)).toEqual({ cols: 100, rows: 30 });
    });

    it('is memory-only without a path', () => {
        const store = createPaneGeometryStore({ path: null });
        store.record(PANE_A, 100, 30);
        store.flush();
        expect(store.path).toBeNull();
        expect(store.get(PANE_A)).toEqual({ cols: 100, rows: 30 });
    });
});
