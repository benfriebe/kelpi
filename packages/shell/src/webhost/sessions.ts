/**
 * Per-pane storage partitions and the cookie surface behind `nex web cookies-*` (web-pane.md §6,
 * §13.2).
 *
 * The rule that shapes everything: **the partition is sealed into a view at creation**. A pane's
 * `isPrivate` flag therefore cannot be flipped on a live view — the daemon sends
 * `pane-set-private` and the registry destroys and rebuilds the pane against the other store
 * (live JS state is expected to be lost, and the spec says so out loud).
 *
 * Partition choice:
 *   - persistent → one shared `persist:nex-web` partition, so a login survives a restart and is
 *     visible to every non-private web pane, exactly like the Swift app's `default` data store;
 *   - private → `nex-web-private-<paneID>`, with **no** `persist:` prefix, which is Electron's
 *     in-memory partition. One per pane so two private panes cannot see each other's cookies,
 *     and everything in it dies with the process.
 *
 * `canonicalDomain` (strip one leading `.`) is the matching rule everywhere, as in the Swift app.
 */

import { session, type Session } from 'electron';

import type { CookieRecord, CookieWrite, PaneStorage } from './dispatch.js';

/** The shared persistent store for non-private panes. */
export const PERSISTENT_PARTITION = 'persist:nex-web';

/** No `persist:` prefix ⇒ in-memory: gone when the app exits (§6's "discarded on quit"). */
export function privatePartition(paneID: string): string {
    return `nex-web-private-${paneID}`;
}

/** §13.2: matching everywhere strips exactly one leading dot. */
export function canonicalDomain(domain: string): string {
    return domain.startsWith('.') ? domain.slice(1) : domain;
}

/** The URL `session.cookies.remove` needs to identify a cookie. */
export function cookieURL(cookie: {
    domain?: string | undefined;
    path?: string | undefined;
    secure?: boolean | undefined;
}): string {
    const host = canonicalDomain(cookie.domain ?? '');
    const scheme = cookie.secure === true ? 'https' : 'http';
    const path = cookie.path ?? '/';
    return `${scheme}://${host}${path.startsWith('/') ? path : `/${path}`}`;
}

export interface PaneSessions {
    /** Memoised per pane: every tab of a pane shares one store. */
    sessionFor(paneID: string, isPrivate: boolean): Session;
    /** The pane closed; drop the handle (an in-memory partition also gets wiped). */
    forget(paneID: string): void;
    readonly storage: PaneStorage;
}

export interface PaneSessionOptions {
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Test seam; production uses Electron's `session.fromPartition`. */
    readonly fromPartition?: ((partition: string) => Session) | undefined;
}

export function createPaneSessions(options: PaneSessionOptions = {}): PaneSessions {
    const resolve = options.fromPartition ?? ((partition: string): Session => session.fromPartition(partition));
    const byPane = new Map<string, { session: Session; isPrivate: boolean }>();

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const sessionOf = (paneID: string): Session | null => byPane.get(paneID)?.session ?? null;

    const storage: PaneStorage = {
        async list(paneID) {
            const store = sessionOf(paneID);
            // "No coordinator yet" (§13.2): a pane whose views were never built reads empty
            // rather than erroring. The daemon answers the same way with no host at all.
            if (store === null) return [];
            try {
                const cookies = await store.cookies.get({});
                return cookies.map((cookie): CookieRecord => {
                    const sessionOnly = cookie.session === true || cookie.expirationDate === undefined;
                    return {
                        name: cookie.name,
                        value: cookie.value ?? '',
                        domain: cookie.domain ?? '',
                        path: cookie.path ?? '/',
                        isSecure: cookie.secure === true,
                        isHttpOnly: cookie.httpOnly === true,
                        ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
                        ...(sessionOnly ? { sessionOnly: true } : {})
                    };
                });
            } catch (error) {
                report(error, 'cookies-list');
                return [];
            }
        },

        async clearAllSiteData(paneID) {
            const store = sessionOf(paneID);
            if (store === null) return;
            // §13.2: "removes cookies, local storage, IndexedDB, and caches" — the whole store,
            // since the epoch. `clearStorageData()` with no filter is exactly that.
            await store.clearStorageData();
            try {
                await store.clearCache();
            } catch (error) {
                report(error, 'clear-cache');
            }
        },

        /**
         * WEB-052: delete the ORIGINAL record first, then set the new one. A rename otherwise
         * leaves a stale twin, because `cookies.set` keys on (name, domain, path) and a changed
         * name simply writes a second cookie beside the old one.
         *
         * `httpOnly` rides through an edit but is not offered in the form; `secure`/`httpOnly`
         * are omitted entirely when off, mirroring the Swift panel's write.
         */
        async set(paneID, cookie: CookieWrite, original) {
            const store = sessionOf(paneID);
            if (store === null) throw new Error('web pane has no storage yet');
            if (original !== undefined && original.name !== '') {
                try {
                    await store.cookies.remove(
                        cookieURL({
                            domain: original.domain,
                            path: original.path ?? cookie.path,
                            secure: cookie.isSecure
                        }),
                        original.name
                    );
                } catch (error) {
                    report(error, 'cookies-remove-original');
                }
            }
            await store.cookies.set({
                url: cookieURL({ domain: cookie.domain, path: cookie.path, secure: cookie.isSecure }),
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                ...(cookie.isSecure ? { secure: true } : {}),
                ...(cookie.isHttpOnly ? { httpOnly: true } : {}),
                ...(cookie.expires === undefined ? {} : { expirationDate: cookie.expires })
            });
        },

        async remove(paneID, filter) {
            const store = sessionOf(paneID);
            if (store === null) return 0;
            const wantedDomain = filter.domain === undefined ? null : canonicalDomain(filter.domain);
            let cookies;
            try {
                cookies = await store.cookies.get({});
            } catch (error) {
                report(error, 'cookies-get');
                return 0;
            }
            let deleted = 0;
            for (const cookie of cookies) {
                if (filter.name !== undefined && cookie.name !== filter.name) continue;
                if (wantedDomain !== null && canonicalDomain(cookie.domain ?? '') !== wantedDomain) continue;
                try {
                    await store.cookies.remove(cookieURL(cookie), cookie.name);
                    deleted += 1;
                } catch (error) {
                    report(error, 'cookies-remove');
                }
            }
            return deleted;
        }
    };

    return {
        sessionFor(paneID, isPrivate) {
            const existing = byPane.get(paneID);
            if (existing !== undefined && existing.isPrivate === isPrivate) return existing.session;
            const store = resolve(isPrivate ? privatePartition(paneID) : PERSISTENT_PARTITION);
            byPane.set(paneID, { session: store, isPrivate });
            return store;
        },

        forget(paneID) {
            const existing = byPane.get(paneID);
            byPane.delete(paneID);
            if (existing === undefined || !existing.isPrivate) return;
            // Best effort: an in-memory partition dies with the process anyway, but a long-lived
            // shell that opens and closes many private panes should not hold their data.
            void existing.session.clearStorageData().catch((error: unknown) => {
                report(error, 'private-partition-clear');
            });
        },

        storage
    };
}
