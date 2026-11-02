import { describe, expect, it } from 'vitest';

import { decodeWorkspaceTicketJSON, encodeWorkspaceTicketJSON, parseWorkspaceTicket } from './ticket.js';
import type { WorkspaceTicket } from './types.js';

const TICKET: WorkspaceTicket = {
    provider: 'github',
    kind: 'pr',
    repo: 'acme/api',
    number: 418,
    key: '#418',
    url: 'https://github.com/acme/api/pull/418',
    title: 'Retry login on 401'
};

describe('parseWorkspaceTicket', () => {
    it('keeps a whole ticket, and drops keys it does not know', () => {
        expect(parseWorkspaceTicket(TICKET)).toEqual(TICKET);
        expect(parseWorkspaceTicket({ ...TICKET, body: 'secret', token: 'ghp_x' })).toEqual(TICKET);
        expect(parseWorkspaceTicket({ ...TICKET, provider: 'linear', number: null, key: 'ENG-123', repo: 'eng' })).toMatchObject({
            provider: 'linear',
            number: null
        });
        expect(parseWorkspaceTicket({ ...TICKET, title: '' })?.title).toBe('');
    });

    it('reads anything it cannot trust whole as no ticket', () => {
        for (const value of [
            null,
            undefined,
            'x',
            [],
            { ...TICKET, provider: 'gitlab' },
            { ...TICKET, kind: 'epic' },
            { ...TICKET, repo: '' },
            { ...TICKET, key: 7 },
            { ...TICKET, number: 0 },
            { ...TICKET, number: 1.5 },
            { ...TICKET, number: '418' },
            { ...TICKET, url: 'http://github.com/acme/api/pull/418' },
            { ...TICKET, url: 'javascript:alert(1)' },
            { ...TICKET, url: 'https://github.com/a b' },
            { ...TICKET, title: null },
            { ...TICKET, title: 'x'.repeat(1001) }
        ]) {
            expect(parseWorkspaceTicket(value), JSON.stringify(value)).toBeNull();
        }
    });
});

describe('the ticketJSON column', () => {
    it('round-trips, and maps NULL, empty and broken JSON to no ticket', () => {
        const text = encodeWorkspaceTicketJSON(TICKET);
        expect(text).toBe(JSON.stringify(TICKET));
        expect(decodeWorkspaceTicketJSON(text)).toEqual(TICKET);
        expect(encodeWorkspaceTicketJSON(null)).toBeNull();
        expect(encodeWorkspaceTicketJSON(undefined)).toBeNull();
        for (const broken of [null, '', '{', 'null', '42']) expect(decodeWorkspaceTicketJSON(broken)).toBeNull();
    });
});
