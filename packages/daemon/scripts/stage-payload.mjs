#!/usr/bin/env node
/**
 * Stage the daemon's *runtime payload* — everything a packaged app has to carry so that a
 * detached `kelpid` can run from inside an application bundle instead of from the workspace.
 *
 * `scripts/bundle.mjs` produces one file (`dist/kelpid.js`) plus one unbundled native module
 * (node-pty, which cannot be inlined). This script lays those two things out in the shape the
 * shell's packaged lookup expects, so the Electron package step only has to copy one directory
 * into `Contents/Resources/daemon`:
 *
 *     <outDir>/
 *     ├─ kelpid.js                                    the esbuild bundle (mode 0755)
 *     ├─ kelpid.js.map                                its sourcemap (stack traces from a shipped app)
 *     ├─ payload.json                               manifest: what was staged, and from where
 *     └─ node_modules/
 *        └─ node-pty/
 *           ├─ package.json                         `main: ./lib/index.js`
 *           ├─ LICENSE
 *           ├─ lib/                                 the JS half
 *           └─ prebuilds/<platform>-<arch>/         pty.node + spawn-helper (the native half)
 *
 * ## Why exactly that layout (the resolution chain, verified against node-pty 1.1.0)
 *
 * 1. `dist/kelpid.js` is an ES module whose banner builds `require` from
 *    `createRequire(import.meta.url)`; `src/pty/spawner.ts` calls `require('node-pty')` lazily
 *    on first spawn. CJS resolution walks up from the *importing file*, so from
 *    `<outDir>/kelpid.js` the first candidate is `<outDir>/node_modules/node-pty` — which is why
 *    `node_modules/` sits beside the bundle rather than anywhere else.
 * 2. node-pty's `lib/utils.js` `loadNativeModule('pty')` walks `build/Release`, `build/Debug`,
 *    `prebuilds/${process.platform}-${process.arch}` — each tried relative to `lib/`'s parent
 *    and then to `lib/` itself — and `require`s `<dir>/pty.node`. The published package has no
 *    `build/`, so the hit is `<pkg>/prebuilds/darwin-arm64/pty.node`.
 * 3. `lib/unixTerminal.js` then derives the fork helper from whichever directory answered:
 *    `path.resolve(__dirname, native.dir + '/spawn-helper')` →
 *    `<pkg>/prebuilds/darwin-arm64/spawn-helper`, which must stay **executable**.
 *
 * Only the target platform+arch prebuild is staged: the published package carries four
 * (darwin-arm64, darwin-x64, win32-arm64, win32-x64) plus C++ sources and vendored deps, ~62 MB
 * in total, of which ~130 KB is actually loaded at runtime.
 *
 * ## Usage
 *
 *     node scripts/stage-payload.mjs --out <dir> [--platform darwin] [--arch arm64] [--clean]
 *
 * or programmatically (this is what the shell's Forge config does, via a child process, so the
 * ESM/CJS boundary between the two packages never has to be crossed):
 *
 *     import { stageDaemonPayload } from '@kelpi/daemon/scripts/stage-payload.mjs';
 *
 * It refuses to run when `dist/kelpid.js` is missing — build the bundle first
 * (`pnpm --filter @kelpi/daemon build`), because a payload staged from a stale or absent bundle
 * is the kind of thing that only shows up as a broken app three steps later.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The bundle + sourcemap `scripts/bundle.mjs` writes. */
export const BUNDLE_NAME = 'kelpid.js';
export const SOURCEMAP_NAME = 'kelpid.js.map';
/** Written next to the payload so a packaged app can be inspected without guessing. */
export const MANIFEST_NAME = 'payload.json';

/**
 * The subset of the node-pty package that is reachable at runtime. Everything else it publishes
 * (`src/`, `deps/`, `third_party/`, `scripts/`, `binding.gyp`, the other platforms' prebuilds)
 * is build input, not runtime input.
 */
export const NODE_PTY_FILES = ['package.json', 'LICENSE'];
export const NODE_PTY_DIRS = ['lib'];

/** `prebuilds/<platform>-<arch>` — the directory node-pty's own loader computes. */
export function prebuildDirName(platform = process.platform, arch = process.arch) {
    return `${platform}-${arch}`;
}

/** Resolve the installed node-pty package root (works through pnpm's symlinked store). */
export function resolveNodePtyRoot() {
    return path.dirname(require.resolve('node-pty/package.json'));
}

function copyFileIfPresent(from, to) {
    if (!existsSync(from)) return false;
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { dereference: true });
    return true;
}

/**
 * Copy the runtime half of node-pty into `<outDir>/node_modules/node-pty`.
 *
 * `dereference: true` matters: in a pnpm workspace the package directory is a symlink into the
 * content-addressed store, and an app bundle that carries symlinks into `~/Library/pnpm` is not
 * an app bundle, it is a time bomb.
 */
