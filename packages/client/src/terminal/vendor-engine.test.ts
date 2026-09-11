/**
 * The vendored terminal engine is a FORK, and forks get lost.
 *
 * `ghostty-web` reaches this app through `pnpm.overrides['ghostty-web'] =
 * file:vendor/ghostty-web-patched`, and `packages/client/package.json` still asks for
 * `^0.4.0`. Drop the override — or take a future npm release wholesale — and everything still
 * installs, still typechecks and still boots; what silently disappears is the behaviour this
 * repo added on top of upstream. The IME half is the easiest to lose and the hardest to notice
 * in a unit test: composition would still work, the preedit would still show, it would just be
 * back in the corner of the pane instead of on the caret (TERM-032 / TERM-033).
 *
 * The behaviour itself is measured in the live audit (`scripts/ui-audit/audit.mjs` step
 * `terminal-ime`, which parks the cursor with a CUP escape and compares measured origins
 * against computed cell origins) — it needs WASM, a canvas and a PTY, none of which exist in
 * jsdom. What CAN be checked here, in milliseconds, is that the artifact those measurements
 * were taken against is the artifact this workspace installs, and that the built bundle and
 * the snapshotted source it claims to come from have not drifted apart.
 *
 * From `-nex.13` the fork is no longer TypeScript-only: `ghostty-vt.wasm` carries a libghostty-vt
 * patch (§165), and a marker string cannot see inside a 413 KB binary. So this file grew two new
 * kinds of case.
 *
 * FOUR run the REAL wasm (`WebAssembly.compile` on the file this directory ships, driven through
 * the public `Ghostty` constructor exactly as `renderer-replay.test.ts` does) and assert the VT's
 * behaviour rather than its bytes.
 *
 * TWO load no wasm at all and hash the one INLINED in the built bundles against the one on disk.
 * Those are the cases that actually guard a re-vendored engine, and the reason is worth stating
 * plainly because the first pass at §165 got it wrong: the four behavioural cases read the wasm
 * off disk, which is not where the app gets its engine from (see `inlinedWasm`). A patched wasm
 * shipped behind a dist still carrying upstream's left all four green and the app unchanged.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ghostty, type GhosttyTerminal } from 'ghostty-web';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const vendorRoot = path.join(repoRoot, 'vendor', 'ghostty-web-patched');

/** The version the audit evidence and PROVENANCE.md were written against. */
const EXPECTED_VERSION = '0.4.0-nex.13';

/** Markers of the caret-anchored IME, in the built ESM bundle the client imports. */
const CARET_MARKERS = ['data-ime-preedit', 'data-ime-caret', 'syncImeCaret'];

/**
 * Markers of `-nex.3`'s honoured `allowTransparency` (§N17).
 *
 * The same loss the caret markers guard against, one release later: upstream's option was
 * accepted and never read, so every default-background paint was an opaque `fillRect` and a
 * `background-opacity < 1` pane rendered solid however translucent the window and the fill
 * behind the canvas were. `paintDefaultBackground` is the single seam that clears instead —
 * take a future npm release wholesale and translucency silently goes back to solid.
 */
const TRANSPARENCY_MARKERS = ['paintDefaultBackground', 'allowTransparency'];

/**
 * Markers of `-nex.4`'s focus-aware cursor (§N20).
 *
 * The third thing upstream does not have and the app cannot see the absence of in a unit test:
 * `ghostty-web` draws one cursor, filled and blinking, in every terminal on the page — so a
 * grid of panes reads as if all of them had the caret. `setFocused` is the port of
 * `ghostty_surface_set_focus`, and `renderHollowCursor` is the treatment it selects
 * (`src/renderer/cursor.zig:59-60` — steady, hollow, whatever style the terminal asked for).
 * Take a future npm release wholesale and every pane starts blinking again.
 */
const CURSOR_FOCUS_MARKERS = ['setFocused', 'renderHollowCursor', 'cursorStateDirty'];

