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
import { trackKittyKeyboard, type KittyKeyboardTracker } from './kitty-keyboard.js';
import {
    DEFAULT_MOUSE_FORMAT,
    trackMouseFormat,
    type MouseFormatTracker,
    type MouseTrackingMode
} from './mouse-modes.js';
import {
    OSC_NOTIFY_CODE,
    OSC_NOTIFY_URXVT_CODE,
    parseOscNotification,
    type OscNotification
} from './osc-notify.js';
import { OSC_52_CODE, parseOsc52, type Osc52Request } from './osc52.js';
import { DEFAULT_RING_CAPACITY_BYTES, RawRingBuffer } from './ring.js';
import { searchTerminal, type SearchOptions, type TerminalMatch } from './search.js';

const { Terminal } = headless;
const { SerializeAddon } = serializeModule;

type SerializeAddonInstance = InstanceType<typeof SerializeAddon>;

/** Scrollback depth per pane, in lines (stack.md: "~10000"). */
export const DEFAULT_SCROLLBACK_LINES = 10_000;
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/** `ITerminalOptions['windowsPty']`, minus the `undefined` `exactOptionalPropertyTypes` adds. */
type TerminalReflowPolicy = NonNullable<NonNullable<ConstructorParameters<typeof Terminal>[0]>['windowsPty']>;

/**
 * THE REFLOW POLICY — read this before touching `applyGrid`.
 *
 * A shell's line editor repaints on `SIGWINCH` assuming the terminal did **not** move its
 * text: zle walks the cursor up by the number of rows it believes its prompt occupies and
 * redraws from there. `@xterm/headless` 6.0.0, left alone, *does* reflow on a column change —
 * it rewraps every line that no longer fits and slides everything below it down. Each shrink
 * therefore inserts a row underneath zle's arithmetic, zle redraws one row too low, and the
 * previous prompt's top line is stranded on screen. A 90-step width drag over a p10k-shaped
 * two-line prompt left **13** stale copies in the daemon's buffer; with reflow off, **1** (the
 * live prompt). Not a hypothesis — both numbers came out of running the UI audit's unchanged
 * `terminal-resize-storm` step against the two policies, product change only.
 *
 * xterm exposes exactly one switch for "this pty wraps its own lines, do not reflow", and it
 * has two spellings:
 *
 *   - `windowsMode: true` — **deprecated**, and unusable here for a second reason. Besides
 *     disabling reflow it installs `updateWindowsModeWrappedState`, a heuristic that on every
 *     LF and every CUP sets `isWrapped` on the current row whenever the previous row's last
 *     cell is not blank. That FABRICATES soft wraps: a line that happens to fill the width is
 *     glued to the next one, which corrupts everything downstream that joins wrapped rows —
 *     `serialize()` (so the replay a client renders), `capture()` (so `kelpi pane capture`),
 *     `search()` and `cellText()`. Measured on 6.0.0: a full-width `AAAA…` followed by a hard
 *     newline and `short-b` serializes as the single line `AAAA…AAAAshort-b`.
 *   - `windowsPty: { backend, buildNumber }` — the maintained replacement, and the one used
 *     here. `CoreTerminal._handleWindowsPtyOptionChange` only arms the wrapping heuristic for
 *     `backend === 'conpty'` with `buildNumber < 21376`, so a **winpty** backend turns reflow
 *     off and leaves the heuristic uninstalled — reflow-off and nothing else.
 *
 * This daemon is not on Windows and this value never leaves the emulator; it is xterm's name
 * for a policy, not a claim about the host.
 *
 * **The one thing reflow-off costs every reader below, and it is not obvious.** xterm's
 * post-shrink per-line trim lives *inside* `if (this._isReflowEnabled)` in `Buffer.resize`, so
 * turning reflow off also turns that trim off: on a column shrink every existing `BufferLine`
 * keeps the width it was allocated at while `_cols` becomes the new one, and those rows are
 * re-used in place by everything the program prints afterwards. A row read with no column
 * bounds is therefore WIDER than the grid — padding, plus any cells the shrink stranded past
 * the new width, which `EL` and an ordinary overwrite can never reach. Every read that joins
 * or indexes rows must bound itself to `term.cols`; `cellText` does, and the ⌘-click regression
 * that taught us (`docs/audit/run-Q/FINDINGS.md` row 1) is pinned in `cell-text.test.ts`.
 *
 * **N23 closed the last reader that could not bound itself: the SNAPSHOT.**
 * `@xterm/addon-serialize` walks `line.length`, not `term.cols`, and there is no option that
 * changes it — so every replay frame carried the stranded cells, and the client's engine (which
 * has no stranded cells of its own) rendered them as content, wrapped the overflow onto the next
 * row and shifted every row below. That is the owner's "rows of garbage glyphs after closing or
 * adjusting panes". Rather than teach one more reader to bound itself, `applyGrid` now does the
 * trim xterm's reflow path would have done (`trimStrandedCells`), so the stranded cells never
 * exist and EVERY reader — including the one that cannot be bounded — is correct by
 * construction.
 *
 * **READ-4 closed the one column that trim could not reach: the HALF GLYPH.** A cell count is
 * not a column count. A double-width glyph occupies two cells, and when the new right edge
 * falls between them, trimming to `cols` cells keeps the glyph's lead cell (still `width: 2`)
 * and drops the spacer holding its second column — so the line is `cols` cells and `cols + 1`
 * COLUMNS, and the serializer, which encodes cells, emitted every one of them. One column of
 * overflow is one wrapped row on the client and every row below it moves down. The trim now
 * blanks that half glyph (see `trimStrandedCells`), which is the state xterm's own parser
 * would have produced anyway — it wraps a wide char rather than putting its lead in the last
 * column, so a lead cell there is a shape the emulator can neither reach nor draw.
 */
