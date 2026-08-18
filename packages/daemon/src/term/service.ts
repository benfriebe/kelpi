/**
 * Server-side terminal state (WP2.3).
 *
 * One `@xterm/headless` Terminal per pane, fed every PTY byte, plus a bounded raw ring
 * buffer as belt-and-braces. This is what makes `pane capture`, reattach snapshots and
 * DECCKM-aware named keys work with **zero clients attached**
 * (`docs/current/terminal-surface.md` §9, `docs/research/ghostty-web.md` §3c/§4).
 *
 * Notes on the emulator:
 * - `@xterm/headless` ships CJS (`main: lib-headless/xterm-headless.js`) with no `exports`
 *   map, and cjs-module-lexer does NOT see its named exports, so a named ESM import
 *   (`import { Terminal } from '@xterm/headless'`) throws at runtime. Default-import the
 *   namespace and destructure — verified against the installed 6.0.0 build.
 * - `Terminal.write()` is asynchronous (it queues into xterm's WriteBuffer and calls back
 *   when the chunk has been parsed). `feed()` therefore only *enqueues*. The seam's
 *   synchronous `capture()` / `snapshot()` / `modes()` read last-known state (everything
 *   parsed so far); the added `captureAsync()` / `snapshotAsync()` / `modesAsync()` /
 *   `flush()` members await the pending write chain first and are what handlers should use
 *   when they need to observe bytes written moments earlier.
 */

import serializeModule from '@xterm/addon-serialize';
import headless from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import type { TerminalStateService, VtModes } from '../seams.js';
import { DEFAULT_RING_CAPACITY_BYTES, RawRingBuffer } from './ring.js';

const { Terminal } = headless;
const { SerializeAddon } = serializeModule;

type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

/** Scrollback depth per pane, in lines (stack.md: "~10000"). */
export const DEFAULT_SCROLLBACK_LINES = 10_000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

export interface TerminalStateOptions {
    /** Scrollback lines retained per pane. Default 10 000. */
    readonly scrollback?: number;
    /** Raw ring-buffer capacity per pane, in bytes. Default 1 MiB. */
    readonly ringCapacityBytes?: number;
    /** Grid used when a pane is created implicitly (a feed before its attach). */
    readonly defaultCols?: number;
    readonly defaultRows?: number;
    /**
     * Cap on scrollback lines included in `snapshot()`. Omitted = the whole buffer, which
     * is what a reattaching client wants (it gets history for free).
     */
    readonly snapshotScrollbackLines?: number;
}

export interface GridSize {
    readonly cols: number;
    readonly rows: number;
}

export interface TerminalSnapshot {
    readonly data: Uint8Array;
    readonly cols: number;
    readonly rows: number;
}

const IDLE_MODES: VtModes = { applicationCursorKeys: false, bracketedPaste: false };

/** Convenience factory for boot wiring. */
export function createTerminalStateService(options: TerminalStateOptions = {}): TerminalStateServiceImpl {
    return new TerminalStateServiceImpl(options);
}

/** xterm refuses to go below these; clamping here keeps `gridSize()` truthful. */
const MIN_COLS = 2;
const MIN_ROWS = 1;

interface PaneTerminal {
    readonly term: HeadlessTerminal;
    readonly serializer: SerializeAddonInstance;
    readonly ring: RawRingBuffer;
    /** Writes handed to xterm. */
    issued: number;
    /** Writes xterm has parsed (or that dispose force-settled). */
    done: number;
    /** Resolves when the most recently issued write has been parsed. */
    tail: Promise<void>;
    /** Force-settle hooks for in-flight writes, so dispose() can never strand a flush(). */
    readonly settlers: Set<() => void>;
    disposed: boolean;
}

const encoder = new TextEncoder();

// Zero-size guard (terminal-surface.md §15.4): never size a surface to zero.
function sanitizeCols(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(MIN_COLS, Math.floor(value));
}

function sanitizeRows(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(MIN_ROWS, Math.floor(value));
}

/**
 * `TerminalStateService` backed by `@xterm/headless` + `@xterm/addon-serialize`.
 *
 * Widenings over the seam (all additive): `captureAsync`, `snapshotAsync`, `modesAsync`,
 * `flush`, `has`, `gridSize`, `paneIDs`, `ringTail`, `disposeAll`, and `feed()` also
 * accepting a string.
 */
export class TerminalStateServiceImpl implements TerminalStateService {
    private readonly panes = new Map<string, PaneTerminal>();
    private readonly scrollback: number;
    private readonly ringCapacityBytes: number;
    private readonly defaultCols: number;
    private readonly defaultRows: number;
    private readonly snapshotScrollbackLines: number | undefined;

