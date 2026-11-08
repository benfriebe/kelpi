/**
 * The integrations wire contract (docs/integrations.md): the verb family and who may run it, the
 * request decoder, the status/frame/reply readers, and the one URL rule every opened link obeys.
 */

import { describe, expect, it } from 'vitest';

import {
    INTEGRATION_COMMANDS,
    INTEGRATION_ERROR_CODES,
    INTEGRATION_MANAGEMENT_COMMANDS,
    INTEGRATION_TOKEN_MAX_LENGTH,
    TICKET_REF_MAX_LENGTH,
    TICKET_SEARCH_QUERY_MAX_LENGTH,
    TICKET_SEARCH_SECTION_IDS,
    WORKSPACE_CHECKOUT_MODES,
    WS_INTEGRATIONS_CHANGED_MESSAGE,
    decodeIntegrationRequest,
    isGitHubWebURL,
    isIntegrationCommand,
    isIntegrationManagementCommand,
    normalizeIntegrationStatus,
    normalizeIntegrationStatuses,
    normalizeTicketSummary,
    parseIntegrationFailure,
    parseIntegrationLinkStartReply,
    parseIntegrationsChanged,
    parseIntegrationsStatusReply,
    parseTicketResolveReply,
    parseTicketSearchReply,
    type TicketSummary,
    type WsIntegrationStatus
} from './integrations.js';
import type { WsServerMessage, WsWelcomeMessage } from './messages.js';

const SUMMARY: TicketSummary = {
    provider: 'github',
    kind: 'pr',
    repo: 'acme/api',
    number: 418,
    key: '#418',
    title: 'Retry login on 401',
    url: 'https://github.com/acme/api/pull/418',
    state: 'open',
    draft: true,
    author: 'octocat',
    labels: ['bug', 'auth'],
    updated_at: '2026-10-07T01:02:03Z',
    repo_id: 'R1'
};

describe('the verb family', () => {
    it('pins the seven verbs, and the four that only an owner may run', () => {
        expect([...INTEGRATION_COMMANDS]).toEqual([
            'integrations-status',
            'integration-link-start',
            'integration-link-cancel',
            'integration-link-token',
            'integration-unlink',
            'ticket-search',
            'ticket-resolve'
        ]);
        expect([...INTEGRATION_MANAGEMENT_COMMANDS]).toEqual([
            'integration-link-start',
            'integration-link-cancel',
            'integration-link-token',
            'integration-unlink'
        ]);
        for (const command of INTEGRATION_COMMANDS) expect(isIntegrationCommand(command)).toBe(true);
        // Search, resolve and status are open to paired devices and plugin views.
        for (const command of ['integrations-status', 'ticket-search', 'ticket-resolve']) {
            expect(isIntegrationManagementCommand(command)).toBe(false);
        }
        expect(isIntegrationCommand('workspace-create')).toBe(false);
        expect(isIntegrationCommand('remote-pair')).toBe(false);
    });

    it('pins the vocabularies clients branch on', () => {
        expect([...TICKET_SEARCH_SECTION_IDS]).toEqual(['authored', 'review-requested', 'assigned', 'results']);
        expect([...WORKSPACE_CHECKOUT_MODES]).toEqual(['new-branch', 'pr-head', 'attach-branch', 'existing-checkout']);
        expect([...INTEGRATION_ERROR_CODES]).toEqual([
            'not-connected',
            'unauthorized',
            'rate-limited',
            'sso-required',
            'org-restricted',
            'not-found',
            'unreachable',
            'timeout',
            'github-error',
            'bad-ref',
            'bad-request',
            'forbidden',
            'unavailable',
            'missing-scope'
        ]);
    });
});