export function stageNodePty({ outDir, platform = process.platform, arch = process.arch, sourceDir } = {}) {
    const source = sourceDir ?? resolveNodePtyRoot();
    const target = path.join(outDir, 'node_modules', 'node-pty');
    mkdirSync(target, { recursive: true });

    const copied = [];
    for (const file of NODE_PTY_FILES) {
        if (copyFileIfPresent(path.join(source, file), path.join(target, file))) copied.push(file);
    }
    for (const dir of NODE_PTY_DIRS) {
        const from = path.join(source, dir);
        if (!existsSync(from)) continue;
        cpSync(from, path.join(target, dir), { recursive: true, dereference: true });
        copied.push(`${dir}/`);
    }

    const prebuild = prebuildDirName(platform, arch);
    const prebuildSource = path.join(source, 'prebuilds', prebuild);
    if (!existsSync(prebuildSource)) {
        throw new Error(
            `node-pty has no prebuild for ${prebuild} at ${prebuildSource}. ` +
                `Available: ${listPrebuilds(source).join(', ') || '(none)'}`
        );
    }
    const prebuildTarget = path.join(target, 'prebuilds', prebuild);
    cpSync(prebuildSource, prebuildTarget, { recursive: true, dereference: true });
    copied.push(`prebuilds/${prebuild}/`);

    // `cpSync` preserves the mode, but the fork helper is the one file where losing +x turns
    // into "every PTY spawn fails" rather than a build error, so make it explicit.
    const helper = path.join(prebuildTarget, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);

    const version = readJson(path.join(source, 'package.json'))?.version;
    return {
        target,
        source,
        prebuild,
        copied,
        ...(version === undefined ? {} : { version }),
        // The path node-pty's loader will compute at runtime, recorded so the packaged smoke
        // can assert the exact file rather than "something under prebuilds".
        nativeModule: path.join(prebuildTarget, 'pty.node'),
        spawnHelper: helper
    };
}

function listPrebuilds(source) {
    const dir = path.join(source, 'prebuilds');
    if (!existsSync(dir)) return [];
    try {
        return require('node:fs').readdirSync(dir);
    } catch {
        return [];
    }
}

function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return undefined;
    }
}

/**
 * Stage the whole payload. Returns a manifest describing what landed where; the same object is
 * written to `<outDir>/payload.json`.
 */
export function stageDaemonPayload({
    outDir,
    platform = process.platform,
    arch = process.arch,
    clean = true,
    distDir = path.join(packageRoot, 'dist')
} = {}) {
    if (outDir === undefined || outDir.length === 0) throw new Error('stageDaemonPayload: outDir is required');
    const target = path.resolve(outDir);

    const bundle = path.join(distDir, BUNDLE_NAME);
    if (!existsSync(bundle)) {
        throw new Error(
            `daemon bundle not found at ${bundle} — run \`pnpm --filter @kelpi/daemon build\` before staging the payload`
        );
    }

    if (clean) rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });

    cpSync(bundle, path.join(target, BUNDLE_NAME), { dereference: true });
    chmodSync(path.join(target, BUNDLE_NAME), 0o755);
    const sourcemap = copyFileIfPresent(path.join(distDir, SOURCEMAP_NAME), path.join(target, SOURCEMAP_NAME));

    const nodePty = stageNodePty({ outDir: target, platform, arch });

    const manifest = {
        staged_at: new Date().toISOString(),
        platform,
        arch,
        entry: BUNDLE_NAME,
        entry_bytes: statSync(path.join(target, BUNDLE_NAME)).size,
        sourcemap,
        node_pty: {
            ...(nodePty.version === undefined ? {} : { version: nodePty.version }),
            prebuild: nodePty.prebuild,
            // Relative so the manifest stays meaningful once the directory is copied into an
            // app bundle (the absolute build-machine paths would be noise).
            native_module: path.relative(target, nodePty.nativeModule),
            spawn_helper: path.relative(target, nodePty.spawnHelper),
            resolved_from: 'require("node-pty") in kelpid.js → <payload>/node_modules/node-pty'
        }
    };
    writeFileSync(path.join(target, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);

    return { ...manifest, dir: target, nodePtyDir: nodePty.target };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const options = { clean: true };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => argv[(index += 1)];
        switch (arg) {
            case '--out':
            case '-o':
                options.outDir = next();
                break;
            case '--platform':
                options.platform = next();
                break;
            case '--arch':
                options.arch = next();
                break;
            case '--no-clean':
                options.clean = false;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                throw new Error(`unknown argument: ${arg}`);
        }
    }
    return options;
}

const USAGE = `stage-payload — lay out the daemon's runtime payload for packaging

  node scripts/stage-payload.mjs --out <dir> [--platform darwin] [--arch arm64] [--no-clean]

Writes <dir>/kelpid.js (+ .map), <dir>/node_modules/node-pty (JS + the one prebuild that
platform/arch needs) and <dir>/payload.json. Build the bundle first:

  pnpm --filter @kelpi/daemon build
`;

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help === true || options.outDir === undefined) {
            process.stdout.write(USAGE);
            process.exit(options.help === true ? 0 : 1);
        }
        const manifest = stageDaemonPayload(options);
        process.stdout.write(
            `staged daemon payload → ${manifest.dir}\n` +
                `  kelpid.js         ${String(manifest.entry_bytes)} bytes${manifest.sourcemap ? ' (+ sourcemap)' : ''}\n` +
                `  node-pty        ${manifest.node_pty.version ?? '?'} — ${manifest.node_pty.native_module}\n`
        );
    } catch (error) {
        process.stderr.write(`stage-payload: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
}
