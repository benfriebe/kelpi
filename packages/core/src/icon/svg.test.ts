import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
    ART_SCALE,
    ART_STROKE_WIDTH,
    ART_TRANSLATE_X,
    ART_TRANSLATE_Y,
    ART_VIEWBOX,
    KELPIE_PATHS
} from './art-data.js';
import { KELPIE_MIN_STROKE_FRACTION, flattenSvgPath } from './art.js';
import {
    KELPIE_MARK_BACKGROUND,
    KELPIE_MARK_FOREGROUND,
    KELPIE_MARK_STROKE,
    KELPIE_TAB_STROKE,
    kelpieMarkSvg
} from './svg.js';

const svg = kelpieMarkSvg();

describe('kelpieMarkSvg', () => {
    /**
     * The point of generating it: the client's `/favicon.svg` is the SAME drawing as the Dock
     * tile and the tray glyph, not a hand-trimmed copy of the source file that can drift from
     * them. So every path, in order, and the transform that positions them.
     */
    it('is the whole mark, path for path', () => {
        const paths = [...svg.matchAll(/<path d="([^"]+)"\/>/g)].map((match) => match[1]);
        expect(paths).toEqual([...KELPIE_PATHS]);
        const scale = String(ART_SCALE);
        expect(svg).toContain(
            `transform="matrix(${scale},0,0,${scale},${String(ART_TRANSLATE_X)},${String(ART_TRANSLATE_Y)})"`
        );
        expect(svg).toContain(`stroke-width="${String(ART_STROKE_WIDTH)}"`);
    });

    /**
     * The drawing is `fill:none` strokes with round caps and joins at one shared width. Lose
     * any of those and the mark renders as filled blobs, which is a different picture.
     */
    it('keeps the stroke contract the drawing depends on', () => {
        expect(svg).toContain('fill="none"');
        expect(svg).toContain('stroke-linecap="round"');
        expect(svg).toContain('stroke-linejoin="round"');
        expect(svg).toContain(`stroke="${KELPIE_MARK_FOREGROUND}"`);
    });

    it('sits on the source drawing\'s own square, with no width/height to fight the browser', () => {
        expect(svg).toContain(`viewBox="0 0 ${String(ART_VIEWBOX)} ${String(ART_VIEWBOX)}"`);
        expect(svg).not.toMatch(/<svg[^>]*\bwidth=/);
    });

    /**
     * The floor, the whole reason `strokeWidth` is an option. The source drawing's ~1.2 % of
     * the square is a fifth of a pixel at 16px; a tab needs a whole one, which is what the
     * canvas favicon already floors itself at. Both must say the same number or the icon
     * visibly thickens the moment the client mounts.
     */
    it('takes a stroke in viewBox units and states it pre-transform', () => {
        expect(KELPIE_TAB_STROKE).toBe(ART_VIEWBOX * KELPIE_MIN_STROKE_FRACTION);
        expect(KELPIE_MARK_STROKE).toBeCloseTo(ART_STROKE_WIDTH * ART_SCALE, 10);

        const tab = kelpieMarkSvg({ strokeWidth: KELPIE_TAB_STROKE });
        const width = Number(/stroke-width="([\d.]+)"/.exec(tab)?.[1]);
        expect(width * ART_SCALE).toBeCloseTo(KELPIE_TAB_STROKE, 2);
        expect(width).toBeGreaterThan(ART_STROKE_WIDTH * 5);

        // Asking for the source's own stroke round-trips to it; the default prints it exactly,
        // rather than through the division, so the drawing keeps its own exact number.
        const asked = Number(/stroke-width="([\d.]+)"/.exec(kelpieMarkSvg({ strokeWidth: KELPIE_MARK_STROKE }))?.[1]);
        expect(asked).toBeCloseTo(ART_STROKE_WIDTH, 3);
        expect(kelpieMarkSvg()).toContain(`stroke-width="${String(ART_STROKE_WIDTH)}"`);
    });

    it('paints the tile behind the mark, and drops it when asked for a transparent one', () => {
        expect(svg).toContain(`<rect width="1024" height="1024" fill="${KELPIE_MARK_BACKGROUND}"/>`);
        expect(kelpieMarkSvg({ background: '' })).not.toContain('<rect');
        expect(kelpieMarkSvg({ background: '#123456' })).toContain('fill="#123456"');
    });

    /**
     * A favicon a parser rejects is a favicon nobody sees. Everything in this document is
     * markup or an attribute value, so the one way to write an unparseable one is to let a
     * raw `<`, `>` or `&` into a value.
     */
    it('is well-formed markup', () => {
        const values = [...svg.matchAll(/="([^"]*)"/g)].map((match) => match[1] as string);
        expect(values.filter((value) => /[<>&]/.test(value))).toEqual([]);
        expect(svg.startsWith('<svg ')).toBe(true);
        expect(svg.trimEnd().endsWith('</g></svg>')).toBe(true);
    });

    /**
     * The generated document and the editable source are two statements of one drawing, and
     * `art.test.ts` already pins the data against the source. This pins the round trip the
     * other way: what the client serves is what Inkscape holds.
     */
    it('carries the same paths the source SVG does', () => {
        const source = readFileSync(fileURLToPath(new URL('../../assets/kelpi-icon.svg', import.meta.url)), 'utf8');
        for (const d of [...source.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1] as string)) {
            expect(svg).toContain(d);
            expect(flattenSvgPath(d).length).toBeGreaterThan(0);
        }
    });
});
