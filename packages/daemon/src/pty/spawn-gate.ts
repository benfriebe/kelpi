/**
 * Hold a pane's FIRST spawn until somebody can say how big it is.
 *
 * `./geometry.ts` remembers what a pane was last rendered at, and every spawn path asks it
 * first — which is the whole answer for a pane that has been on screen before, daemon restart
 * included (the cache is a file beside the database). It has nothing to say about a pane
 * nobody has ever rendered: the first pane of a fresh install, the child of a split, a
 * markdown pane the user just pressed ⌘E on. Those spawn at 80×24 (or, worse, at the last size
 * some OTHER pane was rendered at), the shell prints its prompt at that width, and the client's
 * real geometry lands a beat later as a resize. `@xterm/headless` does not reflow, so
 * everything printed before that resize stays wrong in the daemon's scrollback forever — the
 * half-width strand above the repainted prompt that this module exists to remove.
 *
 * The fix is to wait, briefly, for a number we are about to be told:
 *
 *   - a spawn path offers the pane to `defer()`, which either takes ownership (returns `true`,
 *     and the caller does nothing) or declines (returns `false`, and the caller spawns now
 *     exactly as it always did);
 *   - `report()` — wired to the client's first geometry report for that pane — runs the
 *     pending spawn AT THE REPORTED SIZE, synchronously, before the attach that carried it
 *     even gets to its snapshot;
 *   - `flush()` runs it immediately at the caller's fallback size, because something needs the
 *     PTY right now (a keystroke, `pane send`, a resume command, a capture);
 *   - a hard timeout runs it at the fallback size, so a client that never attaches costs a
 *     bounded wait and then today's behaviour, not a pane that never starts.
 *
 * Three properties the callers depend on:
 *
 *   1. **Exactly one spawn.** The entry is removed BEFORE its callback runs, so a re-entrant
 *      `flush()` (a callback that writes, a `pty.spawn` that the gated manager intercepts)
 *      cannot spawn twice, and a `report()` racing the timeout cannot either.
 *   2. **Never throws into a spawn path.** A callback that throws is reported and swallowed;
 *      the pane is simply not spawned, which is the same outcome a throwing `pty.spawn` has.
 *   3. **A cancelled pane never spawns.** `cancel()` (wired to `pty.kill`, i.e. every pane
 *      close) drops the pending spawn without running it, so a pane closed while deferred
 *      leaves no orphan child behind.
 *
 * `shouldDefer` is the policy seam, and the policy lives in boot: defer only when somebody is
 * plausibly about to measure this pane (a client is attached, or we are inside the boot window
 * where one is expected). With nothing attached — the CLI-only daemon the compat suite and
 * every headless flow run — the gate declines and every spawn is byte-identical to the one
 * before this module existed.
 */

import type { GridSize } from './geometry.js';
import type { NexPtyManager } from './manager.js';

/** Why the deferred spawn finally ran. `null` size = "use your own fallback". */
export type DeferredSpawnReason = 'geometry' | 'timeout' | 'demand';

/** The deferred work: spawn the PTY (and attach the terminal) at this size. */
export type DeferredSpawn = (size: GridSize | null, reason: DeferredSpawnReason) => void;

export interface PaneSpawnGate {
    /**
     * Offer a pane's first spawn to the gate.
     *
     * Returns `true` when the gate took ownership — the caller must NOT spawn — and `false`
     * when it declined, in which case the caller spawns immediately as before. Offering a pane
     * that is already pending returns `true` without registering a second callback: the first
     * spawn path to arrive owns the spawn.
     */
    defer(paneID: string, spawn: DeferredSpawn): boolean;
    /** A client reported a real grid: run the pending spawn at exactly that size. */
    report(paneID: string, cols: number, rows: number): void;
    /** Something needs the PTY now: run the pending spawn at the caller's fallback size. */
    flush(paneID: string): void;
    /** The pane is gone: drop the pending spawn WITHOUT running it. */
    cancel(paneID: string): void;
    /** Drop every pending spawn without running any (shutdown, `killAll`). */
    cancelAll(): void;
    /** True while a spawn is registered and has not run yet. */
    pending(paneID: string): boolean;
    /** How many spawns are waiting (diagnostics, tests). */
    readonly pendingCount: number;
    /** Cancel everything and refuse further deferrals. */
    close(): void;
}