const NO_REFLOW: TerminalReflowPolicy = {
    backend: 'winpty',
    buildNumber: 1
};

/**
 * xterm's stock policy, restored for the duration of a ROW-only resize (see `applyGrid`).
 *
 * Reflow-off is a column-axis decision. Rows are the other half of the same option and the
 * only thing they gate is where a *grown* viewport finds its extra lines: stock xterm pulls
 * them back out of scrollback (history slides down into view, which is what ghostty and the
 * shipped app do), while every windows spelling pushes blank rows onto the bottom. Keeping
 * the stock behaviour for the row half costs one extra `resize()` call and keeps a taller
 * window showing history instead of empty space.
 */
const STOCK_REFLOW: TerminalReflowPolicy = {};

/** The slice of xterm's internals `trimStrandedCells` needs, all optional (see the function). */
interface XtermBufferLine {
    readonly length: number;
    resize?: (cols: number, fillCharData: unknown) => void;
    getWidth?: (index: number) => number;
    setCell?: (index: number, cell: unknown) => void;
}
interface XtermBuffer {
    lines?: { length: number; get: (index: number) => XtermBufferLine | undefined };
    getNullCell?: () => unknown;
}
interface XtermCore {
    _bufferService?: { buffers?: { normal?: XtermBuffer; alt?: XtermBuffer } };
}

/**
 * The post-shrink per-line trim `NO_REFLOW` takes away, done by hand (N23).
 *
 * xterm's `Buffer.resize` ends with "trim the end of the line off if cols shrunk" — a
 * `line.resize(newCols, nullCell)` over every line in the buffer — but that loop sits inside
 * `if (this._isReflowEnabled)`, bundled with the rewrap this daemon must not have. So the trim
 * is replayed here: no rewrap, no rows inserted, no cursor arithmetic touched (N11/N12 are
 * untouched by construction — `line.resize` only drops cells that are already past the grid and
 * therefore unreachable), and afterwards no line is wider than the terminal.
 *
 * Both buffers, because `BufferSet.resize` resizes both and an application can switch to the
 * alternate screen at any time. Both walk `buffer.lines`, which for the normal buffer is the
 * whole `CircularList` — scrollback included, not just the viewport rows — because a line that
 * scrolled off before the shrink is still in the snapshot the client replays.
 *
 * **The half glyph (READ-4).** Cutting a line to `cols` CELLS does not cut it to `cols`
 * COLUMNS: a double-width glyph straddling the new right edge keeps its lead cell (`width: 2`)
 * and loses the spacer that carried its second column, leaving a row one column wider than the
 * grid — which the serializer emits in full and a fresh VT wraps onto the next row, shifting
 * every row below it. So the trim finishes the job xterm's `BufferLine.resize` leaves half
 * done and blanks that lead cell. Nothing is lost that could have been shown: xterm's own
 * parser never puts a wide char's lead in the last column (it wraps instead), so the cell is
 * undrawable, and like the cells past it, unreachable — no `EL` and no overwrite lands there.
 *
 * Reached through `_core`, which is private API: every step is feature-detected and a shape
 * that does not answer leaves the buffer exactly as it was — the pre-N23 behaviour, which is
 * degraded but not broken.
 */
