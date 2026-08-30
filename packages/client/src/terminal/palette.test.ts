/**
 * §APP-014 — the resolved theme palette, applied to a client.
 *
 * Two properties matter and both are about what a theme may NOT do: it may not blank a colour
 * it says nothing about (the engines paint `undefined` black), and it may not put a value the
 * engines cannot parse into a pane (ghostty-web maps anything that is not `#rgb` / `#rrggbb` /
 * `rgb()` to black too, which is how a whole terminal goes dark from one bad line in a file).
 */

import { describe, expect, it } from 'vitest';

import { mergeTerminalPalette, terminalPaletteCssVars } from './palette';
import { DEFAULT_TERMINAL_THEME, LIGHT_TERMINAL_THEME } from './renderer';

describe('mergeTerminalPalette', () => {
    it('lays the theme’s colours over the preset and keeps the rest', () => {
        const merged = mergeTerminalPalette(DEFAULT_TERMINAL_THEME, {
            background: '#2e3440',
            foreground: '#d8dee9',
            red: '#bf616a'
        });
        expect(merged.background).toBe('#2e3440');
        expect(merged.foreground).toBe('#d8dee9');
        expect(merged.red).toBe('#bf616a');
        // Untouched by the theme → still the preset's, not undefined.
        expect(merged.brightWhite).toBe(DEFAULT_TERMINAL_THEME.brightWhite);
        expect(merged.selectionBackground).toBe(DEFAULT_TERMINAL_THEME.selectionBackground);
    });

    it('merges over whichever preset it is given (the bucket still decides the base)', () => {
        const merged = mergeTerminalPalette(LIGHT_TERMINAL_THEME, { foreground: '#4c4f69' });
        expect(merged.foreground).toBe('#4c4f69');
        expect(merged.background).toBe(LIGHT_TERMINAL_THEME.background);
    });

    it('returns the base UNCHANGED (same identity) when there is nothing to apply', () => {
        expect(mergeTerminalPalette(DEFAULT_TERMINAL_THEME, {})).toBe(DEFAULT_TERMINAL_THEME);
        expect(mergeTerminalPalette(DEFAULT_TERMINAL_THEME, null)).toBe(DEFAULT_TERMINAL_THEME);
        expect(mergeTerminalPalette(DEFAULT_TERMINAL_THEME, undefined)).toBe(DEFAULT_TERMINAL_THEME);
    });

    it('drops values an engine cannot parse, and keys it does not know', () => {
        const merged = mergeTerminalPalette(DEFAULT_TERMINAL_THEME, {
            foreground: 'rebeccapurple',
            background: 'rgba(0,0,0,0.5)',
            cursor: '#fff',
            nonsense: '#123456'
        });
        expect(merged.foreground).toBe(DEFAULT_TERMINAL_THEME.foreground);
        expect(merged.background).toBe(DEFAULT_TERMINAL_THEME.background);
        expect(merged.cursor).toBe('#fff');
        expect((merged as Record<string, unknown>)['nonsense']).toBeUndefined();
    });
});

describe('terminalPaletteCssVars', () => {
    it('publishes the palette under the terminal token names', () => {
        expect(
            terminalPaletteCssVars({ foreground: '#d8dee9', brightBlue: '#81a1c1', black: '#3b4252' })
        ).toEqual({
            '--kelpi-term-fg': '#d8dee9',
            '--kelpi-term-bright-blue': '#81a1c1',
            '--kelpi-term-black': '#3b4252'
        });
    });

    /**
     * `--kelpi-term-bg` is the pane FILL — the background at the ghostty opacity — and the theme
     * reaches it daemon-side instead (`appearance.backgroundColor`). Emitting an opaque hex
     * here would overwrite the alpha and break window transparency (§APP-012).
     */
    it('never emits --kelpi-term-bg', () => {
        expect(terminalPaletteCssVars({ background: '#2e3440', foreground: '#d8dee9' })).toEqual({
            '--kelpi-term-fg': '#d8dee9'
        });
    });

    it('is empty for no palette at all', () => {
        expect(terminalPaletteCssVars(null)).toEqual({});
        expect(terminalPaletteCssVars({})).toEqual({});
        expect(terminalPaletteCssVars({ foreground: 'not-a-colour' })).toEqual({});
    });
});
