/**
 * The integrations service (docs/integrations.md §9): one object that owns the GitHub credential
 * and everything done with it, composed once by `boot/compose.ts`.
 *
 * It is two things to two callers:
 *
 *   - the create flow's `TicketService` (`handlers/app/context.ts`): `connected(provider)` with no
 *     network, and `resolve(ref, signal)`, which answers the FULL `ResolvedTicket` (the cleaned
 *     summary, a pull request's head facts, the matched repository and its base and head remotes,
 *     the defaults, the workspaces already open for it, the ticket file's content, warnings);
 *   - the WS channel (`ws/integrations.ts`'s `IntegrationsChannel`): status, the device flow, a
 *     pasted token, unlink, search, resolve, and a change feed the sync hub turns into
 *     `integrations-changed`.
 *
 * What it keeps, and for how long:
 *
 *   - the credential: `integrations.json` (`./store.ts`), and memory;
 *   - search answers for 30 s (`SEARCH_CACHE_TTL_MS`), keyed by login and query; at most about 20
 *     searches a minute reach GitHub (`SEARCH_THROTTLE_LIMIT`), and a GitHub rate limit is honoured
 *     until it resets;
 *   - GitHub's half of a resolve for about 5 minutes (`RESOLVE_CACHE_TTL_MS`), keyed by
 *     `ticketIdentity`, so the create that follows a sheet's resolve does not ask GitHub again. The
 *     local half (matching, branches, defaults, existing workspaces) is recomputed every time: it
 *     is git reads and store reads, and it changes as the user works;
 *   - which owners are organizations, for the daemon's life.
 *
 * Every cache is dropped when the credential changes. A 401 for the stored credential marks it
 * `revoked` (persisted), broadcasts, and answers `unauthorized`. `dispose()` (daemon stop and
 * handoff) aborts every request in flight and drops the device flow; anything asked afterwards is
 * refused with `unavailable`.
 *
 * The credential never leaves this module except as an `Authorization` header to GitHub: not in a
 * status, a reply, an error, a log line, a store action or a git call.
 */

import {
    buildTicketSearchQueries,
    gitHubOwnersFromRemotes,
    gitHubTicketKey,
    gitHubTicketURL,
    parseTicketRef,
    serializeTicketDefaults,
    TICKET_TITLE_MAX_LENGTH,
    ticketCreateDefaults,
    ticketIdentity,
    untrustedLine,
    type GitHubTicketRef,
    type TicketFileDetail,
    type TicketSearchOwner
} from '@kelpi/core/tickets';
import type {
    IntegrationFailure,
    IntegrationLinkStartReply,
    IntegrationLinkTokenReply,
    IntegrationProvider,
    IntegrationUnlinkReply,
    TicketProvider,
    TicketResolveReply,
    TicketSearchReply,
    TicketSearchSection,
    TicketSummary,
    WsIntegrationStatus
} from '@kelpi/protocol';

import { createRepoFacts, type RepoFacts } from '../git/repo-facts.js';
import {
    integrationFailure,
    TicketServiceError,
    type ExistingTicketWorkspace,
    type ResolvedPullRequest,
    type ResolvedTicket,
    type TicketService
} from '../handlers/app/context.js';
import type { DaemonState, DomainAction, Repo } from '../store/types.js';
import type { IntegrationsChannel } from '../ws/integrations.js';
import { resolveIntegrationsConfig, type IntegrationsConfig } from './config.js';
import { createDeviceFlow, type DeviceFlow } from './device-flow.js';
import { classifyOwners, fetchTicket, fetchViewer, searchTickets, type GitHubTicketDetail, type GitHubTicketRow } from './github.js';
import { createGitHubHttp, type CredentialContext, type FetchLike, type GitHubHttp } from './http.js';
import { buildRepoIndex, headRemoteFor, localBranchLookup, type RepoIndex } from './matching.js';
import { createCredentialStore, type CredentialStore, type StoredAccount } from './store.js';

