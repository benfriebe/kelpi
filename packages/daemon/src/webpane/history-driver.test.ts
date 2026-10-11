/**
 * #375: which navigations reach the browsing history. Only the user's: a page the CLI, a plugin
 * or anything following from them loads is never recorded, nor is a reload, a restored tab, or
 * anything in a private pane.
 *
 * Driven through the real handlers (`webHarness`) and host events, so the gesture marks are
 * decoded from the wire exactly as the GUI sends them.
 */

import { describe, expect, it, vi, type MockInstance } from 'vitest';

import { attachFakeHost, id, NOW, WEB_PANE, WEB_TAB, webHarness, type FakeHost, type WebHarness } from './testing.js';
import type { WebHistoryStore } from './history.js';
import { TYPED_COMMIT_WINDOW_MS } from './service.js';

function setup(): { h: WebHarness; host: FakeHost; clock: { at: number }; record: MockInstance<WebHistoryStore['recordVisit']> } {
    const clock = { at: NOW };
    const h = webHarness({ now: () => clock.at });
    const host = attachFakeHost(h.service);
    const record = vi.spyOn(h.service.history, 'recordVisit');
    return { h, host, clock, record };
}

/** The host committing a document: `did-navigate` is the one page state with a status. */
function commit(host: FakeHost, url: string, tabID = WEB_TAB, status = 200): void {
    host.emit('nav-state', WEB_PANE, { loading: true }, tabID);
    host.emit('page-state', WEB_PANE, { url, title: '', status }, tabID);
}

const typedNavigate = (h: WebHarness, url: string): void => {
    h.send({ command: 'web-navigate', pane_id: WEB_PANE, url, gesture: true, typed: true });
};

describe('what the user navigates to is recorded', () => {
    it('records the URL bar submit as typed, so its origin can be prefilled', () => {
        const { h, host } = setup();
        typedNavigate(h, 'github.com');
        commit(host, 'https://github.com/');
        expect(h.service.history.prefill()).toEqual([{ url: 'https://github.com/', title: '', kind: 'origin' }]);
    });

    it('records the links the user follows from there, as links', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'github.com');
        commit(host, 'https://github.com/');
        // The user clicks into a same-document route, then a link to a new document.
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        host.emit('page-state', WEB_PANE, { url: 'https://github.com/#readme' }, WEB_TAB);
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        commit(host, 'https://github.com/anthropics');
        expect(record.mock.calls.map(([visit]) => [visit.url, visit.source])).toEqual([
            ['https://github.com/', 'typed'],
            ['https://github.com/#readme', 'link'],
            ['https://github.com/anthropics', 'link']
        ]);
    });

    it('counts typing the address that is already showing', () => {
        const { h, host } = setup();
        typedNavigate(h, 'https://github.com/a/b');
        commit(host, 'https://github.com/a/b');
        typedNavigate(h, 'https://github.com/a/b');
        commit(host, 'https://github.com/a/b');
        expect(h.service.history.prefill().filter((entry) => entry.kind === 'url')).toEqual([
            { url: 'https://github.com/a/b', title: '', kind: 'url' }
        ]);
    });

    it('does not count a reload, or the load finishing on the same address', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        host.emit('page-state', WEB_PANE, { url: 'https://example.com/' }, WEB_TAB);
        h.send({ command: 'web-reload', pane_id: WEB_PANE, gesture: true });
        commit(host, 'https://example.com/');
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('lets a late title follow the visit it belongs to', () => {
        const { h, host } = setup();
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        host.emit('page-state', WEB_PANE, { title: 'Example Domain' }, WEB_TAB);
        expect(h.service.history.query('domain')).toEqual([{ url: 'https://example.com/', title: 'Example Domain' }]);
    });

    it('marks every gesture-carrying GUI command as the user', () => {
        const { h, host, record } = setup();
        h.send({ command: 'web-back', pane_id: WEB_PANE, gesture: true });
        commit(host, 'https://back.test/');
        h.send({ command: 'web-forward', pane_id: WEB_PANE, gesture: true });
        commit(host, 'https://forward.test/');
        expect(record.mock.calls.map(([visit]) => visit.url)).toEqual(['https://back.test/', 'https://forward.test/']);
    });

    it('records a new tab or pane the GUI opened', () => {
        const tab = id('ffffffff', 1);
        const pane = id('ffffffff', 2);
        const paneTab = id('ffffffff', 3);
        const { h, host, record } = setup();
        h.send({ command: 'web-tab-new', pane_id: WEB_PANE, url: '', gesture: true });
        commit(host, 'https://tab.test/', tab);
        // "Open in Kelpi" on a terminal link, the header globe, ⌘⇧O: a `web-open` with the mark.
        h.reply({ command: 'web-open', url: 'https://pane.test/', pane_id: WEB_PANE, gesture: true });
        host.emit('nav-state', pane, { loading: true }, paneTab);
        host.emit('page-state', pane, { url: 'https://pane.test/', title: '', status: 200 }, paneTab);
        expect(record.mock.calls.map(([visit]) => visit.url)).toEqual(['https://tab.test/', 'https://pane.test/']);
    });

    it('opens a typed bare address at the scheme history remembers for its host', () => {
        const { h, host } = setup();
        h.service.history.recordVisit({ url: 'http://wiki.corp.example/', source: 'typed' });
        typedNavigate(h, 'wiki.corp.example/page');
        expect(host.calls.at(-1)?.args['url']).toBe('http://wiki.corp.example/page');
        // Only for the URL bar: the CLI's bare address is normalised the ordinary way.
        h.send({ command: 'web-navigate', pane_id: WEB_PANE, url: 'wiki.corp.example/page' });
        expect(host.calls.at(-1)?.args['url']).toBe('https://wiki.corp.example/page');
    });
});

