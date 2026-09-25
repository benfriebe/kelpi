/**
 * Build-time packaging helpers (M8 wave 7).
 *
 * Everything here runs on the *build* machine, never in the shipped app: the app icon (drawn
 * and encoded in code, like `icon.ts` does for the tray), the filter that decides what goes
 * into `app.asar`, and the checks on the Node runtime that gets bundled beside the daemon.
 *
 * It lives in `src/` rather than `scripts/` for one reason: this is the part of packaging with
 * real logic in it — an ICNS container, an SDF rasteriser, a path filter — and putting it in
 * TypeScript puts it under `tsc` and under vitest, which a `.mjs` build script would not be.
 * `scripts/bundle.mjs` emits a CJS copy at `dist/packaging.cjs` so `forge.config.cjs` and
 * `scripts/make-icon.mjs` can use exactly this code instead of a second implementation.
 *
 * Nothing here imports Electron.
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { stampKelpie } from '@kelpi/core/icon';
import { encodePng } from '@kelpi/core/icon/png';
import { RESOURCE_NAMES } from './resources.js';

export { RESOURCE_NAMES } from './resources.js';

type Rgba = readonly [number, number, number, number];

// ── what goes into app.asar ─────────────────────────────────────────────────────────

/**
 * The complete contents of the packaged `app.asar`.
 *
 * The shell is a single esbuild bundle: `dist/main.js` inlines `ws` and the three workspace
 * packages, and `electron` comes from the runtime. So the app directory needs the bundle, its
 * sourcemap (so a crash report from a shipped build is readable) and the `package.json` that
 * names the entry point — and nothing else. Shipping `node_modules/` would drag Electron's own
 * ~250 MB download and esbuild's binary into the archive for no reason, and shipping `src/`
 * would ship the sources twice.
 */
export const PACKAGED_APP_FILES: readonly string[] = ['/package.json', '/dist/main.js', '/dist/main.js.map'];

/**
 * `@electron/packager`'s `ignore` predicate: it is called with every path relative to the app
 * directory, POSIX-separated and leading-slashed (the root itself is the empty string), and
 * **true means leave it out**.
 *
 * An allowlist, not a denylist: a new top-level directory in this package (fixtures, docs, a
 * second build output) must not silently start shipping.
 */
export function packagedAppIgnore(file: string): boolean {
    if (file === '' || file === '/') return false;
    // Directories on the path to a kept file have to be walked into.
    if (PACKAGED_APP_FILES.some((kept) => kept === file || kept.startsWith(`${file}/`))) return false;
    return true;
}

// ── the CLI launcher ────────────────────────────────────────────────────────────────

/**
 * Grep-able proof that a file at `/usr/local/bin/kelpi` came from a Kelpi app bundle.
 *
 * The Swift `CLIInstallService` answered "is this ours?" with a code-signature Team ID. This
 * build is not necessarily signed at all (`isSignedBuild`), so attribution uses a marker the
 * launcher carries in its own text instead — see `src/cli-install.ts` for the full rule and why
 * it is deliberately *more* conservative than the Swift check.
 */
export const CLI_LAUNCHER_MARKER = 'nex-cli-launcher';

/**
 * The POSIX-sh launcher staged as `Contents/Resources/cli/kelpi`.
 *
 * `/usr/local/bin/kelpi` is a symlink to this file, so the first thing it has to do is walk back
 * through that symlink to find the directory it really lives in — `$0` is the *link's* path, and
 * `dirname "$0"` would say `/usr/local/bin`, where there is no bundle to run.
 *
 * Having found itself, it prefers the app's own bundled Node over whatever `PATH` offers. That
 * is the difference between a CLI that works on any Mac and one that works only where someone
 * has installed Node: the hooks Claude Code fires run in a non-interactive shell with a minimal
 * `PATH`, which is exactly where a `#!/usr/bin/env node` shebang fails.
 */
