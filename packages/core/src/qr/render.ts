/**
 * The two renderings of a {@link QrMatrix} Kelpi needs: an inline SVG for the pair card in
 * Settings > Remote, and half-block text for `kelpid pair --qr` on a headless host.
 *
 * Both add the quiet zone themselves, and both default it to 4 modules, which is the minimum
 * ISO/IEC 18004 allows for a QR symbol. It is not decoration: a scanner locates it by finding
 * three finder patterns against a light surround, and a QR code butted against a coloured card
 * or a terminal's background is routinely unreadable. Neither renderer will let you forget it,
 * and neither stops you setting it to zero if you are placing the symbol inside your own margin.
 */

import type { QrMatrix } from './encode.js';

/** The specification's minimum quiet zone, in modules, and the default for both renderers. */
export const QR_QUIET_ZONE = 4;

/** Options for {@link qrSvg}. */
export interface QrSvgOptions {
    /**
     * Pixels per module, used only for the root `width` and `height`. The `viewBox` is in
     * module units, so a stylesheet can override the size without touching this. Defaults to 4.
     */
    readonly moduleSize?: number | undefined;
    /** Light margin around the symbol, in modules. Defaults to 4; below 4 risks a failed scan. */
    readonly quietZone?: number | undefined;
    /** The dark modules. Defaults to black. */
    readonly foreground?: string | undefined;
    /**
     * The quiet zone and the light modules. Defaults to white. Pass an empty string to omit the
     * background rectangle entirely, which is only safe when whatever sits behind the SVG is
     * light: a QR code on a dark surface is a QR code no camera will read.
     */
    readonly background?: string | undefined;
    /**
     * The accessible name. It reaches the DOM as `aria-label` on an element with `role="img"`,
     * so a screen reader announces one image rather than reading nothing. Defaults to
     * `'QR code'`; a caller that knows what the code is for should say so instead.
     */
    readonly ariaLabel?: string | undefined;
}

/** Escape the five characters that cannot appear literally in XML text or an attribute value. */
function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * The symbol as a standalone inline SVG string.
 *
 * Every dark module goes into ONE `<path>`, as a run of horizontal bars: a version 10 symbol has
 * 3249 modules, and a `<rect>` apiece would be 1600-odd elements for React to diff and the
 * browser to lay out, for a picture that never changes. Horizontal runs merge into a single
 * subpath, so the common case is far fewer than one subpath per module.
 *
 * Sizes are integers in module units and the path never leaves the grid, so `shape-rendering`
 * is set to `crispEdges`: at a fractional scale the default antialiasing greys the module edges,
 * which is exactly the contrast a camera is trying to threshold.
 */
export function qrSvg(matrix: QrMatrix, options: QrSvgOptions = {}): string {
    const moduleSize = options.moduleSize ?? 4;
    const quietZone = options.quietZone ?? QR_QUIET_ZONE;
    const foreground = options.foreground ?? '#000000';
    const background = options.background ?? '#ffffff';
    const ariaLabel = options.ariaLabel ?? 'QR code';

    const extent = matrix.size + quietZone * 2;
    const side = extent * moduleSize;

    let path = '';
    for (let y = 0; y < matrix.size; y += 1) {
        let x = 0;
        while (x < matrix.size) {
            if (!matrix.module(x, y)) {
                x += 1;
                continue;
            }
            const start = x;
            while (x < matrix.size && matrix.module(x, y)) x += 1;
            const width = x - start;
            path += `M${String(start + quietZone)} ${String(y + quietZone)}h${String(width)}v1h-${String(width)}z`;
        }
    }

    const rect =
        background === ''
            ? ''
            : `<rect width="${String(extent)}" height="${String(extent)}" fill="${escapeXml(background)}"/>`;

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(ariaLabel)}"` +
        ` width="${String(side)}" height="${String(side)}" viewBox="0 0 ${String(extent)} ${String(extent)}"` +
        ' shape-rendering="crispEdges">' +
        rect +
        `<path fill="${escapeXml(foreground)}" d="${path}"/>` +
        '</svg>'
    );
}

/** Options for {@link qrText}. */
export interface QrTextOptions {
    /** Light margin around the symbol, in modules. Defaults to 4; below 4 risks a failed scan. */
    readonly quietZone?: number | undefined;
    /**
     * Swap which colour the block glyphs carry. Off by default, which draws for a dark terminal;
     * turn it on for a light one. See the note on {@link qrText} for why there is no right answer.
     */
    readonly invert?: boolean | undefined;
}

const BLOCK_FULL = '█'; // both halves painted
const BLOCK_UPPER = '▀'; // upper half painted
const BLOCK_LOWER = '▄'; // lower half painted

/**
 * The symbol as text, two module rows per line, using the half-block glyphs.
 *
 * Half blocks rather than two spaces per module because a QR code twice as wide as it is tall
 * does not scan, and because a version 10 symbol at two columns a module is 130 columns wide,
 * which wraps in most terminals. This way a version 10 symbol is 65 columns by 33 lines.
 *
 * THE GLYPHS CARRY THE LIGHT MODULES, not the dark ones, and the quiet zone is therefore solid
 * blocks. That is the right way round for a dark terminal, which is what a terminal multiplexer
 * is looked at in: the light modules come out bright and the dark modules are the terminal's own
 * dark background, so the symbol has the polarity a camera expects, quiet zone included. Printing
 * the dark modules instead would leave the quiet zone as background, and on a dark terminal a
 * symbol with a dark surround does not scan at all. On a light terminal the answer is the other
 * way round, which is what `invert` is for. Colour would settle it properly, but this returns a
 * plain string with no escape sequences in it, so the caller stays free to colour it, indent it,
 * or put it in a file.
 */
export function qrText(matrix: QrMatrix, options: QrTextOptions = {}): string {
    const quietZone = options.quietZone ?? QR_QUIET_ZONE;
    const invert = options.invert ?? false;
    const extent = matrix.size + quietZone * 2;

    // A glyph half is painted when its module is light, or dark under `invert`. An odd extent
    // leaves the last line without a bottom row; it is painted as quiet zone, which adds half a
    // module of margin and never takes any away.
    const painted = (x: number, y: number): boolean => (y < extent ? !matrix.module(x, y - quietZone) !== invert : !invert);

    const lines: string[] = [];
    for (let row = 0; row < extent; row += 2) {
        let line = '';
        for (let column = 0; column < extent; column += 1) {
            const x = column - quietZone;
            const upper = painted(x, row);
            const lower = painted(x, row + 1);
            if (upper && lower) line += BLOCK_FULL;
            else if (upper) line += BLOCK_UPPER;
            else if (lower) line += BLOCK_LOWER;
            else line += ' ';
        }
        lines.push(line);
    }
    return lines.join('\n');
}
