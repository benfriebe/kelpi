import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ART_STROKE_WIDTH, ART_VIEWBOX, KELPIE_PATHS } from './art-data.js';
import { flattenSvgPath } from './art.js';
import { KELPIE_MARK_BACKGROUND, KELPIE_MARK_FOREGROUND, kelpieMarkSvg } from './svg.js';

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
        expect(svg).toContain('transform="matrix(1.2460415,0,0,1.2460415,-124.26033,-80.177323)"');
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
