/**
 * The daemon's HTTP surface (WP2.7): health, the web client's static build, and the token
 * gate in front of the `/ws` upgrade.
 *
 * ARCHITECTURE.md: "the web client is served BY the daemon, so UI and daemon logic always
 * update atomically together and remote browsers are version-matched by construction".
 * That makes this module deliberately boring — a hono app on `node:http`:
 *
 *   GET /healthz   → `{ok:true, version, build, protocol, pid, uptime_ms}`
 *   GET /*         → the client build from `distDir`, with an index.html fallback so
 *                    client-side routes deep-link; when `distDir` is missing or has no
 *                    index.html the daemon still answers, with a plain "client not built"
 *                    page (a dev daemon running against `vite dev` is a normal state).
 *
 * Auth: the run dir's 0600 `.token` (`lifecycle/rundir.ts`) authenticates local WS clients;
 * tailnet clients are authenticated by being on the tailnet. Only the `/ws` upgrade is
 * gated — the static bundle has to load before a client can present a token, and the HTTP
 * listener is loopback + explicitly configured binds only.
 */

import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

import { Hono } from 'hono';

import { PANE_ASSETS_PREFIX } from '../content/index.js';
import { ensureToken, readToken, resolveRunPaths } from '../lifecycle/rundir.js';

/** The single WS endpoint; everything else on the listener is plain HTTP. */
export const WS_PATH = '/ws';

/** Env override for the client build directory (dev convenience). */
export const CLIENT_DIR_ENV = 'NEXD_CLIENT_DIR';

export interface DaemonVersionInfo {
    readonly version: string;
    readonly build: string;
    readonly protocol: number;
}

export interface HttpAppOptions {
    readonly version: DaemonVersionInfo;
    /** Directory holding the built client (index.html + assets). */
    readonly distDir?: string | undefined;
    /** Epoch ms the daemon started; defaults to now. */
    readonly startedAt?: number | undefined;
    /** Non-fatal problems (unreadable asset, …). */
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /** Extra routes registered BEFORE the static catch-all (M5 content-pane assets). */
    readonly routes?: ((app: Hono) => void) | undefined;
}

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.htm', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.map', 'application/json; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.avif', 'image/avif'],
    ['.ico', 'image/x-icon'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2'],
    ['.ttf', 'font/ttf'],
    ['.wasm', 'application/wasm']
]);