export function cliLauncherScript(options: { version?: string } = {}): string {
    const version = (options.version ?? '').trim();
    const stamp =
        version === ''
            ? ''
            : `# Identity for \`kelpi --version\` and doctor's CLI/daemon drift check.\n` +
              `KELPI_CLI_VERSION="\${KELPI_CLI_VERSION:-${version}}"\n` +
              `export KELPI_CLI_VERSION\n`;
    return `#!/bin/sh
# ${CLI_LAUNCHER_MARKER} — installed by Kelpi.app. Safe to delete; \`kelpi install-hooks --link\`
# (or the app's "Install CLI" tray item) puts it back.
set -e

# Walk $0 back through any symlinks: /usr/local/bin/kelpi points here.
target="$0"
while [ -L "$target" ]; do
    link="$(readlink "$target")"
    case "$link" in
        /*) target="$link" ;;
        *) target="$(dirname "$target")/$link" ;;
    esac
done
dir="$(cd "$(dirname "$target")" && pwd)"
bundle="$dir/kelpi.js"
${stamp}
# The app ships its own Node beside this directory; fall back to PATH only if it is gone.
if [ -x "$dir/../node" ]; then
    exec "$dir/../node" "$bundle" "$@"
fi
exec node "$bundle" "$@"
`;
}

/**
 * The `package.json` staged beside the CLI bundle, as `Contents/Resources/cli/package.json`.
 *
 * `kelpi.js` is an ES module with a `.js` name, so Node takes its module type from the nearest
 * `package.json` above it. Staging copies the bundle away from `packages/cli/package.json`, which
 * declares `"type": "module"`, and without a declaration of its own the lookup climbs out of the
 * app: from `packages/shell/out/Kelpi-darwin-arm64/Kelpi.app` it reaches this package's
 * `package.json`, which has no `type` (and must not gain one: `dist/main.js` is CommonJS). Node
 * then parses the bundle as CommonJS, fails, reparses it as ESM, and prints
 * `MODULE_TYPELESS_PACKAGE_JSON` ahead of every command's output. This file ends the lookup
 * beside the bundle. The daemon payload carries the same declaration for `kelpid.js`
 * (`packages/daemon/scripts/stage-payload.mjs`).
 */
export const ESM_SCOPE_PACKAGE_JSON = `${JSON.stringify({ type: 'module' })}\n`;

// ── the macOS fuse set ──────────────────────────────────────────────────────────────

/**
 * Is this build signed with a real identity, rather than the ad-hoc signature Forge falls back
 * to? `KELPI_MACOS_IDENTITY` is the one input: set it and `forge.config.cjs` adds an `osxSign`
 * block, leave it empty and the bundle carries an ad-hoc (`-`) signature whose code identity
 * changes with every build.
 */
export function isSignedBuild(identity: string | null | undefined): boolean {
    return (identity ?? '').trim().length > 0;
}

/**
 * May this build fuse Chromium's cookie encryption on? **Only when it is really signed.**
 *
 * `EnableCookieEncryption` makes Chromium encrypt the cookie store with a key it keeps in the
 * macOS login keychain ("<app> Safe Storage"), fetched by `OSCrypt` during browser startup. The
 * network service will not serve a single request until it has that key, so anything that makes
 * the keychain call block blocks *every* navigation — silently, with no `did-fail-load` and no
 * error: the window just stays on the initial empty document forever. That is exactly what the
 * packaged app did (run-F ▸ N2), and a `sample` of the browser process names the mechanism:
 *
 *     SecItemAdd → SecItemAdd_osx → SecKeychainItemCreateFromContent
 *       → StorageManager::defaultKeychainUI → makeLoginAuthUI
 *         → AuthorizationCopyRights → xpc_connection_send_message_with_reply_sync → mach_msg
 *
 * — a *synchronous* wait on an authorization dialog that nothing is going to answer. Two things
 * make that dialog appear, and an unsigned build has both: the item's ACL is bound to the code
 * signature, and an ad-hoc signature is a different identity on every rebuild; and any launch
 * without an unlocked login keychain (a private `HOME`, ssh, launchd, CI — `packaged-smoke.mjs`
 * runs in exactly such a sandbox) has no keychain to satisfy it with.
 *
 * So cookie encryption travels with signing, and turns on in the same step as the Developer ID
 * (README ▸ "Signing and notarization"). Note that even a signed build cannot answer that dialog
 * inside the smoke's private `HOME`: run `packaged-smoke.mjs --mock-keychain` there.
 */
export function cookieEncryptionFuseEnabled(identity: string | null | undefined): boolean {
    return isSignedBuild(identity);
}

