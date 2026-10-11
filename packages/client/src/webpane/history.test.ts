/**
 * The URL bar's history rules (#375): what it prefills, and which rows it lists.
 */

import { describe, expect, it } from 'vitest';

import {
    inlineCompletion,
    matchesQuery,
    mergeSuggestions,
    parseHistoryEntries,
    parseHistoryRows,
    parseHistoryTypedMessage,
    prefillCandidates,
    stripForMatch,
    suggestionKey,
    type WebHistoryEntry
} from './history';

const GITHUB: WebHistoryEntry = { url: 'https://github.com/', title: 'GitHub', kind: 'origin' };
const GITLAB: WebHistoryEntry = { url: 'https://www.gitlab.com/', title: 'GitLab', kind: 'origin' };
const REPO: WebHistoryEntry = {
    url: 'https://github.com/anthropics/claude-code/issues',
    title: 'Issues',
    kind: 'url'
};
const LOCAL: WebHistoryEntry = { url: 'http://localhost:3000/', title: '', kind: 'origin' };

describe('inlineCompletion: site first', () => {
    it('completes a typed prefix to the site, slash included', () => {
        expect(inlineCompletion('git', [GITHUB])).toBe('hub.com/');
    });

    it('takes the first candidate that matches, in the daemon order', () => {
        expect(inlineCompletion('git', [GITLAB, GITHUB])).toBe('lab.com/');
        expect(inlineCompletion('gith', [GITLAB, GITHUB])).toBe('ub.com/');
    });

    it('matches without www. and without the scheme, and keeps a typed www.', () => {
        expect(inlineCompletion('gitl', [GITLAB])).toBe('ab.com/');
        expect(inlineCompletion('www.gitl', [GITLAB])).toBe('ab.com/');
    });

    it('matches the full form when the user typed a scheme', () => {
        expect(inlineCompletion('https://gi', [GITHUB])).toBe('thub.com/');
        expect(inlineCompletion('https://gitl', [GITLAB])).toBe('ab.com/');
        expect(inlineCompletion('http://gi', [GITHUB])).toBe('');
    });

    it('ignores case for the match and never rewrites what was typed', () => {
        expect(inlineCompletion('GIT', [GITHUB])).toBe('hub.com/');
    });

    it('completes a host with a port', () => {
        expect(inlineCompletion('localhost:3', [LOCAL])).toBe('000/');
    });

    it('needs no completion for an address typed exactly', () => {
        expect(inlineCompletion('github.com/', [GITHUB])).toBe('');
    });

    it('lets an address typed exactly win over a longer one that ranks higher', () => {
        const AU: WebHistoryEntry = { url: 'https://amazon.com.au/', title: '', kind: 'origin' };
        const COM: WebHistoryEntry = { url: 'https://amazon.com/', title: '', kind: 'origin' };
        expect(inlineCompletion('amazon.com', [AU, COM])).toBe('');
        expect(inlineCompletion('amazon.co', [AU, COM])).toBe('m.au/');
        const LONG: WebHistoryEntry = { url: 'https://github.com/a/bc', title: '', kind: 'url' };
        const SHORT: WebHistoryEntry = { url: 'https://github.com/a/b', title: '', kind: 'url' };
        expect(inlineCompletion('github.com/a/b', [LONG, SHORT])).toBe('');
    });

    it('never jumps a site ahead to a full address before the path is reached', () => {
        expect(inlineCompletion('git', [REPO])).toBe('');
    });

    it('does not complete empty input or anything with whitespace', () => {
        expect(inlineCompletion('', [GITHUB])).toBe('');
        expect(inlineCompletion('git hub', [GITHUB])).toBe('');
    });
});

describe('inlineCompletion: into the path', () => {
    it('fills one path segment at a time, stopping after the next slash', () => {
        expect(inlineCompletion('github.com/an', [GITHUB, REPO])).toBe('thropics/');
        expect(inlineCompletion('github.com/anthropics/c', [REPO])).toBe('laude-code/');
    });

    it('fills to the end when no slash is left', () => {
        expect(inlineCompletion('github.com/anthropics/claude-code/i', [REPO])).toBe('ssues');
    });

    it('a site never completes once the path is reached', () => {
        expect(inlineCompletion('github.com/x', [GITHUB])).toBe('');
    });
});

