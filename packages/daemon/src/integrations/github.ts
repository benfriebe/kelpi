/**
 * What the integrations service asks GitHub (docs/integrations.md §9.4, §9.5): who the credential
 * is (REST `GET /user`, the only call that reports a classic token's scopes), the picker's
 * searches, which owners are organizations, and one ticket in full.
 *
 * Every GraphQL document here is a CONSTANT shape: the only varying parts are alias and variable
 * names this module numbers itself (`s0`/`$q0`, `o0`/`$o0`), and every value a user or a ticket
 * supplied (search text, owner logins, owner/name/number) travels as a variable. Nothing typed
 * into the picker can change what is asked.
 *
 * Responses are parsed defensively: a row that does not have a positive number, a valid
 * `owner/name` and a known state is dropped, never guessed at. Text is returned as GitHub sent
 * it; the service cleans every string before it reaches a summary, a name or a prompt
 * (`untrustedLine`), and `renderTicketFile` cleans the rest.
 */

import { isGitHubOwner, isGitHubRepoName, type TicketFileComment, type TicketFileReviewComment, type TicketSearchQuery } from '@kelpi/core/tickets';
import type { TicketKind, TicketSearchSectionID, TicketState } from '@kelpi/protocol';

import { TicketServiceError } from '../handlers/app/context.js';
import { graphQLFailure, type CredentialContext, type GitHubHttp } from './http.js';

/** Rows per default list, and for typed text. */
export const SEARCH_PAGE_SIZE = 20;
/** Owners classified per request. */
const MAX_OWNERS_PER_LOOKUP = 30;
/** Comments and review summaries fetched; the ticket file keeps the last 10. */
const COMMENTS_FETCHED = 10;
/** Review threads read for unresolved inline comments, and comments read per thread. */
const REVIEW_THREADS_FETCHED = 50;
const COMMENTS_PER_THREAD = 5;

export interface GitHubViewer {
    readonly login: string;
    /** `x-oauth-scopes`, split; null when GitHub sent no such header (a fine-grained token). */
    readonly scopes: readonly string[] | null;
}

/** One issue or pull request as GitHub described it, before repository matching and cleaning. */
export interface GitHubTicketRow {
    readonly kind: TicketKind;
    /** `owner/name`, validated. */
    readonly repo: string;
    readonly number: number;
    readonly title: string;
    readonly state: TicketState;
    readonly draft: boolean;
    readonly author: string | null;
    readonly labels: readonly string[];
    readonly updatedAt: string;
}

export interface GitHubPullRequestHead {
    readonly headRef: string;
    readonly headSha: string;
    readonly crossRepository: boolean;
    readonly maintainerCanModify: boolean;
    readonly headOwner: string | null;
    readonly headRepo: string | null;
    readonly baseRef: string;
    readonly baseDefaultBranch: string;
}

export interface GitHubTicketDetail extends GitHubTicketRow {
    readonly body: string;
    /** Comments and review summaries, oldest first, the last 10. */
    readonly comments: readonly TicketFileComment[];
    /** Comments of unresolved review threads, in thread order. */
    readonly reviewComments: readonly TicketFileReviewComment[];
    readonly pullRequest: GitHubPullRequestHead | null;
}

export interface GitHubSearchSection {
    readonly id: TicketSearchSectionID;
    readonly rows: readonly GitHubTicketRow[];
}

export interface GitHubSearchResult {
    readonly sections: readonly GitHubSearchSection[];
    /** Sections GitHub answered with an error for (the others still came back). */
    readonly failed: readonly TicketSearchSectionID[];
    /** Organizations whose results SAML SSO hid (`X-GitHub-SSO: partial-results`). */
    readonly ssoHiddenOrganizations: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function login(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const name = value['login'];
    return typeof name === 'string' && name !== '' ? name : null;
}

function nodes(value: unknown): Record<string, unknown>[] {
    if (!isRecord(value) || !Array.isArray(value['nodes'])) return [];
    return (value['nodes'] as unknown[]).filter(isRecord);
}

/** `owner/name` from GitHub, if both halves are valid. */
function repoName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const [owner, name, extra] = value.split('/');
    if (owner === undefined || name === undefined || extra !== undefined) return null;
    return isGitHubOwner(owner) && isGitHubRepoName(name) ? `${owner}/${name}` : null;
}

