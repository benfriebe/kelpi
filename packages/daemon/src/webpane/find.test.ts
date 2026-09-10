/**
 * Find-in-page, daemon half (WEB-059…WEB-065).
 *
 * The page-side marking is proven by the live smoke against a real engine; what is checkable
 * here is the part that broke in the Swift app and had to be fixed there: **which tab a count
 * belongs to**, and **when a remembered needle is re-applied**.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createWebFindState, findCountsOf, isFindAction, type WebFindAction } from './find.js';
import { attachFakeHost, id, webHarness, WEB_PANE, WEB_TAB, WORKSPACE } from './testing.js';
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

    describe('overlapping requests', () => {
        const cleanups: Array<() => void> = [];
        afterEach(() => { for (const close of cleanups.splice(0)) close(); });
        const fixture = () => {
            const h = webHarness(), host = attachFakeHost(h.service);
            cleanups.push(() => h.service.close());
            const drive = (action: WebFindAction, needle = '') => webPaneGuiCommand(h.service, h.store, 'web-find', WEB_PANE, {
                tab_id: WEB_TAB, action, needle
            });
            return { ...h, host, drive };
        };

        it.each([
            ['next', false], ['prev', false], ['next', true], ['prev', true]
        ] as const)('remembers a pending search after %s, with step replying first: %s', async (action, stepFirst) => {
            const h = fixture();
            h.service.find.remember(WEB_PANE, WEB_TAB, 'previous query');
            const search = h.drive('search', 'current query'), step = h.drive(action);
            const [searchCall, stepCall] = h.host.calls;
            const answerSearch = () => h.host.answerRaw(searchCall!.id, { ok: true, total: 5, current: 0 });
            const answerStep = () => h.host.answerRaw(stepCall!.id, { ok: true, total: 5, current: 1 });
            if (stepFirst) { answerStep(); await step; answerSearch(); }
            else { answerSearch(); await search; answerStep(); }
            // Only the newest count is useful, but the search still owns query memory.
            expect(await search).toMatchObject({ ok: false, tab_id: WEB_TAB });
            expect(await step).toMatchObject({ ok: true, total: 5, current: 1, tab_id: WEB_TAB });
            expect(h.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: WEB_TAB, needle: 'current query' });
            const before = h.host.calls.length;
            h.host.emit('page-state', WEB_PANE, { url: 'https://example.com/next' }, WEB_TAB);
            expect(h.host.calls.slice(before).map(call => call.args)).toEqual([
                { paneID: WEB_PANE, tabID: WEB_TAB, action: 'search', needle: 'current query' }
            ]);
        });

        it.each([
            ['search', 'search'], ['search', 'clear'], ['clear', 'search']
        ] as const)('keeps a late %s from overwriting a newer %s followed by next', async (older, newer) => {
            const h = fixture();
            h.service.find.remember(WEB_PANE, WEB_TAB, 'initial query');
            const first = h.drive(older, 'old query'), latest = h.drive(newer, 'new query'), step = h.drive('next');
            const [firstCall, latestCall, stepCall] = h.host.calls;
            h.host.answerRaw(latestCall!.id, { ok: true, total: 3, current: 0 }); await latest;
            h.host.answerRaw(stepCall!.id, { ok: true, total: 3, current: 1 }); await step;
            h.host.answerRaw(firstCall!.id, { ok: true, total: 0, current: -1 });
            expect(await first).toMatchObject({ ok: false, error: 'browser find target changed' });
            expect(h.service.find.sessionOf(WEB_PANE)).toEqual(newer === 'clear' ? null : { tabID: WEB_TAB, needle: 'new query' });
        });

        it('keeps a pending query when a later step is cancelled', async () => {
            const h = fixture(), cancelled = new AbortController();
            const search = h.drive('search', 'current query');
            const step = h.service.runFind(WEB_PANE, WEB_TAB, 'next', '', cancelled.signal);
            cancelled.abort();
            expect(await step).toMatchObject({ ok: false });
            expect(h.service.host.pending).toBe(1);
            h.host.answerRaw(h.host.calls[0]!.id, { ok: true, total: 2, current: 0 }); await search;
            h.host.answerRaw(h.host.calls[1]!.id, { ok: true, total: 2, current: 1 });
            expect(h.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: WEB_TAB, needle: 'current query' });
            expect(h.service.host.pending).toBe(0);
        });

        it('does not remember a cancelled search or cancel the following step', async () => {
            const h = fixture(), cancelled = new AbortController();
            h.service.find.remember(WEB_PANE, WEB_TAB, 'initial query');
            const search = h.service.runFind(WEB_PANE, WEB_TAB, 'search', 'cancelled query', cancelled.signal);
            const step = h.drive('next');
            cancelled.abort();
            expect(await search).toMatchObject({ ok: false });
            expect(h.service.host.pending).toBe(1);
            h.host.answerRaw(h.host.calls[1]!.id, { ok: true, total: 2, current: 1 });
            expect(await step).toMatchObject({ ok: true, current: 1 });
            h.host.answerRaw(h.host.calls[0]!.id, { ok: true, total: 2, current: 0 });
            expect(h.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: WEB_TAB, needle: 'initial query' });
            expect(h.service.host.pending).toBe(0);
        });

        it.each(['tab switch', 'private session', 'host replacement', 'park and restore'] as const)('invalidates both requests after %s without erasing a new query', async change => {
            const h = fixture();
            h.store.dispatch({ type: 'web-tab-open', workspaceID: WORKSPACE, paneID: WEB_PANE, tabID: SECOND_TAB, url: 'https://second.example', makeActive: false });
            const search = h.drive('search', 'old query'), step = h.drive('next');
            let currentHost = h.host, currentTab = WEB_TAB;
            if (change === 'tab switch') {
                h.reply({ command: 'web-tab-select', pane_id: WEB_PANE, tab: SECOND_TAB }); currentTab = SECOND_TAB;
            } else if (change === 'private session') h.reply({ command: 'web-private', pane_id: WEB_PANE, private: true });
            else if (change === 'host replacement') currentHost = attachFakeHost(h.service, 'new host');
            else {
                h.store.dispatch({ type: 'park-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
                h.store.dispatch({ type: 'unpark-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
            }
            const replacement = h.service.runFind(WEB_PANE, currentTab, 'search', 'new query');
            currentHost.answerRaw(currentHost.calls.at(-1)!.id, { ok: true, total: 4, current: 0 });
            expect(await replacement).toMatchObject({ ok: true });
            h.host.answerRaw(h.host.calls[0]!.id, { ok: true, total: 2, current: 0 });
            h.host.answerRaw(h.host.calls[1]!.id, { ok: true, total: 2, current: 1 });
            expect(await search).toMatchObject({ ok: false });
            expect(await step).toMatchObject({ ok: false });
            expect(h.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: currentTab, needle: 'new query' });
        });
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
