import { describe, expect, it } from 'vitest';

import { formatIconString, iconRefusal, MAX_ICON_SYMBOL_LENGTH, parseIconString } from './icon.js';

describe('icon strings', () => {
    it('parses both prefixes', () => {
        expect(parseIconString('system:star.fill')).toEqual({ kind: 'system', name: 'star.fill' });
        expect(parseIconString('emoji:📁')).toEqual({ kind: 'emoji', grapheme: '📁' });
    });

    it('keeps colons inside the payload', () => {
        expect(parseIconString('system:a:b')).toEqual({ kind: 'system', name: 'a:b' });
    });

    it('returns null for unknown prefix, empty payload and missing separator', () => {
        expect(parseIconString('sfsymbol:star')).toBeNull();
        expect(parseIconString('system:')).toBeNull();
        expect(parseIconString('emoji:')).toBeNull();
        expect(parseIconString('star.fill')).toBeNull();
        expect(parseIconString('')).toBeNull();
        expect(parseIconString(null)).toBeNull();
    });

    it('round-trips', () => {
        expect(formatIconString({ kind: 'system', name: 'star.fill' })).toBe('system:star.fill');
        expect(formatIconString({ kind: 'emoji', grapheme: '📁' })).toBe('emoji:📁');
        expect(parseIconString(formatIconString({ kind: 'emoji', grapheme: '📁' }))).toEqual({
            kind: 'emoji',
            grapheme: '📁'
        });
    });
});

describe('iconRefusal', () => {
    it('accepts one emoji grapheme, ZWJ, flag and skin-tone sequences included', () => {
        for (const grapheme of ['🔥', '👩‍🍳', '🇦🇺', '👍🏽', '❤️', '⌘']) {
            expect(iconRefusal({ kind: 'emoji', grapheme })).toBeNull();
        }
    });

    it('refuses a letter, two emoji and text, naming the payload', () => {
        expect(iconRefusal({ kind: 'emoji', grapheme: 'a' })).toBe("'a' is not a usable icon: give one emoji or symbol");
        expect(iconRefusal({ kind: 'emoji', grapheme: '🔥🔥' })).toBe(
            "'🔥🔥' is not a usable icon: give one emoji or symbol"
        );
        expect(iconRefusal({ kind: 'emoji', grapheme: 'abc' })).not.toBeNull();
        // Surrounding whitespace is not trimmed into acceptance: the stored value must be exact.
        expect(iconRefusal({ kind: 'emoji', grapheme: ' 🔥' })).not.toBeNull();
    });

    it('refuses one grapheme longer than any emoji without echoing it back', () => {
        const chain = Array.from({ length: 2000 }, () => '🔥').join('\u200d');
        expect(iconRefusal({ kind: 'emoji', grapheme: chain })).toBe('the icon is too long: give one emoji or symbol');
        expect(iconRefusal({ kind: 'emoji', grapheme: `🔥${'\u0301'.repeat(1000)}` })).toBe(
            'the icon is too long: give one emoji or symbol'
        );
        expect(iconRefusal({ kind: 'emoji', grapheme: '👩🏻‍❤️‍💋‍👨🏼' })).toBeNull();
    });

    it('treats a system symbol as an opaque token, refused only when over-long', () => {
        expect(iconRefusal({ kind: 'system', name: 'star.fill' })).toBeNull();
        expect(iconRefusal({ kind: 'system', name: 'a'.repeat(MAX_ICON_SYMBOL_LENGTH) })).toBeNull();
        expect(iconRefusal({ kind: 'system', name: 'a'.repeat(MAX_ICON_SYMBOL_LENGTH + 1) })).toBe(
            'the symbol name is too long: at most 128 characters'
        );
    });
});
