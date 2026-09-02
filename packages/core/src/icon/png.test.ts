import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { KELPIE_MIN_STROKE_FRACTION } from './art.js';
import { encodePng, kelpieMarkPng, parseHexRgb } from './png.js';
import { KELPIE_MARK_BACKGROUND, KELPIE_MARK_FOREGROUND } from './svg.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('encodePng', () => {
    it('writes a signature, an IHDR with the right dimensions, and an IEND', () => {
        const png = encodePng(2, 1, new Uint8Array(8));
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
        expect(png.readUInt32BE(16)).toBe(2);
        expect(png.readUInt32BE(20)).toBe(1);
        expect(png.readUInt8(24)).toBe(8); // bit depth
        expect(png.readUInt8(25)).toBe(6); // RGBA
        expect(png.subarray(png.length - 8, png.length - 4).toString('ascii')).toBe('IEND');
    });

    it('rejects a buffer that is not width × height × 4', () => {
        expect(() => encodePng(2, 2, new Uint8Array(4))).toThrow(/expected 16 bytes/);
    });
});

describe('parseHexRgb', () => {
    it('takes a hex colour with or without its hash, and refuses anything else', () => {
        expect(parseHexRgb('#0A0A0C')).toEqual([10, 10, 12]);
        expect(parseHexRgb('e6e6ea')).toEqual([230, 230, 234]);
        expect(parseHexRgb('#abc')).toBeNull();
        expect(parseHexRgb('rebeccapurple')).toBeNull();
    });
});

describe('kelpieMarkPng', () => {
    it('encodes a square PNG of the requested size', () => {
        const png = kelpieMarkPng(32);
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(png.readUInt32BE(16)).toBe(32);
        expect(png.readUInt32BE(20)).toBe(32);
    });

    it('refuses a size that is not a positive integer', () => {
        expect(() => kelpieMarkPng(0)).toThrow(/bad size/);
        expect(() => kelpieMarkPng(16.5)).toThrow(/bad size/);
    });

    it('refuses a colour it cannot parse rather than drawing a wrong one', () => {
        expect(() => kelpieMarkPng(16, { background: 'transparent' })).toThrow(/bad background/);
        expect(() => kelpieMarkPng(16, { foreground: '#fff' })).toThrow(/bad foreground/);
    });

    /**
     * Safari's icon is the one nothing can repaint later, so the mark has to be legible in it
     * on its own. That means the tab stroke floor by default, and pixels that actually reach
     * the foreground tone: a render whose brightest pixel is halfway there is the faint-ghost
     * failure this floor exists to prevent.
     */
    it('draws the mark at full strength at tab size', () => {
        const size = 32;
        const rgba = decodeSolidPng(kelpieMarkPng(size), size);
        const background = parseHexRgb(KELPIE_MARK_BACKGROUND) as [number, number, number];
        const foreground = parseHexRgb(KELPIE_MARK_FOREGROUND) as [number, number, number];

        let brightest = 0;
        let painted = 0;
        for (let index = 0; index < size * size; index += 1) {
            const red = rgba[index * 4] as number;
            if (red > brightest) brightest = red;
            if (red > (background[0] as number) + 8) painted += 1;
            expect(rgba[index * 4 + 3]).toBe(0xff); // opaque: a home-screen tile has no alpha
        }
        expect(brightest).toBe(foreground[0]);
        // A recognisable head, not a scattering of grey: a good fraction of the tile is line.
        expect(painted).toBeGreaterThan(size * size * 0.15);
    });

    it('honours a caller that wants the drawing\'s own weight instead', () => {
        const size = 32;
        const floored = countPainted(kelpieMarkPng(size), size);
        const natural = countPainted(kelpieMarkPng(size, { minStrokePx: 1 }), size);
        expect(floored).toBeGreaterThan(natural);
        expect(size * KELPIE_MIN_STROKE_FRACTION).toBe(2);
    });
});

/** IDAT → RGBA. Only handles what `encodePng` writes: 8-bit RGBA, filter 0, no interlace. */
function decodeSolidPng(png: Buffer, size: number): Uint8Array {
    let offset = 8;
    let idat: Buffer | null = null;
    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString('ascii');
        if (type === 'IDAT') idat = png.subarray(offset + 8, offset + 8 + length);
        offset += length + 12;
    }
    expect(idat).not.toBeNull();
    const raw = inflateSync(idat as Buffer);
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
        const rowStart = y * (size * 4 + 1);
        expect(raw[rowStart]).toBe(0); // filter: none
        rgba.set(raw.subarray(rowStart + 1, rowStart + 1 + size * 4), y * size * 4);
    }
    return rgba;
}

function countPainted(png: Buffer, size: number): number {
    const rgba = decodeSolidPng(png, size);
    const background = parseHexRgb(KELPIE_MARK_BACKGROUND) as [number, number, number];
    let painted = 0;
    for (let index = 0; index < size * size; index += 1) {
        if ((rgba[index * 4] as number) > (background[0] as number) + 8) painted += 1;
    }
    return painted;
}
