import fs from 'node:fs/promises';
import path from 'node:path';
import type { Hono } from 'hono';
import type { PluginService } from './service.js';

const MIME: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm' };

/** Only ui/ assets of a currently attached view; never an owner token or filesystem route. */
export function pluginAssetsRoute(plugins: PluginService): (app: Hono) => void {
    return app => {
        app.on(['GET', 'HEAD'], '/plugin-assets/:lease/*', async c => {
            try {
                const relative = c.req.path.split('/').slice(3).join('/');
                const file = plugins.viewAsset(c.req.param('lease'), relative);
                const bytes = await fs.readFile(file);
                return new Response(c.req.method === 'HEAD' ? null : bytes, { headers: {
                    'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-store',
                    'Referrer-Policy': 'no-referrer',
                    'X-Content-Type-Options': 'nosniff',
                    // Also sandbox a package HTML document opened outside its host iframe.
                    'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'"
                } });
            } catch { return c.text('not found\n', 404); }
        });
    };
}
