/**
 * The service worker's one decision, as a pure function.
 *
 * `sw.ts` runs in a worker global that jsdom does not have and vitest cannot mount, so the
 * interesting half lives here instead: given the four facts a `FetchEvent` carries (method,
 * absolute URL, the worker's own origin, and the request mode), answer which of four
 * behaviours applies. The worker is then a thin shell around `routeRequest` plus four cache
 * strategies, and every rule below is pinned by `sw-routing.test.ts` rather than by a live
 * browser.
 *
 * Every phone rule in `pwa/` is an owner-directed divergence from the shipped Swift app, which
 * has no phone UI, no install and no worker to be faithful to. `manifest.ts`'s header states
 * that once for the package; this module inherits it.
 */

/**
 * What the worker does with a request.
 *
 *   - `bypass`  the worker does not call `respondWith` at all, so the browser performs its own
 *               default fetch. Nothing is read from a cache and nothing is written to one.
 *   - `shell`   the document load: network first with a short timeout, cached `/` as the
 *               fallback, so an installed app whose daemon is down opens on Kelpi's own
 *               connection screen instead of the browser's error page.
 *   - `asset`   `/assets/*`: cache first. These carry a content hash in the file name, so a
 *               hit is by construction the right bytes and a miss is a new build.
 *   - `root`    the manifest and the icons: network first, cache fallback. Same paths every
 *               build, different bytes, so a cache hit may be stale and the network wins when
 *               there is one.
 */
export type ServiceWorkerRoute = 'bypass' | 'shell' | 'asset' | 'root';

/** The facts a `FetchEvent` carries, extracted so the decision needs no browser. */
export interface ServiceWorkerRequestFacts {
    /** `request.method`. Anything but GET is bypassed. */
    readonly method: string;
    /** `request.url`: absolute, with its query string intact. */
    readonly url: string;
    /** `self.location.origin`: the origin the worker was registered on. */
    readonly origin: string;
    /** `request.mode`. `'navigate'` is the document load; everything else is a subresource. */
    readonly mode: string;
}

/** The daemon's WebSocket endpoint (`daemon/src/ws/http.ts` `WS_PATH`). */
export const WS_PATH = '/ws';

/** The content-pane asset route (`daemon/src/content/index.ts` `PANE_ASSETS_PREFIX`). */
export const PANE_ASSETS_PREFIX = '/pane-assets';

/** Vite's hashed output. The daemon serves this prefix `immutable` and nothing else. */
export const ASSET_PREFIX = '/assets/';

/** The navigation fallback, and the only entry of the precache list that is a document. */
export const SHELL_PATH = '/';

/**
 * The routing rule, in the order the checks have to happen.
 *
 * **The token stays out of the caches.** Guardrail 3 of the phone program, and the reason four
 * of these five bypasses exist. A paired phone arrives from a QR code at `/?token=kd_...` and
 * `app/config.ts` moves that token into `localStorage` and strips it from the address bar; the
 * pane-asset routes carry a credential derived from it in a PATH SEGMENT
 * (`content/asset-credential.ts`), which no query-string rule would ever catch; and `/ws`
 * carries it as `?token=`. So:
 *
 *   1. **not GET** - a POST is never a cache read or write anywhere in the Cache API's model.
 *   2. **cross-origin** - the worker's scope is this daemon; another origin's bytes are not
 *      ours to hold, and `?daemon=` can point the client at a different one entirely.
 *   3. **any query string** - `/?token=`, `/ws?token=`, and any future `?v=` cache-buster. A
 *      blanket rule rather than a token-name rule, because the failure it prevents is silent:
 *      a cached `?token=` response works perfectly while it sits in a cache the next person to
 *      open the app can read.
 *   4. **`/ws`** - a WebSocket upgrade is not a cacheable GET, and a plain GET of it is the
 *      daemon's 426. Checked by path as well as by query so a bare `/ws` cannot slip through.
 *   5. **`/pane-assets/*`** - a person's own files, served under a credential, with no content
 *      hash and no business surviving a page close.
 *
 * Only then does the positive half run: navigations take the shell strategy, `/assets/*` the
 * immutable one, and a path this build actually precached at the root takes the network-first
 * one. Anything else same-origin is bypassed rather than guessed at: `/healthz`, a deep link
 * the daemon answers with `index.html`, a file a later build adds. The worker holds what it
 * was told to hold and passes on everything else.
 */
