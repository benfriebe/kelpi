/**
 * The built-in chrome palettes and the shareable style-theme document (SET-023…SET-030).
 *
 * The share code is a format other people's files land in, so the tests here are mostly about
 * refusal: a document from a newer Kelpi must be rejected by version rather than half-decoded,
 * and the three paste forms must all round-trip while junk produces the exact Swift message
 * (the user sees that string, so it is part of the contract).
 */

import { describe, expect, it } from 'vitest';

import {
    BUILT_IN_CHROME_THEMES,
    CHROME_THEME_CODE_PREFIX,
    ChromeThemeError,
    INVALID_THEME_MESSAGE,
    base64Decode,
    base64Encode,
    builtInStyleTheme,
    chromeThemeFileJson,
    chromeThemeShareCode,
    decodeChromeStyleTheme,
    paletteOverrides,
    parseChromeThemeCode,
    unsupportedVersionMessage
} from './presets';
import { OVERRIDABLE_CHROME_KEYS, normalizeHexColor } from './theme';

describe('BUILT_IN_CHROME_THEMES', () => {
    it('is the seven presets, dark-first then light', () => {
        expect(BUILT_IN_CHROME_THEMES.map((entry) => entry.name)).toEqual([
            'Dracula',
            'Nord',
            'Gruvbox Dark',
            'Tokyo Night',
            'Catppuccin Mocha',
            'Solarized Light',
            'Gruvbox Light'
        ]);
        expect(BUILT_IN_CHROME_THEMES.slice(0, 5).every((entry) => entry.appearance === 'dark')).toBe(true);
        expect(BUILT_IN_CHROME_THEMES.slice(5).every((entry) => entry.appearance === 'light')).toBe(true);
    });

    /**
     * Every palette colour has to be a real hex, and the palette has to cover exactly the
     * overridable keys — a preset that misses one leaves that surface on the OTHER appearance's
     * preset colour, which is how a "theme" ends up with one stray periwinkle divider.
     */
    it('is a complete, well-formed palette for every overridable key', () => {
        for (const entry of BUILT_IN_CHROME_THEMES) {
            const keys = Object.keys(entry.palette).sort();
            expect(keys).toEqual([...OVERRIDABLE_CHROME_KEYS].sort());
            for (const [key, value] of Object.entries(entry.palette)) {
                expect(normalizeHexColor(value), `${entry.name}.${key}`).not.toBeNull();
            }
        }
    });

    it('maps a palette into `<bucket>:<key>` overrides', () => {
        const overrides = paletteOverrides(BUILT_IN_CHROME_THEMES[0]!.palette, 'dark');
        expect(overrides['dark:accent']).toBe('BD93F9');
        expect(Object.keys(overrides)).toHaveLength(OVERRIDABLE_CHROME_KEYS.length);
    });

    it('tints a preset’s sparkline to its accent and leaves everything else default', () => {
        const theme = builtInStyleTheme(BUILT_IN_CHROME_THEMES[1]!);
        expect(theme.name).toBe('Nord');
        expect(theme.sparklineColorHex).toBe('88C0D0');
        expect(theme.sidebarColorIntensity).toBe(1);
        // -1 keeps the recipient's appearance preset in charge of the band opacity.
        expect(theme.sidebarGroupFillOpacity).toBe(-1);
    });
});

describe('the theme document', () => {
    const THEME = builtInStyleTheme(BUILT_IN_CHROME_THEMES[0]!);

    it('exports pretty JSON with sorted keys', () => {
        const json = chromeThemeFileJson(THEME);
        const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
        expect(keys).toEqual([...keys].sort());
        expect(json).toContain('\n  ');
        expect(json.endsWith('\n')).toBe(true);
    });

    it('round-trips through the share code', () => {
        const code = chromeThemeShareCode(THEME);
        expect(code.startsWith(CHROME_THEME_CODE_PREFIX)).toBe(true);
        expect(code.includes('\n')).toBe(false);
        expect(parseChromeThemeCode(code)).toEqual(THEME);
    });

    // SET-028: all three paste forms.
    it('accepts the prefixed code, a bare blob, and raw JSON', () => {
        const code = chromeThemeShareCode(THEME);
        const bare = code.slice(CHROME_THEME_CODE_PREFIX.length);
        expect(parseChromeThemeCode(bare)).toEqual(THEME);
        expect(parseChromeThemeCode(chromeThemeFileJson(THEME))).toEqual(THEME);
        // Whitespace a paste picks up must not matter.
        expect(parseChromeThemeCode(`  ${code}\n`)).toEqual(THEME);
    });

    // SET-029: the version gate, with the exact user-facing wording.
    it('refuses a document from a newer Kelpi, by version', () => {
        expect(() => decodeChromeStyleTheme({ ...THEME, version: 2 })).toThrow(unsupportedVersionMessage(2));
        // And a pasted one reaches the user as THAT message, not "not a Kelpi theme".
        const code = `${CHROME_THEME_CODE_PREFIX}${base64Encode(JSON.stringify({ ...THEME, version: 7 }))}`;
        expect(() => parseChromeThemeCode(code)).toThrow(unsupportedVersionMessage(7));
    });

    it('refuses anything that is not a theme, with the Swift wording', () => {
        for (const input of ['', 'hello there', '{not json', '[]']) {
            expect(() => parseChromeThemeCode(input)).toThrow(ChromeThemeError);
        }
        expect(() => parseChromeThemeCode('hello there')).toThrow(INVALID_THEME_MESSAGE);
        expect(() => decodeChromeStyleTheme(null)).toThrow(INVALID_THEME_MESSAGE);
        expect(() => decodeChromeStyleTheme({ version: 0 })).toThrow(INVALID_THEME_MESSAGE);
    });

    it('drops override entries that are not colours rather than failing the import', () => {
        const decoded = decodeChromeStyleTheme({
            version: 1,
            colorOverrides: { 'dark:accent': '#bd93f9', 'dark:divider': 'nope', 'light:accent': 42 }
        });
        expect(decoded.colorOverrides).toEqual({ 'dark:accent': 'BD93F9' });
    });

    it('fills the styling defaults for a partial document', () => {
        const decoded = decodeChromeStyleTheme({ version: 1 });
        expect(decoded.sidebarAvatarFillOpacity).toBe(0.2);
        expect(decoded.sparklineStyle).toBe('line');
        expect(decoded.sparklineWidth).toBe(28);
    });
});

describe('base64 helpers', () => {
    it('round-trip non-latin1 text (a theme name can hold anything)', () => {
        const text = '{"name":"Café ☕"}';
        expect(base64Decode(base64Encode(text))).toBe(text);
    });

    it('refuse a blob that decodes to something that is not an object', () => {
        // `atob` is far more permissive than Swift's `Data(base64Encoded:)`, so the decode only
        // counts when the RESULT looks like JSON — otherwise a stray word would "decode" to
        // mojibake and produce the wrong error message.
        expect(base64Decode(base64Encode('just some words'))).toBeNull();
        expect(base64Decode('not base64 !!')).toBeNull();
    });
});
