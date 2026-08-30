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
 * This is a **placeholder**, and deliberately labelled as one: a dark rounded tile with a
 * prompt chevron, a cursor bar and the green "agent running" dot. It exists so a packaged
 * build never silently ships the default Electron icon (which is what makes a build look like
 * a prototype in the Dock). Replacing it with a designed icon means dropping a real `.icns`
 * in and pointing `forge.config.cjs` at it — nothing else depends on this file's contents.
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
