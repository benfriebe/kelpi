/**
 * Where the integrations service talks to and where it keeps the credential
 * (docs/integrations.md §9.1). Every value here is read once, at boot, from the environment the
 * daemon was started with; a test or a scenario passes its own `env` and never the process's.
 *
 *   KELPID_INTEGRATIONS_PATH   the credential file; default `<dirname(dbPath)>/integrations.json`,
 *                              and memory only for a `:memory:` database
 *   KELPI_GITHUB_CLIENT_ID     the OAuth App's client ID; overrides the build constant, and an
 *                              empty value turns the device flow off (`available: false`)
 *   KELPI_GITHUB_API_URL       the REST and GraphQL base (`https://api.github.com`)
 *   KELPI_GITHUB_WEB_URL       the device flow's base (`https://github.com`, `/login/…`)
 *
 * The two URL overrides exist for tests and end-to-end scenarios against a fake GitHub. A link
 * sends the new credential to whatever they name, so a non-HTTPS override is accepted only for a
 * loopback host, and the daemon says in its log when either is in effect. A STORED credential is
 * bound to the endpoints it was linked against (`store.ts`): a daemon booted with other endpoints
 * (an inherited override) never sends it, and reports `problem: 'endpoint-mismatch'` instead. Links a client opens
 * (the verification page, a ticket's page, an SSO or settings link) are NOT rebased onto the web
 * override: they must stay `https://github.com/…` (`isGitHubWebURL`), and a fake GitHub returns
 * GitHub's own spelling for them.
 */

import { homedir } from 'node:os';
import path from 'node:path';

import { expandTilde } from '../db/index.js';

export const INTEGRATIONS_PATH_ENV = 'KELPID_INTEGRATIONS_PATH';
export const INTEGRATIONS_FILENAME = 'integrations.json';
export const GITHUB_CLIENT_ID_ENV = 'KELPI_GITHUB_CLIENT_ID';
export const GITHUB_API_URL_ENV = 'KELPI_GITHUB_API_URL';
export const GITHUB_WEB_URL_ENV = 'KELPI_GITHUB_WEB_URL';

/**
 * The OAuth App's client ID, compiled in. Empty until the app is registered (with "Enable Device
 * Flow" on): until then Settings ▸ Integrations offers only a personal access token. A client ID
 * is public by design (the device flow has no client secret), so it may live in source.
 */
export const GITHUB_OAUTH_CLIENT_ID = '';

export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_GITHUB_WEB_URL = 'https://github.com';

/** GitHub client IDs: `Iv1.…`, `Ov23li…`, hex. Anything else is refused rather than sent. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface GitHubEndpoints {
    /** No trailing slash. */
    readonly api: string;
    /** No trailing slash. */
    readonly web: string;
}

export interface IntegrationsConfig {
    /** The credential file, or null to keep the credential in memory only. */
    readonly path: string | null;
    /** Empty = the device flow is not offered. */
    readonly clientID: string;
    readonly endpoints: GitHubEndpoints;
    /** Ready-to-log notes about overrides in effect and values that were refused. */
    readonly notes: readonly string[];
}

/** `KELPID_INTEGRATIONS_PATH`, else beside the database; null for a `:memory:` database without an override. */
export function resolveIntegrationsPath(dbPath: string, env: NodeJS.ProcessEnv): string | null {
    const override = env[INTEGRATIONS_PATH_ENV]?.trim();
    if (override !== undefined && override.length > 0) return path.resolve(expandTilde(override, env['HOME'] ?? homedir()));
    if (dbPath === ':memory:') return null;
    return path.join(path.dirname(dbPath), INTEGRATIONS_FILENAME);
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** An override URL, normalized without a trailing slash, or null when it is not one we will send a token to. */
export function endpointOverride(raw: string | undefined): string | null {
    const text = raw?.trim();
    if (text === undefined || text === '') return null;
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) return null;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function resolveIntegrationsConfig(dbPath: string, env: NodeJS.ProcessEnv, buildClientID: string = GITHUB_OAUTH_CLIENT_ID): IntegrationsConfig {
    const notes: string[] = [];
    let clientID = env[GITHUB_CLIENT_ID_ENV] !== undefined ? (env[GITHUB_CLIENT_ID_ENV] ?? '').trim() : buildClientID;
    if (clientID !== '' && !CLIENT_ID_PATTERN.test(clientID)) {
        notes.push(`integrations: ignoring a malformed ${GITHUB_CLIENT_ID_ENV}; GitHub's device flow is off`);
        clientID = '';
    }
    const endpoint = (name: string, fallback: string): string => {
        const raw = env[name];
        if (raw === undefined || raw.trim() === '') return fallback;
        const value = endpointOverride(raw);
        if (value === null) {
            notes.push(`integrations: ignoring ${name} (not https, or http to a host other than loopback)`);
            return fallback;
        }
        notes.push(`integrations: GitHub ${name === GITHUB_API_URL_ENV ? 'API' : 'web'} requests go to ${value} (${name})`);
        return value;
    };
    return {
        path: resolveIntegrationsPath(dbPath, env),
        clientID,
        endpoints: { api: endpoint(GITHUB_API_URL_ENV, DEFAULT_GITHUB_API_URL), web: endpoint(GITHUB_WEB_URL_ENV, DEFAULT_GITHUB_WEB_URL) },
        notes
    };
}
