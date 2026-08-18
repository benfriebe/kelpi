import { describe, expect, it } from 'vitest';
import {
    idsEqual,
    isUUIDToken,
    makeSlug,
    normalizeLabel,
    normalizeUUIDToken
} from './ids.js';

describe('UUID tokens', () => {
    it('accepts the canonical form in either case', () => {
        expect(isUUIDToken('A1B2C3D4-0000-4000-8000-000000000001')).toBe(true);
        expect(isUUIDToken('a1b2c3d4-0000-4000-8000-000000000001')).toBe(true);
    });

    it('rejects non-canonical spellings', () => {
        expect(isUUIDToken('{a1b2c3d4-0000-4000-8000-000000000001}')).toBe(false);
        expect(isUUIDToken('a1b2c3d4000040008000000000000001')).toBe(false);
        expect(isUUIDToken('worker')).toBe(false);
        expect(normalizeUUIDToken('worker')).toBeNull();
    });

    it('compares UUIDs case-insensitively and other ids exactly', () => {
        expect(
            idsEqual('A1B2C3D4-0000-4000-8000-000000000001', 'a1b2c3d4-0000-4000-8000-000000000001')
        ).toBe(true);
        expect(idsEqual('worker', 'worker')).toBe(true);
        expect(idsEqual('worker', 'Worker')).toBe(false);
    });
});

describe('makeSlug', () => {
    it('lowercases, collapses non-alphanumeric runs, trims and suffixes', () => {
        expect(makeSlug('My Project', 'A1B2C3D4-0000-4000-8000-000000000001')).toBe(
            'my-project-a1b2c3d4'
        );
        expect(makeSlug('  Hello --- World!! ', 'A1B2C3D4-0000-4000-8000-000000000001')).toBe(
            'hello-world-a1b2c3d4'
        );
    });

    it('falls back to the bare suffix when the name has no alphanumerics', () => {
        expect(makeSlug('!!!', 'A1B2C3D4-0000-4000-8000-000000000001')).toBe('a1b2c3d4');
        expect(makeSlug('', 'A1B2C3D4-0000-4000-8000-000000000001')).toBe('a1b2c3d4');
    });
});

describe('normalizeLabel', () => {
    it('trims whitespace and newlines', () => {
        expect(normalizeLabel('  worker \n')).toBe('worker');
        expect(normalizeLabel('   ')).toBe('');
    });

    it('truncates to 64 characters', () => {
        const long = 'a'.repeat(100);
        expect(normalizeLabel(long)).toHaveLength(64);
        expect(normalizeLabel('a'.repeat(64))).toHaveLength(64);
    });
});
