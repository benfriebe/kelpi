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

import { kelpieArt } from './app-icon-art.js';
import { encodePng } from './icon.js';
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
 * The designed icon: the kelpie head from `assets/kelpi-icon.svg` (white line art on black),
 * stroked onto the same rounded tile the placeholder used. The drawing itself is data in
 * `app-icon-art-data.ts`; `app-icon-art.ts` flattens it into polylines once per process.
 *
 * The tile keeps a whisper of gradient and rim over the design's flat black so the icon still
 * reads as an object on a dark Dock, but it stays close enough to #000 that the mark and its
 * background look like the source drawing, not a re-interpretation of it.
 */
const TILE_TOP: Rgba = [0x16, 0x16, 0x1a, 0xff];
const TILE_BOTTOM: Rgba = [0x04, 0x04, 0x06, 0xff];
const TILE_EDGE: Rgba = [0x33, 0x33, 0x3b, 0xff];
const GLYPH: Rgba = [0xff, 0xff, 0xff, 0xff];

/** Everything below is in a 0..1 square, so one description renders at every icon size. */
const TILE_INSET = 0.055;
const TILE_RADIUS = 0.215;

/**
 * The source canvas maps onto this central span of the icon. The drawing frames itself with
 * its own margins inside its square, so this only has to pull it clear of the tile's edge.
 */
const GLYPH_SPAN = 0.84;

/**
 * The floor on the stroke's device width. The nominal stroke is ~10px at 1024 and scales down
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

/** Signed distance to a round-capped segment of width `width`. */
function segmentDistance(
    x: number,
    y: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    width: number
): number {
    const px = x - ax;
    const py = y - ay;
    const vx = bx - ax;
    const vy = by - ay;
    const lengthSquared = vx * vx + vy * vy;
    const t = lengthSquared === 0 ? 0 : clamp01((px * vx + py * vy) / lengthSquared);
    return Math.hypot(px - vx * t, py - vy * t) - width / 2;
}

interface Canvas {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

/**
 * Stroke the kelpie onto a `size`-px canvas: a max-blended coverage buffer, one round-capped
 * capsule per polyline segment.
 *
 * Stamping (iterate segments, touch only each segment's bounding box) rather than the tile's
 * per-pixel SDF loop, because the drawing has a few thousand segments: evaluating all of them
 * at every pixel of a 1024² canvas is billions of distance calls, while stamping is bounded by
 * stroke area. Max-blending makes overlapping caps idempotent, which is also what makes a
 * chain of capsules an *exact* round-joined stroke rather than a darkened approximation.
 */
function stampKelpie(size: number): Float32Array {
    const art = kelpieArt();
    const coverage = new Float32Array(size * size);
    const span = GLYPH_SPAN * size;
    const inset = ((1 - GLYPH_SPAN) / 2) * size;
    const width = Math.max(art.strokeWidth * span, MIN_STROKE_PX);
    const reach = width / 2 + 1;
    for (const line of art.polylines) {
        for (let at = 0; at + 1 < line.length; at += 1) {
            const from = line[at] as { x: number; y: number };
            const to = line[at + 1] as { x: number; y: number };
            const ax = inset + from.x * span;
            const ay = inset + from.y * span;
            const bx = inset + to.x * span;
            const by = inset + to.y * span;
            const minX = Math.max(0, Math.floor(Math.min(ax, bx) - reach));
            const maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx) + reach));
            const minY = Math.max(0, Math.floor(Math.min(ay, by) - reach));
            const maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by) + reach));
            for (let py = minY; py <= maxY; py += 1) {
                for (let px = minX; px <= maxX; px += 1) {
                    // Everything here is in device pixels, so the AA ramp is one pixel wide.
                    const distance = segmentDistance(px + 0.5, py + 0.5, ax, ay, bx, by, width);
                    const alpha = clamp01(0.5 - distance);
                    if (alpha <= 0) continue;
                    const offset = py * size + px;
                    if (alpha > (coverage[offset] as number)) coverage[offset] = alpha;
                }
            }
        }
    }
    return coverage;
}

/**
 * Draw the app icon at `size` px.
 *
 * The kelpie mark in white line art on a near-black rounded tile — the shipped drawing from
 * `assets/kelpi-icon.svg`, not a placeholder. Anti-aliasing comes from signed distance fields
 * rather than supersampling, because the largest ICNS variant is 1024², and a 4× supersample
 * of that is a 67 MB buffer.
 */
export function appIconPixels(size: number): Canvas {
    if (!Number.isInteger(size) || size <= 0) throw new Error(`appIconPixels: bad size ${String(size)}`);
    const rgba = new Uint8Array(size * size * 4);
    // One device pixel, in the normalized space every shape is described in.
    const pixel = 1 / size;

    const coverage = (distance: number): number => clamp01(0.5 - distance / pixel);
    const glyph = stampKelpie(size);

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