    constructor(options: TerminalStateOptions = {}) {
        this.scrollback = Math.max(0, Math.floor(options.scrollback ?? DEFAULT_SCROLLBACK_LINES));
        this.ringCapacityBytes = Math.max(1, Math.floor(options.ringCapacityBytes ?? DEFAULT_RING_CAPACITY_BYTES));
        this.defaultCols = sanitizeCols(options.defaultCols ?? DEFAULT_COLS, DEFAULT_COLS);
        this.defaultRows = sanitizeRows(options.defaultRows ?? DEFAULT_ROWS, DEFAULT_ROWS);
        this.snapshotScrollbackLines =
            options.snapshotScrollbackLines === undefined
                ? undefined
                : Math.max(0, Math.floor(options.snapshotScrollbackLines));
    }

    // ── lifecycle ───────────────────────────────────────────────────────────────────

    /**
     * Ensure terminal state exists for a pane. Idempotent per paneID (registry semantics,
     * terminal-surface.md §1.2): an existing pane keeps its live state and scrollback; only
     * its grid is re-asserted if the caller's dimensions differ.
     */
    attach(paneID: string, cols: number, rows: number): void {
        const wantCols = sanitizeCols(cols, this.defaultCols);
        const wantRows = sanitizeRows(rows, this.defaultRows);
        const existing = this.panes.get(paneID);
        if (existing) {
            if (existing.term.cols !== wantCols || existing.term.rows !== wantRows) {
                existing.term.resize(wantCols, wantRows);
            }
            return;
        }
        this.panes.set(paneID, this.create(wantCols, wantRows));
    }

    has(paneID: string): boolean {
        return this.panes.has(paneID);
    }

    paneIDs(): readonly string[] {
        return [...this.panes.keys()];
    }

    dispose(paneID: string): void {
        const entry = this.panes.get(paneID);
        if (!entry) return;
        this.panes.delete(paneID);
        entry.disposed = true;
        // Settle anything still queued before tearing the emulator down, so a concurrent
        // flush()/captureAsync() can never hang on a callback that will now never fire.
        for (const settle of [...entry.settlers]) settle();
        entry.settlers.clear();
        entry.serializer.dispose();
        entry.term.dispose();
        entry.ring.clear();
    }

    disposeAll(): void {
        for (const paneID of [...this.panes.keys()]) this.dispose(paneID);
    }

    // ── input ───────────────────────────────────────────────────────────────────────

    /**
     * Feed raw PTY output. Unknown panes are created lazily (with the default grid) so
     * output is never dropped if bytes arrive before the pane's `attach()`.
     *
     * The chunk is queued for asynchronous parsing, so the caller must not mutate `data`
     * afterwards — pass the buffer straight from the PTY read, never a reused scratch array.
     */
    feed(paneID: string, data: Uint8Array | string): void {
        if (data.length === 0) return;
        let entry = this.panes.get(paneID);
        if (!entry) {
            entry = this.create(this.defaultCols, this.defaultRows);
            this.panes.set(paneID, entry);
        }
        entry.ring.append(typeof data === 'string' ? encoder.encode(data) : data);

        entry.issued += 1;
        const target = entry;
        entry.tail = new Promise<void>((resolve) => {
            let settled = false;
            const settle = (): void => {
                if (settled) return;
                settled = true;
                target.settlers.delete(settle);
                target.done += 1;
                resolve();
            };
            target.settlers.add(settle);
            target.term.write(data, settle);
        });
    }

    resize(paneID: string, cols: number, rows: number): void {
        const entry = this.panes.get(paneID);
        if (!entry) return;
        const wantCols = sanitizeCols(cols, entry.term.cols);
        const wantRows = sanitizeRows(rows, entry.term.rows);
        if (entry.term.cols === wantCols && entry.term.rows === wantRows) return;
        entry.term.resize(wantCols, wantRows);
    }

    /** Await every write handed to the emulator so far. Resolves immediately if idle. */
    async flush(paneID: string): Promise<void> {
        const entry = this.panes.get(paneID);
        if (!entry) return;
        // `tail` is replaced by each new feed(), so re-read it every turn.
        while (!entry.disposed && entry.done < entry.issued) {
            await entry.tail;
        }
    }

    async flushAll(): Promise<void> {
        await Promise.all([...this.panes.keys()].map((paneID) => this.flush(paneID)));
    }

    // ── reads ───────────────────────────────────────────────────────────────────────

