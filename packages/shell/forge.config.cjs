/**
 * Electron Forge configuration — how `Nex.app` is built (M8 wave 7).
 *
 * CommonJS on purpose: this package has no `"type": "module"`, and Forge loads a `.cjs` config
 * with `require` semantics. Everything with real logic in it lives in TypeScript instead
 * (`src/packaging.ts`, `src/resources.ts`) and is reached through `dist/packaging.cjs`, so the
 * icon, the asar allowlist and the Node-runtime checks stay under `tsc` and vitest rather than
 * turning into a second, untested implementation down here.
 *
 * ## What the finished bundle looks like
 *
 *     Nex.app/Contents/
 *     ├─ MacOS/Nex                  the Electron binary, with fuses flipped (below)
 *     └─ Resources/
 *        ├─ app.asar                package.json + dist/main.js + its map, and nothing else
 *        ├─ daemon/                 nexd.js + node_modules/node-pty     ← outside the asar
 *        ├─ client/                 the built web UI                    ← outside the asar
 *        └─ node                    a Node 24 runtime for the daemon    ← outside the asar
 *
 * `src/resources.ts` is the single description of that layout: the app reads it back through
 * the same module at launch (`src/daemon.ts`), and `scripts/packaged-smoke.mjs` asserts it.
 *
 * ## Why three things sit *outside* `app.asar`
 *
 * An asar is an archive that only Electron's patched `fs` can see through. The daemon payload
 * has to be visible to a **plain `node` process** that Electron is not involved in: `node`
 * cannot execute a script inside an archive, and `dlopen` cannot load `pty.node` out of one
 * either. `extraResource` copies those three entries in beside the archive, where both the
 * bundled Node and the daemon's own `require` can reach them.
 *
 * ## Staging
 *
 * `prePackage` runs `scripts/stage-resources.mjs`, which lays out `out/staging/{daemon,client,
 * node}` (+ `icon.icns`). Packaging then just copies. The build inputs — the daemon bundle, the
 * client `vite build`, this package's own `dist/` — are NOT built here: `pnpm dist` at the repo
 * root builds all three first, and a missing one fails loudly with the command that fixes it
 * rather than silently packaging something stale.
 *
 * ## Signing
 *
 * Nothing here is signed or notarized by default; there is no `osxSign`/`osxNotarize` block, so
 * `pnpm dist` produces an ad-hoc-signed (arm64 requirement) app that Gatekeeper will quarantine
 * on any machine that did not build it. That gap, and the checklist for closing it, are written
 * down in the repo README ("Signing and notarization"). Setting `NEX_MACOS_IDENTITY` opts into
 * `osxSign` with that identity — the first half of the checklist, untested until someone with a
 * Developer ID runs it.
 */

const fs = require('node:fs');
const path = require('node:path');

const { MakerDMG } = require('@electron-forge/maker-dmg');
const { MakerZIP } = require('@electron-forge/maker-zip');
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

const packageRoot = __dirname;
/** Where `scripts/stage-resources.mjs` writes; inside `out/`, so it is gitignored and swept. */
const stagingDir = path.join(packageRoot, 'out', 'staging');
const iconFile = path.join(stagingDir, 'icon.icns');

/**
 * The three `Contents/Resources` entries, as *basenames* — `extraResource` copies each path to
 * `Contents/Resources/<basename>`. Restated here rather than imported because a Forge config is
 * evaluated before anything is built; `prePackage` asserts they still match the TypeScript
 * (`RESOURCE_NAMES`), so the two cannot drift silently.
 */
const RESOURCE_DIRS = ['daemon', 'client', 'node'];

/** `dist/packaging.cjs`, with a repair hint instead of a bare MODULE_NOT_FOUND. */
function packagingHelpers() {
    const compiled = path.join(packageRoot, 'dist', 'packaging.cjs');
    try {
        return require(compiled);
    } catch (error) {
        throw new Error(
            `the shell is not built (${compiled} is missing). Run \`pnpm --filter @nex/shell build\`,` +
                ' or `pnpm dist` from the repo root to build every package and package the app.' +
                `\n  cause: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function assertBuilt() {
    const main = path.join(packageRoot, 'dist', 'main.js');
    if (!fs.existsSync(main)) {
        throw new Error(`the shell bundle is missing (${main}). Run \`pnpm --filter @nex/shell build\`.`);
    }
}

/** Ad-hoc by default; an identity in the environment opts into a real signature. */
const signingIdentity = (process.env['NEX_MACOS_IDENTITY'] ?? '').trim();

/**
 * Cookie encryption travels with the signature — see `cookieEncryptionFuseEnabled` in
 * `src/packaging.ts` for the whole story. Short version: the fuse makes Chromium fetch a key
 * from the login keychain before the network service will serve anything, and on an
 * ad-hoc-signed build (or any launch without an unlocked keychain) that call blocks on an
 * authorization dialog nobody can answer — the window then never loads, with no error at all.
 */
