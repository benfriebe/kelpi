import { describe, expect, it } from 'vitest';

import { tabRequestForWindowOpen } from './window-open.js';

describe('tabRequestForWindowOpen', () => {
    it('opens a middle-clicked (or ⌘-clicked) link as a background tab', () => {
        expect(tabRequestForWindowOpen({ url: 'https://example.com/a', disposition: 'background-tab' })).toEqual({
            url: 'https://example.com/a',
            active: false
        });
    });

    it('opens a target=_blank link, a ⇧⌘-click or a window.open as the active tab', () => {
        for (const disposition of ['foreground-tab', 'new-window']) {
            expect(tabRequestForWindowOpen({ url: 'http://localhost:3000/b', disposition })).toEqual({
                url: 'http://localhost:3000/b',
                active: true
            });
        }
    });

    it('refuses dispositions that are not a request for a new place to show a page', () => {
        for (const disposition of ['default', 'save-to-disk', 'other', '']) {
            expect(tabRequestForWindowOpen({ url: 'https://example.com/', disposition })).toBeNull();
        }
    });

    it('passes on http(s) only', () => {
        for (const url of ['about:blank', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'not a url', '']) {
            expect(tabRequestForWindowOpen({ url, disposition: 'background-tab' })).toBeNull();
        }
    });
});
