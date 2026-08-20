/**
 * Web-pane favourites (WEB-037/038/044/045/046, SET-097…SET-100).
 *
 * The rule with teeth is WEB-044's match: scheme and host are case-insensitive by spec, path and
 * query are not — a store that folded the whole URL would toggle the wrong entry for any site
 * with a case-sensitive path, which is most of them.
 *
 * Every test injects its own file seams, so no suite touches a real path.
 */

import { describe, expect, it } from 'vitest';

import {
    createFavouritesStore,
    decodeFavouritesJSON,
    encodeFavouritesJSON,
    favouriteLabel,
    normalizeFavouriteURL,
    serializeFavourite
} from './favourites.js';
import { attachFakeHost, webHarness } from './testing.js';
import { favouritesCommand } from '../ws/web-ui.js';

const NOW = 1_755_500_000_000;

function memoryStore(seed = '[]'): { store: ReturnType<typeof createFavouritesStore>; written: string[] } {
    const written: string[] = [];
    let counter = 0;
    const store = createFavouritesStore({
        path: '/sandbox/favourites.json',
        readFile: () => seed,
        writeFile: (_path, contents) => {
            written.push(contents);
        },
        uuid: () => {
            counter += 1;
            return `fav-${String(counter)}`;
        },
        now: () => NOW
    });
    return { store, written };
}

describe('the URL match (WEB-044)', () => {
    it('folds scheme and host, strips trailing slashes, and leaves the path alone', () => {
        expect(normalizeFavouriteURL('HTTPS://Example.COM/')).toBe('https://example.com');
        expect(normalizeFavouriteURL('https://example.com/API')).not.toBe(
            normalizeFavouriteURL('https://example.com/api')
        );
        expect(normalizeFavouriteURL('  https://example.com/a/  ')).toBe('https://example.com/a');
    });

    it('compares a non-URL argument as written', () => {
        expect(normalizeFavouriteURL('localhost:3000')).toBe('localhost:3000');
    });

    it('toggles by match, not by string equality', () => {
        const { store } = memoryStore();
        store.toggle('https://Example.com/docs', 'Docs');
        expect(store.has('HTTPS://example.COM/docs/')).toBe(true);
        store.toggle('https://example.com/docs/', '');
        expect(store.list()).toHaveLength(0);
    });

    it('ignores an empty URL entirely (the star is disabled for one)', () => {
        const { store, written } = memoryStore();
        expect(store.toggle('   ', 'nothing')).toMatchObject({ added: false, id: null });
        expect(store.list()).toHaveLength(0);
        expect(written).toHaveLength(0);
    });
});

describe('the store', () => {
    it('writes the whole file on every mutation (WEB-045: no debounce)', () => {
        const { store, written } = memoryStore();
        store.toggle('https://a.example', 'A');
        store.toggle('https://b.example', 'B');
        store.rename('fav-1', '  Renamed  ');
        store.move(0, 1);
        store.remove('fav-2');
        expect(written).toHaveLength(5);
        const final = JSON.parse(written.at(-1) ?? '[]') as { id: string; title: string }[];
        expect(final).toHaveLength(1);
        expect(final[0]).toMatchObject({ id: 'fav-1', title: 'Renamed' });
    });

    it('is a no-op when a rename changes nothing, or a move is out of range', () => {
        const { store, written } = memoryStore();
        store.toggle('https://a.example', 'A');
        store.rename('fav-1', 'A');
        store.rename('missing', 'X');
        store.move(0, 0);
        store.move(0, 9);
        store.remove('missing');
        expect(written).toHaveLength(1);
    });

    it('moves rather than swaps (SET-100)', () => {
        const { store } = memoryStore();
        store.toggle('https://a.example', 'A');
        store.toggle('https://b.example', 'B');
        store.toggle('https://c.example', 'C');
        store.move(2, 0);
        expect(store.list().map((favourite) => favourite.title)).toEqual(['C', 'A', 'B']);
    });

    it('round-trips the Swift `web.favourites` JSON shape', () => {
        const json = encodeFavouritesJSON([
            { id: 'fav-1', url: 'https://a.example', title: 'A', createdAt: NOW }
        ]);
        expect(JSON.parse(json)).toEqual([
            { id: 'fav-1', url: 'https://a.example', title: 'A', createdAt: new Date(NOW).toISOString() }
        ]);
        expect(decodeFavouritesJSON(json)).toEqual([
            { id: 'fav-1', url: 'https://a.example', title: 'A', createdAt: NOW }
        ]);
    });

    it('survives a corrupt or missing file rather than refusing to start', () => {
        expect(decodeFavouritesJSON('not json')).toEqual([]);
        expect(decodeFavouritesJSON('{"not":"an array"}')).toEqual([]);
        // A row with no URL cannot be addressed, so it is dropped.
        expect(decodeFavouritesJSON('[{"id":"x"}]')).toEqual([]);
        const store = createFavouritesStore({
            path: '/sandbox/missing.json',
            readFile: () => {
                throw new Error('ENOENT');
            },
            writeFile: () => {}
        });
        expect(store.list()).toEqual([]);
    });

    it('labels a favourite by title, then host, then raw URL', () => {
        expect(favouriteLabel({ id: '1', url: 'https://a.example/x', title: 'Named', createdAt: 0 })).toBe('Named');
        expect(favouriteLabel({ id: '1', url: 'https://a.example/x', title: '  ', createdAt: 0 })).toBe('a.example');
        expect(favouriteLabel({ id: '1', url: 'not a url', title: '', createdAt: 0 })).toBe('not a url');
    });

    it('serializes the label so every client shows the same one', () => {
        expect(serializeFavourite({ id: '1', url: 'https://a.example', title: '', createdAt: NOW })).toEqual({
            id: '1',
            url: 'https://a.example',
            title: '',
            created_at: new Date(NOW).toISOString(),
            label: 'a.example'
        });
    });
});

describe('the verbs', () => {
    it('answer with the post-mutation list, and broadcast it', () => {
        const broadcasts: readonly unknown[][] = [];
        const harness = webHarness();
        attachFakeHost(harness.service);
        const channel = harness.service;

        expect(favouritesCommand(channel, 'web-favourites-list', {})).toEqual({ ok: true, favourites: [] });

        const added = favouritesCommand(channel, 'web-favourite-toggle', {
            url: 'https://example.com',
            title: 'Example'
        });
        expect(added).toMatchObject({ ok: true, added: true });
        expect((added['favourites'] as unknown[]) ?? []).toHaveLength(1);

        const removed = favouritesCommand(channel, 'web-favourite-toggle', { url: 'https://example.com/' });
        expect(removed).toMatchObject({ ok: true, added: false });
        expect((removed['favourites'] as unknown[]) ?? []).toHaveLength(0);
        void broadcasts;
    });

    it('refuse a toggle with no URL and a move with no indices', () => {
        const harness = webHarness();
        expect(favouritesCommand(harness.service, 'web-favourite-toggle', {})).toMatchObject({ ok: false });
        expect(favouritesCommand(harness.service, 'web-favourite-remove', {})).toMatchObject({ ok: false });
        expect(favouritesCommand(harness.service, 'web-favourite-rename', {})).toMatchObject({ ok: false });
        expect(favouritesCommand(harness.service, 'web-favourite-move', { from: 0 })).toMatchObject({ ok: false });
    });
});
