/**
 * GitHub over HTTP (docs/integrations.md §9.2): the one place a request leaves the daemon, so the
 * one place the headers, the timeout and the meaning of every failure are decided.
 *
 *   - `fetch` is injected (Node's global by default; tests pass fakes that return `Response`s,
 *     and nothing here ever reaches the network in a test);
 *   - every request is bounded: `AbortSignal.any([caller, AbortSignal.timeout(10 s)])`; the
 *     caller's abort rejects with ITS reason (a cancelled create), the timeout with `timeout`,
 *     anything else the network throws with `unreachable`;
 *   - headers: `User-Agent: Kelpi/<version>`, and for the API `Accept: application/vnd.github+json`
 *     and `X-GitHub-Api-Version: 2022-11-28`; `github.com/login/*` (the device flow) gets
 *     `Accept: application/json`, without which GitHub answers form-encoded;
 *   - every failure is a `TicketServiceError` whose message is ready to show and carries no
 *     header, no token and no URL with either in it. The log line for a failure names the
 *     method, the path, the status and `x-github-request-id`, nothing else.
 *
 * Status mapping (§2.2):
 *
 *   401                                         unauthorized (the service marks the credential revoked)
 *   403/429 + `x-ratelimit-remaining: 0`,
 *     `retry-after`, or a rate-limit message    rate-limited (`retry_after_s` from either header)
 *   any + `X-GitHub-SSO: required; url=…`       sso-required (`sso_url`, only an https://github.com one)
 *   403 + "OAuth App access restrictions"       org-restricted (`settings_url` for an OAuth link)
 *   403 otherwise                               github-error
 *   404                                         not-found
 *   5xx, 422, any other, a body that is not JSON  github-error
 *
 * GraphQL answers 200 with `errors[]`, often beside partial `data` (one aliased search failing,
 * a ticket that does not exist). `graphql` returns both and `graphQLFailure` maps the errors:
 * `RATE_LIMITED` → rate-limited, `FORBIDDEN` with the OAuth App restriction message →
 * org-restricted, with a SAML message → sso-required, other `FORBIDDEN` and `NOT_FOUND` →
 * not-found, anything else → github-error. A 200 with `X-GitHub-SSO: partial-results` (SAML hid
 * some organizations' results) is not an error: `ssoPartial` carries it for a warning.
 */

import { isGitHubWebURL } from '@kelpi/protocol';
import { untrustedLine } from '@kelpi/core/tickets';

import { TicketServiceError } from '../handlers/app/context.js';
import type { GitHubEndpoints } from './config.js';

export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const GITHUB_API_VERSION = '2022-11-28';
/** A response body larger than this is not one Kelpi asked for. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GitHubHttpOptions {
    readonly endpoints: GitHubEndpoints;
    /** `Kelpi/<version>`. */
    readonly userAgent: string;
    readonly fetch?: FetchLike | undefined;
    readonly timeoutMs?: number | undefined;
    /** `AbortSignal.timeout` by default; tests pass a signal they abort themselves. */
    readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
    /** Epoch ms, for `x-ratelimit-reset`. */
    readonly now?: (() => number) | undefined;
    readonly log?: ((line: string) => void) | undefined;
}

/** What `graphQLFailure` and the status mapping need to know about the credential in use. */
export interface CredentialContext {
    /** How the credential was linked: only an OAuth link gets an org-restriction settings link. */
    readonly how: 'oauth' | 'token';
    /** The OAuth App's client ID ('' when there is none). */
    readonly clientID: string;
}

export interface GraphQLErrorInfo {
    readonly type: string | null;
    readonly message: string;
    /** The first `path` element (the alias), when GitHub gave one. */
    readonly alias: string | null;
}

export interface GraphQLResult {
    readonly data: Readonly<Record<string, unknown>> | null;
    readonly errors: readonly GraphQLErrorInfo[];
    /** `X-GitHub-SSO: partial-results; organizations=…`: how many organizations were hidden (0 when none). */
    readonly ssoHiddenOrganizations: number;
    readonly headers: Headers;
}

