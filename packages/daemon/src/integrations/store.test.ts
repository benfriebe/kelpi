/**
 * `integrations.json` (docs/integrations.md §9.1, persistence.md §7.4): modes, atomic writes,
 * failing closed on a file it cannot read, moving that file aside on the next link, a memory-only
 * store for `:memory:`, and the config that decides where the file lives.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { endpointOverride, resolveIntegrationsConfig, resolveIntegrationsPath } from './config.js';
import { createCredentialStore, type StoredAccount } from './store.js';

const roots: string[] = [];
afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function tmpDir(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kelpi-integrations-')));
    roots.push(dir);
    return dir;
}

const ACCOUNT: StoredAccount = {
    provider: 'github',
    host: 'github.com',
    login: 'octocat',
    how: 'oauth',
    scopes: ['repo'],
    createdAt: '2026-10-07T00:00:00.000Z',
    revoked: false,
    endpoints: { api: 'https://api.github.com', web: 'https://github.com' },
    credential: { accessToken: 'gho_secret', tokenType: 'bearer', expiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }
};

const mode = (file: string): number => fs.statSync(file).mode & 0o777;

describe('credential store', () => {
    it('writes a 0600 file in a 0700 directory it creates, with no temp file left behind', () => {
        const dir = path.join(tmpDir(), 'data');
        const file = path.join(dir, 'integrations.json');
        const store = createCredentialStore({ path: file });
        store.save(ACCOUNT);
        expect(mode(dir)).toBe(0o700);
        expect(mode(file)).toBe(0o600);
        expect(fs.readdirSync(dir)).toEqual(['integrations.json']);
        const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        expect(body).toEqual({
            v: 1,
            accounts: [
                {
                    provider: 'github',
                    host: 'github.com',
                    login: 'octocat',
                    how: 'oauth',
                    scopes: ['repo'],
                    createdAt: '2026-10-07T00:00:00.000Z',
                    endpoints: { api: 'https://api.github.com', web: 'https://github.com' },
                    credential: { accessToken: 'gho_secret', tokenType: 'bearer', expiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }
                }
            ]
        });
    });

    it('keeps the endpoints an account was linked against, and reads one written before them as github.com', () => {
        const file = path.join(tmpDir(), 'integrations.json');
        const fake = { api: 'http://127.0.0.1:4010/api', web: 'http://127.0.0.1:4010' };
        createCredentialStore({ path: file }).save({ ...ACCOUNT, endpoints: fake });
        expect(createCredentialStore({ path: file }).account('github')?.endpoints).toEqual(fake);

        const { endpoints: _endpoints, revoked: _revoked, ...older } = ACCOUNT;
        fs.writeFileSync(file, JSON.stringify({ v: 1, accounts: [older] }), { mode: 0o600 });
        expect(createCredentialStore({ path: file }).account('github')?.endpoints).toEqual({ api: 'https://api.github.com', web: 'https://github.com' });
    });

    it('reads back what it wrote, a fine-grained token without scopes, and the revoked mark', () => {
        const file = path.join(tmpDir(), 'integrations.json');
        const first = createCredentialStore({ path: file });
        first.save({ ...ACCOUNT, how: 'token', scopes: null });
        first.markRevoked('github');
        const second = createCredentialStore({ path: file });
        expect(second.unreadable).toBe(false);
        expect(second.account('github')).toEqual({ ...ACCOUNT, how: 'token', scopes: null, revoked: true });
    });

    it('narrows a widened file back to 0600 when it reads it', () => {
        const file = path.join(tmpDir(), 'integrations.json');
        createCredentialStore({ path: file }).save(ACCOUNT);
        fs.chmodSync(file, 0o644);
        createCredentialStore({ path: file });
        expect(mode(file)).toBe(0o600);
    });

    it.each([
        ['not JSON', '{"v":1,'],
        ['a newer version', JSON.stringify({ v: 2, accounts: [] })],
        ['an account without a token', JSON.stringify({ v: 1, accounts: [{ ...ACCOUNT, credential: {} }] })],
        ['an unknown method', JSON.stringify({ v: 1, accounts: [{ provider: 'github', host: 'github.com', login: 'x', how: 'magic', createdAt: '', credential: { accessToken: 't' } }] })],
        ['a plain-http endpoint off loopback', JSON.stringify({ v: 1, accounts: [{ ...ACCOUNT, endpoints: { api: 'http://api.example.com', web: 'https://github.com' } }] })],
        ['an endpoint that is not a string', JSON.stringify({ v: 1, accounts: [{ ...ACCOUNT, endpoints: { api: 'https://api.github.com' } }] })]
    ])('fails closed on %s, and leaves the file alone until the next link moves it aside', (_label, text) => {
        const dir = tmpDir();
        const file = path.join(dir, 'integrations.json');
        fs.writeFileSync(file, text, { mode: 0o600 });
        let clock = 1_234;
        const store = createCredentialStore({ path: file, now: () => clock });
        expect(store.unreadable).toBe(true);
        expect(store.unreadableReason).not.toContain('gho_');
        expect(store.account('github')).toBeNull();
        // A 401 cannot mark what cannot be read, and nothing is written.
        store.markRevoked('github');
        expect(fs.readFileSync(file, 'utf8')).toBe(text);

        clock = 5_678;
        store.save(ACCOUNT);
        expect(store.unreadable).toBe(false);
        expect(store.account('github')?.login).toBe('octocat');
        const aside = path.join(dir, 'integrations.json.unreadable-5678');
        expect(fs.readFileSync(aside, 'utf8')).toBe(text);
        expect(mode(aside)).toBe(0o600);
        expect(createCredentialStore({ path: file }).account('github')?.login).toBe('octocat');
    });

    it('an unlink of an unreadable file also moves it aside, leaving no credential', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'integrations.json');
        fs.writeFileSync(file, 'garbage', { mode: 0o600 });
        const store = createCredentialStore({ path: file, now: () => 9 });
        store.remove('github');
        expect(store.unreadable).toBe(false);
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.existsSync(path.join(dir, 'integrations.json.unreadable-9'))).toBe(true);
    });

    it("keeps another provider's account verbatim across a rewrite", () => {
        const file = path.join(tmpDir(), 'integrations.json');
        const linear = { provider: 'linear', host: 'linear.app', login: 'x', credential: { accessToken: 'lin', refreshToken: 'r' } };
        fs.writeFileSync(file, JSON.stringify({ v: 1, accounts: [linear] }), { mode: 0o600 });
        const store = createCredentialStore({ path: file });
        expect(store.unreadable).toBe(false);
        store.save(ACCOUNT);
        store.remove('github');
        expect((JSON.parse(fs.readFileSync(file, 'utf8')) as { accounts: unknown[] }).accounts).toEqual([linear]);
    });

    it('keeps the credential in memory only without a path', () => {
        const store = createCredentialStore({ path: null });
        store.save(ACCOUNT);
        expect(store.account('github')?.credential.accessToken).toBe('gho_secret');
        store.remove('github');
        expect(store.account('github')).toBeNull();
    });

    it('throws a failed write and keeps the previous state', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'integrations.json');
        const store = createCredentialStore({ path: file });
        store.save(ACCOUNT);
        fs.chmodSync(dir, 0o500);
        try {
            expect(() => store.save({ ...ACCOUNT, login: 'other' })).toThrow();
            expect(store.account('github')?.login).toBe('octocat');
        } finally {
            fs.chmodSync(dir, 0o700);
        }
        expect(fs.readdirSync(dir)).toEqual(['integrations.json']);
    });
});

describe('integrations config', () => {
    it('puts the file beside the database, honours the override, and is memory-only for :memory:', () => {
        expect(resolveIntegrationsPath('/data/kelpid/kelpi-v2.db', {})).toBe('/data/kelpid/integrations.json');
        expect(resolveIntegrationsPath(':memory:', {})).toBeNull();
        expect(resolveIntegrationsPath(':memory:', { KELPID_INTEGRATIONS_PATH: '/x/i.json' })).toBe('/x/i.json');
        expect(resolveIntegrationsPath('/d/k.db', { KELPID_INTEGRATIONS_PATH: '~/i.json', HOME: '/home/me' })).toBe('/home/me/i.json');
    });

    it('takes the client ID from the build unless the environment says otherwise (empty turns it off)', () => {
        expect(resolveIntegrationsConfig(':memory:', {}, 'Ov23build').clientID).toBe('Ov23build');
        expect(resolveIntegrationsConfig(':memory:', { KELPI_GITHUB_CLIENT_ID: 'Iv1.abc' }, 'Ov23build').clientID).toBe('Iv1.abc');
        expect(resolveIntegrationsConfig(':memory:', { KELPI_GITHUB_CLIENT_ID: '' }, 'Ov23build').clientID).toBe('');
        const bad = resolveIntegrationsConfig(':memory:', { KELPI_GITHUB_CLIENT_ID: 'a b' }, '');
        expect(bad.clientID).toBe('');
        expect(bad.notes.join('\n')).toContain('malformed');
    });

    it('accepts https endpoint overrides anywhere and http only on loopback', () => {
        expect(endpointOverride('https://ghe.example/api/v3/')).toBe('https://ghe.example/api/v3');
        expect(endpointOverride('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999');
        expect(endpointOverride('http://localhost:1/')).toBe('http://localhost:1');
        expect(endpointOverride('http://evil.example')).toBeNull();
        expect(endpointOverride('https://user:pw@x.example')).toBeNull();
        expect(endpointOverride('ftp://x')).toBeNull();
        const config = resolveIntegrationsConfig(':memory:', { KELPI_GITHUB_API_URL: 'http://127.0.0.1:4000', KELPI_GITHUB_WEB_URL: 'http://evil.example' });
        expect(config.endpoints).toEqual({ api: 'http://127.0.0.1:4000', web: 'https://github.com' });
        expect(config.notes).toHaveLength(2);
    });
});
