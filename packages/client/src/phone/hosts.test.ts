import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { StorageLike } from '../app/config';
import {
    PHONE_HOSTS_KEY,
    originHostName,
    parsePairingURL,
    readStoredHosts,
    suggestedHostName,
    usePhoneHosts,
    writeStoredHosts,
    type PhoneHostEntry
} from './hosts';

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

const MAC: PhoneHostEntry = { id: 'h1', name: 'mac', url: 'https://mac.tail.ts.net/?token=kd_abc' };

describe('the remembered host list', () => {
    it('is empty with nothing stored, a blocked store, or garbage', () => {
        expect(readStoredHosts(memoryStorage())).toEqual([]);
        expect(readStoredHosts(null)).toEqual([]);
        expect(readStoredHosts(memoryStorage({ [PHONE_HOSTS_KEY]: 'not json' }))).toEqual([]);
        expect(readStoredHosts(memoryStorage({ [PHONE_HOSTS_KEY]: '{"a":1}' }))).toEqual([]);
        expect(
            readStoredHosts({
                getItem: () => {
                    throw new Error('SecurityError');
                },
                setItem: () => {},
                removeItem: () => {}
            })
        ).toEqual([]);
    });

    it('keeps only well-formed entries, and only their three fields', () => {
        const stored = JSON.stringify([MAC, { id: 'x' }, { ...MAC, id: 'h2', extra: true }, 42]);
        expect(readStoredHosts(memoryStorage({ [PHONE_HOSTS_KEY]: stored }))).toEqual([MAC, { ...MAC, id: 'h2' }]);
    });

    it('round-trips, and an empty list removes the key rather than storing []', () => {
        const storage = memoryStorage();
        writeStoredHosts([MAC], storage);
        expect(readStoredHosts(storage)).toEqual([MAC]);
        writeStoredHosts([], storage);
        expect(storage.map.has(PHONE_HOSTS_KEY)).toBe(false);
    });
});

describe('a pasted pairing URL', () => {
    it('must be an absolute http(s) URL with a host', () => {
        expect(parsePairingURL('')).toMatchObject({ ok: false });
        expect(parsePairingURL('   ')).toMatchObject({ ok: false });
        expect(parsePairingURL('mac.tail.ts.net')).toMatchObject({ ok: false, error: 'that is not a URL' });
        expect(parsePairingURL('ftp://mac/?token=x')).toMatchObject({ ok: false });
        expect(parsePairingURL('file:///tmp')).toMatchObject({ ok: false });
    });

    it('reads the token the way the remote-daemon runtime will, and says when there is none', () => {
        expect(parsePairingURL('  https://mac.tail.ts.net/?token=kd_abc  ')).toEqual({
            ok: true,
            url: 'https://mac.tail.ts.net/?token=kd_abc',
            hostname: 'mac.tail.ts.net',
            hasToken: true
        });
        expect(parsePairingURL('http://127.0.0.1:4321/')).toMatchObject({ ok: true, hostname: '127.0.0.1', hasToken: false });
    });
});

describe('names', () => {
    it('suggests the tailnet machine name, made unique against the list', () => {
        expect(suggestedHostName('mac.tail.ts.net', [])).toBe('mac');
        expect(suggestedHostName('mac.tail.ts.net', ['Mac'])).toBe('mac 2');
        expect(suggestedHostName('mac.tail.ts.net', ['mac', 'mac 2'])).toBe('mac 3');
        expect(suggestedHostName('10.0.0.5', [])).toBe('10');
        expect(suggestedHostName('', [])).toBe('host');
    });

    it('calls a loopback origin "this Mac" and a tailnet origin by its machine name', () => {
        expect(originHostName(null)).toBe('this Mac');
        expect(originHostName({ hostname: '' })).toBe('this Mac');
        expect(originHostName({ hostname: 'localhost' })).toBe('this Mac');
        expect(originHostName({ hostname: '127.0.0.1' })).toBe('this Mac');
        expect(originHostName({ hostname: 'studio.tail.ts.net' })).toBe('studio');
    });
});

describe('usePhoneHosts', () => {
    it('adds, renames and removes, remembering each change', () => {
        const storage = memoryStorage();
        const { result } = renderHook(() => usePhoneHosts(storage));
        expect(result.current.hosts).toEqual([]);

        let added: PhoneHostEntry | null = null;
        act(() => {
            added = result.current.add('  mac ', MAC.url);
        });
        expect(added).not.toBeNull();
        expect(result.current.hosts).toHaveLength(1);
        expect(result.current.hosts[0]).toMatchObject({ name: 'mac', url: MAC.url });
        expect(readStoredHosts(storage)).toEqual(result.current.hosts);

        const id = result.current.hosts[0]?.id ?? '';
        act(() => result.current.rename(id, ' studio '));
        expect(result.current.hosts[0]?.name).toBe('studio');
        act(() => result.current.rename(id, '   '));
        expect(result.current.hosts[0]?.name).toBe('studio');
        expect(readStoredHosts(storage)[0]?.name).toBe('studio');

        act(() => result.current.remove(id));
        expect(result.current.hosts).toEqual([]);
        expect(storage.map.has(PHONE_HOSTS_KEY)).toBe(false);
    });

    it('starts from what is remembered', () => {
        const storage = memoryStorage({ [PHONE_HOSTS_KEY]: JSON.stringify([MAC]) });
        const { result } = renderHook(() => usePhoneHosts(storage));
        expect(result.current.hosts).toEqual([MAC]);
    });
});
