import { describe, expect, it } from 'vitest';

import {
    ASSET_PREFIX,
    PANE_ASSETS_PREFIX,
    SHELL_PATH,
    WS_PATH,
    networkAnswer,
    rootPrecachePaths,
    routeRequest,
    type ServiceWorkerRequestFacts,
    type ServiceWorkerRoute
} from './sw-routing';

const ORIGIN = 'https://mac.tailnet.ts.net';

/** The list `vite.config.ts` injects, in the shape it injects it. */
const PRECACHE = [
    SHELL_PATH,
    '/assets/index-a1b2c3d4.js',
    '/assets/index-e5f6a7b8.css',
    '/manifest.webmanifest',
    '/icon-192.png',
    '/icon-512.png',
    '/favicon.svg',
    '/favicon.png',
    '/apple-touch-icon.png'
];

const ROOT_PATHS = rootPrecachePaths(PRECACHE);

function route(
    partial: Partial<ServiceWorkerRequestFacts> & { readonly url: string }
): ServiceWorkerRoute {
    const facts: ServiceWorkerRequestFacts = {
        method: 'GET',
        origin: ORIGIN,
        mode: 'no-cors',
        ...partial
    };
    return routeRequest(facts, ROOT_PATHS);
}

/** The document load, which is the only request whose `mode` is `navigate`. */
function navigate(url: string): ServiceWorkerRoute {
    return route({ url, mode: 'navigate' });
}

describe('what the service worker never touches', () => {
    /**
     * Guardrail 3 of the phone program: the token stays out of the caches. Each of these is a
     * separate rule in `routeRequest` and each is pinned separately, because a single blanket
     * assertion would pass with any one of them deleted.
     */
    it('bypasses the WebSocket endpoint, with a token and without one', () => {
        expect(route({ url: `${ORIGIN}${WS_PATH}` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}${WS_PATH}?token=kd_secret` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}${WS_PATH}?x=y` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}${WS_PATH}/` })).toBe('bypass');
        // A navigation to it would be a person typing the URL; still nothing to cache.
        expect(navigate(`${ORIGIN}${WS_PATH}`)).toBe('bypass');
    });

    it('bypasses pane assets, whose credential is a path segment and not a query', () => {
        expect(route({ url: `${ORIGIN}${PANE_ASSETS_PREFIX}/pane-1/diagram.png` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}${PANE_ASSETS_PREFIX}/c/abc123/pane-1/diagram.png` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}${PANE_ASSETS_PREFIX}` })).toBe('bypass');
    });

    it('bypasses anything carrying a query string, including the paired phone`s first open', () => {
        expect(navigate(`${ORIGIN}/?token=kd_secret`)).toBe('bypass');
        expect(navigate(`${ORIGIN}/?daemon=http://other:1234`)).toBe('bypass');
        expect(navigate(`${ORIGIN}/?shellWindow=abc`)).toBe('bypass');
        expect(route({ url: `${ORIGIN}/icon-192.png?v=2` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}/assets/index-a1b2c3d4.js?v=2` })).toBe('bypass');
        // An empty query string is still a query string as far as `URL` is concerned only when
        // the `?` is present; `/?` parses to search `''`, so it stays a navigation.
        expect(navigate(`${ORIGIN}/`)).toBe('shell');
    });

    it('bypasses everything that is not a GET', () => {
        for (const method of ['POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']) {
            expect([method, route({ url: `${ORIGIN}/`, method })]).toEqual([method, 'bypass']);
            expect([method, route({ url: `${ORIGIN}/`, method, mode: 'navigate' })]).toEqual([
                method,
                'bypass'
            ]);
        }
        expect(route({ url: `${ORIGIN}/`, method: 'get' })).toBe('root'.replace('root', 'bypass'));
    });

    it('bypasses another origin, however familiar it looks', () => {
        expect(route({ url: 'https://other.ts.net/assets/index-a1b2c3d4.js' })).toBe('bypass');
        expect(navigate('https://other.ts.net/')).toBe('bypass');
        // Same host, different scheme and port: three separate origins, all foreign.
        expect(route({ url: 'http://mac.tailnet.ts.net/icon-192.png' })).toBe('bypass');
        expect(route({ url: 'https://mac.tailnet.ts.net:8443/icon-192.png' })).toBe('bypass');
    });

    it('bypasses a same-origin path this build did not precache', () => {
        expect(route({ url: `${ORIGIN}/healthz` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}/icon-1024.png` })).toBe('bypass');
        expect(route({ url: `${ORIGIN}/assets` })).toBe('bypass');
    });

    it('bypasses a URL it cannot parse rather than guessing', () => {
        expect(route({ url: 'not a url' })).toBe('bypass');
        expect(route({ url: '/relative/only.js' })).toBe('bypass');
    });
});

