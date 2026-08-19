import { describe, expect, it } from 'vitest';

import { isDarkBackground } from '../content/html.js';
import { DEFAULT_GHOSTTY_APPEARANCE, parseGhosttyAppearance, parseGhosttyColor } from './ghostty.js';

describe('parseGhosttyColor', () => {
    it('accepts the hex spellings ghostty writes, with or without the hash', () => {
        expect(parseGhosttyColor('#1A1B26')).toBe('#1a1b26');
        expect(parseGhosttyColor('1a1b26')).toBe('#1a1b26');
        expect(parseGhosttyColor('  #FFF  ')).toBe('#ffffff');
        expect(parseGhosttyColor('abc')).toBe('#aabbcc');
    });

    it('refuses anything it cannot be sure about', () => {
        // Named colors and rgb() would silently become black in the engines; the caller keeps
        // its previous value instead.
        expect(parseGhosttyColor('black')).toBeNull();
        expect(parseGhosttyColor('rgb(0,0,0)')).toBeNull();
        expect(parseGhosttyColor('#12345')).toBeNull();
        expect(parseGhosttyColor('')).toBeNull();
    });
});

describe('parseGhosttyAppearance', () => {
    it('reads the five keys and ignores everything else', () => {
        const appearance = parseGhosttyAppearance(`# my ghostty config
background = #ffffff
background-opacity = 0.85
font-family = JetBrains Mono
font-size = 15
theme = Catppuccin Latte
window-padding-x = 8
keybind = cmd+t=new_tab
mouse-hide-while-typing = true
`);
        expect(appearance).toEqual({
            backgroundColor: '#ffffff',
            backgroundOpacity: 0.85,
            fontFamily: '"JetBrains Mono"',
            fontSize: 15,
            theme: 'Catppuccin Latte'
        });
    });

    it('is the defaults for an empty or comment-only file', () => {
        expect(parseGhosttyAppearance('')).toEqual(DEFAULT_GHOSTTY_APPEARANCE);
        expect(parseGhosttyAppearance('# nothing here\n\n')).toEqual(DEFAULT_GHOSTTY_APPEARANCE);
    });

    it('keeps the default for a value it cannot parse', () => {
        const appearance = parseGhosttyAppearance('background = mauve\nfont-size = huge\n');
        expect(appearance.backgroundColor).toBe(DEFAULT_GHOSTTY_APPEARANCE.backgroundColor);
        expect(appearance.fontSize).toBeNull();
    });

    it('lets a later line win for a scalar key', () => {
        expect(parseGhosttyAppearance('background = #000000\nbackground = #ffffff\n').backgroundColor).toBe(
            '#ffffff'
        );
    });

    it('accumulates font-family lines into a CSS stack, and an empty value resets it', () => {
        expect(parseGhosttyAppearance('font-family = Menlo\nfont-family = "Apple Color Emoji"\n').fontFamily).toBe(
            'Menlo, "Apple Color Emoji"'
        );
        expect(parseGhosttyAppearance('font-family = Menlo\nfont-family = \nfont-family = Monaco\n').fontFamily).toBe(
            'Monaco'
        );
        expect(parseGhosttyAppearance('font-family = Menlo\nfont-family = Menlo\n').fontFamily).toBe('Menlo');
    });

    it('clamps background-opacity into 0..1', () => {
        expect(parseGhosttyAppearance('background-opacity = 2\n').backgroundOpacity).toBe(1);
        expect(parseGhosttyAppearance('background-opacity = -1\n').backgroundOpacity).toBe(0);
        expect(parseGhosttyAppearance('background-opacity = 0\n').backgroundOpacity).toBe(0);
    });

    it('feeds the luminance rule that picks light vs dark (content-panes.md §3.1)', () => {
        expect(isDarkBackground(parseGhosttyAppearance('background = #1a1b26\n').backgroundColor)).toBe(true);
        expect(isDarkBackground(parseGhosttyAppearance('background = #eff1f5\n').backgroundColor)).toBe(false);
        // 0.299r+0.587g+0.114b straddles 0.5 on green far from where a naive average would.
        expect(isDarkBackground(parseGhosttyAppearance('background = #008000\n').backgroundColor)).toBe(true);
        expect(isDarkBackground(parseGhosttyAppearance('background = #00e000\n').backgroundColor)).toBe(false);
    });
});
