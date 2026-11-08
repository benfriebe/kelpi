import { describe, expect, it } from 'vitest';

import { DEFAULT_TICKET_SEARCHES, GITHUB_SEARCH_QUERY_MAX_LENGTH, buildTicketSearchQueries } from './search.js';

describe('buildTicketSearchQueries (integrations.md §6)', () => {
    it('answers an empty query with the three unscoped @me lists, in order', () => {
        const plan = buildTicketSearchQueries('   ', [{ login: 'acme', kind: 'org' }]);
        expect(plan.queries).toBe(DEFAULT_TICKET_SEARCHES);
        expect(plan.queries).toEqual([
            { id: 'authored', query: 'is:open is:pr author:@me archived:false sort:updated-desc' },
            { id: 'review-requested', query: 'is:open is:pr review-requested:@me archived:false sort:updated-desc' },
            { id: 'assigned', query: 'is:open is:issue assignee:@me archived:false sort:updated-desc' }
        ]);
    });

    it('scopes typed text by deduplicated user:/org: qualifiers', () => {
        const plan = buildTicketSearchQueries('login\ntimeout', [
            { login: 'Acme', kind: 'org' },
            { login: 'octocat', kind: 'user' },
            { login: 'acme', kind: 'org' },
            { login: '-bad', kind: 'user' }
        ]);
        expect(plan).toEqual({
            queries: [{ id: 'results', query: 'login timeout in:title is:open archived:false sort:updated-desc org:acme user:octocat' }],
            omittedOwners: []
        });
    });

    it('falls back to involves:@me with no registered GitHub owner', () => {
        expect(buildTicketSearchQueries('login', []).queries).toEqual([
            { id: 'results', query: 'login in:title is:open archived:false sort:updated-desc involves:@me' }
        ]);
    });

    it("stays within GitHub's 256 characters, reporting the owners it left out", () => {
        const owners = Array.from({ length: 40 }, (_, index) => ({ login: `organization-${index}`, kind: 'org' as const }));
        const plan = buildTicketSearchQueries('x'.repeat(500), owners);
        const query = plan.queries[0]?.query ?? '';
        expect(query.length).toBeLessThanOrEqual(GITHUB_SEARCH_QUERY_MAX_LENGTH);
        expect(query).toContain('org:organization-0');
        expect(plan.omittedOwners.length).toBeGreaterThan(0);
        expect(plan.omittedOwners).toContain('organization-39');
    });
});
