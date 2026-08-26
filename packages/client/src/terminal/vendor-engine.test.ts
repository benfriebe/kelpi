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
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const vendorRoot = path.join(repoRoot, 'vendor', 'ghostty-web-patched');

/** The version the audit evidence and PROVENANCE.md were written against. */
const EXPECTED_VERSION = '0.4.0-nex.7';

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
const EMPTY_WRITE_MARKERS = ['B.length === 0', 'ghostty_wasm_alloc_u8_array(B.length)'];

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
        for (const marker of EMPTY_WRITE_MARKERS) {
            expect(bundle).toContain(marker);
        }
        // The guard has to come BEFORE the allocation it protects, or it protects nothing.
        expect(bundle.indexOf(EMPTY_WRITE_MARKERS[0] as string)).toBeLessThan(
            bundle.indexOf(EMPTY_WRITE_MARKERS[1] as string)
        );
    });

    it('ships a bundle that can suspend its paint, guarded before the first cell read (§N24)', () => {
        const bundle = read(path.join(vendorRoot, 'dist', 'ghostty-web.js'));
        for (const marker of PAINT_SUSPEND_MARKERS) {
            expect(bundle).toContain(marker);
        }
        expect(bundle).toMatch(PAINT_SUSPEND_GUARD);
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
    });
});
