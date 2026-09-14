#!/usr/bin/env node
/**
 * Rebuild `vendor/ghostty-web-patched/dist` from the tracked source snapshot and the tracked WASM.
 *
 * WHY THIS EXISTS (#6)
 * --------------------
 * The bundle under `vendor/ghostty-web-patched/dist` is what `packages/client` imports as
 * `ghostty-web`, and it is TRACKED (see the negation in `.gitignore`), so a fresh clone needs
 * nothing but `pnpm install --frozen-lockfile`. This script is how that tracked artifact is
 * regenerated whenever `vendor/ghostty-web-patched/source/` or `ghostty-vt.wasm` changes. Until it
 * existed, the recipe was a shell block in PROVENANCE.md that people hand-ran (or skipped, and then
 * lost an hour to `TS2307: Cannot find module 'ghostty-web'`).
 *
 * WHAT IS DELICATE ABOUT IT
 * -------------------------
 * 1. The WASM has to be STAGED at the build root before vite runs. `source/lib/ghostty.ts` resolves
 *    the engine with `new URL('../ghostty-vt.wasm', import.meta.url)`, which from `lib/` is the
 *    build root; the vendoring moved the file up to the package root instead, so a build tree
 *    without the staged copy leaves that URL unresolved. Vite's library mode then degrades
 *    `import.meta.url` to `self.location`, the engine FETCHES `/ghostty-vt.wasm` at runtime, the
 *    daemon's SPA fallback answers with `index.html`, and `WebAssembly.compile` reports
 *    `expected magic word 00 61 73 6d, found 3c 21 64 6f` (that is ASCII `<!do`). With the file
 *    staged, vite inlines it as a `data:application/wasm;base64,…` URI, which is what
 *    `packages/client/src/terminal/vendor-engine.test.ts` asserts the bundle ships.
 * 2. The build runs OUTSIDE the checkout, in a scratch directory, with `--ignore-workspace`. The
 *    snapshot's own toolchain (vite 4, vite-plugin-dts) is not in this repo's lockfile and must not
 *    join it; an in-tree build picks up the monorepo workspace and resolves the wrong versions.
 * 3. Nothing is published into `vendor/` until the built bundles are proved to carry the tracked
 *    WASM inline. Shipping a rebuilt WASM behind a stale dist leaves every test green and the app
 *    unchanged, which is exactly how #165 was first "fixed".
 * 4. The final `pnpm install` is part of the build, not an afterthought. pnpm materialises the
 *    `file:` override as a COPY under `node_modules/.pnpm/ghostty-web@file+vendor+…`, so a new
 *    bundle is invisible to `pnpm typecheck` and to vitest until an install re-copies it.
 *
 * USAGE
 *   pnpm vendor:build                  # rebuild, verify, publish, reinstall
 *   pnpm vendor:build -- --keep        # keep the scratch build directory for inspection
 *   pnpm vendor:build -- --no-install  # skip the workspace reinstall (the tree is then stale)
 *
 * Afterwards, run the guards that read the artifact:
 *   pnpm vitest run packages/client/src/terminal/vendor-engine.test.ts
 * They pin the version PROVENANCE.md documents and the behaviour markers of every `-nex` patch, so
 * a rebuild that quietly dropped one fails there rather than in a terminal pane.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(repoRoot, 'vendor', 'ghostty-web-patched');
const sourceDir = path.join(vendorRoot, 'source');
const wasmFile = path.join(vendorRoot, 'ghostty-vt.wasm');
const distDir = path.join(vendorRoot, 'dist');

/** Both bundles vite emits, and the two files the package's `exports` map points at. */
const BUNDLES = ['ghostty-web.js', 'ghostty-web.umd.cjs'];

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const run = (command, args, cwd) => {
    console.log(`[vendor:build] ${command} ${args.join(' ')}  (in ${cwd})`);
    execFileSync(command, args, { cwd, stdio: 'inherit' });
};

/**
 * The WASM a built bundle will actually run, pulled back out of the bundle.
 *
 * `Ghostty.load()` tries the inlined data URI first and only then a `.wasm` on disk, and the client
 * build emits no `.wasm` asset at all, so the bundle IS the engine and the file beside it is
 * decoration. Anything that checks the file instead of the bundle checks the wrong artifact.
 */
