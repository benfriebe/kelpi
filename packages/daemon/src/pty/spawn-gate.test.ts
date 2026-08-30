/**
 * The spawn gate: the other half of "a shell is BORN at the size it will be shown at".
 *
 * `geometry.test.ts` covers the pane the daemon has seen before. This covers the one it has
 * not — a fresh install's first pane, a split's child, a markdown pane's first ⌘E — where the
 * only honest answer to "how big is it?" is "ask the client, it is about to tell us". The
 * contract these tests hold to is small and load-bearing: exactly one spawn per pane, at the
 * reported size when a report arrives, at the caller's fallback when nothing does, never after
 * the pane is gone, and never at all for a daemon nobody is looking at.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PtySpawnOptions } from '../seams.js';
import type { KelpiPtyManager } from './manager.js';
import {
    DEFAULT_SPAWN_DEFER_TIMEOUT_MS,
    createPaneSpawnGate,
    withSpawnGate,
    type DeferredSpawnReason
} from './spawn-gate.js';

const PANE = 'AAAAAAAA-0000-4000-8000-000000000001';
const OTHER = 'AAAAAAAA-0000-4000-8000-000000000002';

interface Spawned {
    readonly size: { cols: number; rows: number } | null;
    readonly reason: DeferredSpawnReason;
}

/** A gate that always agrees to defer — the "a client is attached" policy. */
function armedGate(timeoutMs = DEFAULT_SPAWN_DEFER_TIMEOUT_MS) {
    return createPaneSpawnGate({ timeoutMs, shouldDefer: () => true });
}

