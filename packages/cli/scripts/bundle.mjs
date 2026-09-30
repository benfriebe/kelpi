/**
 * Bundle the CLI into a single runnable file: `dist/kelpi.js`.
 *
 * Same shape as the daemon's bundler and for the same reason: `@kelpi/protocol` publishes
 * TypeScript source through its `exports` map, so plain `tsc` output is not runnable by node.
 * esbuild resolves and inlines it, leaving one dependency-free file that can be symlinked into
 * `/usr/local/bin/kelpi` (or pointed at by `KELPI_COMPAT_CLI`).
 *
 * Contract:
 *   - platform node, format ESM, target the Node the repo pins (24);
 *   - NO external dependencies at all — the CLI must run from anywhere, including a checkout
 *     with no `node_modules` beside it;
 *   - a shebang and mode 0755, so `dist/kelpi.js` is directly executable (`spawn` finds `node`
 *     through `/usr/bin/env`, which is why the harness can exec it like the Swift binary);
 *   - `KELPI_CLI_VERSION` / `KELPI_CLI_BUILD` are read at RUNTIME (see src/version.ts), so a
 *     packaging step can stamp identity without a rebuild.
 *
 * Usage: `pnpm --filter @kelpi/cli build` (or `node scripts/bundle.mjs --watch`).
 * `--outfile <path>` writes a private copy elsewhere: the daemon's compat suite bundles its own
 * so it never reads `dist/kelpi.js` while the CLI's integration suite is rewriting it.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * `--outfile <path>`, or the default. A flag with no path after it is an error rather than a
 * silent fall back to `dist/kelpi.js`, which is exactly the file a private copy exists to avoid.
 */
function resolveOutfile(argv) {
    const index = argv.indexOf('--outfile');
    if (index < 0) return path.join(packageRoot, 'dist', 'kelpi.js');
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('-')) {
        process.stderr.write('bundle.mjs: --outfile needs a path\n');
        process.exit(1);
    }
    return path.resolve(value);
}

const outfile = resolveOutfile(process.argv);

/** @type {import('esbuild').BuildOptions} */
const options = {
    entryPoints: [path.join(packageRoot, 'src', 'main.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: [],
    banner: { js: '#!/usr/bin/env node' },
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
    chmodSync(outfile, 0o755);
    process.stdout.write(`built ${outfile}\n`);
}
