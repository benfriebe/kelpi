/**
 * The chrome's CSS custom properties, with the dark preset baked in as a literal fallback.
 *
 * `theme.ts` RESOLVES a palette; this module is how components CONSUME one. Every color is
 * read as `var(--nex-x, <dark preset>)`, so a chrome component renders correctly even when it
 * is mounted without a `ThemeProvider` (unit tests, an embedder that owns `:root` itself), and
 * assembly can unify the whole app by defining the variables once.
 *
 * `CHROME_TOKEN_FALLBACKS` is asserted against `chromeThemeCssVars(DARK_CHROME_THEME)` in
 * `tokens.test.ts`, so the literals here cannot drift from the preset table.
 */

/** Dark-column fallbacks (shell-ui.md §2 preset table). */
export const CHROME_TOKEN_FALLBACKS = {
    '--nex-bg': '#0A0A0C',
    '--nex-sidebar-bg': '#0C0C10',
    '--nex-surface': '#101013',
    '--nex-header-bg': '#13131A',
    '--nex-footer-bg': '#0C0C10',
    '--nex-fg': '#E6E6EA',
    '--nex-fg-secondary': '#9A9AA0',
    '--nex-fg-tertiary': '#6A6A72',
    '--nex-border': '#24242B',
    '--nex-selection-fill': 'rgba(82, 118, 184, 0.24)',
    '--nex-selection-stroke': '#5276B8',
    '--nex-accent': '#6F9BD8',
    '--nex-pane-focus': '#6F9BD8',
    '--nex-status-running': '#5FBE89',
    '--nex-status-waiting': '#6F9BD8',
    '--nex-status-inactive': '#8A8A92',
    '--nex-active-agent': '#D3A329',
    '--nex-group-band-opacity': '0.22'
} as const;

export type ChromeTokenName = keyof typeof CHROME_TOKEN_FALLBACKS;

/** `var(--nex-x, <dark preset>)` — usable anywhere a CSS color string is. */
export function token(name: ChromeTokenName): string {
    return `var(${name}, ${CHROME_TOKEN_FALLBACKS[name]})`;
}

/** Named reads, so components say `tokens.textSecondary` rather than a raw variable. */
export const tokens = {
    windowBackground: token('--nex-bg'),
    sidebarBackground: token('--nex-sidebar-bg'),
    surfaceBackground: token('--nex-surface'),
    headerBackground: token('--nex-header-bg'),
    footerBackground: token('--nex-footer-bg'),
    textPrimary: token('--nex-fg'),
    textSecondary: token('--nex-fg-secondary'),
    textTertiary: token('--nex-fg-tertiary'),
    divider: token('--nex-border'),
    selectionFill: token('--nex-selection-fill'),
    selectionStroke: token('--nex-selection-stroke'),
    accent: token('--nex-accent'),
    paneFocus: token('--nex-pane-focus'),
    statusRunning: token('--nex-status-running'),
    statusWaiting: token('--nex-status-waiting'),
    statusInactive: token('--nex-status-inactive'),
    activeAgent: token('--nex-active-agent')
} as const;
