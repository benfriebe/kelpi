/**
 * Web-pane favourites (web-pane.md §14; WEB-037/038/044/045/046, SET-097…SET-100, SET-230).
 *
 * The Swift app kept these in `UserDefaults` under `web.favourites` as an ISO-8601 JSON array,
 * written immediately on every mutation. The port needs a home that is (a) daemon-side, because
 * a favourite must be the same in every window and in the Electron shell, and (b) not domain
 * state, because nothing about a favourite is a workspace, a pane or a delta.
 *
 * **The choice: a config-adjacent JSON file, `favourites.json`, beside the daemon database.**
 * Not the DB app-state row, and the reasoning is worth writing down:
 *
 *   - it keeps the *exact* Swift payload shape (`[{id, url, title, createdAt}]`, `createdAt` in
 *     ISO-8601), so a legacy `web.favourites` value can be dropped in verbatim — which the
 *     app-state row could not do without a schema decision it does not need;
 *   - a favourite is a user preference, and preferences in this port live in files the user can
 *     read and edit (`~/.config/nex/config`, and now this), not inside a SQLite blob;
 *   - it costs the domain store nothing: no new `DomainEvent`, no delta kind, no mirror
 *     hydration. Clients get the list from a WS verb and a `web-favourites` broadcast.
 *
 * Every mutation writes the whole file synchronously and immediately (WEB-045: no debounce — a
 * star toggled a moment before quit must survive). The list is small by nature; the write is a
 * few hundred bytes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { JsonObject } from '@nex/protocol';

export interface Favourite {
    readonly id: string;
    readonly url: string;
    readonly title: string;
    /** Epoch ms in memory; ISO-8601 on disk, matching the Swift encoder. */
    readonly createdAt: number;
}

/**
 * WEB-044's match rule: lowercase the parts that are case-insensitive by spec (scheme + host)
 * and strip trailing slashes, but leave path and query alone — most servers treat `/API` and
 * `/api` as different resources, and a favourite that "matched" both would toggle the wrong one.
 */
export function normalizeFavouriteURL(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') return '';
    let normalized = trimmed;
    try {
        const url = new URL(trimmed);
        // `URL` already lowercases protocol and host; re-serialising is what applies it.
        normalized = url.toString();
    } catch {
        // Not an absolute URL (a bare host, a half-typed address): compare it as written.
        normalized = trimmed;
    }
    while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized;
}

/** `displayLabel`: the title, else the host, else the raw URL (never empty). */
export function favouriteLabel(favourite: Favourite): string {
    if (favourite.title.trim() !== '') return favourite.title;
    try {
        const host = new URL(favourite.url).host;
        if (host !== '') return host;
    } catch {
        // fall through
    }
    return favourite.url;
}

export function serializeFavourite(favourite: Favourite): JsonObject {
    return {
        id: favourite.id,
        url: favourite.url,
        title: favourite.title,
        created_at: new Date(favourite.createdAt).toISOString(),
        label: favouriteLabel(favourite)
    };
}

/** The on-disk row shape — deliberately the Swift `Favourite` `Codable` encoding. */
function toDisk(favourite: Favourite): Record<string, unknown> {
    return {
        id: favourite.id,
        url: favourite.url,
        title: favourite.title,
        createdAt: new Date(favourite.createdAt).toISOString()
    };
}

function fromDisk(raw: unknown, fallbackID: () => string, now: number): Favourite | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
    if (url === '') return null;
    const created = record['createdAt'];
    const parsed = typeof created === 'string' ? Date.parse(created) : Number.NaN;
    return {
        id: typeof record['id'] === 'string' && record['id'] !== '' ? record['id'] : fallbackID(),
        url,
        title: typeof record['title'] === 'string' ? record['title'] : '',
        createdAt: Number.isNaN(parsed) ? now : parsed
    };
}

export function decodeFavouritesJSON(json: string, options: { readonly uuid?: (() => string) | undefined; readonly now?: number | undefined } = {}): Favourite[] {
    const uuid = options.uuid ?? ((): string => randomUUID());
    const now = options.now ?? Date.now();
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out: Favourite[] = [];
    for (const entry of parsed) {
        const favourite = fromDisk(entry, uuid, now);
        if (favourite !== null) out.push(favourite);
    }
    return out;
}