// ── the ad-hoc signature ────────────────────────────────────────────────────────────

/**
 * Does this build have to be ad-hoc signed **after** packaging finishes? Yes, unless a real
 * identity is configured — in which case `@electron/packager`'s own `osxSign` step already
 * signed the finished bundle and re-signing it would throw that signature away.
 */
export function adhocSignRequired(identity: string | null | undefined, platform: string): boolean {
    return !isSignedBuild(identity) && (platform === 'darwin' || platform === 'mas');
}

/**
 * `codesign` invocations that give an unsigned build a *valid* ad-hoc signature — and then
 * prove it. Run in order; a non-zero exit from either one must fail the build.
 *
 * ## Why this exists (N22)
 *
 * Forge's `FusesPlugin` flips the fuses at the `packageAfterCopy` hook and, because there is no
 * `osxSign` config, re-signs ad-hoc right there. Packaging then keeps going: `@electron/packager`
 * renames `Electron.app` → `Kelpi.app` and all four `Electron Helper*.app` bundles, rewrites every
 * one of their `Info.plist`s (`appBundleId`, `productName`, `extendInfo`, the asar integrity
 * hash) and copies `extraResource` in. Nothing re-signs afterwards. So the shipped bundle used
 * to carry a signature sealed over the *pre-rename* contents:
 *
 *     $ codesign --verify --strict Kelpi.app
 *     Kelpi.app: invalid Info.plist (plist or signature have been modified)
 *     $ codesign -dv Kelpi.app
 *     Identifier=com.github.Electron        ← not com.benfriebe.kelpi
 *     Info.plist=not bound
 *
 * That is not cosmetic. macOS derives the app's *identity* from the code signature, and a broken
 * seal leaves the app running under whatever identifier the stale CodeDirectory names — `tccd`
 * logs the packaged app as `com.github.Electron` and its renderers as `com.github.Electron.helper`.
 * The measured consequence: the browser process's `--remote-debugging-port` listener accepts a
 * TCP connection (`lsof` shows the accepted fd) and the reply never leaves the process, so no
 * CDP client can attach to the packaged app at all — which is why the UI audit could never run
 * against shipped bytes. An ad-hoc re-sign of the finished bundle fixes it outright, and the
 * fuse set is untouched (an otherwise byte-identical copy with the *same* fuses, re-signed,
 * answers `/json/version` in ~5 ms).
 *
 * `--deep` is the right tool *here* and only here: this is an ad-hoc signature with no
 * entitlements and no Developer ID, and the four renamed helper bundles need the same treatment
 * as the outer one. A real signing run takes the `osxSign` path instead, which signs inside-out
 * with per-bundle entitlements the way Apple documents.
 */
export function adhocSignCommands(appPath: string): readonly (readonly string[])[] {
    return [
        ['codesign', '--force', '--deep', '--sign', '-', appPath],
        ['codesign', '--verify', '--strict', appPath]
    ];
}

// ── the Developer ID signature ──────────────────────────────────────────────────────

/**
 * Entitlements for `Kelpi.app` itself, under the hardened runtime notarization requires.
 *
 * `allow-jit` is Electron's own (V8 in the main process). Everything else is there because
 * Kelpi is a terminal: a program running in a pane is a descendant of the app, so macOS
 * attributes its privacy requests (TCC) to Kelpi, and a hardened app that lacks the matching
 * entitlement has the request denied without a prompt. Claude Code's voice mode in a pane
 * needs `audio-input`; an `osascript` needs `apple-events`. The set is Ghostty's
 * (`macos/Ghostty.entitlements`), and each one has a usage string in `forge.config.cjs`.
 */
export const APP_ENTITLEMENTS: readonly string[] = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.device.audio-input',
    'com.apple.security.device.camera',
    'com.apple.security.automation.apple-events',
    'com.apple.security.personal-information.addressbook',
    'com.apple.security.personal-information.calendars',
    'com.apple.security.personal-information.location',
    'com.apple.security.personal-information.photos-library'
];