describe('the spawn gate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('spawns at the size the first geometry report carries', () => {
        const gate = armedGate();
        const spawns: Spawned[] = [];

        expect(gate.defer(PANE, (size, reason) => spawns.push({ size, reason }))).toBe(true);
        expect(spawns).toEqual([]); // nothing has been measured yet, so nothing is born yet
        expect(gate.pending(PANE)).toBe(true);

        gate.report(PANE, 213, 56);

        expect(spawns).toEqual([{ size: { cols: 213, rows: 56 }, reason: 'geometry' }]);
        expect(gate.pending(PANE)).toBe(false);
    });

    it('spawns at the caller fallback when nothing ever reports', () => {
        const gate = armedGate(1500);
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        vi.advanceTimersByTime(1499);
        expect(spawns).toEqual([]);
        vi.advanceTimersByTime(1);

        // `null` is the gate saying "you were right, use the grid you would have used".
        expect(spawns).toEqual([{ size: null, reason: 'timeout' }]);
        expect(gate.pending(PANE)).toBe(false);
    });

    it('declines outright when the policy says nobody is looking — the CLI/headless case', () => {
        const gate = createPaneSpawnGate({ shouldDefer: () => false });
        const spawns: Spawned[] = [];

        // `false` is the caller's instruction to spawn NOW, exactly as it did before the gate
        // existed. Nothing is registered, so no timer, no callback, no wait.
        expect(gate.defer(PANE, (size, reason) => spawns.push({ size, reason }))).toBe(false);
        expect(gate.pending(PANE)).toBe(false);
        gate.report(PANE, 100, 40);
        expect(spawns).toEqual([]);
    });

    it('declines when no policy is supplied at all, which is every existing composition', () => {
        const gate = createPaneSpawnGate();
        expect(gate.defer(PANE, () => undefined)).toBe(false);
    });

    it('runs a pending spawn on demand, at the fallback grid', () => {
        const gate = armedGate();
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        gate.flush(PANE);

        expect(spawns).toEqual([{ size: null, reason: 'demand' }]);
        // …and the report that arrives a moment later finds nothing left to do.
        gate.report(PANE, 213, 56);
        expect(spawns).toHaveLength(1);
    });

    it('never spawns twice, whatever order the triggers arrive in', () => {
        const gate = armedGate(1000);
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        gate.report(PANE, 120, 40);
        gate.report(PANE, 130, 41);
        gate.flush(PANE);
        vi.advanceTimersByTime(5000);

        expect(spawns).toEqual([{ size: { cols: 120, rows: 40 }, reason: 'geometry' }]);
    });

    it('keeps the FIRST spawn path that offered a pane, and never registers a second', () => {
        const gate = armedGate();
        const spawns: string[] = [];

        expect(gate.defer(PANE, () => spawns.push('first'))).toBe(true);
        // A second path (the lazy re-spawn, a racing create) is told the pane is taken care of.
        expect(gate.defer(PANE, () => spawns.push('second'))).toBe(true);

        gate.report(PANE, 100, 40);
        expect(spawns).toEqual(['first']);
    });

    it('never spawns a pane that was closed while it waited', () => {
        const gate = armedGate(1000);
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        gate.cancel(PANE);

        expect(gate.pending(PANE)).toBe(false);
        gate.report(PANE, 213, 56);
        gate.flush(PANE);
        vi.advanceTimersByTime(5000);
        expect(spawns).toEqual([]);
    });

    it('ignores a degenerate report and keeps waiting for a real one', () => {
        const gate = armedGate();
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        // A layout pass in flight, a hidden window, a client bug: none of these are a grid a
        // shell should be born into, and none of them are a reason to give up waiting.
        gate.report(PANE, 0, 0);
        gate.report(PANE, Number.NaN, 24);
        gate.report(PANE, -5, 10);
        expect(spawns).toEqual([]);
        expect(gate.pending(PANE)).toBe(true);

        gate.report(PANE, 120, 40);
        expect(spawns).toEqual([{ size: { cols: 120, rows: 40 }, reason: 'geometry' }]);
    });

    it('keeps panes apart', () => {
        const gate = armedGate();
        const spawns: string[] = [];
        gate.defer(PANE, () => spawns.push('pane'));
        gate.defer(OTHER, () => spawns.push('other'));

        gate.report(OTHER, 100, 40);

        expect(spawns).toEqual(['other']);
        expect(gate.pending(PANE)).toBe(true);
        expect(gate.pendingCount).toBe(1);
    });

    it('swallows a throwing spawn instead of taking the daemon down with it', () => {
        const errors: string[] = [];
        const gate = createPaneSpawnGate({
            shouldDefer: () => true,
            onError: (_, context) => errors.push(context)
        });
        gate.defer(PANE, () => {
            throw new Error('node-pty said no');
        });

        expect(() => gate.report(PANE, 100, 40)).not.toThrow();
        expect(errors).toEqual([`deferred spawn ${PANE}`]);
        expect(gate.pending(PANE)).toBe(false);
    });

    it('drops everything on close, and refuses to take on more', () => {
        const gate = armedGate();
        const spawns: string[] = [];
        gate.defer(PANE, () => spawns.push('pane'));
        gate.defer(OTHER, () => spawns.push('other'));

        gate.close();

        expect(gate.pendingCount).toBe(0);
        vi.advanceTimersByTime(10_000);
        expect(spawns).toEqual([]);
        // A shutdown that raced a `pane create` must not start a shell nothing will ever kill.
        expect(gate.defer(PANE, () => spawns.push('late'))).toBe(false);
        expect(spawns).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The PtyManager wrapper
// ---------------------------------------------------------------------------

class FakePtyManager implements KelpiPtyManager {
    readonly spawns: PtySpawnOptions[] = [];
    readonly writes: { paneID: string; data: string }[] = [];
    readonly resizes: { paneID: string; cols: number; rows: number }[] = [];
    readonly killed: string[] = [];
    private readonly live = new Set<string>();

    spawn(opts: PtySpawnOptions): void {
        if (this.live.has(opts.paneID)) return;
        this.live.add(opts.paneID);
        this.spawns.push(opts);
    }

    has(paneID: string): boolean {
        return this.live.has(paneID);
    }

    write(paneID: string, data: Uint8Array | string): void {
        this.writes.push({ paneID, data: String(data) });
    }

    writeDirect(paneID: string, data: Uint8Array | string): void {
        this.writes.push({ paneID, data: String(data) });
    }

    resize(paneID: string, cols: number, rows: number): void {
        this.resizes.push({ paneID, cols, rows });
    }

    kill(paneID: string): void {
        this.live.delete(paneID);
        this.killed.push(paneID);
    }

    async killAll(): Promise<void> {
        for (const paneID of [...this.live]) this.kill(paneID);
    }

    setSyncGroup(): void {}
    onData(): () => void {
        return () => undefined;
    }
    onExit(): () => void {
        return () => undefined;
    }
    pid(): number | undefined {
        return undefined;
    }
    count(): number {
        return this.live.size;
    }
    paneIDs(): string[] {
        return [...this.live];
    }
    isSyncing(): boolean {
        return false;
    }
    syncTargetIDs(): Set<string> {
        return new Set();
    }
}

describe('the gated PtyManager', () => {
    it('flushes a pending spawn before a write, so input is never dropped', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        gate.defer(PANE, () => raw.spawn({ paneID: PANE, cwd: '/', env: [], cols: 80, rows: 24 }));

        pty.write(PANE, 'echo hi\r');

        // The spawn ran FIRST: the bytes reached a live PTY rather than the void.
        expect(raw.spawns.map((entry) => entry.paneID)).toEqual([PANE]);
        expect(raw.writes).toEqual([{ paneID: PANE, data: 'echo hi\r' }]);
        expect(gate.pending(PANE)).toBe(false);
    });

    it('flushes on writeDirect too — that is the resume-command path', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        gate.defer(PANE, () => raw.spawn({ paneID: PANE, cwd: '/', env: [], cols: 80, rows: 24 }));

        pty.writeDirect(PANE, 'claude --resume x\r');

        expect(raw.spawns).toHaveLength(1);
        expect(raw.writes).toHaveLength(1);
    });

    it('reads a pending spawn as a live pane, because a write to it will land', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        gate.defer(PANE, () => undefined);

        // Every `has()` caller is asking "is there something to talk to?" — and for a deferred
        // pane the answer is yes: the write that follows resolves the deferral.
        expect(pty.has(PANE)).toBe(true);
        expect(pty.has(OTHER)).toBe(false);
    });

    it('cancels a pending spawn when the pane is killed', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        const spawns: string[] = [];
        gate.defer(PANE, () => spawns.push(PANE));

        pty.kill(PANE);
        gate.report(PANE, 120, 40);

        expect(spawns).toEqual([]);
        expect(gate.pending(PANE)).toBe(false);
    });

    it('cancels everything on killAll', async () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        const spawns: string[] = [];
        gate.defer(PANE, () => spawns.push(PANE));

        await pty.killAll();

        expect(gate.pendingCount).toBe(0);
        expect(spawns).toEqual([]);
    });

    it('does NOT flush on resize — that call is the measurement being delivered', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        const spawns: Spawned[] = [];
        gate.defer(PANE, (size, reason) => spawns.push({ size, reason }));

        // The hub resizes the (not yet existing) PTY and only THEN reports the geometry.
        // Flushing here would spawn at the fallback grid microseconds before the truth lands.
        pty.resize(PANE, 213, 56);
        expect(spawns).toEqual([]);

        gate.report(PANE, 213, 56);
        expect(spawns).toEqual([{ size: { cols: 213, rows: 56 }, reason: 'geometry' }]);
    });

    it('lets a direct spawn supersede a pending one, and never spawns twice', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);
        const spawns: string[] = [];
        gate.defer(PANE, () => spawns.push('deferred'));

        pty.spawn({ paneID: PANE, cwd: '/', env: [], cols: 100, rows: 30 });
        gate.report(PANE, 213, 56);

        expect(spawns).toEqual([]);
        expect(raw.spawns).toHaveLength(1);
        expect(raw.spawns[0]?.cols).toBe(100);
    });

    it('passes every other call straight through', () => {
        const gate = armedGate();
        const raw = new FakePtyManager();
        const pty = withSpawnGate(raw, gate);

        pty.spawn({ paneID: PANE, cwd: '/', env: [], cols: 80, rows: 24 });
        pty.resize(PANE, 100, 30);

        expect(pty.count()).toBe(1);
        expect(pty.paneIDs()).toEqual([PANE]);
        expect(pty.isSyncing(PANE)).toBe(false);
        expect(pty.syncTargetIDs(PANE)).toEqual(new Set());
        expect(pty.pid(PANE)).toBeUndefined();
        expect(raw.resizes).toEqual([{ paneID: PANE, cols: 100, rows: 30 }]);
    });
});
