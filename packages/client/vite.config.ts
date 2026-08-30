import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * Dev-server proxy target: the daemon's **HTTP/WS** port (`KELPID_HTTP_PORT`), not its control
 * TCP port — `/ws` is served by the same listener that serves the client build, so a proxy
 * aimed at the control socket's port would never upgrade. Override per shell with
 * `KELPI_DAEMON_URL` when the daemon took an ephemeral port; the alternative (and the one that
 * also works from another machine) is the client's own `?daemon=` override, which bypasses
 * the proxy entirely. See README.md.
 */
const daemonUrl = process.env['KELPI_DAEMON_URL'] ?? 'http://127.0.0.1:19470';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/ws': { target: daemonUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
});
