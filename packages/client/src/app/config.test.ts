import { describe, expect, it } from 'vitest';

import {
    DAEMON_STORAGE_KEY,
    TOKEN_STORAGE_KEY,
    describeTarget,
    forgetStoredToken,
    resolveDaemonTarget,
    sanitizedSearch,
    type StorageLike
} from './config';

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        getItem: (key) => data.get(key) ?? null,
        setItem: (key, value) => {
            data.set(key, value);
        },
        removeItem: (key) => {
            data.delete(key);
        }
    };
}

describe('resolveDaemonTarget', () => {
    it('defaults to same-origin with no token', () => {
        const target = resolveDaemonTarget({ search: '', storage: null });
        expect(target).toEqual({ url: undefined, token: undefined, fromQuery: false });
        expect(describeTarget(target)).toContain('origin');
    });

    it('takes the query parameters and remembers them', () => {
        const storage = memoryStorage();
        const target = resolveDaemonTarget({
            search: '?daemon=http://127.0.0.1:19470&token=abc',
            storage
        });

        expect(target).toEqual({ url: 'http://127.0.0.1:19470', token: 'abc', fromQuery: true });
        expect(storage.data.get(DAEMON_STORAGE_KEY)).toBe('http://127.0.0.1:19470');
        expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe('abc');
    });

    it('falls back to the remembered values on a later load', () => {
        const storage = memoryStorage({
            [DAEMON_STORAGE_KEY]: 'http://127.0.0.1:19470',
            [TOKEN_STORAGE_KEY]: 'abc'
        });
        expect(resolveDaemonTarget({ search: '', storage })).toEqual({
            url: 'http://127.0.0.1:19470',
            token: 'abc',
            fromQuery: false
        });
    });

    it('clears a remembered value with an empty parameter', () => {
        const storage = memoryStorage({ [DAEMON_STORAGE_KEY]: 'http://stale', [TOKEN_STORAGE_KEY]: 'old' });
        const target = resolveDaemonTarget({ search: '?daemon=&token=', storage });

        expect(target).toEqual({ url: undefined, token: undefined, fromQuery: true });
        expect(storage.data.has(DAEMON_STORAGE_KEY)).toBe(false);
        expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
    });

    it('survives a storage that throws (private mode)', () => {
        const hostile: StorageLike = {
            getItem: () => {
                throw new Error('denied');
            },
            setItem: () => {
                throw new Error('denied');
            },
            removeItem: () => {
                throw new Error('denied');
            }
        };
        expect(resolveDaemonTarget({ search: '?token=abc', storage: hostile })).toEqual({
            url: undefined,
            token: 'abc',
            fromQuery: true
        });
    });
});

describe('forgetStoredToken', () => {
    it('drops the remembered token and leaves the daemon override alone', () => {
        const storage = memoryStorage({ [DAEMON_STORAGE_KEY]: 'http://127.0.0.1:19470', [TOKEN_STORAGE_KEY]: 'stale' });
        forgetStoredToken(storage);
        expect(storage.data.has(TOKEN_STORAGE_KEY)).toBe(false);
        // Which daemon to talk to is still right; only the credential was wrong.
        expect(storage.data.get(DAEMON_STORAGE_KEY)).toBe('http://127.0.0.1:19470');
    });

    it('lets the next visit with a good ?token= win', () => {
        const storage = memoryStorage({ [TOKEN_STORAGE_KEY]: 'stale' });
        forgetStoredToken(storage);
        expect(resolveDaemonTarget({ search: '', storage }).token).toBeUndefined();
        expect(resolveDaemonTarget({ search: '?token=fresh', storage }).token).toBe('fresh');
        expect(storage.data.get(TOKEN_STORAGE_KEY)).toBe('fresh');
    });

    it('is a no-op without storage, and survives one that throws', () => {
        expect(() => forgetStoredToken(null)).not.toThrow();
        expect(() =>
            forgetStoredToken({
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {
                    throw new Error('denied');
                }
            })
        ).not.toThrow();
    });
});

describe('sanitizedSearch', () => {
    it('strips the credentials and keeps everything else', () => {
        expect(sanitizedSearch('?daemon=x&token=y')).toBe('');
        expect(sanitizedSearch('?token=y&debug=1')).toBe('?debug=1');
        expect(sanitizedSearch('')).toBe('');
    });
});
