/**
 * Built-in chrome palettes + the shareable style-theme document (SET-023…SET-030).
 *
 * Two things live here, and they are the same data seen from two directions:
 *
 *   - `BUILT_IN_CHROME_THEMES` — the seven one-click presets from
 *     `Nex/Theme/BuiltInChromeThemes.swift`, colour-for-colour. Each names the appearance mode
 *     it was designed for; applying one switches to that mode AND overwrites the styling.
 *   - `ChromeStyleTheme` — `Nex/Theme/ChromeStyleTheme.swift`'s document: the per-appearance
 *     colour overrides (**both** buckets), the five sidebar knobs and the three sparkline
 *     fields, serialisable as a `.nextheme` file or a one-line `nex-theme:<base64>` code.
 *
 * What the document deliberately does NOT carry, and why it matters on import: the recipient's
 * chrome appearance mode and their terminal background. A shared theme restyles the chrome; it
 * does not decide whether you work in the dark or repaint your terminal (`applyStyleTheme`,
 * SettingsFeature.swift:390-416).
 *
 * `version` is a compatibility gate, not decoration: a document from a newer Nex is REFUSED
 * with the exact Swift wording rather than decoded with its unknown fields silently dropped.
 */

import { normalizeHexColor, type ChromeAppearance } from './theme';

/** The eleven colours a preset specifies, as bare `RRGGBB` (the Swift storage spelling). */
export interface ChromePalette {
    readonly windowBackground: string;
    readonly sidebarBackground: string;
    readonly headerBackground: string;
    readonly footerBackground: string;
    readonly surfaceBackground: string;
    readonly accent: string;
    readonly paneFocus: string;
    readonly divider: string;
    readonly statusRunning: string;
    readonly statusWaiting: string;
    readonly statusInactive: string;
}

export interface BuiltInChromeTheme {
    readonly name: string;
    /** The mode this palette is designed for; applying the preset switches to it. */
    readonly appearance: 'light' | 'dark';
    readonly palette: ChromePalette;
}

/** `"<bucket>:<key>" → "RRGGBB"` for ONE appearance bucket. */
export function paletteOverrides(palette: ChromePalette, bucket: 'light' | 'dark'): Record<string, string> {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(palette)) {
        entries[`${bucket}:${key}`] = value;
    }
    return entries;
}

/** `BuiltInChromeTheme.all` — dark-first then light, colours sampled from each theme. */
export const BUILT_IN_CHROME_THEMES: readonly BuiltInChromeTheme[] = [
    {
        name: 'Dracula',
        appearance: 'dark',
        palette: {
            windowBackground: '21222C',
            sidebarBackground: '282A36',
            headerBackground: '343746',
            footerBackground: '282A36',
            surfaceBackground: '2B2D3A',
            accent: 'BD93F9',
            paneFocus: 'BD93F9',
            divider: '44475A',
            statusRunning: '50FA7B',
            statusWaiting: '8BE9FD',
            statusInactive: '6272A4'
        }
    },
    {
        name: 'Nord',
        appearance: 'dark',
        palette: {
            windowBackground: '2E3440',
            sidebarBackground: '2E3440',
            headerBackground: '3B4252',
            footerBackground: '2E3440',
            surfaceBackground: '353C4A',
            accent: '88C0D0',
            paneFocus: '88C0D0',
            divider: '3B4252',
            statusRunning: 'A3BE8C',
            statusWaiting: '81A1C1',
            statusInactive: '4C566A'
        }
    },
    {
        name: 'Gruvbox Dark',
        appearance: 'dark',
        palette: {
            windowBackground: '1D2021',
            sidebarBackground: '282828',
            headerBackground: '3C3836',
            footerBackground: '282828',
            surfaceBackground: '32302F',
            accent: 'FE8019',
            paneFocus: 'FE8019',
            divider: '3C3836',
            statusRunning: 'B8BB26',
            statusWaiting: '83A598',
            statusInactive: '7C6F64'
        }
    },
    {
        name: 'Tokyo Night',
        appearance: 'dark',
        palette: {
            windowBackground: '16161E',
            sidebarBackground: '1A1B26',
            headerBackground: '1F2335',
            footerBackground: '1A1B26',
            surfaceBackground: '1F2335',
            accent: '7AA2F7',
            paneFocus: '7AA2F7',
            divider: '292E42',
            statusRunning: '9ECE6A',
            statusWaiting: '7DCFFF',
            statusInactive: '565F89'
        }
    },
    {
        name: 'Catppuccin Mocha',
        appearance: 'dark',
        palette: {
            windowBackground: '181825',
            sidebarBackground: '1E1E2E',
            headerBackground: '313244',
            footerBackground: '1E1E2E',
            surfaceBackground: '313244',
            accent: 'CBA6F7',
            paneFocus: 'CBA6F7',
            divider: '45475A',
            statusRunning: 'A6E3A1',
            statusWaiting: '89B4FA',
            statusInactive: '6C7086'
        }
    },
    {
        name: 'Solarized Light',
        appearance: 'light',
        palette: {
            windowBackground: 'EEE8D5',
            sidebarBackground: 'EEE8D5',
            headerBackground: 'FDF6E3',
            footerBackground: 'EEE8D5',
            surfaceBackground: 'FDF6E3',
            accent: '268BD2',
            paneFocus: '268BD2',
            divider: 'D9D2BE',
            statusRunning: '859900',
            statusWaiting: '2AA198',
            statusInactive: '93A1A1'
        }
    },
    {
        name: 'Gruvbox Light',
        appearance: 'light',
        palette: {
            windowBackground: 'EBDBB2',
            sidebarBackground: 'FBF1C7',
            headerBackground: 'F2E5BC',
            footerBackground: 'FBF1C7',
            surfaceBackground: 'FBF1C7',
            accent: 'AF3A03',
            paneFocus: 'AF3A03',
            divider: 'D5C4A1',
            statusRunning: '79740E',
            statusWaiting: '076678',
            statusInactive: '7C6F64'
        }
    }
];

