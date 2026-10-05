/**
 * Server-side terminal state (WP2.3).
 *
 * One `@xterm/headless` Terminal per pane, fed every PTY byte, plus a bounded raw ring
 * buffer as belt-and-braces. This is what makes `pane capture`, reattach snapshots and
 * DECCKM-aware named keys work with **zero clients attached**
 * (`docs/terminal-surface.md` §9, `../kelpi-docs/research/ghostty-web.md` §3c/§4).
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
import type { IBufferCell, IBufferLine, Terminal as HeadlessTerminal } from '@xterm/headless';

import type { TerminalStateService, VtModes } from '../seams.js';
import { trackKittyKeyboard, type KittyKeyboardTracker, type KittyState } from './kitty-keyboard.js';
import {
    DEFAULT_MOUSE_FORMAT,
    trackMouseFormat,
    type MouseFormat,
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
/** Bound normal PTY read-ahead well below xterm's 50 MB write-discard threshold. */
export const WRITE_HIGH_WATER_BYTES = 512 * 1024;
export const WRITE_LOW_WATER_BYTES = 128 * 1024;

/** `ITerminalOptions['windowsPty']`, minus the `undefined` `exactOptionalPropertyTypes` adds. */
type TerminalReflowPolicy = NonNullable<NonNullable<ConstructorParameters<typeof Terminal>[0]>['windowsPty']>;

/**
 * The two private xterm shapes `hyperlinkAt` reads (#83). Named here rather than inlined so the
 * blast radius of an emulator upgrade is one declaration, and so the read site stays readable.
 * Every field is optional: the reader treats a missing one as "no hyperlink", never as an error.
 * See `hyperlinkAt` for why the private path is taken at all.
 */
interface XtermCoreLine {
    readonly _extendedAttrs?: Record<number, { readonly urlId?: number } | undefined> | undefined;
}
interface XtermCoreWithLinks {
    readonly _inputHandler?:
        | { readonly _oscLinkService?: { getLinkData(id: number): { uri?: string } | undefined } | undefined }
        | undefined;
}

/**
 * A run of cells on one VIEWPORT row (#303): row 0 is the top of the live screen and a negative
 * row is history above it. `cellText` names one per UTF-16 unit of its text (`width` is the
 * character's cell count, 2 for a wide one), and `hyperlinkRangeAt` one per run of a link's cells,
 * which is what a hover underline is drawn under.
 */
export interface TerminalCellSpan {
    readonly row: number;
    readonly col: number;
    readonly width: number;
}

/**
 * Which cell each UTF-16 unit of a row's text came from (#303), walking the row the way xterm 6's
 * `translateToString` does: a wide character's spacer is never visited, an unwritten cell reads as
 * a space, a combined cluster contributes every unit of its string. Null when the walk does not
 * reproduce `expected` (the row's own `translateToString(false, 0, width)`), so an emulator that
 * one day walks differently loses the underline rather than drawing it under the wrong cells.
 */
function rowCells(
    line: IBufferLine,
    width: number,
    row: number,
    expected: string,
    scratch: IBufferCell
): TerminalCellSpan[] | null {
    const cells: TerminalCellSpan[] = [];
    let chars = '';
    for (let x = 0; x < width; ) {
        const cell = line.getCell(x, scratch);
        if (cell === undefined) return null;
        const cellWidth = cell.getWidth();
        const text = cell.getChars() || ' ';
        chars += text;
        for (let unit = 0; unit < text.length; unit++) cells.push({ row, col: x, width: Math.max(1, cellWidth) });
        x += cellWidth || 1;
    }
    return chars === expected ? cells : null;
}

/**
 * The column a click at `col` means (#303): the right half of a wide character is that
 * character, whose cell is the one to its left. Any other column is itself.
 */
function wideCharStart(line: IBufferLine | undefined, col: number, scratch: IBufferCell): number {
    if (line === undefined || col <= 0) return col;
    return line.getCell(col, scratch)?.getWidth() === 0 ? col - 1 : col;
}