function ticketState(kind: TicketKind, raw: unknown): TicketState | null {
    if (raw === 'OPEN') return 'open';
    if (raw === 'CLOSED') return 'closed';
    if (raw === 'MERGED' && kind === 'pr') return 'merged';
    return null;
}

/** One search node or resolved object → a row, or null when it is not a usable issue or pull request. */
function parseRow(node: Record<string, unknown>, fallbackRepo?: string): GitHubTicketRow | null {
    const typename = node['__typename'];
    const kind: TicketKind | null = typename === 'Issue' ? 'issue' : typename === 'PullRequest' ? 'pr' : null;
    if (kind === null) return null;
    const number = node['number'];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;
    const repository = node['repository'];
    const repo = (isRecord(repository) ? repoName(repository['nameWithOwner']) : null) ?? fallbackRepo ?? null;
    if (repo === null) return null;
    const state = ticketState(kind, node['state']);
    if (state === null) return null;
    return {
        kind,
        repo,
        number,
        title: str(node['title']) ?? '',
        state,
        draft: kind === 'pr' && node['isDraft'] === true,
        author: login(node['author']),
        labels: nodes(node['labels'])
            .map((label) => str(label['name']))
            .filter((name): name is string => name !== null && name !== ''),
        updatedAt: str(node['updatedAt']) ?? ''
    };
}

const ROW_FIELDS = `
    __typename
    number
    title
    state
    updatedAt
    author { login }
    labels(first: 10) { nodes { name } }
    repository { nameWithOwner }`;

const ROW_FRAGMENT = `
fragment KelpiTicketRow on SearchResultItem {
  ... on Issue {${ROW_FIELDS}
  }
  ... on PullRequest {${ROW_FIELDS}
    isDraft
  }
}`;

/** The search document for `count` aliased searches (`s0…`), each taking its query as `$q<i>`. */
export function searchDocument(count: number): string {
    const variables = Array.from({ length: count }, (_, index) => `$q${index}: String!`).join(', ');
    const searches = Array.from(
        { length: count },
        (_, index) => `  s${index}: search(query: $q${index}, type: ISSUE, first: ${SEARCH_PAGE_SIZE}) { nodes { ...KelpiTicketRow } }`
    ).join('\n');
    return `query KelpiTicketSearch(${variables}) {\n${searches}\n}\n${ROW_FRAGMENT}`;
}

/** `GET /user`: who the credential is, and a classic token's scopes. */
export async function fetchViewer(http: GitHubHttp, token: string, credential: CredentialContext, signal?: AbortSignal): Promise<GitHubViewer> {
    const { body, headers } = await http.restGet('/user', token, credential, signal);
    const name = isRecord(body) ? body['login'] : undefined;
    if (typeof name !== 'string' || !isGitHubOwner(name)) {
        throw new TicketServiceError('github-error', 'GitHub did not say whose credential this is');
    }
    const header = headers.get('x-oauth-scopes');
    const scopes =
        header === null
            ? null
            : header
                  .split(',')
                  .map((scope) => scope.trim())
                  .filter((scope) => scope !== '');
    return { login: name, scopes };
}