function trimStrandedCells(term: HeadlessTerminal, cols: number): void {
    const core = (term as unknown as { _core?: XtermCore })._core;
    const buffers = core?._bufferService?.buffers;
    if (buffers === undefined) return;
    for (const buffer of [buffers.normal, buffers.alt]) {
        const lines = buffer?.lines;
        if (buffer === undefined || lines === undefined) continue;
        const fill = buffer.getNullCell?.();
        if (fill === undefined) continue;
        for (let index = 0; index < lines.length; index += 1) {
            const line = lines.get(index);
            if (line === undefined) continue;
            if (line.length > cols) line.resize?.(cols, fill);
            // The cut can land inside a wide glyph; its orphaned lead half is one column of
            // overflow, so blank it. Guarded on the exact width the trim produced, so a line
            // the resize above could not touch is left exactly as it was.
            if (line.length !== cols || line.getWidth?.(cols - 1) !== 2) continue;
            line.setCell?.(cols - 1, fill);
        }
    }
}

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
    /**
     * **OSC 7** — the shell reporting its working directory (`ESC ] 7 ; file://host/path BEL`).
     *
     * This is the port's pwd producer (terminal-panes.md §TERM-048): every byte already flows
     * through this emulator, so the sequence is parsed here rather than by a second scanner,
     * and the pane's `workingDirectory` follows the shell instead of being frozen at spawn.
     * Boot dispatches `pane-directory-changed` from it and hands the same event to repo
     * auto-detect (graft-git.md §GIT-075).
     *
     * The callback fires for every report, including a repeat of the current directory — the
     * store's reducer and the auto-detect debounce are where "did it actually change?" lives.
     */
    readonly onDirectoryChange?: ((paneID: string, directory: string) => void) | undefined;
    /**
     * **OSC 0 / OSC 2** — the window/icon title (terminal-panes.md §TERM-147).
     *
     * `pane-title-changed`'s producer. xterm already parses both sequences and surfaces them as
     * `Terminal.onTitleChange`, so this is a subscription rather than a parser: OSC 0 sets icon
     * name AND window title, OSC 2 sets the window title, and either fires the event.
     *
     * Fires for every report, repeats included; the store's reducer decides whether the pane's
     * `title` (and therefore its `lastActivityAt`) actually moved.
     */
    readonly onTitleChange?: ((paneID: string, title: string) => void) | undefined;
    /**
     * **OSC 9 / OSC 777** — a desktop notification raised by the program in the pane
     * (terminal-panes.md §TERM-050).
     *
     * The port's equivalent of libghostty's `GHOSTTY_ACTION_DESKTOP_NOTIFICATION`. Parsed here
     * for the same reason OSC 7 is: every PTY byte already passes through this emulator, so a
     * sequence split across two chunks is reassembled by the parser rather than missed by a
     * scanner. `./osc-notify.ts` owns the grammar; boot owns the suppression matrix and the
     * broadcast.
     *
     * Fires once per well-formed sequence; a malformed or empty one never reaches the callback.
     */
    readonly onOscNotification?:
        | ((paneID: string, notification: OscNotification) => void)
        | undefined;
    /**
     * **OSC 52** — a program in the pane driving the clipboard (terminal-panes.md §TERM-046).
     *
     * Parsed here for the same reason OSC 7 and OSC 9 are, and reported *whatever it turns out
     * to be*: a write, a refused read, or an ignored/oversize/malformed sequence. Every one of
     * those has a log line attached to it upstream (`handlers/app/clipboard.ts`), which is why
     * the callback receives `ignored` requests instead of the parser swallowing them.
     *
     * The handler behind it is registered UNCONDITIONALLY and CLAIMS the sequence, whether or
     * not a sink was supplied — see `create()`. That is the read refusal's structural half: no
     * later handler can be added that answers one.
     */
    readonly onClipboardRequest?: ((paneID: string, request: Osc52Request) => void) | undefined;
    /**
     * A pane's VT modes changed (`modes()`'s value is not what it was).
     *
     * Exists for the mouse-reporting modes, which the CLIENT acts on: the port encodes DEC
     * mouse reports in its own layer (`client/src/terminal/mouse.ts`) because neither renderer
     * does, so the modes have to cross the socket as state. DECCKM / bracketed paste ride along
     * because they are the same object; nothing but the mouse half has a client-side consumer.
     *
     * Fires only on a REAL transition, after the chunk that caused it has been parsed.
     */
    readonly onModesChange?: ((paneID: string, modes: VtModes) => void) | undefined;
    /**
     * Bytes this terminal owes its PTY (§TERM-030).
     *
     * A real terminal ANSWERS `CSI ? u` with `CSI ? {flags} u` — that reply is how an
     * application discovers the kitty keyboard protocol exists and which of its enhancements
     * this terminal supports (`kitty-keyboard.ts`). It is the only case in this service where
     * parsing output produces input, so it is a callback rather than a PTY reference: boot owns
     * the manager, and it writes the reply with `writeDirect` so a device answer is never
     * mirrored into a synchronise-input sibling.
     *
     * Fires synchronously while the chunk that asked is being parsed.
     */
    readonly onKittyReply?: ((paneID: string, reply: Uint8Array) => void) | undefined;
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