export interface PaneSpawnGateOptions {
    /** Hard cap on the wait; the spawn then runs at the caller's fallback. */
    readonly timeoutMs?: number | undefined;
    /**
     * Policy: may THIS pane's spawn be deferred at all? Absent = never defer, which is the
     * behaviour of every daemon composed before this module existed.
     */
    readonly shouldDefer?: ((paneID: string) => boolean) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

/** Long enough for a cold Electron window to attach, short enough to never look hung. */
export const DEFAULT_SPAWN_DEFER_TIMEOUT_MS = 2000;

/** Grids below this are a layout pass in flight, never a pane a shell should be born into. */
const MIN_COLS = 2;
const MIN_ROWS = 1;

interface PendingEntry {
    spawn: DeferredSpawn;
    timer: NodeJS.Timeout | undefined;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function sane(value: number, min: number): number | null {
    if (!Number.isFinite(value)) return null;
    const floored = Math.floor(value);
    return floored < min ? null : floored;
}

export function createPaneSpawnGate(options: PaneSpawnGateOptions = {}): PaneSpawnGate {
    const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_SPAWN_DEFER_TIMEOUT_MS);
    const shouldDefer = options.shouldDefer;
    const pending = new Map<string, PendingEntry>();
    let closed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    /**
     * Take the entry OUT of the map before running it. Everything else in this module is
     * built on that ordering: a callback that re-enters (a write that flushes, a `pty.spawn`
     * the gated manager cancels through) finds nothing left to run.
     */
    const run = (paneID: string, size: GridSize | null, reason: DeferredSpawnReason): void => {
        const entry = pending.get(paneID);
        if (entry === undefined) return;
        pending.delete(paneID);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
        try {
            entry.spawn(size, reason);
        } catch (error) {
            // A spawn path must never take the daemon down, and a failed spawn is already a
            // reported condition everywhere else (`PtyManager` reports rather than throws).
            report(error, `deferred spawn ${paneID}`);
        }
    };

    /** Drop a pending spawn without running it. A free function, so no call site depends on
     * `this` — every method below is safe to pass around detached. */
    const drop = (paneID: string): void => {
        const entry = pending.get(paneID);
        if (entry === undefined) return;
        pending.delete(paneID);
        if (entry.timer !== undefined) clearTimeout(entry.timer);
    };

    const dropAll = (): void => {
        for (const paneID of [...pending.keys()]) drop(paneID);
    };

