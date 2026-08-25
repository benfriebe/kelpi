import { describe, expect, it } from 'vitest';

import {
    CHROME_TOKEN_FALLBACKS,
    DARK_CHROME_THEME,
    DEFAULT_SIDEBAR_TINT,
    LIGHT_CHROME_THEME,
    SIDEBAR_TINT_VARS,
    autoTextColor,
    chromeBucket,
    chromeElapsedLabel,
    chromeThemeCssVars,
    clockLabel,
    ghosttyBucket,
    homeAbbreviated,
    isDarkBackground,
    middleTruncate,
    normalizeHexColor,
    perceivedLuminance,
    presetChromeTheme,
    resolveChromeTheme,
    resolveLabelStyle,
    sidebarTintCssVars,
    tintedColor,
    flattenOver,
    withAlpha,
    workspaceColorHex
} from './index';

describe('ghostty background luminance rule', () => {
    // content-panes.md §3.1 + port note 9: content panes pick light/dark from the terminal
    // background's LUMINANCE, never from the OS theme.
    it('switches bucket at luminance 0.5', () => {
        expect(ghosttyBucket('#1E1E1E')).toBe('dark');
        expect(ghosttyBucket('#000000')).toBe('dark');
        expect(ghosttyBucket('#FFFFFF')).toBe('light');
        expect(ghosttyBucket('#FDF6E3')).toBe('light'); // solarized light
        expect(ghosttyBucket('#282C34')).toBe('dark'); // one dark
    });

    it('uses 0.299r + 0.587g + 0.114b, so a saturated green is LIGHT and a blue is DARK', () => {
        expect(perceivedLuminance('#00FF00')).toBeCloseTo(0.587, 3);
        expect(isDarkBackground('#00FF00')).toBe(false);
        expect(perceivedLuminance('#0000FF')).toBeCloseTo(0.114, 3);
        expect(isDarkBackground('#0000FF')).toBe(true);
    });

    it('is independent of the chrome appearance decision', () => {
        expect(chromeBucket('light', true)).toBe('light');
        expect(chromeBucket('dark', false)).toBe('dark');
        expect(chromeBucket('system', true)).toBe('dark');
        expect(chromeBucket('system', false)).toBe('light');
    });

    it('treats an unparseable color as black rather than throwing', () => {
        expect(perceivedLuminance('not-a-color')).toBe(0);
        expect(ghosttyBucket('')).toBe('dark');
    });
});

describe('resolveChromeTheme', () => {
    it('returns the preset for the resolved bucket', () => {
        expect(resolveChromeTheme({ appearance: 'dark' })).toEqual(DARK_CHROME_THEME);
        expect(resolveChromeTheme({ appearance: 'light' })).toEqual(LIGHT_CHROME_THEME);
        expect(resolveChromeTheme({ appearance: 'system', systemDark: true })).toEqual(DARK_CHROME_THEME);
    });

    it('applies `<bucket>:<key>` overrides only for the resolved bucket', () => {
        const overrides = { 'dark:sidebarBackground': '112233', 'light:sidebarBackground': 'AABBCC' };
        expect(resolveChromeTheme({ appearance: 'dark', overrides }).sidebarBackground).toBe('#112233');
        expect(resolveChromeTheme({ appearance: 'light', overrides }).sidebarBackground).toBe('#AABBCC');
    });

    it('an accent override also rewrites selectionStroke and selectionFill (§2)', () => {
        const theme = resolveChromeTheme({ appearance: 'dark', overrides: { 'dark:accent': '#FF8800' } });
        expect(theme.accent).toBe('#FF8800');
        expect(theme.selectionStroke).toBe('#FF8800');
        expect(theme.selectionFill).toBe('rgba(255, 136, 0, 0.18)');
    });

    it('ignores malformed hex and non-overridable keys', () => {
        const theme = resolveChromeTheme({
            appearance: 'dark',
            overrides: { 'dark:accent': 'nope', 'dark:textPrimary': '#FF0000' }
        });
        expect(theme.accent).toBe(DARK_CHROME_THEME.accent);
        expect(theme.textPrimary).toBe(DARK_CHROME_THEME.textPrimary);
    });
});