describe('nothing an agent drives is recorded', () => {
    it('ignores a CLI navigation and everything after it', () => {
        const { h, host, record } = setup();
        h.send({ command: 'web-navigate', pane_id: WEB_PANE, url: 'localhost:5173' });
        commit(host, 'http://localhost:5173/');
        host.emit('page-state', WEB_PANE, { url: 'http://localhost:5173/login' }, WEB_TAB);
        commit(host, 'http://localhost:5173/admin');
        expect(record).not.toHaveBeenCalled();
    });

    it('takes the tab back from the user when an agent acts on the page', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        for (const command of [
            { command: 'web-click', selector: 'css:a' },
            { command: 'web-type', selector: 'css:input', text: 'x' },
            { command: 'web-select', selector: 'css:select', value_or_label: 'a' },
            { command: 'web-key', key: 'Enter' },
            { command: 'web-hover', selector: 'css:a' },
            { command: 'web-scroll', selector: 'css:a' },
            { command: 'web-exec', script: 'location.href = "/next"' }
        ]) {
            // The user clicks into the page, then the agent acts before the page moves.
            host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
            h.send({ pane_id: WEB_PANE, ...command });
            commit(host, `https://example.com/${command.command}`);
        }
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('leaves the tab with the user for read-only automation', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        h.send({ command: 'web-q-text', pane_id: WEB_PANE, selector: 'css:h1' });
        h.send({ command: 'web-wait', pane_id: WEB_PANE, selector: 'css:h1' });
        commit(host, 'https://example.com/next');
        expect(record).toHaveBeenCalledTimes(2);
    });

    it('ignores an agent-opened tab or pane', () => {
        const tab = id('ffffffff', 1);
        const { h, host, record } = setup();
        h.send({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'https://agent.test/' });
        commit(host, 'https://agent.test/', tab);
        expect(record).not.toHaveBeenCalled();
    });

    it('records nothing from a pane nobody drove since it was restored', () => {
        const { host, record } = setup();
        commit(host, 'https://restored.test/');
        commit(host, 'https://restored.test/redirected');
        expect(record).not.toHaveBeenCalled();
    });
});

describe('same-document changes (the flooding rule)', () => {
    it('records a page rewriting its own address only after a press', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'maps.test');
        commit(host, 'https://maps.test/');
        // A map panning: `replaceState` after `replaceState`, nobody pressing anything new.
        for (const n of [1, 2, 3]) host.emit('page-state', WEB_PANE, { url: `https://maps.test/@${String(n)}` }, WEB_TAB);
        host.emit('user-input', WEB_PANE, {}, WEB_TAB);
        host.emit('page-state', WEB_PANE, { url: 'https://maps.test/search' }, WEB_TAB);
        host.emit('page-state', WEB_PANE, { url: 'https://maps.test/search/more' }, WEB_TAB);
        expect(record.mock.calls.map(([visit]) => visit.url)).toEqual(['https://maps.test/', 'https://maps.test/search']);
    });

    it('does not take a page re-reporting the address it already showed, after a daemon restart', () => {
        const { host, record } = setup();
        // The daemon came back to a tab already showing the agent's page (the harness pane).
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        host.emit('page-state', WEB_PANE, { url: 'https://example.com' }, WEB_TAB);
        expect(record).not.toHaveBeenCalled();
    });
});

