/**
 * ChromeTheme (WP3.5) — the chrome palette as CSS custom properties.
 *
 * Spec: docs/current/shell-ui.md §2. The chrome palette is deliberately independent of the
 * terminal (ghostty) theme and is **resolved, never stored**: appearance preference + OS color
 * scheme + per-bucket user overrides in, one flat token set out. Port note from §15: "hex
 * colors are canonical — implement `resolve(appearance, system, overrides)` as a pure function
 * producing a CSS-variable set", which is exactly the shape here.
 *
 * Two independent light/dark decisions exist in the app and they must not be confused:
 *
 *   - **chrome** light/dark comes from the appearance preference / OS scheme (this module's
 *     `resolveChromeTheme`);
 *   - **content-pane** light/dark comes from the ghostty background color's *luminance*, not
 *     the OS theme (docs/current/content-panes.md §3.1 + port note 9) — `ghosttyBucket` below.
 *
 * Everything is a plain sRGB hex or `rgba()` string so the whole theme is assignable straight
 * onto a container's inline style as `--nex-*` variables.
 */

import type { WorkspaceColor } from '@nex/daemon/store';

// ── token set ───────────────────────────────────────────────────────────────────────

export interface ChromeTheme {
    /** Gaps between panes / behind the empty grid. */
    readonly windowBackground: string;
    readonly sidebarBackground: string;
    /** Sheets, palette, popovers, Settings. */
    readonly surfaceBackground: string;
    /** Pane headers, search overlay, resize overlay. */
    readonly headerBackground: string;
    /** The bottom status bar AND the title bar. */
    readonly footerBackground: string;
    readonly textPrimary: string;
    readonly textSecondary: string;
    readonly textTertiary: string;
    readonly divider: string;
    readonly selectionFill: string;
    readonly selectionStroke: string;
    readonly accent: string;
    readonly paneFocus: string;
    readonly statusRunning: string;
    readonly statusWaiting: string;
    readonly statusInactive: string;
    /** Amber agent badge / elapsed timer. */
    readonly activeAgent: string;
    readonly groupBandOpacity: number;
}

export type ChromeAppearance = 'system' | 'light' | 'dark';
/** The concrete bucket an appearance resolves to; overrides are stored per bucket. */
export type ChromeBucket = 'light' | 'dark';

/** §2 preset table, light column. */
export const LIGHT_CHROME_THEME: ChromeTheme = {
    windowBackground: '#EAE8E2',
    sidebarBackground: '#EFEEE9',
    surfaceBackground: '#FFFFFF',
    headerBackground: '#F7F6F2',
    footerBackground: '#EFEEE9',
    textPrimary: '#2B2B2E',
    textSecondary: '#6B6C70',
    textTertiary: '#9A9A96',
    divider: '#DEDCD5',
    selectionFill: 'rgba(94, 138, 196, 0.16)',
    selectionStroke: '#5E8AC4',
    accent: '#5E8AC4',
    paneFocus: '#5E8AC4',
    statusRunning: '#4FA46B',
    statusWaiting: '#5E8AC4',
    statusInactive: '#9A9A96',
    activeAgent: '#A97C17',
    groupBandOpacity: 0.3
};

/** §2 preset table, dark column. */
export const DARK_CHROME_THEME: ChromeTheme = {
    windowBackground: '#0A0A0C',
    sidebarBackground: '#0C0C10',
    surfaceBackground: '#101013',
    headerBackground: '#13131A',
    footerBackground: '#0C0C10',
    textPrimary: '#E6E6EA',
    textSecondary: '#9A9AA0',
    textTertiary: '#6A6A72',
    divider: '#24242B',
    selectionFill: 'rgba(82, 118, 184, 0.24)',
    selectionStroke: '#5276B8',
    accent: '#6F9BD8',
    paneFocus: '#6F9BD8',
    statusRunning: '#5FBE89',
    statusWaiting: '#6F9BD8',
    statusInactive: '#8A8A92',
    activeAgent: '#D3A329',
    groupBandOpacity: 0.22
};

