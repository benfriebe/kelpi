/**
 * Test-only doubles for the integrations specs (like `ws/testing.ts`: a real module so every
 * colocated test builds the same fake, imported by nothing in the runtime path).
 *
 * `fakeGitHub()` is a `fetch` that answers from handlers the test registers and records every
 * request, headers and body included, so a test can assert what was sent as well as what came
 * back. Nothing here touches the network.
 */

import type { FetchLike } from './http.js';

export interface FakeRequest {
    readonly method: string;
    readonly url: string;
    /** The URL's path (no query). */
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal | null;
}

export interface GraphQLCall {
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly request: FakeRequest;
}

export type FakeHandler = (request: FakeRequest) => Response | Promise<Response>;
export type GraphQLHandler = (call: GraphQLCall) => Response | Promise<Response>;

export interface FakeGitHub {
    readonly fetch: FetchLike;
    readonly requests: FakeRequest[];
    readonly graphqlCalls: GraphQLCall[];
    /** Answer `method path` (exact) with `handler`; a later registration replaces an earlier one. */
    on(method: string, path: string, handler: FakeHandler): void;
    /** Answer `POST /graphql` by operation; `handler` sees the parsed query and variables. */
    graphql(handler: GraphQLHandler): void;
}

/** A JSON response. */
export function json(body: unknown, init: { readonly status?: number; readonly headers?: Record<string, string> } = {}): Response {
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
    });
}

function headersOf(init: RequestInit): Record<string, string> {
    const out: Record<string, string> = {};
    const raw = init.headers;
    if (raw === undefined) return out;
    new Headers(raw).forEach((value, key) => {
        out[key] = value;
    });
    return out;
}

export function fakeGitHub(): FakeGitHub {
    const handlers = new Map<string, FakeHandler>();
    const requests: FakeRequest[] = [];
    const graphqlCalls: GraphQLCall[] = [];
    let graphqlHandler: GraphQLHandler | null = null;

    const fetchImpl: FetchLike = async (input, init) => {
        const url = new URL(input);
        const request: FakeRequest = {
            method: init.method ?? 'GET',
            url: input,
            path: url.pathname,
            headers: headersOf(init),
            body: typeof init.body === 'string' ? init.body : '',
            signal: init.signal ?? null
        };
        requests.push(request);
        if (request.signal?.aborted) throw request.signal.reason;
        let answer: Response | Promise<Response>;
        if (request.method === 'POST' && request.path.endsWith('/graphql') && graphqlHandler !== null) {
            const parsed = JSON.parse(request.body) as { query: string; variables: Record<string, unknown> };
            const call = { query: parsed.query, variables: parsed.variables, request };
            graphqlCalls.push(call);
            answer = graphqlHandler(call);
        } else {
            const handler = handlers.get(`${request.method} ${request.path}`);
            answer = handler === undefined ? json({ message: 'Not Found' }, { status: 404 }) : handler(request);
        }
        // Like a real fetch: a request whose signal aborts while waiting rejects with its reason.
        const signal = request.signal;
        if (signal === null) return answer;
        return new Promise<Response>((resolve, reject) => {
            const onAbort = (): void => reject(signal.reason);
            signal.addEventListener('abort', onAbort, { once: true });
            Promise.resolve(answer).then(
                (response) => {
                    signal.removeEventListener('abort', onAbort);
                    resolve(response);
                },
                (error: unknown) => {
                    signal.removeEventListener('abort', onAbort);
                    reject(error);
                }
            );
        });
    };

    return {
        fetch: fetchImpl,
        requests,
        graphqlCalls,
        on(method, path, handler) {
            handlers.set(`${method} ${path}`, handler);
        },
        graphql(handler) {
            graphqlHandler = handler;
        }
    };
}

/** A `GET /user` answer: the login, and (unless `scopes` is null, a fine-grained token) `x-oauth-scopes`. */
export function userResponse(login: string, scopes: string | null): Response {
    return json({ login, id: 1 }, { headers: scopes === null ? {} : { 'x-oauth-scopes': scopes } });
}
