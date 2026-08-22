/**
 * §APP-014 — the daemon's resolved `theme = <name>` palette, applied to this client.
 *
 * The seam it plugs into already existed. A pane's colours come from
 * `resolveTerminalTheme(null, terminalThemePreset(bucket))`: the light/dark preset, overlaid
 * with whatever `--nex-term-*` the stylesheet resolved. All a THEME does is add one more layer
 * on top — the keys the theme file actually defined — and hand the result to the same
 * `setTheme` every pane's renderer already re-applies live.
 *
 * Two rules, and both are about what a theme is allowed to do:
 *
 *   - **it may be partial.** A ghostty theme is free to set six colours; the other sixteen must
 *     stay whatever the preset says, not become `undefined` (which the engines paint black).
 *     So the merge is key-by-key over the base, never a replacement.
 *   - **it may not smuggle a non-colour in.** The daemon parses theme files with the ghostty
 *     colour parser, so values arrive as `#rrggbb` — but the payload crosses a socket, and
 *     `isEngineColor` is the same guard the CSS-variable read applies to values it did not
 *     write. Anything else is dropped and the base's value stands.
 *
 * `terminalPaletteCssVars` publishes the same answer as `--nex-term-*` custom properties.
 * That is what `TERMINAL_TOKEN_NAMES` documents as the unifying mechanism — every surface that
 * reads a terminal colour out of CSS (a pane's fallback fill, the content panes, a stylesheet
 * rule) then follows the theme too, rather than only the canvas the engine paints.
 */

import { TERMINAL_TOKEN_NAMES, isEngineColor, type TerminalTheme } from './renderer';

/** The wire shape: `TerminalTheme` keys → colour, carrying only what the theme file set. */
export type ResolvedThemePalette = Readonly<Record<string, string>>;

const THEME_KEYS = Object.keys(TERMINAL_TOKEN_NAMES) as readonly (keyof TerminalTheme)[];

/**
 * `base`, with every colour the theme actually defines laid over it.
 *
 * Returns `base` itself (same identity) when the palette contributes nothing, so a client
 * without a theme does not rebuild an engine's theme object on every render.
 */
export function mergeTerminalPalette(
    base: TerminalTheme,
    palette: ResolvedThemePalette | null | undefined
): TerminalTheme {
    if (palette === null || palette === undefined) return base;
    const overrides: Record<string, string> = {};
    for (const key of THEME_KEYS) {
        const value = palette[key];
        if (isEngineColor(value)) overrides[key] = value.trim();
    }
    if (Object.keys(overrides).length === 0) return base;
    return { ...base, ...overrides };
}

/**
 * The palette as `--nex-term-*` custom properties, for the element that owns the theme scope.
 *
 * `--nex-term-bg` is deliberately NOT emitted here: the pane background is the ghostty
 * background AT THE GHOSTTY OPACITY (`App.tsx`'s `paneFill`), and the theme reaches it through
 * the daemon instead — a resolved theme's `background` becomes `appearance.backgroundColor`
 * when the user's own config names none. Emitting it twice would let an opaque hex overwrite
 * the alpha'd fill and break window transparency (§APP-012).
 */
export function terminalPaletteCssVars(
    palette: ResolvedThemePalette | null | undefined
): Record<string, string> {
    const vars: Record<string, string> = {};
    if (palette === null || palette === undefined) return vars;
    for (const key of THEME_KEYS) {
        if (key === 'background') continue;
        const value = palette[key];
        if (isEngineColor(value)) vars[TERMINAL_TOKEN_NAMES[key]] = value.trim();
    }
    return vars;
}