/** The OSC 8 link id on a cell of a buffer line, or 0 (#83). Private xterm reads; see `hyperlinkAt`. */
function linkIDAt(line: IBufferLine | undefined, x: number): number {
    if (!line) return 0;
    // `buffer.getLine` hands back an API view; the extended attributes live on the core line it
    // wraps, indexed by CELL column (which is what the client sends).
    const core = (line as unknown as { _line?: XtermCoreLine })._line;
    const urlId = core?._extendedAttrs?.[x]?.urlId;
    return typeof urlId === 'number' ? urlId : 0;
}

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
    clone?: () => XtermBufferLine;
    cleanupMemory?: () => number;
    copyCellsFrom?: (src: XtermBufferLine, srcCol: number, destCol: number, length: number, applyInReverse: boolean) => void;
    /** `CELL_WORDS` words per cell: content (codepoint + combined flag + width), fg, bg. */
    readonly _data?: Uint32Array;
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
/**
 * Each trimmed line's cells as they were before its FIRST trim, up to the last one with text in
 * it, so a later widen can put back what a narrower width cut off. Without it a maximise or a
 * drag that passes through a narrow width deletes every long line's tail for good: the shell
 * repaints its prompt and nothing repaints history.
 */
const strandedTails = new WeakMap<XtermBufferLine, XtermBufferLine>();
/**
 * Only the bottom lines of a buffer keep what a cut hid: a stash costs about the hidden text, so
 * a full 10 000-line scrollback of long lines would hold ~10 MB more. Older history stays cut.
 */
const STRANDED_TAIL_LINES = 1000;

const CELL_WORDS = 3;
/** A cell's codepoint plus its combined flag: 0 or a space is a blank cell. */
const CELL_CHAR_MASK = 0x3fffff;

/** One past the last cell in `from`..`to` of `data` that is not a default-coloured blank. */
function contentEnd(data: Uint32Array, from: number, to: number): number {
    let end = to;
    while (end > from) {
        const word = (end - 1) * CELL_WORDS;
        const char = data[word]! & CELL_CHAR_MASK;
        if ((char !== 0 && char !== 32) || data[word + 1] !== 0 || data[word + 2] !== 0) break;
        end -= 1;
    }
    return end;
}

/**
 * Has `line` kept the first `cols` cells it had when `original` was stashed? Runs on every
 * stashed line on every step of a drag, so it compares xterm's raw cell words: no strings.
 */
function unchangedSinceTrim(line: XtermBufferLine, original: XtermBufferLine, cols: number): boolean {
    const now = line._data;
    const then = original._data;
    if (now === undefined || then === undefined || now.length < cols * CELL_WORDS || then.length < cols * CELL_WORDS) {
        return false;
    }
    for (let word = cols * CELL_WORDS - 1; word >= 0; word -= 1) if (now[word] !== then[word]) return false;
    // ponytail: a combined glyph swapped for another with the same width compares equal.
    // A blank head is refused: a recycled scrollback line is blank too, and would inherit it.
    return contentEnd(then, 0, cols) > 0;
}

/** The buffers `trimStrandedCells` and `restoreStrandedCells` walk, with their fill cell. */
function eachLine(term: HeadlessTerminal, visit: (line: XtermBufferLine, fill: unknown, recent: boolean) => void): void {
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
            if (line !== undefined) visit(line, fill, index >= lines.length - STRANDED_TAIL_LINES);
        }
    }
}

/**
 * The widen half of `trimStrandedCells`: give back the cells a narrower width cut, on every line
 * nothing has rewritten since. A rewritten line drops its stash, so a prompt redrawn while narrow
 * never grows the tail of the one it replaced.
 */
function restoreStrandedCells(term: HeadlessTerminal, fromCols: number, cols: number): void {
    eachLine(term, (line, fill) => {
        const original = strandedTails.get(line);
        if (original === undefined) return;
        if (!unchangedSinceTrim(line, original, fromCols)) {
            strandedTails.delete(line);
            return;
        }
        const end = Math.min(original.length, cols);
        if (line.length < end) line.resize?.(end, fill);
        line.copyCellsFrom?.(original, fromCols, fromCols, end - fromCols, false);
        if (original.length <= cols) strandedTails.delete(line);
    });
}

