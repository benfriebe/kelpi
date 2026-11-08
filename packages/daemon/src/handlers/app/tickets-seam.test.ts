/**
 * The create flow's ticket seam (docs/integrations.md §8): the inert default, the error type and
 * the two wire forms a refusal takes.
 */

import { describe, expect, it } from 'vitest';

import { parseTicketRef } from '@kelpi/core/tickets';
import { parseIntegrationFailure } from '@kelpi/protocol';

import { workspaceTicketOf } from '../../store/index.js';
import {
    INERT_TICKET_SERVICE,
    integrationFailure,
    resolveAppDeps,
    ticketCreateFailure,
    TicketServiceError,
    type TicketService
} from './context.js';

describe('the ticket seam', () => {
    it('defaults to a service that is never connected and refuses every resolve', async () => {
        const deps = resolveAppDeps();
        expect(deps.tickets).toBe(INERT_TICKET_SERVICE);
        expect(deps.tickets.connected('github')).toBe(false);
        const ref = parseTicketRef('acme/api#7');
        if (ref === null) throw new Error('ref');
        await expect(deps.tickets.resolve(ref, new AbortController().signal)).rejects.toMatchObject({
            name: 'TicketServiceError',
            code: 'not-connected'
        });
    });

    it('takes the service boot passes', () => {
        const service: TicketService = { connected: () => true, resolve: () => Promise.reject(new Error('unused')) };
        expect(resolveAppDeps({ tickets: service }).tickets).toBe(service);
    });

    it('turns an error into a verb failure and a create failure that read back the same', () => {
        const error = new TicketServiceError('sso-required', 'Authorize Kelpi for acme', {
            ssoURL: 'https://github.com/orgs/acme/sso?authorization_request=1'
        });
        expect(error).toBeInstanceOf(Error);
        expect(integrationFailure(error)).toEqual({
            ok: false,
            error: 'Authorize Kelpi for acme',
            code: 'sso-required',
            sso_url: 'https://github.com/orgs/acme/sso?authorization_request=1'
        });
        expect(ticketCreateFailure(error)).toEqual({
            ok: false,
            error: 'Authorize Kelpi for acme',
            ticket_error: 'sso-required',
            sso_url: 'https://github.com/orgs/acme/sso?authorization_request=1'
        });
        expect(parseIntegrationFailure(ticketCreateFailure(error))).toEqual(parseIntegrationFailure(integrationFailure(error)));
        const limited = new TicketServiceError('rate-limited', 'slow down', { retryAfterS: 30 });
        expect(ticketCreateFailure(limited)).toMatchObject({ ticket_error: 'rate-limited', retry_after_s: 30 });
    });

    it('keeps exactly the seven ticket fields on the workspace', () => {
        expect(
            workspaceTicketOf({
                provider: 'github',
                kind: 'pr',
                repo: 'acme/api',
                number: 418,
                key: '#418',
                title: 'Retry login on 401',
                url: 'https://github.com/acme/api/pull/418',
                state: 'open',
                author: 'octocat',
                labels: ['bug'],
                updated_at: '2026-10-07T00:00:00Z',
                repo_id: 'R1'
            })
        ).toEqual({
            provider: 'github',
            kind: 'pr',
            repo: 'acme/api',
            number: 418,
            key: '#418',
            url: 'https://github.com/acme/api/pull/418',
            title: 'Retry login on 401'
        });
    });
});