describe('decodeIntegrationRequest', () => {
    const decoded = (payload: Record<string, unknown>) => {
        const result = decodeIntegrationRequest(payload);
        if (!result.ok) throw new Error(`refused: ${result.failure.error}`);
        return result.request;
    };
    const refused = (payload: Record<string, unknown>) => {
        const result = decodeIntegrationRequest(payload);
        if (result.ok) throw new Error('decoded');
        return result.failure;
    };

    it('reads every verb, ignoring keys it does not know', () => {
        expect(decoded({ command: 'integrations-status', extra: 1 })).toEqual({ command: 'integrations-status' });
        expect(decoded({ command: 'integration-link-start', provider: 'github' })).toEqual({
            command: 'integration-link-start',
            provider: 'github'
        });
        expect(decoded({ command: 'integration-link-cancel', provider: 'github', flow_id: 'F1' })).toEqual({
            command: 'integration-link-cancel',
            provider: 'github',
            flow_id: 'F1'
        });
        expect(decoded({ command: 'integration-link-cancel', provider: 'github', flow_id: '' })).toEqual({
            command: 'integration-link-cancel',
            provider: 'github'
        });
        expect(decoded({ command: 'integration-unlink', provider: 'github' })).toEqual({ command: 'integration-unlink', provider: 'github' });
        expect(decoded({ command: 'ticket-search', provider: 'github', query: '  login  ' })).toEqual({
            command: 'ticket-search',
            provider: 'github',
            query: 'login'
        });
        expect(decoded({ command: 'ticket-search', provider: 'github' })).toEqual({ command: 'ticket-search', provider: 'github', query: '' });
        expect(decoded({ command: 'ticket-resolve', ref: ' acme/api#7 ' })).toEqual({ command: 'ticket-resolve', ref: 'acme/api#7' });
    });

    it('trims a pasted token and refuses anything that cannot be one', () => {
        expect(decoded({ command: 'integration-link-token', provider: 'github', token: '  ghp_abc123\n' })).toEqual({
            command: 'integration-link-token',
            provider: 'github',
            token: 'ghp_abc123'
        });
        for (const token of ['', '   ', 'ghp abc', 'ghp_\u0007x', 'x'.repeat(INTEGRATION_TOKEN_MAX_LENGTH + 1), 7]) {
            expect(refused({ command: 'integration-link-token', provider: 'github', token }).code).toBe('bad-request');
        }
    });

    it('answers bad-request for a missing or unknown provider, and for over-long or mistyped fields', () => {
        expect(refused({ command: 'integration-link-start' })).toEqual({
            ok: false,
            error: 'integration-link-start requires provider',
            code: 'bad-request'
        });
        // Linear is a stored-ticket provider, not one this daemon can link yet.
        expect(refused({ command: 'integration-link-start', provider: 'linear' }).error).toBe('unknown provider: linear');
        expect(refused({ command: 'ticket-search', provider: 'github', query: 'x'.repeat(TICKET_SEARCH_QUERY_MAX_LENGTH + 1) }).code).toBe(
            'bad-request'
        );
        expect(refused({ command: 'ticket-search', provider: 'github', query: 3 }).code).toBe('bad-request');
        expect(refused({ command: 'ticket-resolve' }).error).toBe('ticket-resolve requires ref');
        expect(refused({ command: 'ticket-resolve', ref: 'x'.repeat(TICKET_REF_MAX_LENGTH + 1) }).code).toBe('bad-request');
        expect(refused({ command: 'integration-link-cancel', provider: 'github', flow_id: 9 }).code).toBe('bad-request');
        expect(refused({ command: 'remote-pair' }).code).toBe('bad-request');
    });
});

describe('isGitHubWebURL', () => {
    it("accepts GitHub's own pages and nothing that merely mentions them", () => {
        for (const url of [
            'https://github.com/login/device',
            'https://github.com/acme/api/pull/418',
            'https://github.com/orgs/acme/sso?authorization_request=abc',
            'https://github.com/settings/connections/applications/Iv1.abc',
            'https://github.com',
            'HTTPS://GITHUB.COM/acme'
        ]) {
            expect(isGitHubWebURL(url), url).toBe(true);
        }
        for (const url of [
            'http://github.com/acme',
            'https://github.com.evil.example/acme',
            'https://github.com@evil.example/acme',
            'https://user:pass@github.com/acme',
            'https://github.com:8443/acme',
            'https://api.github.com/repos/acme/api',
            'https://evil.example/#https://github.com',
            'javascript:alert(1)//github.com',
            'github.com/acme',
            '',
            42
        ]) {
            expect(isGitHubWebURL(url), String(url)).toBe(false);
        }
    });
});