/**
 * Entitlements for the bundled `node` that runs the daemon: the set the official Node build
 * ships with, minus `get-task-allow`, which notarization rejects.
 *
 * `allow-dyld-environment-variables` matters beyond Node itself. Without it dyld strips every
 * `DYLD_*` variable from a hardened process's environment before `main`, so the daemon, and
 * every shell it spawns, would silently lose them (measured: a hardened binary's own `getenv`
 * sees nothing, so nothing it execs can inherit them).
 */
export const NODE_ENTITLEMENTS: readonly string[] = [
    'com.apple.security.cs.allow-jit',
    'com.apple.security.cs.allow-unsigned-executable-memory',
    'com.apple.security.cs.disable-executable-page-protection',
    'com.apple.security.cs.allow-dyld-environment-variables',
    'com.apple.security.cs.disable-library-validation'
];

/**
 * node-pty's `spawn-helper` sits between the daemon and the user's shell (it `exec`s it), so it
 * needs the same `DYLD_*` pass-through as `node`, and nothing else.
 */
export const SPAWN_HELPER_ENTITLEMENTS: readonly string[] = ['com.apple.security.cs.allow-dyld-environment-variables'];

/** What `@electron/osx-sign`'s `optionsForFile` may return for one path. */
export interface SignFileOptions {
    readonly hardenedRuntime: true;
    readonly entitlements: string[];
}

/**
 * Per-file signing options for `osxSign.optionsForFile`. `null` keeps osx-sign's defaults, which
 * already give each Electron helper (GPU, Renderer, Plugin, plain) its Chromium entitlements.
 * `appName` is the bundle's file name (`Kelpi.app`); the helpers' names only start with it.
 */
export function signOptionsForFile(filePath: string, appName: string): SignFileOptions | null {
    const normal = filePath.split('\\').join('/');
    const entitlements = normal.endsWith(`/${appName}`)
        ? APP_ENTITLEMENTS
        : normal.endsWith(`/${appName}/Contents/Resources/${RESOURCE_NAMES.node}`)
          ? NODE_ENTITLEMENTS
          : normal.includes('/node-pty/') && normal.endsWith('/spawn-helper')
            ? SPAWN_HELPER_ENTITLEMENTS
            : null;
    return entitlements === null ? null : { hardenedRuntime: true, entitlements: [...entitlements] };
}

/** A Mach-O file's magic number in both byte orders, thin 32/64-bit and universal. */
const MACHO_MAGICS: ReadonlySet<number> = new Set([
    0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca
]);

/** Does this file start like a Mach-O binary (thin or universal)? */
export function isMachOHeader(header: Uint8Array): boolean {
    if (header.length < 4) return false;
    const magic = ((header[0]! << 24) | (header[1]! << 16) | (header[2]! << 8) | header[3]!) >>> 0;
    return MACHO_MAGICS.has(magic);
}

/**
 * `osxSign.ignore`: skip every file that is not code. osx-sign signs any file that merely
 * *looks* binary, which in this bundle means the whole web client (fonts, PNGs, Wasm) and
 * `app.asar`, each given a detached signature in extended attributes. Apple's rule is to sign
 * code only and let the enclosing bundle's seal cover resources, which is what this does.
 * `readHeader` returns a file's first bytes, or `null` for a directory (`.app`, `.framework`),
 * which is never skipped.
 */
export function signIgnore(
    filePath: string,
    readHeader: (file: string) => Uint8Array | null = readFileHeader
): boolean {
    const header = readHeader(filePath);
    return header !== null && !isMachOHeader(header);
}