export function presetChromeTheme(bucket: ChromeBucket): ChromeTheme {
    return bucket === 'dark' ? DARK_CHROME_THEME : LIGHT_CHROME_THEME;
}

/**
 * §2 "Overridable keys". `textPrimary/Secondary/Tertiary`, `activeAgent` and
 * `groupBandOpacity` are deliberately NOT user-overridable.
 */
export const OVERRIDABLE_CHROME_KEYS = [
    'windowBackground',
    'sidebarBackground',
    'footerBackground',
    'headerBackground',
    'surfaceBackground',
    'accent',
    'paneFocus',
    'divider',
    'statusRunning',
    'statusWaiting',
    'statusInactive'
] as const;

export type OverridableChromeKey = (typeof OVERRIDABLE_CHROME_KEYS)[number];

/** `"<light|dark>:<key>" → "RRGGBB"`, exactly as the app stores them. */
export type ChromeColorOverrides = Readonly<Record<string, string>>;

// ── color utilities ─────────────────────────────────────────────────────────────────

export interface Rgb {
    readonly r: number;
    readonly g: number;
    readonly b: number;
}

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

/** Parses `RRGGBB` / `#RRGGBB` into 0..255 components; anything else is null. */
export function parseHexColor(value: string): Rgb | null {
    const match = HEX_RE.exec(value.trim());
    if (match === null) return null;
    const hex = match[1] as string;
    return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16)
    };
}

export function normalizeHexColor(value: string): string | null {
    const rgb = parseHexColor(value);
    if (rgb === null) return null;
    const part = (component: number): string => component.toString(16).padStart(2, '0').toUpperCase();
    return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/**
 * `rgba(...)` from a hex + alpha.
 *
 * A **`var(--nex-x, #hex)` token** (what `tokens.ts` hands every component) is not a hex, and
 * returning it unchanged dropped the alpha silently: `withAlpha(tokens.accent, 0.18)` painted
 * the accent at FULL strength, which is why a selected settings tab, a selected profile row and
 * an armed key recorder all wore a solid periwinkle slab instead of an 18 % tint (the audit
 * read it as "selected text rather than a selected nav item" — run-B's nit list). Those keep
 * the live variable, so they are mixed in CSS rather than resolved here.
 *
 * Anything that is neither a hex nor a CSS colour expression still passes through unchanged —
 * a bad input must not become a valid-but-wrong declaration.
 */
export function withAlpha(color: string, alpha: number): string {
    const clamped = Math.min(1, Math.max(0, alpha));
    const rgb = parseHexColor(color);
    if (rgb !== null) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamped})`;
    if (/^(var|color-mix|rgb|rgba|hsl|hsla|oklch|lab)\(/i.test(color.trim())) {
        return `color-mix(in srgb, ${color} ${(clamped * 100).toFixed(2).replace(/\.?0+$/, '')}%, transparent)`;
    }
    return color;
}

/**
 * `color` at `alpha`, composited over an opaque `base`, as an opaque `#RRGGBB`.
 *
 * The caller that needs this is the content pane's sandboxed frame (content-panes.md §3.8 +
 * `content/ContentFrame.tsx`): the pane container paints `rgba(ghostty-bg, opacity)` over the
 * window, but a sandboxed out-of-process iframe cannot composite through to it — it paints its
 * own surface over Chromium's white base. Flattening the same two colors the container uses
 * gives the FRAME a background pixel-identical to the composite it can no longer join. An
 * unparseable input degrades to whichever half parses, then to the base string itself.
 */