    /**
     * Plain-text read of the pane (terminal-surface.md §9.3). `scrollback: false` reads the
     * viewport (the visible rows); `true` reads the whole buffer including history.
     * Unknown pane → `''` (callers that must distinguish "pane closed during capture" from
     * "empty screen" check `has()` first).
     */
    capture(paneID: string, opts: { scrollback: boolean }): string {
        const entry = this.panes.get(paneID);
        if (!entry) return '';
        return readRegion(entry.term, opts.scrollback);
    }

    /** `capture()` after flushing pending writes — the read handlers should use. */
    async captureAsync(paneID: string, opts: { scrollback: boolean }): Promise<string> {
        await this.flush(paneID);
        return this.capture(paneID, opts);
    }

    /**
     * Serialized screen + scrollback a fresh client replays into its renderer
     * (`@xterm/addon-serialize` VT stream; includes modes so DECCKM / bracketed paste
     * survive the replay).
     */
    snapshot(paneID: string): TerminalSnapshot {
        const entry = this.panes.get(paneID);
        if (!entry) return { data: new Uint8Array(0), cols: 0, rows: 0 };
        const text =
            this.snapshotScrollbackLines === undefined
                ? entry.serializer.serialize()
                : entry.serializer.serialize({ scrollback: this.snapshotScrollbackLines });
        return { data: encoder.encode(text), cols: entry.term.cols, rows: entry.term.rows };
    }

    async snapshotAsync(paneID: string): Promise<TerminalSnapshot> {
        await this.flush(paneID);
        return this.snapshot(paneID);
    }

    /** Live VT modes the input encoder needs (DECCKM-aware arrows, paste framing). */
    modes(paneID: string): VtModes {
        const entry = this.panes.get(paneID);
        if (!entry) return IDLE_MODES;
        const modes = entry.term.modes;
        return {
            applicationCursorKeys: modes.applicationCursorKeysMode,
            bracketedPaste: modes.bracketedPasteMode
        };
    }

    async modesAsync(paneID: string): Promise<VtModes> {
        await this.flush(paneID);
        return this.modes(paneID);
    }

    /** Grid the daemon believes the pane has (authoritative cols×rows for PTY sizing). */
    gridSize(paneID: string): GridSize | null {
        const entry = this.panes.get(paneID);
        if (!entry) return null;
        return { cols: entry.term.cols, rows: entry.term.rows };
    }

    /** Byte-perfect tail of raw PTY output (debug/replay complement to the VT snapshot). */
    ringTail(paneID: string, maxBytes?: number): Uint8Array {
        const entry = this.panes.get(paneID);
        if (!entry) return new Uint8Array(0);
        return entry.ring.snapshotTail(maxBytes);
    }

    // ── internals ───────────────────────────────────────────────────────────────────

    private create(cols: number, rows: number): PaneTerminal {
        const term = new Terminal({
            cols,
            rows,
            scrollback: this.scrollback,
            allowProposedApi: true,
            // Headless has no renderer; these only affect parsing/serialization behavior.
            convertEol: false
        });
        const serializer = new SerializeAddon();
        term.loadAddon(serializer);
        return {
            term,
            serializer,
            ring: new RawRingBuffer(this.ringCapacityBytes),
            issued: 0,
            done: 0,
            tail: Promise.resolve(),
            settlers: new Set(),
            disposed: false
        };
    }
}

/**
 * Translate buffer lines to plain text (terminal-surface.md §9.3).
 *
 * - viewport = the `rows` visible lines (`[baseY, baseY + rows)`); scrollback = the whole
 *   buffer (`[0, length)`). Both read the *active* buffer, so an app on the alternate
 *   screen captures the alternate screen (which has no scrollback).
 * - Per-row text comes from xterm's `translateToString(true)`: interior blank columns are
 *   preserved (null cells render as spaces), the trailing run of blanks is dropped.
 * - Soft-wrapped rows are re-joined into one logical line — a region read in ghostty is
 *   non-rectangular, so a wrapped command line must not come back with a spurious newline.
 *   (`@xterm/headless` 6.0.0 does not reflow on resize, so a widened pane leaves padded
 *   wrapped rows behind; the per-row trim above is what keeps the joined text clean.)
 * - Trailing blank lines are trimmed. An empty region yields `''`.
 */
function readRegion(term: HeadlessTerminal, includeScrollback: boolean): string {
    const buffer = term.buffer.active;
    const start = includeScrollback ? 0 : Math.max(0, buffer.baseY);
    const end = includeScrollback ? buffer.length : Math.min(buffer.length, buffer.baseY + term.rows);

    const lines: string[] = [];
    let current: string | null = null;
    for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(true) : '';
        if (current !== null && line?.isWrapped) {
            current += text;
            continue;
        }
        if (current !== null) lines.push(current);
        current = text;
    }
    if (current !== null) lines.push(current);

    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
}
