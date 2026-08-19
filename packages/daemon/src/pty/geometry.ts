/**
 * Last-known pane geometry — so a shell is BORN at the size it will be shown at.
 *
 * The daemon owns the PTY, and it spawns one long before any client can measure a pane: on
 * boot it restores every workspace's panes, and a `pane-split` creates a child the instant the
 * command lands. With nothing better to go on that spawn used a fixed 80×24, and the shell
 * duly drew its first prompt 80 columns wide. The client then attached, reported (say) 213
 * columns, and everything that had already been printed stayed wrong forever:
 *
 *   - `@xterm/headless` does not reflow on resize, so the 80-column lines sit in the daemon's
 *     scrollback padded to their old width and go out in every reattach snapshot;
 *   - a zsh/p10k prompt repaints on SIGWINCH, so the screen ends up holding the 80-column copy
 *     AND the repainted one — the stacked, half-width prompt copies a reattach used to show.
 *
 * The fix is to remember. Every client attach and every resize records the pane's grid here;
 * the spawn paths ask for it back. A pane that has been seen before is spawned at its own last
 * size, and a brand-new pane (a split, a `pane create`) is spawned at the last size ANY pane
 * was rendered at — which is far closer to the truth than 80×24 and is corrected by the
 * client's attach a few milliseconds later, before the shell has drawn much of anything.
 *
 * The file is a cache, never a source of truth: a missing, unreadable or corrupt one costs
 * exactly what today's behaviour costs (80×24), and a write failure is reported once and then
 * ignored. Nothing here may throw into a spawn path.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface GridSize {
    readonly cols: number;
    readonly rows: number;
}

export interface PaneGeometryStore {
    /** The pane's own last size, else the most recent size seen for any pane, else null. */
    sizeFor(paneID: string): GridSize | null;
    /** Strictly this pane's recorded size (no fallback) — the honest read for tests. */
    get(paneID: string): GridSize | null;
    /** The most recent size any client reported, whatever the pane. */
    latest(): GridSize | null;
    record(paneID: string, cols: number, rows: number): void;
    forget(paneID: string): void;
    /** Persist immediately (shutdown); a no-op without a path. */
    flush(): void;
    /** Stop the debounce timer and flush. */
    close(): void;
    /** Where it persists, or null when it is memory-only. */
    readonly path: string | null;
}

/** Written at most this often; geometry is a cache and a resize drag is a storm. */
export const DEFAULT_GEOMETRY_WRITE_DELAY_MS = 750;

/** Panes remembered before the oldest entries are dropped. */
export const DEFAULT_GEOMETRY_LIMIT = 500;

/** File name inside the daemon's state directory. */
export const GEOMETRY_FILE_NAME = 'pane-geometry.json';

const FORMAT_VERSION = 1;

/** Same clamps the terminal state uses; a zero-size grid must never reach a PTY. */
const MIN_COLS = 2;
const MIN_ROWS = 1;
const MAX_DIMENSION = 10_000;

interface Entry {
    cols: number;
    rows: number;
    at: number;
}

interface PersistedShape {
    version?: number;
    panes?: Record<string, { cols?: unknown; rows?: unknown; at?: unknown }>;
    latest?: { cols?: unknown; rows?: unknown };
}

export interface PaneGeometryStoreOptions {
    /** JSON file to persist into; omit for a memory-only store (tests, `:memory:` daemons). */
    readonly path?: string | null | undefined;
    readonly writeDelayMs?: number | undefined;
    readonly limit?: number | undefined;
    readonly now?: (() => number) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

function sane(value: unknown, min: number): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const floored = Math.floor(value);
    if (floored < min || floored > MAX_DIMENSION) return null;
    return floored;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function createPaneGeometryStore(options: PaneGeometryStoreOptions = {}): PaneGeometryStore {
    const filePath = options.path === undefined || options.path === null || options.path === '' ? null : options.path;
    const writeDelayMs = Math.max(0, options.writeDelayMs ?? DEFAULT_GEOMETRY_WRITE_DELAY_MS);
    const limit = Math.max(1, options.limit ?? DEFAULT_GEOMETRY_LIMIT);
    const now = options.now ?? ((): number => Date.now());
    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    const panes = new Map<string, Entry>();
    let latest: GridSize | null = null;
    let timer: NodeJS.Timeout | undefined;
    let dirty = false;
    let closed = false;

    if (filePath !== null) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw) as PersistedShape;
            if (parsed.version === FORMAT_VERSION && parsed.panes !== undefined) {
                for (const [paneID, value] of Object.entries(parsed.panes)) {
                    const cols = sane(value?.cols, MIN_COLS);
                    const rows = sane(value?.rows, MIN_ROWS);
                    if (cols === null || rows === null) continue;
                    const at = sane(value?.at, 0) ?? 0;
                    panes.set(paneID, { cols, rows, at });
                }
            }
            const lastCols = sane(parsed.latest?.cols, MIN_COLS);
            const lastRows = sane(parsed.latest?.rows, MIN_ROWS);
            if (lastCols !== null && lastRows !== null) latest = { cols: lastCols, rows: lastRows };
        } catch (error) {
            // A missing file is the normal first-run case; anything else is a corrupt cache and
            // costs nothing but the fallback grid.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') report(error, 'geometry-read');
        }
    }

    const write = (): void => {
        dirty = false;
        if (filePath === null) return;
        const payload = {
            version: FORMAT_VERSION,
            updatedAt: now(),
            latest,
            panes: Object.fromEntries([...panes.entries()].map(([id, entry]) => [id, entry]))
        };
        const tmp = `${filePath}.${String(process.pid)}.tmp`;
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
            fs.renameSync(tmp, filePath);
        } catch (error) {
            report(error, 'geometry-write');
            try {
                fs.rmSync(tmp, { force: true });
            } catch {
                /* best effort */
            }
        }
    };

    const schedule = (): void => {
        dirty = true;
        if (closed || filePath === null || timer !== undefined) return;
        timer = setTimeout(() => {
            timer = undefined;
            write();
        }, writeDelayMs);
        timer.unref?.();
    };

    const prune = (): void => {
        if (panes.size <= limit) return;
        const ordered = [...panes.entries()].sort((a, b) => a[1].at - b[1].at);
        for (const [paneID] of ordered.slice(0, panes.size - limit)) panes.delete(paneID);
    };

    return {
        get path(): string | null {
            return filePath;
        },
        get(paneID: string): GridSize | null {
            const entry = panes.get(paneID);
            return entry === undefined ? null : { cols: entry.cols, rows: entry.rows };
        },
        latest(): GridSize | null {
            return latest;
        },
        sizeFor(paneID: string): GridSize | null {
            const entry = panes.get(paneID);
            if (entry !== undefined) return { cols: entry.cols, rows: entry.rows };
            return latest;
        },
        record(paneID: string, cols: number, rows: number): void {
            if (closed) return;
            const safeCols = sane(cols, MIN_COLS);
            const safeRows = sane(rows, MIN_ROWS);
            if (safeCols === null || safeRows === null) return;
            const existing = panes.get(paneID);
            const unchanged =
                existing !== undefined && existing.cols === safeCols && existing.rows === safeRows;
            panes.set(paneID, { cols: safeCols, rows: safeRows, at: now() });
            latest = { cols: safeCols, rows: safeRows };
            prune();
            if (unchanged) return; // a repeated identical report is not worth a write
            schedule();
        },
        forget(paneID: string): void {
            if (!panes.delete(paneID)) return;
            schedule();
        },
        flush(): void {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            if (dirty) write();
        },
        close(): void {
            this.flush();
            closed = true;
        }
    };
}