/** The picker's searches in one request (module note). */
export async function searchTickets(
    http: GitHubHttp,
    token: string,
    credential: CredentialContext,
    queries: readonly TicketSearchQuery[],
    now: number,
    signal?: AbortSignal
): Promise<GitHubSearchResult> {
    const variables: Record<string, string> = {};
    queries.forEach((query, index) => {
        variables[`q${index}`] = query.query;
    });
    const result = await http.graphql(searchDocument(queries.length), variables, token, credential, signal);
    const sections: GitHubSearchSection[] = [];
    const failed: TicketSearchSectionID[] = [];
    queries.forEach((query, index) => {
        const alias = `s${index}`;
        const answered = result.data?.[alias];
        const aliasFailed = result.errors.some((error) => error.alias === alias);
        if (!isRecord(answered) || aliasFailed) {
            failed.push(query.id);
            return;
        }
        const rows = nodes(answered)
            .map((node) => parseRow(node))
            .filter((row): row is GitHubTicketRow => row !== null);
        sections.push({ id: query.id, rows });
    });
    if (sections.length === 0) {
        throw graphQLFailure(result.errors, result.headers, credential, now) ?? new TicketServiceError('github-error', 'GitHub answered the search with nothing');
    }
    return { sections, failed, ssoHiddenOrganizations: result.ssoHiddenOrganizations };
}

/**
 * Which of `logins` are organizations and which are users (`org:` or `user:` in a typed search);
 * a login GitHub does not know maps to null and is left out of the search.
 */
export async function classifyOwners(
    http: GitHubHttp,
    token: string,
    credential: CredentialContext,
    logins: readonly string[],
    now: number,
    signal?: AbortSignal
): Promise<Map<string, 'user' | 'org' | null>> {
    const classified = new Map<string, 'user' | 'org' | null>();
    const valid = logins.filter((name) => isGitHubOwner(name));
    for (let start = 0; start < valid.length; start += MAX_OWNERS_PER_LOOKUP) {
        const batch = valid.slice(start, start + MAX_OWNERS_PER_LOOKUP);
        const variables: Record<string, string> = {};
        batch.forEach((name, index) => {
            variables[`o${index}`] = name;
        });
        const document = `query KelpiOwners(${batch.map((_, index) => `$o${index}: String!`).join(', ')}) {\n${batch
            .map((_, index) => `  o${index}: repositoryOwner(login: $o${index}) { __typename }`)
            .join('\n')}\n}`;
        const result = await http.graphql(document, variables, token, credential, signal);
        if (result.data === null) {
            throw graphQLFailure(result.errors, result.headers, credential, now) ?? new TicketServiceError('github-error', 'GitHub did not answer which owners are organizations');
        }
        batch.forEach((name, index) => {
            const owner = result.data?.[`o${index}`];
            const typename = isRecord(owner) ? owner['__typename'] : null;
            classified.set(name.toLowerCase(), typename === 'Organization' ? 'org' : typename === 'User' ? 'user' : null);
        });
    }
    return classified;
}

const COMMENT_FIELDS = 'author { login } createdAt body';

export const RESOLVE_DOCUMENT = `query KelpiTicketResolve($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        number title state body updatedAt
        author { login }
        labels(first: 20) { nodes { name } }
        comments(last: ${COMMENTS_FETCHED}) { nodes { ${COMMENT_FIELDS} } }
      }
      ... on PullRequest {
        number title state isDraft body updatedAt
        author { login }
        labels(first: 20) { nodes { name } }
        comments(last: ${COMMENTS_FETCHED}) { nodes { ${COMMENT_FIELDS} } }
        reviews(last: ${COMMENTS_FETCHED}) { nodes { author { login } submittedAt body } }
        baseRefName headRefName headRefOid isCrossRepository maintainerCanModify
        headRepositoryOwner { login }
        headRepository { nameWithOwner }
        reviewThreads(first: ${REVIEW_THREADS_FETCHED}) {
          nodes { isResolved path line comments(first: ${COMMENTS_PER_THREAD}) { nodes { ${COMMENT_FIELDS} } } }
        }
      }
    }
  }
}`;

