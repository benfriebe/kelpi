/**
 * The tray icon, drawn in code (docs/current/agent-lifecycle.md §8.2).
 *
 * The macOS app draws a terminal glyph with a 6px status dot in the top-right corner:
 * waiting colour when anything waits, else running colour, else no dot. Rather than ship
 * binary assets through an esbuild bundle (and a packaging step that does not exist yet),
 * the shell rasterizes the icon into an RGBA buffer and encodes a PNG with `node:zlib` —
 * ~80 lines, zero dependencies, and the dot colour can follow the status live.
 *
 * Template vs mid-grey, which is §AGNT-087's actual rule and not a compromise:
 *
 *   - **idle** (no dot) draws the glyph in OPAQUE BLACK and is marked a template image, so
 *     macOS tints it with the menu bar — light bar, dark glyph; dark bar, light glyph; and it
 *     inverts under a highlighted status item. This is exactly what the Swift does ("with
 *     neither, the image is a template").
 *   - **running / waiting / disconnected** carry a coloured dot, and a template image cannot:
 *     AppKit throws away every channel but alpha. Those states draw the glyph mid-grey (which
 *     reads on both a light and a dark menu bar) and ship as an ordinary image, with the dot in
 *     its status colour. Same trade the Swift makes, one state at a time.
 *
 * `trayIconIsTemplate` is the single source of that rule; `status.ts` passes it straight to
 * `nativeImage.setTemplateImage`, so the drawing and the flag can never disagree.
 */

import { deflateSync } from 'node:zlib';

export type IconIndicator = 'idle' | 'running' | 'waiting' | 'disconnected';

/** §5.9's resolved dark-mode status colours (the menu bar is its own appearance). */
export const STATUS_COLORS: Readonly<Record<IconIndicator, [number, number, number, number] | null>> = {
    idle: null,
    running: [0x4f, 0xa4, 0x6b, 0xff],
    waiting: [0x5e, 0x8a, 0xc4, 0xff],
    disconnected: [0x9a, 0x9a, 0x96, 0xff]
};

/** The non-template glyph tone: mid-grey reads on a light AND a dark menu bar. */
const NON_TEMPLATE_GLYPH: [number, number, number, number] = [0x8e, 0x8e, 0x93, 0xff];
/** The template glyph: opaque black + alpha is all AppKit keeps, and all it needs to tint. */
const TEMPLATE_GLYPH: [number, number, number, number] = [0x00, 0x00, 0x00, 0xff];

/**
 * §AGNT-087: is this indicator's image a macOS template image?
 *
 * True exactly when there is no status dot to carry — a template keeps only the alpha channel,
 * so a coloured dot and menu-bar tinting are mutually exclusive. The Swift draws the same line.
 */
export function trayIconIsTemplate(indicator: IconIndicator): boolean {
    return STATUS_COLORS[indicator] === null;
}

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

// ── the glyph ───────────────────────────────────────────────────────────────────────

/** Menu-bar icons are 22pt tall on macOS; scale 2 renders the @2x variant. */
export const ICON_BASE_SIZE = 22;

interface Canvas {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
}

function createCanvas(size: number): Canvas {
    return { width: size, height: size, rgba: new Uint8Array(size * size * 4) };
}

function plot(canvas: Canvas, x: number, y: number, color: readonly [number, number, number, number]): void {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    const offset = (y * canvas.width + x) * 4;
    canvas.rgba[offset] = color[0];
    canvas.rgba[offset + 1] = color[1];
    canvas.rgba[offset + 2] = color[2];
    canvas.rgba[offset + 3] = color[3];
}

function fillRect(
    canvas: Canvas,
    x: number,
    y: number,
    width: number,
    height: number,
    color: readonly [number, number, number, number]
): void {
    for (let row = y; row < y + height; row += 1) {
        for (let column = x; column < x + width; column += 1) plot(canvas, column, row, color);
    }
}

function fillCircle(
    canvas: Canvas,
    centerX: number,
    centerY: number,
    radius: number,
    color: readonly [number, number, number, number]
): void {
    const limit = radius * radius;
    for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
        for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
            const dx = x + 0.5 - centerX;
            const dy = y + 0.5 - centerY;
            if (dx * dx + dy * dy <= limit) plot(canvas, x, y, color);
        }
    }
}

/**
 * The raw pixels, so tests can assert on the drawing without decoding a PNG.
 * `scale` multiplies the 22pt base; every coordinate below is in base points.
 */
export function trayIconPixels(indicator: IconIndicator, scale = 2): Canvas {
    const size = ICON_BASE_SIZE * scale;
    const canvas = createCanvas(size);
    const unit = (value: number): number => Math.round(value * scale);
    // §AGNT-087: the tinted (template) form is black-on-alpha; the dotted forms stay mid-grey.
    const GLYPH = trayIconIsTemplate(indicator) ? TEMPLATE_GLYPH : NON_TEMPLATE_GLYPH;

    // Terminal outline: a 16×14 rounded-ish box (corners knocked out below).
    const left = unit(3);
    const top = unit(4);
    const width = unit(16);
    const height = unit(14);
    const stroke = Math.max(1, unit(1.5));

    fillRect(canvas, left, top, width, stroke, GLYPH);
    fillRect(canvas, left, top + height - stroke, width, stroke, GLYPH);
    fillRect(canvas, left, top, stroke, height, GLYPH);
    fillRect(canvas, left + width - stroke, top, stroke, height, GLYPH);
    // Knock the four corner pixels out so the box reads as rounded at 22pt.
    const clear: [number, number, number, number] = [0, 0, 0, 0];
    fillRect(canvas, left, top, stroke, stroke, clear);
    fillRect(canvas, left + width - stroke, top, stroke, stroke, clear);
    fillRect(canvas, left, top + height - stroke, stroke, stroke, clear);
    fillRect(canvas, left + width - stroke, top + height - stroke, stroke, stroke, clear);

    // Prompt chevron `>` …
    for (let step = 0; step < unit(3); step += 1) {
        fillRect(canvas, left + unit(3) + step, top + unit(4) + step, stroke, stroke, GLYPH);
        fillRect(canvas, left + unit(3) + step, top + unit(9) - step - stroke, stroke, stroke, GLYPH);
    }
    // … and the cursor underscore.
    fillRect(canvas, left + unit(8), top + unit(9), unit(5), stroke, GLYPH);

    const dot = STATUS_COLORS[indicator];
    if (dot !== null) {
        // §8.2: a 6px dot in the top-right corner, overlapping the glyph.
        fillCircle(canvas, size - unit(4), unit(4), unit(3), dot);
    }
    return canvas;
}

export function trayIconPng(indicator: IconIndicator, scale = 2): Buffer {
    const canvas = trayIconPixels(indicator, scale);
    return encodePng(canvas.width, canvas.height, canvas.rgba);
}

/** `nativeImage.createFromDataURL` input — the form Electron takes without touching disk. */
export function trayIconDataUrl(indicator: IconIndicator, scale = 2): string {
    return `data:image/png;base64,${trayIconPng(indicator, scale).toString('base64')}`;
}
