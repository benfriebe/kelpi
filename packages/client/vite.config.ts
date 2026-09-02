import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// By path, not by `@kelpi/core/icon`: Vite externalizes bare specifiers when it loads this
// config, and Node cannot import the workspace packages' TypeScript sources. A relative import
// is bundled into the config instead, which is the only shape that works here.
import { kelpieMarkPng } from '../core/src/icon/png.js';
import { KELPIE_TAB_STROKE, kelpieMarkSvg } from '../core/src/icon/svg.js';

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
  const files = new Map<string, { readonly type: string; readonly body: string | Uint8Array }>([
    ['favicon.svg', { type: 'image/svg+xml', body: kelpieMarkSvg({ strokeWidth: KELPIE_TAB_STROKE }) }],
    ['favicon.png', { type: 'image/png', body: kelpieMarkPng(FAVICON_PNG_SIZE) }],
    ['apple-touch-icon.png', { type: 'image/png', body: kelpieMarkPng(APPLE_TOUCH_SIZE, { minStrokePx: 1 }) }],
  ]);
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

export default defineConfig({
  plugins: [react(), tailwindcss(), faviconPlugin()],
  server: {
    proxy: {
      '/ws': { target: daemonUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