// ── the shareable document ──────────────────────────────────────────────────────────

/** `ChromeStyleTheme.currentVersion`. A document above this is refused, not coerced. */
export const CHROME_THEME_VERSION = 1;

/** `ChromeStyleTheme.codePrefix`. */
export const CHROME_THEME_CODE_PREFIX = 'nex-theme:';

export interface ChromeStyleTheme {
    readonly version: number;
    /** The file's base name on export; echoed back on import. */
    readonly name?: string | undefined;
    readonly colorOverrides: Readonly<Record<string, string>>;
    readonly sidebarColorIntensity: number;
    readonly sidebarAvatarFillOpacity: number;
    readonly sidebarAvatarStrokeOpacity: number;
    /** -1 = "use the appearance preset's band opacity". */
    readonly sidebarGroupFillOpacity: number;
    readonly sidebarGroupStrokeOpacity: number;
    readonly sparklineColorHex: string;
    readonly sparklineWidth: number;
    readonly sparklineStyle: string;
}

/** A preset's `styleTheme`: its palette in its native bucket, sparkline tinted to the accent. */
export function builtInStyleTheme(preset: BuiltInChromeTheme): ChromeStyleTheme {
    return {
        version: CHROME_THEME_VERSION,
        name: preset.name,
        colorOverrides: paletteOverrides(preset.palette, preset.appearance),
        sidebarColorIntensity: 1,
        sidebarAvatarFillOpacity: 0.2,
        sidebarAvatarStrokeOpacity: 0.45,
        sidebarGroupFillOpacity: -1,
        sidebarGroupStrokeOpacity: 0,
        sparklineColorHex: preset.palette.accent,
        sparklineWidth: 28,
        sparklineStyle: 'line'
    };
}

export class ChromeThemeError extends Error {}

/** `ChromeStyleThemeError.message` — the two user-facing strings, verbatim. */
export const INVALID_THEME_MESSAGE = "That doesn't look like a Nex theme.";
export function unsupportedVersionMessage(version: number): string {
    return `This theme was made with a newer version of Nex (v${String(version)}).`;
}