    return {
        defer(paneID: string, spawn: DeferredSpawn): boolean {
            if (closed) return false;
            if (pending.has(paneID)) return true; // first path to arrive owns the spawn
            if (shouldDefer === undefined || !shouldDefer(paneID)) return false;
            const entry: PendingEntry = { spawn, timer: undefined };
            pending.set(paneID, entry);
            const timer = setTimeout(() => {
                entry.timer = undefined;
                run(paneID, null, 'timeout');
            }, timeoutMs);
            // A pending spawn must never be the reason the daemon cannot exit.
            timer.unref?.();
            entry.timer = timer;
            return true;
        },
        report(paneID: string, cols: number, rows: number): void {
            if (!pending.has(paneID)) return;
            const safeCols = sane(cols, MIN_COLS);
            const safeRows = sane(rows, MIN_ROWS);
            // A degenerate report is not a measurement; keep waiting for a real one (or the
            // timeout), rather than spawning into a grid no shell should see.
            if (safeCols === null || safeRows === null) return;
            run(paneID, { cols: safeCols, rows: safeRows }, 'geometry');
        },
        flush(paneID: string): void {
            run(paneID, null, 'demand');
        },
        cancel(paneID: string): void {
            drop(paneID);
        },
        cancelAll(): void {
            dropAll();
        },
        pending(paneID: string): boolean {
            return pending.has(paneID);
        },
        get pendingCount(): number {
            return pending.size;
        },
        close(): void {
            closed = true;
            dropAll();
        }
    };
}

/**
 * The same `PtyManager`, with the gate wired into the four places a deferred pane is
 * observable.
 *
 * Boot hands this wrapper to EVERYTHING — the handler context, the terminal input encoder, the
 * WS stream hub — so no caller has to know the gate exists:
 *
 *  - `write` / `writeDirect`: somebody is typing at the pane (a keystroke, `pane send`, a
 *    resume command). The bytes must reach a PTY, so the pending spawn runs first, at the
 *    fallback size. Waiting any longer would drop input.
 *  - `has`: a pending spawn reads as a live pane. Every caller uses `has()` to ask "is there a
 *    process to talk to?" (`typeResumeCommands`, the reopen resume, the agent-restart verb),
 *    and for a deferred pane the honest answer is yes — the write that follows flushes it.
 *    The one caller that means "is there one ALREADY?" is `spawnPaneIfShell`, and for it the
 *    answer is also right: a pane with a spawn pending must not be spawned a second time.
 *  - `kill`: the pane is closing. Drop the pending spawn, or a pane the user closed a moment
 *    ago starts a shell nobody will ever see (and nothing will ever kill).
 *  - `resize` is deliberately NOT a flush: the resize that carries a client's geometry is the
 *    very thing the gate is waiting for, and flushing here would spawn at the fallback size
 *    microseconds before the real one arrives. Boot reports geometry to the gate directly.
 *
 * Every other method is a plain delegation, written out rather than proxied so that a method
 * added to `NexPtyManager` later fails to compile here instead of quietly bypassing the gate.
 */
export function withSpawnGate(pty: NexPtyManager, gate: PaneSpawnGate): NexPtyManager {
    return {
        spawn(opts): void {
            // A direct spawn supersedes anything the gate is holding for that pane.
            gate.cancel(opts.paneID);
            pty.spawn(opts);
        },
        has(paneID: string): boolean {
            return pty.has(paneID) || gate.pending(paneID);
        },
        write(paneID: string, data: Uint8Array | string): void {
            gate.flush(paneID);
            pty.write(paneID, data);
        },
        writeDirect(paneID: string, data: Uint8Array | string): void {
            gate.flush(paneID);
            pty.writeDirect(paneID, data);
        },
        resize(paneID: string, cols: number, rows: number): void {
            pty.resize(paneID, cols, rows);
        },
        kill(paneID: string): void {
            gate.cancel(paneID);
            pty.kill(paneID);
        },
        async killAll(): Promise<void> {
            gate.cancelAll();
            await pty.killAll();
        },
        setSyncGroup(workspaceID: string, paneIDs: ReadonlySet<string>): void {
            pty.setSyncGroup(workspaceID, paneIDs);
        },
        onData(cb: (paneID: string, data: Uint8Array) => void): () => void {
            return pty.onData(cb);
        },
        onExit(cb: (paneID: string, exitCode: number) => void): () => void {
            return pty.onExit(cb);
        },
        pid(paneID: string): number | undefined {
            return pty.pid(paneID);
        },
        count(): number {
            return pty.count();
        },
        paneIDs(): string[] {
            return pty.paneIDs();
        },
        isSyncing(paneID: string): boolean {
            return pty.isSyncing(paneID);
        },
        syncTargetIDs(sourcePaneID: string): Set<string> {
            return pty.syncTargetIDs(sourcePaneID);
        }
    };
}