describe('CSS custom properties', () => {
    it('emits every token plus the grid aliases', () => {
        const vars = chromeThemeCssVars(presetChromeTheme('dark'));
        expect(vars['--nex-bg']).toBe(DARK_CHROME_THEME.windowBackground);
        expect(vars['--nex-fg']).toBe(DARK_CHROME_THEME.textPrimary);
        expect(vars['--nex-group-band-opacity']).toBe('0.22');
        expect(vars['--nex-surface-bg']).toBe(vars['--nex-surface']);
        expect(vars['--nex-agent']).toBe(vars['--nex-active-agent']);
    });

    it('the token fallbacks are the dark preset (drift guard)', () => {
        const vars = chromeThemeCssVars(presetChromeTheme('dark'));
        for (const [name, fallback] of Object.entries(CHROME_TOKEN_FALLBACKS)) {
            expect([name, vars[name]]).toEqual([name, fallback]);
        }
    });
});

describe('color helpers', () => {
    it('normalizes and alpha-blends hex', () => {
        expect(normalizeHexColor('5e8ac4')).toBe('#5E8AC4');
        expect(normalizeHexColor('#zzz')).toBeNull();
        expect(withAlpha('#5E8AC4', 0.5)).toBe('rgba(94, 138, 196, 0.5)');
        expect(withAlpha('garbage', 0.5)).toBe('garbage');
    });

    /**
     * A `var(--nex-x, #hex)` token used to pass through unchanged, so the alpha vanished and the
     * "tinted" surfaces (selected settings tab, selected profile row, armed key recorder) painted
     * a solid accent slab — run-B's "reads as selected text" nit. Mixing keeps the live variable,
     * so a user theme's accent still wins.
     */
    it('mixes a CSS variable rather than dropping its alpha', () => {
        expect(withAlpha('var(--nex-accent, #6F9BD8)', 0.18)).toBe(
            'color-mix(in srgb, var(--nex-accent, #6F9BD8) 18%, transparent)'
        );
        expect(withAlpha('var(--nex-accent, #6F9BD8)', 0.125)).toBe(
            'color-mix(in srgb, var(--nex-accent, #6F9BD8) 12.5%, transparent)'
        );
    });

    /**
     * The content pane's sandboxed frame paints this instead of compositing (run-B L1): an
     * opaque-origin iframe is out-of-process and cannot see through to the pane container, so
     * the client hands it the composite the container would have produced.
     */
    it('flattens a translucent pane fill over the window background', () => {
        expect(flattenOver('#FFFFFF', 0.5, '#000000')).toBe('#808080');
        expect(flattenOver('#1A1B26', 1, '#EAE8E2')).toBe('#1A1B26'); // opaque → the fill itself
        expect(flattenOver('#1A1B26', 0, '#EAE8E2')).toBe('#EAE8E2'); // invisible → the base
        expect(flattenOver('#1A1B26', 2, '#EAE8E2')).toBe('#1A1B26'); // alpha clamps to 0..1
        expect(flattenOver('#1A1B26', Number.NaN, '#EAE8E2')).toBe('#1A1B26'); // NaN → opaque
        expect(flattenOver('garbage', 0.5, '#EAE8E2')).toBe('#EAE8E2'); // degrade to the half
        expect(flattenOver('#1A1B26', 0.5, 'garbage')).toBe('#1A1B26'); // that still parses
    });

    it('picks label text by luminance (> 0.6 → black)', () => {
        expect(autoTextColor('#FFFFFF')).toBe('#000000');
        expect(autoTextColor('#101013')).toBe('#FFFFFF');
    });

    it('workspace colors have per-bucket variants for the adaptive monochromes', () => {
        expect(workspaceColorHex('black', 'light')).not.toBe(workspaceColorHex('black', 'dark'));
        expect(workspaceColorHex(null, 'dark')).toBe(workspaceColorHex('gray', 'dark'));
    });

    it('styles a chip from a matching preset and neutrally otherwise', () => {
        const presets = [{ name: 'infra', color: { kind: 'named' as const, color: 'blue' as const } }];
        const matched = resolveLabelStyle('infra', presets, 'dark');
        expect(matched.background).toBe(workspaceColorHex('blue', 'dark'));
        const unmatched = resolveLabelStyle('Infra', presets, 'dark'); // case-SENSITIVE identity
        expect(unmatched.background).not.toBe(matched.background);
    });
});