function readNumber(source: Record<string, unknown>, key: string, fallback: number): number {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Decode a theme object. The version gate runs FIRST: a v2 document may mean something
 * different by a field this decoder would otherwise happily read.
 */
export function decodeChromeStyleTheme(raw: unknown): ChromeStyleTheme {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new ChromeThemeError(INVALID_THEME_MESSAGE);
    }
    const source = raw as Record<string, unknown>;
    const version = readNumber(source, 'version', 0);
    if (version <= 0) throw new ChromeThemeError(INVALID_THEME_MESSAGE);
    if (version > CHROME_THEME_VERSION) throw new ChromeThemeError(unsupportedVersionMessage(version));

    const overrides: Record<string, string> = {};
    const rawOverrides = source['colorOverrides'];
    if (typeof rawOverrides === 'object' && rawOverrides !== null && !Array.isArray(rawOverrides)) {
        for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
            if (typeof value !== 'string') continue;
            const hex = normalizeHexColor(value);
            if (hex === null) continue;
            overrides[key] = hex.replace(/^#/, '');
        }
    }
    const name = source['name'];
    return {
        version,
        ...(typeof name === 'string' && name !== '' ? { name } : {}),
        colorOverrides: overrides,
        sidebarColorIntensity: readNumber(source, 'sidebarColorIntensity', 1),
        sidebarAvatarFillOpacity: readNumber(source, 'sidebarAvatarFillOpacity', 0.2),
        sidebarAvatarStrokeOpacity: readNumber(source, 'sidebarAvatarStrokeOpacity', 0.45),
        sidebarGroupFillOpacity: readNumber(source, 'sidebarGroupFillOpacity', -1),
        sidebarGroupStrokeOpacity: readNumber(source, 'sidebarGroupStrokeOpacity', 0),
        sparklineColorHex: typeof source['sparklineColorHex'] === 'string' ? source['sparklineColorHex'] : '',
        sparklineWidth: readNumber(source, 'sparklineWidth', 28),
        sparklineStyle: source['sparklineStyle'] === 'dots' ? 'dots' : 'line'
    };
}

/** The `.nextheme` file body: pretty-printed, **sorted keys** (`jsonData()`). */
export function chromeThemeFileJson(theme: ChromeStyleTheme): string {
    return `${JSON.stringify(sortKeys(theme), null, 2)}\n`;
}

/** `nex-theme:<base64(compact sorted-key JSON)>` (`shareCode()`). */
export function chromeThemeShareCode(theme: ChromeStyleTheme): string {
    const json = JSON.stringify(sortKeys(theme));
    return `${CHROME_THEME_CODE_PREFIX}${base64Encode(json)}`;
}

/**
 * Decode any of the three forms a user can paste (`init(shareCode:)`): the prefixed code, a
 * bare base64 blob, or the raw JSON of an exported file. Anything else is `invalidCode`.
 *
 * Order matters: base64 is attempted first (matching Swift), but `atob` is far more permissive
 * than `Data(base64Encoded:)` — it happily decodes short JSON-ish strings into mojibake — so
 * the decode only counts when the RESULT parses as an object. A blob that decodes to garbage
 * falls through to the raw-JSON branch instead of throwing the wrong error.
 */
export function parseChromeThemeCode(code: string): ChromeStyleTheme {
    const trimmed = code.trim();
    if (trimmed === '') throw new ChromeThemeError(INVALID_THEME_MESSAGE);
    let body = trimmed;
    if (body.startsWith(CHROME_THEME_CODE_PREFIX)) body = body.slice(CHROME_THEME_CODE_PREFIX.length).trim();

    if (!body.startsWith('{')) {
        const decoded = base64Decode(body);
        if (decoded !== null) {
            // A version gate rejection must reach the user as ITS message, not as "not a Nex
            // theme" — so a decode that produced a real object is committed to here.
            return decodeChromeStyleTheme(parseJsonOrThrow(decoded));
        }
    }
    if (trimmed.startsWith('{')) return decodeChromeStyleTheme(parseJsonOrThrow(trimmed));
    if (body.startsWith('{')) return decodeChromeStyleTheme(parseJsonOrThrow(body));
    throw new ChromeThemeError(INVALID_THEME_MESSAGE);
}

function parseJsonOrThrow(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new ChromeThemeError(INVALID_THEME_MESSAGE);
    }
}

function sortKeys(theme: ChromeStyleTheme): Record<string, unknown> {
    const source = theme as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
        if (source[key] === undefined) continue;
        if (key === 'colorOverrides') {
            const nested: Record<string, string> = {};
            for (const inner of Object.keys(theme.colorOverrides).sort()) {
                nested[inner] = theme.colorOverrides[inner] as string;
            }
            out[key] = nested;
            continue;
        }
        out[key] = source[key];
    }
    return out;
}

/** UTF-8-safe base64 (`btoa` is latin-1 only; a theme name can hold anything). */
export function base64Encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/** The inverse; `null` when the input is not base64 or does not decode to an object. */
export function base64Decode(text: string): string | null {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(text)) return null;
    try {
        const binary = atob(text.replace(/\s+/g, ''));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const decoded = new TextDecoder().decode(bytes);
        return decoded.trim().startsWith('{') ? decoded : null;
    } catch {
        return null;
    }
}

/** The chrome appearance a preset implies, as the settings value that is written. */
export function presetAppearance(preset: BuiltInChromeTheme): ChromeAppearance {
    return preset.appearance;
}
