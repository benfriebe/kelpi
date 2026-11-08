/**
 * The picker's GitHub searches (docs/integrations.md "Search").
 *
 * An empty query is three lists that are personal by construction, so they search all of GitHub:
 * open pull requests the user wrote, open pull requests waiting for their review, open issues
 * assigned to them. Typed text is one list of open issues and pull requests whose TITLE matches,
 * scoped to the accounts the user works in: one `user:` or `org:` qualifier per distinct owner of a
 * registered repository's GitHub remote (GitHub ORs repeated `user:`/`org:` qualifiers). With no
 * such owner the search falls back to `involves:@me`, so a fresh install still finds the user's
 * own tickets rather than all of GitHub's.
 *
 * Every query here is the VALUE of a GraphQL variable (`search(query: $q, …)`), never text spliced
 * into the GraphQL document, so nothing a user types can change the request's shape. Inside the
 * search syntax the user may type qualifiers of their own (`label:bug`); that is a feature.
 *
 * GitHub caps a search at 256 characters. The typed text is capped well below that
 * (`TICKET_SEARCH_QUERY_MAX_LENGTH`), and owner qualifiers are added while they fit; any that do
 * not are reported in `omittedOwners` for the daemon to mention.
 */

import { TICKET_SEARCH_QUERY_MAX_LENGTH, type TicketSearchSectionID } from '@kelpi/protocol';

import { isGitHubOwner } from './refs.js';
import { untrustedLine } from './text.js';

/** GitHub's limit on one search query. */
export const GITHUB_SEARCH_QUERY_MAX_LENGTH = 256;

/** Whether an owner login is a personal account (`user:`) or an organization (`org:`). */
export interface TicketSearchOwner {
    readonly login: string;
    readonly kind: 'user' | 'org';
}

export interface TicketSearchQuery {
    readonly id: TicketSearchSectionID;
    readonly query: string;
}

export interface TicketSearchPlan {
    /** In section order: three for an empty query, one `results` otherwise. */
    readonly queries: readonly TicketSearchQuery[];
    /** Owners (lowercased) left out because the query would pass 256 characters. */
    readonly omittedOwners: readonly string[];
}

const COMMON = 'archived:false sort:updated-desc';

/** The three default lists, in the order the picker shows them. */
export const DEFAULT_TICKET_SEARCHES: readonly TicketSearchQuery[] = [
    { id: 'authored', query: `is:open is:pr author:@me ${COMMON}` },
    { id: 'review-requested', query: `is:open is:pr review-requested:@me ${COMMON}` },
    { id: 'assigned', query: `is:open is:issue assignee:@me ${COMMON}` }
];

/**
 * The searches for what the user typed (module note). `text` is cleaned to one line and capped;
 * `owners` are deduplicated case-insensitively, and any that is not a valid login is skipped.
 */
export function buildTicketSearchQueries(text: string, owners: readonly TicketSearchOwner[]): TicketSearchPlan {
    const typed = untrustedLine(text, TICKET_SEARCH_QUERY_MAX_LENGTH);
    if (typed === '') return { queries: DEFAULT_TICKET_SEARCHES, omittedOwners: [] };

    const base = `${typed} in:title is:open ${COMMON}`;
    const seen = new Set<string>();
    const qualifiers: string[] = [];
    const omittedOwners: string[] = [];
    let length = base.length;
    for (const owner of owners) {
        const login = owner.login.toLowerCase();
        if (!isGitHubOwner(login) || seen.has(login)) continue;
        seen.add(login);
        const qualifier = `${owner.kind === 'org' ? 'org' : 'user'}:${login}`;
        if (length + 1 + qualifier.length > GITHUB_SEARCH_QUERY_MAX_LENGTH) {
            omittedOwners.push(login);
            continue;
        }
        qualifiers.push(qualifier);
        length += 1 + qualifier.length;
    }
    const scope = qualifiers.length > 0 ? qualifiers.join(' ') : 'involves:@me';
    return { queries: [{ id: 'results', query: `${base} ${scope}` }], omittedOwners };
}