function trimStrandedCells(term: HeadlessTerminal, cols: number): void {
    eachLine(term, (line, fill, recent) => {
        if (line.length > cols) {
            // Stash before the first cut only: a second, narrower shrink must not replace the
            // whole line with an already-trimmed one. A line rewritten since gets a fresh stash.
            // Blank tails are checked first: most lines are, and cloning them on every step of a
            // drag is what made it slow. The copy stops at the last cell with something in it:
            // xterm lines are the full grid width, and the blanks past the text are most of it.
            const stashed = strandedTails.get(line);
            if (!recent) strandedTails.delete(line);
            else if (stashed === undefined || !unchangedSinceTrim(line, stashed, line.length)) {
                const end = line._data === undefined ? cols : contentEnd(line._data, cols, line.length);
                const copy = end > cols ? line.clone?.() : undefined;
                copy?.resize?.(end, fill);
                copy?.cleanupMemory?.();
                if (copy !== undefined) strandedTails.set(line, copy);
                else strandedTails.delete(line);
            }
            line.resize?.(cols, fill);
        }
        // The cut can land inside a wide glyph; its orphaned lead half is one column of
        // overflow, so blank it. Guarded on the exact width the trim produced, so a line
        // the resize above could not touch is left exactly as it was.
        if (line.length !== cols || line.getWidth?.(cols - 1) !== 2) return;
        line.setCell?.(cols - 1, fill);
    });
}

export interface TerminalStateOptions {
    /** Production pauses only the source PTY, never other panes or slow-client viewers. */
    readonly onBackpressure?: (paneID: string, paused: boolean) => void;
    readonly onError?: (paneID: string, error: unknown) => void;
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

/**
 * How much of a write's side effects to suppress (`docs/terminal-host.md` §7, §8.1).
 *
 * - `0` live output: everything runs.
 * - `1` replayed output the daemon has not seen before (the handoff gap): no kitty query reply,
 *   because the application that asked timed out long ago and a late answer would land at its
 *   prompt as typed text.
 * - `2` replayed output that may repeat what a previous daemon already acted on (a saved screen,
 *   or a crash's retained tail): also no OSC 9/777 notification and no OSC 52 clipboard write.
 */
export type ReplayMode = 0 | 1 | 2;

/** A pane's emulator state as of one byte of its output: what a handoff carries (§5). */
export interface TerminalCheckpoint {
    readonly cols: number;
    readonly rows: number;
    /** A VT stream that rebuilds the screen, scrollback and modes in a fresh terminal. */
    readonly snapshot: Uint8Array;
    readonly kitty: KittyState;
    readonly mouseFormat: MouseFormat;
}

interface PendingWrite {
    readonly bytes: number;
    readonly data: Uint8Array | string;
    readonly settle: () => void;
    readonly mode: ReplayMode;
}

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
    readonly writes: PendingWrite[];
    writeIndex: number;
    writing: boolean;
    pendingBytes: number;
    outputPaused: boolean;
    /** The replay mode of the write xterm is parsing right now; the parser hooks read it. */
    readonly effects: { mode: ReplayMode };
    /** Bytes still to be fed as replay (`markReplay`), and in which mode. */
    replayBudget: number;
    replayBudgetMode: ReplayMode;
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

    private readonly onBackpressure: TerminalStateOptions['onBackpressure'];
    private readonly onWriteError: TerminalStateOptions['onError'];

