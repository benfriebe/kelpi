import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    createWebHistoryStore,
    historyMatchForm,
    HISTORY_MAX_URL_LENGTH,
    HISTORY_RETENTION_MS,
    sanitizeHistoryURL,
    type PrefillEntry,
    type WebHistoryStoreOptions
} from './history.js';

const DAY = 86_400_000;
const T0 = 1_760_000_000_000;

function store(options: WebHistoryStoreOptions & { clock?: { at: number } } = {}) {
    const clock = options.clock ?? { at: T0 };
    const errors: string[] = [];
    const published: (readonly PrefillEntry[])[] = [];
    const history = createWebHistoryStore({
        now: () => clock.at,
        onError: (_error, context) => errors.push(context),
        onPrefillChanged: (entries) => published.push(entries),
        ...options
    });
    return { history, clock, errors, published };
}

const urls = (entries: readonly { url: string }[]): string[] => entries.map((entry) => entry.url);

describe('what history keeps (#375)', () => {
    it('keeps http, https and file URLs, and nothing else', () => {
        expect(sanitizeHistoryURL('https://example.com/a')).toBe('https://example.com/a');
        expect(sanitizeHistoryURL('http://localhost:3000')).toBe('http://localhost:3000/');
        expect(sanitizeHistoryURL('file:///Users/me/notes.html')).toBe('file:///Users/me/notes.html');
        for (const raw of ['about:blank', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'mailto:a@b.c', 'not a url', '']) {
            expect(sanitizeHistoryURL(raw)).toBeNull();
        }
    });

    it('strips credentials and refuses very long URLs', () => {
        expect(sanitizeHistoryURL('https://user:secret@example.com/x')).toBe('https://example.com/x');
        const long = `https://example.com/${'a'.repeat(HISTORY_MAX_URL_LENGTH)}`;
        expect(sanitizeHistoryURL(long)).toBeNull();
    });

    it('never keeps a URL carrying a credential in its query or fragment', () => {
        for (const raw of [
            'https://app.test/callback?code=abc&state=xyz',
            'https://app.test/#access_token=abc&token_type=bearer',
            'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abc',
            'https://app.test/login?magic=1&token=abc',
            'https://maps.test/js?API_KEY=abc'
        ]) {
            expect(sanitizeHistoryURL(raw)).toBeNull();
        }
        // An ordinary fragment or query is kept.
        expect(sanitizeHistoryURL('https://github.com/a/b#readme')).toBe('https://github.com/a/b#readme');
        expect(sanitizeHistoryURL('https://app.test/#/route?tab=2')).toBe('https://app.test/#/route?tab=2');
        expect(sanitizeHistoryURL('https://search.test/?q=kelpi')).toBe('https://search.test/?q=kelpi');
    });

    it('matches on the address with the scheme, www. and trailing slashes dropped', () => {
        expect(historyMatchForm('https://www.GitHub.com/Anthropics/')).toBe('github.com/anthropics');
        expect(historyMatchForm('file:///tmp/x')).toBe('/tmp/x');
    });

    it('does not record what it does not keep', () => {
        const { history } = store();
        expect(history.recordVisit({ url: 'about:blank', source: 'link' })).toBe(false);
        expect(history.query('blank')).toEqual([]);
    });
});

describe('suggestions', () => {
    it('matches every word against the address or the title', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://github.com/anthropics/claude-code', title: 'Claude Code repo', source: 'link' });
        history.recordVisit({ url: 'https://example.com/docs', title: 'Example docs', source: 'link' });
        expect(urls(history.query('github'))).toEqual(['https://github.com/anthropics/claude-code']);
        expect(urls(history.query('claude repo'))).toEqual(['https://github.com/anthropics/claude-code']);
        expect(urls(history.query('CLAUDE'))).toEqual(['https://github.com/anthropics/claude-code']);
        expect(history.query('claude missing')).toEqual([]);
        expect(history.query('   ')).toEqual([]);
    });

    it('ignores a scheme or www. typed into the bar, the way the stored form does', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://www.example.com/', source: 'link' });
        expect(urls(history.query('https://www.exam'))).toEqual(['https://www.example.com/']);
        // A bare scheme is not a word that matches every row.
        expect(history.query('https://')).toEqual([]);
    });

    it('puts word-boundary matches before matches inside a word', () => {
        const { history } = store();
        // The inside-a-word match is visited more, so frecency alone would rank it first.
        for (let i = 0; i < 5; i++) history.recordVisit({ url: 'https://pinpoint.dev/', source: 'link' });
        history.recordVisit({ url: 'https://point.example/', source: 'link' });
        expect(urls(history.query('point'))).toEqual(['https://point.example/', 'https://pinpoint.dev/']);
    });

    it('ranks typed visits above links, and recent above old', () => {
        const { history, clock } = store();
        history.recordVisit({ url: 'https://a.test/page', source: 'link' });
        history.recordVisit({ url: 'https://b.test/page', source: 'typed' });
        expect(urls(history.query('page'))).toEqual(['https://b.test/page', 'https://a.test/page']);

        // Sixty days on, a fresh link visit outranks a typed one from two months ago.
        clock.at += 60 * DAY;
        history.recordVisit({ url: 'https://c.test/page', source: 'link' });
        expect(urls(history.query('page'))[0]).toBe('https://c.test/page');
    });

    it('folds http/https, www. and trailing-slash variants into one suggestion', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://example.com/', source: 'typed' });
        history.recordVisit({ url: 'http://www.example.com', source: 'link' });
        expect(history.query('example')).toHaveLength(1);
    });

    it('caps the number of suggestions', () => {
        const { history } = store();
        for (let i = 0; i < 30; i++) history.recordVisit({ url: `https://site${String(i)}.test/`, source: 'link' });
        expect(history.query('site')).toHaveLength(8);
        expect(history.query('site', 3)).toHaveLength(3);
        expect(history.query('site', 500)).toHaveLength(20);
    });

    it('keeps the best title it has seen, and updates it when one arrives later', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://example.com/a', title: 'https://example.com/a', source: 'link' });
        expect(history.query('example')[0]?.title).toBe('');
        history.updateTitle('https://example.com/a', 'Alpha page');
        expect(history.query('alpha')).toEqual([{ url: 'https://example.com/a', title: 'Alpha page' }]);
        history.recordVisit({ url: 'https://example.com/a', source: 'link' });
        expect(history.query('alpha')[0]?.title).toBe('Alpha page');
    });
});

