import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    CURATED_EMOJI,
    CURATED_SYMBOL_ICONS,
    ChromeIcon,
    GENERIC_ICON_GLYPH,
    avatarLetter,
    formatIconToken,
    iconGlyph,
    iconIsTintable,
    isSingleGrapheme,
    normalizeEmojiInput
} from './index';

afterEach(cleanup);

describe('IconRef tokens', () => {
    // PLAN.md: SF Symbol names round-trip as opaque tokens; the client maps the ones it knows
    // and falls back to a generic glyph rather than dropping the icon.
    it('maps the curated symbol set', () => {
        expect(iconGlyph({ kind: 'system', name: 'star.fill' })).toBe('★');
        expect(iconGlyph({ kind: 'system', name: 'hammer' })).toBe('⚒');
        expect(iconGlyph({ kind: 'system', name: 'testtube.2' })).toBe('⚗');
    });

    it('falls back for an unknown symbol name', () => {
        expect(iconGlyph({ kind: 'system', name: 'newer.app.only' })).toBe(GENERIC_ICON_GLYPH);
    });

    it('passes emoji through and refuses to tint them', () => {
        expect(iconGlyph({ kind: 'emoji', grapheme: '🚀' })).toBe('🚀');
        expect(iconIsTintable({ kind: 'emoji', grapheme: '🚀' })).toBe(false);
        expect(iconIsTintable({ kind: 'system', name: 'folder' })).toBe(true);
    });

    it('has no glyph without an icon (the letter avatar takes over)', () => {
        expect(iconGlyph(null)).toBeNull();
        expect(iconGlyph(undefined)).toBeNull();
    });
});

describe('avatarLetter', () => {
    it('uppercases the first grapheme, and answers "?" for an empty name', () => {
        expect(avatarLetter('alpha')).toBe('A');
        expect(avatarLetter('  beta')).toBe('B');
        expect(avatarLetter('')).toBe('?');
        expect(avatarLetter('   ')).toBe('?');
        expect(avatarLetter('🚀 launch')).toBe('🚀');
    });
});

describe('the Change Icon picker (§5.6)', () => {
    it('offers the curated sets the doc names, all of them drawable', () => {
        expect(CURATED_SYMBOL_ICONS.map((choice) => choice.label)).toEqual([
            'Folder',
            'Tray',
            'Archive',
            'Star',
            'Flag',
            'Pin',
            'Bookmark',
            'Build',
            'Tests',
            'Terminal',
            'Package',
            'Docs',
            'AI'
        ]);
        for (const choice of CURATED_SYMBOL_ICONS) {
            expect(iconGlyph({ kind: 'system', name: choice.name })).not.toBe(GENERIC_ICON_GLYPH);
        }
        expect(CURATED_EMOJI).toContain('🔥');
        expect(CURATED_EMOJI).toHaveLength(12);
    });

    it('formats the flat DB token both ways round', () => {
        expect(formatIconToken({ kind: 'emoji', grapheme: '🔥' })).toBe('emoji:🔥');
        expect(formatIconToken({ kind: 'system', name: 'star' })).toBe('system:star');
        // An unmapped token still round-trips: the client sets what it cannot draw.
        expect(formatIconToken({ kind: 'system', name: 'newer.app.only' })).toBe('system:newer.app.only');
        expect(formatIconToken(null)).toBeNull();
    });

    it('accepts exactly one grapheme cluster in the custom field', () => {
        expect(isSingleGrapheme('🔥')).toBe(true);
        // One grapheme, five code points — the reason `[...value].length` is not the check.
        expect(isSingleGrapheme('👩‍👩‍👧')).toBe(true);
        expect(isSingleGrapheme('🇦🇺')).toBe(true);
        expect(isSingleGrapheme('a')).toBe(true);
        expect(isSingleGrapheme('ab')).toBe(false);
        expect(isSingleGrapheme('🔥🔥')).toBe(false);
        expect(isSingleGrapheme('')).toBe(false);
    });

    it('trims before validating, and rejects anything longer', () => {
        expect(normalizeEmojiInput('  🚀  ')).toBe('🚀');
        expect(normalizeEmojiInput('   ')).toBeNull();
        expect(normalizeEmojiInput('no')).toBeNull();
    });
});

describe('ChromeIcon', () => {
    it('renders an aria-hidden glyph by default and a labelled one on request', () => {
        const view = render(<ChromeIcon name="search" />);
        const svg = view.container.querySelector('svg') as SVGElement;
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('data-icon')).toBe('search');

        view.rerender(<ChromeIcon name="branch" title="Git branch" size={9} />);
        expect(screen.getByTitle('Git branch')).toBeDefined();
        expect(view.container.querySelector('svg')?.getAttribute('width')).toBe('9');
    });

    /**
     * #7 - the inspector toggle moved to the trailing edge and took the sidebar glyph with it,
     * flipped. "Flipped" has to be exact or the two ends of the title bar stop being each other's
     * mirror: same rectangle, divider reflected through the 12-unit grid's centre.
     */
    it('mirrors the sidebar glyph for the trailing inspector toggle', () => {
        const left = render(<ChromeIcon name="sidebar" />);
        const right = render(<ChromeIcon name="sidebar-right" />);
        const frame = (view: typeof left): (string | null | undefined)[] => {
            const rect = view.container.querySelector('rect');
            return [rect?.getAttribute('x'), rect?.getAttribute('width')];
        };
        expect(frame(left)).toEqual(['1.6', '8.8']);
        expect(frame(right)).toEqual(frame(left));
        expect(left.container.querySelector('path')?.getAttribute('d')).toBe('M4.6 2.2v7.6');
        // 12 - 4.6. Anything else is a similar drawing rather than the same one flipped.
        expect(right.container.querySelector('path')?.getAttribute('d')).toBe('M7.4 2.2v7.6');
    });
});