    constructor(options: TerminalStateOptions = {}) {
        this.onBackpressure = options.onBackpressure;
        this.onWriteError = options.onError;
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
        entry.writes.length = 0;
        this.setOutputPaused(paneID, entry, false);
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
        // The first `replayBudget` bytes after `markReplay` are replayed output (§7).
        if (entry.replayBudget > 0) {
            const bytes = typeof data === 'string' ? encoder.encode(data) : data;
            const replayed = Math.min(entry.replayBudget, bytes.length);
            entry.replayBudget -= replayed;
            this.enqueue(paneID, entry, bytes.subarray(0, replayed), entry.replayBudgetMode);
            if (replayed < bytes.length) this.enqueue(paneID, entry, bytes.subarray(replayed), 0);
            return;
        }
        this.enqueue(paneID, entry, data, 0);
    }

    /**
     * Treat the next `bytes` fed to this pane as replayed output (the handoff drain, §7):
     * `quiet` also silences notifications and clipboard writes, for bytes a previous daemon may
     * already have acted on.
     */
    markReplay(paneID: string, bytes: number, quiet: boolean): void {
        const entry = this.panes.get(paneID);
        if (!entry || bytes <= 0) return;
        entry.replayBudget = bytes;
        entry.replayBudgetMode = quiet ? 2 : 1;
    }

    /**
     * Rebuild a pane from a checkpoint (`docs/terminal-host.md` §7). The saved VT stream goes
     * through the same write queue as output, ahead of anything fed afterwards, with every side
     * effect suppressed; the state xterm does not hold (kitty flags, mouse format) is put back
     * directly. Call on a freshly attached pane, before any output is fed.
     */
    restore(paneID: string, checkpoint: TerminalCheckpoint): void {
        const entry = this.panes.get(paneID);
        if (!entry) return;
        if (checkpoint.snapshot.length > 0) this.enqueue(paneID, entry, checkpoint.snapshot, 2);
        entry.kitty.importState(checkpoint.kitty);
        entry.mouseFormat.restore(checkpoint.mouseFormat);
    }

    /**
     * The pane's state for a handoff, once every byte fed so far has been parsed, plus how many
     * of the last bytes fed must be sent again (`tailBack`): a checkpoint that lands inside an
     * escape sequence or a UTF-8 character would leave the next daemon's parser to print its
     * remainder as text, so the checkpoint names the offset where that sequence began instead.
     * Replaying the start of a sequence has no side effects; its effect only happens once it ends.
     */
    async checkpointAsync(paneID: string): Promise<(TerminalCheckpoint & { readonly tailBack: number }) | null> {
        await this.flush(paneID);
        const entry = this.panes.get(paneID);
        if (!entry) return null;
        const serialized =
            this.snapshotScrollbackLines === undefined
                ? entry.serializer.serialize()
                : entry.serializer.serialize({ scrollback: this.snapshotScrollbackLines });
        return {
            cols: entry.term.cols,
            rows: entry.term.rows,
            snapshot: encoder.encode(serialized + restoreExtras(entry.term)),
            kitty: entry.kitty.exportState(),
            mouseFormat: entry.mouseFormat.format,
            tailBack: incompleteTail(entry)
        };
    }

