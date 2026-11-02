/**
 * Private scenario fixture: a stand-in for GitHub on loopback, so a scenario can link an account
 * and start workspaces from issues and pull requests with no network and no real account
 * (`scripts/scenarios/new-workspace-from-ticket.mjs`).
 *
 * It answers exactly what the daemon's integrations service asks (docs/integrations.md §9,
 * `packages/daemon/src/integrations/{http,device-flow,github}.ts`) and nothing else:
 *
 *   web base (KELPI_GITHUB_WEB_URL = http://127.0.0.1:<port>)
 *     POST /login/device/code           the device flow's start: a user code and GitHub's own
 *                                       `https://github.com/login/device` (client-facing links are
 *                                       never rebased onto the override, so the fake spells them
 *                                       as GitHub does)
 *     POST /login/oauth/access_token    `authorization_pending` PENDING_POLLS times, then a token
 *   API base (KELPI_GITHUB_API_URL = http://127.0.0.1:<port>/api)
 *     GET  /api/user                    the viewer, with `x-oauth-scopes: repo`
 *     POST /api/graphql                 KelpiTicketSearch (the three @me lists and typed text),
 *                                       KelpiOwners (`acme` is an organization) and
 *                                       KelpiTicketResolve (acme/api #7 and #8)
 *
 * Canned data, one repository that matters, `acme/api`:
 *   - issue #7 "Fix login timeout" (assigned to the viewer);
 *   - pull request #8 "Retry on 401", same repository, head `fix/retry-401` at the commit the
 *     scenario's bare repository has (`prHeadSha`), base `main`, maintainers may modify;
 *   - `other-org/tools#3`, a review request in a repository nobody registered (a dimmed row).
 *
 * Every request is recorded (method, path, which base, the GraphQL operation and its variables,
 * whether it carried the fake token, nothing, or something else) and the record is rewritten to
 * `logFile` after each one, so a scenario asserts what the daemon asked rather than what it hoped.
 * The token itself is never written to the record. A request the fake does not know is answered
 * 404 and recorded as `unexpected`.
 *
 * `armRateLimit({ operation, retryAfterS })` makes the NEXT request for that GraphQL operation
 * answer as GitHub's rate limit does: 403, `x-ratelimit-remaining: 0`, `retry-after`.
 *
 * Use it in process (`startFakeGitHub(options)`), or run it alone for poking by hand:
 *   node scripts/fixtures/fake-github.cjs [--log <file>] [--pr-head-sha <sha>]
 * which prints `FAKE_GITHUB <port> <token>` and serves until killed.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const VERIFICATION_URI = 'https://github.com/login/device';
const VIEWER = 'octo-fake';
const PENDING_POLLS = 2;

const ISSUE_7 = {
    kind: 'issue',
    repo: 'acme/api',
    number: 7,
    title: 'Fix login timeout',
    author: 'reporter-one',
    labels: ['bug'],
    updatedAt: '2026-10-12T10:00:00Z',
    body: 'Logging in times out after 30 s on a slow network.\n\nSteps: throttle to 3G, sign in, wait.',
    comments: [{ author: VIEWER, createdAt: '2026-10-12T09:00:00Z', body: 'Seen on staging as well.' }]
};

const PR_8 = {
    kind: 'pr',
    repo: 'acme/api',
    number: 8,
    title: 'Retry on 401',
    author: VIEWER,
    labels: ['auth'],
    updatedAt: '2026-10-13T10:00:00Z',
    body: 'Retries a request once after refreshing the session when the API answers 401.',
    comments: [],
    headRef: 'fix/retry-401',
    baseRef: 'main'
};

const TOOLS_3 = {
    kind: 'pr',
    repo: 'other-org/tools',
    number: 3,
    title: 'Bump the linter',
    author: 'someone-else',
    labels: [],
    updatedAt: '2026-10-11T10:00:00Z',
    body: '',
    comments: []
};

/** A search node, the shape `parseRow` (`integrations/github.ts`) reads. */
function searchNode(ticket) {
    return {
        __typename: ticket.kind === 'pr' ? 'PullRequest' : 'Issue',
        number: ticket.number,
        title: ticket.title,
        state: 'OPEN',
        updatedAt: ticket.updatedAt,
        author: { login: ticket.author },
        labels: { nodes: ticket.labels.map((name) => ({ name })) },
        repository: { nameWithOwner: ticket.repo },
        ...(ticket.kind === 'pr' ? { isDraft: false } : {})
    };
}

function comments(list) {
    return { nodes: list.map((entry) => ({ author: { login: entry.author }, createdAt: entry.createdAt, body: entry.body })) };
}