export function flattenOver(color: string, alpha: number, base: string): string {
    const top = parseHexColor(color);
    const bottom = parseHexColor(base);
    if (top === null) return normalizeHexColor(base) ?? base;
    if (bottom === null) return normalizeHexColor(color) ?? color;
    const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
    const mix = (over: number, under: number): number => Math.round(over * a + under * (1 - a));
    const part = (component: number): string => component.toString(16).padStart(2, '0').toUpperCase();
    return `#${part(mix(top.r, bottom.r))}${part(mix(top.g, bottom.g))}${part(mix(top.b, bottom.b))}`;
}

/**
 * Perceived luminance, `0.299r + 0.587g + 0.114b` over sRGB in 0..1 — the exact formula the
 * app uses for both the content-pane dark-mode rule (content-panes.md §3.1) and label chip
 * text color (app-state-core.md §6.3).
 */
export function perceivedLuminance(color: string): number {
    const rgb = parseHexColor(color);
    if (rgb === null) return 0;
    return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

/** content-panes.md §3.1: `isDark = luminance < 0.5`. */
export function isDarkBackground(color: string): boolean {
    return perceivedLuminance(color) < 0.5;
}

/**
 * The light/dark bucket a **ghostty background color** implies for content panes. Port note 9:
 * derived from the background's luminance, NOT the OS theme.
 */
export function ghosttyBucket(backgroundColor: string): ChromeBucket {
    return isDarkBackground(backgroundColor) ? 'dark' : 'light';
}

/** app-state-core.md §6.3: black when luminance > 0.6, else white. */
export function autoTextColor(background: string): string {
    return perceivedLuminance(background) > 0.6 ? '#000000' : '#FFFFFF';
}

// ── resolution ──────────────────────────────────────────────────────────────────────

export interface ChromeThemeInput {
    readonly appearance?: ChromeAppearance | undefined;
    /** The OS color scheme; consulted only when appearance is `system`. */
    readonly systemDark?: boolean | undefined;
    readonly overrides?: ChromeColorOverrides | undefined;
}

export function chromeBucket(appearance: ChromeAppearance, systemDark: boolean): ChromeBucket {
    if (appearance === 'light') return 'light';
    if (appearance === 'dark') return 'dark';
    return systemDark ? 'dark' : 'light';
}

/**
 * §2 resolution algorithm: preset for the resolved bucket, then every valid `<bucket>:<key>`
 * override applied on top. Overriding `accent` ALSO rewrites `selectionStroke` (same value)
 * and `selectionFill` (accent @ 0.18).
 */
export function resolveChromeTheme(input: ChromeThemeInput = {}): ChromeTheme {
    const appearance = input.appearance ?? 'system';
    const bucket = chromeBucket(appearance, input.systemDark ?? false);
    const base = presetChromeTheme(bucket);
    const overrides = input.overrides;
    if (overrides === undefined) return base;

    const resolved: Record<string, string | number> = { ...base };
    for (const key of OVERRIDABLE_CHROME_KEYS) {
        const raw = overrides[`${bucket}:${key}`];
        if (raw === undefined) continue;
        const hex = normalizeHexColor(raw);
        if (hex === null) continue;
        resolved[key] = hex;
        if (key === 'accent') {
            resolved['selectionStroke'] = hex;
            resolved['selectionFill'] = withAlpha(hex, 0.18);
        }
    }
    return resolved as unknown as ChromeTheme;
}

// ── CSS custom properties ───────────────────────────────────────────────────────────

/**
 * Token → CSS variable name. Assembly owns `:root`; components read these with a literal
 * fallback (`var(--nex-fg, #E6E6EA)`) so a chrome component renders correctly even when it is
 * mounted outside a `ThemeProvider` (tests, storybook-style harnesses).
 */
export const CHROME_CSS_VARS: Readonly<Record<keyof ChromeTheme, string>> = {
    windowBackground: '--nex-bg',
    sidebarBackground: '--nex-sidebar-bg',
    surfaceBackground: '--nex-surface',
    headerBackground: '--nex-header-bg',
    footerBackground: '--nex-footer-bg',
    textPrimary: '--nex-fg',
    textSecondary: '--nex-fg-secondary',
    textTertiary: '--nex-fg-tertiary',
    divider: '--nex-border',
    selectionFill: '--nex-selection-fill',
    selectionStroke: '--nex-selection-stroke',
    accent: '--nex-accent',
    paneFocus: '--nex-pane-focus',
    statusRunning: '--nex-status-running',
    statusWaiting: '--nex-status-waiting',
    statusInactive: '--nex-status-inactive',
    activeAgent: '--nex-active-agent',
    groupBandOpacity: '--nex-group-band-opacity'
};

/**
 * Second spellings the app also answers to. The pane grid (WP3.3) reads `--nex-surface-bg`
 * and `--nex-agent`; emitting both names from one resolve puts every subtree on one palette
 * without either module importing the other's naming choice.
 */
export const CHROME_CSS_VAR_ALIASES: Readonly<Record<string, string>> = {
    '--nex-surface-bg': '--nex-surface',
    '--nex-agent': '--nex-active-agent'
};

export interface ChromeCssVarOptions {
    /**
     * The ghostty `background-opacity` (APP-012 / SET-049). Below 1 the WINDOW fill —
     * `--nex-bg`, which `<body>`, the pane grid's gutters and the app root all paint — is
     * emitted as `rgba(…, opacity)` rather than an opaque hex, so a window the Electron shell
     * created transparent lets the desktop through everywhere the client is not deliberately
     * opaque (the sidebar, the header, popovers, the settings dialog).
     *
     * It belongs here rather than in each component for the same reason the sidebar tint knobs
     * do: `--nex-bg` is read in a dozen places and one assignment reaches all of them. The
     * default (1, or absent) emits exactly what it always did, byte for byte.
     */
    readonly windowOpacity?: number | undefined;
}

/** The theme as a `{ '--nex-*': value }` map, ready for an inline `style` or `:root` block. */
export function chromeThemeCssVars(
    theme: ChromeTheme,
    options: ChromeCssVarOptions = {}
): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [token, name] of Object.entries(CHROME_CSS_VARS)) {
        const value = theme[token as keyof ChromeTheme];
        vars[name] = typeof value === 'number' ? String(value) : value;
    }
    const opacity = options.windowOpacity;
    if (typeof opacity === 'number' && Number.isFinite(opacity) && opacity < 1) {
        vars[CHROME_CSS_VARS.windowBackground] = withAlpha(
            theme.windowBackground,
            Math.max(0, opacity)
        );
    }
    for (const [alias, canonical] of Object.entries(CHROME_CSS_VAR_ALIASES)) {
        const value = vars[canonical];
        if (value !== undefined) vars[alias] = value;
    }
    return vars;
}