describe('prefillCandidates', () => {
    it('appends favourite sites after the typed list, once each', () => {
        const out = prefillCandidates([GITHUB], [
            { url: 'https://github.com/settings', title: 'Settings' },
            { url: 'https://docs.example.com/guide', title: 'Guide' },
            { url: 'https://docs.example.com/other', title: 'Other' },
            { url: 'file:///tmp/x.html', title: 'Local' }
        ]);
        // Marked, so Shift+Delete on its prefill drops it without asking history to forget it.
        expect(out).toEqual([GITHUB, { url: 'https://docs.example.com/', title: '', kind: 'origin', favourite: true }]);
    });

    it('returns the typed list itself when there is nothing to add', () => {
        const typed = [GITHUB];
        expect(prefillCandidates(typed, [])).toBe(typed);
    });
});

describe('matching and merging the list', () => {
    it('stripForMatch and suggestionKey drop scheme, www. and trailing slashes', () => {
        expect(stripForMatch('https://www.example.com/a')).toBe('example.com/a');
        expect(suggestionKey('http://www.Example.com/')).toBe('example.com');
        expect(suggestionKey('example.com')).toBe('example.com');
    });

    it('every word has to be in the address or the title', () => {
        expect(matchesQuery('claude issues', REPO.url, REPO.title)).toBe(true);
        expect(matchesQuery('claude pulls', REPO.url, REPO.title)).toBe(false);
        expect(matchesQuery('https', 'https://example.com/', 'Example')).toBe(false);
        expect(matchesQuery('   ', 'https://example.com/', 'Example')).toBe(false);
    });

    it('lists matching favourites first (at most three), then history, one row per page', () => {
        const favourites = [1, 2, 3, 4].map((n) => ({ url: `https://fav${String(n)}.test/`, title: 'fav' }));
        const rows = mergeSuggestions({
            text: 'fav',
            favourites,
            history: [
                { url: 'http://www.fav1.test', title: 'dupe of a favourite' },
                { url: 'https://history.test/fav', title: 'History' }
            ],
            prefilled: 'fav'
        });
        expect(rows.map((row) => [row.url, row.favourite])).toEqual([
            ['https://fav1.test/', true],
            ['https://fav2.test/', true],
            ['https://fav3.test/', true],
            ['https://history.test/fav', false]
        ]);
    });

    it('drops the row the bar is already prefilling, and caps the list at eight', () => {
        const history = Array.from({ length: 12 }, (_, n) => ({ url: `https://h${String(n)}.test/`, title: '' }));
        const rows = mergeSuggestions({ text: 'h', favourites: [], history, prefilled: 'h0.test/' });
        expect(rows).toHaveLength(8);
        expect(rows[0]?.url).toBe('https://h1.test/');
    });

    it('never lists a row from an earlier query that no longer matches what is typed', () => {
        // The rows answered `git`; the field now says `gitl` and its own query is still in flight.
        const history = [
            { url: 'https://github.com/', title: 'GitHub' },
            { url: 'https://gitlab.com/', title: 'GitLab' }
        ];
        const rows = mergeSuggestions({ text: 'gitl', favourites: [], history, prefilled: 'gitl' });
        expect(rows.map((row) => row.url)).toEqual(['https://gitlab.com/']);
    });

    it('reads a typed scheme or www. the way the address is read', () => {
        expect(matchesQuery('https://www.exa', 'https://example.com/', '')).toBe(true);
        expect(matchesQuery('https://', 'https://example.com/', '')).toBe(false);
    });
});

describe('wire shapes', () => {
    it('parses the prefill list and drops malformed entries', () => {
        expect(
            parseHistoryEntries([
                { url: 'https://a.test/', title: 'A', kind: 'origin' },
                { url: 'https://b.test/x', kind: 'url' },
                { url: '', kind: 'url' },
                { url: 'https://c.test/', kind: 'page' },
                'nonsense'
            ])
        ).toEqual([
            { url: 'https://a.test/', title: 'A', kind: 'origin' },
            { url: 'https://b.test/x', title: '', kind: 'url' }
        ]);
        expect(parseHistoryEntries(null)).toEqual([]);
    });

    it('reads a web-history-typed broadcast and ignores everything else', () => {
        expect(parseHistoryTypedMessage({ type: 'web-history-typed', entries: [GITHUB] })).toEqual([GITHUB]);
        expect(parseHistoryTypedMessage({ type: 'web-favourites', entries: [GITHUB] })).toBeNull();
    });

    it('parses query rows', () => {
        expect(parseHistoryRows([{ url: 'https://a.test/' }, { title: 'no url' }])).toEqual([
            { url: 'https://a.test/', title: '' }
        ]);
    });
});
