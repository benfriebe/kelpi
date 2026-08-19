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

/** Matches the window's `backgroundColor`, so the icon and the app read as one thing. */
const TILE_TOP: Rgba = [0x2b, 0x2b, 0x34, 0xff];
const TILE_BOTTOM: Rgba = [0x15, 0x15, 0x19, 0xff];
const TILE_EDGE: Rgba = [0x3d, 0x3d, 0x49, 0xff];
const GLYPH: Rgba = [0xe8, 0xe8, 0xee, 0xff];
const ACCENT: Rgba = [0x4f, 0xa4, 0x6b, 0xff];

/** Everything below is in a 0..1 square, so one description renders at every icon size. */
const TILE_INSET = 0.055;
const TILE_RADIUS = 0.215;
const STROKE = 0.052;

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
 * Draw the app icon at `size` px.
 *
 * A dark rounded tile with a light prompt chevron, a cursor underscore and a small green
 * "agent running" dot — the same three ideas as the tray glyph, at a size where they can
 * breathe. Anti-aliasing comes from signed distance fields rather than supersampling, because
 * the largest ICNS variant is 1024², and a 4× supersample of that is a 67 MB buffer.
 */
export function appIconPixels(size: number): Canvas {
    if (!Number.isInteger(size) || size <= 0) throw new Error(`appIconPixels: bad size ${String(size)}`);
    const rgba = new Uint8Array(size * size * 4);
    // One device pixel, in the normalized space every shape is described in.
    const pixel = 1 / size;

    const coverage = (distance: number): number => clamp01(0.5 - distance / pixel);

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

            // Prompt chevron `>` …
            const upper = segmentDistance(x, y, 0.3, 0.35, 0.45, 0.5, STROKE);
            const lower = segmentDistance(x, y, 0.3, 0.65, 0.45, 0.5, STROKE);
            // … and the cursor underscore.
            const bar = segmentDistance(x, y, 0.53, 0.645, 0.72, 0.645, STROKE);
            const glyph = Math.min(upper, lower, bar);
            color = mix(color, GLYPH, coverage(glyph));

            // The status dot the tray icon paints when an agent is running.
            const dot = Math.hypot(x - 0.755, y - 0.245) - 0.055;
            color = mix(color, ACCENT, coverage(dot));

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
    RESOURCE_NAMES.node
];