export interface RestResult {
    readonly body: unknown;
    readonly headers: Headers;
}

export interface GitHubHttp {
    readonly endpoints: GitHubEndpoints;
    /** `GET <api><path>` with the credential. */
    restGet(path: string, token: string, credential: CredentialContext, signal?: AbortSignal): Promise<RestResult>;
    /** `POST <api>/graphql`; a 200 resolves even with `errors` (see the module note). */
    graphql(query: string, variables: Readonly<Record<string, unknown>>, token: string, credential: CredentialContext, signal?: AbortSignal): Promise<GraphQLResult>;
    /**
     * `POST <web><path>` form-encoded, for the device flow. Resolves the JSON object GitHub
     * answered with whatever its status (the flow's errors arrive as `{error}`); rejects only for
     * transport failures, a timeout, a 5xx or a body that is not a JSON object.
     */
    loginPost(path: string, form: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** GitHub's `message`, as one cleaned line (it may quote what a user typed). */
function githubMessage(body: unknown): string {
    if (!isRecord(body) || typeof body['message'] !== 'string') return '';
    return untrustedLine(body['message'], 300);
}

/** `x-github-request-id`, if it looks like one (it is the only response header ever logged). */
function requestID(headers: Headers): string {
    const id = headers.get('x-github-request-id') ?? '';
    return /^[A-Za-z0-9:._-]{1,80}$/.test(id) ? id : '-';
}

/** `X-GitHub-SSO: required; url=<https://github.com/…>` → the URL, if it is GitHub's own page. */
export function ssoRequiredURL(header: string | null): string | null | undefined {
    if (header === null) return undefined;
    const trimmed = header.trim();
    if (!/^required\b/i.test(trimmed)) return undefined;
    const match = /url=(\S+)/i.exec(trimmed);
    const url = match?.[1]?.replace(/[;,]$/, '');
    return url !== undefined && isGitHubWebURL(url) ? url : null;
}

/** `X-GitHub-SSO: partial-results; organizations=1,2,3` → 3. */
export function ssoHiddenOrganizations(header: string | null): number {
    if (header === null || !/^partial-results\b/i.test(header.trim())) return 0;
    const match = /organizations=([0-9,\s]+)/i.exec(header);
    if (match === null) return 1;
    return (match[1] as string).split(',').filter((id) => id.trim() !== '').length || 1;
}

const ORG_RESTRICTED_PATTERN = /OAuth App access restrictions|organization has enabled OAuth App/i;
const SAML_PATTERN = /\bSAML\b|single sign-on/i;
const RATE_LIMIT_PATTERN = /rate limit/i;

function orgRestricted(credential: CredentialContext, detail: string): TicketServiceError {
    const settingsURL =
        credential.how === 'oauth' && credential.clientID !== ''
            ? `https://github.com/settings/connections/applications/${encodeURIComponent(credential.clientID)}`
            : undefined;
    return new TicketServiceError(
        'org-restricted',
        `The organization restricts OAuth App access and has not approved Kelpi${detail === '' ? '' : ` (${detail})`}: request approval on GitHub, or link a personal access token instead`,
        settingsURL === undefined ? {} : { settingsURL }
    );
}

function retryAfterSeconds(headers: Headers, now: number): number | undefined {
    const retryAfter = headers.get('retry-after');
    if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim())) return Number(retryAfter.trim());
    const reset = headers.get('x-ratelimit-reset');
    if (reset !== null && /^\d{1,12}$/.test(reset.trim())) return Math.max(0, Math.ceil(Number(reset.trim()) - now / 1000));
    return undefined;
}

function rateLimited(headers: Headers, now: number): TicketServiceError {
    const retryAfterS = retryAfterSeconds(headers, now);
    return new TicketServiceError(
        'rate-limited',
        `GitHub's rate limit was reached${retryAfterS === undefined ? '' : `; try again in ${retryAfterS} s`}`,
        retryAfterS === undefined ? {} : { retryAfterS }
    );
}