    private enqueue(paneID: string, entry: PaneTerminal, data: Uint8Array | string, mode: ReplayMode): void {
        entry.issued += 1;
        const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        entry.pendingBytes += bytes;
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
                target.pendingBytes -= bytes;
                try {
                    if (!target.disposed) this.publishModes(paneID, target);
                } catch (error) {
                    this.reportWriteError(paneID, error);
                } finally {
                    if (target.pendingBytes <= WRITE_LOW_WATER_BYTES) this.setOutputPaused(paneID, target, false);
                    resolve();
                }
            };
            target.settlers.add(settle);
            target.writes.push({ data, bytes, settle, mode });
        });
        if (entry.pendingBytes >= WRITE_HIGH_WATER_BYTES) this.setOutputPaused(paneID, entry, true);
        this.drainWrites(paneID, entry);
    }

    private reportWriteError(paneID: string, error: unknown): void {
        // Even a reporting hook must not strand a write or become an unhandled rejection.
        try { this.onWriteError?.(paneID, error); } catch { /* reporting is best effort */ }
    }

    private setOutputPaused(paneID: string, entry: PaneTerminal, paused: boolean): void {
        if (entry.outputPaused === paused) return;
        entry.outputPaused = paused;
        try { this.onBackpressure?.(paneID, paused); } catch (error) { this.reportWriteError(paneID, error); }
    }

    private drainWrites(paneID: string, entry: PaneTerminal): void {
        if (entry.disposed || entry.writing) return;
        const first = entry.writes[entry.writeIndex];
        if (first === undefined) return;
        const batch: PendingWrite[] = [first];
        let bytes = first.bytes;
        entry.writeIndex += 1;
        // Coalesce small reads: a timer per line would make a 10,000-line burst take seconds.
        // Keep strings and bytes separate so xterm retains its incremental decoding semantics.
        while (entry.writeIndex < entry.writes.length) {
            const next = entry.writes[entry.writeIndex]!;
            // Never mix replayed and live output in one write: the parser hooks read its mode.
            if (typeof next.data !== typeof first.data || next.mode !== first.mode || bytes + next.bytes > 64 * 1024) {
                break;
            }
            batch.push(next);
            bytes += next.bytes;
            entry.writeIndex += 1;
        }
        const data = batch.length === 1 ? first.data : typeof first.data === 'string'
            ? batch.map(item => item.data as string).join('')
            : Buffer.concat(batch.map(item => item.data as Uint8Array));
        if (entry.writeIndex === entry.writes.length) {
            entry.writes.length = 0;
            entry.writeIndex = 0;
        } else if (entry.writeIndex * 2 >= entry.writes.length) {
            // Release consumed buffers even when continuous output never empties the queue.
            // Compact only after consuming half, keeping the copying cost amortized linear.
            entry.writes.splice(0, entry.writeIndex);
            entry.writeIndex = 0;
        }
        entry.writing = true;
        entry.effects.mode = first.mode;
        let finished = false;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            entry.effects.mode = 0;
            for (const item of batch) item.settle();
            entry.writing = false;
            // Leave xterm's write callback before handing it the next chunk. This also
            // handles synchronous callbacks without recursively exhausting the JS stack.
            queueMicrotask(() => this.drainWrites(paneID, entry));
        };
        try {
            // Only one write per pane is ever outstanding inside xterm. Callers that
            // synchronously feed a large burst cannot overflow its internal queue either.
            entry.term.write(data, finish);
        } catch (error) {
            this.reportWriteError(paneID, error);
            finish();
        }
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
     * `cellsOf(start, end)` (#303) says which viewport cell each UTF-16 unit of `text[start, end)`
     * sits in, so a token can be drawn back onto the grid as a hover underline. Only the rows the
     * range touches are walked, so a long wrapped line costs its token, not the whole line. It
     * answers undefined, rather than guessing, when a row's cells do not reproduce its text
     * (`rowCells`). Read it before yielding: it reads the buffer as it is when called.
     *
     * A cell on the right half of a wide character is read as that character (#303): the
     * offset would otherwise land after it, on the next character.
     *
     * `maxRows` (#303) bounds the read to that many rows above and below the clicked one, and
     * answers null for a line that runs past them, rather than half a line: the hover probe runs
     * on every cell the pointer crosses, over output that can be one logical line of hundreds of
     * kilobytes (a minified bundle, a source map).
     *
     * Unknown pane, out-of-range row, or an empty line (or one longer than `maxRows`) → null.
     */
    cellText(
        paneID: string,
        row: number,
        col: number,
        options: { readonly maxRows?: number } = {}
    ): {
        text: string;
        offset: number;
        cellsOf: (start: number, end: number) => readonly TerminalCellSpan[] | undefined;
    } | null {
        const entry = this.panes.get(paneID);
        if (!entry) return null;
        const buffer = entry.term.buffer.active;
        const cols = entry.term.cols;
        if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return null;
        const top = Math.max(0, buffer.baseY);
        const y = top + Math.floor(row);
        if (y >= buffer.length) return null;

        const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
        // Walk back to the first row of this logical line.
        let start = y;
        while (start > 0 && buffer.getLine(start)?.isWrapped === true) {
            start -= 1;
            if (y - start > maxRows) return null;
        }

        let text = '';
        let offset = 0;
        const scratch = buffer.getNullCell();
        const clicked = wideCharStart(buffer.getLine(y), Math.floor(col), scratch);
        /** Where each row's text starts in `text`, for `cellsOf`. */
        const rows: Array<{ readonly y: number; readonly start: number; readonly length: number; readonly width: number }> = [];
        for (let cursor = start; cursor < buffer.length; cursor++) {
            if (cursor > start && buffer.getLine(cursor)?.isWrapped !== true) break;
            if (cursor - y > maxRows) return null;
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
                offset = text.length + line.translateToString(false, 0, Math.min(clicked, width)).length;
            }
            const rowText = line.translateToString(isLast, 0, width);
            rows.push({ y: cursor, start: text.length, length: rowText.length, width });
            text += rowText;
        }
        if (text === '') return null;
        const cellsOf = (from: number, to: number): readonly TerminalCellSpan[] | undefined => {
            const cells: TerminalCellSpan[] = [];
            for (const part of rows) {
                const lo = Math.max(from, part.start);
                const hi = Math.min(to, part.start + part.length);
                if (lo >= hi) continue;
                const line = buffer.getLine(part.y);
                if (!line) return undefined;
                // The trimmed last row is a prefix of the whole row's walk, so its cells are too.
                const mapped = rowCells(line, part.width, part.y - top, line.translateToString(false, 0, part.width), scratch);
                if (mapped === null) return undefined;
                for (let unit = lo; unit < hi; unit++) cells.push(mapped[unit - part.start] as TerminalCellSpan);
            }
            return cells;
        };
        return { text, offset, cellsOf };
    }

    async cellTextAsync(
        paneID: string,
        row: number,
        col: number,
        options: { readonly maxRows?: number } = {}
    ): Promise<ReturnType<TerminalStateServiceImpl['cellText']>> {
        await this.flush(paneID);
        return this.cellText(paneID, row, col, options);
    }

    /**
     * The OSC 8 hyperlink URI attached to a VIEWPORT cell, or null (#83).
     *
     * A full-screen TUI does not print URLs the way a shell does. Codex, ratatui apps and an
     * increasing number of CLIs emit OSC 8 (`ESC ] 8 ; ; URI ST title ST`), where the cells hold
     * the TITLE and the address exists only as an attribute on them. `cellText` reads display
     * text, so the token under such a click is a prose word and the URL is unreachable, which
     * is exactly what "⌘-click does nothing in a Codex pane" was.
     *
     * **This reaches into xterm's private internals, deliberately, and here is the reasoning.**
     * `@xterm/headless` parses OSC 8 and stores it (the id on the cell's extended attributes,
     * the URI in an `OscLinkService`), but exposes neither through its public API: the only
     * public consumer is `xterm`'s DOM/canvas renderer, which this daemon does not run. The
     * alternatives were to re-parse the PTY stream for OSC 8 alongside the emulator (a second
     * incomplete emulator, and it would have to track the cursor to know which cells a link
     * covers) or to leave every hyperlinked URL unopenable. So: two private reads, both wrapped
     * in one try/catch that answers null, and `hyperlink.test.ts` drives a real OSC 8 sequence
     * through the real emulator and reads it back, so an xterm upgrade that moves either of
     * them breaks that test rather than silently returning null forever.
     *
     * Row/col are the same VIEWPORT coordinates `cellText` takes, and the same `baseY` offset
     * applies, so the alternate screen (where a TUI lives) reads correctly. No wrap-joining is
     * needed or wanted: every cell of a link carries the id, so the tail row of a hard-wrapped
     * hyperlink answers the whole URI just as the head row does.
     */
    hyperlinkAt(paneID: string, row: number, col: number): string | null {
        return this.hyperlinkRangeAt(paneID, row, col)?.uri ?? null;
    }

    async hyperlinkAtAsync(paneID: string, row: number, col: number): Promise<string | null> {
        await this.flush(paneID);
        return this.hyperlinkAt(paneID, row, col);
    }

    /**
     * `hyperlinkAt`, plus the cells the link covers on screen (#303): what a hover underline over
     * this link is drawn under.
     *
     * The cells are the runs that carry this link's URI on the clicked row and on the rows above
     * and below it, for as long as consecutive rows carry it. Matched by URI, not by link id:
     * xterm gives every OSC 8 that names no `id=` a fresh id, and a TUI that hard-wraps a link
     * emits one per row (Codex does), so the id changes at the row boundary while the address
     * does not. A link wrapped inside a box is two runs with the border between them, and the
     * border is not underlined. Bounded to the viewport, which is all a client can paint.
     */
    hyperlinkRangeAt(
        paneID: string,
        row: number,
        col: number
    ): { uri: string; segments: readonly TerminalCellSpan[] } | null {
        const entry = this.panes.get(paneID);
        if (!entry) return null;
        if (!Number.isFinite(row) || !Number.isFinite(col) || row < 0 || col < 0) return null;
        try {
            const buffer = entry.term.buffer.active;
            const top = Math.max(0, buffer.baseY);
            const y = top + Math.floor(row);
            if (y >= buffer.length) return null;
            const clickedLine = buffer.getLine(y);
            const id = linkIDAt(clickedLine, wideCharStart(clickedLine, Math.floor(col), buffer.getNullCell()));
            if (id === 0) return null;
            const links = (entry.term as unknown as { _core?: XtermCoreWithLinks })._core
                ?._inputHandler?._oscLinkService;
            const uris = new Map<number, string | null>();
            const uriOf = (linkID: number): string | null => {
                if (linkID === 0) return null;
                let known = uris.get(linkID);
                if (known === undefined) {
                    const read = links?.getLinkData(linkID)?.uri;
                    known = typeof read === 'string' && read !== '' ? read : null;
                    uris.set(linkID, known);
                }
                return known;
            };
            const uri = uriOf(id);
            if (uri === null) return null;

            const cols = entry.term.cols;
            const runsOn = (lineY: number): TerminalCellSpan[] => {
                const runs: TerminalCellSpan[] = [];
                const line = buffer.getLine(lineY);
                let start = -1;
                for (let x = 0; x <= cols; x++) {
                    const inLink = x < cols && uriOf(linkIDAt(line, x)) === uri;
                    if (inLink && start < 0) start = x;
                    if (!inLink && start >= 0) {
                        runs.push({ row: lineY - top, col: start, width: x - start });
                        start = -1;
                    }
                }
                return runs;
            };
            const above: TerminalCellSpan[][] = [];
            for (let lineY = y - 1; lineY >= top; lineY--) {
                const runs = runsOn(lineY);
                if (runs.length === 0) break;
                above.unshift(runs);
            }
            const segments = above.flat();
            const bottom = Math.min(buffer.length, top + entry.term.rows);
            for (let lineY = y; lineY < bottom; lineY++) {
                const runs = runsOn(lineY);
                if (runs.length === 0) break;
                segments.push(...runs);
            }
            return { uri, segments };
        } catch {
            return null;
        }
    }

    async hyperlinkRangeAtAsync(
        paneID: string,
        row: number,
        col: number
    ): Promise<{ uri: string; segments: readonly TerminalCellSpan[] } | null> {
        await this.flush(paneID);
        return this.hyperlinkRangeAt(paneID, row, col);
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
            const fromCols = term.cols;
            term.resize(cols, term.rows);
            // A column SHRINK is the only direction that strands cells (N23). Growing widens
            // the lines again on demand, and gives back what an earlier shrink cut.
            if (cols < fromCols) trimStrandedCells(term, cols);
            else restoreStrandedCells(term, fromCols, cols);
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
        const effects: { mode: ReplayMode } = { mode: 0 };
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
                if (effects.mode === 2) return false; // may repeat what a previous daemon posted
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
            if (effects.mode !== 2) clipboard?.(paneID, parseOsc52(data));
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
                : {
                      // A replayed query was asked of a daemon that is gone; answering it now
                      // would type the reply into whatever the application shows by then.
                      onReply: (reply: Uint8Array) => {
                          if (effects.mode === 0) this.onKittyReply?.(paneID, reply);
                      }
                  })
        });
        const entry: PaneTerminal = {
            term,
            serializer,
            ring: new RawRingBuffer(this.ringCapacityBytes),
            mouseFormat,
            kitty,
            lastModes: IDLE_MODES,
            writes: [],
            writeIndex: 0,
            writing: false,
            pendingBytes: 0,
            outputPaused: false,
            issued: 0,
            done: 0,
            tail: Promise.resolve(),
            settlers: new Set(),
            disposed: false,
            effects,
            replayBudget: 0,
            replayBudgetMode: 1
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

// ── handoff helpers (docs/terminal-host.md §5) ────────────────────────────────────────

/** xterm internals the checkpoint reads; the serialize addon does not carry them. */
interface XtermCheckpointCore {
    readonly _core?: {
        readonly _inputHandler?: {
            readonly _parser?: { readonly currentState?: number };
            readonly _utf8Decoder?: { readonly interim?: Uint8Array };
        };
        readonly buffer?: { readonly x: number; readonly y: number; readonly scrollTop: number; readonly scrollBottom: number };
        readonly coreService?: { readonly isCursorHidden?: boolean; readonly decPrivateModes?: { readonly origin?: boolean } };
    };
}

/**
 * VT the serialize addon leaves out, appended to a checkpoint: the scroll region (a TUI that
 * inserts lines inside one, as Codex does, would otherwise scroll the whole screen), then the
 * cursor put back where DECSTBM's homing moved it from, then a hidden cursor (Claude Code and
 * other Ink apps hide it).
 */
function restoreExtras(term: HeadlessTerminal): string {
    const core = (term as unknown as XtermCheckpointCore)._core;
    const buffer = core?.buffer;
    if (buffer === undefined) return '';
    let extra = '';
    if (buffer.scrollTop !== 0 || buffer.scrollBottom !== term.rows - 1) {
        extra += `\x1b[${String(buffer.scrollTop + 1)};${String(buffer.scrollBottom + 1)}r`;
        const origin = core?.coreService?.decPrivateModes?.origin === true;
        const row = origin ? buffer.y - buffer.scrollTop + 1 : buffer.y + 1;
        extra += `\x1b[${String(row)};${String(Math.min(buffer.x, term.cols - 1) + 1)}H`;
    }
    if (core?.coreService?.isCursorHidden === true) extra += '\x1b[?25l';
    return extra;
}

/**
 * Only ESC opens a sequence here: output is decoded as UTF-8 before it is parsed, so raw C1
 * bytes (0x9b and friends) are ordinary continuation bytes, never introducers. ESC itself never
 * occurs inside a UTF-8 character.
 */
const ESC = 0x1b;

/** How many of the last bytes fed belong to a sequence or character the parser has not finished. */
function incompleteTail(entry: PaneTerminal): number {
    const handler = (entry.term as unknown as XtermCheckpointCore)._core?._inputHandler;
    const parserBusy = (handler?._parser?.currentState ?? 0) !== 0;
    const interim = handler?._utf8Decoder?.interim;
    const partialChar = interim === undefined ? 0 : interim.filter((byte) => byte !== 0).length;
    if (!parserBusy) return partialChar;
    // Mid-sequence: step back to the escape that opened it. An `ESC \` pair is a string
    // terminator, not an opener, so it is skipped. A payload longer than the scanned window
    // (a huge OSC or DCS) cannot be stepped back over; the checkpoint then keeps its offset.
    const tail = entry.ring.snapshotTail(64 * 1024);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
        if (tail[index] === ESC && tail[index + 1] !== 0x5c) return tail.length - index;
    }
    return 0;
}
