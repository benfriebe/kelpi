/**
 * The service worker: minimal, and honest about what it holds.
 *
 * Built by `vite.config.ts` as a second Rollup entry that lands at `/sw.js` with no content
 * hash and no `import` statement in its output, and served by the daemon with
 * `Service-Worker-Allowed: /` and `Cache-Control: no-cache` (`daemon/src/ws/http.ts`).
 *
 * What it exists for, and the only thing it promises: **an installed Kelpi opens.** Tap the
 * Home Screen icon with the Mac asleep and the app paints its own connection screen and starts
 * retrying, instead of Safari's "cannot connect to the server" page, which is a dead end with
 * no retry, no branding and no way to tell a sleeping Mac from a revoked pairing. Everything
 * past that first paint needs the daemon, and this worker never pretends otherwise: there is no
 * offline mode, no queued command, no cached pane content.
 *
 * The decision of what to do with a request is `sw-routing.ts`, a pure function with its own
 * tests, because this file runs in a global vitest cannot mount. Read the guardrail there: the
 * token stays out of the caches, and four of the five bypasses are that rule.
 *
 * **The update policy** (phone program section 7, decided by the coordinator): `skipWaiting()`
 * on install, `clients.claim()` on activate, old caches deleted on activate, and no prompt. The
 * page that is running keeps the bundle it already loaded; it picks up the new one on its next
 * navigation, which is network-first, so a reachable daemon always hands back the current
 * `index.html`. That is the whole update story, and it needs no prompt because a Kelpi client
 * and its daemon are version-matched by construction: the daemon serves this bundle
 * (ARCHITECTURE.md), so a new build IS a new daemon.
 *
 * Two corrections to the plan's wording, from reading the code rather than trusting it. There
 * is no "reload me" path in the client: `grep -rn "location.reload" packages/` finds nothing
 * outside web-pane commands, and `daemon.info.build` has zero read sites
 * (`client/src/state/store.ts:124-135`). What the protocol actually answers is a PROTOCOL skew,
 * and it answers it by refusing: `daemon/src/ws/sync.ts:1613-1620` rejects a mismatched
 * `protocolVersion` with `protocol-mismatch`, and the client stops retrying and paints
 * `connection-splash` at `data-status="rejected"` with the daemon's sentence. So a prompt here
 * would still be a second answer to a question already answered, just a differently worded
 * question, and the reason no stale shell can survive is the network-first navigation below
 * rather than a reload nobody wrote.
 */

import { SHELL_PATH, rootPrecachePaths, routeRequest } from './sw-routing';

// ── the worker global, declared narrowly ────────────────────────────────────────────

/*
 * `/// <reference lib="webworker" />` is the usual way to type this file, and it is wrong here:
 * the reference is program-wide, not file-wide, so pulling `WebWorker` into a client whose
 * tsconfig declares `["ES2023", "DOM", "DOM.Iterable"]` redeclares `self`, `Event`, `location`
 * and about forty other names against the DOM lib and the whole package stops typechecking. A
 * second tsconfig for one file is the alternative, and it would take `pnpm typecheck`, the
 * vitest config and `verify.mjs` with it. So the four members this file touches are declared
 * structurally instead. `Request`, `Response`, `CacheStorage` and `fetch` are already in the
 * DOM lib and mean the same thing in both globals.
 */

interface ExtendableEventLike {
    waitUntil(promise: Promise<unknown>): void;
}

interface FetchEventLike extends ExtendableEventLike {
    readonly request: Request;
    respondWith(response: Response | Promise<Response>): void;
}

interface ServiceWorkerGlobalScopeLike {
    readonly location: { readonly origin: string };
    readonly clients: { claim(): Promise<void> };
    skipWaiting(): Promise<void>;
    addEventListener(type: 'install', listener: (event: ExtendableEventLike) => void): void;
    addEventListener(type: 'activate', listener: (event: ExtendableEventLike) => void): void;
    addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
}

const worker = self as unknown as ServiceWorkerGlobalScopeLike;

// ── what this build cached ──────────────────────────────────────────────────────────

/*
 * Both values below are placeholders that `vite.config.ts` rewrites in `generateBundle`, where
 * the hashed asset names finally exist; the plugin throws if either token survives, so an
 * unreplaced placeholder is a failed build and never a shipped worker. This is the technique
 * `workbox-build`'s `injectManifest` uses, for the same reason: a precache list has to be the
 * output of the build it belongs to, and `define` runs before any of those names are known.
 */

/**
 * The cache name, versioned by a hash of the precache list itself.
 *
 * NOT the daemon's build id. `daemon/src/boot/version.ts:16-18` hard-codes `DAEMON_BUILD = '1'`
 * with a `KELPID_BUILD` runtime override that nothing in the repo ever sets, so it is the same
 * string in every build that has ever been made: a cache keyed on it would never be replaced.
 * The precache list is the honest version, and a strictly better one, because it changes when
 * and only when the CACHED BYTES change - every entry under `/assets/` carries Vite's content
 * hash, so a rebuild that alters one module alters this name, and a rebuild that alters nothing
 * leaves it alone and keeps the installed app's cache warm.
 */
const CACHE_PREFIX = 'kelpi-shell-';
const CACHE_NAME = `${CACHE_PREFIX}__KELPI_SW_VERSION__`;

/**
 * Everything this worker holds: `/`, this build's `/assets/*`, and the root files with no
 * content hash in their names (the manifest, its two icons, the three favicons).
 *
 * Parsed from a JSON string rather than spliced in as an array literal so the injection is one
 * quoted token in one expression, which a regex can replace without parsing JavaScript.
 */
