// @vitest-environment node
//
// No DOM is involved: the daemon's emulator is headless and the engine is driven through the wasm's
// own API with no canvas. Under this project's default jsdom environment the `@xterm/headless`
// terminal reaches for `HTMLCanvasElement.getContext` to measure a character and jsdom prints an
// unhandled "Not implemented" error on every run - noise in a battery log that means nothing.

/**
 * #166, end to end at the unit level: the DAEMON's real snapshot into the REAL engine.
 *
 * Everything else about #166 is tested against doubles — a stub emulator in the daemon's stream
 * tests, a fake renderer in the pane's. Neither can see the thing the issue is actually about,
 * because the defect lives in the agreement between two real terminal emulators over one byte
 * stream:
 *
 *   - the daemon's `@xterm/headless` + `@xterm/addon-serialize` (`daemon/src/term/service.ts`),
 *     which serialises a soft-wrapped row and its continuation with NO newline between them,
 *     because the row's `isWrapped` says a terminal replaying this at the same width will wrap it
 *     again at the same column, and
 *   - the client's libghostty-vt (`vendor/ghostty-web-patched`), the terminal doing the replaying,
 *     which is NOT at that width whenever this client is not the size owner.
 *
 * So this file runs both for real: the daemon's service takes the snapshot, the shipped wasm
 * replays it, and the screens are compared. Three screens, because the same question is asked from
 * different sides —
 *
 *   OWNER     a ghostty engine at the owner's grid, fed the raw PTY bytes. What the user whose
 *             window the PTY follows is looking at.
 *   MIRROR    a ghostty engine that started at the viewer's grid, adopted the snapshot's grid and
 *             then applied it. What #166 makes a non-owner do.
 *   OWN-WIDTH the same engine applying the same snapshot at the viewer's own grid. What shipped.
 *
 * `kelpi pane capture` reads the daemon's side, which is why the CLI looked clean throughout #165
 * and #166 while the user's screen was garbage: the comparison below is the only place that
 * disagreement is visible without a browser.
 *
 * The wasm is driven the way `vendor-engine.test.ts` and `renderer-replay.test.ts` drive it:
 * `WebAssembly.compile` on the file this repo ships, then the public two-argument `Ghostty`
 * constructor. No canvas, no jsdom layout, no PTY.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTerminalStateService } from '@kelpi/daemon/term';
import { Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const wasmPath = path.join(repoRoot, 'vendor', 'ghostty-web-patched', 'ghostty-vt.wasm');

const PANE = 'pane-166';
/** The owner's window: narrow enough that an ordinary line soft-wraps. */
const OWNER_COLS = 40;
const OWNER_ROWS = 12;
/** The viewer's window: wide enough that nothing in the fixture would wrap in it at all. */
const VIEWER_COLS = 120;
const VIEWER_ROWS = 30;

/**
 * The PTY's output, as the shell would have written it at the owner's width.
 *
 * One line that does not fit (84 printable characters at 40 columns: three rows, two of them
 * soft-wrap continuations) between two that do. That is the shape the serialiser joins, and the
 * shape the reporter photographed as `17 chars, 9 blank, 17 chars…` — his was Claude Code's diff
 * frame at ~26 columns rather than a `printf`, and the mechanism is this one.
 */
const PTY_OUTPUT = `$ cat long\r\n${'A'.repeat(38)}-HALF-TWO-${'B'.repeat(26)}-END\r\n$ `;

/**
 * RIS. Every replay is applied behind one (`ingest.ts` ▸ `beginApplication`: "the snapshot carries
 * no leading clear… one RIS per attach makes the replay the whole truth"), and these engines are
 * driven exactly as the pane drives them.
 */
const RIS = '\u001bc';

/** A second long line, written AFTER the snapshot: the live half of the stream. */
const PTY_LIVE = `\r\n${'C'.repeat(52)}-LIVE\r\n$ `;

async function loadEngine(): Promise<Ghostty> {
    const module = await WebAssembly.compile(new Uint8Array(fs.readFileSync(wasmPath)));
    const instance = await WebAssembly.instantiate(module, { env: { log: () => {} } });
    return new Ghostty(instance, module);
}

/**
 * Every physical row's text, trailing blank rows dropped: what a reader of the pane sees.
 *
 * The trim is at the END only. A blank row BETWEEN two rows of content is content — it is exactly
 * what a glued screen leaves behind — and dropping those would hide the defect.
 */
function rowTexts(vt: GhosttyTerminal): string[] {
    const rows = Array.from({ length: vt.rows }, (_, row) =>
        (vt.getLine(row) ?? [])
            .map((cell) => (cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)))
            .join('')
            .replace(/\s+$/u, '')
    );
    while (rows.length > 0 && rows.at(-1) === '') rows.pop();
    return rows;
}

/**
 * The engine's rows joined the way a wrap-joined read joins them, so the result is comparable with
 * `kelpi pane capture` (`term/service.ts` `capture`, which returns LOGICAL lines).
 *
 * `isRowWrapped(y)` is libghostty-vt's `wrap_continuation` — "this row is the tail of the one above
 * it" — the same relation xterm.js exposes as `BufferLine.isWrapped` and the daemon's read joins on
 * (`term/search.ts` `collectLogicalLines`).
 */
function logicalLines(vt: GhosttyTerminal): string[] {
    const out: string[] = [];
    for (let row = 0; row < vt.rows; row += 1) {
        const text = (vt.getLine(row) ?? [])
            .map((cell) => (cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)))
            .join('');
        if (row > 0 && vt.isRowWrapped(row)) out[out.length - 1] = `${out.at(-1) ?? ''}${text}`;
        else out.push(text);
    }
    const trimmed = out.map((line) => line.replace(/\s+$/u, ''));
    while (trimmed.length > 0 && trimmed.at(-1) === '') trimmed.pop();
    return trimmed;
}