describe('status, welcome and the integrations-changed frame', () => {
    const connected: WsIntegrationStatus = {
        provider: 'github',
        available: true,
        connected: true,
        login: 'octocat',
        how: 'oauth',
        scopes: ['repo'],
        linking: { state: 'failed', flowID: 'F1', reason: 'denied', message: 'The code was denied at GitHub.' }
    };

    it('keeps a well-formed status field for field', () => {
        expect(normalizeIntegrationStatus(connected)).toEqual(connected);
        expect(normalizeIntegrationStatus({ provider: 'github', available: false, connected: false })).toEqual({
            provider: 'github',
            available: false,
            connected: false
        });
        expect(
            normalizeIntegrationStatus({
                provider: 'github',
                available: true,
                connected: false,
                linking: { state: 'pending', flowID: 'F2', expiresAt: 1_800_000_000_000 }
            })?.linking
        ).toEqual({ state: 'pending', flowID: 'F2', expiresAt: 1_800_000_000_000 });
    });

    it('drops unknown fields, so a credential can never ride through a reader', () => {
        const status = normalizeIntegrationStatus({
            ...connected,
            token: 'ghp_secret',
            accessToken: 'ghp_secret',
            deviceCode: 'dc',
            userCode: 'ABCD-1234',
            problem: 'stolen',
            linking: { state: 'pending', flowID: 'F3' }
        });
        expect(JSON.stringify(status)).not.toMatch(/secret|dc|ABCD/);
        expect(status).not.toHaveProperty('problem');
        expect(status).not.toHaveProperty('linking');
    });

    it('refuses a status for a provider this client does not know, and drops it from a list', () => {
        expect(normalizeIntegrationStatus({ provider: 'gitlab', available: true, connected: true })).toBeNull();
        expect(normalizeIntegrationStatus({ provider: 'github', available: 'yes', connected: true })).toBeNull();
        expect(normalizeIntegrationStatuses([connected, { provider: 'gitlab', available: true, connected: true }, null])).toEqual([connected]);
        expect(normalizeIntegrationStatuses('nope')).toEqual([]);
    });

    it('reads the frame, and round-trips it and the welcome fields as server messages', () => {
        const frame = { type: WS_INTEGRATIONS_CHANGED_MESSAGE, integrations: [connected] } as const;
        const server: WsServerMessage = frame;
        expect(JSON.parse(JSON.stringify(server))).toEqual(frame);
        expect(parseIntegrationsChanged(JSON.parse(JSON.stringify(frame)) as Record<string, unknown>)).toEqual([connected]);
        expect(parseIntegrationsChanged({ type: 'settings-changed', integrations: [] })).toBeNull();

        const welcome: WsWelcomeMessage = {
            type: 'welcome',
            protocolVersion: 2,
            clientID: 'C',
            daemon: { version: '0.3.0', build: 'b', pid: 1 },
            integrations: [connected],
            integrationsManageable: true
        };
        expect(JSON.parse(JSON.stringify(welcome))).toEqual(welcome);
    });

    it('reads the status reply', () => {
        expect(parseIntegrationsStatusReply({ ok: true, integrations: [connected], manageable: true })).toEqual({
            ok: true,
            integrations: [connected],
            manageable: true
        });
        expect(parseIntegrationsStatusReply({ ok: true, integrations: [connected] })?.manageable).toBe(false);
        expect(parseIntegrationsStatusReply({ ok: false, error: 'x', code: 'forbidden' })).toBeNull();
    });
});

