#!/usr/bin/env node
/**
 * Generate the app icon — a real `.icns`, produced in code.
 *
 * The shell already draws its tray glyph rather than shipping binary assets (`src/icon.ts`),
 * and the app icon follows the same rule for the same reasons: no PNGs to keep in sync with a
 * design file, no `iconutil`/`sips` dependency in the build, no binary blob in git, and the
 * icon can be re-rendered at any size from one description. The drawing and the ICNS container
 * live in `src/packaging.ts` (TypeScript, unit-tested); this script is just the file writer.
 *
 * It also writes a 512px PNG beside the `.icns` — handy for a README, a DMG background, or a
 * quick look at what changed without opening the icns.
 *
 *     node scripts/make-icon.mjs [--out <dir>]        # default: out/staging
 *
 * The drawing is the designed Kelpi mark: the kelpie head from `@kelpi/core`'s
 * `assets/kelpi-icon.svg`, white line art on a near-black rounded tile. The SVG is the
 * editable source; its path data is restated in `@kelpi/core/icon` (a unit test keeps the copy
 * honest) and stroked by the rasteriser in `src/packaging.ts`, so the icon is still rendered
 * rather than shipped as a binary. To change the icon, edit the SVG and re-extract the data
 * module. The mark lives in core because the web client's favicon draws it too.
 */

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);

/** Built by `scripts/bundle.mjs`; see its header for why the helpers are compiled once. */
export function loadPackagingHelpers() {
    const compiled = path.join(packageRoot, 'dist', 'packaging.cjs');
    try {
        return require(compiled);
    } catch (error) {
        throw new Error(
            `packaging helpers are not built (${compiled}). Run \`pnpm --filter @kelpi/shell build\` first.` +
                `\n  cause: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

export const DEFAULT_ICON_DIR = path.join(packageRoot, 'out', 'staging');

/** Write `<outDir>/icon.icns` (+ `icon.png`); returns both paths. */
export function writeAppIcon(outDir = DEFAULT_ICON_DIR) {
    const { buildAppIcns, appIconPng } = loadPackagingHelpers();
    mkdirSync(outDir, { recursive: true });
    const icns = path.join(outDir, 'icon.icns');
    const png = path.join(outDir, 'icon.png');
    writeFileSync(icns, buildAppIcns());
    writeFileSync(png, appIconPng(512));
    return { icns, png };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    const argv = process.argv.slice(2);
    const outIndex = argv.indexOf('--out');
    const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined;
    try {
        const written = writeAppIcon(outDir === undefined ? DEFAULT_ICON_DIR : path.resolve(outDir));
        process.stdout.write(`wrote ${written.icns}\nwrote ${written.png}\n`);
    } catch (error) {
        process.stderr.write(`make-icon: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
}
