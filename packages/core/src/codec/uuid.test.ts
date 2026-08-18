import { describe, expect, it } from 'vitest';

import { isUUIDString, newUUID, normalizeUUIDLoose, parseUUID, uuidEquals } from './uuid.js';

const ID = '5F0C24D9-1B61-412D-8D02-E62026261A9E';

describe('parseUUID', () => {
    it('accepts the canonical 8-4-4-4-12 form case-insensitively and emits uppercase', () => {
        expect(parseUUID(ID)).toBe(ID);
        expect(parseUUID(ID.toLowerCase())).toBe(ID);
        expect(isUUIDString(ID.toLowerCase())).toBe(true);
    });

    it('rejects everything Foundation would reject', () => {
        expect(parseUUID('')).toBeNull();
        expect(parseUUID('5F0C24D91B61412D8D02E62026261A9E')).toBeNull();
        expect(parseUUID(`{${ID}}`)).toBeNull();
        expect(parseUUID(`urn:uuid:${ID}`)).toBeNull();
        expect(parseUUID(`${ID} `)).toBeNull();
        expect(parseUUID('5F0C24D9-1B61-412D-8D02-E62026261A9')).toBeNull();
        expect(parseUUID('5F0C24D9-1B61-412D-8D02-E62026261A9Z')).toBeNull();
        expect(parseUUID(null)).toBeNull();
        expect(parseUUID(12)).toBeNull();
    });
});

describe('normalizeUUIDLoose', () => {
    it('uppercases valid ids and passes anything else through (write path never throws)', () => {
        expect(normalizeUUIDLoose(ID.toLowerCase())).toBe(ID);
        expect(normalizeUUIDLoose('not-a-uuid')).toBe('not-a-uuid');
    });
});

describe('uuidEquals', () => {
    it('compares case-insensitively and requires both sides well-formed', () => {
        expect(uuidEquals(ID, ID.toLowerCase())).toBe(true);
        expect(uuidEquals(ID, 'AAAAAAAA-0000-0000-0000-000000000001')).toBe(false);
        expect(uuidEquals(ID, 'nope')).toBe(false);
        expect(uuidEquals(undefined, undefined)).toBe(false);
    });
});

describe('newUUID', () => {
    it('normalizes the generated id to uppercase', () => {
        expect(newUUID(() => ID.toLowerCase())).toBe(ID);
    });

    it('throws when the generator returns a non-UUID', () => {
        expect(() => newUUID(() => 'nope')).toThrow();
    });

    it('generates distinct well-formed ids from the platform source', () => {
        const first = newUUID();
        const second = newUUID();
        expect(isUUIDString(first)).toBe(true);
        expect(first).toBe(first.toUpperCase());
        expect(first).not.toBe(second);
    });
});