/** A non-2xx API response as the error to reply with (module note). */
export function httpFailure(status: number, headers: Headers, body: unknown, credential: CredentialContext, now: number): TicketServiceError {
    const message = githubMessage(body);
    if (status === 401) {
        return new TicketServiceError('unauthorized', 'GitHub refused the credential (401): link GitHub again in Settings ▸ Integrations');
    }
    const sso = ssoRequiredURL(headers.get('x-github-sso'));
    if (sso !== undefined) {
        return new TicketServiceError(
            'sso-required',
            'The organization uses SAML single sign-on and this credential is not authorized for it: authorize it on GitHub, then try again',
            sso === null ? {} : { ssoURL: sso }
        );
    }
    if (status === 403 || status === 429) {
        if (status === 429 || headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null || RATE_LIMIT_PATTERN.test(message)) {
            return rateLimited(headers, now);
        }
        if (ORG_RESTRICTED_PATTERN.test(message)) return orgRestricted(credential, '');
        if (SAML_PATTERN.test(message)) {
            return new TicketServiceError('sso-required', 'The organization uses SAML single sign-on and this credential is not authorized for it');
        }
        return new TicketServiceError('github-error', `GitHub refused the request (403)${message === '' ? '' : `: ${message}`}`);
    }
    if (status === 404) return new TicketServiceError('not-found', 'GitHub has no such thing, or this credential cannot see it');
    if (status >= 500) return new TicketServiceError('github-error', `GitHub had a problem (${status}); try again in a moment`);
    return new TicketServiceError('github-error', `GitHub answered ${status}${message === '' ? '' : `: ${message}`}`);
}

/** The errors of a GraphQL answer as the one error to reply with (module note). Null for no errors. */
export function graphQLFailure(errors: readonly GraphQLErrorInfo[], headers: Headers, credential: CredentialContext, now: number): TicketServiceError | null {
    if (errors.length === 0) return null;
    const rate = errors.find((error) => error.type === 'RATE_LIMITED');
    if (rate !== undefined) return rateLimited(headers, now);
    const restricted = errors.find((error) => ORG_RESTRICTED_PATTERN.test(error.message));
    if (restricted !== undefined) return orgRestricted(credential, '');
    const saml = errors.find((error) => error.type === 'FORBIDDEN' && SAML_PATTERN.test(error.message));
    if (saml !== undefined) {
        const sso = ssoRequiredURL(headers.get('x-github-sso'));
        return new TicketServiceError(
            'sso-required',
            'The organization uses SAML single sign-on and this credential is not authorized for it: authorize it on GitHub, then try again',
            typeof sso === 'string' ? { ssoURL: sso } : {}
        );
    }
    const notFound = errors.find((error) => error.type === 'NOT_FOUND');
    if (notFound !== undefined) return new TicketServiceError('not-found', notFound.message || 'GitHub has no such thing, or this credential cannot see it');
    const forbidden = errors.find((error) => error.type === 'FORBIDDEN');
    if (forbidden !== undefined) {
        return new TicketServiceError('not-found', `GitHub did not let this credential read it${forbidden.message === '' ? '' : ` (${forbidden.message})`}`);
    }
    const first = errors[0] as GraphQLErrorInfo;
    return new TicketServiceError('github-error', `GitHub answered with an error${first.message === '' ? '' : `: ${first.message}`}`);
}

function parseGraphQLErrors(raw: unknown): GraphQLErrorInfo[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter(isRecord).map((error) => {
        const path = Array.isArray(error['path']) ? error['path'] : [];
        return {
            type: typeof error['type'] === 'string' ? error['type'] : null,
            message: typeof error['message'] === 'string' ? untrustedLine(error['message'], 300) : '',
            alias: typeof path[0] === 'string' ? path[0] : null
        };
    });
}

