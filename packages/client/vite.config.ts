import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// By path, not by `@kelpi/core/icon`: Vite externalizes bare specifiers when it loads this
// config, and Node cannot import the workspace packages' TypeScript sources. A relative import
// is bundled into the config instead, which is the only shape that works here.
import { kelpieMarkPng } from '../core/src/icon/png.js';
import { KELPIE_TAB_STROKE, kelpieMarkSvg } from '../core/src/icon/svg.js';
// By path for the same reason, even though this one is the client's own source: this file is
// loaded by Node, not by the bundle it configures, so `src/` is not on any alias it knows.
import { MANIFEST_FILE_NAME, MANIFEST_ICONS, webManifestJson } from './src/pwa/manifest.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Dev-server proxy target: the daemon's **HTTP/WS** port (`KELPID_HTTP_PORT`), not its control
 * TCP port — `/ws` is served by the same listener that serves the client build, so a proxy
 * aimed at the control socket's port would never upgrade. Override per shell with
 * `KELPI_DAEMON_URL` when the daemon took an ephemeral port; the alternative (and the one that
 * also works from another machine) is the client's own `?daemon=` override, which bypasses
 * the proxy entirely. See README.md.
 */
const daemonUrl = process.env['KELPI_DAEMON_URL'] ?? 'http://127.0.0.1:19470';

/**
 * The icon a browser scales into a tab. 64 rather than 32 so a hidpi tab has real pixels to
 * downsample, and the same canvas size `chrome/favicon.ts` redraws the badged mark on.
 */
const FAVICON_PNG_SIZE = 64;

/**
 * Apple's home-screen tile. iOS renders it near its own size rather than shrinking it into a
 * tab, so it takes the drawing's natural stroke with a one-pixel floor under it. The tab
 * floor would be an eighth of the tile in line width.
 */
const APPLE_TOUCH_SIZE = 180;

/**
 * The three tab icons, hoisted out of `faviconPlugin` so `serviceWorkerPlugin` can precache
 * exactly these names rather than retype them. The worker holds the root files this build
 * emits, and a second list of them would be free to drift from the one that emits them.
 */
const FAVICON_FILES = new Map<string, { readonly type: string; readonly body: string | Uint8Array }>([
  ['favicon.svg', { type: 'image/svg+xml', body: kelpieMarkSvg({ strokeWidth: KELPIE_TAB_STROKE }) }],
  ['favicon.png', { type: 'image/png', body: kelpieMarkPng(FAVICON_PNG_SIZE) }],
  ['apple-touch-icon.png', { type: 'image/png', body: kelpieMarkPng(APPLE_TOUCH_SIZE, { minStrokePx: 1 }) }],
]);

/**
 * Emit the tab icons rather than check them in.
 *
 * The Kelpi mark is data in `@kelpi/core/icon`, the same drawing the Dock tile, the menu-bar
 * glyph and the canvas favicon badge all render, so everything served here is printed from it
 * at build time. A checked-in icon would be a second copy of the artwork, free to drift from
 * the one everything else draws, which is exactly what this repo keeps refusing to have.
 *
 * Three files, because browsers do not agree on one:
 *
 *   - `favicon.svg`          resolution-independent, for browsers that render SVG icons.
 *   - `favicon.png`          for Safari, which renders none, and which is what an iPhone on
 *                            the tailnet is running. It is also the only icon Safari ever
 *                            shows: it ignores the href swap `chrome/favicon.ts` does for
 *                            the status badge.
 *   - `apple-touch-icon.png` the home-screen tile for "Add to Home Screen".
 *
 * The SVG is emitted at the tab stroke floor (`KELPIE_TAB_STROKE`), not the drawing's own
 * hairline, so the static icon and the canvas one that replaces it carry the same weight.
 *
 * The dev server answers the same paths from memory, so `vite dev` and the daemon-served build
 * show the same icons.
 */
function faviconPlugin(): Plugin {
  const files = FAVICON_FILES;
  return {
    name: 'kelpi:favicon',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files.get((request.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '');
        if (file === undefined) {
          next();
          return;
        }
        response.setHeader('Content-Type', file.type);
        response.end(file.body);
      });
    },
    generateBundle() {
      for (const [fileName, file] of files) {
        this.emitFile({ type: 'asset', fileName, source: file.body });
      }
    },
  };
}