describe('chrome formatters', () => {
    it('abbreviates the home directory', () => {
        expect(homeAbbreviated('/Users/x', '/Users/x')).toBe('~');
        expect(homeAbbreviated('/Users/x/code/nex', '/Users/x')).toBe('~/code/nex');
        expect(homeAbbreviated('/opt/nex', '/Users/x')).toBe('/opt/nex');
        expect(homeAbbreviated('/Users/x/code', '')).toBe('/Users/x/code');
    });

    it('formats elapsed labels from epoch milliseconds', () => {
        const start = 1_000_000;
        expect(chromeElapsedLabel(start, start + 9_000)).toBe('9s');
        expect(chromeElapsedLabel(start, start + 249_000)).toBe('4m 9s');
        expect(chromeElapsedLabel(start, start + 3_780_000)).toBe('1h 3m');
        expect(chromeElapsedLabel(start, start - 5_000)).toBe('0s');
    });

    /*
     * §M23: this read `toBe('09:05')`, which is only the right answer in a 24-hour locale — it
     * passed because the runner's locale happens to be one, and zero-padded 24 h is the very
     * format the finding says the port must stop hard-coding. Swapped one-for-one for the same
     * instant read through the two locales that disagree about it, plus a runtime-locale read
     * that still pins the hour and the minute.
     */
    it('formats the footer clock in the viewer’s locale and middle-truncates paths', () => {
        const at = new Date(2026, 0, 2, 9, 5);
        // A 12-hour locale drops the leading zero and carries the period (ICU may separate it
        // with a narrow no-break space, so the gap is matched rather than spelled).
        expect(clockLabel(at, 'en-US')).toMatch(/^9:05\s?AM$/);
        // A 24-hour one keeps the padding, because the locale's own hour pattern does — which is
        // what the old hard-coded format assumed for everybody, and what a bare `hour: 'numeric'`
        // would have thrown away (it renders `9:05` here).
        expect(clockLabel(at, 'en-GB')).toBe('09:05');
        // Neither carries seconds: this is the hour+minute skeleton, not a full time.
        expect(clockLabel(new Date(2026, 0, 2, 9, 5, 47), 'en-GB')).toBe('09:05');
        // And with no locale named it is whatever this machine says: hour and minute, no seconds.
        expect(clockLabel(at)).toMatch(/\b0?9[:.]05\b/);
        expect(middleTruncate('/a/very/long/path/here', 11)).toHaveLength(11);
        expect(middleTruncate('short', 11)).toBe('short');
    });
});

// ── sidebar tint knobs (SET-037, SET-038) ───────────────────────────────────────────

describe('sidebarTintCssVars', () => {
    it('publishes all five knobs as variables', () => {
        const vars = sidebarTintCssVars(
            { intensity: 1.4, avatarFill: 0.3, avatarStroke: 0.6, groupFill: 0.25, groupStroke: 0.1 },
            DARK_CHROME_THEME
        );
        expect(vars).toEqual({
            '--nex-sidebar-intensity': '1.4',
            '--nex-avatar-fill': '0.3',
            '--nex-avatar-stroke': '0.6',
            '--nex-group-fill': '0.25',
            '--nex-group-stroke': '0.1'
        });
    });

    /**
     * The `-1` sentinel is resolved HERE, not in CSS: "use the appearance preset" is a decision
     * about the palette, and the two buckets have different band opacities (0.22 dark, 0.3
     * light) — a CSS fallback could only ever bake in one of them.
     */
    it('resolves the -1 group-fill sentinel to the bucket’s preset band opacity', () => {
        const dark = sidebarTintCssVars({ ...DEFAULT_SIDEBAR_TINT }, DARK_CHROME_THEME);
        expect(dark['--nex-group-fill']).toBe(String(DARK_CHROME_THEME.groupBandOpacity));
        const light = sidebarTintCssVars({ ...DEFAULT_SIDEBAR_TINT }, LIGHT_CHROME_THEME);
        expect(light['--nex-group-fill']).toBe(String(LIGHT_CHROME_THEME.groupBandOpacity));
    });
});

describe('tintedColor', () => {
    it('multiplies the knob by the intensity, in CSS', () => {
        const expression = tintedColor('#6F9BD8', SIDEBAR_TINT_VARS.avatarFill, 0.2);
        expect(expression).toContain('#6F9BD8');
        expect(expression).toContain('var(--nex-avatar-fill, 0.2)');
        expect(expression).toContain('var(--nex-sidebar-intensity, 1)');
        // `color-mix` clamps its percentage to 0…100 by spec, which IS `min(1, value ×
        // intensity)` — so the Swift `effectiveOpacity` rule holds without a clamp of our own.
        expect(expression.startsWith('color-mix(in srgb,')).toBe(true);
    });

    it('carries the shipped default as the out-of-provider fallback', () => {
        expect(tintedColor('#fff', SIDEBAR_TINT_VARS.avatarStroke, 0.45)).toContain(
            'var(--nex-avatar-stroke, 0.45)'
        );
    });
});

