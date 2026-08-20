/**
 * Find-in-page, daemon half (WEB-059…WEB-065).
 *
 * The page-side marking is proven by the live smoke against a real engine; what is checkable
 * here is the part that broke in the Swift app and had to be fixed there: **which tab a count
 * belongs to**, and **when a remembered needle is re-applied**.
 */

import { describe, expect, it } from 'vitest';

import { createWebFindState, findCountsOf, isFindAction } from './find.js';
import { attachFakeHost, id, webHarness, WEB_PANE, WEB_TAB } from './testing.js';
import { webPaneGuiCommand } from '../ws/web-ui.js';

const SECOND_TAB = id('cccccccc', 2);

describe('the needle memory', () => {
    it('remembers a search per pane and forgets an empty one', () => {
        const state = createWebFindState();
        state.remember('pane', 'tab', 'hello');
        expect(state.sessionOf('pane')).toEqual({ tabID: 'tab', needle: 'hello' });
        // An emptied field is a closed find as far as later navigations are concerned.
        state.remember('pane', 'tab', '');
        expect(state.sessionOf('pane')).toBeNull();
    });

    it('forgets a pane that went away', () => {
        const state = createWebFindState();
        state.remember('pane', 'tab', 'hello');
        state.disposePane('pane');
        expect(state.sessionOf('pane')).toBeNull();
    });

    it('defaults a malformed envelope to "no matches", never to match 0 of 0', () => {
        expect(findCountsOf({})).toEqual({ total: 0, current: -1 });
        expect(findCountsOf({ total: 3, current: 1 })).toEqual({ total: 3, current: 1 });
    });

    it('only accepts the four actions the page implements', () => {
        for (const action of ['search', 'next', 'prev', 'clear']) expect(isFindAction(action)).toBe(true);
        expect(isFindAction('replace')).toBe(false);
    });
});

describe('web-find', () => {
    it('drives the host and answers with the tab the count was measured on', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        const pending = webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, {
            tab_id: WEB_TAB,
            action: 'search',
            needle: 'fixture'
        });
        const call = host.answer({ ok: true, total: 3, current: 0 }, 'find');
        expect(call.args).toMatchObject({ paneID: WEB_PANE, tabID: WEB_TAB, action: 'search', needle: 'fixture' });
        await expect(pending).resolves.toMatchObject({
            ok: true,
            total: 3,
            current: 0,
            tab_id: WEB_TAB,
            pane_id: WEB_PANE
        });
        // The needle is now remembered, which is what makes WEB-065 possible.
        expect(harness.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: WEB_TAB, needle: 'fixture' });
    });

    it('forgets the needle on clear, so later navigations stop re-marking (WEB-065)', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        const search = webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, {
            tab_id: WEB_TAB,
            action: 'search',
            needle: 'fixture'
        });
        host.answer({ ok: true, total: 1, current: 0 }, 'find');
        await search;

        const clear = webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, {
            tab_id: WEB_TAB,
            action: 'clear'
        });
        host.answer({ ok: true, total: 0, current: -1 }, 'find');
        await clear;
        expect(harness.service.find.sessionOf(WEB_PANE)).toBeNull();

        // A completed navigation now re-marks nothing.
        const before = host.calls.length;
        host.emit('page-state', WEB_PANE, { url: 'https://example.com/next' }, WEB_TAB);
        expect(host.calls.length).toBe(before);
    });

    it('re-applies the remembered needle when a navigation completes (WEB-065)', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        const search = webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, {
            tab_id: WEB_TAB,
            action: 'search',
            needle: 'fixture'
        });
        host.answer({ ok: true, total: 2, current: 0 }, 'find');
        await search;

        host.emit('page-state', WEB_PANE, { url: 'https://example.com/next' }, WEB_TAB);
        const reapplied = host.calls.filter((call) => call.verb === 'find').at(-1);
        expect(reapplied?.args).toMatchObject({ tabID: WEB_TAB, action: 'search', needle: 'fixture' });
    });

    it('clears the outgoing tab and re-runs on the incoming one when tabs switch (WEB-064)', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        const search = webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, {
            tab_id: WEB_TAB,
            action: 'search',
            needle: 'fixture'
        });
        host.answer({ ok: true, total: 2, current: 0 }, 'find');
        await search;

        harness.service.retargetFind(WEB_PANE, SECOND_TAB);
        const finds = host.calls.filter((call) => call.verb === 'find');
        expect(finds.at(-2)?.args).toMatchObject({ tabID: WEB_TAB, action: 'clear' });
        expect(finds.at(-1)?.args).toMatchObject({ tabID: SECOND_TAB, action: 'search', needle: 'fixture' });
        expect(harness.service.find.sessionOf(WEB_PANE)?.tabID).toBe(SECOND_TAB);
    });

    it('does nothing on a tab switch when no find is open', () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        harness.service.retargetFind(WEB_PANE, SECOND_TAB);
        expect(host.calls.filter((call) => call.verb === 'find')).toHaveLength(0);
    });

    it('rejects an unknown action before the host is bothered', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        await expect(
            webPaneGuiCommand(harness.service, harness.store, 'web-find', WEB_PANE, { tab_id: WEB_TAB, action: 'replace' })
        ).resolves.toMatchObject({ ok: false });
        expect(host.calls.filter((call) => call.verb === 'find')).toHaveLength(0);
    });
});

describe('web-zoom', () => {
    it('turns the three directions into the Swift layer’s ±0.1 / reset', async () => {
        const harness = webHarness();
        const host = attachFakeHost(harness.service);
        for (const [direction, expected] of [
            ['in', { delta: 0.1 }],
            ['out', { delta: -0.1 }],
            ['reset', { reset: true }]
        ] as const) {
            const pending = webPaneGuiCommand(harness.service, harness.store, 'web-zoom', WEB_PANE, {
                tab_id: WEB_TAB,
                direction
            });
            const call = host.answer({ ok: true, zoom: 1.1 }, 'zoom');
            expect(call.args).toMatchObject({ paneID: WEB_PANE, tabID: WEB_TAB, ...expected });
            await expect(pending).resolves.toMatchObject({ ok: true, zoom: 1.1, tab_id: WEB_TAB });
        }
    });
});
