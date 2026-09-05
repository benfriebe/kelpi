/**
 * §WEB-029 — the inline error card.
 *
 * The wiring (a main-frame `did-fail-load` loading this card, and `did-navigate` refusing to
 * treat it as a page) is Electron-only; what is checkable without a browser is the card itself:
 * that it names the failed address, says what went wrong in words, offers a Retry that goes back
 * to that address, and cannot be turned into an injection by a hostile URL.
 */

import { describe, expect, it } from 'vitest';

import {
    ERROR_PAGE_MARKER,
    isWebErrorPageURL,
    reportedTabURL,
    webErrorMessage,
    webErrorPageDataURL,
    webErrorPageHTML
} from './error-page.js';

const FAILED = { url: 'https://nope.example/path?a=1', description: 'ERR_NAME_NOT_RESOLVED', code: -105 };

describe('the error card', () => {
    it('shows the failed URL, a sentence, the code, and a Retry that retries', () => {
        const html = webErrorPageHTML(FAILED);
        expect(html).toContain("Couldn't load page");
        expect(html).toContain('The server could not be found.');
        expect(html).toContain('(-105)');
        expect(html).toContain('https://nope.example/path?a=1');
        // The Retry anchor targets the failed address — that is the whole mechanism.
        expect(html).toContain('<a class="btn" href="https://nope.example/path?a=1">Retry</a>');
    });

    /**
     * §M32 — the card is `WebPaneCoordinator.swift:803-901` transcribed. Each of these five was
     * a separate drift: the heading, the missing red badge, the URL's colour and its position
     * ABOVE the message, the filled `#0A84FF` Retry, and the card's shadow.
     */
    it('is the shipped card: badge, heading, blue URL above the message, filled Retry, shadow', () => {
        const html = webErrorPageHTML(FAILED);

        expect(html).toContain("<title>Couldn't load page</title>");
        expect(html).toContain("<h1>Couldn't load page</h1>");

        // The red circular `!` badge, at the Swift's size and both its colours.
        expect(html).toContain('<div class="icon">!</div>');
        expect(html).toContain('.icon{width:32px;height:32px;border-radius:50%;background:rgba(255,69,58,0.18);color:#FF453A;');

        // The URL is blue monospace and comes BEFORE the message paragraph.
        expect(html).toContain('color:#5AC8FA;');
        expect(html.indexOf('class="url"')).toBeLessThan(html.indexOf('class="message"'));

        // Retry is the filled system-blue button, not a muted outlined chip.
        expect(html).toContain('background:#0A84FF;color:white;');
        expect(html).not.toContain('#24405e');
        expect(html).not.toContain('#3b6ea5');

        // …and the card carries the Swift's drop shadow on the Swift's ground.
        expect(html).toContain('box-shadow:0 10px 40px rgba(0,0,0,0.4);');
        expect(html).toContain('background:#1c1c1e;color:#f2f2f7;');
    });

    it('is self-contained: no external stylesheet, script or image', () => {
        const html = webErrorPageHTML(FAILED);
        expect(html).not.toContain('<script');
        expect(html).not.toContain('<link');
        expect(html).not.toContain('src=');
    });

    it('escapes a hostile URL rather than pasting it into the document', () => {
        const html = webErrorPageHTML({
            ...FAILED,
            url: 'https://x/"><script>fetch("//evil")</script>'
        });
        expect(html).not.toContain('<script>fetch');
        expect(html).toContain('&quot;&gt;&lt;script&gt;');
    });

    it('translates the common net errors and passes anything else through', () => {
        expect(webErrorMessage('ERR_CONNECTION_REFUSED')).toBe('The connection was refused.');
        expect(webErrorMessage('ERR_INTERNET_DISCONNECTED')).toBe('There is no internet connection.');
        expect(webErrorMessage('ERR_CERT_AUTHORITY_INVALID')).toBe(
            'The secure connection could not be established.'
        );
        expect(webErrorMessage('ERR_SOMETHING_NEW')).toBe('ERR_SOMETHING_NEW');
        expect(webErrorMessage('')).toBe('The page could not be loaded.');
    });

    it('round-trips as a data URL the tab can recognise as its own', () => {
        const dataURL = webErrorPageDataURL(FAILED);
        expect(dataURL.startsWith('data:text/html;charset=utf-8,')).toBe(true);
        expect(isWebErrorPageURL(dataURL)).toBe(true);
        expect(decodeURIComponent(dataURL.slice('data:text/html;charset=utf-8,'.length))).toBe(
            webErrorPageHTML(FAILED)
        );
        expect(webErrorPageHTML(FAILED)).toContain(ERROR_PAGE_MARKER);
    });

    it('does not mistake an ordinary page for the card', () => {
        expect(isWebErrorPageURL('https://example.com/')).toBe(false);
        expect(isWebErrorPageURL('data:text/html,<h1>hi</h1>')).toBe(false);
        expect(isWebErrorPageURL('about:blank')).toBe(false);
    });
});

/**
 * §4.3 / §8.2, issue #50 (web-01). The card is a `data:` URL, and the engine reports it as the
 * page; `web-url`, `web-capture` and the console line all read `TabController.url()`, so the
 * failed address has to be reported from there or an agent polling `kelpi web url` after a bad
 * navigate gets the card itself.
 */
describe('the URL a tab reports', () => {
    const card = webErrorPageDataURL(FAILED);

    it('is the failed address while the card is showing, never the card', () => {
        expect(reportedTabURL(card, FAILED.url, true)).toBe(FAILED.url);
        // The card can be up with `failedLoad` already cleared by a later `navigate`; it is still
        // not a page, so it is still not reported.
        expect(reportedTabURL(card, 'https://next.example/', false)).toBe('https://next.example/');
        // ...and a failure whose card has not committed yet (or could not load, leaving
        // Chromium's own page) reports the address rather than what Chromium holds.
        expect(reportedTabURL('chrome-error://chromewebdata/', FAILED.url, true)).toBe(FAILED.url);
    });

    it('is the live URL for a page, and keeps §4.4 placeholders from wiping the address', () => {
        expect(reportedTabURL('https://example.com/', 'https://example.com/', false)).toBe('https://example.com/');
        expect(reportedTabURL('', 'https://example.com/', false)).toBe('https://example.com/');
        expect(reportedTabURL('about:blank', 'https://example.com/', false)).toBe('https://example.com/');
        // A tab that was never asked for anything reports what it has, placeholder included.
        expect(reportedTabURL('about:blank', '', false)).toBe('about:blank');
        expect(reportedTabURL('', '', false)).toBe('');
    });
});