export function encodeFavouritesJSON(favourites: readonly Favourite[]): string {
    return `${JSON.stringify(favourites.map(toDisk), null, 2)}\n`;
}

export interface FavouritesStore {
    list(): readonly Favourite[];
    /** WEB-044: add when the URL is not already saved, remove when it is. Empty URL = no-op. */
    toggle(url: string, title: string): { readonly favourites: readonly Favourite[]; readonly added: boolean; readonly id: string | null };
    /** True when the URL matches a saved favourite (the star's filled state). */
    has(url: string): boolean;
    remove(id: string): readonly Favourite[];
    /** SET-099: the trimmed title; a no-op when it did not change. */
    rename(id: string, title: string): readonly Favourite[];
    /** SET-100 drag reorder. */
    move(from: number, to: number): readonly Favourite[];
}

export interface FavouritesStoreOptions {
    /** Absolute path to `favourites.json`. Absent = in-memory only (unit tests). */
    readonly path?: string | undefined;
    readonly uuid?: (() => string) | undefined;
    readonly now?: (() => number) | undefined;
    readonly onChange?: ((favourites: readonly Favourite[]) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Test seams so nothing in a suite ever touches a real path. */
    readonly readFile?: ((path: string) => string) | undefined;
    readonly writeFile?: ((path: string, contents: string) => void) | undefined;
}

export function createFavouritesStore(options: FavouritesStoreOptions = {}): FavouritesStore {
    const uuid = options.uuid ?? ((): string => randomUUID());
    const now = options.now ?? ((): number => Date.now());
    const path = options.path;
    const read = options.readFile ?? ((file: string): string => readFileSync(file, 'utf8'));
    const write = options.writeFile ?? ((file: string, contents: string): void => {
        writeFileSync(file, contents, 'utf8');
    });
    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    let favourites: Favourite[] = [];
    if (path !== undefined) {
        try {
            favourites = decodeFavouritesJSON(read(path), { uuid, now: now() });
        } catch {
            // A missing file is the normal fresh-install case, not an error worth logging.
            favourites = [];
        }
    }

    const commit = (next: Favourite[]): readonly Favourite[] => {
        favourites = next;
        if (path !== undefined) {
            try {
                write(path, encodeFavouritesJSON(favourites));
            } catch (error) {
                report(error, 'favourites-write');
            }
        }
        options.onChange?.(favourites);
        return favourites;
    };

    const indexOfURL = (url: string): number => {
        const needle = normalizeFavouriteURL(url);
        if (needle === '') return -1;
        return favourites.findIndex((favourite) => normalizeFavouriteURL(favourite.url) === needle);
    };

    return {
        list() {
            return favourites;
        },

        has(url) {
            return indexOfURL(url) >= 0;
        },

        toggle(url, title) {
            const trimmed = url.trim();
            if (trimmed === '') return { favourites, added: false, id: null };
            const at = indexOfURL(trimmed);
            if (at >= 0) {
                const removed = favourites[at];
                const next = favourites.filter((_, index) => index !== at);
                commit(next);
                return { favourites, added: false, id: removed?.id ?? null };
            }
            const created: Favourite = { id: uuid(), url: trimmed, title: title.trim(), createdAt: now() };
            commit([...favourites, created]);
            return { favourites, added: true, id: created.id };
        },

        remove(id) {
            const next = favourites.filter((favourite) => favourite.id !== id);
            if (next.length === favourites.length) return favourites;
            return commit(next);
        },

        rename(id, title) {
            const trimmed = title.trim();
            let changed = false;
            const next = favourites.map((favourite) => {
                if (favourite.id !== id || favourite.title === trimmed) return favourite;
                changed = true;
                return { ...favourite, title: trimmed };
            });
            return changed ? commit(next) : favourites;
        },

        move(from, to) {
            if (!Number.isInteger(from) || !Number.isInteger(to)) return favourites;
            if (from < 0 || from >= favourites.length) return favourites;
            if (to < 0 || to >= favourites.length || from === to) return favourites;
            const next = [...favourites];
            const [moved] = next.splice(from, 1);
            if (moved === undefined) return favourites;
            next.splice(to, 0, moved);
            return commit(next);
        }
    };
}
