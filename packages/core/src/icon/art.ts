/**
 * The Kelpi mark's artwork AND its rasteriser: the kelpie head from
 * `../../assets/kelpi-icon.svg`, flattened into stroke centrelines, plus the SDF stamp that
 * paints them. The app icon (`shell/src/packaging.ts`), the menu-bar tray glyph
 * (`shell/src/icon.ts`) and the browser tab's favicon (`client/src/chrome/favicon.ts`) all
 * render from here, so there is exactly one kelpie in the codebase. It lives in `@kelpi/core`
 * rather than in the shell precisely because the third of those runs in a browser.
 *
 * The drawing is unusually friendly to this treatment: every path is `fill:none` with round
 * caps and round joins at one shared width, so "render the SVG" reduces to "stroke a set of
 * polylines with round-capped segments", which is exactly the `segmentDistance` primitive
 * below. No SVG library, no rasteriser dependency, no binary asset in git, and the mark still
 * re-renders at every size — 1024px Dock tile to 16px favicon — from one description.
 *
 * What this file implements is therefore a *subset* of SVG path data, not a path engine:
 * moveto/lineto (and the implicit linetos after a moveto), cubic curves with their smooth `s`
 * shorthand, and closepath. Anything else in a future version of the drawing throws at
 * flatten time, loudly, in tests; silently skipping a command would ship a wrong icon.
 */

import {
    ART_SCALE,
    ART_STROKE_WIDTH,
    ART_TRANSLATE_X,
    ART_TRANSLATE_Y,
    ART_VIEWBOX,
    KELPIE_PATHS
} from './art-data.js';

export interface ArtPoint {
    readonly x: number;
    readonly y: number;
}

export type ArtPolyline = readonly ArtPoint[];

/**
 * Longest chord a flattened curve may take, in source-canvas pixels. At 2 canvas px the sag of
 * a chord against its arc is far below half a pixel at the largest render (1024 = 1 canvas px),
 * so flattening is invisible under a 12px round-capped stroke.
 */
const MAX_CHORD = 2;

/** Path-data tokens: a command letter, or a number (which may carry an exponent). */
function tokenize(d: string): readonly (string | number)[] {
    const tokens: (string | number)[] = [];
    const matcher = /([A-DF-Za-df-z])|(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?)/g;
    for (let match = matcher.exec(d); match !== null; match = matcher.exec(d)) {
        tokens.push(match[1] !== undefined ? match[1] : Number.parseFloat(match[2] as string));
    }
    return tokens;
}

/**
 * Flatten one path's `d` into polylines, one per subpath, in the path's own coordinates.
 *
 * Round joins come for free: consecutive segments of a polyline are stroked as round-capped
 * capsules, and overlapping round caps *are* a round join, so the flattened form is exact for
 * this drawing rather than an approximation of it.
 */
