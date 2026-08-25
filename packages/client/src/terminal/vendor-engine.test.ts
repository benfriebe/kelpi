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
const EXPECTED_VERSION = '0.4.0-nex.4';

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
    });
});