/** `kelpi pane capture`'s own rows, trailing blanks dropped. */
function captureRows(capture: string): string[] {
    const rows = capture.replace(/\r/gu, '').split('\n').map((row) => row.replace(/\s+$/u, ''));
    while (rows.length > 0 && rows.at(-1) === '') rows.pop();
    return rows;
}

interface Fixture {
    /** What the daemon's emulator holds, wrap-joined (what `kelpi pane capture` prints). */
    readonly capture: string[];
    /** The replay frame a client attaching now would be sent, and the grid it states. */
    readonly snapshot: { data: Uint8Array; cols: number; rows: number };
    /** The owner's own screen: a real engine at the owner's grid, fed the raw bytes. */
    readonly owner: string[];
    readonly ghostty: Ghostty;
}

async function fixture(): Promise<Fixture> {
    const term = createTerminalStateService();
    term.attach(PANE, OWNER_COLS, OWNER_ROWS);
    term.feed(PANE, new TextEncoder().encode(PTY_OUTPUT));
    const snapshot = await term.snapshotAsync(PANE);
    const capture = captureRows(await term.captureAsync(PANE, { scrollback: false }));
    term.dispose(PANE);

    const ghostty = await loadEngine();
    const owner = ghostty.createTerminal(OWNER_COLS, OWNER_ROWS);
    try {
        owner.write(PTY_OUTPUT);
        return { capture, snapshot, owner: rowTexts(owner), ghostty };
    } finally {
        owner.free();
    }
}

describe('the replay is only meaningful at the grid it was serialised at (#166)', () => {
    it("glues the owner's rows when the viewer applies the snapshot at its own width", async () => {
        // THE DEFECT, reproduced against both real emulators. This is what shipped: the viewer's
        // engine is at its own 120 columns, the snapshot was serialised at the owner's 40, and the
        // serialiser left no newline between a wrapped row and its continuation — so two of the
        // owner's rows land side by side on one row of the viewer's screen and every row below them
        // moves up. A TUI that then redraws part of its screen by absolute position paints into the
        // wrong rows, which is the fixed-stride fragments in the report.
        const f = await fixture();
        const vt = f.ghostty.createTerminal(VIEWER_COLS, VIEWER_ROWS);
        try {
            vt.write(RIS); // the reset every replay is applied behind (`ingest.ts`)
            vt.write(f.snapshot.data);

            expect(rowTexts(vt)).not.toEqual(f.owner);
            // Concretely: a row wider than the owner's whole screen, holding both halves.
            const glued = rowTexts(vt).find((row) => row.length > OWNER_COLS);
            expect(glued).toBeDefined();
            expect(glued).toContain('-HALF-TWO-');
            expect(glued).toContain('-END');
            // And the owner's continuation row is nowhere on the viewer's screen as a row.
            expect(rowTexts(vt)).not.toContain(f.owner[2]);
        } finally {
            vt.free();
        }
    });

    it("reproduces the owner's screen row for row when the viewer adopts the snapshot grid", async () => {
        // THE FIX, at the only level that can show it: the client resizes its engine to the grid
        // the replay states (`TerminalPane.tsx` ▸ `adoptReplayGrid`) and then applies the bytes.
        const f = await fixture();
        expect({ cols: f.snapshot.cols, rows: f.snapshot.rows }).toEqual({
            cols: OWNER_COLS,
            rows: OWNER_ROWS
        });

        const vt = f.ghostty.createTerminal(VIEWER_COLS, VIEWER_ROWS);
        try {
            // The pane's order, exactly: resize to the snapshot's grid FIRST, then reset, then
            // write. A resize afterwards would re-wrap what it had just painted.
            vt.resize(f.snapshot.cols, f.snapshot.rows);
            vt.write(RIS);
            vt.write(f.snapshot.data);

            expect(vt.cols).toBe(OWNER_COLS);
            // Row for row, the owner's screen…
            expect(rowTexts(vt)).toEqual(f.owner);
            // …and, wrap-joined, the daemon's authoritative buffer — the same text `kelpi pane
            // capture` prints, which is what read clean while the user's screen did not.
            expect(logicalLines(vt)).toEqual(f.capture);
            for (const row of rowTexts(vt)) expect(row.length).toBeLessThanOrEqual(OWNER_COLS);
        } finally {
            vt.free();
        }
    });

    it('keeps agreeing through the live output that follows the replay', async () => {
        // The half a width-independent snapshot could never have fixed, and the reason #166 was
        // closed at the GRID rather than at the serialisation: the PTY is N columns wide, so every
        // byte it emits after the replay was composed for an N-column screen. A viewer at any other
        // width diverges again on the next autowrap — here, a second long line delivered as live
        // output to all three engines.
        const f = await fixture();
        const owner = f.ghostty.createTerminal(OWNER_COLS, OWNER_ROWS);
        const mirror = f.ghostty.createTerminal(VIEWER_COLS, VIEWER_ROWS);
        const ownWidth = f.ghostty.createTerminal(VIEWER_COLS, VIEWER_ROWS);
        try {
            owner.write(PTY_OUTPUT);
            mirror.resize(f.snapshot.cols, f.snapshot.rows);
            for (const vt of [mirror, ownWidth]) {
                vt.write(RIS);
                vt.write(f.snapshot.data);
            }
            for (const vt of [owner, mirror, ownWidth]) vt.write(PTY_LIVE);

            expect(rowTexts(mirror)).toEqual(rowTexts(owner));
            expect(rowTexts(ownWidth)).not.toEqual(rowTexts(owner));
        } finally {
            owner.free();
            mirror.free();
            ownWidth.free();
        }
    });
});
