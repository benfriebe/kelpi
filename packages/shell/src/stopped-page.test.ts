/**
 * #312: the daemon-stopped page and the links its buttons are made of.
 */

import { describe, expect, it } from 'vitest';

import {
    STOPPED_PAGE_MARKER,
    isStoppedPageURL,
    stoppedPageAction,
    stoppedPageActionURL,
    stoppedPageHTML,
    stoppedPageURL
} from './stopped-page.js';

describe('the daemon-stopped page', () => {
    it('says what happened, what starting brings back, and offers Start and Quit', () => {
        const html = stoppedPageHTML({ kind: 'stopped', runDir: '/Users/x/Library/Application Support/kelpid/run' });
        expect(html).toContain('Kelpi’s daemon has stopped');
        expect(html).toContain('Shells start fresh');
        expect(html).toContain(`href="${stoppedPageActionURL('start-daemon')}"`);
        expect(html).toContain(`href="${stoppedPageActionURL('quit')}"`);
        expect(html).toContain('/Users/x/Library/Application Support/kelpid/run');
    });

    it('runs no script and loads nothing', () => {
        const html = stoppedPageHTML({ kind: 'stopped', runDir: '/run' });
        expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
        expect(html).not.toMatch(/<script/i);
    });

    it('has no buttons while starting, and a Try Again after a failed start', () => {
        expect(stoppedPageHTML({ kind: 'starting' })).not.toContain('class="button');
        const failed = stoppedPageHTML({ kind: 'failed', message: 'No Node binary was found <here>', repair: 'Install Node 24+' });
        expect(failed).toContain('No Node binary was found &lt;here&gt;');
        expect(failed).toContain('Install Node 24+');
        expect(failed).toContain('Try Again');
    });

    it('recognises its own URL and nobody else’s', () => {
        expect(isStoppedPageURL(stoppedPageURL({ kind: 'starting' }))).toBe(true);
        expect(isStoppedPageURL('http://127.0.0.1:53358/?token=x')).toBe(false);
        expect(isStoppedPageURL(`data:text/html,<title>${STOPPED_PAGE_MARKER}`)).toBe(true);
        expect(isStoppedPageURL('data:text/html,<p>hello</p>')).toBe(false);
    });

    it('maps its links to actions, and nothing else', () => {
        expect(stoppedPageAction(stoppedPageActionURL('start-daemon'))).toBe('start-daemon');
        expect(stoppedPageAction(stoppedPageActionURL('quit'))).toBe('quit');
        expect(stoppedPageAction('https://kelpi-shell.invalid/rm-rf')).toBeNull();
        expect(stoppedPageAction('https://example.com/start-daemon')).toBeNull();
        expect(stoppedPageAction('not a url')).toBeNull();
    });
});
