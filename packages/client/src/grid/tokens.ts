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
    /**
     * M13 — the macOS **system** accent, as its own name.
     *
     * `PaneHeaderView.swift:88,91`, `PaneGridView.swift:451-452` and `SplitDividerView.swift:20`
     * paint the label chip, the drop-zone overlay and the divider's drag tint with
     * `Color.accentColor`, and the shipped app ships no `AccentColor.colorset` — so those three
     * surfaces follow the **OS** accent and are untouched by Settings ▸ Appearance ▸ "Sidebar
     * highlight", which in the Swift recolours only `theme.accent` (the sidebar).
     *
     * The port cannot read the OS accent from the renderer: `systemPreferences.getAccentColor()`
     * is a main-process API, there is no preload bridge, and reaching it would mean a new wire
     * message through protocol → daemon → client. That is **ledgered as a standing divergence**
     * rather than built here. What this token buys is the seam: the three surfaces now read one
     * name, it falls back to `--nex-accent` so today's palette is byte-identical, and whoever
     * threads the OS accent through later defines this one variable and all three follow.
     */
    '--nex-system-accent': 'var(--nex-accent, #6F9BD8)', // systemAccent (M13)
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
    systemAccent: token('--nex-system-accent'),
    paneFocus: token('--nex-pane-focus'),
    statusRunning: token('--nex-status-running'),
    statusWaiting: token('--nex-status-waiting'),
    statusInactive: token('--nex-status-inactive'),
    activeAgent: token('--nex-agent')
} as const;

/**
 * Badge pills are the token color at a percentage opacity. CSS custom properties can't be
 * alpha-composited with `color-mix` fallbacks reliably across the theme swap, so the pill fill
 * is expressed as `color-mix` with a literal fallback color.
 *
 * The default is the agent badge's 14% (agent-lifecycle.md §5.9,
 * `PaneHeaderView.swift:329,336`), which is the one the spec writes down. It is **not** the only
 * tone: M14 — `PaneHeaderView.swift` draws the label chip / ZOOM / SYNC at 12 (`:91`, `:112`,
 * `:137`) and SYNC OFF / the branch chip at 10 (`:153`, `:174`), so `PaneHeader`'s `Badge` names
 * its own `fill` at every call site rather than inheriting one flat recipe.
 */
export function pill(color: string, percent = 14): string {
    return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
