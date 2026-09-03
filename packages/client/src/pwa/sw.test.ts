import { describe, expect, it } from 'vitest';

import source from './sw.ts?raw';

/**
 * `sw.ts` runs in a `ServiceWorkerGlobalScope`. vitest cannot mount one, jsdom does not have
 * one, and a hand-rolled fake of `caches` + `FetchEvent` would be a test of the fake. So the
 * behaviour is tested in two other places instead: the decisions are pure functions in
 * `sw-routing.ts` with their own tests, and the whole worker runs against a real daemon in a
 * real Chromium in `packages/shell/scripts/pwa-smoke.mjs` (`phone-pwa-shell`).
 *
 * What is left, and what this file pins, are two properties of the worker that are invariants of
 * its SOURCE rather than of any one request, and whose violation is silent. Reading the source
 * for a rule that cannot be reached any other way is the shape `web-smoke.mjs` already uses for
 * `POSTER_DEADLINE_MS`.
 */
describe('the worker, as source', () => {
    /**
     * **The cache is written once, at install, and never again.**
     *
     * Every strategy returns network responses without storing them, and that is not a
     * simplification: the `/` in the cache belongs to the same build as the `/assets/*` beside
     * it, so writing a newer daemon's `index.html` over it would leave a document naming asset
     * hashes the cache does not hold - the exact offline failure the cache exists to prevent.
     * The device round adds a second reason: with the daemon dead behind `tailscale serve` the
     * responses arriving here are the proxy's 502 pages, and a `put` anywhere in a strategy
     * would quietly persist one under `/` or `/icon-192.png`. Nothing would notice until an
     * installed app opened to a Bad Gateway page it was serving to itself.
     */
    it('writes to the cache exactly once, in install, and never puts', () => {
        expect(source).not.toMatch(/\.put\s*\(/);
        expect(source.match(/\.addAll\s*\(/g)).toHaveLength(1);
        const install = source.slice(source.indexOf("addEventListener('install'"), source.indexOf("addEventListener('activate'"));
        expect(install).toMatch(/\.addAll\s*\(/);
    });

    /**
     * Both placeholders have to survive verbatim into the built chunk for `vite.config.ts` to
     * replace them; the plugin throws when they do not. This is the other half of that contract,
     * on the source side: a rename here without a rename there fails the build, and a rename
     * here alone fails this test with the reason.
     */
    it('carries the two tokens the build injects', () => {
        expect(source).toContain("JSON.parse('__KELPI_SW_PRECACHE__')");
        expect(source).toContain('__KELPI_SW_VERSION__');
    });

    /** The bypass rule is a `return` with no `respondWith`, not a fetch-and-return. */
    it('lets a bypassed request leave the worker untouched', () => {
        expect(source).toMatch(/if \(route === 'bypass'\) return;/);
    });
});