describe('the address a bare host means', () => {
    it('takes the scheme, and www., history remembers for the host', () => {
        const { history } = store();
        history.recordVisit({ url: 'http://wiki.corp.example/', source: 'typed' });
        history.recordVisit({ url: 'https://www.shop.test/', source: 'typed' });
        expect(history.rememberedAddress('wiki.corp.example')).toBe('http://wiki.corp.example/');
        expect(history.rememberedAddress('wiki.corp.example/a/b')).toBe('http://wiki.corp.example/a/b');
        expect(history.rememberedAddress('shop.test/cart')).toBe('https://www.shop.test/cart');
        // A typed `www.` stands, and so does anything that already names its scheme.
        expect(history.rememberedAddress('www.wiki.corp.example/x')).toBe('http://www.wiki.corp.example/x');
        expect(history.rememberedAddress('https://wiki.corp.example/')).toBe('https://wiki.corp.example/');
        // A host history has never seen, or text that is not a host, is left alone.
        expect(history.rememberedAddress('unknown.test/x')).toBe('unknown.test/x');
        expect(history.rememberedAddress('search words')).toBe('search words');
    });
});

describe('error pages', () => {
    it('stores a 4xx/5xx page but never suggests it, until it loads successfully', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://example.com/gone', source: 'typed', status: 404 });
        expect(history.query('gone')).toEqual([]);
        expect(history.prefill()).toEqual([]);
        // A same-document navigation carries no status and keeps the document's.
        history.recordVisit({ url: 'https://example.com/gone', source: 'link' });
        expect(history.query('gone')).toEqual([]);
        history.recordVisit({ url: 'https://example.com/gone', source: 'link', status: 200 });
        expect(urls(history.query('gone'))).toEqual(['https://example.com/gone']);
    });
});

describe('the prefill set', () => {
    it('offers an origin once any page on it was typed, and never from links alone', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://linked.test/a', source: 'link' });
        history.recordVisit({ url: 'https://linked.test/b', source: 'link' });
        expect(history.prefill()).toEqual([]);
        history.recordVisit({ url: 'https://github.com/anthropics', source: 'typed' });
        expect(history.prefill()).toEqual([{ url: 'https://github.com/', title: '', kind: 'origin' }]);
    });

    it('offers a full URL only once it was typed twice', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://github.com/a/b', title: 'B', source: 'typed' });
        expect(history.prefill().filter((entry) => entry.kind === 'url')).toEqual([]);
        history.recordVisit({ url: 'https://github.com/a/b', source: 'typed' });
        expect(history.prefill().filter((entry) => entry.kind === 'url')).toEqual([
            { url: 'https://github.com/a/b', title: 'B', kind: 'url' }
        ]);
    });

    it('folds the scheme and www. variants of a host into one origin', () => {
        const { history } = store();
        history.recordVisit({ url: 'http://www.example.com/x', source: 'typed' });
        for (let i = 0; i < 3; i++) history.recordVisit({ url: 'https://example.com/y', source: 'link' });
        const origins = history.prefill().filter((entry) => entry.kind === 'origin');
        // Typed through one variant, offered as the variant used most.
        expect(origins).toEqual([{ url: 'https://example.com/', title: '', kind: 'origin' }]);
    });

    it('publishes the set only when it changes', () => {
        const { history, published } = store();
        history.recordVisit({ url: 'https://linked.test/', source: 'link' });
        expect(published).toEqual([[]]);
        history.recordVisit({ url: 'https://github.com/', source: 'typed' });
        expect(published).toHaveLength(2);
        history.recordVisit({ url: 'https://linked.test/again', source: 'link' });
        expect(published).toHaveLength(2);
        history.remove('https://github.com/');
        expect(published.at(-1)).toEqual([]);
    });
});

