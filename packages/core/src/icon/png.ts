/**
 * The Kelpi mark as PNG bytes, and the tiny encoder that writes them.
 *
 * Safari is why this exists. It does not render SVG favicons at all, and it does not re-read
 * the icon when script swaps the link's href, so on an iPhone attached over the tailnet the
 * two forms in `svg.ts` and `client/src/chrome/favicon.ts` between them show nothing: no tab
 * icon, and a blank tile if the page is added to the home screen. A raster icon is the only
 * form that browser accepts, so the client's build emits one from this module.
 *
 * **This module is not part of `./index.ts`, and must not be.** It imports `node:zlib`, and the
 * barrel is what the browser client imports for `kelpieArt()`; re-exporting from here would
 * drag a Node builtin into the web bundle. Node-side consumers take it by its own subpath,
 * `@kelpi/core/icon/png` (the shell's tray and app icons, the client's Vite config).
 *
 * `encodePng` moved here from the shell's `icon.ts` when the mark did. It is deliberately the
 * smallest thing that writes a valid PNG: no filtering heuristics, no palette, no dependency,
 * and therefore no binary icon checked into the repo anywhere.
 */

import { deflateSync } from 'node:zlib';

import { KELPIE_MIN_STROKE_FRACTION, stampKelpie } from './art.js';
import { KELPIE_MARK_BACKGROUND, KELPIE_MARK_FOREGROUND } from './svg.js';

// ── PNG encoding ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = ((CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
}

/** Minimal 8-bit RGBA, non-interlaced PNG. `rgba` is `width * height * 4` bytes. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
    if (rgba.length !== width * height * 4) {
        throw new Error(`encodePng: expected ${String(width * height * 4)} bytes, got ${String(rgba.length)}`);
    }
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8); // bit depth
    ihdr.writeUInt8(6, 9); // colour type: RGBA
    ihdr.writeUInt8(0, 10); // deflate
    ihdr.writeUInt8(0, 11); // adaptive filtering
    ihdr.writeUInt8(0, 12); // no interlace

    // One filter byte (0 = None) per scanline.
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (width * 4 + 1);
        raw[rowStart] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, rowStart + 1);
    }

    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', new Uint8Array(0))
    ]);
}

// ── the mark ────────────────────────────────────────────────────────────────────────

/** `#RRGGBB` / `RRGGBB` → an RGB triple; anything else is null. */
export function parseHexRgb(value: string): [number, number, number] | null {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
    if (match === null) return null;
    const hex = match[1] as string;
    return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16)
    ];
}

export interface KelpieMarkPngOptions {
    /** The tile behind the mark; opaque, because a home-screen icon has no transparency. */
    readonly background?: string | undefined;
    readonly foreground?: string | undefined;
    /**
     * The floor on the stroke, in pixels of this render. Defaults to the tab rule
     * (`KELPIE_MIN_STROKE_FRACTION` of the canvas), which is right for an icon a browser will
     * scale down to 16px and wrong for one shown near its own size: a 180px home-screen tile
     * wants the drawing's natural stroke with a one-pixel floor under it, not an eighth of its
     * width in line.
     */
    readonly minStrokePx?: number | undefined;
}

/**
 * The mark at `size` px: white line art on an opaque tile, RGBA, PNG-encoded.
 *
 * Full bleed and flat, matching `kelpieMarkSvg` rather than the Dock tile: no rounded corners
 * and no gradient, because a browser draws a favicon into whatever shape it likes and a home
 * screen applies its own mask.
 */
export function kelpieMarkPng(size: number, options: KelpieMarkPngOptions = {}): Buffer {
    if (!Number.isInteger(size) || size <= 0) throw new Error(`kelpieMarkPng: bad size ${String(size)}`);
    const backgroundHex = options.background ?? KELPIE_MARK_BACKGROUND;
    const foregroundHex = options.foreground ?? KELPIE_MARK_FOREGROUND;
    const background = parseHexRgb(backgroundHex);
    const foreground = parseHexRgb(foregroundHex);
    if (background === null) throw new Error(`kelpieMarkPng: bad background ${backgroundHex}`);
    if (foreground === null) throw new Error(`kelpieMarkPng: bad foreground ${foregroundHex}`);

    const coverage = stampKelpie(size, {
        span: 1,
        minStrokePx: options.minStrokePx ?? size * KELPIE_MIN_STROKE_FRACTION
    });
    const rgba = new Uint8Array(size * size * 4);
    for (let index = 0; index < coverage.length; index += 1) {
        const alpha = coverage[index] as number;
        const offset = index * 4;
        for (let channel = 0; channel < 3; channel += 1) {
            const from = background[channel] as number;
            const to = foreground[channel] as number;
            rgba[offset + channel] = Math.round(from + (to - from) * alpha);
        }
        rgba[offset + 3] = 0xff;
    }
    return encodePng(size, size, rgba);
}
