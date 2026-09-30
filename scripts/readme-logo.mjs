#!/usr/bin/env node
/**
 * Export the Kelpi mark for the README, from the same code that draws the app icon, the tray
 * glyph and the favicon (`packages/core/src/icon/`). Nothing here is drawn by hand.
 *
 *     pnpm --filter @kelpi/shell build     # once: builds dist/packaging.cjs, the app icon's renderer
 *     node scripts/readme-logo.mjs         # writes docs/assets/kelpi-logo.{svg,png}
 *
 *   - `kelpi-logo.svg`  the mark as vector (`kelpieMarkSvg`): near-white line art on the
 *                       near-black tile, exactly what the daemon serves as `/favicon.svg`
 *                       but at the drawing's own stroke rather than the tab's heavier one.
 *   - `kelpi-logo.png`  the app icon at 512px (`appIconPng`, as `make-icon.mjs` writes it):
 *                       the rounded tile, rim and padding of the Dock icon. A dark tile on a
 *                       transparent ground, so it reads on GitHub's light and dark themes alike.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'docs', 'assets');
fs.mkdirSync(outDir, { recursive: true });

// The core package is TypeScript with no build of its own, so bundle its icon module on the
// fly with the esbuild the shell already depends on.
const requireFromShell = createRequire(path.join(repoRoot, 'packages', 'shell', 'package.json'));
const esbuild = requireFromShell('esbuild');
const bundled = path.join(outDir, '.icon-bundle.mjs');
await esbuild.build({
    entryPoints: [path.join(repoRoot, 'packages', 'core', 'src', 'icon', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundled,
    logLevel: 'silent'
});
let icon;
try {
    icon = await import(pathToFileURL(bundled).href);
} finally {
    fs.rmSync(bundled, { force: true });
}

const svgFile = path.join(outDir, 'kelpi-logo.svg');
fs.writeFileSync(svgFile, icon.kelpieMarkSvg());

const { loadPackagingHelpers } = await import(pathToFileURL(path.join(repoRoot, 'packages', 'shell', 'scripts', 'make-icon.mjs')).href);
const pngFile = path.join(outDir, 'kelpi-logo.png');
fs.writeFileSync(pngFile, loadPackagingHelpers().appIconPng(512));

process.stdout.write(`wrote ${path.relative(repoRoot, svgFile)}\nwrote ${path.relative(repoRoot, pngFile)}\n`);
