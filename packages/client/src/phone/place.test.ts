/**
 * The remembered place (B7). The rules it encodes are in `place.ts`'s header; these pin the
 * parsing, the round trip and the two ways a store can let you down (blocked, or holding rubbish
 * a previous version wrote).
 */

import { describe, expect, it } from 'vitest';

import type { StorageLike } from '../app/config';
import { PHONE_PLACE_KEY, isPhonePlace, readStoredPlace, writeStoredPlace } from './place';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        }
    };
}

function blockedStorage(): StorageLike {
    return {
        getItem: () => {
            throw new Error('SecurityError');
        },
        setItem: () => {
            throw new Error('SecurityError');
        },
        removeItem: () => {
            throw new Error('SecurityError');
        }
    };
}

describe('isPhonePlace', () => {
    it('wants a non-empty host and a workspace id', () => {
        expect(isPhonePlace({ host: 'origin', workspaceID: 'w1' })).toBe(true);
        expect(isPhonePlace({ host: 'phone:h1', workspaceID: '' })).toBe(true);
        expect(isPhonePlace({ host: '', workspaceID: 'w1' })).toBe(false);
        expect(isPhonePlace({ host: 'origin' })).toBe(false);
        expect(isPhonePlace(null)).toBe(false);
        expect(isPhonePlace('origin')).toBe(false);
    });
});

describe('the remembered place', () => {
    it('round-trips through one key beside the host list', () => {
        const storage = memoryStorage();
        writeStoredPlace({ host: 'phone:h1', workspaceID: 'w9' }, storage);
        expect(storage.map.get(PHONE_PLACE_KEY)).toBe(JSON.stringify({ host: 'phone:h1', workspaceID: 'w9' }));
        expect(readStoredPlace(storage)).toEqual({ host: 'phone:h1', workspaceID: 'w9' });
    });

    it('is null when nothing is remembered, and forgetting removes the key', () => {
        const storage = memoryStorage();
        expect(readStoredPlace(storage)).toBeNull();
        writeStoredPlace({ host: 'origin', workspaceID: 'w1' }, storage);
        writeStoredPlace(null, storage);
        expect(storage.map.has(PHONE_PLACE_KEY)).toBe(false);
        expect(readStoredPlace(storage)).toBeNull();
    });

    it('is null for rubbish rather than throwing at boot', () => {
        expect(readStoredPlace(memoryStorage({ [PHONE_PLACE_KEY]: 'not json' }))).toBeNull();
        expect(readStoredPlace(memoryStorage({ [PHONE_PLACE_KEY]: '[]' }))).toBeNull();
        expect(readStoredPlace(memoryStorage({ [PHONE_PLACE_KEY]: '{"host":3}' }))).toBeNull();
    });

    it('survives a blocked store: no place, no throw', () => {
        const blocked = blockedStorage();
        expect(readStoredPlace(blocked)).toBeNull();
        expect(() => writeStoredPlace({ host: 'origin', workspaceID: 'w1' }, blocked)).not.toThrow();
        expect(() => writeStoredPlace(null, blocked)).not.toThrow();
        expect(readStoredPlace(null)).toBeNull();
    });
});
