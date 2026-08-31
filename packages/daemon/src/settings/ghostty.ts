/**
 * A MINIMAL `~/.config/ghostty/config` reader (content-panes.md §3.1, §3.8 + port note 9).
 *
 * The Swift app links libghostty and asks it for the resolved terminal config; the daemon has
 * no ghostty, so it reads the five keys that actually change how Kelpi draws — and nothing else.
 * Ghostty's file uses the same `key = value` / `#` comment syntax as `~/.config/nex/config`,
 * so the line splitter is `@kelpi/core/config`'s: one parser, one set of quirks.
 *
 * Scope, stated honestly so nobody mistakes this for a ghostty config implementation:
 *
 *   - keys read: `background`, `background-opacity`, `font-family`, `font-size`, `theme`,
 *     `window-padding-x`, `window-padding-y`;
 *   - every other key is ignored (ghostty has hundreds);
 *   - `config-file = …` includes are NOT followed;
 *   - a `theme` name is reported verbatim here and RESOLVED next door in `./theme.ts`
 *     (§APP-014): this module only reads the config file, so the theme file lookup — which
 *     touches other paths on disk — lives beside it rather than inside it. `background` from a
 *     resolved theme is applied by `service.ts`, and only when this file names none
 *     (`hasExplicitBackground`);
 *   - a missing / unreadable file is not an error: it yields the defaults.
 *
 * Value rules follow ghostty's own where they are cheap: a later line wins for a scalar key,
 * repeated `font-family` lines ACCUMULATE into a fallback stack, and `font-family = ""`
 * clears the accumulated list.
 */

import { parseConfigLines } from '@kelpi/core/config';
import { DEFAULT_SETTINGS_BACKGROUND } from '@kelpi/protocol';

export interface GhosttyAppearance {
    /** `#rrggbb`, lowercase. Always concrete: the luminance rule needs a real color. */
    readonly backgroundColor: string;
    /** 0..1. */
    readonly backgroundOpacity: number;
    /** CSS font stack from the `font-family` lines, or null when the file sets none. */
    readonly fontFamily: string | null;
    readonly fontSize: number | null;
    /** ghostty's `theme` value verbatim (it may be `dark:X,light:Y`); null when unset. */
    readonly theme: string | null;
    /**
     * `window-padding-x` / `window-padding-y`: whole pixels the terminal pane keeps clear at
     * its edges (x = left/right, y = top; the bottom edge collects the sub-cell remainder —
     * `TerminalPane.tsx` owns that geometry). Null = the key is unset and the client's shipped
     * default (2, ghostty's own default) applies. Parsed as a non-negative number, rounded,
     * and clamped to 64 — a runaway value must not be able to shrink the measured host to
     * nothing.
     */
    readonly windowPaddingX: number | null;
    readonly windowPaddingY: number | null;
    /**
     * Did the file actually carry a parseable `background = …` line?
     *
     * `backgroundColor` is always concrete (the luminance rule needs a real colour), so "the
     * user asked for `#0a0a0c`" and "nobody asked for anything" are otherwise the same value.
     * §APP-014 needs them apart: a resolved THEME supplies the background when the config names
     * none, and must never outrank a `background` line the user wrote (§SET-217/§SET-218, and
     * terminal-surface.md §3.2's "the *resolved* value, i.e. after any `theme` is applied").
     */
    readonly hasExplicitBackground: boolean;
}

export const DEFAULT_GHOSTTY_APPEARANCE: GhosttyAppearance = {
    backgroundColor: DEFAULT_SETTINGS_BACKGROUND,
    backgroundOpacity: 1,
    fontFamily: null,
    fontSize: null,
    theme: null,
    windowPaddingX: null,
    windowPaddingY: null,
    hasExplicitBackground: false
};

/** See `GhosttyAppearance.windowPaddingX` — the ceiling a parsed padding is clamped to. */
export const MAX_WINDOW_PADDING = 64;

function parsePadding(raw: string): number | null {
    const parsed = parseNumber(raw);
    if (parsed === null || parsed < 0) return null;
    return Math.min(MAX_WINDOW_PADDING, Math.round(parsed));
}

const HEX3 = /^[0-9a-f]{3}$/;
const HEX6 = /^[0-9a-f]{6}$/;

/**
 * ghostty writes a background as `#1a1b26` or bare `1a1b26`, and both `#abc` and `abc` are
 * legal short forms. Named colors (`background = black`) and anything else are refused — the
 * caller keeps the previous/default value rather than painting the pane an accidental black.
 */
export function parseGhosttyColor(raw: string): string | null {
    const value = raw.trim().replace(/^#/, '').toLowerCase();
    if (HEX6.test(value)) return `#${value}`;
    if (HEX3.test(value)) {
        const [r, g, b] = [value[0] as string, value[1] as string, value[2] as string];
        return `#${r}${r}${g}${g}${b}${b}`;
    }
    return null;
}

function parseNumber(raw: string): number | null {
    const value = Number.parseFloat(raw.trim());
    return Number.isFinite(value) ? value : null;
}

/**
 * Quote-stripping for `font-family = "JetBrains Mono"`. Ghostty accepts the bare form too, so
 * this only removes a matched surrounding pair — a family whose name contains a quote is not
 * a thing worth handling.
 */
function unquote(raw: string): string {
    const value = raw.trim();
    if (value.length >= 2) {
        const first = value[0];
        if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
    }
    return value;
}

/** Quote a family that needs it, so the result is a valid CSS `font-family` value. */
function cssFamily(name: string): string {
    return /^[A-Za-z_][\w-]*$/.test(name) ? name : `"${name.replace(/"/g, '\\"')}"`;
}

export function parseGhosttyAppearance(contents: string): GhosttyAppearance {
    let backgroundColor = DEFAULT_GHOSTTY_APPEARANCE.backgroundColor;
    let backgroundOpacity = DEFAULT_GHOSTTY_APPEARANCE.backgroundOpacity;
    let fontSize: number | null = null;
    let theme: string | null = null;
    let windowPaddingX: number | null = null;
    let windowPaddingY: number | null = null;
    let families: string[] = [];
    let hasExplicitBackground = false;

    for (const { key, value } of parseConfigLines(contents)) {
        switch (key) {
            case 'background': {
                const color = parseGhosttyColor(value);
                if (color !== null) {
                    backgroundColor = color;
                    hasExplicitBackground = true;
                }
                break;
            }
            case 'background-opacity': {
                const parsed = parseNumber(value);
                if (parsed !== null) backgroundOpacity = Math.min(1, Math.max(0, parsed));
                break;
            }
            case 'font-family': {
                // ghostty: an empty value resets the accumulated family list.
                const family = unquote(value);
                if (family === '') families = [];
                else if (!families.includes(family)) families.push(family);
                break;
            }
            case 'font-size': {
                const parsed = parseNumber(value);
                if (parsed !== null && parsed > 0) fontSize = parsed;
                break;
            }
            case 'theme':
                theme = value === '' ? null : value;
                break;
            case 'window-padding-x': {
                const parsed = parsePadding(value);
                if (parsed !== null) windowPaddingX = parsed;
                break;
            }
            case 'window-padding-y': {
                const parsed = parsePadding(value);
                if (parsed !== null) windowPaddingY = parsed;
                break;
            }
            default:
                break;
        }
    }

    return {
        backgroundColor,
        backgroundOpacity,
        fontFamily: families.length === 0 ? null : families.map(cssFamily).join(', '),
        fontSize,
        theme,
        windowPaddingX,
        windowPaddingY,
        hasExplicitBackground
    };
}