const IDLE_MODES: VtModes = {
    applicationCursorKeys: false,
    bracketedPaste: false,
    mouseTracking: 'none',
    mouseFormat: DEFAULT_MOUSE_FORMAT,
    kittyKeyboardFlags: 0
};

/** Value equality for the modes object, so `onModesChange` only fires on a real transition. */
export function sameModes(a: VtModes, b: VtModes): boolean {
    return (
        a.applicationCursorKeys === b.applicationCursorKeys &&
        a.bracketedPaste === b.bracketedPaste &&
        (a.mouseTracking ?? 'none') === (b.mouseTracking ?? 'none') &&
        (a.mouseFormat ?? DEFAULT_MOUSE_FORMAT) === (b.mouseFormat ?? DEFAULT_MOUSE_FORMAT) &&
        (a.kittyKeyboardFlags ?? 0) === (b.kittyKeyboardFlags ?? 0)
    );
}

/** Convenience factory for boot wiring. */
export function createTerminalStateService(options: TerminalStateOptions = {}): TerminalStateServiceImpl {
    return new TerminalStateServiceImpl(options);
}

/**
 * OSC 7's payload: a `file://` URL whose path is the shell's cwd — `file:///Users/me/code`,
 * or, with the hostname a shell usually inserts, `file://mac.local/Users/me/code`.
 *
 * Deliberately tolerant, because shells are:
 *   - a bare absolute path (some emit `7;/Users/me`) is accepted as itself;
 *   - percent-escapes are decoded (a path with a space arrives as `%20`), and a malformed
 *     escape keeps the raw string rather than throwing;
 *   - anything neither absolute nor a `file:` URL is ignored — a relative or empty report
 *     must never become a pane's working directory.
 */
export function parseOsc7(data: string): string | null {
    const raw = data.trim();
    if (raw === '') return null;
    let candidate: string;
    if (raw.startsWith('file://')) {
        const rest = raw.slice('file://'.length);
        const slash = rest.indexOf('/');
        if (slash < 0) return null; // `file://host` with no path at all
        candidate = rest.slice(slash);
    } else if (raw.startsWith('/')) {
        candidate = raw;
    } else return null;
    try {
        candidate = decodeURIComponent(candidate);
    } catch {
        // Keep the undecoded form: a bad escape is better than losing the report.
    }
    return candidate === '' ? null : candidate;
}

/** xterm refuses to go below these; clamping here keeps `gridSize()` truthful. */
const MIN_COLS = 2;
const MIN_ROWS = 1;