describe('a press inside the page makes the tab the user\'s', () => {
    it('records the link a user clicks in a page an agent loaded, but not that page', () => {
        const { h, host, record } = setup();
        h.send({ command: 'web-navigate', pane_id: WEB_PANE, url: 'https://agent.test/' });
        commit(host, 'https://agent.test/');
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        commit(host, 'https://agent.test/clicked');
        expect(record.mock.calls.map(([visit]) => [visit.url, visit.source])).toEqual([['https://agent.test/clicked', 'link']]);
    });

    it('treats a key press inside the page the same way', () => {
        const { host, record } = setup();
        host.emit('user-input', WEB_PANE, {}, WEB_TAB);
        commit(host, 'https://submitted.test/');
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('hands a popup the driver of the page that opened it', () => {
        const userTab = id('ffffffff', 1);
        const agentTab = id('ffffffff', 2);
        const { h, host, record } = setup();
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        host.emit('open-tab', WEB_PANE, { url: 'https://popup.test/', active: true }, WEB_TAB);
        commit(host, 'https://popup.test/', userTab);
        h.send({ command: 'web-click', pane_id: WEB_PANE, selector: 'css:a' });
        host.emit('open-tab', WEB_PANE, { url: 'https://agent-popup.test/', active: true }, userTab);
        commit(host, 'https://agent-popup.test/', agentTab);
        expect(record.mock.calls.map(([visit]) => visit.url)).toEqual(['https://popup.test/']);
    });
});

describe('the typed mark', () => {
    it('is not taken by the old page finishing its load', () => {
        const { h, host, record } = setup();
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        typedNavigate(h, 'github.com');
        // `did-finish-load` of the page that was showing: no status, so not the commit.
        host.emit('page-state', WEB_PANE, { url: 'https://example.com' }, WEB_TAB);
        commit(host, 'https://github.com/');
        expect(record.mock.calls.map(([visit]) => [visit.url, visit.source])).toEqual([['https://github.com/', 'typed']]);
    });

    it('is answered by a jump within the page to exactly the address typed', () => {
        const { h, host, record, clock } = setup();
        typedNavigate(h, 'https://example.com/#section');
        // A fragment change commits no document: no status, and no loading bracket.
        host.emit('page-state', WEB_PANE, { url: 'https://example.com/#section' }, WEB_TAB);
        // Nothing is left waiting to be credited to the next click.
        clock.at += 1000;
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        commit(host, 'https://example.com/next');
        expect(record.mock.calls.map(([visit]) => [visit.url, visit.source])).toEqual([
            ['https://example.com/#section', 'typed'],
            ['https://example.com/next', 'link']
        ]);
    });

    it('is dropped when the typed load fails, so a later click is not credited as typed', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'nowhere.invalid');
        host.emit('nav-state', WEB_PANE, { loading: true }, WEB_TAB);
        host.emit('nav-state', WEB_PANE, { loading: false }, WEB_TAB);
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        commit(host, 'https://clicked.test/');
        expect(record.mock.calls.map(([visit]) => visit.source)).toEqual(['link']);
    });

    it('expires when no document commits in time', () => {
        const { h, host, clock, record } = setup();
        typedNavigate(h, 'slow.test');
        clock.at += TYPED_COMMIT_WINDOW_MS + 1;
        commit(host, 'https://slow.test/');
        expect(record.mock.calls.map(([visit]) => visit.source)).toEqual(['link']);
    });
});

describe('reloads the daemon causes are nobody\'s', () => {
    it('records nothing in a private pane, nor when private mode is turned off', () => {
        const { h, host, record } = setup();
        h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true });
        typedNavigate(h, 'secret.test');
        commit(host, 'https://secret.test/');
        h.reply({ command: 'web-private', pane_id: WEB_PANE, private: false });
        // The rebuilt view reloads at its stored URL, and may redirect.
        commit(host, 'https://secret.test/');
        commit(host, 'https://secret.test/login');
        expect(record).not.toHaveBeenCalled();
    });

    it('resets every tab when a host registers and replays the panes', () => {
        const { h, host, record } = setup();
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        const next = attachFakeHost(h.service, 'next-shell');
        // The new host's view loads the stored URL, and the session has expired.
        next.emit('page-state', WEB_PANE, { url: 'https://example.com/login', status: 200 }, WEB_TAB);
        expect(record).toHaveBeenCalledTimes(1);
    });

    it('resets a pane whose views are rebuilt after a renderer died', () => {
        const { h, host, record } = setup();
        host.emit('view-focus', WEB_PANE, {}, WEB_TAB);
        h.service.rebuildPane(WEB_PANE);
        commit(host, 'https://rebuilt.test/redirected');
        expect(record).not.toHaveBeenCalled();
    });
});

describe('a late title', () => {
    it('is not written once the tab has gone private', () => {
        const { h, host } = setup();
        const title = vi.spyOn(h.service.history, 'updateTitle');
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true });
        host.emit('page-state', WEB_PANE, { title: 'Private Title' }, WEB_TAB);
        expect(title).not.toHaveBeenCalled();
    });

    it('is not written once an agent has taken the tab', () => {
        const { h, host } = setup();
        const title = vi.spyOn(h.service.history, 'updateTitle');
        typedNavigate(h, 'example.com');
        commit(host, 'https://example.com/');
        h.send({ command: 'web-exec', pane_id: WEB_PANE, script: 'document.title = "x"' });
        host.emit('page-state', WEB_PANE, { title: 'Agent Title' }, WEB_TAB);
        expect(title).not.toHaveBeenCalled();
    });
});

describe('tab bookkeeping', () => {
    it('still forgets a closed tab\'s loading state', () => {
        const tab = id('ffffffff', 1);
        const { h, host } = setup();
        h.send({ command: 'web-tab-new', pane_id: WEB_PANE, url: 'https://second.test/', gesture: true });
        host.emit('nav-state', WEB_PANE, { loading: true }, tab);
        expect(h.service.navState(WEB_PANE, tab)).not.toBeNull();
        h.reply({ command: 'web-tab-close', pane_id: WEB_PANE, tab });
        expect(h.service.navState(WEB_PANE, tab)).toBeNull();
    });
});