export function contentTypeFor(filePath: string): string {
    return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

/** `NEXD_CLIENT_DIR`, expanded and absolute; undefined when unset. */
export function resolveClientDistDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const raw = env[CLIENT_DIR_ENV]?.trim();
    if (raw === undefined || raw.length === 0) return undefined;
    return path.resolve(raw);
}

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>nexd — client not built</title></head>
<body style="font-family: ui-sans-serif, system-ui, sans-serif; margin: 3rem auto; max-width: 40rem; line-height: 1.5">
<h1>nexd is running</h1>
<p>The web client build was not found, so there is nothing to serve here yet.</p>
<p>The daemon itself is healthy: the control socket, the WebSocket endpoint and
<code>/healthz</code> all work. Build the client (or point the daemon at an existing build
with <code>NEXD_CLIENT_DIR</code>) and reload.</p>
</body></html>
`;

function notBuiltResponse(): Response {
    return new Response(NOT_BUILT_PAGE, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-nex-client': 'not-built'
        }
    });
}

interface ResolvedFile {
    readonly path: string;
    readonly size: number;
    readonly mtimeMs: number;
}

function statFile(candidate: string): ResolvedFile | undefined {
    try {
        const stats = fs.statSync(candidate);
        if (!stats.isFile()) return undefined;
        return { path: candidate, size: stats.size, mtimeMs: stats.mtimeMs };
    } catch {
        return undefined;
    }
}

/**
 * Map a request path onto a file inside `distDir`, refusing anything that escapes it
 * (`..`, absolute paths, NUL bytes, encoded separators).
 */
export function resolveStaticPath(distDir: string, requestPath: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(requestPath);
    } catch {
        return undefined;
    }
    if (decoded.includes('\0')) return undefined;
    const root = path.resolve(distDir);
    const resolved = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
    return resolved;
}

function fileResponse(file: ResolvedFile, options: { immutable: boolean }): Response {
    const body = fs.readFileSync(file.path);
    return new Response(body, {
        status: 200,
        headers: {
            'content-type': contentTypeFor(file.path),
            'content-length': String(file.size),
            'cache-control': options.immutable
                ? 'public, max-age=31536000, immutable'
                : 'no-cache',
            etag: `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`
        }
    });
}

/** Hashed bundle output lives under /assets/ — safe to cache forever. */
function isImmutableAsset(requestPath: string): boolean {
    return requestPath.startsWith('/assets/');
}

// ── content-pane assets (M5) ────────────────────────────────────────────────────────

export interface PaneAssetRequest {
    readonly paneID: string;
    /** Path relative to the pane's open file, still un-normalized. */
    readonly relativePath: string;
}

/**
 * `/pane-assets/<paneID>/<relpath>` → its two parts, or null when the shape is wrong.
 * Percent-decoding happens here (hono keeps the pathname encoded), so an encoded separator
 * cannot smuggle a second path segment past the parse.
 */
export function parsePaneAssetPath(pathname: string): PaneAssetRequest | null {
    const prefix = `${PANE_ASSETS_PREFIX}/`;
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return null;
    let paneID: string;
    let relativePath: string;
    try {
        paneID = decodeURIComponent(rest.slice(0, slash));
        relativePath = decodeURIComponent(rest.slice(slash + 1));
    } catch {
        return null;
    }
    if (paneID === '' || relativePath === '') return null;
    if (paneID.includes('\0') || relativePath.includes('\0')) return null;
    if (paneID.includes('/') || paneID.includes('\\')) return null;
    return { paneID, relativePath };
}

/**
 * The sibling-asset route (content-panes.md port note 4): a markdown preview is loaded with
 * `<base href="/pane-assets/<paneID>/">`, so `![](diagram.png)` next to the file resolves.
 *
 * The route itself only parses and serves; `resolve` (the `ContentService`) decides what the
 * pane may expose and rejects anything that escapes the file's directory — this route can
 * therefore never reach a file the service did not hand back.
 */
export function createPaneAssetsRoute(
    resolve: (paneID: string, relativePath: string) => string | null
): (app: Hono) => void {
    return (app) => {
        app.on(['GET', 'HEAD'], `${PANE_ASSETS_PREFIX}/*`, (c) => {
            const request = parsePaneAssetPath(new URL(c.req.url).pathname);
            if (request === null) return c.text('not found\n', 404);
            const resolved = resolve(request.paneID, request.relativePath);
            if (resolved === null) return c.text('not found\n', 404);
            const file = statFile(resolved);
            if (file === undefined) return c.text('not found\n', 404);
            return fileResponse(file, { immutable: false });
        });
    };
}

export function createHttpApp(options: HttpAppOptions): Hono {
    const app = new Hono();
    const startedAt = options.startedAt ?? Date.now();
    const distDir = options.distDir !== undefined ? path.resolve(options.distDir) : undefined;

    app.get('/healthz', (c) =>
        c.json({
            ok: true,
            version: options.version.version,
            build: options.version.build,
            protocol: options.version.protocol,
            pid: process.pid,
            uptime_ms: Math.max(0, Date.now() - startedAt)
        })
    );

    options.routes?.(app);

    // The WS endpoint never reaches hono (the upgrade is handled on the raw server); a
    // plain GET of it is a client that forgot to upgrade.
    app.get(WS_PATH, (c) => c.text('expected a websocket upgrade\n', 426));

    app.on(['GET', 'HEAD'], '*', (c) => {
        if (distDir === undefined) return notBuiltResponse();

        const requestPath = new URL(c.req.url).pathname;
        const resolved = resolveStaticPath(distDir, requestPath);
        if (resolved === undefined) return c.text('not found\n', 404);

        try {
            const direct = statFile(resolved) ?? statFile(path.join(resolved, 'index.html'));
            if (direct !== undefined) {
                const immutable = isImmutableAsset(requestPath) && !direct.path.endsWith('index.html');
                return fileResponse(direct, { immutable });
            }

            // SPA deep link: anything that isn't a file falls back to the shell document.
            const index = statFile(path.join(distDir, 'index.html'));
            if (index === undefined) return notBuiltResponse();
            return fileResponse(index, { immutable: false });
        } catch (error) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)), 'static');
            return c.text('internal error\n', 500);
        }
    });

    return app;
}

// ── upgrade authentication ──────────────────────────────────────────────────────────

export interface UpgradeAuthOptions {
    /** The run dir's shared secret. Required unless `allowAnonymous` is set. */
    readonly token?: string | undefined;
    /** Explicit opt-out (tests, tailnet-only deployments that trust the network). */
    readonly allowAnonymous?: boolean | undefined;
    /** Path the WS endpoint lives on; default `/ws`. */
    readonly path?: string | undefined;
}