/**
 * The marker of `-nex.5`'s zero-length `write()` guard (§N1 / §N23).
 *
 * `GhosttyTerminal.write()` hands `bytes.length` to the WASM allocator, and a ZERO-size request
 * comes back as Zig's non-null sentinel `0xFFFFFFFF` — `-1` off the `i32` export — so the
 * `Uint8Array.set(bytes, ptr)` that follows throws `RangeError: offset is out of bounds`. The
 * daemon replays an EMPTY snapshot for any pane whose shell has not printed yet, so that throw
 * is the first write into a fresh engine: N1's "terminal renderer failed to start", and the
 * `external-editor` error `run-U` and `run-V` both logged.
 *
 * Unlike the other three adaptations this one is ALSO defended in the client (`renderer.ts`
 * returns early on zero bytes), so taking a regressed engine would fix itself invisibly here and
 * break for any other embedder — which is exactly the kind of silent fork loss this file exists
 * to catch. The needle is the minified form (`vite` keeps the guard as its own statement).
 */
const EMPTY_WRITE_GUARD = /if \((\w+)\.length === 0\)\s*return;\s*const \w+ = this\.exports\.ghostty_wasm_alloc_u8_array\(\1\.length\)/;

/**
 * Markers of `-nex.6`'s paint suspension (§N24).
 *
 * The fourth adaptation, and the one whose absence is invisible until someone photographs it: a
 * widening `ghostty_terminal_resize` under heap churn leaves cells in libghostty-vt's own
 * storage that the VT never wrote, and upstream's render loop paints them on the very next
 * frame — measured at 66.7 flashes per 100 close/reopen cycles over a left/right split, nine to
 * ten frames each. The app suspends the engine's paint for the length of the resize→replay
 * window (`TerminalRenderer.resize`); take a future npm release wholesale and the suspension
 * becomes a call into nothing, the hold silently stops holding, and the flash comes back.
 */
const PAINT_SUSPEND_MARKERS = ['setPaintSuspended', 'isPaintSuspended', 'this.paintSuspended'];

/**
 * The guard has to be the FIRST thing `render()` does — before a single cell is read.
 *
 * Vite keeps the early return as its own statement; the parameter names are minified, hence the
 * pattern rather than a literal.
 */
