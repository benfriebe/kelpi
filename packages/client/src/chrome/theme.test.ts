import { describe, expect, it } from 'vitest';

import {
    CHROME_TOKEN_FALLBACKS,
    DARK_CHROME_THEME,
    LIGHT_CHROME_THEME,
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

    it('formats the footer clock and middle-truncates paths', () => {
        expect(clockLabel(new Date(2026, 0, 2, 9, 5))).toBe('09:05');
        expect(middleTruncate('/a/very/long/path/here', 11)).toHaveLength(11);
        expect(middleTruncate('short', 11)).toBe('short');
    });
});
