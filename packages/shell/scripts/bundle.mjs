/**
 * Bundle the Electron main process into `dist/main.js`.
 *
 * Same reasoning as the daemon's bundler: `@nex/core`, `@nex/protocol` and `@nex/daemon`
 * publish TypeScript source through their `exports` maps (they are workspace-internal), so
 * plain `tsc` output would not be runnable — esbuild resolves and inlines them.
 *
 * Contract:
 *   - **CJS**, not ESM. Electron's main process supports ESM, but CJS is the format every
 *     Electron version and every packaging tool handles without caveats, and this file has no
 *     top-level await. `dist/main.js` is what `package.json` `main` points at.
 *   - `electron` stays external: it is provided by the runtime, not npm.
 *   - `ws` and the workspace packages are inlined, so `dist/` plus Electron is self-contained.
 *     No native modules are bundled — node-pty lives in the daemon process, never here
 *     (docs/research/stack.md §2: "keep *all* native modules out of the shell").
 *
 * Usage: `pnpm --filter @nex/shell build` (or `node scripts/bundle.mjs --watch`).
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(packageRoot, 'dist', 'main.js');

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Electron 43 ships Node 24; matching it keeps the output free of pointless downleveling.
    target: 'node24',
    external: ['electron'],
    sourcemap: 'linked',
    logLevel: 'info',
    keepNames: true,
    minify: false
};

mkdirSync(path.dirname(outfile), { recursive: true });

if (process.argv.includes('--watch')) {
    const context = await esbuild.context(options);
    await context.watch();
    process.stdout.write(`watching → ${outfile}\n`);
} else {
    await esbuild.build(options);
    process.stdout.write(`built ${outfile}\n`);
}
