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

export type TrayStatusKind = Exclude<IconIndicator, 'idle'>;

/** The three dot colours a tray image can carry, as `#RRGGBB`. */
export type TrayStatusPalette = Readonly<Record<TrayStatusKind, string>>;

/**
 * §M25 — the chrome palette's status column, restated here.
 *
 * `StatusBarController.swift:26-28, 41-60` takes its two dot colours as *arguments*, and
 * `AppReducer.swift:2538-2557` resolves them from the live `ChromeTheme` — appearance
 * preference + the user's `chrome-colors` overrides — on every `updateExternalIndicators`. The
 * port hard-coded one column, so a user who recoloured "Running" in Settings ▸ Appearance, or
 * who simply runs a dark chrome, got a menu-bar dot that agreed with nothing in the window.
 *
 * The two tables are copied from `client/src/chrome/theme.ts`'s `LIGHT_CHROME_THEME` /
 * `DARK_CHROME_THEME` rather than imported, for the same reason `appearance.ts` re-implements a
 * one-key config read: the main process does not (and must not) load the renderer bundle. If
 * shell-ui.md §2's preset table ever changes, both copies change with it — which is why the
 * values are named after their keys rather than pasted as anonymous hexes.
 */
export const LIGHT_TRAY_STATUS: TrayStatusPalette = {
    running: '#4FA46B', // statusRunning
    waiting: '#5E8AC4', // statusWaiting
    disconnected: '#9A9A96' // statusInactive
};

export const DARK_TRAY_STATUS: TrayStatusPalette = {
    running: '#5FBE89', // statusRunning
    waiting: '#6F9BD8', // statusWaiting
    disconnected: '#8A8A92' // statusInactive
};

/**
 * What an unconfigured shell draws: the light column, which is what the tray drew before the
 * palette became an input. A tray exists before the daemon has said anything at all, so
 * "nothing known yet" has to have an answer, and the answer is the one that does not change
 * today's pixels.
 */
export const DEFAULT_TRAY_STATUS: TrayStatusPalette = LIGHT_TRAY_STATUS;

/** The override key the app stores for each dot (`"<bucket>:<ChromeColorKey>"`). */
const OVERRIDE_KEY: Readonly<Record<TrayStatusKind, string>> = {
    running: 'statusRunning',
    waiting: 'statusWaiting',
    disconnected: 'statusInactive'
};

export interface TrayPaletteInput {
    /** `chrome-appearance`. Anything else (including undefined) reads as `system`. */
    readonly appearance?: string | undefined;
    /**
     * The OS colour scheme. `AppReducer.swift:2543-2545` resolves the theme against
     * `NSApp.effectiveAppearance` with the comment "the menu bar sits in the OS appearance",
     * so this is the tray's own scheme, not the window's.
     */
    readonly systemDark?: boolean | undefined;
    /** `chrome-colors`: `"<light|dark>:<key>" → "RRGGBB"`. */
    readonly overrides?: Readonly<Record<string, string>> | undefined;
}

/** `#RRGGBB` / `RRGGBB` → an opaque RGBA quad; anything else is null. */
export function parseTrayHex(value: string): [number, number, number, number] | null {
    const match = /^#?([0-9a-fA-F]{6})$/.exec(value.trim());
    if (match === null) return null;
    const hex = match[1] as string;
    return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
        0xff
    ];
}

/**
 * `resolveChromeTheme`'s status column, for the tray: the preset for the resolved bucket, then
 * any valid `<bucket>:<key>` override on top. An unparseable override is ignored rather than
 * drawn — a mistyped hex must not blank the dot.
 */
export function resolveTrayStatusPalette(input: TrayPaletteInput = {}): TrayStatusPalette {
    const appearance = input.appearance;
    const bucket =
        appearance === 'light' || appearance === 'dark'
            ? appearance
            : input.systemDark === true
              ? 'dark'
              : 'light';
    const base = bucket === 'dark' ? DARK_TRAY_STATUS : LIGHT_TRAY_STATUS;
    const overrides = input.overrides;
    if (overrides === undefined) return base;
    const resolved: Record<string, string> = { ...base };
    for (const kind of ['running', 'waiting', 'disconnected'] as const) {
        const raw = overrides[`${bucket}:${OVERRIDE_KEY[kind]}`];
        if (typeof raw !== 'string' || parseTrayHex(raw) === null) continue;
        resolved[kind] = raw;
    }
    return resolved as unknown as TrayStatusPalette;
}

/**
 * A repaint key. `updateTray` only redraws when the *indicator* changes, so a recoloured dot on
 * an unchanged state would never reach the menu bar without this.
 */
export function trayPaletteSignature(palette: TrayStatusPalette): string {
    return `${palette.running}/${palette.waiting}/${palette.disconnected}`;
}

/**
 * Which indicators carry a dot, and therefore cannot be template images. The colours themselves
 * are now the caller's (see `resolveTrayStatusPalette`); this map is only the null/non-null
 * shape the template rule reads.
 */
export const STATUS_COLORS: Readonly<Record<IconIndicator, [number, number, number, number] | null>> = {
    idle: null,
    running: parseTrayHex(DEFAULT_TRAY_STATUS.running),
    waiting: parseTrayHex(DEFAULT_TRAY_STATUS.waiting),
    disconnected: parseTrayHex(DEFAULT_TRAY_STATUS.disconnected)
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
export function trayIconPixels(
    indicator: IconIndicator,
    scale = 2,
    palette: TrayStatusPalette = DEFAULT_TRAY_STATUS
): Canvas {
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

    /*
     * §M25: the colour comes from the resolved palette, and only the template rule
     * (`STATUS_COLORS[indicator] === null`) still decides WHETHER there is a dot. A palette
     * whose entry does not parse falls back to the shipped preset rather than to no dot — an
     * indicator that should carry one must never silently become a template image, because that
     * is a different macOS behaviour, not just a different colour.
     */
    if (!trayIconIsTemplate(indicator)) {
        const kind = indicator as TrayStatusKind;
        const dot = parseTrayHex(palette[kind]) ?? parseTrayHex(DEFAULT_TRAY_STATUS[kind]);
        // §8.2: a 6px dot in the top-right corner, overlapping the glyph.
        if (dot !== null) fillCircle(canvas, size - unit(4), unit(4), unit(3), dot);
    }
    return canvas;
}

export function trayIconPng(
    indicator: IconIndicator,
    scale = 2,
    palette: TrayStatusPalette = DEFAULT_TRAY_STATUS
): Buffer {
    const canvas = trayIconPixels(indicator, scale, palette);
    return encodePng(canvas.width, canvas.height, canvas.rgba);
}

/** `nativeImage.createFromDataURL` input — the form Electron takes without touching disk. */
export function trayIconDataUrl(
    indicator: IconIndicator,
    scale = 2,
    palette: TrayStatusPalette = DEFAULT_TRAY_STATUS
): string {
    return `data:image/png;base64,${trayIconPng(indicator, scale, palette).toString('base64')}`;
}
