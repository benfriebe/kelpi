/**
 * Chrome theme tokens as CSS custom properties (shell-ui.md §2).
 *
 * The grid never resolves a palette itself: it reads `var(--nex-*)` with the dark preset
 * baked in as the fallback, so the module renders correctly standalone (tests, storybook)
 * and assembly can unify the whole app by defining the variables once on `:root`.
 * Fallback values are the dark column of the preset table in shell-ui.md §2.
 */

export const GRID_TOKEN_FALLBACKS = {
    '--nex-bg': '#0A0A0C', // windowBackground: gaps between panes / empty grid
    '--nex-header-bg': '#13131A', // headerBackground: pane headers, overlays
    '--nex-surface-bg': '#101013', // surfaceBackground: chips, popovers
    '--nex-fg': '#E6E6EA', // textPrimary
    '--nex-fg-secondary': '#9A9AA0', // textSecondary
    '--nex-fg-tertiary': '#6A6A72', // textTertiary
    '--nex-border': '#24242B', // divider
    '--nex-accent': '#6F9BD8', // accent
    '--nex-pane-focus': '#6F9BD8', // paneFocus (independently themable)
    '--nex-status-running': '#5FBE89', // statusRunning
    '--nex-status-waiting': '#6F9BD8', // statusWaiting
    '--nex-status-inactive': '#8A8A92', // statusInactive
    '--nex-agent': '#D3A329' // activeAgent (amber agent badge / elapsed timer)
} as const;

export type GridTokenName = keyof typeof GRID_TOKEN_FALLBACKS;

/** `var(--nex-x, <dark preset>)` — usable anywhere a CSS color string is. */
export function token(name: GridTokenName): string {
    return `var(${name}, ${GRID_TOKEN_FALLBACKS[name]})`;
}

/** Colors resolved once, so components read `tokens.headerBackground` rather than raw vars. */
export const tokens = {
    windowBackground: token('--nex-bg'),
    headerBackground: token('--nex-header-bg'),
    surfaceBackground: token('--nex-surface-bg'),
    textPrimary: token('--nex-fg'),
    textSecondary: token('--nex-fg-secondary'),
    textTertiary: token('--nex-fg-tertiary'),
    divider: token('--nex-border'),
    accent: token('--nex-accent'),
    paneFocus: token('--nex-pane-focus'),
    statusRunning: token('--nex-status-running'),
    statusWaiting: token('--nex-status-waiting'),
    statusInactive: token('--nex-status-inactive'),
    activeAgent: token('--nex-agent')
} as const;

/**
 * Badge pills are the token color at 14% opacity (agent-lifecycle.md §5.9). CSS custom
 * properties can't be alpha-composited with `color-mix` fallbacks reliably across the
 * theme swap, so the pill fill is expressed as `color-mix` with a literal fallback color.
 */
export function pill(color: string, percent = 14): string {
    return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