// APP-012 / SET-049 — the window fill follows the ghostty opacity so a transparent Electron
// window shows the desktop through everything the client does not paint opaquely.
describe('chromeThemeCssVars windowOpacity', () => {
    it('emits an opaque --nex-bg by default, byte for byte', () => {
        const theme = presetChromeTheme('dark');
        expect(chromeThemeCssVars(theme)['--nex-bg']).toBe(theme.windowBackground);
        expect(chromeThemeCssVars(theme, {})['--nex-bg']).toBe(theme.windowBackground);
        expect(chromeThemeCssVars(theme, { windowOpacity: 1 })['--nex-bg']).toBe(theme.windowBackground);
    });

    it('emits rgba below 1, and carries it to the alias the pane grid reads', () => {
        const theme = presetChromeTheme('dark');
        const vars = chromeThemeCssVars(theme, { windowOpacity: 0.85 });
        expect(vars['--nex-bg']).toBe(withAlpha(theme.windowBackground, 0.85));
        expect(vars['--nex-bg']).toContain('rgba(');
        // Only the WINDOW fill gains alpha: the sidebar, header and surfaces stay opaque, which
        // is what keeps chrome legible over an arbitrary desktop.
        expect(vars['--nex-sidebar-bg']).toBe(theme.sidebarBackground);
        expect(vars['--nex-surface']).toBe(theme.surfaceBackground);
    });

    it('clamps a nonsense opacity rather than emitting an invalid colour', () => {
        const theme = presetChromeTheme('dark');
        expect(chromeThemeCssVars(theme, { windowOpacity: -3 })['--nex-bg']).toBe(
            withAlpha(theme.windowBackground, 0)
        );
        expect(chromeThemeCssVars(theme, { windowOpacity: Number.NaN })['--nex-bg']).toBe(
            theme.windowBackground
        );
    });
});

/**
 * §N17 — the GROUND is a second, separate answer, and it is the one that stops alpha stacking.
 *
 * `--nex-bg` gaining alpha is not enough on its own: FIVE elements painted it — `<body>`, the
 * app root, the grid container, every pane wrapper, every pane body — and alpha multiplies, so
 * 0.85 came out at 1 − 0.15⁵ = 0.99992 and the owner saw a solid pane. `--nex-window-fill` is
 * what the two GROUND elements paint instead, and below opacity 1 it paints nothing at all:
 * `RootChromeView.swift:32-39` skips its opaque backdrop entirely "with `background-opacity <
 * 1`", leaving each pane's own fill as the single translucent layer over the desktop.
 */
describe('chromeThemeCssVars window ground (--nex-window-fill)', () => {
    it('is the window background, byte for byte, at the default opacity', () => {
        const theme = presetChromeTheme('dark');
        expect(chromeThemeCssVars(theme)['--nex-window-fill']).toBe(theme.windowBackground);
        expect(chromeThemeCssVars(theme, {})['--nex-window-fill']).toBe(theme.windowBackground);
        expect(chromeThemeCssVars(theme, { windowOpacity: 1 })['--nex-window-fill']).toBe(
            theme.windowBackground
        );
        // A nonsense opacity is not a transparent window.
        expect(chromeThemeCssVars(theme, { windowOpacity: Number.NaN })['--nex-window-fill']).toBe(
            theme.windowBackground
        );
    });

    it('paints nothing below 1, while --nex-bg keeps its alpha for the gaps', () => {
        const theme = presetChromeTheme('dark');
        const vars = chromeThemeCssVars(theme, { windowOpacity: 0.85 });
        expect(vars['--nex-window-fill']).toBe('transparent');
        // Deliberately two different answers: the gap colour still carries alpha, so a
        // placeholder or a popover that reads `--nex-bg` is translucent rather than absent.
        expect(vars['--nex-bg']).toBe(withAlpha(theme.windowBackground, 0.85));
    });

    it('follows the light preset too, so the ground is never a dark hex on a light chrome', () => {
        const light = presetChromeTheme('light');
        expect(chromeThemeCssVars(light)['--nex-window-fill']).toBe(light.windowBackground);
        expect(chromeThemeCssVars(light, { windowOpacity: 0.5 })['--nex-window-fill']).toBe(
            'transparent'
        );
    });

    it('is a real token, so a component mounted without a provider still has a ground', () => {
        expect(CHROME_TOKEN_FALLBACKS['--nex-window-fill']).toBe(CHROME_TOKEN_FALLBACKS['--nex-bg']);
    });
});