/** `repository.issueOrPullRequest` for KelpiTicketResolve. */
function detailNode(ticket, prHeadSha) {
    const base = {
        __typename: ticket.kind === 'pr' ? 'PullRequest' : 'Issue',
        number: ticket.number,
        title: ticket.title,
        state: 'OPEN',
        body: ticket.body,
        updatedAt: ticket.updatedAt,
        author: { login: ticket.author },
        labels: { nodes: ticket.labels.map((name) => ({ name })) },
        comments: comments(ticket.comments)
    };
    if (ticket.kind !== 'pr') return base;
    return {
        ...base,
        isDraft: false,
        reviews: { nodes: [{ author: { login: 'reviewer-two' }, submittedAt: '2026-10-13T11:00:00Z', body: 'Looks right; one note inline.' }] },
        baseRefName: ticket.baseRef,
        headRefName: ticket.headRef,
        headRefOid: prHeadSha,
        isCrossRepository: false,
        maintainerCanModify: true,
        headRepositoryOwner: { login: 'acme' },
        headRepository: { nameWithOwner: 'acme/api' },
        reviewThreads: {
            nodes: [
                {
                    isResolved: false,
                    path: 'src/auth.ts',
                    line: 12,
                    comments: comments([{ author: 'reviewer-two', createdAt: '2026-10-13T11:00:00Z', body: 'Cap the retries at one.' }])
                }
            ]
        }
    };
}