/** The same map as a CSS text block (for a `<style>` tag or a stylesheet write). */
export function chromeThemeCssText(theme: ChromeTheme, selector = ':root'): string {
    const body = Object.entries(chromeThemeCssVars(theme))
        .map(([name, value]) => `  ${name}: ${value};`)
        .join('\n');
    return `${selector} {\n${body}\n}`;
}

/** Writes the tokens onto an element (the ThemeProvider's container, or `documentElement`). */
export function applyChromeTheme(element: ElementStyleTarget, theme: ChromeTheme): void {
    for (const [name, value] of Object.entries(chromeThemeCssVars(theme))) {
        element.style.setProperty(name, value);
    }
}

/** The slice of `HTMLElement` `applyChromeTheme` needs (keeps this module DOM-lib-light). */
export interface ElementStyleTarget {
    readonly style: { setProperty(name: string, value: string): void };
}

// ── workspace colors ────────────────────────────────────────────────────────────────

/**
 * The ten `WorkspaceColor` tokens as concrete hex per bucket. `black` and `white` are the
 * adaptive monochromes described in shell-ui.md §14: black = dark gray in light mode / mid
 * gray in dark, white = light gray / near-white — always visible against the chrome.
 */
export const WORKSPACE_COLOR_HEX: Readonly<Record<WorkspaceColor, Readonly<Record<ChromeBucket, string>>>> = {
    red: { light: '#D0453C', dark: '#F0655C' },
    orange: { light: '#C87A1E', dark: '#E8994A' },
    yellow: { light: '#B99413', dark: '#E0C245' },
    green: { light: '#3F9457', dark: '#5FBE89' },
    blue: { light: '#3D74C0', dark: '#6F9BD8' },
    purple: { light: '#8158C8', dark: '#A98BE8' },
    pink: { light: '#C4508E', dark: '#E683B4' },
    gray: { light: '#8A8A8E', dark: '#9A9AA0' },
    black: { light: '#3A3A3E', dark: '#7A7A82' },
    white: { light: '#C8C8C4', dark: '#E6E6EA' }
};