/** A regular file's first four bytes (fewer if it is shorter), or `null` for anything else. */
export function readFileHeader(file: string): Uint8Array | null {
    let fd: number | undefined;
    try {
        if (!statSync(file).isFile()) return null;
        fd = openSync(file, 'r');
        const header = Buffer.alloc(4);
        return header.subarray(0, readSync(fd, header, 0, 4, 0));
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

// ── notarization ────────────────────────────────────────────────────────────────────

/** `osxNotarize` for `@electron/notarize`, in each of the three credential forms notarytool takes. */
export type NotarizeOptions =
    | { readonly keychainProfile: string }
    | { readonly appleApiKey: string; readonly appleApiKeyId: string; readonly appleApiIssuer: string }
    | { readonly appleId: string; readonly appleIdPassword: string; readonly teamId: string };

/**
 * The environment groups that turn notarization on, first match wins:
 *
 * - `KELPI_NOTARY_PROFILE`: a profile saved with `xcrun notarytool store-credentials`, for a
 *   local build.
 * - `APPLE_API_KEY` (path to the `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`: an App Store
 *   Connect API key.
 * - `APPLE_ID`, `APPLE_ID_PASSWORD` (app-specific), `APPLE_TEAM_ID`: what Nex's release used.
 */
const NOTARIZE_GROUPS = [
    ['KELPI_NOTARY_PROFILE'],
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    ['APPLE_ID', 'APPLE_ID_PASSWORD', 'APPLE_TEAM_ID']
] as const;

/**
 * `osxNotarize` from the environment, or `null` when none of it is set (a local, signed-only
 * build). Anything half-configured throws instead of quietly shipping an unnotarized app:
 * a group with some of its variables missing, or credentials without a signing identity, since
 * Apple will not notarize an ad-hoc signature. `@electron/notarize` staples the app itself once
 * the submission is accepted.
 */
export function notarizeOptions(
    env: Readonly<Record<string, string | undefined>>,
    identity: string | null | undefined
): NotarizeOptions | null {
    const value = (name: string): string => (env[name] ?? '').trim();
    for (const group of NOTARIZE_GROUPS) {
        const present = group.filter((name) => value(name).length > 0);
        if (present.length === 0) continue;
        const missing = group.filter((name) => value(name).length === 0);
        if (missing.length > 0) {
            throw new Error(`notarization is half-configured: ${present.join(', ')} set but ${missing.join(', ')} missing`);
        }
        if (!isSignedBuild(identity)) {
            throw new Error(`${present.join(', ')} asks for notarization, which needs KELPI_MACOS_IDENTITY set to a Developer ID`);
        }
        const [first = '', second = '', third = ''] = group.map(value);
        if (group.length === 1) return { keychainProfile: first };
        if (group[0] === 'APPLE_API_KEY') return { appleApiKey: first, appleApiKeyId: second, appleApiIssuer: third };
        return { appleId: first, appleIdPassword: second, teamId: third };
    }
    return null;
}

// ── the bundled Node runtime ────────────────────────────────────────────────────────

/** What `<node> -p "process.versions.node + ' ' + process.arch"` tells us about a candidate. */
export interface NodeRuntimeProbe {
    readonly version: string;
    readonly arch: string;
}

/** The daemon is built and tested against Node 24 (`ARCHITECTURE.md`, stack.md §3). */
export const MINIMUM_NODE_MAJOR = 24;

/**
 * Reasons a Node binary must not be bundled, in human-readable form (empty = fine).
 *
 * The failure this prevents is nasty and late: an x64 Node inside an arm64 app bundle launches
 * under Rosetta, loads the arm64 `pty.node`, and dies with a mach-o mismatch on the first PTY
 * spawn — long after packaging looked successful.
 */
export function nodeRuntimeIssues(probe: NodeRuntimeProbe, targetArch: string): readonly string[] {
    const issues: string[] = [];
    const major = Number.parseInt(probe.version.split('.')[0] ?? '', 10);
    if (!Number.isFinite(major)) {
        issues.push(`could not read a Node version from ${JSON.stringify(probe.version)}`);
    } else if (major < MINIMUM_NODE_MAJOR) {
        issues.push(`Node ${probe.version} is older than the required ${String(MINIMUM_NODE_MAJOR)}.x`);
    }
    if (probe.arch !== targetArch) {
        issues.push(`Node is ${probe.arch} but the app is being packaged for ${targetArch}`);
    }
    return issues;
}

// ── the app icon ────────────────────────────────────────────────────────────────────

/**
 * The designed icon: the kelpie head from `core/assets/kelpi-icon.svg` (white line art on black),
 * stroked onto the same rounded tile the placeholder used. The drawing itself is data in
 * `@kelpi/core/icon` (`art-data.ts`), which flattens it into polylines once per process.
 *
 * The tile keeps a whisper of gradient and rim over the design's flat black so the icon still
 * reads as an object on a dark Dock, but it stays close enough to #000 that the mark and its
 * background look like the source drawing, not a re-interpretation of it.
 */
const TILE_TOP: Rgba = [0x16, 0x16, 0x1a, 0xff];
const TILE_BOTTOM: Rgba = [0x04, 0x04, 0x06, 0xff];
const TILE_EDGE: Rgba = [0x33, 0x33, 0x3b, 0xff];
const GLYPH: Rgba = [0xff, 0xff, 0xff, 0xff];

// Everything below is in a 0..1 square, so one description renders at every icon size.

/**
 * Apple's icon grid, as a fraction of the canvas.
 *
 * A macOS app icon is not drawn edge to edge. The grid puts a full-bleed rounded rectangle -
 * which is exactly what this tile is - on the central 824 of 1024 points, with a 185.4pt corner
 * radius, and leaves the surrounding 100pt empty. The Dock does not normalise that away: it
 * lays every tile out on the same 1024 box, so an icon that paints into the padding simply
 * looks bigger than the apps beside it.
 *
 * Issue #5 was that. The tile spanned 0.89 of the canvas - 911 of 1024 points, ~10% over the
 * grid - and Kelpi sat visibly larger than its Dock neighbours. Nothing was wrong with the
 * drawing; it was on a bigger grid than everyone else.
 */
export const APP_ICON_TILE_SPAN = 824 / 1024;
const TILE_INSET = (1 - APP_ICON_TILE_SPAN) / 2;
const TILE_RADIUS = 185.4 / 1024;

/**
 * The source canvas maps onto this fraction of the *tile*. The drawing frames itself with its
 * own margins inside its square, so this only has to pull it clear of the tile's edge - and
 * measuring it against the tile rather than the canvas is what keeps the mark's proportions
 * fixed when the tile moves onto (or off) the grid.
 *
 * The value is the ratio the drawing already had (0.84 of canvas over a 0.89 tile), so this
 * change resizes the icon without redrawing it.
 */
const GLYPH_SPAN_OF_TILE = 0.84 / 0.89;

/** The same span against the whole canvas, which is the space `stampKelpie` stamps into. */
const GLYPH_SPAN = APP_ICON_TILE_SPAN * GLYPH_SPAN_OF_TILE;

/**
 * The floor on the stroke's device width. The nominal stroke is ~9px at 1024 and scales down
 * linearly, which at the 16px and 32px ICNS variants would leave sub-half-pixel lines that
 * dissolve into grey mush; a one-pixel floor keeps the mark legible in a Finder list instead.
 */
const MIN_STROKE_PX = 1;

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
    const k = clamp01(t);
    return [
        Math.round(a[0] + (b[0] - a[0]) * k),
        Math.round(a[1] + (b[1] - a[1]) * k),
        Math.round(a[2] + (b[2] - a[2]) * k),
        Math.round(a[3] + (b[3] - a[3]) * k)
    ];
}

/** Signed distance to a rounded rectangle centred on (0.5, 0.5); negative inside. */
function roundedRectDistance(x: number, y: number, inset: number, radius: number): number {
    const half = 0.5 - inset - radius;
    const dx = Math.abs(x - 0.5) - half;
    const dy = Math.abs(y - 0.5) - half;
    const outsideX = Math.max(dx, 0);
    const outsideY = Math.max(dy, 0);
    return Math.hypot(outsideX, outsideY) + Math.min(Math.max(dx, dy), 0) - radius;
}

interface Canvas {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/**
 * Draw the app icon at `size` px.
 *
 * The kelpie mark in white line art on a near-black rounded tile — the shipped drawing from
 * `core/assets/kelpi-icon.svg`, not a placeholder. Anti-aliasing comes from signed distance fields
 * rather than supersampling, because the largest ICNS variant is 1024², and a 4× supersample
 * of that is a 67 MB buffer.
 */
export function appIconPixels(size: number): Canvas {
    if (!Number.isInteger(size) || size <= 0) throw new Error(`appIconPixels: bad size ${String(size)}`);
    const rgba = new Uint8Array(size * size * 4);
    // One device pixel, in the normalized space every shape is described in.
    const pixel = 1 / size;

    const coverage = (distance: number): number => clamp01(0.5 - distance / pixel);
    const glyph = stampKelpie(size, { span: GLYPH_SPAN, minStrokePx: MIN_STROKE_PX });

    for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
            const x = (px + 0.5) / size;
            const y = (py + 0.5) / size;

            const tile = roundedRectDistance(x, y, TILE_INSET, TILE_RADIUS);
            const tileAlpha = coverage(tile);
            if (tileAlpha <= 0) continue;

            // Vertical gradient, then a rim highlight just inside the edge.
            let color = mix(TILE_TOP, TILE_BOTTOM, y);
            const edge = Math.abs(tile + 0.012) - 0.006;
            color = mix(color, TILE_EDGE, coverage(edge) * 0.9);

            // The kelpie, already anti-aliased by the stamp pass.
            color = mix(color, GLYPH, glyph[py * size + px] as number);

            const offset = (py * size + px) * 4;
            rgba[offset] = color[0];
            rgba[offset + 1] = color[1];
            rgba[offset + 2] = color[2];
            rgba[offset + 3] = Math.round(255 * tileAlpha);
        }
    }

    return { width: size, height: size, rgba };
}