/**
 * Emit the web app manifest and the icons it names, the same way and for the same reason.
 *
 * A sibling of `faviconPlugin` rather than three more rows in its map: those three files are the
 * identity a browser TAB shows, these are the identity an installed app shows, and the daemon
 * has to answer this one with a MIME it does not need for the others
 * (`daemon/src/ws/http.ts`, `application/manifest+json`).
 *
 * The manifest body is `src/pwa/manifest.ts` - a pure builder, so what a test asserts is exactly
 * what is written here. The icons are the same `kelpieMarkPng` the tab icons are, at the two
 * sizes the manifest names, and they take the tile's stroke rule rather than the tab's:
 * `minStrokePx: 1`, as `apple-touch-icon.png` above does. That floor is inert at these sizes -
 * the mark's natural stroke is 12px on a 1024 canvas, so 2.25px at 192 and 6px at 512 - and it
 * is stated anyway so the intent survives a size change. The tab default
 * (`KELPIE_MIN_STROKE_FRACTION`, an eighth of the canvas) would put a 12px line on the 192 tile
 * and a 32px one on the 512: right for something scaled down to 16px, wrong for a Home Screen
 * icon shown near its own size.
 *
 * These paths carry no content hash - they are not under `/assets/` - so an installed app's
 * manifest URL and icon URLs are stable across builds while their bytes are not. That is the
 * shape a service worker (A2) has to plan for; it is also why the daemon serves everything
 * outside `/assets/` as `no-cache`.
 */
function manifestPlugin(): Plugin {
  const files = new Map<string, { readonly type: string; readonly body: string | Uint8Array }>([
    [MANIFEST_FILE_NAME, { type: 'application/manifest+json', body: webManifestJson() }],
    ...MANIFEST_ICONS.map(
      (icon) =>
        [icon.fileName, { type: 'image/png', body: kelpieMarkPng(icon.size, { minStrokePx: 1 }) }] as const
    ),
  ]);
  return {
    name: 'kelpi:manifest',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files.get((request.url ?? '').split('?')[0]?.replace(/^\//, '') ?? '');
        if (file === undefined) {
          next();
          return;
        }
        response.setHeader('Content-Type', file.type);
        response.end(file.body);
      });
    },
    generateBundle() {
      for (const [fileName, file] of files) {
        this.emitFile({ type: 'asset', fileName, source: file.body });
      }
    },
  };
}

/**
 * The service worker (A2), and why it is a second Rollup entry rather than a second bundler.
 *
 * The file has to land at `/sw.js`: at the SITE ROOT, because a worker's default scope is the
 * directory it is served from and `/` is the scope this one needs; and with NO content hash,
 * because the browser re-fetches that exact URL to check for an update, so a name that moved
 * every build would orphan the installed worker instead of updating it. It also has to contain
 * no `import` statement, because a classic worker script cannot have one and
 * `type: 'module'` workers are still not everywhere (Safari shipped them in 16.4; the phones
 * this is for are older than that assumption is safe).
 *
 * Two shapes do that. The one NOT taken is a self-contained plugin in `manifestPlugin`'s shape
 * that bundles `sw.ts` itself and emits the bytes: it needs a bundler of its own, and the only
 * one reachable from `packages/client` is esbuild as a transitive dependency of Vite, which is
 * not ours to import - `transformWithEsbuild` transpiles one file and does not bundle, so it
 * cannot pull in `sw-routing.ts`, and adding esbuild as a direct dependency to bundle 4 KB is a
 * lockfile change for nothing. The one taken is a second `rollupOptions.input`, with
 * `entryFileNames` answering `sw.js` for that chunk and Vite's own default for every other.
 * The worker imports exactly one module of its own and nothing the app also imports, so Rollup
 * gives it a self-contained chunk with nothing to share and nothing to import;
 * `serviceWorkerPlugin` asserts that rather than assuming it. Measured: building this tree with
 * the second entry and without it produces the same ten files under `dist/assets/`, with the
 * same content hashes and the same sizes, so the app's output is untouched by any of this.
 */
const SERVICE_WORKER_ENTRY = path.resolve(here, 'src/pwa/sw.ts');
const SERVICE_WORKER_FILE = 'sw.js';

/** The chunk name Rollup gives the entry above; `entryFileNames` keys on it. */
const SERVICE_WORKER_CHUNK = 'sw';

/**
 * The two tokens `src/pwa/sw.ts` carries and this plugin replaces. Both live inside string
 * literals in the worker's source, so the replacement is a regex over the emitted chunk and
 * never a parse of JavaScript. `workbox-build`'s `injectManifest` does the same thing for the
 * same reason: a precache list is an OUTPUT of the build it belongs to, so `define` (which runs
 * before a single hashed name exists) cannot carry it.
 */
