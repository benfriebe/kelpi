/**
 * Bundle the daemon into a single runnable file: `dist/nexd.js`.
 *
 * Why a bundle at all: `@nex/core` and `@nex/protocol` publish TypeScript source through their
 * `exports` map (they are workspace-internal), so plain `tsc` output is not runnable by node —
 * esbuild resolves and inlines them. The result is one file plus one native dependency, which
 * is also what ships inside the app bundle.
 *
 * Contract:
 *   - platform node, format ESM, target the Node the repo pins (24);
 *   - `node-pty` stays EXTERNAL: it is a native module and cannot be inlined. The daemon
 *     `createRequire`s it lazily, so the bundle must be able to resolve it at runtime —
 *     ship `node_modules/node-pty` beside `dist/`, or run from the workspace;
 *   - a CJS-compat banner, because bundled dependencies (xterm's headless build, ws) reference
 *     `require` / `__dirname` / `__filename`, none of which exist in an ES module;
 *   - a shebang and mode 0755, so `dist/nexd.js` is directly executable.
 *
 * Usage: `pnpm --filter @nex/daemon build` (or `node scripts/bundle.mjs --watch`).
 */

import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(packageRoot, 'dist', 'nexd.js');

const banner = `#!/usr/bin/env node
import { createRequire as __nexdCreateRequire } from 'node:module';
import { fileURLToPath as __nexdFileURLToPath } from 'node:url';
import { dirname as __nexdDirname } from 'node:path';
const require = __nexdCreateRequire(import.meta.url);
const __filename = __nexdFileURLToPath(import.meta.url);
const __dirname = __nexdDirname(__filename);
`;

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    // node-pty is the only native dependency; everything else is inlined.
    external: ['node-pty'],
    banner: { js: banner },
    sourcemap: 'linked',
    logLevel: 'info',
    // Keep names so stack traces from a shipped daemon stay readable.
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
    chmodSync(outfile, 0o755);
    process.stdout.write(`built ${outfile}\n`);
}
