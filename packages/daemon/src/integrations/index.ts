/**
 * The integrations service (docs/integrations.md §9): GitHub's credential, device flow, search and
 * resolve, composed by `boot/compose.ts` as the create flow's `TicketService` and the sync hub's
 * `IntegrationsChannel`.
 *
 *   config.ts       where the credential lives and which GitHub to talk to (env overrides)
 *   store.ts        `integrations.json`: 0600, atomic, failing closed
 *   http.ts         every request: headers, the timeout, the meaning of every failure
 *   device-flow.ts  GitHub's device flow, polled by the daemon
 *   github.ts       the GraphQL documents and REST calls, and their parsing
 *   matching.ts     which registered repository a ticket belongs to, and its branches' facts
 *   service.ts      the service itself
 */

export {
    DEFAULT_GITHUB_API_URL,
    DEFAULT_GITHUB_WEB_URL,
    GITHUB_API_URL_ENV,
    GITHUB_CLIENT_ID_ENV,
    GITHUB_OAUTH_CLIENT_ID,
    GITHUB_WEB_URL_ENV,
    INTEGRATIONS_FILENAME,
    INTEGRATIONS_PATH_ENV,
    resolveIntegrationsConfig,
    resolveIntegrationsPath
} from './config.js';
export type { GitHubEndpoints, IntegrationsConfig } from './config.js';
export { createCredentialStore } from './store.js';
export type { CredentialStore, StoredAccount, StoredCredential } from './store.js';
export { createIntegrationsService, RESOLVE_CACHE_TTL_MS, SEARCH_CACHE_TTL_MS, SEARCH_THROTTLE_LIMIT } from './service.js';
export type { CreateIntegrationsServiceOptions, IntegrationsService, IntegrationsStore } from './service.js';
