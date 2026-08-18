import { describe, expect, it } from 'vitest';

import { formatIconString, parseIconString } from './icon.js';

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
