/**
 * The Kelpi mark as a standalone SVG document, emitted from the same data every other
 * rendering of it uses (`art-data.ts`).
 *
 * `art.ts` rasterises the mark for the places that need pixels: the ICNS variants, the tray
 * image, the canvas favicon a browser tab redraws as agents change state. A browser also wants
 * the mark *before* any of that runs, as the `<link rel="icon">` target in the served
 * document, and there the honest form is the vector one.
 *
 * Generating it rather than checking a second SVG into the repo is the whole point: a copy of
 * `assets/kelpi-icon.svg` trimmed for the web would be a third statement of the same drawing,
 * free to drift from the other two. This one cannot: it is the path data, the group transform
 * and the stroke width, printed.
 *
 * The output is deliberately plain. No Inkscape namespaces, no `<defs>`, no ids: just a
 * background rect, the group transform from the source, and the three paths. The client's
 * build emits it as `/favicon.svg`.
 */

import { KELPIE_MIN_STROKE_FRACTION } from './art.js';
import {
    ART_SCALE,
    ART_STROKE_WIDTH,
    ART_TRANSLATE_X,
    ART_TRANSLATE_Y,
    ART_VIEWBOX,
    KELPIE_PATHS
} from './art-data.js';

export interface KelpieMarkSvgOptions {
    /** The tile behind the mark. Pass an empty string for a transparent background. */
    readonly background?: string | undefined;
    /** The line art itself; the source drawing is white. */
    readonly foreground?: string | undefined;
    /**
     * The stroke, in viewBox units (so: post-transform, the width the mark actually renders
     * with on its 1024 square). Defaults to the source drawing's own ~12.
     *
     * A caller drawing for a browser tab must pass `KELPIE_TAB_STROKE` instead. The source
     * stroke is ~1.2 % of the square, which at 16px is a fifth of a pixel: the mark renders as
     * a grey ghost of itself. Vector art does not save you from that, it just moves where the
     * decision is made.
     */
    readonly strokeWidth?: number | undefined;
}

/**
 * The mark's own colours, as the chrome carries them.
 *
 * The source SVG is pure white on pure black; these are the client's near-white and near-black
 * (`DEFAULT_FAVICON_COLORS`, which is built from them), so the tab icon sits in the same
 * palette as the app it belongs to rather than a hair brighter than everything else in it.
 */
export const KELPIE_MARK_BACKGROUND = '#0A0A0C';
export const KELPIE_MARK_FOREGROUND = '#E6E6EA';

/** The source drawing's own stroke, in viewBox units: `stroke-width` after the group scale. */
export const KELPIE_MARK_STROKE = ART_STROKE_WIDTH * ART_SCALE;

/**
 * The stroke a tab render needs, in viewBox units: `KELPIE_MIN_STROKE_FRACTION` of the square,
 * which is one device pixel once a browser has scaled the mark down to 16px. The canvas
 * favicon floors itself at the same fraction, so the static icon and the badged one that
 * replaces it carry the same weight of line.
 */
export const KELPIE_TAB_STROKE = ART_VIEWBOX * KELPIE_MIN_STROKE_FRACTION;

/**
 * The mark as an `<svg>` document string, on the source drawing's own 1024 square.
 *
 * No width/height attributes: a favicon is asked for at whatever size the browser wants it,
 * and a `viewBox` alone answers all of them.
 */
export function kelpieMarkSvg(options: KelpieMarkSvgOptions = {}): string {
    const background = options.background ?? KELPIE_MARK_BACKGROUND;
    const foreground = options.foreground ?? KELPIE_MARK_FOREGROUND;
    const box = String(ART_VIEWBOX);
    const transform = `matrix(${String(ART_SCALE)},0,0,${String(ART_SCALE)},${String(ART_TRANSLATE_X)},${String(ART_TRANSLATE_Y)})`;
    const tile = background.length === 0 ? '' : `<rect width="${box}" height="${box}" fill="${background}"/>`;
    const paths = KELPIE_PATHS.map((d) => `<path d="${d}"/>`).join('');
    // `stroke-width` is read inside the group, so it is stated pre-transform: undo the scale.
    // The default is the source's own attribute verbatim rather than a round trip through it,
    // which would print floating-point noise where the drawing has an exact number.
    const stroke =
        options.strokeWidth === undefined ? ART_STROKE_WIDTH : Number((options.strokeWidth / ART_SCALE).toFixed(4));
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">` +
        tile +
        `<g fill="none" stroke="${foreground}" stroke-width="${String(stroke)}"` +
        ` stroke-linecap="round" stroke-linejoin="round" transform="${transform}">` +
        paths +
        '</g></svg>\n'
    );
}