const PRECACHE = JSON.parse('__KELPI_SW_PRECACHE__') as readonly string[];

/** The subset that gets the network-first strategy. See `rootPrecachePaths`. */
const ROOT_PATHS = rootPrecachePaths(PRECACHE);

/**
 * How long a navigation waits for the daemon before falling back to the cached shell.
 *
 * A dead daemon on the tailnet is two different failures. A Mac that is awake with kelpid
 * stopped refuses the connection immediately, and the fallback is instant (measured in the
 * `phone-pwa-shell` smoke: the reload after `SIGTERM` paints Kelpi's own splash in well under a
 * second). A Mac that is ASLEEP accepts nothing at all, and the TCP connect sits there until
 * the platform gives up, which on iOS is tens of seconds of a white screen. This is the number
 * that turns the second case into the first. 2.5s rather than something tighter because a real
 * tailnet round trip on a cold cellular link is a few hundred milliseconds and a wrong guess
 * here costs a stale shell on a working daemon; rather than something longer because the thing
 * behind the fallback is the app's own "Connecting to kelpid…" screen, which starts its own
 * reconnect loop the moment it paints, so waiting is never the faster route to a connection.
 */
const SHELL_NETWORK_TIMEOUT_MS = 2_500;

/** The same reasoning for an icon or the manifest, which nothing is waiting on. */
const ROOT_NETWORK_TIMEOUT_MS = 2_500;

// ── lifecycle ───────────────────────────────────────────────────────────────────────

worker.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            // `addAll` is all-or-nothing: one entry that 404s and the whole install fails, so a
            // half-populated cache cannot exist. That is the behaviour worth having here, since
            // a shell cached without the assets it references is worse than no cache at all.
            await cache.addAll([...PRECACHE]);
            // Section 7: skip waiting. There is no second bundle to be careful about - the page
            // that is open keeps the JavaScript it already parsed either way, and a worker
            // sitting in `waiting` until every tab closes is how an installed app on a phone,
            // which is never closed, ends up months behind.
            await worker.skipWaiting();
        })()
    );
});

worker.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // Only this worker's own caches, by prefix. A cache belonging to something else on
            // the origin is not ours to delete.
            const names = await caches.keys();
            await Promise.all(
                names
                    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
                    .map(async (name) => caches.delete(name))
            );
            await worker.clients.claim();
        })()
    );
});

// ── fetch ───────────────────────────────────────────────────────────────────────────

worker.addEventListener('fetch', (event) => {
    const route = routeRequest(
        {
            method: event.request.method,
            url: event.request.url,
            origin: worker.location.origin,
            mode: event.request.mode
        },
        ROOT_PATHS
    );

    // `bypass` returns without calling `respondWith`, which is not the same as fetching and
    // returning the result: the request never enters the worker's control at all, so nothing
    // about it can be observed, buffered or accidentally stored here.
    if (route === 'bypass') return;
    if (route === 'shell') {
        event.respondWith(shellResponse(event.request));
        return;
    }
    if (route === 'asset') {
        event.respondWith(immutableAsset(event.request));
        return;
    }
    event.respondWith(rootFile(event.request));
});

/**
 * The document: network first, cached `/` as the fallback.
 *
 * **Nothing is written back.** The `/` in the cache is the one `install` fetched, from the same
 * build as the `/assets/*` beside it; overwriting it with a newer daemon's `index.html` would
 * leave a document naming asset hashes this cache does not hold, which is exactly the offline
 * failure the cache exists to prevent. A new build gets a new worker (its `sw.js` bytes contain
 * the asset hashes, and the daemon serves that file `no-cache`, so the browser's byte-compare
 * really does see the change) and therefore a new, self-consistent cache.
 */
async function shellResponse(request: Request): Promise<Response> {
    try {
        const response = await fetchWithTimeout(request, SHELL_NETWORK_TIMEOUT_MS);
        if (response.ok) return response;
        // A non-2xx from a reachable daemon is a real answer about a real path; the cached
        // shell is only better than an error page when there was no answer at all.
        return response;
    } catch {
        const cached = await cachedShell();
        if (cached !== undefined) return cached;
        // Nothing cached and nothing reachable: let the browser draw its own failure, which is
        // still the truth. Re-fetching without the timeout is what produces that page.
        return await fetch(request);
    }
}

/** `/assets/*`: cache first. The content hash in the name is the version. */
async function immutableAsset(request: Request): Promise<Response> {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(request);
    if (hit !== undefined) return hit;
    // A miss is an asset from a DIFFERENT build (an old page still running against a new
    // daemon). It is not this cache's to hold, so it goes to the network and stays there.
    return await fetch(request);
}

/** The manifest and the icons: network first, cache fallback. Stable paths, changing bytes. */
async function rootFile(request: Request): Promise<Response> {
    try {
        const response = await fetchWithTimeout(request, ROOT_NETWORK_TIMEOUT_MS);
        if (response.ok) return response;
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(request)) ?? response;
    } catch {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(request);
        if (hit !== undefined) return hit;
        return await fetch(request);
    }
}

async function cachedShell(): Promise<Response | undefined> {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(SHELL_PATH);
}

/**
 * `fetch` with a deadline, aborted rather than abandoned.
 *
 * A bare `Promise.race` would leave the losing fetch running and, on a navigation, holding a
 * socket open against a machine that is not answering - which is precisely the state this
 * timeout exists because of.
 */
async function fetchWithTimeout(request: Request, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(request, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
