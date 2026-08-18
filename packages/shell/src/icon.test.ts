import { describe, expect, it } from 'vitest';

import { ICON_BASE_SIZE, STATUS_COLORS, encodePng, trayIconPixels, trayIconPng } from './icon.js';

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

describe('trayIconPixels', () => {
    it('renders at the menu-bar size for the given scale', () => {
        expect(trayIconPixels('idle', 1).width).toBe(ICON_BASE_SIZE);
        expect(trayIconPixels('idle', 2).width).toBe(ICON_BASE_SIZE * 2);
    });

    function dotPixel(indicator: Parameters<typeof trayIconPixels>[0]): [number, number, number, number] {
        const canvas = trayIconPixels(indicator, 2);
        // The dot is centred at (size - 8, 8) in device pixels at scale 2.
        const x = canvas.width - 8;
        const y = 8;
        const offset = (y * canvas.width + x) * 4;
        return [
            canvas.rgba[offset] as number,
            canvas.rgba[offset + 1] as number,
            canvas.rgba[offset + 2] as number,
            canvas.rgba[offset + 3] as number
        ];
    }

    it('paints the status dot in the status colour, and nothing when idle', () => {
        expect(dotPixel('waiting')).toEqual(STATUS_COLORS.waiting);
        expect(dotPixel('running')).toEqual(STATUS_COLORS.running);
        expect(dotPixel('disconnected')).toEqual(STATUS_COLORS.disconnected);
        expect(dotPixel('idle')[3]).toBe(0);
    });

    it('draws a glyph even when idle', () => {
        const canvas = trayIconPixels('idle', 2);
        const opaque = [...canvas.rgba].filter((_value, index) => index % 4 === 3 && canvas.rgba[index] !== 0);
        expect(opaque.length).toBeGreaterThan(50);
    });
});

describe('trayIconPng', () => {
    it('encodes each indicator to a distinct PNG', () => {
        const idle = trayIconPng('idle');
        const waiting = trayIconPng('waiting');
        expect(idle.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(idle.equals(waiting)).toBe(false);
    });
});