export function inlinedWasm(bundleFile) {
    const bundle = fs.readFileSync(bundleFile, 'utf8');
    const base64 = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/.exec(bundle)?.[1];
    if (base64 === undefined) {
        throw new Error(
            `${bundleFile} carries no inlined wasm data URI.\n` +
                'The staged ghostty-vt.wasm was not resolved at build time, so the engine would ' +
                'fetch it at runtime and receive the SPA fallback instead. See this file\'s header.'
        );
    }
    return Buffer.from(base64, 'base64');
}

/** Throw unless every bundle in `dir` inlines exactly the WASM this repo tracks. */
export function assertBundlesCarryTrackedWasm(dir, expected) {
    for (const bundle of BUNDLES) {
        const found = sha256(inlinedWasm(path.join(dir, bundle)));
        if (found !== expected) {
            throw new Error(
                `${path.join(dir, bundle)} inlines a different engine than ` +
                    `vendor/ghostty-web-patched/ghostty-vt.wasm\n  expected ${expected}\n  found    ${found}`
            );
        }
    }
}

export function buildVendorEngine({ keep = false, install = true } = {}) {
    if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
        throw new Error(`no source snapshot at ${sourceDir}`);
    }
    const trackedWasm = sha256(fs.readFileSync(wasmFile));
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-ghostty-'));
    console.log(`[vendor:build] build directory: ${scratch}`);
    console.log(`[vendor:build] tracked ghostty-vt.wasm: sha256 ${trackedWasm}`);

    try {
        fs.cpSync(sourceDir, scratch, { recursive: true });
        // (1) in the header: staged at the build root so vite inlines it rather than fetching it.
        fs.copyFileSync(wasmFile, path.join(scratch, 'ghostty-vt.wasm'));

        // (2) in the header: the snapshot resolves its own toolchain, outside this workspace.
        run('pnpm', ['install', '--ignore-workspace'], scratch);
        run('pnpm', ['exec', 'vite', 'build'], scratch);

        const built = path.join(scratch, 'dist');
        // Upstream's own `build:wasm-copy` step. Nothing in this repo loads it (the bundle inlines
        // its engine), but the package's `files` list ships it, so the artifact stays complete.
        fs.copyFileSync(wasmFile, path.join(built, 'ghostty-vt.wasm'));

        // (3) in the header: verify BEFORE publishing, so a bad build never reaches the tree.
        assertBundlesCarryTrackedWasm(built, trackedWasm);

        fs.rmSync(distDir, { recursive: true, force: true });
        fs.cpSync(built, distDir, { recursive: true });
        for (const bundle of BUNDLES) {
            const { size } = fs.statSync(path.join(distDir, bundle));
            console.log(`[vendor:build] ${bundle}: ${(size / 1000).toFixed(2)} kB`);
        }
        console.log(`[vendor:build] published ${path.relative(repoRoot, distDir)}`);
    } finally {
        if (keep) console.log(`[vendor:build] keeping ${scratch}`);
        else fs.rmSync(scratch, { recursive: true, force: true });
    }

    if (!install) {
        console.log(
            '[vendor:build] --no-install: run `pnpm install --frozen-lockfile` before typechecking ' +
                'or testing, or the workspace keeps importing the previous bundle.'
        );
        return;
    }

    // (4) in the header: pnpm copies the `file:` dependency, so the install is what publishes the
    // new bundle to everything that imports `ghostty-web`.
    run('pnpm', ['install', '--frozen-lockfile'], repoRoot);
    const installed = path.join(repoRoot, 'packages', 'client', 'node_modules', 'ghostty-web', 'dist');
    assertBundlesCarryTrackedWasm(installed, trackedWasm);
    console.log('[vendor:build] installed copy carries the same engine; the workspace is current.');
}

// ── cli ─────────────────────────────────────────────────────────────────────────────

if (process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log('usage: node scripts/build-vendor-engine.mjs [--keep] [--no-install]');
        process.exit(0);
    }
    try {
        buildVendorEngine({ keep: argv.includes('--keep'), install: !argv.includes('--no-install') });
    } catch (error) {
        console.error(`[vendor:build] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
