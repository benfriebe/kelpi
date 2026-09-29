import { describe, expect, it } from 'vitest';

import { sanitizedGitName } from './index.js';

describe('sanitizedGitName', () => {
    it('is a fixed point for an already-valid name', () => {
        expect(sanitizedGitName('feature/foo.bar_baz-1')).toBe('feature/foo.bar_baz-1');
    });

    it('collapses unsafe runs to a single hyphen and preserves case', () => {
        expect(sanitizedGitName('My Feature!!')).toBe('My-Feature');
        expect(sanitizedGitName('a  b   c')).toBe('a-b-c');
    });

    it('collapses repeated separators', () => {
        expect(sanitizedGitName('a--b//c..d')).toBe('a-b/c.d');
    });

    it('trims leading and trailing separator characters (space included)', () => {
        expect(sanitizedGitName('  /.-_feature-_./  ')).toBe('feature');
    });

    it('returns null when nothing survives', () => {
        expect(sanitizedGitName('   ')).toBeNull();
        expect(sanitizedGitName('///')).toBeNull();
        expect(sanitizedGitName('!!!')).toBeNull();
        expect(sanitizedGitName('🚀✨')).toBeNull();
    });

    it('turns non-ASCII runs into a hyphen and keeps any length', () => {
        expect(sanitizedGitName('café crème')).toBe('caf-cr-me');
        expect(sanitizedGitName('x'.repeat(300))).toBe('x'.repeat(300));
    });
});
