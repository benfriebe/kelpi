import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChromeIcon, GENERIC_ICON_GLYPH, avatarLetter, iconGlyph, iconIsTintable } from './index';

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
});