interface PaneTerminal {
    readonly term: HeadlessTerminal;
    readonly serializer: SerializeAddonInstance;
    readonly ring: RawRingBuffer;
    /** DEC mouse FORMAT (1005/1006/1015/1016) — the half `IModes` does not expose. */
    readonly mouseFormat: MouseFormatTracker;
    /** Kitty keyboard protocol flags + per-screen push/pop stacks (`kitty-keyboard.ts`). */
    readonly kitty: KittyKeyboardTracker;
    /** Last value handed to `onModesChange`, so a repeat DECSET costs no broadcast. */
    lastModes: VtModes;
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
    private readonly onDirectoryChange: ((paneID: string, directory: string) => void) | undefined;
    private readonly onTitleChange: ((paneID: string, title: string) => void) | undefined;
    private readonly onOscNotification:
        | ((paneID: string, notification: OscNotification) => void)
        | undefined;
    private readonly onClipboardRequest: ((paneID: string, request: Osc52Request) => void) | undefined;
    private readonly onModesChange: ((paneID: string, modes: VtModes) => void) | undefined;
    private readonly onKittyReply: ((paneID: string, reply: Uint8Array) => void) | undefined;

    constructor(options: TerminalStateOptions = {}) {
        this.scrollback = Math.max(0, Math.floor(options.scrollback ?? DEFAULT_SCROLLBACK_LINES));
        this.ringCapacityBytes = Math.max(1, Math.floor(options.ringCapacityBytes ?? DEFAULT_RING_CAPACITY_BYTES));
        this.defaultCols = sanitizeCols(options.defaultCols ?? DEFAULT_COLS, DEFAULT_COLS);
        this.defaultRows = sanitizeRows(options.defaultRows ?? DEFAULT_ROWS, DEFAULT_ROWS);
        this.snapshotScrollbackLines =
            options.snapshotScrollbackLines === undefined
                ? undefined
                : Math.max(0, Math.floor(options.snapshotScrollbackLines));
        this.onDirectoryChange = options.onDirectoryChange;
        this.onTitleChange = options.onTitleChange;
        this.onOscNotification = options.onOscNotification;
        this.onClipboardRequest = options.onClipboardRequest;
        this.onModesChange = options.onModesChange;
        this.onKittyReply = options.onKittyReply;
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
            this.applyGrid(existing, wantCols, wantRows);
            return;
        }
        this.panes.set(paneID, this.create(paneID, wantCols, wantRows));
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
        entry.mouseFormat.dispose();
        entry.kitty.dispose();
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
            entry = this.create(paneID, this.defaultCols, this.defaultRows);
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
                // Modes are only observable AFTER the chunk has been parsed, which is what this
                // callback means. Compared rather than hooked so every mode this service reports
                // (xterm's own `IModes` half included) is covered by one check.
                this.publishModes(paneID, target);
                resolve();
            };
            target.settlers.add(settle);
            target.term.write(data, settle);
        });
    }

    resize(paneID: string, cols: number, rows: number): void {
        const entry = this.panes.get(paneID);
        if (!entry) return;
        this.applyGrid(entry, sanitizeCols(cols, entry.term.cols), sanitizeRows(rows, entry.term.rows));
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
     * The wrap-joined logical line under a VIEWPORT cell, plus where that cell lands in it.
     *
     * This is what ⌘-clicking a path in a terminal needs (CONT-122 / TERM-052). Neither
     * renderer this port ships exposes a word-under-cursor API — the same reason scrollback
     * search moved server-side (`term/search.ts`) — so the client sends the cell it computed
     * from the pane's own grid geometry and the daemon reads the buffer that already holds the
     * authoritative screen.
     *
     * Soft wraps are re-joined exactly as `search.ts` does (full-width rows for every row but
     * the last of a logical line) so a path that wrapped mid-line is one token again, and the
     * clicked column maps into the join.
     *
     * **Every row is read against the GRID, never against the line's allocation.** That is not
     * belt-and-braces, it is the whole correctness of the join under `NO_REFLOW` (see the
     * reflow policy above): xterm's post-shrink per-line trim lives *inside*
     * `if (this._isReflowEnabled)` in `Buffer.resize`, so with reflow off a column shrink
     * leaves every existing `BufferLine` at the width it was allocated at while `term.cols`
     * becomes the new one. `translateToString()` with no column bounds then returns the whole
     * allocation — a row 132 cells wide inside a 65-column grid — which glues 67 spaces into
     * the middle of a soft-wrapped path and puts the clicked offset in the gap. That is the
     * `run-Q` ⌘-click regression, and bounding the read to `cols` is what fixes it.
     *
     * The offset is derived from the text actually produced rather than from `row × cols`, so
     * it stays exact when a row's cells and its characters are not one-to-one (a double-width
     * CJK cell contributes one character, a combined cluster contributes several).
     *
     * Unknown pane, out-of-range row, or an empty line → null.
     */
    cellText(paneID: string, row: number, col: number): { text: string; offset: number } | null {
        const entry = this.panes.get(paneID);
        if (!entry) return null;
        const buffer = entry.term.buffer.active;
        const cols = entry.term.cols;
        if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return null;
        const y = Math.max(0, buffer.baseY) + Math.floor(row);
        if (y >= buffer.length) return null;

        // Walk back to the first row of this logical line.
        let start = y;
        while (start > 0 && buffer.getLine(start)?.isWrapped === true) start -= 1;

        let text = '';
        let offset = 0;
        for (let cursor = start; cursor < buffer.length; cursor++) {
            if (cursor > start && buffer.getLine(cursor)?.isWrapped !== true) break;
            const line = buffer.getLine(cursor);
            if (!line) break;
            // Full width for continued rows so the join reads as one logical line; the final
            // row is trimmed, which is what makes the joined text end where content does.
            const isLast =
                cursor + 1 >= buffer.length || buffer.getLine(cursor + 1)?.isWrapped !== true;
            const width = Math.min(cols, line.length);
            // Where the clicked cell lands in the join: the prefix rows, plus this row up to
            // the clicked column.
            if (cursor === y) {
                offset = text.length + line.translateToString(false, 0, Math.min(Math.floor(col), width)).length;
            }
            text += line.translateToString(isLast, 0, width);
        }
        if (text === '') return null;
        return { text, offset };
    }

    async cellTextAsync(
        paneID: string,
        row: number,
        col: number
    ): Promise<{ text: string; offset: number } | null> {
        await this.flush(paneID);
        return this.cellText(paneID, row, col);
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

    /**
     * Live VT modes: what the input encoder needs (DECCKM-aware arrows, paste framing) plus the
     * mouse-reporting pair the CLIENT needs (`mouse-modes.ts`).
     */
    modes(paneID: string): VtModes {
        const entry = this.panes.get(paneID);
        if (!entry) return IDLE_MODES;
        return readModes(entry);
    }

    async modesAsync(paneID: string): Promise<VtModes> {
        await this.flush(paneID);
        return this.modes(paneID);
    }

    /**
     * Every occurrence of `needle` in the pane's buffer (`./search.ts`). Unknown pane → `[]`,
     * which is the same answer as "no matches" on purpose: a pane that closed mid-search is a
     * search with nothing to find, not an error the overlay has to render.
     */
    search(paneID: string, needle: string, options: SearchOptions = {}): TerminalMatch[] {
        const entry = this.panes.get(paneID);
        if (!entry) return [];
        return searchTerminal(entry.term, needle, options);
    }

    /** `search()` after flushing pending writes — what the WS handler uses (see `feed`). */
    async searchAsync(
        paneID: string,
        needle: string,
        options: SearchOptions = {}
    ): Promise<TerminalMatch[]> {
        await this.flush(paneID);
        return this.search(paneID, needle, options);
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

    /**
     * Apply a grid to the emulator — **one axis at a time**, because the two axes want
     * different reflow policies (see `NO_REFLOW` / `STOCK_REFLOW` above).
     *
     * Rows first, at the OLD width and under xterm's stock policy, so a taller viewport still
     * pulls history down out of scrollback. Then columns, under the standing no-reflow policy
     * the terminal was built with, so a narrower window never rewraps text underneath a line
     * editor that is repainting on the assumption that it will not.
     *
     * Both calls are synchronous and nothing between them can observe the intermediate grid:
     * `Terminal.resize()` mutates the buffer inline and this service never subscribes to
     * `onResize`. The option is read live by `Buffer._isReflowEnabled` at resize time, which
     * is what makes a per-axis policy possible at all.
     */
    private applyGrid(entry: PaneTerminal, cols: number, rows: number): void {
        const term = entry.term;
        if (term.cols === cols && term.rows === rows) return;
        if (term.rows !== rows) {
            term.options.windowsPty = STOCK_REFLOW;
            try {
                term.resize(term.cols, rows);
            } finally {
                term.options.windowsPty = NO_REFLOW;
            }
        }
        if (term.cols !== cols) {
            const shrank = cols < term.cols;
            term.resize(cols, term.rows);
            // A column SHRINK is the only direction that strands cells (N23). Growing widens
            // the lines again on demand, and a line shorter than the grid is what xterm does
            // itself.
            if (shrank) trimStrandedCells(term, cols);
        }
    }

    /** Emit `onModesChange` when this pane's modes are not what they last were. */
    private publishModes(paneID: string, entry: PaneTerminal): void {
        if (this.onModesChange === undefined || entry.disposed) return;
        const next = readModes(entry);
        if (sameModes(entry.lastModes, next)) return;
        entry.lastModes = next;
        this.onModesChange(paneID, next);
    }

    private create(paneID: string, cols: number, rows: number): PaneTerminal {
        const term = new Terminal({
            cols,
            rows,
            scrollback: this.scrollback,
            allowProposedApi: true,
            // Headless has no renderer; these only affect parsing/serialization behavior.
            convertEol: false,
            // The standing policy: no column reflow (see NO_REFLOW). `applyGrid` lifts it for
            // the row half of a resize and puts it straight back.
            windowsPty: NO_REFLOW
        });
        const serializer = new SerializeAddon();
        term.loadAddon(serializer);
        if (this.onDirectoryChange !== undefined) {
            const report = this.onDirectoryChange;
            // `false` = "not fully handled", so xterm's own OSC 7 bookkeeping still runs and a
            // future handler can see the sequence too.
            term.parser.registerOscHandler(7, (data) => {
                const directory = parseOsc7(data);
                if (directory !== null) report(paneID, directory);
                return false;
            });
        }
        if (this.onTitleChange !== undefined) {
            const report = this.onTitleChange;
            // §TERM-147's producer. `onTitleChange` covers OSC 0 (icon + window title) and OSC 2
            // (window title) — xterm routes both here, so there is no second handler to write.
            term.onTitleChange((title) => {
                report(paneID, title);
            });
        }
        if (this.onOscNotification !== undefined) {
            const report = this.onOscNotification;
            // §TERM-050. `false` again — a notification is an observation, not a claim on the
            // sequence, so xterm's own bookkeeping and any later handler still see it.
            const notify = (code: number) => (data: string): boolean => {
                const parsed = parseOscNotification(code, data);
                if (parsed !== null) report(paneID, parsed);
                return false;
            };
            term.parser.registerOscHandler(OSC_NOTIFY_CODE, notify(OSC_NOTIFY_CODE));
            term.parser.registerOscHandler(OSC_NOTIFY_URXVT_CODE, notify(OSC_NOTIFY_URXVT_CODE));
        }
        /*
         * §TERM-046: OSC 52. Two things here are deliberate and neither is like its neighbours.
         *
         * **Registered unconditionally**, even with no sink: this handler is the only thing
         * standing between `OSC 52 ; c ; ?` and a terminal that answers it, and that guarantee
         * must not depend on which callbacks boot happened to supply.
         *
         * **Returns `true`** — "fully handled", where OSC 7 / 9 / 777 return `false` so xterm's
         * own bookkeeping and any later handler still see the sequence. This port CLAIMS OSC 52
         * instead. `@xterm/headless` 6.0.0 has no built-in OSC 52 responder (clipboard access is
         * an addon there, and this service loads no such addon) and this service never
         * subscribes to `term.onData`, so nothing in the daemon can turn a read into a reply
         * today; consuming the sequence is what keeps that true when a handler is added later.
         */
        const clipboard = this.onClipboardRequest;
        term.parser.registerOscHandler(OSC_52_CODE, (data) => {
            clipboard?.(paneID, parseOsc52(data));
            return true;
        });
        // Mouse FORMAT has no `IModes` member, so it is tracked off the parser (`mouse-modes.ts`).
        // Registered unconditionally: `modes()` is a synchronous read for every caller, and a
        // pane that starts life without a mode listener can still be attached to later.
        const mouseFormat = trackMouseFormat(term);
        // §TERM-030. Registered unconditionally for the same reason as the mouse format —
        // `modes()` is a synchronous read for every caller — but the query REPLY is only wired
        // when boot supplied a sink, so a service built without one answers nothing rather than
        // pretending to be a terminal that cannot talk back.
        const kitty = trackKittyKeyboard(term, {
            ...(this.onKittyReply === undefined
                ? {}
                : { onReply: (reply: Uint8Array) => this.onKittyReply?.(paneID, reply) })
        });
        const entry: PaneTerminal = {
            term,
            serializer,
            ring: new RawRingBuffer(this.ringCapacityBytes),
            mouseFormat,
            kitty,
            lastModes: IDLE_MODES,
            issued: 0,
            done: 0,
            tail: Promise.resolve(),
            settlers: new Set(),
            disposed: false
        };
        entry.lastModes = readModes(entry);
        return entry;
    }
}

/** The modes object for one pane: xterm's own half plus the tracked mouse format. */
function readModes(entry: PaneTerminal): VtModes {
    const modes = entry.term.modes;
    return {
        applicationCursorKeys: modes.applicationCursorKeysMode,
        bracketedPaste: modes.bracketedPasteMode,
        mouseTracking: modes.mouseTrackingMode as MouseTrackingMode,
        mouseFormat: entry.mouseFormat.format,
        kittyKeyboardFlags: entry.kitty.flags
    };
}

/**
 * Translate buffer lines to plain text (terminal-surface.md §9.3).
 *
 * - viewport = the `rows` visible lines (`[baseY, baseY + rows)`); scrollback = the whole
 *   buffer (`[0, length)`). Both read the *active* buffer, so an app on the alternate
 *   screen captures the alternate screen (which has no scrollback).
 * - Per-row text comes from xterm's `translateToString(true)`: interior blank columns are
 *   preserved (null cells render as spaces), the trailing run of blanks is dropped.
 * - **Every row is read against the GRID**, `min(term.cols, line.length)` — the same bound
 *   `cellText` takes, and for the same reason. `NO_REFLOW` (above) leaves xterm's post-shrink
 *   per-line trim un-run (it lives inside `if (this._isReflowEnabled)` in `Buffer.resize`), so
 *   a column shrink leaves every existing `BufferLine` at the width it was allocated at while
 *   `term.cols` becomes the new one. An unbounded read then hands back the whole allocation:
 *   cells the shrink stranded past the grid, which no program can reach again (a repaint only
 *   writes `cols` columns) and no renderer draws. Unbounded, they append to live output
 *   (`/tmp/dir/notes.md------STRANDED`) and splice into the middle of a re-joined wrap.
 *   Bounding truncates a *pre-shrink* row to the grid — content the user can no longer see
 *   either — which is the deliberate trade: a capture describes the pane as it stands, never a
 *   mix of live cells and cells from a geometry that is gone.
 * - Soft-wrapped rows are re-joined into one logical line — a region read in ghostty is
 *   non-rectangular, so a wrapped command line must not come back with a spurious newline.
 *   (this emulator is configured NOT to reflow — see `NO_REFLOW` — so a widened pane leaves
 *   its wrapped rows split where they were and a narrowed one leaves rows wider than the
 *   grid; the per-row trim above and this join are what keep the read a logical line either
 *   way. Stock `@xterm/headless` 6.0.0 *does* reflow, so this sentence is a statement about
 *   the configuration, not about the library.) The trim is per row rather than a pad to
 *   `cols`, which is what keeps the widen half clean: a stale wrap whose first row is now
 *   null-padded out to the new width joins with no invented run of spaces.
 * - Trailing blank lines are trimmed. An empty region yields `''`.
 */
function readRegion(term: HeadlessTerminal, includeScrollback: boolean): string {
    const buffer = term.buffer.active;
    const cols = term.cols;
    const start = includeScrollback ? 0 : Math.max(0, buffer.baseY);
    const end = includeScrollback ? buffer.length : Math.min(buffer.length, buffer.baseY + term.rows);

    const lines: string[] = [];
    let current: string | null = null;
    for (let y = start; y < end; y++) {
        const line = buffer.getLine(y);
        const text = line ? line.translateToString(true, 0, Math.min(cols, line.length)) : '';
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
