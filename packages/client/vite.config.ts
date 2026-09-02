import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

// By path, not by `@kelpi/core/icon`: Vite externalizes bare specifiers when it loads this
// config, and Node cannot import the workspace packages' TypeScript sources. A relative import
// is bundled into the config instead, which is the only shape that works here.
import { kelpieMarkSvg } from '../core/src/icon/svg.js';

/**
 * Dev-server proxy target: the daemon's **HTTP/WS** port (`KELPID_HTTP_PORT`), not its control
 * TCP port — `/ws` is served by the same listener that serves the client build, so a proxy
 * aimed at the control socket's port would never upgrade. Override per shell with
 * `KELPI_DAEMON_URL` when the daemon took an ephemeral port; the alternative (and the one that
 * also works from another machine) is the client's own `?daemon=` override, which bypasses
 * the proxy entirely. See README.md.
 */
const daemonUrl = process.env['KELPI_DAEMON_URL'] ?? 'http://127.0.0.1:19470';

/** What `index.html` links as the document's icon, and therefore a fixed name, never hashed. */
const FAVICON_FILE = 'favicon.svg';

/**
 * Emit the tab icon rather than check one in.
 *
 * The Kelpi mark is data in `@kelpi/core/icon`, the same drawing the Dock tile, the menu-bar
 * glyph and the canvas favicon badge all render, so the served `/favicon.svg` is printed from
 * it at build time. A checked-in SVG here would be a second copy of the artwork, free to drift
 * from the icon everything else draws, which is exactly what this repo keeps refusing to have.
 *
 * The dev server answers the same path from memory, so `vite dev` and the daemon-served build
 * show the same tab icon.
 */
function faviconPlugin(): Plugin {
  const svg = kelpieMarkSvg();
  return {
    name: 'kelpi:favicon',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if ((request.url ?? '').split('?')[0] !== `/${FAVICON_FILE}`) {
          next();
          return;
        }
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(svg);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: FAVICON_FILE, source: svg });
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