/** What a search string asks for, the way `buildTicketSearchQueries` writes it. */
function answerSearch(query) {
    if (query.includes('author:@me')) return [PR_8];
    if (query.includes('review-requested:@me')) return [TOOLS_3];
    if (query.includes('assignee:@me')) return [ISSUE_7];
    const text = query.split(' in:title')[0].trim().toLowerCase();
    return [ISSUE_7, PR_8].filter((ticket) => text !== '' && ticket.title.toLowerCase().includes(text));
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

/**
 * @param {object} [options]
 * @param {string} [options.logFile]     where the request record is rewritten after each request
 * @param {string} [options.prHeadSha]   pull request #8's head commit (40 hex)
 * @param {string} [options.clientID]    the client id the daemon must send (KELPI_GITHUB_CLIENT_ID)
 */
async function startFakeGitHub(options = {}) {
    const token = `gho_fake${crypto.randomBytes(16).toString('hex')}`;
    const deviceCode = `fake-device-${crypto.randomBytes(12).toString('hex')}`;
    const userCode = `FAKE-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const clientID = options.clientID ?? 'Iv1.kelpifakeclient';
    const prHeadSha = options.prHeadSha ?? '0'.repeat(40);
    const requests = [];
    const armed = new Map();
    let polls = 0;

    const save = () => {
        if (options.logFile === undefined) return;
        fs.writeFileSync(`${options.logFile}.tmp`, JSON.stringify(requests, null, 2));
        fs.renameSync(`${options.logFile}.tmp`, options.logFile);
    };

    const server = http.createServer(async (request, response) => {
        const body = await readBody(request).catch(() => '');
        const url = new URL(request.url ?? '/', 'http://fake');
        const authorization = request.headers['authorization'];
        const record = {
            seq: requests.length + 1,
            at: Date.now(),
            method: request.method ?? '',
            path: url.pathname,
            base: url.pathname.startsWith('/api/') ? 'api' : url.pathname.startsWith('/login/') ? 'web' : 'unknown',
            operation: null,
            variables: null,
            auth: authorization === undefined ? 'none' : authorization === `Bearer ${token}` ? 'token' : 'other',
            // The token anywhere but the Authorization header: a URL, a query, a body.
            tokenElsewhere: `${request.url ?? ''}\n${body}`.includes(token),
            userAgent: String(request.headers['user-agent'] ?? ''),
            accept: String(request.headers['accept'] ?? ''),
            status: 0,
            unexpected: false
        };
        requests.push(record);
        const send = (status, payload, headers = {}) => {
            record.status = status;
            save();
            response.writeHead(status, { 'content-type': 'application/json', 'x-github-request-id': `FAKE:${String(record.seq)}`, ...headers });
            response.end(JSON.stringify(payload));
        };
        const unexpected = (why) => {
            record.unexpected = true;
            record.note = why;
            send(404, { message: 'Not Found' });
        };

        // ── the device flow (web base, never a credential) ──────────────────────────────
        if (record.method === 'POST' && url.pathname === '/login/device/code') {
            record.operation = 'device-code';
            const form = new URLSearchParams(body);
            if (form.get('client_id') !== clientID || form.get('scope') !== 'repo') {
                record.note = 'wrong client_id or scope';
                send(200, { error: 'incorrect_client_credentials' });
                return;
            }
            send(200, { device_code: deviceCode, user_code: userCode, verification_uri: VERIFICATION_URI, expires_in: 900, interval: 5 });
            return;
        }
        if (record.method === 'POST' && url.pathname === '/login/oauth/access_token') {
            record.operation = 'access-token';
            const form = new URLSearchParams(body);
            if (form.get('client_id') !== clientID || form.get('device_code') !== deviceCode || form.get('grant_type') !== DEVICE_GRANT_TYPE) {
                record.note = 'wrong client_id, device_code or grant_type';
                send(200, { error: 'incorrect_device_code' });
                return;
            }
            polls += 1;
            if (polls <= PENDING_POLLS) {
                record.note = 'authorization_pending';
                send(200, { error: 'authorization_pending', error_description: 'The authorization request is still pending.' });
                return;
            }
            record.note = 'token issued';
            send(200, { access_token: token, token_type: 'bearer', scope: 'repo' });
            return;
        }

        // ── the API (always with the fake token) ────────────────────────────────────────
        if (record.base === 'api' && record.auth !== 'token') {
            record.note = 'no or wrong credential';
            send(401, { message: 'Bad credentials' });
            return;
        }
        if (record.method === 'GET' && url.pathname === '/api/user') {
            record.operation = 'GET /user';
            send(200, { login: VIEWER, id: 1 }, { 'x-oauth-scopes': 'repo' });
            return;
        }
        if (record.method === 'POST' && url.pathname === '/api/graphql') {
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                unexpected('graphql body is not JSON');
                return;
            }
            const operation = /\bquery\s+(\w+)/.exec(String(parsed?.query ?? ''))?.[1] ?? 'unknown';
            const variables = parsed?.variables ?? {};
            record.operation = operation;
            record.variables = variables;
            const limit = armed.get(operation);
            if (limit !== undefined) {
                armed.delete(operation);
                record.note = 'rate-limited (armed)';
                send(
                    403,
                    { message: 'API rate limit exceeded for user ID 1.', documentation_url: 'https://docs.github.com/rest/rate-limit' },
                    { 'x-ratelimit-limit': '30', 'x-ratelimit-remaining': '0', 'retry-after': String(limit.retryAfterS) }
                );
                return;
            }
            if (operation === 'KelpiTicketSearch') {
                const data = {};
                for (const [name, query] of Object.entries(variables)) {
                    data[`s${name.slice(1)}`] = { nodes: answerSearch(String(query)).map(searchNode) };
                }
                send(200, { data });
                return;
            }
            if (operation === 'KelpiOwners') {
                const data = {};
                for (const [name, login] of Object.entries(variables)) {
                    data[`o${name.slice(1)}`] = String(login).toLowerCase() === 'acme' ? { __typename: 'Organization' } : null;
                }
                send(200, { data });
                return;
            }
            if (operation === 'KelpiTicketResolve') {
                const repo = `${String(variables.owner)}/${String(variables.name)}`.toLowerCase();
                if (repo !== 'acme/api') {
                    send(200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'], message: `Could not resolve to a Repository with the name '${repo}'.` }] });
                    return;
                }
                const ticket = [ISSUE_7, PR_8].find((entry) => entry.number === Number(variables.number)) ?? null;
                send(200, {
                    data: {
                        repository: {
                            nameWithOwner: 'acme/api',
                            defaultBranchRef: { name: 'main' },
                            issueOrPullRequest: ticket === null ? null : detailNode(ticket, prHeadSha)
                        }
                    },
                    ...(ticket === null
                        ? { errors: [{ type: 'NOT_FOUND', path: ['repository', 'issueOrPullRequest'], message: `Could not resolve to an issue or pull request with the number of ${String(variables.number)}.` }] }
                        : {})
                });
                return;
            }
            unexpected(`unknown GraphQL operation ${operation}`);
            return;
        }
        unexpected(`${record.method} ${url.pathname} is not something the daemon asks`);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    save();
    return {
        port,
        token,
        deviceCode,
        userCode,
        clientID,
        viewer: VIEWER,
        verificationURI: VERIFICATION_URI,
        webURL: `http://127.0.0.1:${String(port)}`,
        apiURL: `http://127.0.0.1:${String(port)}/api`,
        tickets: { issue: ISSUE_7, pr: PR_8, unregistered: TOOLS_3 },
        requests: () => requests.map((entry) => ({ ...entry })),
        armRateLimit({ operation, retryAfterS }) {
            armed.set(operation, { retryAfterS });
        },
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            })
    };
}

module.exports = { startFakeGitHub, VIEWER, VERIFICATION_URI, PENDING_POLLS };

if (require.main === module) {
    const args = process.argv.slice(2);
    const value = (flag) => {
        const index = args.indexOf(flag);
        return index >= 0 ? args[index + 1] : undefined;
    };
    startFakeGitHub({ logFile: value('--log'), prHeadSha: value('--pr-head-sha') }).then((fake) => {
        process.stdout.write(`FAKE_GITHUB ${String(fake.port)} ${fake.token}\n`);
    });
}