describe('ticket readers', () => {
    it('keeps a well-formed summary and refuses a GitHub row whose link is not GitHub', () => {
        expect(normalizeTicketSummary(SUMMARY)).toEqual(SUMMARY);
        expect(normalizeTicketSummary({ ...SUMMARY, url: 'https://evil.example/acme/api/pull/418' })).toBeNull();
        expect(normalizeTicketSummary({ ...SUMMARY, number: 0 })).toBeNull();
        expect(normalizeTicketSummary({ ...SUMMARY, kind: 'epic' })).toBeNull();
        const { draft: _draft, ...notDraft } = SUMMARY;
        expect(normalizeTicketSummary({ ...notDraft, draft: false, author: null, repo_id: null, labels: ['a', 3] })).toEqual({
            ...notDraft,
            author: null,
            repo_id: null,
            labels: ['a']
        });
    });

    it('reads a search reply, dropping unknown sections and rows that do not parse', () => {
        const reply = parseTicketSearchReply({
            ok: true,
            sections: [
                { id: 'authored', items: [SUMMARY, { ...SUMMARY, url: 'ftp://x' }] },
                { id: 'starred', items: [SUMMARY] },
                { id: 'assigned', items: 'nope' }
            ],
            warnings: ['Some results from acme were hidden: authorize SSO', '']
        });
        expect(reply).toEqual({
            ok: true,
            sections: [
                { id: 'authored', items: [SUMMARY] },
                { id: 'assigned', items: [] }
            ],
            warnings: ['Some results from acme were hidden: authorize SSO']
        });
        expect(parseTicketSearchReply({ ok: true })).toBeNull();
    });

    it('reads a resolve reply with its defaults, existing workspaces and checkout', () => {
        const raw = {
            ok: true,
            ticket: SUMMARY,
            defaults: {
                name: '#418 Retry login on 401',
                repo_id: 'R1',
                worktree: 'fix-login',
                branch: 'fix/login',
                checkout: 'pr-head',
                update_main: false,
                prompt: 'Pick up pull request #418: …',
                prompt_variant: 'ticket-file'
            },
            existing: [{ workspace_id: 'W1', reason: 'ticket' }, { workspace_id: 'W2', reason: 'vibes' }],
            checked_out_at: '/Users/ben/code/api',
            warnings: ['The head was force-pushed']
        };
        expect(parseTicketResolveReply(raw)).toEqual({ ...raw, existing: [{ workspace_id: 'W1', reason: 'ticket' }] });
        expect(parseTicketResolveReply({ ...raw, defaults: { ...raw.defaults, checkout: 'teleport' } })).toBeNull();
        expect(
            parseTicketResolveReply({ ...raw, defaults: { ...raw.defaults, worktree: null, branch: '', repo_id: null } })?.defaults
        ).toMatchObject({ worktree: null, branch: null, repo_id: null });
    });

    it('reads a link-start reply only when the verification page is GitHub', () => {
        const reply = {
            ok: true,
            flow_id: 'F1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 899,
            interval: 5
        };
        expect(parseIntegrationLinkStartReply(reply)).toEqual(reply);
        expect(parseIntegrationLinkStartReply({ ...reply, verification_uri: 'https://evil.example/login/device' })).toBeNull();
        expect(parseIntegrationLinkStartReply({ ...reply, interval: 0 })).toBeNull();
    });
});

describe('parseIntegrationFailure', () => {
    it('reads the code and its extras, and treats an unknown code as the generic case', () => {
        expect(
            parseIntegrationFailure({
                ok: false,
                error: 'Authorize Kelpi for acme',
                code: 'sso-required',
                sso_url: 'https://github.com/orgs/acme/sso?authorization_request=1'
            })
        ).toEqual({
            error: 'Authorize Kelpi for acme',
            code: 'sso-required',
            sso_url: 'https://github.com/orgs/acme/sso?authorization_request=1'
        });
        expect(parseIntegrationFailure({ ok: false, error: 'slow down', code: 'rate-limited', retry_after_s: 42 })).toEqual({
            error: 'slow down',
            code: 'rate-limited',
            retry_after_s: 42
        });
        expect(parseIntegrationFailure({ ok: false, error: 'new thing', code: 'quantum' })?.code).toBeNull();
        expect(parseIntegrationFailure({ ok: true })).toBeNull();
    });

    it("reads a workspace-create failure's ticket_error, and drops links that are not GitHub's", () => {
        expect(
            parseIntegrationFailure({
                ok: false,
                error: 'acme restricts OAuth apps',
                ticket_error: 'org-restricted',
                settings_url: 'https://evil.example/settings',
                sso_url: 'http://github.com/orgs/acme/sso'
            })
        ).toEqual({ error: 'acme restricts OAuth apps', code: 'org-restricted' });
    });
});