export const SEARCH_CACHE_TTL_MS = 30_000;
export const SEARCH_THROTTLE_LIMIT = 20;
export const SEARCH_THROTTLE_WINDOW_MS = 60_000;
export const RESOLVE_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 64;
const PROVIDER: IntegrationProvider = 'github';

/** The store the service reads (repositories, workspaces) and writes (a repository's null `remoteURL`). */
export interface IntegrationsStore {
    getState(): DaemonState;
    dispatch(action: DomainAction): unknown;
}

export interface CreateIntegrationsServiceOptions {
    readonly store: IntegrationsStore;
    /** The daemon's version, for `User-Agent: Kelpi/<version>`. */
    readonly version: string;
    /** Resolved config; or `dbPath` + `env` to resolve it here. */
    readonly config?: IntegrationsConfig | undefined;
    readonly dbPath?: string | undefined;
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly credentials?: CredentialStore | undefined;
    readonly repoFacts?: RepoFacts | undefined;
    readonly fetch?: FetchLike | undefined;
    readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
    /** Debounced state save, after a `remoteURL` backfill. */
    readonly persist?: (() => void) | undefined;
    readonly now?: (() => number) | undefined;
    readonly newFlowID?: (() => string) | undefined;
    readonly log?: ((line: string) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface IntegrationsService extends TicketService, IntegrationsChannel {
    /** Stop and handoff: abort every request, drop the device flow, refuse what comes after. */
    dispose(): void;
}

interface Cached<T> {
    readonly at: number;
    readonly login: string;
    readonly value: T;
}

function remember<T>(map: Map<string, Cached<T>>, key: string, entry: Cached<T>): void {
    map.delete(key);
    map.set(key, entry);
    while (map.size > MAX_CACHE_ENTRIES) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/** `updatedAt` as ISO 8601 UTC, or '' when GitHub's value is not a date. */
function isoDate(value: string): string {
    const time = Date.parse(value);
    return Number.isNaN(time) ? '' : new Date(time).toISOString();
}

/** A row as the wire's `TicketSummary`: every string cleaned, the URL built here (always https://github.com/…). */
export function ticketSummary(row: GitHubTicketRow, repoID: string | null): TicketSummary {
    const author = row.author === null ? '' : untrustedLine(row.author, 60);
    return {
        provider: 'github',
        kind: row.kind,
        repo: row.repo,
        number: row.number,
        key: gitHubTicketKey(row.number),
        title: untrustedLine(row.title, TICKET_TITLE_MAX_LENGTH),
        url: gitHubTicketURL(row.repo, row.kind, row.number),
        state: row.state,
        ...(row.draft ? { draft: true as const } : {}),
        author: author === '' ? null : author,
        labels: row.labels
            .map((label) => untrustedLine(label, 60))
            .filter((label) => label !== '')
            .slice(0, 20),
        updated_at: isoDate(row.updatedAt),
        repo_id: repoID
    };
}

export function createIntegrationsService(options: CreateIntegrationsServiceOptions): IntegrationsService {
    const now = options.now ?? (() => Date.now());
    const log = options.log ?? ((): void => {});
    const report = (error: unknown, context: string): void => options.onError?.(toError(error), context);
    const config = options.config ?? resolveIntegrationsConfig(options.dbPath ?? ':memory:', options.env ?? {});
    for (const note of config.notes) log(note);
    const credentials = options.credentials ?? createCredentialStore({ path: config.path, now, onError: (error, context) => report(error, context) });
    if (credentials.unreadable) {
        log(`integrations: ${credentials.path ?? 'integrations.json'} is unreadable (${credentials.unreadableReason ?? 'unknown'}); GitHub stays disconnected until it is linked again`);
    }
    const facts = options.repoFacts ?? createRepoFacts();
    const http: GitHubHttp = createGitHubHttp({
        endpoints: config.endpoints,
        userAgent: `Kelpi/${options.version}`,
        fetch: options.fetch,
        timeoutSignal: options.timeoutSignal,
        now,
        log
    });

    /** Aborted by `dispose()`: every request this service makes listens to it. */
    const lifetime = new AbortController();
    const listeners = new Set<(statuses: readonly WsIntegrationStatus[]) => void>();
    const searchCache = new Map<string, Cached<TicketSearchReply>>();
    const resolveCache = new Map<string, Cached<GitHubTicketDetail>>();
    const ownerKinds = new Map<string, 'user' | 'org' | null>();
    const searchTimes: number[] = [];
    let rateLimitedUntil = 0;
    /** Repositories whose null `remoteURL` this daemon already tried to fill. */
    const backfilled = new Set<string>();

    const statuses = (): WsIntegrationStatus[] => {
        const account = credentials.account(PROVIDER);
        const linking = deviceFlow.linking();
        return [
            {
                provider: PROVIDER,
                available: config.clientID !== '',
                connected: account !== null && !account.revoked,
                ...(account === null ? {} : { login: account.login, how: account.how }),
                ...(account === null || account.scopes === null ? {} : { scopes: [...account.scopes] }),
                ...(credentials.unreadable ? { problem: 'unreadable' as const } : account?.revoked === true ? { problem: 'revoked' as const } : {}),
                ...(linking === undefined ? {} : { linking })
            }
        ];
    };

    const emit = (): void => {
        if (lifetime.signal.aborted) return;
        const current = statuses();
        for (const listener of [...listeners]) {
            try {
                listener(current);
            } catch (error) {
                report(error, 'integrations: change listener');
            }
        }
    };

    const forgetCaches = (): void => {
        searchCache.clear();
        resolveCache.clear();
        ownerKinds.clear();
        rateLimitedUntil = 0;
    };

    const stopping = (): TicketServiceError => new TicketServiceError('unavailable', 'The daemon is stopping');

    /** The caller's signal and the service's lifetime, as one. */
    const bounded = (signal: AbortSignal | undefined): AbortSignal => (signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]));

    const credentialContext = (account: StoredAccount): CredentialContext => ({ how: account.how, clientID: config.clientID });

    const usableAccount = (): StoredAccount => {
        if (lifetime.signal.aborted) throw stopping();
        const account = credentials.account(PROVIDER);
        if (account === null || account.revoked) {
            throw new TicketServiceError(
                'not-connected',
                account?.revoked === true
                    ? 'GitHub refused the stored credential: link GitHub again in Settings ▸ Integrations'
                    : 'GitHub is not connected: connect it in Settings ▸ Integrations'
            );
        }
        return account;
    };

    /** Run `work` with the stored credential; a 401 for THAT credential marks it revoked. */
    const withCredential = async <T>(work: (account: StoredAccount) => Promise<T>): Promise<T> => {
        const account = usableAccount();
        try {
            return await work(account);
        } catch (error) {
            if (error instanceof TicketServiceError && error.code === 'unauthorized') {
                const current = credentials.account(PROVIDER);
                if (current !== null && current.credential.accessToken === account.credential.accessToken && !current.revoked) {
                    credentials.markRevoked(PROVIDER);
                    forgetCaches();
                    log(`integrations: github credential for ${account.login} was refused (401); marked revoked`);
                    emit();
                }
            }
            if (lifetime.signal.aborted && !(error instanceof TicketServiceError)) throw stopping();
            throw error;
        }
    };

    /** Verify a new credential, store it, and say so. */
    const link = async (token: string, how: 'oauth' | 'token', tokenType: string, signal: AbortSignal | undefined): Promise<readonly string[]> => {
        const viewer = await fetchViewer(http, token, { how, clientID: config.clientID }, bounded(signal));
        const warnings: string[] = [];
        if (viewer.scopes === null) {
            if (how === 'token') {
                warnings.push('This looks like a fine-grained token: Kelpi can only see the repositories it was granted, and GitHub does not say which.');
            }
        } else if (!viewer.scopes.includes('repo')) {
            throw new TicketServiceError(
                'missing-scope',
                how === 'token'
                    ? 'This token does not have the "repo" scope: create one with it (or a fine-grained token with read access to issues, pull requests and contents)'
                    : 'GitHub did not grant the "repo" scope: link again and approve it'
            );
        }
        if (lifetime.signal.aborted) throw stopping();
        try {
            credentials.save({
                provider: PROVIDER,
                host: 'github.com',
                login: viewer.login,
                how,
                scopes: viewer.scopes,
                createdAt: new Date(now()).toISOString(),
                revoked: false,
                credential: { accessToken: token, tokenType, expiresAt: null, refreshToken: null, refreshTokenExpiresAt: null }
            });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            throw new TicketServiceError('unavailable', `Kelpi could not save the credential${typeof code === 'string' ? ` (${code})` : ''}`);
        }
        forgetCaches();
        log(`integrations: github linked as ${viewer.login} (${how})`);
        return warnings;
    };

    const deviceFlow: DeviceFlow = createDeviceFlow({
        http,
        clientID: config.clientID,
        now,
        log,
        ...(options.newFlowID === undefined ? {} : { newFlowID: options.newFlowID }),
        onChange: emit,
        onToken: async (token, signal) => {
            await link(token.accessToken, 'oauth', token.tokenType, signal);
        }
    });

    /** A verb's failure reply. `signal` is the verb's own: a request its session dropped is not an error to report. */
    const failureOf = (error: unknown, signal?: AbortSignal): IntegrationFailure => {
        if (error instanceof TicketServiceError) return integrationFailure(error);
        if (lifetime.signal.aborted) return integrationFailure(stopping());
        if (signal?.aborted === true) return { ok: false, error: 'the request was cancelled', code: 'unavailable' };
        report(error, 'integrations');
        return { ok: false, error: 'the request failed', code: 'github-error' };
    };

    // ── repositories ────────────────────────────────────────────────────────────────

    /** Fill a registered repository's null `remoteURL` from its `origin`, once per daemon life. */
    const backfillRemoteURLs = (index: RepoIndex): void => {
        let changed = false;
        for (const repo of options.store.getState().repos) {
            if (repo.remoteURL !== null || backfilled.has(repo.id)) continue;
            const remotes = index.remotesByRepo.get(repo.id);
            if (remotes === undefined) continue;
            backfilled.add(repo.id);
            const origin = remotes.find((remote) => remote.name === 'origin');
            if (origin === undefined) continue;
            options.store.dispatch({ type: 'set-repo-remote-url', id: repo.id, remoteURL: origin.fetchURL });
            changed = true;
        }
        if (changed) options.persist?.();
    };

    const repoIndex = async (signal: AbortSignal): Promise<RepoIndex> => {
        const index = await buildRepoIndex(options.store.getState().repos, facts, signal);
        try {
            backfillRemoteURLs(index);
        } catch (error) {
            report(error, 'integrations: remote url backfill');
        }
        return index;
    };

    // ── search ──────────────────────────────────────────────────────────────────────

    const throttle = (): void => {
        const at = now();
        if (at < rateLimitedUntil) {
            const retryAfterS = Math.ceil((rateLimitedUntil - at) / 1000);
            throw new TicketServiceError('rate-limited', `GitHub's rate limit was reached; try again in ${retryAfterS} s`, { retryAfterS });
        }
        while (searchTimes.length > 0 && at - (searchTimes[0] as number) >= SEARCH_THROTTLE_WINDOW_MS) searchTimes.shift();
        if (searchTimes.length >= SEARCH_THROTTLE_LIMIT) {
            const retryAfterS = Math.max(1, Math.ceil((SEARCH_THROTTLE_WINDOW_MS - (at - (searchTimes[0] as number))) / 1000));
            throw new TicketServiceError('rate-limited', `Searching too fast; try again in ${retryAfterS} s`, { retryAfterS });
        }
        searchTimes.push(at);
    };

    const noteRateLimit = (error: unknown): void => {
        if (error instanceof TicketServiceError && error.code === 'rate-limited' && error.retryAfterS !== undefined) {
            rateLimitedUntil = Math.max(rateLimitedUntil, now() + error.retryAfterS * 1000);
        }
    };

    /** The `user:`/`org:` owners a typed search is scoped to: every registered repository's GitHub remotes. */
    const searchOwners = async (index: RepoIndex, account: StoredAccount, signal: AbortSignal): Promise<TicketSearchOwner[]> => {
        const logins = gitHubOwnersFromRemotes(index.remoteURLs);
        const unknown = logins.filter((owner) => !ownerKinds.has(owner));
        if (unknown.length > 0) {
            const classified = await classifyOwners(http, account.credential.accessToken, credentialContext(account), unknown, now(), signal);
            for (const owner of unknown) ownerKinds.set(owner, classified.get(owner) ?? null);
        }
        const owners: TicketSearchOwner[] = [];
        for (const owner of logins) {
            const kind = ownerKinds.get(owner);
            if (kind === 'user' || kind === 'org') owners.push({ login: owner, kind });
        }
        return owners;
    };

    const search = async (query: string, signal: AbortSignal): Promise<TicketSearchReply> =>
        withCredential(async (account) => {
            const key = `${account.login}\n${query}`;
            const hit = searchCache.get(key);
            if (hit !== undefined && hit.login === account.login && now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.value;
            throttle();
            const requestSignal = bounded(signal);
            const index = await repoIndex(requestSignal);
            const owners = query === '' ? [] : await searchOwners(index, account, requestSignal);
            const plan = buildTicketSearchQueries(query, owners);
            let result;
            try {
                result = await searchTickets(http, account.credential.accessToken, credentialContext(account), plan.queries, now(), requestSignal);
            } catch (error) {
                noteRateLimit(error);
                throw error;
            }
            const repoIDs = new Map<string, string | null>();
            const repoIDOf = async (repo: string): Promise<string | null> => {
                const known = repoIDs.get(repo.toLowerCase());
                if (known !== undefined) return known;
                const best = (await index.candidates(repo, requestSignal))[0];
                const id = best?.repo.id ?? null;
                repoIDs.set(repo.toLowerCase(), id);
                return id;
            };
            const sections: TicketSearchSection[] = [];
            for (const section of result.sections) {
                const items: TicketSummary[] = [];
                for (const row of section.rows) items.push(ticketSummary(row, await repoIDOf(row.repo)));
                sections.push({ id: section.id, items });
            }
            const warnings: string[] = [];
            const sectionNames: Readonly<Record<string, string>> = {
                authored: 'your pull requests',
                'review-requested': 'reviews requested from you',
                assigned: 'issues assigned to you',
                results: 'the results'
            };
            for (const id of result.failed) warnings.push(`GitHub could not answer ${sectionNames[id] ?? id}; try again`);
            if (result.ssoHiddenOrganizations > 0) {
                warnings.push(
                    `Results from ${result.ssoHiddenOrganizations} organization${result.ssoHiddenOrganizations === 1 ? '' : 's'} are hidden until this credential is authorized for their SAML single sign-on`
                );
            }
            if (plan.omittedOwners.length > 0) {
                warnings.push(`Not searched (the query would pass GitHub's 256 characters): ${plan.omittedOwners.join(', ')}`);
            }
            const reply: TicketSearchReply = { ok: true, sections, ...(warnings.length === 0 ? {} : { warnings }) };
            remember(searchCache, key, { at: now(), login: account.login, value: reply });
            return reply;
        });

    // ── resolve ─────────────────────────────────────────────────────────────────────

    const existingFor = (identity: string, repoID: string | null, branch: string | null): ExistingTicketWorkspace[] => {
        const existing: ExistingTicketWorkspace[] = [];
        const seen = new Set<string>();
        const state = options.store.getState();
        for (const workspace of state.workspaces) {
            if (workspace.ticket !== null && ticketIdentity(workspace.ticket) === identity) {
                existing.push({ workspaceID: workspace.id, reason: 'ticket' });
                seen.add(workspace.id);
            }
        }
        if (repoID !== null && branch !== null) {
            for (const workspace of state.workspaces) {
                if (seen.has(workspace.id)) continue;
                if (workspace.repoAssociations.some((association) => association.repoID === repoID && association.branchName === branch)) {
                    existing.push({ workspaceID: workspace.id, reason: 'branch' });
                    seen.add(workspace.id);
                }
            }
        }
        return existing;
    };

    const fetchDetail = async (ref: GitHubTicketRef, identity: string, signal: AbortSignal): Promise<{ detail: GitHubTicketDetail; at: number }> =>
        withCredential(async (account) => {
            const hit = resolveCache.get(identity);
            if (hit !== undefined && hit.login === account.login && now() - hit.at < RESOLVE_CACHE_TTL_MS) return { detail: hit.value, at: hit.at };
            const detail = await fetchTicket(http, account.credential.accessToken, credentialContext(account), ref, now(), bounded(signal));
            const at = now();
            remember(resolveCache, identity, { at, login: account.login, value: detail });
            return { detail, at };
        });

    const resolveTicket = async (ref: GitHubTicketRef, signal: AbortSignal): Promise<ResolvedTicket> => {
        const identity = ticketIdentity({ provider: 'github', repo: ref.repo, number: ref.number, key: gitHubTicketKey(ref.number) });
        const { detail, at } = await fetchDetail(ref, identity, signal);
        const requestSignal = bounded(signal);
        const index = await repoIndex(requestSignal);
        const match = (await index.candidates(detail.repo, requestSignal))[0] ?? null;
        const repo: Repo | null = match?.repo ?? null;
        const remotes = match?.remotes ?? [];
        const pr = detail.pullRequest;
        let pullRequest: ResolvedPullRequest | null = null;
        if (pr !== null) {
            const head = match === null ? { headRemote: null, headPushURL: null } : headRemoteFor(pr, remotes, match.remote);
            pullRequest = { ...pr, ...head };
        }
        const branches = repo === null ? null : await facts.branches(repo.path, requestSignal);
        const summary = ticketSummary(detail, repo?.id ?? null);
        const defaults = ticketCreateDefaults({
            kind: summary.kind,
            number: summary.number,
            key: summary.key,
            title: summary.title,
            url: summary.url,
            repo: summary.repo,
            author: summary.author,
            labels: summary.labels,
            repoID: summary.repo_id,
            pullRequest: pr === null ? null : { headRef: pr.headRef, headOwner: pr.headOwner, baseRef: pr.baseRef, baseDefaultBranch: pr.baseDefaultBranch },
            localBranch: localBranchLookup(branches, remotes, {
                kind: summary.kind,
                number: summary.number,
                repo: summary.repo,
                headRef: pr?.headRef ?? null,
                headRepo: pr?.headRepo ?? null,
                crossRepository: pr?.crossRepository ?? false
            })
        });
        const warnings = [...defaults.warnings];
        if (repo === null) {
            warnings.push(`${summary.repo} is not a registered repository: add it in Settings ▸ Repositories to work on it in a worktree`);
        }
        const what = summary.kind === 'pr' ? 'pull request' : 'issue';
        if (summary.state !== 'open') warnings.push(`${what} ${summary.key} is ${summary.state}`);
        if (pr !== null && pr.crossRepository) {
            if (pr.headRepo === null) {
                warnings.push(`the fork ${summary.key} came from was deleted: its branch can be checked out, but not pushed back`);
            } else if (pullRequest?.headRemote === null && pullRequest.headPushURL === null && repo !== null) {
                warnings.push(`the fork does not let maintainers push: ${summary.key}'s branch can be checked out, but not pushed back`);
            }
        }
        const file: TicketFileDetail = {
            provider: 'github',
            kind: detail.kind,
            key: summary.key,
            title: detail.title,
            url: summary.url,
            repo: summary.repo,
            state: detail.state,
            draft: detail.draft,
            author: detail.author,
            labels: detail.labels,
            ...(pr === null ? {} : { baseRef: pr.baseRef, headRef: pr.headRef, headRepo: pr.headRepo }),
            body: detail.body,
            comments: detail.comments,
            ...(pr === null ? {} : { reviewComments: detail.reviewComments })
        };
        return {
            summary,
            pullRequest,
            repoID: summary.repo_id,
            baseRemote: match?.remote.name ?? null,
            defaults,
            // GitHub's own name for the repository, not the reference as typed: a renamed or
            // transferred repository still finds the workspaces created under its current name.
            existing: existingFor(ticketIdentity(summary), summary.repo_id, defaults.branch),
            checkedOutAt: defaults.checkedOutAt,
            warnings,
            file,
            resolvedAt: at
        };
    };

    // ── the service ─────────────────────────────────────────────────────────────────

    return {
        connected(provider: TicketProvider) {
            if (provider !== PROVIDER || lifetime.signal.aborted) return false;
            const account = credentials.account(PROVIDER);
            return account !== null && !account.revoked;
        },

        resolve: resolveTicket,

        statuses,

        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        async linkStart(_provider, signal): Promise<IntegrationLinkStartReply | IntegrationFailure> {
            try {
                const started = await deviceFlow.start(bounded(signal));
                return {
                    ok: true,
                    flow_id: started.flowID,
                    user_code: started.userCode,
                    verification_uri: started.verificationURI,
                    expires_in: started.expiresIn,
                    interval: started.interval
                };
            } catch (error) {
                return failureOf(error, signal);
            }
        },

        linkCancel(_provider, flowID) {
            return { ok: true, cancelled: deviceFlow.cancel(flowID) };
        },

        async linkToken(_provider, token, signal): Promise<IntegrationLinkTokenReply | IntegrationFailure> {
            try {
                if (lifetime.signal.aborted) throw stopping();
                const warnings = await link(token, 'token', 'bearer', signal);
                // A pasted token replaces whatever the device flow was doing.
                if (!deviceFlow.cancel()) deviceFlow.clearFailure();
                emit();
                return { ok: true, integrations: statuses(), ...(warnings.length === 0 ? {} : { warnings }) };
            } catch (error) {
                return failureOf(error, signal);
            }
        },

        unlink(_provider): IntegrationUnlinkReply | IntegrationFailure {
            try {
                if (lifetime.signal.aborted) throw stopping();
                const account = credentials.account(PROVIDER);
                try {
                    credentials.remove(PROVIDER);
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    throw new TicketServiceError('unavailable', `Kelpi could not update its credential file${typeof code === 'string' ? ` (${code})` : ''}`);
                }
                if (!deviceFlow.cancel()) deviceFlow.clearFailure();
                forgetCaches();
                log(`integrations: github unlinked${account === null ? '' : ` (${account.login})`}`);
                emit();
                return { ok: true, integrations: statuses() };
            } catch (error) {
                return failureOf(error);
            }
        },

        async ticketSearch(_provider, query, signal): Promise<TicketSearchReply | IntegrationFailure> {
            try {
                return await search(query, signal);
            } catch (error) {
                return failureOf(error, signal);
            }
        },

        async ticketResolve(ref, signal): Promise<TicketResolveReply | IntegrationFailure> {
            const parsed = parseTicketRef(ref);
            if (parsed === null) {
                return { ok: false, error: 'That is not a GitHub issue or pull request (a URL, or owner/name#123)', code: 'bad-ref' };
            }
            try {
                const resolved = await resolveTicket(parsed, signal);
                return {
                    ok: true,
                    ticket: resolved.summary,
                    defaults: serializeTicketDefaults(resolved.defaults),
                    existing: resolved.existing.map((entry) => ({ workspace_id: entry.workspaceID, reason: entry.reason })),
                    ...(resolved.checkedOutAt === null ? {} : { checked_out_at: resolved.checkedOutAt }),
                    ...(resolved.warnings.length === 0 ? {} : { warnings: resolved.warnings })
                };
            } catch (error) {
                return failureOf(error, signal);
            }
        },

        dispose() {
            if (lifetime.signal.aborted) return;
            lifetime.abort(stopping());
            deviceFlow.dispose();
            listeners.clear();
            forgetCaches();
        }
    };
}