const cookieEncryption = packagingHelpers().cookieEncryptionFuseEnabled(signingIdentity);

module.exports = {
    packagerConfig: {
        // `productName` in package.json names the bundle (`Nex.app`); this is the id that keeps
        // it distinct from the shipped Swift app (`com.benfriebe.nex`) so both can be installed
        // at once during the port. Taking over the original id is a release-checklist item.
        appBundleId: 'com.benfriebe.newnex',
        appCategoryType: 'public.app-category.developer-tools',
        icon: iconFile,
        asar: true,
        extraResource: RESOURCE_DIRS.map((name) => path.join(stagingDir, name)),
        /**
         * An allowlist (`PACKAGED_APP_FILES`): package.json + the bundle + its sourcemap. The
         * shell is a single esbuild bundle, so `node_modules/` in the archive would only add
         * Electron's own ~250 MB copy and esbuild's binary.
         */
        ignore: (file) => packagingHelpers().packagedAppIgnore(file),
        // Nothing to prune: `ignore` already names every file that ships, and pruning would
        // walk a `node_modules` tree that was never copied.
        prune: false,
        // pnpm's store is a forest of symlinks; an app bundle must carry real files.
        derefSymlinks: true,
        overwrite: true,
        ...(signingIdentity.length > 0 ? { osxSign: { identity: signingIdentity } } : {})
    },

    // stack.md §2: "keep *all* native modules out of the shell" — node-pty lives in the daemon,
    // under plain Node, and is never rebuilt against Electron's ABI.
    rebuildConfig: { onlyModules: [] },

    makers: [
        // ZIP is what Squirrel.Mac consumes, so it stays the primary artifact even while
        // auto-update is off (src/updater.ts).
        new MakerZIP({}, ['darwin']),
        new MakerDMG(
            {
                name: 'Nex',
                icon: iconFile,
                overwrite: true,
                // LZFSE: smaller and much faster to produce than UDZO on Apple Silicon.
                format: 'ULFO'
            },
            ['darwin']
        )
    ],

    plugins: [
        /**
         * Fuses (stack.md §1). These are flipped in the Electron binary itself, so they hold
         * even if someone repackages the app directory by hand.
         *
         * `RunAsNode: false` is the load-bearing one here: it disables `ELECTRON_RUN_AS_NODE`,
         * which is exactly the daemon-runtime option stack.md tells us not to take. The daemon
         * runs under `Contents/Resources/node` instead, so nothing in this app needs it.
         */
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: cookieEncryption,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true
        })
    ],

    hooks: {
        /** Build the `Contents/Resources` payload that `extraResource` above will copy. */
        async prePackage(_forgeConfig, platform, arch) {
            assertBuilt();
            const { RESOURCE_NAMES } = packagingHelpers();
            const expected = [RESOURCE_NAMES.daemon, RESOURCE_NAMES.client, RESOURCE_NAMES.node];
            if (expected.join(',') !== RESOURCE_DIRS.join(',')) {
                throw new Error(
                    `forge.config.cjs stages [${RESOURCE_DIRS.join(', ')}] but src/resources.ts names ` +
                        `[${expected.join(', ')}] — update this config to match.`
                );
            }

            const { stageResources } = await import('./scripts/stage-resources.mjs');
            const staged = stageResources({ stagingDir, platform, arch });
            process.stdout.write(
                `\n  staged for ${platform}/${arch}: daemon + client + node ${staged.node.version} ` +
                    `(${staged.node.arch}, from ${staged.node.source})\n`
            );
        },

        /**
         * Fail the build — rather than the app's first launch — if the payload did not land.
         * An `extraResource` typo is invisible until the daemon cannot be found, which is a
         * dialog on someone else's machine three steps later.
         */
        async postPackage(_forgeConfig, result) {
            const { RESOURCE_NAMES } = packagingHelpers();
            for (const appPath of result.outputPaths) {
                const resources = path.join(appPath, 'Nex.app', 'Contents', 'Resources');
                if (!fs.existsSync(resources)) continue; // non-darwin layout; nothing to check
                const required = [
                    path.join(resources, 'app.asar'),
                    path.join(resources, RESOURCE_NAMES.daemon, 'nexd.js'),
                    path.join(resources, RESOURCE_NAMES.daemon, 'node_modules', 'node-pty', 'package.json'),
                    path.join(resources, RESOURCE_NAMES.client, 'index.html'),
                    path.join(resources, RESOURCE_NAMES.node)
                ];
                const missing = required.filter((file) => !fs.existsSync(file));
                if (missing.length > 0) {
                    throw new Error(`packaged app is incomplete — missing:\n  ${missing.join('\n  ')}`);
                }
                fs.accessSync(path.join(resources, RESOURCE_NAMES.node), fs.constants.X_OK);
                process.stdout.write(`\n  packaged ${path.join(appPath, 'Nex.app')}\n`);
            }
        }
    }
};