export function flattenSvgPath(d: string): readonly ArtPolyline[] {
    const tokens = tokenize(d);
    const polylines: ArtPoint[][] = [];
    let current: ArtPoint[] = [];
    let index = 0;
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    // The reflected control point for `s`/`S` exists only straight after a cubic.
    let controlX = 0;
    let controlY = 0;
    let lastWasCubic = false;

    const takeNumber = (): number => {
        const token = tokens[index];
        if (typeof token !== 'number') {
            throw new Error(`flattenSvgPath: expected a number at token ${String(index)}`);
        }
        index += 1;
        return token;
    };
    const moreNumbers = (): boolean => typeof tokens[index] === 'number';
    const flush = (): void => {
        if (current.length > 1) polylines.push(current);
        current = [];
    };
    const lineTo = (nextX: number, nextY: number): void => {
        current.push({ x: nextX, y: nextY });
        x = nextX;
        y = nextY;
        lastWasCubic = false;
    };
    const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, endX: number, endY: number): void => {
        const net = Math.hypot(c1x - x, c1y - y) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(endX - c2x, endY - c2y);
        const steps = Math.min(64, Math.max(2, Math.ceil(net / MAX_CHORD)));
        const fromX = x;
        const fromY = y;
        for (let step = 1; step <= steps; step += 1) {
            const t = step / steps;
            const u = 1 - t;
            current.push({
                x: u * u * u * fromX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * endX,
                y: u * u * u * fromY + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * endY
            });
        }
        x = endX;
        y = endY;
        controlX = c2x;
        controlY = c2y;
        lastWasCubic = true;
    };

    while (index < tokens.length) {
        const command = tokens[index];
        if (typeof command !== 'string') {
            throw new Error(`flattenSvgPath: expected a command at token ${String(index)}`);
        }
        index += 1;
        const relative = command === command.toLowerCase();
        switch (command) {
            case 'm':
            case 'M': {
                let nextX = takeNumber();
                let nextY = takeNumber();
                if (relative) {
                    nextX += x;
                    nextY += y;
                }
                flush();
                x = nextX;
                y = nextY;
                startX = nextX;
                startY = nextY;
                lastWasCubic = false;
                current.push({ x, y });
                // Further coordinate pairs after a moveto are implicit linetos.
                while (moreNumbers()) {
                    let lineX = takeNumber();
                    let lineY = takeNumber();
                    if (relative) {
                        lineX += x;
                        lineY += y;
                    }
                    lineTo(lineX, lineY);
                }
                break;
            }
            case 'l':
            case 'L': {
                do {
                    let lineX = takeNumber();
                    let lineY = takeNumber();
                    if (relative) {
                        lineX += x;
                        lineY += y;
                    }
                    lineTo(lineX, lineY);
                } while (moreNumbers());
                break;
            }
            case 'c':
            case 'C': {
                do {
                    let c1x = takeNumber();
                    let c1y = takeNumber();
                    let c2x = takeNumber();
                    let c2y = takeNumber();
                    let endX = takeNumber();
                    let endY = takeNumber();
                    if (relative) {
                        c1x += x;
                        c1y += y;
                        c2x += x;
                        c2y += y;
                        endX += x;
                        endY += y;
                    }
                    cubicTo(c1x, c1y, c2x, c2y, endX, endY);
                } while (moreNumbers());
                break;
            }
            case 's':
            case 'S': {
                do {
                    let c2x = takeNumber();
                    let c2y = takeNumber();
                    let endX = takeNumber();
                    let endY = takeNumber();
                    if (relative) {
                        c2x += x;
                        c2y += y;
                        endX += x;
                        endY += y;
                    }
                    const c1x = lastWasCubic ? 2 * x - controlX : x;
                    const c1y = lastWasCubic ? 2 * y - controlY : y;
                    cubicTo(c1x, c1y, c2x, c2y, endX, endY);
                } while (moreNumbers());
                break;
            }
            case 'z':
            case 'Z': {
                lineTo(startX, startY);
                flush();
                break;
            }
            default:
                throw new Error(`flattenSvgPath: unsupported path command "${command}"`);
        }
    }
    flush();
    return polylines;
}

export interface KelpieArt {
    /** Stroke centrelines mapped onto the unit square (the source canvas scaled to 0..1). */
    readonly polylines: readonly ArtPolyline[];
    /** The shared stroke width, in the same unit space. */
    readonly strokeWidth: number;
}

let cached: KelpieArt | null = null;

/** Every path, flattened, group-transformed, and normalised. Computed once per process. */
export function kelpieArt(): KelpieArt {
    if (cached !== null) return cached;
    const polylines = KELPIE_PATHS.flatMap((d) => flattenSvgPath(d)).map((line) =>
        line.map(({ x, y }) => ({
            x: (x * ART_SCALE + ART_TRANSLATE_X) / ART_VIEWBOX,
            y: (y * ART_SCALE + ART_TRANSLATE_Y) / ART_VIEWBOX
        }))
    );
    cached = { polylines, strokeWidth: (ART_STROKE_WIDTH * ART_SCALE) / ART_VIEWBOX };
    return cached;
}

// ── stroking ────────────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Signed distance to a round-capped segment of width `width`. */
export function segmentDistance(
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

export interface KelpieStampOptions {
    /** The central fraction of the canvas the unit-square drawing maps onto. */
    readonly span: number;
    /**
     * The floor on the stroke's device width. The nominal stroke is ~12px at 1024 and scales
     * down linearly, so every small render needs one: without it the lines are sub-half-pixel
     * and dissolve into grey mush. Each caller states its own (`packaging.ts` for the ICNS
     * variants, `icon.ts` for the menu bar).
     */
    readonly minStrokePx: number;
}

/**
 * Stroke the kelpie onto a `size`-px canvas: a max-blended coverage buffer, one round-capped
 * capsule per polyline segment.
 *
 * Stamping (iterate segments, touch only each segment's bounding box) rather than a per-pixel
 * SDF loop, because the drawing has a few thousand segments: evaluating all of them at every
 * pixel of a 1024² canvas is billions of distance calls, while stamping is bounded by stroke
 * area. Max-blending makes overlapping caps idempotent, which is also what makes a chain of
 * capsules an *exact* round-joined stroke rather than a darkened approximation.
 */
export function stampKelpie(size: number, options: KelpieStampOptions): Float32Array {
    const art = kelpieArt();
    const coverage = new Float32Array(size * size);
    const span = options.span * size;
    const inset = ((1 - options.span) / 2) * size;
    const width = Math.max(art.strokeWidth * span, options.minStrokePx);
    const reach = width / 2 + 1;
    for (const line of art.polylines) {
        for (let at = 0; at + 1 < line.length; at += 1) {
            const from = line[at] as ArtPoint;
            const to = line[at + 1] as ArtPoint;
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