describe('remove and clear', () => {
    it('removes a URL with every variant and visit', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://example.com/', source: 'typed' });
        history.recordVisit({ url: 'http://www.example.com/', source: 'typed' });
        history.recordVisit({ url: 'https://other.test/', source: 'link' });
        expect(history.remove('https://example.com')).toBe(true);
        expect(history.query('example')).toEqual([]);
        expect(urls(history.query('other'))).toEqual(['https://other.test/']);
        expect(history.remove('https://never.test/')).toBe(false);
    });

    it('throws rather than pretend, when the database fails a removal or a clear', () => {
        const { history, errors } = store();
        history.recordVisit({ url: 'https://example.com/', source: 'typed' });
        history.close();
        expect(() => history.remove('https://example.com/')).toThrow();
        expect(() => history.clear()).toThrow();
        expect(errors).toEqual(['history-remove', 'history-clear']);
    });

    it('forgets a whole site, so a mistyped one stops being prefilled', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://gogle.com/', source: 'typed' });
        history.recordVisit({ url: 'http://www.gogle.com/search', source: 'link' });
        history.recordVisit({ url: 'https://google.com/', source: 'typed' });
        expect(history.removeSite('https://gogle.com/')).toBe(true);
        expect(history.query('gogle')).toEqual([]);
        expect(history.prefill()).toEqual([{ url: 'https://google.com/', title: '', kind: 'origin' }]);
    });

    it('clears everything', () => {
        const { history } = store();
        history.recordVisit({ url: 'https://example.com/', source: 'typed' });
        history.clear();
        expect(history.query('example')).toEqual([]);
        expect(history.prefill()).toEqual([]);
    });
});

describe('expiry', () => {
    it('drops visits past 90 days, and a URL with none left', () => {
        const { history, clock } = store();
        history.recordVisit({ url: 'https://old.test/', source: 'typed' });
        clock.at += 30 * DAY;
        history.recordVisit({ url: 'https://kept.test/', source: 'link' });
        clock.at += HISTORY_RETENTION_MS - 29 * DAY;
        history.expire();
        expect(history.query('old')).toEqual([]);
        expect(history.prefill()).toEqual([]);
        expect(urls(history.query('kept'))).toEqual(['https://kept.test/']);
    });

    it('lowers the counts as visits expire, so a URL typed long ago stops being prefilled', () => {
        const { history, clock } = store();
        history.recordVisit({ url: 'https://github.com/a/b', source: 'typed' });
        clock.at += 80 * DAY;
        history.recordVisit({ url: 'https://github.com/a/b', source: 'typed' });
        expect(history.prefill().some((entry) => entry.kind === 'url')).toBe(true);
        clock.at += 20 * DAY;
        history.expire();
        expect(history.prefill().some((entry) => entry.kind === 'url')).toBe(false);
        // The recent typed visit still qualifies the origin.
        expect(history.prefill()).toEqual([{ url: 'https://github.com/', title: '', kind: 'origin' }]);
    });

    it('runs by itself at most daily as visits are recorded', () => {
        const { history, clock } = store();
        history.recordVisit({ url: 'https://old.test/', source: 'link' });
        clock.at += HISTORY_RETENTION_MS + DAY;
        history.recordVisit({ url: 'https://new.test/', source: 'link' });
        expect(history.query('old')).toEqual([]);
    });
});

describe('the file', () => {
    let dir: string | null = null;
    afterEach(() => {
        if (dir !== null) rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    it('survives a reopen', () => {
        dir = mkdtempSync(join(tmpdir(), 'kelpi-history-'));
        const path = join(dir, 'web-history.db');
        const first = store({ path });
        first.history.recordVisit({ url: 'https://github.com/', title: 'GitHub', source: 'typed' });
        first.history.close();
        const second = store({ path });
        expect(second.history.query('github')).toEqual([{ url: 'https://github.com/', title: 'GitHub' }]);
        second.history.close();
    });

    it('falls back to memory, reported, when the file is not a database', () => {
        dir = mkdtempSync(join(tmpdir(), 'kelpi-history-'));
        const path = join(dir, 'web-history.db');
        writeFileSync(path, 'this is not a sqlite file, not even close, and long enough to have a header');
        const { history, errors } = store({ path });
        expect(errors).toContain('history-open');
        expect(history.recordVisit({ url: 'https://example.com/', source: 'link' })).toBe(true);
        expect(history.query('example')).toHaveLength(1);
        history.close();
    });
});
