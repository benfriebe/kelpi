/**
 * Where the client connects, and with what token (WP3.6).
 *
 * The daemon **serves this bundle** (ARCHITECTURE.md: "UI delivery — daemon-served, shell loads
 * URL"), so the honest default is same-origin: no configuration, no CORS, and a remote browser
 * behind `tailscale serve` is version-matched by construction. Everything here exists for the
 * two cases where that is not true:
 *
 *   - **`vite dev`** runs the UI on :5173 while the daemon is on its own ephemeral port, so
 *     `?daemon=http://127.0.0.1:19470` points the socket at it (`vite.config.ts` also proxies
 *     `/ws`, which is the zero-config path; `?daemon=` is the one that survives a proxy that
 *     is pointed somewhere else).
 *   - **the token**. The daemon's run dir holds a 0600 `.token` and the WS upgrade is gated on
 *     it (`daemon/src/ws/http.ts`). A browser cannot set a header on a WebSocket handshake, so
 *     the token rides as `?token=` — which means it also lands in the address bar, history and
 *     any screenshot. Both values are therefore remembered in `localStorage` on first sight and
 *     `sanitizedSearch` strips them from the visible URL.
 *
 * Precedence, per value: query parameter → `localStorage` → nothing (same-origin / no token).
 * An explicitly EMPTY parameter (`?daemon=`) clears the remembered value, which is the escape
 * hatch from a stale override.
 */

export const DAEMON_PARAM = 'daemon';
export const TOKEN_PARAM = 'token';

export const DAEMON_STORAGE_KEY = 'nex.daemon-url';
export const TOKEN_STORAGE_KEY = 'nex.token';

/** The slice of `Storage` used here; `null` disables persistence (private mode, tests). */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface DaemonTarget {
    /** Base URL for the socket; `undefined` means "this page's origin" (`resolveWsUrl`). */
    readonly url: string | undefined;
    readonly token: string | undefined;
    /** True when either value came from the query string (so the URL wants sanitizing). */
    readonly fromQuery: boolean;
}

export interface ResolveTargetOptions {
    /** `location.search`; defaults to the page's own. */
    readonly search?: string | undefined;
    /** Defaults to `localStorage` where it exists. Pass `null` to skip persistence entirely. */
    readonly storage?: StorageLike | null | undefined;
}

/** `localStorage` when the browser allows it (Safari private mode throws on access). */
export function defaultStorage(): StorageLike | null {
    try {
        const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
        return storage ?? null;
    } catch {
        return null;
    }
}

function currentSearch(): string {
    return (globalThis as { location?: { search?: string } }).location?.search ?? '';
}

function read(storage: StorageLike | null, key: string): string | undefined {
    if (storage === null) return undefined;
    try {
        const value = storage.getItem(key);
        return value !== null && value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

function write(storage: StorageLike | null, key: string, value: string | undefined): void {
    if (storage === null) return;
    try {
        if (value === undefined) storage.removeItem(key);
        else storage.setItem(key, value);
    } catch {
        // A storage quota / private-mode failure must never stop the client from connecting.
    }
}

/**
 * One parameter's resolution: present-and-non-empty wins and is remembered, present-and-empty
 * clears the memory, absent falls back to what was remembered.
 */
function resolveValue(
    params: URLSearchParams,
    name: string,
    storage: StorageLike | null,
    key: string
): { value: string | undefined; fromQuery: boolean } {
    if (!params.has(name)) return { value: read(storage, key), fromQuery: false };
    const raw = params.get(name)?.trim() ?? '';
    if (raw.length === 0) {
        write(storage, key, undefined);
        return { value: undefined, fromQuery: true };
    }
    write(storage, key, raw);
    return { value: raw, fromQuery: true };
}

/**
 * Forget the remembered token.
 *
 * Called when the daemon rejects the handshake for a token reason: the value we remembered is
 * provably wrong (the daemon restarted with a new run dir, the URL was copied from another
 * machine, the token was truncated), and remembering it would poison **every future visit** —
 * an opened `?token=…` link would work once and then the stale value would win again on the
 * next plain reload. Clearing it makes the next `nexd url` link the source of truth.
 */
export function forgetStoredToken(storage: StorageLike | null = defaultStorage()): void {
    write(storage, TOKEN_STORAGE_KEY, undefined);
}

export function resolveDaemonTarget(options: ResolveTargetOptions = {}): DaemonTarget {
    const search = options.search ?? currentSearch();
    const storage = options.storage === undefined ? defaultStorage() : options.storage;
    const params = new URLSearchParams(search);

    const daemon = resolveValue(params, DAEMON_PARAM, storage, DAEMON_STORAGE_KEY);
    const token = resolveValue(params, TOKEN_PARAM, storage, TOKEN_STORAGE_KEY);

    return {
        url: daemon.value,
        token: token.value,
        fromQuery: daemon.fromQuery || token.fromQuery
    };
}

/**
 * The query string with the connection parameters removed, ready for `history.replaceState`.
 * Returns `''` when nothing is left, so the address bar ends up clean rather than with a bare
 * `?`. Any other parameter is preserved untouched.
 */
export function sanitizedSearch(search: string): string {
    const params = new URLSearchParams(search);
    params.delete(DAEMON_PARAM);
    params.delete(TOKEN_PARAM);
    const rest = params.toString();
    return rest.length === 0 ? '' : `?${rest}`;
}

/** A human-readable target for the connection UI ("same origin" when there is no override). */
export function describeTarget(target: DaemonTarget): string {
    return target.url ?? 'this page’s origin';
}
