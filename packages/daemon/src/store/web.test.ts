/**
 * The web-pane sidecar reducers (store/reducers/web.ts).
 *
 * Spec: docs/current/web-pane.md §4.2/§4.4 (navigate, URL/title mirroring), §5 (tabs),
 * §6 (private), §17 (the activeTab fallback and the duplicate-id rule).
 */

import { describe, expect, it } from 'vitest';

import { createStore, emptyDaemonState, type NexStore } from './index.js';
import { resolvedActiveTab, tabDisplayLabel } from './reducers/web.js';

const HOME = '/Users/test';
const NOW = 1_755_500_000_000;
const WORKSPACE = 'AAAAAAAA-0000-4000-8000-000000000001';
const SHELL = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE = 'EEEEEEEE-0000-4000-8000-000000000001';
const TAB1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const TAB2 = 'CCCCCCCC-0000-4000-8000-000000000002';
const TAB3 = 'CCCCCCCC-0000-4000-8000-000000000003';

function harness(): NexStore {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: WORKSPACE,
        paneID: SHELL,
        name: 'w1',
        color: 'blue',
        now: NOW
    });
    store.dispatch({
        type: 'open-web-pane',
        workspaceID: WORKSPACE,
        paneID: PANE,
        tabID: TAB1,
        url: 'example.com',
        now: NOW
    });
    return store;
}

function web(store: NexStore) {
    const sidecar = store.getState().workspaces[0]?.webPanes[PANE];
    if (sidecar === undefined) throw new Error('missing sidecar');
    return sidecar;
}

function paneTitle(store: NexStore): string {
    return store.getState().workspaces[0]?.panes.find((pane) => pane.id === PANE)?.title ?? '';
}

describe('display label (§2)', () => {
    it('prefers the title, then the host, then the url', () => {
        expect(tabDisplayLabel({ id: TAB1, url: 'https://example.com/x', title: 'Example' })).toBe(
            'Example'
        );
        expect(tabDisplayLabel({ id: TAB1, url: 'https://example.com/x', title: '' })).toBe(
            'example.com'
        );
        expect(tabDisplayLabel({ id: TAB1, url: 'not a url', title: '' })).toBe('not a url');
        expect(tabDisplayLabel({ id: TAB1, url: '', title: '' })).toBe('New Tab');
    });
});

describe('tab open', () => {
    it('appends a normalized tab and activates it by default', () => {
        const store = harness();
        store.dispatch({
            type: 'web-tab-open',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB2,
            url: 'localhost:3000'
        });
        expect(web(store).tabs).toEqual([
            { id: TAB1, url: 'https://example.com', title: '' },
            { id: TAB2, url: 'http://localhost:3000', title: '' }
        ]);
        expect(web(store).activeTabID).toBe(TAB2);
        expect(paneTitle(store)).toBe('localhost');
    });

    it('honours makeActive:false and rejects a duplicate id (§17.1)', () => {
        const store = harness();
        store.dispatch({
            type: 'web-tab-open',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB2,
            url: 'b.test',
            makeActive: false
        });
        expect(web(store).activeTabID).toBe(TAB1);
        store.dispatch({
            type: 'web-tab-open',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB2,
            url: 'c.test'
        });
        expect(web(store).tabs).toHaveLength(2);
    });

    it('ignores a pane that is not a web pane', () => {
        const store = harness();
        const before = store.getState();
        store.dispatch({
            type: 'web-tab-open',
            workspaceID: WORKSPACE,
            paneID: SHELL,
            tabID: TAB2,
            url: 'b.test'
        });
        expect(store.getState()).toBe(before);
    });
});