export function workspaceColorHex(color: WorkspaceColor | null | undefined, bucket: ChromeBucket): string {
    if (color === null || color === undefined) return WORKSPACE_COLOR_HEX.gray[bucket];
    return WORKSPACE_COLOR_HEX[color]?.[bucket] ?? WORKSPACE_COLOR_HEX.gray[bucket];
}

// ── sidebar tint knobs (§2 "Sidebar tint knobs") ────────────────────────────────────

export interface SidebarFillStroke {
    readonly avatarFill: number;
    readonly avatarStroke: number;
    /** -1 means "use `theme.groupBandOpacity`". */
    readonly groupFill: number;
    readonly groupStroke: number;
}

export const DEFAULT_SIDEBAR_FILL_STROKE: SidebarFillStroke = {
    avatarFill: 0.2,
    avatarStroke: 0.45,
    groupFill: -1,
    groupStroke: 0
};

/** "Effective opacity is always `min(1, value * intensity)`." */
export function effectiveOpacity(value: number, intensity: number): number {
    return Math.min(1, Math.max(0, value * intensity));
}

/** The CSS variables the sidebar tint knobs publish (SET-037, SET-038). */
export const SIDEBAR_TINT_VARS = {
    intensity: '--nex-sidebar-intensity',
    avatarFill: '--nex-avatar-fill',
    avatarStroke: '--nex-avatar-stroke',
    groupFill: '--nex-group-fill',
    groupStroke: '--nex-group-stroke'
} as const;

export interface SidebarTint extends SidebarFillStroke {
    /** 0…2; multiplies every value above (SET-037). */
    readonly intensity: number;
}

export const DEFAULT_SIDEBAR_TINT: SidebarTint = { ...DEFAULT_SIDEBAR_FILL_STROKE, intensity: 1 };

/**
 * The tint knobs as CSS variables, ready for the theme container's inline style.
 *
 * **Variables rather than props, and that is the whole design.** The values are read at three
 * places inside a 100 KB `Sidebar.tsx` — the avatar's fill and border, and the group band —
 * each several components deep. Threading a `tint` prop down to them would mean editing a
 * dozen call sites in a file several people work in at once; publishing five numbers on the
 * container the provider already owns means those three places each change by one expression
 * and nothing else in the tree learns a new prop.
 *
 * The `-1` sentinel is resolved HERE (to the bucket's preset band opacity) rather than in CSS,
 * because "use the preset" is a decision about the palette and CSS has no way to express it.
 */
export function sidebarTintCssVars(tint: SidebarTint, theme: ChromeTheme): Record<string, string> {
    const groupFill = tint.groupFill < 0 ? theme.groupBandOpacity : tint.groupFill;
    return {
        [SIDEBAR_TINT_VARS.intensity]: String(tint.intensity),
        [SIDEBAR_TINT_VARS.avatarFill]: String(tint.avatarFill),
        [SIDEBAR_TINT_VARS.avatarStroke]: String(tint.avatarStroke),
        [SIDEBAR_TINT_VARS.groupFill]: String(groupFill),
        [SIDEBAR_TINT_VARS.groupStroke]: String(tint.groupStroke)
    };
}