export function createGitHubHttp(options: GitHubHttpOptions): GitHubHttp {
    const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
    const timeoutMs = options.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS;
    const timeoutSignal = options.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? ((): void => {});

    interface Sent {
        readonly status: number;
        readonly headers: Headers;
        readonly body: unknown;
    }

    /** One request, bounded, with the body read and parsed as JSON. */
    const send = async (method: string, base: string, path: string, init: { headers: Record<string, string>; body?: string }, caller: AbortSignal | undefined): Promise<Sent> => {
        if (caller?.aborted) throw caller.reason;
        const timeout = timeoutSignal(timeoutMs);
        const signal = caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
        const what = `${method} ${path}`;
        let response: Response;
        let text: string;
        try {
            response = await fetchImpl(`${base}${path}`, {
                method,
                headers: { 'User-Agent': options.userAgent, ...init.headers },
                ...(init.body === undefined ? {} : { body: init.body }),
                signal,
                redirect: 'error'
            });
            text = await response.text();
        } catch (error) {
            if (caller?.aborted) throw caller.reason;
            if (timeout.aborted) {
                log(`integrations: github ${what} timed out after ${timeoutMs} ms`);
                throw new TicketServiceError('timeout', `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s`);
            }
            const code = (error as { cause?: { code?: unknown } }).cause?.code;
            const detail = typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : '';
            log(`integrations: github ${what} failed before an answer${detail}`);
            throw new TicketServiceError('unreachable', `Could not reach GitHub${detail}: check the network`);
        }
        if (text.length > MAX_BODY_BYTES) throw new TicketServiceError('github-error', 'GitHub answered with more than Kelpi asked for');
        let body: unknown = null;
        if (text.trim() !== '') {
            try {
                body = JSON.parse(text);
            } catch {
                body = undefined;
            }
        }
        if (response.status < 200 || response.status >= 300) {
            log(`integrations: github ${what} -> ${response.status} (request ${requestID(response.headers)})`);
        }
        if (body === undefined) {
            if (response.status >= 500) return { status: response.status, headers: response.headers, body: null };
            throw new TicketServiceError('github-error', `GitHub answered ${response.status} with something that is not JSON`);
        }
        return { status: response.status, headers: response.headers, body };
    };

    const apiHeaders = (token: string): Record<string, string> => ({
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        Authorization: `Bearer ${token}`
    });

    return {
        endpoints: options.endpoints,

        async restGet(path, token, credential, signal) {
            const sent = await send('GET', options.endpoints.api, path, { headers: apiHeaders(token) }, signal);
            if (sent.status < 200 || sent.status >= 300) throw httpFailure(sent.status, sent.headers, sent.body, credential, now());
            return { body: sent.body, headers: sent.headers };
        },

        async graphql(query, variables, token, credential, signal) {
            const sent = await send(
                'POST',
                options.endpoints.api,
                '/graphql',
                { headers: { ...apiHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) },
                signal
            );
            if (sent.status < 200 || sent.status >= 300) throw httpFailure(sent.status, sent.headers, sent.body, credential, now());
            if (!isRecord(sent.body)) throw new TicketServiceError('github-error', 'GitHub answered with something Kelpi cannot read');
            const errors = parseGraphQLErrors(sent.body['errors']);
            if (errors.length > 0) {
                const types = [...new Set(errors.map((error) => error.type ?? 'unknown'))].join(',');
                log(`integrations: github POST /graphql -> errors ${types} (request ${requestID(sent.headers)})`);
            }
            const data = sent.body['data'];
            return {
                data: isRecord(data) ? data : null,
                errors,
                ssoHiddenOrganizations: ssoHiddenOrganizations(sent.headers.get('x-github-sso')),
                headers: sent.headers
            };
        },

        async loginPost(path, form, signal) {
            const sent = await send(
                'POST',
                options.endpoints.web,
                path,
                {
                    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams(form).toString()
                },
                signal
            );
            if (sent.status >= 500) throw new TicketServiceError('github-error', `GitHub had a problem (${sent.status}); try again in a moment`);
            if (sent.status === 429 || (sent.status === 403 && sent.headers.get('x-ratelimit-remaining') === '0')) {
                throw rateLimited(sent.headers, now());
            }
            if (!isRecord(sent.body)) throw new TicketServiceError('github-error', `GitHub answered ${sent.status} with something Kelpi cannot read`);
            return sent.body;
        }
    };
}
