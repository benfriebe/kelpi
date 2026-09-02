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
}

/** What the source SVG draws: white line art on a full-bleed near-black tile. */
export const KELPIE_MARK_BACKGROUND = '#0A0A0C';
export const KELPIE_MARK_FOREGROUND = '#E6E6EA';

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
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}">` +
        tile +
        `<g fill="none" stroke="${foreground}" stroke-width="${String(ART_STROKE_WIDTH)}"` +
        ` stroke-linecap="round" stroke-linejoin="round" transform="${transform}">` +
        paths +
        '</g></svg>\n'
    );
}