/**
 * `hex` at `var(<name>) × intensity`, as a CSS expression.
 *
 * `color-mix` clamps its percentage to 0…100 by spec, which is exactly `min(1, value ×
 * intensity)` — so `effectiveOpacity`'s rule holds without a clamp of our own, and the browser
 * recomputes it the instant the variable changes. `fallback` keeps a component correct when it
 * is mounted outside a provider (a fixture, a test), the same contract `tokens.ts` follows.
 */
export function tintedColor(hex: string, variable: string, fallback: number): string {
    return `color-mix(in srgb, ${hex} calc(var(${variable}, ${String(fallback)}) * var(${SIDEBAR_TINT_VARS.intensity}, 1) * 100%), transparent)`;
}

// ── label chips (app-state-core.md §6.3) ────────────────────────────────────────────

export interface LabelColorLike {
    readonly kind: 'named' | 'custom';
    readonly color?: WorkspaceColor;
    readonly hex?: string;
}

export interface LabelPresetLike {
    readonly name: string;
    readonly color: LabelColorLike;
    readonly textColor?: LabelColorLike | null;
}

export interface ResolvedLabelStyle {
    readonly background: string;
    readonly text: string;
}

function labelColorHex(color: LabelColorLike | null | undefined, bucket: ChromeBucket): string | null {
    if (color === null || color === undefined) return null;
    if (color.kind === 'custom') return normalizeHexColor(color.hex ?? '');
    return color.color === undefined ? null : workspaceColorHex(color.color, bucket);
}

/**
 * A chip's colors. A label whose text case-sensitively matches a preset name renders in the
 * preset's colors (explicit text color, else auto black/white by luminance); an unmatched
 * label renders neutral against the chrome.
 */
export function resolveLabelStyle(
    label: string,
    presets: readonly LabelPresetLike[],
    bucket: ChromeBucket,
    theme: ChromeTheme = presetChromeTheme(bucket)
): ResolvedLabelStyle {
    const preset = presets.find((candidate) => candidate.name === label);
    const background = preset === undefined ? null : labelColorHex(preset.color, bucket);
    if (preset === undefined || background === null) {
        return { background: withAlpha(theme.textPrimary, 0.08), text: theme.textSecondary };
    }
    const explicit = labelColorHex(preset.textColor, bucket);
    return { background, text: explicit ?? autoTextColor(background) };
}

// ── shared chrome formatters (§2 "Utility formats") ─────────────────────────────────

/** `chromeHomeAbbreviated`: `/Users/x` → `~`, `/Users/x/a` → `~/a`. */
export function homeAbbreviated(path: string, homeDirectory: string): string {
    if (homeDirectory.length === 0) return path;
    const home = homeDirectory.endsWith('/') ? homeDirectory.slice(0, -1) : homeDirectory;
    if (path === home) return '~';
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
    return path;
}

/**
 * `chromeElapsedLabel(start, now)` (agent-lifecycle.md §9.2): `"Ns"` under a minute,
 * `"Nm Ss"` under an hour, `"Nh Mm"` above; negatives clamp to 0. Both arguments are epoch
 * **milliseconds** (the store's `agentStartedAt` contract).
 */
export function chromeElapsedLabel(startMs: number, nowMs: number): string {
    const total = Math.max(0, Math.floor((nowMs - startMs) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

/** The footer's `HH:MM` clock (zero-padded, 24h — the app uses the OS format; this is stable). */
export function clockLabel(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

/** Middle-truncation used by the footer/popover paths (`/a/very/long/path` → `/a/ve…path`). */
export function middleTruncate(value: string, max: number): string {
    if (max <= 1 || value.length <= max) return value;
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${value.slice(0, head)}…${tail === 0 ? '' : value.slice(value.length - tail)}`;
}