function comment(node: Record<string, unknown>, at: 'createdAt' | 'submittedAt'): TicketFileComment | null {
    const body = str(node['body']);
    if (body === null || body.trim() === '') return null;
    return { author: login(node['author']), createdAt: str(node[at]) ?? '', body };
}

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** One ticket in full (module note). Rejects `not-found` when the repository or the number is not there. */
export async function fetchTicket(
    http: GitHubHttp,
    token: string,
    credential: CredentialContext,
    ref: { readonly owner: string; readonly name: string; readonly repo: string; readonly number: number },
    now: number,
    signal?: AbortSignal
): Promise<GitHubTicketDetail> {
    const result = await http.graphql(RESOLVE_DOCUMENT, { owner: ref.owner, name: ref.name, number: ref.number }, token, credential, signal);
    const repository = result.data?.['repository'];
    const object = isRecord(repository) ? repository['issueOrPullRequest'] : undefined;
    if (!isRecord(repository) || !isRecord(object)) {
        const failure = graphQLFailure(result.errors, result.headers, credential, now);
        if (failure !== null && failure.code !== 'not-found') throw failure;
        throw new TicketServiceError(
            'not-found',
            isRecord(repository)
                ? `${ref.repo} has no issue or pull request #${ref.number}`
                : `GitHub has no repository ${ref.repo}, or this credential cannot see it`
        );
    }
    const row = parseRow(object, repoName(repository['nameWithOwner']) ?? ref.repo);
    if (row === null) throw new TicketServiceError('github-error', `GitHub described #${ref.number} in a way Kelpi cannot read`);

    const comments: TicketFileComment[] = nodes(object['comments'])
        .map((node) => comment(node, 'createdAt'))
        .filter((entry): entry is TicketFileComment => entry !== null);
    let pullRequest: GitHubPullRequestHead | null = null;
    const reviewComments: TicketFileReviewComment[] = [];
    if (row.kind === 'pr') {
        for (const review of nodes(object['reviews'])) {
            const entry = comment(review, 'submittedAt');
            if (entry !== null) comments.push(entry);
        }
        for (const thread of nodes(object['reviewThreads'])) {
            if (thread['isResolved'] === true) continue;
            const path = str(thread['path']) ?? '';
            const line = typeof thread['line'] === 'number' && Number.isSafeInteger(thread['line']) ? thread['line'] : null;
            for (const node of nodes(thread['comments'])) {
                const entry = comment(node, 'createdAt');
                if (entry !== null) reviewComments.push({ ...entry, path, line });
            }
        }
        const headRef = str(object['headRefName']);
        const headSha = str(object['headRefOid']);
        const baseRef = str(object['baseRefName']);
        if (headRef === null || headRef === '' || headSha === null || !SHA_PATTERN.test(headSha) || baseRef === null || baseRef === '') {
            throw new TicketServiceError('github-error', `GitHub did not describe pull request #${row.number}'s branches`);
        }
        const headRepository = object['headRepository'];
        const headRepo = isRecord(headRepository) ? repoName(headRepository['nameWithOwner']) : null;
        const ownerLogin = login(object['headRepositoryOwner']);
        const defaultBranchRef = repository['defaultBranchRef'];
        pullRequest = {
            headRef,
            headSha,
            crossRepository: object['isCrossRepository'] === true,
            maintainerCanModify: object['maintainerCanModify'] === true,
            // A deleted fork has no repository; its owner is meaningless without it.
            headOwner: headRepo !== null && ownerLogin !== null && isGitHubOwner(ownerLogin) ? ownerLogin : null,
            headRepo,
            baseRef,
            baseDefaultBranch: (isRecord(defaultBranchRef) ? str(defaultBranchRef['name']) : null) ?? baseRef
        };
    }
    comments.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return {
        ...row,
        body: str(object['body']) ?? '',
        comments: comments.slice(-COMMENTS_FETCHED),
        reviewComments,
        pullRequest
    };
}
