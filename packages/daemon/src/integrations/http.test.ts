/**
 * `http.ts` against a fake `fetch`: the headers every request carries, the timeout, a caller's
 * cancel, a network failure, and the mapping of every GitHub failure (docs/integrations.md §2.2,
 * §9.2), GraphQL's 200-with-errors and the SSO headers included. No network.
 */

import { describe, expect, it } from 'vitest';

import { TicketServiceError } from '../handlers/app/context.js';
import { createGitHubHttp, graphQLFailure, httpFailure, ssoHiddenOrganizations, ssoRequiredURL, type CredentialContext } from './http.js';
import { fakeGitHub, json } from './testing.js';

const ENDPOINTS = { api: 'https://api.github.com', web: 'https://github.com' };
const OAUTH: CredentialContext = { how: 'oauth', clientID: 'Ov23abc' };
const TOKEN_LINK: CredentialContext = { how: 'token', clientID: 'Ov23abc' };
const NOW = 1_800_000_000_000;

function client(gh = fakeGitHub(), extra: { timeoutSignal?: (ms: number) => AbortSignal; log?: (line: string) => void } = {}) {
    return createGitHubHttp({ endpoints: ENDPOINTS, userAgent: 'Kelpi/9.9.9', fetch: gh.fetch, now: () => NOW, ...extra });
}

async function failureOf(promise: Promise<unknown>): Promise<TicketServiceError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(TicketServiceError);
        return error as TicketServiceError;
    }
    throw new Error('expected a failure');
}

describe('requests', () => {
    it('sends the API headers and the credential to the API only', async () => {
        const gh = fakeGitHub();
        gh.on('GET', '/user', () => json({ login: 'octocat' }));
        await client(gh).restGet('/user', 'gho_TOKEN', OAUTH);
        const request = gh.requests[0]!;
        expect(request.url).toBe('https://api.github.com/user');
        expect(request.headers).toMatchObject({
            'user-agent': 'Kelpi/9.9.9',
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            authorization: 'Bearer gho_TOKEN'
        });
    });

    it('sends the device flow form-encoded with Accept: application/json and no credential', async () => {
        const gh = fakeGitHub();
        gh.on('POST', '/login/device/code', () => json({ device_code: 'd' }));
        await client(gh).loginPost('/login/device/code', { client_id: 'Ov23abc', scope: 'repo' });
        const request = gh.requests[0]!;
        expect(request.url).toBe('https://github.com/login/device/code');
        expect(request.headers['accept']).toBe('application/json');
        expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
        expect(request.headers['authorization']).toBeUndefined();
        expect(request.body).toBe('client_id=Ov23abc&scope=repo');
    });

    it('passes GraphQL variables as variables', async () => {
        const gh = fakeGitHub();
        gh.graphql(() => json({ data: { a: 1 } }));
        const result = await client(gh).graphql('query Q($q: String!) { a }', { q: 'x" } evil {' }, 't', OAUTH);
        expect(result.data).toEqual({ a: 1 });
        expect(gh.graphqlCalls[0]!.query).toBe('query Q($q: String!) { a }');
        expect(gh.graphqlCalls[0]!.variables).toEqual({ q: 'x" } evil {' });
    });

    it('times out with `timeout`, never with the caller', async () => {
        const gh = fakeGitHub();
        const timer = new AbortController();
        gh.on('GET', '/user', () => new Promise<Response>(() => {}));
        const lines: string[] = [];
        const pending = client(gh, { timeoutSignal: () => timer.signal, log: (line) => lines.push(line) }).restGet('/user', 'tok', OAUTH);
        timer.abort(new DOMException('timed out', 'TimeoutError'));
        const failure = await failureOf(pending);
        expect(failure.code).toBe('timeout');
        expect(lines.join('\n')).not.toContain('tok');
    });

    it("rejects with the caller's own reason when the caller cancels", async () => {
        const gh = fakeGitHub();
        gh.on('GET', '/user', () => new Promise<Response>(() => {}));
        const controller = new AbortController();
        const pending = client(gh).restGet('/user', 'tok', OAUTH, controller.signal);
        const reason = new Error('create cancelled');
        controller.abort(reason);
        await expect(pending).rejects.toBe(reason);
    });

    it('maps a network failure to `unreachable`, naming only the error code', async () => {
        const failing = createGitHubHttp({
            endpoints: ENDPOINTS,
            userAgent: 'Kelpi/1',
            fetch: () => Promise.reject(Object.assign(new TypeError('fetch failed https://api.github.com/?token=x'), { cause: { code: 'ENOTFOUND' } }))
        });
        const failure = await failureOf(failing.restGet('/user', 'secret', OAUTH));
        expect(failure.code).toBe('unreachable');
        expect(failure.message).toBe('Could not reach GitHub (ENOTFOUND): check the network');
    });

    it('logs a failure by method, path, status and request id only', async () => {
        const gh = fakeGitHub();
        gh.on('GET', '/user', () => json({ message: 'Bad credentials' }, { status: 401, headers: { 'x-github-request-id': 'AB12:CD34', 'x-secret': 'hdr' } }));
        const lines: string[] = [];
        await failureOf(client(gh, { log: (line) => lines.push(line) }).restGet('/user', 'gho_SECRET', OAUTH));
        expect(lines).toEqual(['integrations: github GET /user -> 401 (request AB12:CD34)']);
    });

    it('answers a non-JSON body with `github-error`', async () => {
        const gh = fakeGitHub();
        gh.on('GET', '/user', () => new Response('<html>', { status: 200 }));
        expect((await failureOf(client(gh).restGet('/user', 't', OAUTH))).code).toBe('github-error');
    });
});