export function appIconPng(size: number): Buffer {
    const canvas = appIconPixels(size);
    return encodePng(canvas.width, canvas.height, canvas.rgba);
}

// ── ICNS ────────────────────────────────────────────────────────────────────────────

/**
 * The PNG-carrying ICNS variants, in the order `iconutil` emits them for a `.iconset`.
 *
 * ICNS is a tagged container: 8-byte file header, then `<OSType><uint32 length><data>` per
 * entry. Since macOS 10.7 the `ic**`/`icp*` types accept a whole PNG as their payload, which
 * is why this can be written without `iconutil`, `sips` or any image library — and therefore
 * without a `.icns` binary checked into the repo.
 */
export const ICNS_VARIANTS: readonly { readonly type: string; readonly size: number }[] = [
    { type: 'icp4', size: 16 },
    { type: 'icp5', size: 32 },
    { type: 'ic11', size: 32 }, // 16pt @2x
    { type: 'ic12', size: 64 }, // 32pt @2x
    { type: 'ic07', size: 128 },
    { type: 'ic13', size: 256 }, // 128pt @2x
    { type: 'ic08', size: 256 },
    { type: 'ic14', size: 512 }, // 256pt @2x
    { type: 'ic09', size: 512 },
    { type: 'ic10', size: 1024 } // 512pt @2x
];

