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
import { flattenSvgPath, kelpieArt, segmentDistance, stampKelpie } from './art.js';

describe('the embedded art data', () => {
    /**
     * `art-data.ts` is a machine-extracted copy of the SVG, and copies drift. This is
     * the test the data file's header promises: edit `assets/kelpi-icon.svg` without
     * re-extracting and the suite fails here, not in the Dock three releases later.
     */
    it('is verbatim assets/kelpi-icon.svg', () => {
        const svg = readFileSync(fileURLToPath(new URL('../../assets/kelpi-icon.svg', import.meta.url)), 'utf8');

        const paths = [...svg.matchAll(/\bd="([^"]+)"/g)].map((match) => match[1]);
        expect(paths).toEqual([...KELPIE_PATHS]);

        const matrix = /transform="matrix\(([^)]+)\)"/.exec(svg);
        const parts = (matrix?.[1] ?? '').split(',').map((part) => Number.parseFloat(part));
        expect(parts).toEqual([ART_SCALE, 0, 0, ART_SCALE, ART_TRANSLATE_X, ART_TRANSLATE_Y]);

        // Per path element, not a file-wide search: the background rect has its own width.
        const widths = [...svg.matchAll(/<path\b[^>]*?style="[^"]*?stroke-width:([0-9.]+)/gs)].map((match) =>
            Number.parseFloat(match[1] as string)
        );
        expect(widths).toEqual(KELPIE_PATHS.map(() => ART_STROKE_WIDTH));

        expect(svg).toContain(`width="${String(ART_VIEWBOX)}"`);
        expect(svg).toContain(`height="${String(ART_VIEWBOX)}"`);
    });
});

describe('flattenSvgPath', () => {
    it('flattens a moveto with implicit linetos into one polyline', () => {
        const lines = flattenSvgPath('m 10,10 5,0 0,5');
        expect(lines).toEqual([
            [
                { x: 10, y: 10 },
                { x: 15, y: 10 },
                { x: 15, y: 15 }
            ]
        ]);
    });

    it('splits subpaths, understands absolute commands, and closes with z', () => {
        const lines = flattenSvgPath('M 0,0 L 4,0 z m 10,0 l 0,2');
        expect(lines).toEqual([
            [
                { x: 0, y: 0 },
                { x: 4, y: 0 },
                { x: 0, y: 0 }
            ],
            [
                { x: 10, y: 0 },
                { x: 10, y: 2 }
            ]
        ]);
    });

    it('flattens a cubic into chords that stay on the curve', () => {
        // A quarter-ish arc: start and end are exact, the middle must bulge toward the control net.
        const lines = flattenSvgPath('M 0,0 C 0,10 10,10 10,0');
        expect(lines).toHaveLength(1);
        const line = lines[0] as readonly { x: number; y: number }[];
        expect(line[0]).toEqual({ x: 0, y: 0 });
        expect(line[line.length - 1]).toEqual({ x: 10, y: 0 });
        expect(line.length).toBeGreaterThan(5);
        const peak = Math.max(...line.map((point) => point.y));
        expect(peak).toBeGreaterThan(7);
        expect(peak).toBeLessThanOrEqual(7.5); // the true extremum of this curve
    });

    it('refuses a command it does not implement rather than skipping it', () => {
        expect(() => flattenSvgPath('M 0,0 A 5 5 0 0 1 10,10')).toThrow(/unsupported path command "A"/);
        expect(() => flattenSvgPath('M 0,0 L')).toThrow(/expected a number/);
    });
});

describe('kelpieArt', () => {
    it('lands every stroke inside the unit square, at the design stroke width', () => {
        const art = kelpieArt();
        expect(art.polylines.length).toBeGreaterThan(10);
        // 12px on the 1024 canvas (9.63... pre-transform x 1.246... scale).
        expect(art.strokeWidth * ART_VIEWBOX).toBeCloseTo(12, 3);
        const margin = art.strokeWidth / 2;
        for (const line of art.polylines) {
            for (const point of line) {
                expect(point.x).toBeGreaterThanOrEqual(-margin);
                expect(point.x).toBeLessThanOrEqual(1 + margin);
                expect(point.y).toBeGreaterThanOrEqual(-margin);
                expect(point.y).toBeLessThanOrEqual(1 + margin);
            }
        }
    });

    it('returns the same flattened art on every call (it is cached)', () => {
        expect(kelpieArt()).toBe(kelpieArt());
    });
});

describe('segmentDistance', () => {
    it('measures to the round-capped capsule, caps included', () => {
        // On the centreline of a width-2 segment: half a width inside.
        expect(segmentDistance(5, 0, 0, 0, 10, 0, 2)).toBe(-1);
        // Beyond the end cap: distance from the endpoint, minus the cap radius.
        expect(segmentDistance(13, 4, 0, 0, 10, 0, 2)).toBe(4);
        // A zero-length segment degenerates to a round dot rather than dividing by zero.
        expect(segmentDistance(3, 0, 0, 0, 0, 0, 2)).toBe(2);
    });
});

describe('stampKelpie', () => {
    it('stamps 0..1 anti-aliased coverage onto a size² buffer', () => {
        const coverage = stampKelpie(64, { span: 1, minStrokePx: 1 });
        expect(coverage.length).toBe(64 * 64);
        let max = 0;
        let painted = 0;
        for (const value of coverage) {
            max = Math.max(max, value);
            if (value > 0) painted += 1;
        }
        expect(max).toBeLessThanOrEqual(1);
        // Somewhere a pixel centre sits on a stroke's centreline: the mark is solid, not a ghost.
        expect(max).toBeGreaterThan(0.9);
        expect(painted).toBeGreaterThan(200);
    });

    it('honours the stroke floor — a wider floor paints more ink', () => {
        const area = (coverage: Float32Array): number => coverage.reduce((sum, value) => sum + value, 0);
        const thin = area(stampKelpie(32, { span: 1, minStrokePx: 1 }));
        const thick = area(stampKelpie(32, { span: 1, minStrokePx: 3 }));
        expect(thick).toBeGreaterThan(thin);
    });
});
