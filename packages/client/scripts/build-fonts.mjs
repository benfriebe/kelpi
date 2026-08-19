#!/usr/bin/env node
/**
 * Rebuild the bundled terminal font (`src/assets/fonts/*.woff2`).
 *
 * The client ships `JetBrainsMono Nerd Font` because that is what libghostty bundles and what
 * the Swift app's terminals therefore fell back to for Powerline separators and Nerd Font
 * private-use icons. The web client has no system-font fallback chain worth relying on (Menlo
 * has none of those glyphs), so the font is a first-class asset, not a suggestion.
 *
 *   node packages/client/scripts/build-fonts.mjs --ttf-dir <dir>   # a ghostty checkout
 *   node packages/client/scripts/build-fonts.mjs --download        # Nerd Fonts release
 *
 * Conversion is a lossless TTF→WOFF2 repackaging (`wawoff2`, the Google woff2 encoder built to
 * wasm) — same glyphs, same metrics, ~60 % of the bytes. The outputs are committed; this script
 * exists so they are reproducible and their provenance is checked in rather than folklore.
 *
 * The licence (SIL OFL 1.1) is copied next to the fonts as `OFL.txt` and must stay there.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(clientRoot, 'src', 'assets', 'fonts');

/** Faces the client actually declares (`styles.css`). Italic is deliberately not bundled. */
const FACES = ['Regular', 'Bold'];

/** Where a ghostty checkout keeps the patched TTFs, relative to this repo's parent. */
const GHOSTTY_CANDIDATES = [
    path.resolve(clientRoot, '..', '..', '..', 'nex', 'ghostty', 'src', 'font', 'res'),
    path.resolve(clientRoot, '..', '..', 'ghostty', 'src', 'font', 'res')
];

const RELEASE =
    'https://github.com/ryanoasis/nerd-fonts/releases/download/v3.4.0/JetBrainsMono.zip';

function arg(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) return undefined;
    return process.argv[index + 1];
}

function resolveTtfDir() {
    const explicit = arg('--ttf-dir');
    if (explicit !== undefined) return path.resolve(explicit);
    for (const candidate of GHOSTTY_CANDIDATES) {
        if (FACES.every((face) => fs.existsSync(path.join(candidate, `JetBrainsMonoNerdFont-${face}.ttf`)))) {
            return candidate;
        }
    }
    return undefined;
}

async function loadCompressor() {
    try {
        const mod = await import('wawoff2');
        return mod.compress ?? mod.default?.compress;
    } catch {
        throw new Error(
            'wawoff2 is not installed. Run `pnpm add -D wawoff2 --filter @nex/client` (or `npm i wawoff2` in a scratch dir and re-run with --ttf-dir).'
        );
    }
}

async function main() {
    const ttfDir = resolveTtfDir();
    if (ttfDir === undefined) {
        process.stderr.write(
            `no TTFs found. Pass --ttf-dir <dir> pointing at JetBrainsMonoNerdFont-{${FACES.join(',')}}.ttf,\n` +
                `or download them from ${RELEASE} and unzip somewhere first.\n`
        );
        process.exit(1);
    }
    const compress = await loadCompressor();
    fs.mkdirSync(outDir, { recursive: true });

    for (const face of FACES) {
        const source = path.join(ttfDir, `JetBrainsMonoNerdFont-${face}.ttf`);
        if (!fs.existsSync(source)) throw new Error(`missing ${source}`);
        const target = path.join(outDir, `JetBrainsMonoNerdFont-${face}.woff2`);
        const bytes = await compress(fs.readFileSync(source));
        fs.writeFileSync(target, Buffer.from(bytes));
        process.stdout.write(
            `${path.basename(target)}  ${(fs.statSync(source).size / 1e6).toFixed(2)} MB ttf → ${(bytes.length / 1e6).toFixed(2)} MB woff2\n`
        );
    }

    const licence = path.join(ttfDir, 'OFL.txt');
    if (fs.existsSync(licence)) {
        fs.copyFileSync(licence, path.join(outDir, 'OFL.txt'));
        process.stdout.write('OFL.txt refreshed\n');
    } else if (!fs.existsSync(path.join(outDir, 'OFL.txt'))) {
        throw new Error('OFL.txt is missing next to the fonts and was not found in the source dir');
    }
}

main().catch((error) => {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    process.exit(1);
});