describe('tab close + select', () => {
    it('activates the left neighbour and syncs the header', () => {
        const store = harness();
        for (const [tabID, url] of [
            [TAB2, 'b.test'],
            [TAB3, 'c.test']
        ] as const) {
            store.dispatch({ type: 'web-tab-open', workspaceID: WORKSPACE, paneID: PANE, tabID, url });
        }
        expect(web(store).activeTabID).toBe(TAB3);

        store.dispatch({ type: 'web-tab-close', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB3 });
        expect(web(store).tabs.map((tab) => tab.id)).toEqual([TAB1, TAB2]);
        expect(web(store).activeTabID).toBe(TAB2);
        expect(paneTitle(store)).toBe('b.test');
    });

    it('refuses to close the last tab', () => {
        const store = harness();
        const before = store.getState();
        store.dispatch({ type: 'web-tab-close', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB1 });
        expect(store.getState()).toBe(before);
    });

    it('closing a background tab leaves the active one alone', () => {
        const store = harness();
        store.dispatch({
            type: 'web-tab-open',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB2,
            url: 'b.test'
        });
        store.dispatch({ type: 'web-tab-close', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB1 });
        expect(web(store).activeTabID).toBe(TAB2);
    });

    it('select is a no-op for an unknown or already-active tab', () => {
        const store = harness();
        const before = store.getState();
        store.dispatch({ type: 'web-tab-select', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB1 });
        expect(store.getState()).toBe(before);
        store.dispatch({ type: 'web-tab-select', workspaceID: WORKSPACE, paneID: PANE, tabID: TAB3 });
        expect(store.getState()).toBe(before);
    });
});

describe('navigate + mirroring', () => {
    it('writes the normalized URL onto the active tab', () => {
        const store = harness();
        store.dispatch({
            type: 'web-navigate',
            workspaceID: WORKSPACE,
            paneID: PANE,
            url: 'other.test/x'
        });
        expect(web(store).tabs[0]?.url).toBe('https://other.test/x');
    });

    it('keeps a placeholder URL from wiping the real one, but always takes the title', () => {
        const store = harness();
        store.dispatch({
            type: 'web-tab-state',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB1,
            url: 'https://example.com/deep',
            title: 'Deep'
        });
        expect(web(store).tabs[0]).toEqual({
            id: TAB1,
            url: 'https://example.com/deep',
            title: 'Deep'
        });

        for (const url of ['', 'about:blank']) {
            store.dispatch({
                type: 'web-tab-state',
                workspaceID: WORKSPACE,
                paneID: PANE,
                tabID: TAB1,
                url,
                title: 'Loading'
            });
        }
        expect(web(store).tabs[0]?.url).toBe('https://example.com/deep');
        expect(web(store).tabs[0]?.title).toBe('Loading');
    });

    it('drops a state change for a tab this pane does not have', () => {
        const store = harness();
        const before = store.getState();
        store.dispatch({
            type: 'web-tab-state',
            workspaceID: WORKSPACE,
            paneID: PANE,
            tabID: TAB3,
            url: 'https://nope.test'
        });
        expect(store.getState()).toBe(before);
    });
});

describe('private flag (§6)', () => {
    it('flips once and is idempotent', () => {
        const store = harness();
        store.dispatch({
            type: 'web-set-private',
            workspaceID: WORKSPACE,
            paneID: PANE,
            isPrivate: true
        });
        expect(web(store).isPrivate).toBe(true);
        const after = store.getState();
        store.dispatch({
            type: 'web-set-private',
            workspaceID: WORKSPACE,
            paneID: PANE,
            isPrivate: true
        });
        expect(store.getState()).toBe(after);
    });
});

describe('active tab resolution (§17.2)', () => {
    it('falls back to the first tab when activeTabID is stale', () => {
        expect(
            resolvedActiveTab({
                tabs: [{ id: TAB1, url: 'https://a.test', title: '' }],
                activeTabID: 'GONE',
                isPrivate: false
            })?.id
        ).toBe(TAB1);
        expect(resolvedActiveTab({ tabs: [], activeTabID: null, isPrivate: false })).toBeNull();
    });
});
