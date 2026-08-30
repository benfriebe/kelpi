/**
 * The chrome's CSS custom properties, with the dark preset baked in as a literal fallback.
 *
 * `theme.ts` RESOLVES a palette; this module is how components CONSUME one. Every color is
 * read as `var(--kelpi-x, <dark preset>)`, so a chrome component renders correctly even when it
 * is mounted without a `ThemeProvider` (unit tests, an embedder that owns `:root` itself), and
 * assembly can unify the whole app by defining the variables once.
 *
 * `CHROME_TOKEN_FALLBACKS` is asserted against `chromeThemeCssVars(DARK_CHROME_THEME)` in
 * `tokens.test.ts`, so the literals here cannot drift from the preset table.
 */

/** Dark-column fallbacks (shell-ui.md §2 preset table). */
export const CHROME_TOKEN_FALLBACKS = {
    '--kelpi-bg': '#0A0A0C',
    /**
     * §N17 — the window GROUND, `theme.ts`'s `WINDOW_FILL_CSS_VAR`.
     *
     * Same value as `--kelpi-bg` until the shell creates the window transparent, at which point
     * it becomes `transparent`: `RootChromeView.swift:32-39` skips its opaque backdrop below
     * `background-opacity` 1 so each pane's own fill is the single translucent layer. Only two
     * elements may read it — `<body>` and the app root. Everything else keeps `--kelpi-bg`.
     */
    '--kelpi-window-fill': '#0A0A0C',
    '--kelpi-sidebar-bg': '#0C0C10',
    '--kelpi-surface': '#101013',
    '--kelpi-header-bg': '#13131A',
    '--kelpi-footer-bg': '#0C0C10',
    '--kelpi-fg': '#E6E6EA',
    '--kelpi-fg-secondary': '#9A9AA0',
    '--kelpi-fg-tertiary': '#6A6A72',
    '--kelpi-border': '#24242B',
    '--kelpi-selection-fill': 'rgba(82, 118, 184, 0.24)',
    '--kelpi-selection-stroke': '#5276B8',
    '--kelpi-accent': '#6F9BD8',
    '--kelpi-pane-focus': '#6F9BD8',
    '--kelpi-status-running': '#5FBE89',
    '--kelpi-status-waiting': '#6F9BD8',
    '--kelpi-status-inactive': '#8A8A92',
    '--kelpi-active-agent': '#D3A329',
    '--kelpi-group-band-opacity': '0.22'
} as const;

export type ChromeTokenName = keyof typeof CHROME_TOKEN_FALLBACKS;

/** `var(--kelpi-x, <dark preset>)` — usable anywhere a CSS color string is. */
export function token(name: ChromeTokenName): string {
    return `var(${name}, ${CHROME_TOKEN_FALLBACKS[name]})`;
}

/** Named reads, so components say `tokens.textSecondary` rather than a raw variable. */
export const tokens = {
    windowBackground: token('--kelpi-bg'),
    /** §N17: the ground. `<body>` and the app root only — see `CHROME_TOKEN_FALLBACKS`. */
    windowFill: token('--kelpi-window-fill'),
    sidebarBackground: token('--kelpi-sidebar-bg'),
    surfaceBackground: token('--kelpi-surface'),
    headerBackground: token('--kelpi-header-bg'),
    footerBackground: token('--kelpi-footer-bg'),
    textPrimary: token('--kelpi-fg'),
    textSecondary: token('--kelpi-fg-secondary'),
    textTertiary: token('--kelpi-fg-tertiary'),
    divider: token('--kelpi-border'),
    selectionFill: token('--kelpi-selection-fill'),
    selectionStroke: token('--kelpi-selection-stroke'),
    accent: token('--kelpi-accent'),
    paneFocus: token('--kelpi-pane-focus'),
    statusRunning: token('--kelpi-status-running'),
    statusWaiting: token('--kelpi-status-waiting'),
    statusInactive: token('--kelpi-status-inactive'),
    activeAgent: token('--kelpi-active-agent')
} as const;
