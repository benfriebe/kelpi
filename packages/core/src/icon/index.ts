/**
 * The Kelpi mark: one drawing, every rendering of it.
 *
 *   `art-data.ts`  — the path data, transform and stroke width, extracted from
 *                    `../../assets/kelpi-icon.svg` (the editable source).
 *   `art.ts`       — flattening and the SDF stamp, for anything that needs pixels.
 *   `svg.ts`       — the same mark as an `<svg>` document, for anything that needs vector.
 *
 * Consumers: the shell's app icon and tray glyph (`stampKelpie`), and the web client's tab
 * favicon, which strokes `kelpieArt()` onto a canvas and links `kelpieMarkSvg()` as the
 * document's static icon.
 */

export {
    ART_SCALE,
    ART_STROKE_WIDTH,
    ART_TRANSLATE_X,
    ART_TRANSLATE_Y,
    ART_VIEWBOX,
    KELPIE_PATHS
} from './art-data.js';

export {
    flattenSvgPath,
    kelpieArt,
    segmentDistance,
    stampKelpie,
    type ArtPoint,
    type ArtPolyline,
    type KelpieArt,
    type KelpieStampOptions
} from './art.js';

export {
    KELPIE_MARK_BACKGROUND,
    KELPIE_MARK_FOREGROUND,
    kelpieMarkSvg,
    type KelpieMarkSvgOptions
} from './svg.js';
