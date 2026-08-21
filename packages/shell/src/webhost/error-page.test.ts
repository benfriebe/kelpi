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
    webErrorMessage,
    webErrorPageDataURL,
    webErrorPageHTML
} from './error-page.js';

const FAILED = { url: 'https://nope.example/path?a=1', description: 'ERR_NAME_NOT_RESOLVED', code: -105 };

describe('the error card', () => {
    it('shows the failed URL, a sentence, the code, and a Retry that retries', () => {
        const html = webErrorPageHTML(FAILED);
        expect(html).toContain('Failed to open page');
        expect(html).toContain('The server could not be found.');
        expect(html).toContain('(-105)');
        expect(html).toContain('https://nope.example/path?a=1');
        // The Retry anchor targets the failed address — that is the whole mechanism.
        expect(html).toContain('<a class="retry" href="https://nope.example/path?a=1">Retry</a>');
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
