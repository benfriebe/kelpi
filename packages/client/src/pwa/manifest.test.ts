import { describe, expect, it } from 'vitest';

import indexHtml from '../../index.html?raw';
import { presetChromeTheme } from '../chrome/theme';
import { CHROME_TOKEN_FALLBACKS } from '../chrome/tokens';
import {
    MANIFEST_FILE_NAME,
    MANIFEST_ICONS,
    MANIFEST_MIME,
    buildWebManifest,
    webManifestJson
} from './manifest';

describe('the web app manifest', () => {
    it('carries every field an install prompt reads', () => {
        const manifest = buildWebManifest();
        expect(manifest.name).toBe('Kelpi');
        expect(manifest.short_name).toBe('Kelpi');
        expect(manifest.start_url).toBe('/');
        expect(manifest.scope).toBe('/');
        expect(manifest.display).toBe('standalone');
        expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * Guardrail 3 of the phone program, as an assertion rather than a comment.
     *
     * A `?token=` in `start_url` would be written into the installed app's own metadata, the
     * browser's manifest cache and every screenshot of a Home Screen, and nothing in the app
     * would ever notice: the app would work perfectly, because the token is valid. So the test
     * is on the SHAPE - no query string anywhere in the manifest, not "no token in this one
     * string" - which also catches a cache-busting `?v=` somebody adds to an icon later.
     */
    it('puts no token and no query string in any URL it names', () => {
        const manifest = buildWebManifest();
        const urls = [manifest.start_url, manifest.scope, ...manifest.icons.map((icon) => icon.src)];
        for (const url of urls) {
            expect([url, url.includes('?')]).toEqual([url, false]);
            expect([url, url.includes('#')]).toEqual([url, false]);
            expect([url, url.startsWith('/')]).toEqual([url, true]);
        }
        expect(webManifestJson()).not.toMatch(/token/i);
    });

    it('names each icon as a well formed square PNG', () => {
        const manifest = buildWebManifest();
        expect(manifest.icons.map((icon) => icon.src)).toEqual(
            MANIFEST_ICONS.map((icon) => `/${icon.fileName}`)
        );
        for (const [index, icon] of manifest.icons.entries()) {
            const size = MANIFEST_ICONS[index]?.size;
            expect(icon.sizes).toMatch(/^\d+x\d+$/);
            expect(icon.sizes).toBe(`${String(size)}x${String(size)}`);
            expect(icon.type).toBe('image/png');
            expect(icon.purpose).toBe('any');
        }
    });

    /** 192 and 512 are the sizes Chrome's install criteria name; below that it refuses. */
    it('offers the two sizes an installable app needs', () => {
        expect(MANIFEST_ICONS.map((icon) => icon.size)).toEqual([192, 512]);
    });

    it('round-trips through JSON', () => {
        const json = webManifestJson();
        expect(JSON.parse(json)).toEqual(buildWebManifest());
        expect(json.endsWith('\n')).toBe(true);
    });

    /**
     * The colours are READS of the chrome token table, not literals that happen to match it.
     * `theme.test.ts` pins that table to the dark preset, so this makes the manifest's ground
     * the same one `styles.css` gives `<body>` by two hops rather than by coincidence.
     */
    it('takes its colours from the default theme, not from a copy of them', () => {
        const manifest = buildWebManifest();
        expect(manifest.background_color).toBe(CHROME_TOKEN_FALLBACKS['--kelpi-bg']);
        expect(manifest.theme_color).toBe(CHROME_TOKEN_FALLBACKS['--kelpi-bg']);
        expect(manifest.background_color).toBe(presetChromeTheme('dark').windowBackground);
    });

    it('states the MIME the daemon has to answer with', () => {
        expect(MANIFEST_MIME).toBe('application/manifest+json');
        expect(MANIFEST_FILE_NAME).toBe('manifest.webmanifest');
    });
});

/**
 * The served document's half of the contract.
 *
 * `favicon.test.ts` pins the icon links here for the reason that applies to all of it: nothing
 * in the app reads `index.html`, so nothing else would notice a link or a meta being dropped -
 * every test would stay green and the phone would simply stop installing. These are the tags
 * that turn a page into an installable app, so they get the same treatment.
 */
describe('the document the daemon serves', () => {
    it('links the manifest', () => {
        expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    });

    /**
     * `black-translucent` is the one with a consequence: it puts the app under the status bar,
     * which is what A3's `env(safe-area-inset-*)` padding exists to answer. Losing it silently
     * would leave the safe-area padding pushing content away from nothing.
     */
    it('declares the apple Home Screen metas', () => {
        expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
        expect(indexHtml).toContain(
            '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />'
        );
        expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="Kelpi" />');
    });

    /**
     * Drift guard: the two metas are hand-written hex in a file no bundler type-checks, so this
     * is the only thing standing between them and a theme change. Both are the GROUND of their
     * preset, `--kelpi-bg`, which is what `<body>` paints in `styles.css`.
     */
    it('paints the OS chrome the ground of whichever preset applies', () => {
        const dark = presetChromeTheme('dark').windowBackground;
        const light = presetChromeTheme('light').windowBackground;
        expect(indexHtml).toContain(
            `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${dark}" />`
        );
        expect(indexHtml).toContain(
            `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${light}" />`
        );
        expect(buildWebManifest().theme_color).toBe(dark);
    });

    /** The viewport meta A3 depends on, and the icon links, are still there. */
    it('keeps the viewport and icon declarations the phone plan builds on', () => {
        expect(indexHtml).toContain('viewport-fit=cover');
        expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    });
});
