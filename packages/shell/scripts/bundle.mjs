/**
 * Bundle the Electron main process into `dist/main.js`, and the packaging helpers into
 * `dist/packaging.cjs`.
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
 * ## The second output
 *
 * `dist/packaging.cjs` is `src/packaging.ts` — the app icon, the asar file filter, the Node
 * runtime checks — compiled for the *build* tools rather than the app. `forge.config.cjs` is
 * CommonJS (Forge loads it with `require`) and the build scripts are ESM, and neither can
 * import a `.ts` file; bundling it once here means both use the same TypeScript that `tsc` and
 * vitest already check, instead of a parallel JavaScript copy. It is NOT shipped: the packaged
 * `app.asar` contains `dist/main.js` only (`PACKAGED_APP_FILES`).
 *
 * Usage: `pnpm --filter @nex/shell build` (or `node scripts/bundle.mjs --watch`).
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(packageRoot, 'dist', 'main.js');
const packagingOutfile = path.join(packageRoot, 'dist', 'packaging.cjs');

/** @type {import('esbuild').BuildOptions} */
const shared = {
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

/** @type {import('esbuild').BuildOptions} */
const options = {
    ...shared,
    entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
    outfile
};

/** @type {import('esbuild').BuildOptions} */
const packagingOptions = {
    ...shared,
    entryPoints: [path.join(packageRoot, 'src', 'packaging.ts')],
    outfile: packagingOutfile,
    // A library for the build tools, not a program: keep the named exports reachable.
    sourcemap: false
};

mkdirSync(path.dirname(outfile), { recursive: true });

if (process.argv.includes('--watch')) {
    const contexts = await Promise.all([esbuild.context(options), esbuild.context(packagingOptions)]);
    await Promise.all(contexts.map((context) => context.watch()));
    process.stdout.write(`watching → ${outfile}, ${packagingOutfile}\n`);
} else {
    await esbuild.build(options);
    await esbuild.build(packagingOptions);
    process.stdout.write(`built ${outfile}\nbuilt ${packagingOutfile}\n`);
}