describe('what the service worker answers for', () => {
    it('takes the shell strategy for every navigation, deep links included', () => {
        expect(navigate(`${ORIGIN}/`)).toBe('shell');
        expect(navigate(`${ORIGIN}/some/client/route`)).toBe('shell');
        expect(navigate(`${ORIGIN}/index.html`)).toBe('shell');
    });

    it('takes the immutable strategy for hashed assets', () => {
        expect(route({ url: `${ORIGIN}${ASSET_PREFIX}index-a1b2c3d4.js` })).toBe('asset');
        expect(route({ url: `${ORIGIN}${ASSET_PREFIX}index-e5f6a7b8.css` })).toBe('asset');
        // A hashed asset this build did not emit is still under the immutable prefix: the name
        // is the version, so serving a hit is always correct and a miss just goes to network.
        expect(route({ url: `${ORIGIN}${ASSET_PREFIX}KelpiMono-99887766.woff2` })).toBe('asset');
    });

    it('takes the network-first strategy for the root files the build emits', () => {
        expect(route({ url: `${ORIGIN}/manifest.webmanifest` })).toBe('root');
        expect(route({ url: `${ORIGIN}/icon-192.png` })).toBe('root');
        expect(route({ url: `${ORIGIN}/icon-512.png` })).toBe('root');
        expect(route({ url: `${ORIGIN}/apple-touch-icon.png` })).toBe('root');
        expect(route({ url: `${ORIGIN}/favicon.svg` })).toBe('root');
        expect(route({ url: `${ORIGIN}/favicon.png` })).toBe('root');
    });
});

describe('what counts as an answer from the network', () => {
    /**
     * The device round's bug, as an assertion. With the daemon dead behind `tailscale serve`
     * the proxy is still listening and answers 502 with a real body, so a rule that only fell
     * back on a thrown `fetch` handed the browser that page. Measured from the Mac:
     * `curl -o /dev/null -w '%{http_code}' https://werk.taila5f942.ts.net:8444/` returns 502
     * with the sandboxed daemon killed and serve still fronting its port.
     */
    it('treats every 5xx as the daemon being gone', () => {
        for (const status of [500, 501, 502, 503, 504, 507, 599]) {
            expect([status, networkAnswer(status)]).toEqual([status, 'fall-back']);
        }
    });

    it('uses a 2xx', () => {
        for (const status of [200, 201, 204, 206, 299]) {
            expect([status, networkAnswer(status)]).toEqual([status, 'use']);
        }
    });

    /**
     * A 4xx passes through. Something reached the origin, found this URL and decided about it:
     * the daemon's static handler falls back to `index.html` for unknown paths, so a navigation
     * that really does reach a 404 means something is genuinely not there, and `tailscale serve`
     * answers 403 for a device that has lost access. A cached shell over either would replace a
     * diagnosable refusal with an app that boots, looks healthy and loops on a connection it
     * will never get.
     */
    it('passes a 4xx through rather than masking a refusal with a stale shell', () => {
        for (const status of [400, 401, 403, 404, 410, 426, 429, 499]) {
            expect([status, networkAnswer(status)]).toEqual([status, 'use']);
        }
    });
});

describe('the root path set', () => {
    it('is the precache list without the document and without the hashed assets', () => {
        expect([...rootPrecachePaths(PRECACHE)].sort()).toEqual(
            [
                '/apple-touch-icon.png',
                '/favicon.png',
                '/favicon.svg',
                '/icon-192.png',
                '/icon-512.png',
                '/manifest.webmanifest'
            ].sort()
        );
    });

    it('never contains the shell, which has its own strategy', () => {
        expect(rootPrecachePaths(PRECACHE).has(SHELL_PATH)).toBe(false);
    });
});