const PAINT_SUSPEND_GUARD = /render\([^)]*\)\s*\{\s*(?:var\s+\w+;\s*)?if\s*\(this\.paintSuspended\)\s*return;/;

/**
 * Markers of `-nex.7`'s live default colours (§N18).
 *
 * The fifth adaptation, and the one that only shows itself the moment a user changes
 * `theme = …` with the app running: `ghostty_terminal_new_with_config` takes `bg_color` /
 * `fg_color` ONCE and there is no export that moves them, so every cell the VT has not coloured
 * explicitly reports the colours the terminal was BORN with for the rest of its life. Paint
 * those literally and a live theme change repaints the CSS around the canvas, the margins and
 * the cursor while the cell area keeps the previous theme — and under `background-opacity < 1`
 * the stale fill is opaque, so a translucent pane goes solid until relaunch (measured at 359 497
 * px of the old background). `setTerminalDefaultColors` is how the terminal tells the renderer
 * which two colours mean "default", and `liveThemeColor` is the paint-time lookup that answers
 * them from the LIVE theme. Take a future npm release wholesale and the call lands on nothing.
 */
const LIVE_THEME_MARKERS = [
    'setTerminalDefaultColors',
    'liveThemeColor',
    'isTerminalDefaultBackground',
    'isTerminalDefaultForeground'
];

/**
 * …and the lookup has to be IN the two paint sites, not merely defined.
 *
 * A default-colour table nothing consults is the failure mode a `toContain` cannot see: both
 * `fillStyle` assignments — the cell background (pass 1) and the glyph (pass 2) — must go
 * through it before falling back to the cell's own components.
 */
const LIVE_THEME_PAINT_SITES = /fillStyle\s*=\s*this\.liveThemeColor\([^)]*\)\s*\?\?\s*this\.rgbToCSS\(/g;

/**
 * Marker of `-nex.8`'s scrollbar-strip restore.
 *
 * `renderScrollbar`'s first paint is a backdrop: it clears a ~14px strip at the canvas's right
 * edge to the default background on every frame the scrollbar is drawn — over the last column
 * or two of TEXT. When the scrollbar stops (the fade ends at opacity 0, or a forced repaint
 * passes 0), `render()` skips the scrollbar path entirely and nothing marks the strip's rows
 * dirty, so the rightmost cells stayed erased until the application rewrote them: every scroll
 * gesture left the terminal's right edge cut off. `scrollbarWasPainted` is the transition
 * tracker that forces one full-frame walk on the first scrollbar-less frame. Take a future npm
 * release wholesale and the right edge starts disappearing again.
 */
const SCROLLBAR_RESTORE_MARKERS = ['scrollbarWasPainted'];

/**
 * PR #120's corner chip, which `-nex.2` replaced. Its label must NOT come back.
 *
 * Built from code points rather than written as a literal, for the same reason the audit's
 * fixtures are: this is the operand of a `not.toContain`, and a Hangul literal that some
 * editor or diff turned into `??` would keep passing while checking nothing.
 */
const REPLACED_CHIP_LABEL = String.fromCodePoint(0xc870, 0xd569, 0xc911); // 조합중

function read(file: string): string {
    return fs.readFileSync(file, 'utf8');
}

/**
 * The shipped wasm, instantiated through the public API.
 *
 * `new Ghostty(instance, module)` is the same two-argument form the app uses (the module is what
 * `-nex.10` needs to give every terminal its own instance), and it is the form
 * `renderer-replay.test.ts` already proves works under vitest. Node's `WebAssembly` is a global
 * in the jsdom environment too, so nothing here needs a browser.
 */
async function loadEngine(): Promise<Ghostty> {
    const module = await WebAssembly.compile(
        new Uint8Array(fs.readFileSync(path.join(vendorRoot, 'ghostty-vt.wasm')))
    );
    const instance = await WebAssembly.instantiate(module, { env: { log: () => {} } });
    return new Ghostty(instance, module);
}

/** Every physical row's text, trailing blanks trimmed: what a reader of the pane sees. */
function rowTexts(vt: GhosttyTerminal): string[] {
    return Array.from({ length: vt.rows }, (_, row) =>
        (vt.getLine(row) ?? [])
            .map((cell) => (cell.codepoint === 0 ? ' ' : String.fromCodePoint(cell.codepoint)))
            .join('')
            .trimEnd()
    );
}

/** The indices of the rows the engine reports as soft-wrap continuations. */
function wrappedRows(vt: GhosttyTerminal): number[] {
    return Array.from({ length: vt.rows }, (_, row) => row).filter((row) => vt.isRowWrapped(row));
}

/**
 * The wasm the BUILT BUNDLE will actually run, pulled back out of the bundle.
 *
 * `source/lib/ghostty.ts` resolves the engine with `new URL('../ghostty-vt.wasm',
 * import.meta.url)`, and vite, building a library, cannot know what URL that will have at
 * runtime, so it INLINES the file it finds at the build-tree root as a
 * `data:application/wasm;base64,…` URI. `Ghostty.load()` then tries that data URI first and
 * only falls back to a `.wasm` on disk, which the client build does not even emit. So the
 * bundle IS the engine, and the file beside it is decoration.
 */
function inlinedWasm(bundle: string): Buffer {
    const base64 = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/.exec(read(bundle))?.[1];
    if (base64 === undefined) throw new Error(`no inlined wasm data URI in ${bundle}`);
    return Buffer.from(base64, 'base64');
}

const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex');

describe('vendored ghostty-web engine', () => {
    it('is the fork this repo builds, at the version the audit evidence names', () => {
        const manifest = JSON.parse(read(path.join(vendorRoot, 'package.json'))) as {
            name: string;
            version: string;
        };
        expect(manifest.name).toBe('ghostty-web');
        expect(manifest.version).toBe(EXPECTED_VERSION);
    });

    it('is what the client resolves — the override is still in force', () => {
        // pnpm materialises a `file:` dependency as a real directory under `.pnpm`, so the
        // useful question is not "is it a symlink to vendor/" but "does the package the client
        // would import carry the fork's version".
        const installed = path.join(
            repoRoot,
            'packages',
            'client',
            'node_modules',
            'ghostty-web',
            'package.json'
        );
        const manifest = JSON.parse(read(installed)) as { version: string };
        expect(manifest.version).toBe(EXPECTED_VERSION);
    });

    it('ships a bundle with the caret-anchored IME and without the chip it replaced', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of CARET_MARKERS) {
            expect(bundle).toContain(marker);
        }
        expect(bundle).not.toContain(REPLACED_CHIP_LABEL);
    });

    it('ships a bundle whose renderer honours allowTransparency (§N17)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of TRANSPARENCY_MARKERS) {
            expect(bundle).toContain(marker);
        }
    });

    it('ships a bundle whose cursor follows surface focus (§N20)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of CURSOR_FOCUS_MARKERS) {
            expect(bundle).toContain(marker);
        }
    });

    it('ships a bundle whose write() survives zero bytes (§N1 / §N23)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        // The guard has to come BEFORE the allocation it protects, or it protects nothing.
        expect(EMPTY_WRITE_GUARD.test(bundle)).toBe(true);
    });

    it('ships a bundle that can suspend its paint, guarded before the first cell read (§N24)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of PAINT_SUSPEND_MARKERS) {
            expect(bundle).toContain(marker);
        }
        expect(bundle).toMatch(PAINT_SUSPEND_GUARD);
    });

    it('ships the fresh-instance replay reset in both the VT and the terminal host (§-nex.9)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        expect(bundle.match(/resetForReplay\(\)/g)?.length).toBeGreaterThanOrEqual(3);
        expect(bundle).toContain('new WebAssembly.Instance');
        expect(read(path.join(vendorRoot, 'source', 'lib', 'ghostty.ts'))).toContain('this.cellPool = replacement.cellPool');
    });

    it('ships every terminal on its own WASM instance, with the shared one kept for key encoding (§-nex.10)', () => {
        // Two terminals in one heap was the precondition for the heap-churn trap
        // (`RuntimeError: memory access out of bounds` on a long session's remount replay,
        // and every retry landing on the same corrupted heap). `createTerminal` instantiates
        // the compiled module per terminal; the shared instance still serves the key encoder.
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        expect(bundle.match(/createTerminalOnThisInstance\(/g)?.length).toBeGreaterThanOrEqual(3);
        const ghosttySource = read(path.join(vendorRoot, 'source', 'lib', 'ghostty.ts'));
        expect(ghosttySource).toContain('return Ghostty.fromModule(module).createTerminalOnThisInstance(cols, rows, config);');
        expect(ghosttySource).toContain('if (module === undefined) return this.createTerminalOnThisInstance(cols, rows, config);');
    });

    it('ships a viewport that output cannot move, and a keystroke brings back (§-nex.11)', () => {
        // Upstream snapped to the bottom on every write while scrolled up; against a TUI that
        // repaints its status line several times a second that is a viewport nobody can hold,
        // and with a smooth-scroll animation still heading the other way it jitters. The pin
        // shifts the offset by the scrollback growth instead, and typing scrolls to the bottom.
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        expect(bundle.match(/pinViewportAcrossGrowth\(/g)?.length).toBeGreaterThanOrEqual(2);
        expect(bundle).toContain('scrollOnUserInput');
        const terminalSource = read(path.join(vendorRoot, 'source', 'lib', 'terminal.ts'));
        expect(terminalSource).not.toContain('Auto-scroll to bottom on new output');
        expect(terminalSource).toContain('if (grown > 0) this.pinViewportAcrossGrowth(grown);');
        expect(terminalSource).toContain('if (this.options.scrollOnUserInput !== false) {');
    });

    it('ships a selection manager whose document listeners ALL come off on dispose (§-nex.12)', () => {
        // The retainer behind "Cannot allocate Wasm memory for new instance": an anonymous
        // `document` mousedown listener that dispose() never removed kept every terminal ever
        // opened reachable — and, since `-nex.10`, its own WASM instance with it. The handler is
        // bound and removed like the other three; the bundle must carry both halves.
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        expect(bundle).toMatch(/document\.addEventListener\("mousedown",\s*this\.boundDocumentMouseDownHandler\)/);
        expect(bundle).toMatch(/document\.removeEventListener\("mousedown",\s*this\.boundDocumentMouseDownHandler\)/);
        const source = read(path.join(vendorRoot, 'source', 'lib', 'selection-manager.ts'));
        expect(source).not.toMatch(/document\.addEventListener\('mousedown',\s*\(/);
        // Every document.addEventListener in the source has a matching removal on dispose.
        const added = [...source.matchAll(/document\.addEventListener\('(\w+)'/g)].map((m) => m[1]).sort();
        const removed = [...source.matchAll(/document\.removeEventListener\('(\w+)'/g)].map((m) => m[1]).sort();
        expect(new Set(added)).toEqual(new Set(removed));
    });

    it('ships a bundle whose default cell colours follow a LIVE theme (§N18)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of LIVE_THEME_MARKERS) {
            expect(bundle).toContain(marker);
        }
        // Both paint sites, or the fix is half a fix: the cell background AND the glyph.
        expect(bundle.match(LIVE_THEME_PAINT_SITES) ?? []).toHaveLength(2);
        // …and the terminal has to declare the colours, beside the `createTerminal` that used
        // them — a renderer with nothing declared falls back to upstream's `(0,0,0)` rule.
        expect(bundle).toMatch(/setTerminalDefaultColors\(\s*[A-Za-z_$]/);
    });

    it('ships a bundle that repaints the strip the scrollbar backdrop erases (§-nex.8)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of SCROLLBAR_RESTORE_MARKERS) {
            expect(bundle).toContain(marker);
        }
        // The transition has to both READ and WRITE the tracker inside render(), or it is a
        // field nothing consults: the read is the forceAll trigger, the write arms it.
        expect(bundle).toMatch(/this\.scrollbarWasPainted\s*&&/);
        expect(bundle).toMatch(/this\.scrollbarWasPainted\s*=[^=]/);
    });

    it('keeps the snapshotted source in step with the bundle', () => {
        // `dist/` is gitignored, so `source/` is the only copy of the fork that survives a
        // clean clone. A bundle rebuilt from a tree that was never snapshotted is a fork
        // nobody can reproduce — this fails the moment the two disagree about the IME.
        const terminalSource = read(path.join(vendorRoot, 'source', 'lib', 'terminal.ts'));
        expect(terminalSource).toContain('syncImeCaret');
        expect(terminalSource).toContain('updatePreedit');
        expect(terminalSource).toContain('data-ime-preedit');
        expect(terminalSource).not.toContain(REPLACED_CHIP_LABEL);
        // §N17's half of the fork, in the two files that carry it.
        expect(terminalSource).toContain('allowTransparency: this.options.allowTransparency');
        const rendererSource = read(path.join(vendorRoot, 'source', 'lib', 'renderer.ts'));
        expect(rendererSource).toContain('paintDefaultBackground');
        expect(rendererSource).toContain('this.ctx.clearRect');
        // §N20's half, in the two files that carry it: the Terminal remembers the flag across
        // `open()` and the renderer picks the treatment from it.
        expect(terminalSource).toContain('setFocused(focused: boolean)');
        expect(terminalSource).toContain('focused: this.surfaceFocused');
        expect(rendererSource).toContain('renderHollowCursor');
        expect(rendererSource).toContain('this.cursorVisible || !this.focused');
        // §N1/§N23's half, in the file that carries it.
        const ghosttySource = read(path.join(vendorRoot, 'source', 'lib', 'ghostty.ts'));
        expect(ghosttySource).toContain('if (bytes.length === 0) return;');
        // §N24's half, in the two files that carry it: the Terminal remembers the flag across
        // `open()` and forces a full frame on resume; the renderer refuses to paint and carries
        // the pixels across a suspended resize.
        expect(terminalSource).toContain('setPaintSuspended(suspended: boolean)');
        expect(terminalSource).toContain('if (this.paintSuspended) this.renderer.setPaintSuspended(true)');
        expect(terminalSource).toContain('if (!this.paintSuspended) {');
        expect(rendererSource).toContain('if (this.paintSuspended) return;');
        expect(rendererSource).toContain('this.paintSuspended && this.canvas.width > 0');
        // §N18's half, in the two files that carry it: the Terminal declares the colours the
        // WASM terminal was built with, and the renderer resolves a default cell through the
        // live theme at paint time (in the default-background test AND in both fills).
        expect(terminalSource).toContain('this.renderer.setTerminalDefaultColors(');
        expect(rendererSource).toContain('setTerminalDefaultColors(background: number | null');
        expect(rendererSource).toContain('if (this.isTerminalDefaultBackground(r, g, b)) return true;');
        expect(rendererSource.match(/this\.liveThemeColor\(\w+_r, \w+_g, \w+_b\) \?\?/g) ?? []).toHaveLength(2);
        // §-nex.8's half, in the renderer: the frame after the scrollbar's last one forces the
        // full walk that repaints the strip its backdrop erased.
        expect(rendererSource).toContain('const scrollbarPainted = !!scrollbackProvider && scrollbarOpacity > 0;');
        expect(rendererSource).toContain('if (this.scrollbarWasPainted && !scrollbarPainted) {');
        expect(rendererSource).toContain('this.scrollbarWasPainted = scrollbarPainted;');
    });

    it('inlines the SHIPPED wasm in both bundles, not a stale one (§165)', () => {
        // The finding this case exists for, and the one the two behavioural cases below could
        // not see: they compile `ghostty-vt.wasm` off disk, which is not where the app gets its
        // engine from. Both bundles carry the wasm as a base64 data URI baked in at build time
        // (see `inlinedWasm`), and `Ghostty.load()` tries that URI FIRST; the client build emits
        // no `.wasm` asset at all, so the data URI is the only engine that ever runs in the app.
        //
        // Rebuilding the wasm therefore does nothing until the TypeScript dist is rebuilt on top
        // of it, and the first pass at this fix shipped a patched `ghostty-vt.wasm` beside a dist
        // still carrying upstream's: every test green, the app unchanged. Nothing else in this
        // file, or in the audit, or in the scenarios, would have caught that.
        const onDisk = sha256(fs.readFileSync(path.join(vendorRoot, 'ghostty-vt.wasm')));
        for (const bundle of ['ghostty-web.js', 'ghostty-web.umd.cjs']) {
            expect(sha256(inlinedWasm(path.join(vendorRoot, 'dist', bundle)))).toBe(onDisk);
        }
    });

    it('installs that same bundle where the client imports it from (§165)', () => {
        // pnpm materialises the `file:` override as its own directory, so the bundle the client
        // resolves is a separate path. A rebuilt dist that was never reinstalled is the same
        // failure as the one above, one directory further along.
        //
        // Be honest about where this one earns its keep: with pnpm's default linker the installed
        // file is a HARD LINK, sharing an inode with the vendor bundle, so on this machine it
        // cannot disagree with the case above and cannot fail independently. It matters wherever
        // pnpm copies instead of linking (`package-import-method=copy`, the hoisted linker, a
        // store on a different filesystem, CI caches that rehydrate node_modules), which is
        // exactly where a stale install is plausible and invisible.
        const installed = path.join(repoRoot, 'packages', 'client', 'node_modules', 'ghostty-web');
        const onDisk = sha256(fs.readFileSync(path.join(vendorRoot, 'ghostty-vt.wasm')));
        for (const bundle of ['ghostty-web.js', 'ghostty-web.umd.cjs']) {
            expect(sha256(inlinedWasm(path.join(installed, 'dist', bundle)))).toBe(onDisk);
        }
    });

    it('ships a wasm that forgets a row is wrapped once ESC[2K erases it (§165)', async () => {
        // The narrowest statement of the defect, straight off the wasm.
        //
        // libghostty-vt models soft wrap with two flags per row: `wrap` ("continues onto the next
        // row") and `wrap_continuation` ("is the continuation of the previous row"). `isRowWrapped`
        // exports the second one, which is also the only one xterm.js has (`BufferLine.isWrapped`).
        // Upstream ghostty's `Terminal.eraseLine` left BOTH standing on EL 2, under a note saying
        // xterm does not reset them either: true of xterm(1), false of the xterm.js lineage the
        // daemon runs (`InputHandler.eraseInLine` case 2 passes `clearWrap = true`), and the
        // disagreement is what #165 is. A row that has been erased to nothing cannot be the tail
        // of the line above it, and PageList's column reflow believes the flag over the cells.
        const ghostty = await loadEngine();
        const vt = ghostty.createTerminal(10, 4);
        try {
            // 16 cells at 10 columns: row 0 holds '0123456789' and soft-wraps into row 1.
            vt.write('0123456789abcdef\r\n');
            expect(wrappedRows(vt)).toEqual([1]);

            // CUP to row 2 column 1, then EL 2. Row 1 is now blank, so it is nobody's tail.
            vt.write('\x1b[2;1H\x1b[2K');
            expect(rowTexts(vt)[1]).toBe('');
            expect(wrappedRows(vt)).toEqual([]);
        } finally {
            vt.free();
        }
    });

    it('keeps ESC[K at column 0 from tearing a line a progress bar redraws (§165)', async () => {
        // The deliberate NON-change, pinned because the obvious "completion" of this fix breaks
        // real programs.
        //
        // xterm.js clears its wrap flag for EL 0 when the cursor is at column 0 as well as for
        // EL 2, and an earlier draft of the wasm patch matched it. That is wrong HERE, because
        // xterm.js never reflows and this engine does: `CR` + `ESC[K` + rewrite is how a progress
        // bar, a spinner or a status line redraws the tail of a line it has already printed, and
        // when that line has soft-wrapped the row it lands on is a continuation row. Breaking the
        // backward linkage there tears the logical line PERMANENTLY on the next widen. Measured
        // on the draft: this case came back as '0123456789' + 'ABCDEF' instead of one line.
        //
        // Nothing about §165 needs it. Ink's `eraseLines()` and ratatui/crossterm's
        // `Clear(CurrentLine)` are both `ESC[2K`, which the case below covers.
        const ghostty = await loadEngine();
        const vt = ghostty.createTerminal(10, 4);
        try {
            vt.write('0123456789ABCDEF'); // wraps: '0123456789' then 'ABCDEF'
            expect(wrappedRows(vt)).toEqual([1]);

            vt.write('\r\x1b[K'); // the progress-bar idiom: CR, then erase to end of line
            vt.write('ABCDEF'); // and rewrite the tail in place
            expect(wrappedRows(vt)).toEqual([1]); // still the tail of the line above

            vt.resize(30, 4);
            expect(rowTexts(vt)).toEqual(['0123456789ABCDEF', '', '', '']);
        } finally {
            vt.free();
        }
    });

    it('clears the previous row spacer head when ESC[2K erases a wide-char continuation (§165)', async () => {
        // The other half of `Screen.cursorResetWrapFull`, on the real wasm.
        //
        // A wide character that cannot fit in the last column leaves a SPACER HEAD there and
        // wraps the character itself onto the next row. Once the linkage is broken that head has
        // no tail to point at, so it has to be cleared, exactly as upstream's `cursorResetWrap`
        // clears the one on its own row. A spacer head reads back through `getLine` as a cell
        // with `width === 0`; upstream leaves it standing after the erase.
        const ghostty = await loadEngine();
        const vt = ghostty.createTerminal(7, 4);
        try {
            vt.write('abcdef\u4e2d'); // six narrow cells, then a two-cell wide char
            expect(wrappedRows(vt)).toEqual([1]);
            expect((vt.getLine(0) ?? [])[6]?.width).toBe(0); // the spacer head

            vt.write('\x1b[2;1H\x1b[2K');
            expect(wrappedRows(vt)).toEqual([]);
            expect((vt.getLine(0) ?? [])[6]?.width).not.toBe(0); // cleared with the linkage
        } finally {
            vt.free();
        }
    });

    it('ships a wasm whose widen stacks the rows a TUI repainted while narrow, never glues them (§165)', async () => {
        // The reported symptom end to end, on the real VT: shrink, in-place repaint, widen.
        //
        // The gesture is the one every pane resize produces (a window drag, a split, the
        // inspector opening, another client taking size ownership), and the repaint is Ink's,
        // i.e. Claude Code's: `ansi-escapes`' `eraseLines(n)` is `ESC[2K` + `ESC[1A` per row and a
        // final `ESC[2K ESC[G`, then the whole frame is rewritten at the new width. Before the
        // `-nex.13` wasm patch every one of those erased rows kept the `wrap_continuation` flag
        // the shrink's reflow had put on it, so the widen's reflow appended each row's NEW,
        // unrelated contents to the row above: the reporter's screenshot, rows of 17-cell
        // fragments separated by 9-cell blank runs (the diff frame's line-number gutter) at a
        // constant 26-cell stride, which is the width the frame had been painted at.
        const ROWS = 12;
        const NARROW = 26;
        const WIDE = 190;
        const gutter = (n: number | null) => (n === null ? ' '.repeat(9) : `   ${n} +| `);

        const ghostty = await loadEngine();
        const vt = ghostty.createTerminal(WIDE, ROWS);
        try {
            // A diff frame at the wide width, each row far longer than the narrow width.
            for (let n = 73; n < 77; n += 1) vt.write(`   ${n} +| ${'x'.repeat(150)}\r\n`);
            vt.write('> \r\n');

            // The pane shrinks. Ghostty reflows: every wide row becomes several narrow rows
            // linked as continuations. This half is upstream behaviour and stays.
            vt.resize(NARROW, ROWS);
            expect(wrappedRows(vt).length).toBeGreaterThan(0);

            // The TUI answers SIGWINCH: erase the frame in place, then rewrite it at 26 columns.
            vt.write('\x1b[2K\x1b[1A'.repeat(ROWS - 1) + '\x1b[2K\x1b[G');
            const repainted: string[] = [];
            for (let n = 73; n < 77; n += 1) {
                repainted.push(`${gutter(n)}code line no ${n} co`);
                repainted.push(`${gutter(null)}ntinues here and `);
                repainted.push(`${gutter(null)}wraps at seventee`);
            }
            vt.write(`${repainted.slice(0, ROWS - 1).join('\r\n')}\r\n> `);

            // The only rows that may read as continuations now are the ones the REPAINT wrapped:
            // `   NN +| code line no NN co` is 27 cells at 26 columns, so its last cell lands on
            // the row below. Every other row was written whole and ends in a newline. Anything
            // else here is a stale flag, and the widen below is where it does its damage.
            expect(wrappedRows(vt)).toEqual([1, 5, 9]);

            // The pane widens again. Reflow rejoins the rows it genuinely wrapped and leaves the
            // rest standing: the frame comes back stacked, exactly as it was painted.
            vt.resize(WIDE, ROWS);
            expect(rowTexts(vt)).toEqual([
                '   73 +| code line no 73 co',
                '         ntinues here and',
                '         wraps at seventee',
                '   74 +| code line no 74 co',
                '         ntinues here and',
                '         wraps at seventee',
                '   75 +| code line no 75 co',
                '         ntinues here and',
                '         wraps at seventee',
                '   76 +| code line no 76 co',
                '         ntinues here and',
                '>'
            ]);

            // Said once more as the mechanism rather than as a golden frame, so a future failure
            // reads as "rows got glued" and not merely "the dump moved": nothing the repaint drew
            // was wider than 27 cells, so no row of the widened screen may be either. The defect
            // produced rows of 150+ cells built out of seven narrow rows side by side.
            for (const text of rowTexts(vt)) expect(text.length).toBeLessThanOrEqual(27);
        } finally {
            vt.free();
        }
    });
});
