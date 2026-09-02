import { describe, expect, it } from 'vitest';

import { stampKelpie } from '@kelpi/core/icon';
import {
    DARK_TRAY_STATUS,
    DEFAULT_TRAY_STATUS,
    ICON_BASE_SIZE,
    LIGHT_TRAY_STATUS,
    STATUS_COLORS,
    TRAY_GLYPH_SPAN,
    TRAY_STROKE_FLOOR_PT,
    parseTrayHex,
    resolveTrayStatusPalette,
    trayIconIsTemplate,
    trayIconPixels,
    trayIconPng,
    trayPaletteSignature
} from './icon.js';

// The encoder itself moved to `@kelpi/core/icon/png` with the mark; its tests went with it.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
        // Idle carries NO dot anywhere: the mark is black-on-alpha, so a single chromatic
        // pixel would be a dot that crept into the template image. (The dot-centre pixel
        // itself can hold a faint glyph edge, which is why this checks colour, not alpha.)
        const canvas = trayIconPixels('idle', 2);
        for (let offset = 0; offset < canvas.rgba.length; offset += 4) {
            expect(canvas.rgba[offset]).toBe(0);
            expect(canvas.rgba[offset + 1]).toBe(0);
            expect(canvas.rgba[offset + 2]).toBe(0);
        }
    });

    it('draws a glyph even when idle', () => {
        const canvas = trayIconPixels('idle', 2);
        const opaque = [...canvas.rgba].filter((_value, index) => index % 4 === 3 && canvas.rgba[index] !== 0);
        expect(opaque.length).toBeGreaterThan(50);
    });

    it('strokes the kelpie mark — the app icon’s own art, not a second drawing', () => {
        // The idle icon has no dot, so its ALPHA CHANNEL must be exactly the SDF stamp of
        // `@kelpi/core/icon`'s flattened kelpie at the tray's own span and stroke floor. This
        // is what makes "one kelpie in the codebase" a tested claim rather than a comment.
        const canvas = trayIconPixels('idle', 2);
        const coverage = stampKelpie(canvas.width, {
            span: TRAY_GLYPH_SPAN,
            minStrokePx: TRAY_STROKE_FLOOR_PT * 2
        });
        const alphas = Array.from(coverage, (value) => Math.round(value * 0xff));
        expect([...canvas.rgba].filter((_value, index) => index % 4 === 3)).toEqual(alphas);
    });

    // ── §AGNT-087: template when there is no dot to carry ───────────────────────────

    /**
     * The strongest glyph pixel in the LEFT half of the canvas — the top-right status dot
     * cannot reach it, so this reads the GLYPH tone and nothing else. A scan rather than a
     * fixed coordinate: the kelpie's strokes are art, not a grid this test should restate.
     */
    function glyphPixel(indicator: Parameters<typeof trayIconPixels>[0]): [number, number, number, number] {
        const canvas = trayIconPixels(indicator, 2);
        let best: [number, number, number, number] = [0, 0, 0, 0];
        for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width / 2; x += 1) {
                const offset = (y * canvas.width + x) * 4;
                const alpha = canvas.rgba[offset + 3] as number;
                if (alpha <= best[3]) continue;
                best = [
                    canvas.rgba[offset] as number,
                    canvas.rgba[offset + 1] as number,
                    canvas.rgba[offset + 2] as number,
                    alpha
                ];
            }
        }
        return best;
    }

    it('is a template image exactly when there is no status dot', () => {
        expect(trayIconIsTemplate('idle')).toBe(true);
        expect(trayIconIsTemplate('running')).toBe(false);
        expect(trayIconIsTemplate('waiting')).toBe(false);
        expect(trayIconIsTemplate('disconnected')).toBe(false);
    });

    it('draws the idle glyph in opaque black so the menu bar can tint it', () => {
        expect(glyphPixel('idle')).toEqual([0, 0, 0, 0xff]);
    });

    it('keeps a dotted glyph mid-grey — a template would throw the dot colour away', () => {
        expect(glyphPixel('running')).toEqual([0x8e, 0x8e, 0x93, 0xff]);
        expect(glyphPixel('waiting')).toEqual([0x8e, 0x8e, 0x93, 0xff]);
    });
});