export interface IcnsEntry {
    readonly type: string;
    readonly data: Uint8Array;
}

/** Wrap already-encoded images in the ICNS container. */
export function encodeIcns(entries: readonly IcnsEntry[]): Buffer {
    if (entries.length === 0) throw new Error('encodeIcns: at least one entry is required');
    const chunks: Buffer[] = [];
    let total = 8;
    for (const entry of entries) {
        if (entry.type.length !== 4) throw new Error(`encodeIcns: OSType must be 4 characters, got "${entry.type}"`);
        const header = Buffer.alloc(8);
        header.write(entry.type, 0, 4, 'ascii');
        header.writeUInt32BE(entry.data.length + 8, 4);
        chunks.push(header, Buffer.from(entry.data));
        total += entry.data.length + 8;
    }
    const fileHeader = Buffer.alloc(8);
    fileHeader.write('icns', 0, 4, 'ascii');
    fileHeader.writeUInt32BE(total, 4);
    return Buffer.concat([fileHeader, ...chunks]);
}

/** The finished `.icns` for the app bundle. */
export function buildAppIcns(variants: readonly { type: string; size: number }[] = ICNS_VARIANTS): Buffer {
    // One render per distinct size; the duplicate-size variants (ic08/ic13, ic09/ic14) share it.
    const rendered = new Map<number, Buffer>();
    return encodeIcns(
        variants.map(({ type, size }) => {
            let png = rendered.get(size);
            if (png === undefined) {
                png = appIconPng(size);
                rendered.set(size, png);
            }
            return { type, data: png };
        })
    );
}

// ── names, restated for the Forge config ────────────────────────────────────────────

/** `extraResource` entries are copied to `Contents/Resources/<basename>` — these basenames. */
export const STAGED_RESOURCE_NAMES: readonly string[] = [
    RESOURCE_NAMES.daemon,
    RESOURCE_NAMES.client,
    RESOURCE_NAMES.cli,
    RESOURCE_NAMES.node
];