export type UpgradeDecision =
    | { readonly ok: true; readonly token: string | undefined }
    | { readonly ok: false; readonly status: number; readonly reason: string };

/** Constant-time string compare that never leaks length through an early return. */
export function tokensMatch(expected: string, presented: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(presented, 'utf8');
    if (a.length !== b.length) {
        // Still burn a comparison so the timing profile does not depend on the length.
        timingSafeEqual(a, a);
        return false;
    }
    return timingSafeEqual(a, b);
}

/** `?token=…` or `Authorization: Bearer …` (the two forms browsers can actually send). */
export function extractRequestToken(request: IncomingMessage): string | undefined {
    const header = request.headers.authorization;
    if (typeof header === 'string') {
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        const bearer = match?.[1]?.trim();
        if (bearer !== undefined && bearer.length > 0) return bearer;
    }
    const target = request.url ?? '/';
    const query = new URL(target, 'http://localhost').searchParams.get('token');
    if (query !== null && query.length > 0) return query;
    return undefined;
}

export function requestPathname(request: IncomingMessage): string {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
}

/** The whole upgrade policy, transport-free so it is unit-testable without a socket. */
export function authorizeUpgrade(request: IncomingMessage, options: UpgradeAuthOptions): UpgradeDecision {
    const wsPath = options.path ?? WS_PATH;
    const pathname = requestPathname(request);
    if (pathname !== wsPath && pathname !== `${wsPath}/`) {
        return { ok: false, status: 404, reason: 'unknown upgrade path' };
    }

    const presented = extractRequestToken(request);
    if (options.token === undefined || options.token.length === 0) {
        if (options.allowAnonymous === true) return { ok: true, token: presented };
        return { ok: false, status: 401, reason: 'daemon has no token configured' };
    }
    if (presented === undefined) return { ok: false, status: 401, reason: 'missing token' };
    if (!tokensMatch(options.token, presented)) return { ok: false, status: 403, reason: 'invalid token' };
    return { ok: true, token: presented };
}

export interface RunDirTokenOptions {
    /** Run directory override (otherwise the platform default / `NEXD_RUN_DIR`). */
    readonly dir?: string | undefined;
    readonly protocol?: number | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    /** Mint + persist a token when the run dir has none (the daemon's own start path). */
    readonly create?: boolean | undefined;
}

/**
 * The WS token as clients find it: the run dir's 0600 `daemon-v<PROTO>.token`
 * (`lifecycle/rundir.ts`). Boot passes `create: true`; a probe passes nothing and gets
 * `undefined` when no daemon of this protocol has ever run.
 */
export function runDirToken(options: RunDirTokenOptions = {}): string | undefined {
    const paths = resolveRunPaths({
        ...(options.dir !== undefined ? { dir: options.dir } : {}),
        ...(options.protocol !== undefined ? { protocol: options.protocol } : {}),
        ...(options.env !== undefined ? { env: options.env } : {})
    });
    return options.create === true ? ensureToken(paths) : readToken(paths);
}

const STATUS_TEXT: ReadonlyMap<number, string> = new Map([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'Not Found']
]);

/** Refuse an upgrade on the raw socket (there is no `Response` to return at this point). */
export function writeUpgradeRejection(socket: NodeJS.WritableStream & { destroy(): void }, decision: { status: number; reason: string }): void {
    const text = STATUS_TEXT.get(decision.status) ?? 'Bad Request';
    const body = `${decision.reason}\n`;
    try {
        socket.write(
            `HTTP/1.1 ${decision.status} ${text}\r\n` +
                'connection: close\r\n' +
                'content-type: text/plain; charset=utf-8\r\n' +
                `content-length: ${Buffer.byteLength(body)}\r\n` +
                '\r\n' +
                body
        );
    } catch {
        // The peer already went away; destroying is all that is left.
    }
    socket.destroy();
}