describe('trayIconPng', () => {
    it('encodes each indicator to a distinct PNG', () => {
        const idle = trayIconPng('idle');
        const waiting = trayIconPng('waiting');
        expect(idle.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
        expect(idle.equals(waiting)).toBe(false);
    });

    it('encodes a different PNG for a different palette (§M25)', () => {
        expect(trayIconPng('running', 2, LIGHT_TRAY_STATUS).equals(trayIconPng('running', 2, DARK_TRAY_STATUS))).toBe(
            false
        );
        // …and the glyph is all that changes for `idle`, which has no dot to recolour.
        expect(trayIconPng('idle', 2, LIGHT_TRAY_STATUS).equals(trayIconPng('idle', 2, DARK_TRAY_STATUS))).toBe(true);
    });
});

/**
 * §M25 — the menu-bar dot follows the resolved chrome theme.
 *
 * `StatusBarController.swift:26-28, 41-60` takes `waitingColor:` / `runningColor:` as arguments
 * and `AppReducer.swift:2538-2557` resolves them from the appearance preference plus the user's
 * `chrome-colors` overrides, against the OS appearance ("the menu bar sits in the OS
 * appearance"). The port drew one hard-coded column whatever the user had chosen.
 */
describe('resolveTrayStatusPalette (§M25)', () => {
    function dot(indicator: 'running' | 'waiting' | 'disconnected', palette: Parameters<typeof trayIconPixels>[2]) {
        const canvas = trayIconPixels(indicator, 2, palette);
        const offset = (8 * canvas.width + (canvas.width - 8)) * 4;
        return [
            canvas.rgba[offset] as number,
            canvas.rgba[offset + 1] as number,
            canvas.rgba[offset + 2] as number,
            canvas.rgba[offset + 3] as number
        ];
    }

    it('follows the OS scheme while the preference is `system`', () => {
        expect(resolveTrayStatusPalette({ appearance: 'system', systemDark: false })).toEqual(LIGHT_TRAY_STATUS);
        expect(resolveTrayStatusPalette({ appearance: 'system', systemDark: true })).toEqual(DARK_TRAY_STATUS);
        // No appearance at all reads as `system` (an older daemon, or a pre-`welcome` tray).
        expect(resolveTrayStatusPalette({ systemDark: true })).toEqual(DARK_TRAY_STATUS);
    });

    it('an explicit preference wins over the OS', () => {
        expect(resolveTrayStatusPalette({ appearance: 'light', systemDark: true })).toEqual(LIGHT_TRAY_STATUS);
        expect(resolveTrayStatusPalette({ appearance: 'dark', systemDark: false })).toEqual(DARK_TRAY_STATUS);
    });

    it('applies the user’s per-bucket overrides, and only the matching bucket’s', () => {
        const overrides = { 'dark:statusRunning': 'FF0000', 'light:statusWaiting': '00FF00' };
        const dark = resolveTrayStatusPalette({ appearance: 'dark', overrides });
        expect(dark.running).toBe('FF0000');
        // The light-bucket override is not this bucket's business.
        expect(dark.waiting).toBe(DARK_TRAY_STATUS.waiting);

        const light = resolveTrayStatusPalette({ appearance: 'light', overrides });
        expect(light.waiting).toBe('00FF00');
        expect(light.running).toBe(LIGHT_TRAY_STATUS.running);
    });

    it('ignores an unparseable override rather than blanking the dot', () => {
        const palette = resolveTrayStatusPalette({
            appearance: 'dark',
            overrides: { 'dark:statusWaiting': 'not-a-colour', 'dark:statusRunning': '#12345' }
        });
        expect(palette).toEqual(DARK_TRAY_STATUS);
    });

    it('paints the resolved colour into the icon', () => {
        const palette = resolveTrayStatusPalette({
            appearance: 'dark',
            overrides: { 'dark:statusWaiting': 'FF8800' }
        });
        expect(dot('waiting', palette)).toEqual([0xff, 0x88, 0x00, 0xff]);
        expect(dot('running', palette)).toEqual(parseTrayHex(DARK_TRAY_STATUS.running));
    });

    it('the default is unchanged from what the tray drew before', () => {
        expect(DEFAULT_TRAY_STATUS).toEqual(LIGHT_TRAY_STATUS);
        expect(dot('running', undefined)).toEqual(STATUS_COLORS.running);
        expect(dot('waiting', undefined)).toEqual(STATUS_COLORS.waiting);
        expect(dot('disconnected', undefined)).toEqual(STATUS_COLORS.disconnected);
    });

    it('signs a palette so an unchanged indicator can still force a repaint', () => {
        expect(trayPaletteSignature(LIGHT_TRAY_STATUS)).not.toBe(trayPaletteSignature(DARK_TRAY_STATUS));
        expect(trayPaletteSignature(LIGHT_TRAY_STATUS)).toBe(trayPaletteSignature({ ...LIGHT_TRAY_STATUS }));
    });

    it('parses hex with or without the hash, and refuses anything else', () => {
        expect(parseTrayHex('#5FBE89')).toEqual([0x5f, 0xbe, 0x89, 0xff]);
        expect(parseTrayHex('5fbe89')).toEqual([0x5f, 0xbe, 0x89, 0xff]);
        expect(parseTrayHex('#5FBE8')).toBeNull();
        expect(parseTrayHex('')).toBeNull();
        expect(parseTrayHex('rgb(1,2,3)')).toBeNull();
    });
});