export function routeRequest(
    facts: ServiceWorkerRequestFacts,
    rootPaths: ReadonlySet<string>
): ServiceWorkerRoute {
    if (facts.method.toUpperCase() !== 'GET') return 'bypass';

    let url: URL;
    try {
        url = new URL(facts.url);
    } catch {
        // Unparseable is not a thing a real FetchEvent produces, but guessing at one would be
        // the only place in this function that touches a cache without knowing the path.
        return 'bypass';
    }

    if (url.origin !== facts.origin) return 'bypass';
    if (url.search !== '') return 'bypass';

    const pathname = url.pathname;
    if (pathname === WS_PATH || pathname.startsWith(`${WS_PATH}/`)) return 'bypass';
    if (pathname === PANE_ASSETS_PREFIX || pathname.startsWith(`${PANE_ASSETS_PREFIX}/`)) return 'bypass';

    if (facts.mode === 'navigate') return 'shell';
    if (pathname.startsWith(ASSET_PREFIX)) return 'asset';
    if (rootPaths.has(pathname)) return 'root';
    return 'bypass';
}

/** What a network-first strategy does with the response it got. */
export type NetworkAnswer = 'use' | 'fall-back';

/**
 * Is a network response an answer, or is it the shape a dead daemon makes?
 *
 * **This is the device round's bug.** The first version of this worker treated any response at
 * all as success and only fell back when `fetch` threw. That is right when the daemon is on the
 * same machine, which is what `smoke:pwa` measured: kelpid stops, the port refuses the
 * connection, `fetch` rejects, the cached shell is served. It is wrong on the path a phone
 * actually takes. Behind `tailscale serve` the PROXY is still listening after the daemon dies,
 * and it answers, with a real response carrying a real body:
 *
 *     curl -o /dev/null -w '%{http_code}' https://werk.taila5f942.ts.net:8444/   ->  502
 *
 * So the worker handed the browser a 502 and the installed app rendered Chrome's "This page
 * isn't working", which is exactly the dead end this whole task exists to prevent. A 5xx is
 * never a statement about the URL; it is the absence of the thing that would make one.
 *
 * **A 4xx passes through.** It is the opposite case: something reached the origin, found this
 * specific URL, and decided about it. The daemon's own 404s are real answers (its static
 * handler falls back to `index.html` for unknown paths, so a navigation reaching a 404 means
 * something genuinely is not there), and `tailscale serve` answers 403 for a device that has
 * lost access. Serving the cached shell over either would replace a diagnosable refusal with an
 * app that boots, looks healthy, and loops forever on a connection it will never get. The
 * browser's own page for a 403 is worse-looking and more truthful, and A4's re-pair recovery is
 * the answer to the case that matters.
 *
 * A 3xx never reaches here: `fetch` follows redirects and reports the final status.
 */
export function networkAnswer(status: number): NetworkAnswer {
    return status >= 500 ? 'fall-back' : 'use';
}

/**
 * The precached paths that are neither the shell document nor hashed assets: the manifest, the
 * two manifest icons and the favicons.
 *
 * Split out of the precache list rather than written twice, so the set the `root` strategy
 * answers for is exactly the set `install` put in the cache. These paths are stable across
 * builds while their bytes are not (`vite.config.ts` emits them with no content hash, and the
 * daemon serves everything outside `/assets/` as `no-cache`), which is the whole reason they
 * get network-first rather than the cache-first `/assets/*` gets.
 */
export function rootPrecachePaths(precache: readonly string[]): ReadonlySet<string> {
    return new Set(
        precache.filter((entry) => entry !== SHELL_PATH && !entry.startsWith(ASSET_PREFIX))
    );
}