describe('status mapping', () => {
    const headers = (entries: Record<string, string> = {}): Headers => new Headers(entries);

    it.each([
        ['401', 401, {}, {}, 'unauthorized'],
        ['403 rate limit by remaining', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 42) }, {}, 'rate-limited'],
        ['403 secondary limit by retry-after', 403, { 'retry-after': '60' }, { message: 'You have exceeded a secondary rate limit' }, 'rate-limited'],
        ['429', 429, {}, {}, 'rate-limited'],
        ['403 OAuth App restriction', 403, {}, { message: 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions' }, 'org-restricted'],
        ['403 other', 403, {}, { message: 'Resource not accessible' }, 'github-error'],
        ['404', 404, {}, { message: 'Not Found' }, 'not-found'],
        ['422', 422, {}, { message: 'Validation Failed' }, 'github-error'],
        ['502', 502, {}, {}, 'github-error']
    ])('%s', (_label, status, headerEntries, body, code) => {
        expect(httpFailure(status, headers(headerEntries), body, OAUTH, NOW).code).toBe(code);
    });

    it('carries retry_after_s from either header', () => {
        expect(httpFailure(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 42) }), {}, OAUTH, NOW).retryAfterS).toBe(42);
        expect(httpFailure(429, headers({ 'retry-after': '7' }), {}, OAUTH, NOW).retryAfterS).toBe(7);
    });

    it('turns X-GitHub-SSO: required into sso-required with GitHub\'s URL, and drops any other URL', () => {
        const ok = httpFailure(403, headers({ 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=abc' }), {}, OAUTH, NOW);
        expect(ok.code).toBe('sso-required');
        expect(ok.ssoURL).toBe('https://github.com/orgs/acme/sso?authorization_request=abc');
        const evil = httpFailure(403, headers({ 'x-github-sso': 'required; url=https://evil.example/sso' }), {}, OAUTH, NOW);
        expect(evil.code).toBe('sso-required');
        expect(evil.ssoURL).toBeUndefined();
    });

    it("links an OAuth link's org restriction to the app's settings page, but not a token's", () => {
        const message = { message: 'the `acme` organization has enabled OAuth App access restrictions' };
        expect(httpFailure(403, headers(), message, OAUTH, NOW).settingsURL).toBe('https://github.com/settings/connections/applications/Ov23abc');
        expect(httpFailure(403, headers(), message, TOKEN_LINK, NOW).settingsURL).toBeUndefined();
    });

    it('never echoes a header into an error message', () => {
        const failure = httpFailure(403, headers({ 'x-oauth-scopes': 'repo', authorization: 'Bearer x' }), { message: 'nope' }, OAUTH, NOW);
        expect(failure.message).not.toContain('Bearer');
        expect(failure.message).not.toContain('scopes');
    });

    it('reads the SSO headers', () => {
        expect(ssoRequiredURL(null)).toBeUndefined();
        expect(ssoRequiredURL('partial-results; organizations=1,2')).toBeUndefined();
        expect(ssoRequiredURL('required; url=http://github.com/x')).toBeNull();
        expect(ssoHiddenOrganizations('partial-results; organizations=21955855,20582480')).toBe(2);
        expect(ssoHiddenOrganizations('required; url=https://github.com/x')).toBe(0);
        expect(ssoHiddenOrganizations(null)).toBe(0);
    });
});

describe('GraphQL errors', () => {
    const none = new Headers();

    it('maps each error type', () => {
        expect(graphQLFailure([], none, OAUTH, NOW)).toBeNull();
        expect(graphQLFailure([{ type: 'RATE_LIMITED', message: 'API rate limit exceeded', alias: null }], new Headers({ 'x-ratelimit-reset': String(NOW / 1000 + 5) }), OAUTH, NOW)).toMatchObject({ code: 'rate-limited', retryAfterS: 5 });
        expect(graphQLFailure([{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository', alias: 'repository' }], none, OAUTH, NOW)?.code).toBe('not-found');
        expect(
            graphQLFailure([{ type: 'FORBIDDEN', message: 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions', alias: null }], none, OAUTH, NOW)
        ).toMatchObject({ code: 'org-restricted', settingsURL: 'https://github.com/settings/connections/applications/Ov23abc' });
        expect(graphQLFailure([{ type: 'FORBIDDEN', message: 'Resource protected by organization SAML enforcement', alias: null }], none, OAUTH, NOW)?.code).toBe('sso-required');
        expect(graphQLFailure([{ type: 'FORBIDDEN', message: 'Resource not accessible by integration', alias: null }], none, OAUTH, NOW)?.code).toBe('not-found');
        expect(graphQLFailure([{ type: 'SOMETHING', message: 'x', alias: null }], none, OAUTH, NOW)?.code).toBe('github-error');
    });

    it('returns a 200 with errors and partial data instead of throwing, with the alias of each error', async () => {
        const gh = fakeGitHub();
        gh.graphql(() =>
            json(
                { data: { s0: { nodes: [] }, s1: null }, errors: [{ type: 'FORBIDDEN', message: 'nope', path: ['s1'] }] },
                { headers: { 'x-github-sso': 'partial-results; organizations=7' } }
            )
        );
        const result = await client(gh).graphql('query { s0 s1 }', {}, 't', OAUTH);
        expect(result.data).toEqual({ s0: { nodes: [] }, s1: null });
        expect(result.errors).toEqual([{ type: 'FORBIDDEN', message: 'nope', alias: 's1' }]);
        expect(result.ssoHiddenOrganizations).toBe(1);
    });

    it('throws a non-2xx GraphQL answer through the status mapping', async () => {
        const gh = fakeGitHub();
        gh.graphql(() => json({ message: 'Bad credentials' }, { status: 401 }));
        expect((await failureOf(client(gh).graphql('query { a }', {}, 't', OAUTH))).code).toBe('unauthorized');
    });
});
