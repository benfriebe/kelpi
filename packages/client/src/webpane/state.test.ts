/**
 * The client's read models for favourites and batch sessions.
 *
 * These are pure, and each one encodes a rule that would otherwise be re-derived (differently)
 * in two places: the URL match behind the star, the 50-character menu truncation, the
 * shell-panes-only destination list and its "the pane went away" reset.
 */

import { describe, expect, it } from 'vitest';

import {
    batchDestinations,
    favouriteMatching,
    normalizeFavouriteURL,
    parseBatchMessage,
    parseBatchSession,
    parseFavourites,
    parseFavouritesMessage,
    seededDestination,
    parseViewFocusMessage,
    truncateMiddle,
    viewFocusAppliesHere,
    type WebFavourite
} from './state';

const FAVOURITES: readonly WebFavourite[] = [
    { id: 'f1', url: 'https://example.com/Docs', title: 'Docs', created_at: '', label: 'Docs' },
    { id: 'f2', url: 'http://localhost:3000/', title: '', created_at: '', label: 'localhost:3000' }
];

describe('the favourite match (WEB-044)', () => {
    it('ignores scheme/host case and a trailing slash', () => {
        expect(favouriteMatching(FAVOURITES, 'HTTPS://EXAMPLE.com/Docs')?.id).toBe('f1');
        expect(favouriteMatching(FAVOURITES, 'http://localhost:3000')?.id).toBe('f2');
    });

    it('keeps the path case-sensitive', () => {
        expect(favouriteMatching(FAVOURITES, 'https://example.com/docs')).toBeNull();
    });

    it('never matches an empty URL (the star is disabled for one)', () => {
        expect(favouriteMatching(FAVOURITES, '   ')).toBeNull();
        expect(normalizeFavouriteURL('')).toBe('');
    });
});

describe('menu labels (WEB-038)', () => {
    it('middle-truncates at 50 characters and leaves shorter ones alone', () => {
        expect(truncateMiddle('short')).toBe('short');
        const long = 'a'.repeat(30) + 'b'.repeat(30);
        const truncated = truncateMiddle(long);
        expect(truncated).toHaveLength(50);
        expect(truncated).toContain('…');
        expect(truncated.startsWith('a')).toBe(true);
        expect(truncated.endsWith('b')).toBe(true);
    });
});

describe('the batch destination picker (WEB-132/WEB-133)', () => {
    const panes = [
        { id: 'web-1', type: 'web' },
        { id: 'shell-1', type: 'shell', tag: 'worker' },
        { id: 'shell-2', type: 'shell', workingDirectory: '/Users/x/code/kelpi' },
        { id: 'md-1', type: 'markdown' }
    ];

    it('offers only other shell panes, labelled by tag then by cwd tail', () => {
        expect(batchDestinations(panes, 'web-1')).toEqual([
            { paneID: 'shell-1', label: 'worker' },
            { paneID: 'shell-2', label: 'shell: kelpi' }
        ]);
    });

    it('excludes the source pane itself', () => {
        expect(batchDestinations(panes, 'shell-1').map((entry) => entry.paneID)).toEqual(['shell-2']);
    });

    it('falls back to a bare "shell" when there is nothing to name it by', () => {
        expect(batchDestinations([{ id: 's', type: 'shell' }], 'other')).toEqual([
            { paneID: 's', label: 'shell' }
        ]);
    });

    it('seeds the picker from the remembered target only while that pane still exists', () => {
        const destinations = batchDestinations(panes, 'web-1');
        const session = parseBatchSession({ last_target: 'shell-2', items: [] });
        expect(seededDestination(session, destinations)).toBe('shell-2');
        // The remembered pane closed mid-batch: unselected, not pointed at nothing.
        expect(seededDestination(parseBatchSession({ last_target: 'gone', items: [] }), destinations)).toBeNull();
        expect(seededDestination(null, destinations)).toBeNull();
    });
});

describe('parsing', () => {
    it('reads a favourites broadcast and ignores everything else', () => {
        expect(
            parseFavouritesMessage({
                type: 'web-favourites',
                favourites: [{ id: 'f1', url: 'https://a.example', title: 'A', created_at: '', label: 'A' }]
            })
        ).toHaveLength(1);
        expect(parseFavouritesMessage({ type: 'delta' })).toBeNull();
        // A row with no id or url cannot be addressed, so it is dropped rather than rendered.
        expect(parseFavourites([{ url: 'https://a.example' }, 'nope'])).toEqual([]);
    });

    it('reads a batch broadcast, and treats a null batch as "the session ended"', () => {
        const message = parseBatchMessage({
            type: 'web-batch',
            paneID: 'P',
            batch: {
                visible: true,
                focused_id: 'i1',
                last_target: null,
                submit: false,
                items: [{ id: 'i1', selector: '#a', tag: 'button', text: 'Go', url: 'u', comment: 'c' }]
            }
        });
        expect(message?.paneID).toBe('P');
        expect(message?.batch?.items[0]).toMatchObject({ id: 'i1', comment: 'c' });
        expect(parseBatchMessage({ type: 'web-batch', paneID: 'P', batch: null })?.batch).toBeNull();
        expect(parseBatchMessage({ type: 'web-batch' })).toBeNull();
        expect(parseBatchMessage({ type: 'notification' })).toBeNull();
    });

    it('drops batch items with no id, which nothing could address', () => {
        const session = parseBatchSession({ items: [{ selector: '#a' }, { id: 'ok', selector: '#b' }] });
        expect(session?.items.map((item) => item.id)).toEqual(['ok']);
    });
});

describe('the page-click report (§N29)', () => {
    it('reads a `web-view-focus` broadcast, window and all', () => {
        expect(
            parseViewFocusMessage({
                type: 'web-view-focus',
                paneID: 'P',
                workspaceID: 'W',
                windowID: 'win-1'
            })
        ).toEqual({ paneID: 'P', workspaceID: 'W', windowID: 'win-1' });
    });

    it('treats a missing window as "no window declared", not as an empty string', () => {
        expect(parseViewFocusMessage({ type: 'web-view-focus', paneID: 'P', workspaceID: 'W' })).toEqual({
            paneID: 'P',
            workspaceID: 'W',
            windowID: null
        });
    });

    it('rejects anything that could not move a ring: another message, or a half-addressed one', () => {
        expect(parseViewFocusMessage({ type: 'web-nav-state', paneID: 'P', workspaceID: 'W' })).toBeNull();
        expect(parseViewFocusMessage({ type: 'web-view-focus', workspaceID: 'W' })).toBeNull();
        expect(parseViewFocusMessage({ type: 'web-view-focus', paneID: 'P' })).toBeNull();
        expect(parseViewFocusMessage(null)).toBeNull();
    });

    it('applies only in the shell window it names', () => {
        const here = { paneID: 'P', workspaceID: 'W', windowID: 'win-1' };
        expect(viewFocusAppliesHere(here, 'win-1')).toBe(true);
        expect(viewFocusAppliesHere(here, 'win-2')).toBe(false);
        // An unscoped report is any shell window's — but never a browser tab's, which has no
        // native view to have been clicked in the first place.
        expect(viewFocusAppliesHere({ ...here, windowID: null }, 'win-2')).toBe(true);
        expect(viewFocusAppliesHere({ ...here, windowID: null }, null)).toBe(false);
        expect(viewFocusAppliesHere(here, null)).toBe(false);
    });
});