const PRECACHE_TOKEN = '__KELPI_SW_PRECACHE__';
const VERSION_TOKEN = '__KELPI_SW_VERSION__';

/**
 * Everything the worker precaches: the shell document, this build's hashed assets, and the root
 * files the two plugins above emit.
 *
 * The hashed half is read off the bundle, which is the only place those names exist; the
 * unhashed half is read off the same constants that emit them (`MANIFEST_FILE_NAME`,
 * `MANIFEST_ICONS`, `FAVICON_FILES`), so it cannot drift. Source maps are excluded: nothing
 * fetches them unless a devtools pane is open, and holding them would double the cache for a
 * file no phone will ever ask for.
 */
function precacheList(bundle: Readonly<Record<string, unknown>>): readonly string[] {
  const hashed = Object.keys(bundle)
    .filter((name) => name.startsWith('assets/') && !name.endsWith('.map'))
    .sort()
    .map((name) => `/${name}`);
  const root = [MANIFEST_FILE_NAME, ...MANIFEST_ICONS.map((icon) => icon.fileName), ...FAVICON_FILES.keys()]
    .sort()
    .map((name) => `/${name}`);
  return ['/', ...hashed, ...root];
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'kelpi:service-worker',
    /**
     * `enforce: 'post'` plus `order: 'post'` on the hook below, and both are load-bearing.
     *
     * `generateBundle` is the first hook where the hashed names exist, but it is not the last
     * hook that CHANGES them: Vite's own `vite:css-post` deletes the empty JavaScript facade it
     * generated for a dynamically imported stylesheet (this build has one, for the fallback
     * xterm engine's CSS) in its own `generateBundle`. Reading the bundle before that ran put
     * `/assets/xterm-<hash>.js` in the precache list, and `cache.addAll` is all-or-nothing, so
     * the install 404d and the worker never activated at all. Measured: a first build listed 16
     * entries of which one was never written to disk.
     */
    enforce: 'post',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const chunk = bundle[SERVICE_WORKER_FILE];
        if (chunk === undefined || chunk.type !== 'chunk') {
          throw new Error(`the service worker did not build to ${SERVICE_WORKER_FILE}`);
        }

        const precache = precacheList(bundle);
        // The cache name is a hash of the precache list: the honest version for this cache, and
        // the only one available at build time. The daemon's `build` is the string '1' in every
        // build ever made (`daemon/src/boot/version.ts:16-18` hard-codes `DAEMON_BUILD` and
        // nothing in the repo sets its `KELPID_BUILD` override), so a cache keyed on it would
        // never be replaced; the client bundle carries no build id of its own at all. This one
        // changes when and only when the cached BYTES change, because every `/assets/` entry in
        // the list carries Vite's content hash.
        const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12);

        let code = chunk.code.replace(new RegExp(`(["'\`])${PRECACHE_TOKEN}\\1`, 'g'), () =>
          JSON.stringify(JSON.stringify(precache))
        );
        code = code.replaceAll(VERSION_TOKEN, version);
        if (code === chunk.code || code.includes(PRECACHE_TOKEN) || code.includes(VERSION_TOKEN)) {
          throw new Error(
            `the service worker still carries ${PRECACHE_TOKEN} or ${VERSION_TOKEN}; an unreplaced ` +
              'placeholder would ship a worker that throws on its first line'
          );
        }

        // A classic worker script cannot import. Rollup emits ES output, so this is the check
        // that the chunk really did come out self-contained rather than sharing one with the
        // app - a failure that would otherwise be silent, since the worker would register, fail
        // to parse, and the app would go on working exactly as it does without one.
        if (/(^|[\s;}])(?:import|export)[\s({*]/.test(code)) {
          throw new Error(
            `${SERVICE_WORKER_FILE} contains an import or export statement, so it cannot load as ` +
              'a classic worker script'
          );
        }

        chunk.code = code;
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), faviconPlugin(), manifestPlugin(), serviceWorkerPlugin()],
  build: {
    rollupOptions: {
      // The html entry has to be named explicitly: setting `input` at all replaces Vite's
      // default, which is this same file.
      input: {
        index: path.resolve(here, 'index.html'),
        [SERVICE_WORKER_CHUNK]: SERVICE_WORKER_ENTRY,
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === SERVICE_WORKER_CHUNK ? SERVICE_WORKER_FILE : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    proxy: {
      '/ws': { target: daemonUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
