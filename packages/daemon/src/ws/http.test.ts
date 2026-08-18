import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    authorizeUpgrade,
    contentTypeFor,
    createHttpApp,
    extractRequestToken,
    resolveClientDistDir,
    resolveStaticPath,
    runDirToken,
    tokensMatch
} from './http.js';

const VERSION = { version: '0.1.0', build: '42', protocol: 1 };

const temporaries: string[] = [];

function distDir(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-ws-http-'));
    temporaries.push(dir);
    for (const [name, contents] of Object.entries(files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return dir;
}

/** Enough of an `IncomingMessage` for the upgrade policy. */
function upgradeRequest(url: string, headers: Record<string, string> = {}): IncomingMessage {
    return { url, headers } as unknown as IncomingMessage;
}

afterEach(() => {
    while (temporaries.length > 0) {
        const dir = temporaries.pop() as string;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('GET /healthz', () => {
    it('answers with version, build, protocol and pid', async () => {
        const app = createHttpApp({ version: VERSION });
        const response = await app.request('/healthz');
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body['ok']).toBe(true);
        expect(body['version']).toBe('0.1.0');
        expect(body['build']).toBe('42');
        expect(body['protocol']).toBe(1);
        expect(body['pid']).toBe(process.pid);
        expect(typeof body['uptime_ms']).toBe('number');
    });

    it('works with no client build present', async () => {
        const app = createHttpApp({ version: VERSION });
        expect((await app.request('/healthz')).status).toBe(200);
    });
});

describe('static client serving', () => {
    it('serves index.html at the root', async () => {
        const dir = distDir({ 'index.html': '<!doctype html><title>nex</title>' });
        const app = createHttpApp({ version: VERSION, distDir: dir });
        const response = await app.request('/');
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
        expect(await response.text()).toContain('<title>nex</title>');
    });

    it('serves hashed assets immutably and the shell document no-cache', async () => {
        const dir = distDir({
            'index.html': '<!doctype html>',
            'assets/app-abc123.js': 'console.log(1)'
        });
        const app = createHttpApp({ version: VERSION, distDir: dir });

        const asset = await app.request('/assets/app-abc123.js');
        expect(asset.status).toBe(200);
        expect(asset.headers.get('content-type')).toContain('text/javascript');
        expect(asset.headers.get('cache-control')).toContain('immutable');

        const shell = await app.request('/');
        expect(shell.headers.get('cache-control')).toBe('no-cache');
    });

    it('falls back to index.html for client-side routes', async () => {
        const dir = distDir({ 'index.html': 'SHELL' });
        const app = createHttpApp({ version: VERSION, distDir: dir });
        const response = await app.request('/workspace/abc/pane/def');
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('SHELL');
    });

    it('serves the "client not built" page when the dist dir is absent', async () => {
        const app = createHttpApp({ version: VERSION, distDir: path.join(os.tmpdir(), 'nexd-missing-client-dir') });
        const response = await app.request('/');
        expect(response.status).toBe(200);
        expect(response.headers.get('x-nex-client')).toBe('not-built');
        expect(await response.text()).toContain('client');
    });

    it('serves the "client not built" page when no dist dir is configured', async () => {
        const app = createHttpApp({ version: VERSION });
        const response = await app.request('/anything');
        expect(response.headers.get('x-nex-client')).toBe('not-built');
    });

    it('refuses to escape the dist dir', async () => {
        const dir = distDir({ 'index.html': 'SHELL' });
        fs.writeFileSync(path.join(dir, '..', 'nexd-secret.txt'), 'secret');
        const app = createHttpApp({ version: VERSION, distDir: dir });
        const response = await app.request('/..%2Fnexd-secret.txt');
        expect(response.status).toBe(404);
        fs.rmSync(path.join(dir, '..', 'nexd-secret.txt'), { force: true });
    });

    it('rejects traversal at the path resolver', () => {
        const dir = distDir({ 'index.html': 'SHELL' });
        expect(resolveStaticPath(dir, '/../etc/passwd')).toBeUndefined();
        expect(resolveStaticPath(dir, '/index.html')).toBe(path.join(dir, 'index.html'));
        expect(resolveStaticPath(dir, '/%00')).toBeUndefined();
    });

    it('answers a plain GET of the websocket path with 426', async () => {
        const app = createHttpApp({ version: VERSION });
        expect((await app.request('/ws')).status).toBe(426);
    });
});

describe('content types', () => {
    it('maps the client build extensions', () => {
        expect(contentTypeFor('/x/app.js')).toContain('text/javascript');
        expect(contentTypeFor('/x/app.css')).toContain('text/css');
        expect(contentTypeFor('/x/font.woff2')).toBe('font/woff2');
        expect(contentTypeFor('/x/thing.bin')).toBe('application/octet-stream');
    });
});

describe('upgrade authentication', () => {
    it('accepts the token as a query parameter', () => {
        const decision = authorizeUpgrade(upgradeRequest('/ws?token=s3cret'), { token: 's3cret' });
        expect(decision).toMatchObject({ ok: true, authenticated: true, token: 's3cret' });
    });

    it('accepts the token as a bearer header', () => {
        const decision = authorizeUpgrade(upgradeRequest('/ws', { authorization: 'Bearer s3cret' }), {
            token: 's3cret'
        });
        expect(decision).toMatchObject({ ok: true, authenticated: true });
    });

    it('upgrades a missing or wrong token as UNAUTHENTICATED instead of refusing it', () => {
        // The whole point: a browser cannot see a 401/403 on an upgrade — it sees close 1006
        // and retries forever. The socket opens so the handshake can say what is wrong.
        expect(authorizeUpgrade(upgradeRequest('/ws'), { token: 's3cret' })).toMatchObject({
            ok: true,
            authenticated: false,
            token: undefined
        });
        expect(authorizeUpgrade(upgradeRequest('/ws?token=nope'), { token: 's3cret' })).toMatchObject({
            ok: true,
            authenticated: false,
            token: 'nope'
        });
        expect(
            authorizeUpgrade(upgradeRequest('/ws', { authorization: 'Bearer nope' }), { token: 's3cret' })
        ).toMatchObject({ ok: true, authenticated: false });
    });

    it('rejects unknown upgrade paths before looking at the token', () => {
        expect(authorizeUpgrade(upgradeRequest('/socket?token=s3cret'), { token: 's3cret' })).toMatchObject({
            ok: false,
            status: 404
        });
        // Still 404 for an unknown path with no token at all — the relaxation is about
        // authentication, not about answering on paths nothing serves.
        expect(authorizeUpgrade(upgradeRequest('/socket'), { token: 's3cret' })).toMatchObject({
            ok: false,
            status: 404
        });
    });

    it('refuses every upgrade when no token is configured unless anonymous access is explicit', () => {
        // Nothing a hello could present would help: there is no secret to check against, so
        // upgrading would mean accepting everyone.
        expect(authorizeUpgrade(upgradeRequest('/ws'), {})).toMatchObject({ ok: false, status: 401 });
        expect(authorizeUpgrade(upgradeRequest('/ws?token=anything'), {})).toMatchObject({
            ok: false,
            status: 401
        });
        expect(authorizeUpgrade(upgradeRequest('/ws'), { allowAnonymous: true })).toMatchObject({
            ok: true,
            authenticated: true
        });
    });

    it('extracts tokens and compares them in constant time', () => {
        expect(extractRequestToken(upgradeRequest('/ws?token=abc'))).toBe('abc');
        expect(extractRequestToken(upgradeRequest('/ws', { authorization: 'bearer abc' }))).toBe('abc');
        expect(extractRequestToken(upgradeRequest('/ws'))).toBeUndefined();
        expect(tokensMatch('abc', 'abc')).toBe(true);
        expect(tokensMatch('abc', 'abd')).toBe(false);
        expect(tokensMatch('abc', 'abcd')).toBe(false);
    });
});

describe('runDirToken', () => {
    it('reads the run dir token, and mints one on request', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexd-ws-run-'));
        temporaries.push(dir);

        expect(runDirToken({ dir })).toBeUndefined();
        const minted = runDirToken({ dir, create: true });
        expect(minted).toBeDefined();
        expect(runDirToken({ dir })).toBe(minted);
        // Stable across calls: a restarted daemon must not invalidate open clients.
        expect(runDirToken({ dir, create: true })).toBe(minted);
    });
});

describe('resolveClientDistDir', () => {
    it('reads NEXD_CLIENT_DIR and absolutizes it', () => {
        expect(resolveClientDistDir({})).toBeUndefined();
        expect(resolveClientDistDir({ NEXD_CLIENT_DIR: '  ' })).toBeUndefined();
        expect(resolveClientDistDir({ NEXD_CLIENT_DIR: '/tmp/client' })).toBe(path.resolve('/tmp/client'));
    });
});
