import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginObject, type JsonObject } from '@kelpi/protocol';
import { PluginBrowser } from './browser.js';
import { attachFakeHost, flush, id, NOW, SHELL_PANE, WEB_PANE, WEB_TAB, webHarness, WORKSPACE } from '../webpane/testing.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const stop of cleanups.splice(0).reverse()) stop(); });
function harness() {
    const h = webHarness(), emit = vi.fn(), changed = vi.fn();
    const browser = new PluginBrowser(h.store, h.service, emit, changed);
    cleanups.push(() => { browser.close(); h.service.close(); });
    const context = { daemonID: 'owning-daemon', paneID: WEB_PANE };
    const call = (method: string, args: JsonObject = {}, signal?: AbortSignal) => browser.call(method, args, context, signal);
    const get = () => call('get');
    return { ...h, browser, emit, changed, call, get };
}

describe('native browser plugin contracts', () => {
    it('answers headlessly and shares tabs/private/favourites with the native command route', async () => {
        const h = harness();
        expect(await h.get()).toMatchObject({ paneID: WEB_PANE, workspaceID: WORKSPACE, activeTabID: WEB_TAB, isPrivate: false,
            host: { available: false, id: null, name: null, windowID: null }, tabs: [{ id: WEB_TAB, url: 'https://example.com', live: true, loading: false }] });
        const next = pluginObject(await h.call('tabs.open', { url: 'example.org', makeActive: false }));
        expect(h.reply({ command: 'web-tabs', target: WEB_PANE })).toMatchObject({ tabs: [expect.objectContaining({ id: WEB_TAB, active: true }), expect.objectContaining({ id: String(next['tab_id']), url: 'https://example.org', active: false })] });
        await h.call('setPrivate', { isPrivate: true });
        expect(h.state().workspaces[0]?.webPanes[WEB_PANE]?.isPrivate).toBe(true);
        await h.call('favourites.toggle', { url: 'https://example.com', title: 'Example' });
        expect(h.service.favourites.list()).toHaveLength(1);
        expect(await h.get()).toMatchObject({ favourites: [{ title: 'Example', createdAt: expect.any(String) }] });
        expect(await h.call('url')).toMatchObject({ ok: true, tab_id: WEB_TAB, url: 'https://example.com' });
        expect(await h.call('back')).toMatchObject({ ok: false, error: 'no web pane host connected' });
        expect(await h.call('cookies.list')).toMatchObject({ ok: true, cookies: [], private: true });
    });

    it('starts with current host/loading/history and observes native changes without polling or replaying plugin commands', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        host.emit('nav-state', WEB_PANE, { loading: true, can_go_back: true }, WEB_TAB);
        const attached = pluginObject(h.browser.watch({ pluginID: 'sample.browser', lease: 'view-a' }, { paneID: WEB_PANE }));
        expect(attached['state']).toMatchObject({ host: { available: true, name: 'fake-shell' }, tabs: [{ loading: true, canGoBack: true, canGoForward: false }] });
        host.emit('nav-state', WEB_PANE, { loading: false, can_go_back: true, can_go_forward: true }, WEB_TAB);
        host.emit('page-state', WEB_PANE, { url: 'https://example.org', title: 'Changed' }, WEB_TAB);
        await flush();
        expect(h.emit.mock.calls.filter(([name]) => name === 'browser.changed')).toHaveLength(1);
        expect(h.emit).toHaveBeenCalledWith('browser.changed', { subscription: attached['subscription'], paneID: WEB_PANE }, 'sample.browser');
        expect(await h.get()).toMatchObject({ tabs: [{ title: 'Changed', loading: false, canGoForward: true }] });
        host.release(); await flush();
        expect(await h.get()).toMatchObject({ host: { available: false, id: null }, tabs: [{ loading: false, canGoBack: false }] });
        const registration = h.service.registerHost({ sendJson() {} }, { name: 'new shell', windowID: 'window-two' });
        await flush();
        expect(await h.get()).toMatchObject({ host: { available: true, id: registration.hostID, name: 'new shell', windowID: 'window-two' } });
        expect(h.changed).toHaveBeenCalledWith(null);
    });

    it('does not retain forged nav states and forgets navigation state after a private session rebuild', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        host.emit('nav-state', WEB_PANE, { loading: true }, 'missing-tab');
        expect(h.service.navState(WEB_PANE, 'missing-tab')).toBeNull();
        host.emit('nav-state', WEB_PANE, { can_go_back: true }, WEB_TAB);
        await h.call('setPrivate', { isPrivate: true });
        expect(await h.get()).toMatchObject({ tabs: [{ canGoBack: false }] });
    });

    it('pins an exact background tab for navigation, including about:blank, without changing the active tab', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const opened = pluginObject(await h.call('tabs.open', { url: 'https://other.example', makeActive: true })), second = String(opened['tab_id']);
        const pending = h.call('navigate', { tabID: WEB_TAB, url: 'about:blank' });
        expect(host.calls.at(-1)?.args).toEqual({ paneID: WEB_PANE, tabID: WEB_TAB, url: 'about:blank' });
        expect(await h.get()).toMatchObject({ activeTabID: second, tabs: [{ id: WEB_TAB, url: 'about:blank' }, { id: second }] });
        host.answer({ ok: true }, 'navigate');
        expect(await pending).toMatchObject({ ok: true, tab_id: WEB_TAB });
    });

    it('a slow captured-tab read survives ordinary active-tab switches and unrelated tab closes', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const second = String(pluginObject(await h.call('tabs.open', { url: 'https://other.example' }))['tab_id']);
        const pending = h.call('exec', { tabID: WEB_TAB, script: '({keep_this_key: 7})' });
        await h.call('tabs.close', { tabID: second });
        host.answer({ ok: true, result: { keep_this_key: 7 } }, 'exec');
        expect(await pending).toMatchObject({ tab_id: WEB_TAB, result: { keep_this_key: 7 } });
    });

    it.each(['private round trip', 'rebuild', 'close and reopen same tab id', 'park and restore'] as const)('rejects a late page result after %s', async reason => {
        const h = harness(), host = attachFakeHost(h.service);
        await h.call('tabs.open', { url: 'https://second.example', makeActive: false });
        const pending = h.call('capture', { mode: 'text', tabID: WEB_TAB });
        const rejected = expect(pending).rejects.toThrow(/target changed|no longer available/);
        if (reason === 'private round trip') { await h.call('setPrivate', { isPrivate: true }); await h.call('setPrivate', { isPrivate: false }); }
        else if (reason === 'rebuild') h.service.rebuildPane(WEB_PANE);
        else if (reason === 'close and reopen same tab id') {
            await h.call('tabs.close', { tabID: WEB_TAB });
            h.store.dispatch({ type: 'web-tab-open', workspaceID: WORKSPACE, paneID: WEB_PANE, tabID: WEB_TAB, url: 'https://reused.example' });
        } else {
            h.store.dispatch({ type: 'park-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
            h.store.dispatch({ type: 'unpark-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        }
        host.answer({ ok: true, text: 'stale private or destroyed page' }, 'capture'); await rejected;
    });

    it('host takeover fails the old RPC and its late reply cannot settle the new host operation', async () => {
        const h = harness(), old = attachFakeHost(h.service);
        const pending = h.call('exec', { script: 'location.href' });
        const rejected = expect(pending).rejects.toThrow('target changed');
        const current = attachFakeHost(h.service, 'new shell'); await rejected;
        const next = h.call('exec', { script: 'location.href' });
        old.answer({ ok: true, result: 'old' }, 'exec');
        expect(h.service.host.pending).toBe(1);
        current.answer({ ok: true, result: 'new' }, 'exec');
        expect(await next).toMatchObject({ result: 'new' });
    });

    it('aborts only the caller host wait and ignores its late response', async () => {
        const h = harness(), host = attachFakeHost(h.service), cancelled = new AbortController();
        const first = h.call('exec', { script: 'first()' }, cancelled.signal), second = h.call('capture', { mode: 'text' });
        const rejected = expect(first).rejects.toThrow('cancelled');
        cancelled.abort(); await rejected;
        expect(h.service.host.pending).toBe(1);
        host.answer({ ok: true, result: 'late' }, 'exec');
        host.answer({ ok: true, text: 'healthy' }, 'capture');
        expect(await second).toMatchObject({ text: 'healthy' });
        expect(h.service.host.pending).toBe(0);
    });

    it('bounds captures and preserves arbitrary payload keys', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const large = h.call('capture', { mode: 'text' });
        host.answer({ ok: true, text: 'x'.repeat(256 * 1024) }, 'capture');
        await expect(large).rejects.toThrow('256 KiB');
        const small = h.call('exec', { script: '({some_key:1})' });
        host.answer({ ok: true, result: { some_key: 1, inner: { kebab: 'value' } } }, 'exec');
        expect(await small).toMatchObject({ result: { some_key: 1 } });
    });

    it('rejects ambiguous arguments before changing native state or calling the host', async () => {
        const h = harness(), host = attachFakeHost(h.service), before = h.state();
        for (const [method, args] of [
            ['tabs.reorder', { order: [] }], ['tabs.select', {}], ['setPrivate', { isPrivate: 'yes' }], ['navigate', { url: 'a', target: 'another' }],
            ['find', { tabID: WEB_TAB, action: 'invalid' }], ['cookies.clear', { all: true, domain: 'example.com' }], ['capture', { mode: 'image' }],
            ['zoom', { direction: 0 }], ['favourites.toggle', { url: '' }], ['console', { since: -1 }],
            ['find', { action: 'search' }], ['zoom', { direction: 'in' }]
        ] as const) await expect(h.call(method, args as JsonObject)).rejects.toThrow();
        expect(host.calls).toHaveLength(0); expect(h.state()).toBe(before); expect(h.service.favourites.list()).toEqual([]);
        await expect(h.call('tabs.close', { tabID: WEB_TAB })).rejects.toThrow('last browser tab');
    });

    it('keeps shared favourites watchers current and rejects another lease unwatching them', async () => {
        const h = harness(), owner = { pluginID: 'sample.browser', lease: 'view-a' };
        const watched = pluginObject(h.browser.watch(owner, { paneID: WEB_PANE }));
        h.browser.unwatch({ ...owner, lease: 'view-b' }, watched['subscription']);
        h.service.favourites.toggle('https://saved.example', 'Saved'); await flush();
        expect(h.emit).toHaveBeenCalledWith('browser.changed', expect.objectContaining({ subscription: String(watched['subscription']) }), owner.pluginID);
        h.emit.mockClear(); h.browser.unwatch(owner, watched['subscription']);
        h.service.favourites.toggle('https://another.example', 'Other'); await flush(); expect(h.emit).not.toHaveBeenCalled();
    });

    it('bounds subscriptions, disposes leases independently, and refuses an oversized initial snapshot without leaking slots', async () => {
        const h = harness();
        for (let index = 0; index < 128; index++) h.browser.watch({ pluginID: 'sample.browser', lease: `view-${index % 2}` }, { paneID: WEB_PANE });
        expect(() => h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE })).toThrow('Too many');
        h.browser.release(owner => owner.lease === 'view-0');
        for (let index = 0; index < 64; index++) h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
        expect(() => h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE })).toThrow('Too many');
        h.browser.release(() => true);
        h.service.favourites.toggle('https://oversized.example', 'x'.repeat(256 * 1024));
        expect(() => h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE })).toThrow('256 KiB');
        h.service.favourites.toggle('https://oversized.example', '');
        for (let index = 0; index < 128; index++) h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
    });

    it('closes watches on park and pane reuse but keeps the native process/session independent of release', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const watched = pluginObject(h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE }));
        h.browser.release(() => true);
        expect(host.notifies.filter(row => row.verb === 'pane-close')).toHaveLength(0);
        h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
        h.store.dispatch({ type: 'park-pane', workspaceID: WORKSPACE, paneID: WEB_PANE });
        await flush();
        expect(h.emit).toHaveBeenCalledWith('browser.closed', expect.objectContaining({ paneID: WEB_PANE }), 'sample.browser');
        expect(h.emit.mock.calls.some(([, data]) => data.subscription === watched['subscription'])).toBe(false);
    });

    it('keeps find requests scoped and refuses an old tab clear overwriting a newer search', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const first = h.call('find', { tabID: WEB_TAB, action: 'clear' });
        const next = h.call('find', { tabID: WEB_TAB, action: 'search', needle: 'new needle' });
        const calls = host.calls.filter(call => call.verb === 'find');
        host.answerRaw(calls[1]!.id, { ok: true, total: 2, current: 0 });
        expect(await next).toMatchObject({ ok: true, total: 2, tab_id: WEB_TAB });
        host.answerRaw(calls[0]!.id, { ok: true, total: 0, current: -1 });
        expect(await first).toMatchObject({ ok: false, error: 'browser find target changed' });
        expect(h.service.find.sessionOf(WEB_PANE)).toEqual({ tabID: WEB_TAB, needle: 'new needle' });
    });

    it('does not arm an inspector after its captured tab/private session has been replaced', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const pending = h.call('inspect', { tabID: WEB_TAB, sendTo: SHELL_PANE });
        const rejected = expect(pending).rejects.toThrow('target changed');
        await h.call('setPrivate', { isPrivate: true });
        host.answer({ ok: true }, 'inspect-arm'); await rejected;
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
    });

    it('does not overwrite a newer native inspector arm while an old plugin call awaits acknowledgment', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const pending = h.call('inspect', {}), rejected = expect(pending).rejects.toThrow('inspector target changed');
        const newer = { paneID: WEB_PANE, tabID: WEB_TAB, nonce: 'new-native-arm', sendTo: null, submit: false };
        h.service.inspect.arm(newer); host.answer({ ok: true }, 'inspect-arm'); await rejected;
        expect(h.service.inspect.armOf(WEB_PANE)).toEqual(newer);
    });

    it('keeps batch and cookie calls on native session state and clears failed batch activation', async () => {
        const h = harness();
        expect(await h.call('batch.toggle')).toMatchObject({ ok: false, batch: null });
        expect(h.service.batch.sessionOf(WEB_PANE)).toBeNull();
        const host = attachFakeHost(h.service), pending = h.call('batch.toggle');
        host.answer({ ok: true }, 'inspect-arm');
        expect(await pending).toMatchObject({ ok: true, armed: true, batch: { visible: true } });
        expect(h.service.inspect.armOf(WEB_PANE)?.tabID).toBe(WEB_TAB);
        expect(await h.call('batch.toggle')).toMatchObject({ armed: false, batch: { visible: false } });
        expect(h.service.inspect.armOf(WEB_PANE)).toBeNull();
        const write = h.call('cookies.set', { cookie: { name: 'session', value: 'x', is_http_only: true } });
        expect(host.calls.at(-1)?.args).toMatchObject({ paneID: WEB_PANE, cookie: { is_http_only: true } });
        host.answer({ ok: true, written: 1 }, 'cookies-set'); expect(await write).toMatchObject({ written: 1 });
        await h.call('batch.cancel'); expect(h.service.batch.sessionOf(WEB_PANE)).toBeNull();
    });

    it('recovers a dead native tab through the existing rebuild path and retains its id', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        h.store.dispatch({ type: 'web-tab-live', workspaceID: WORKSPACE, paneID: WEB_PANE, tabID: WEB_TAB, live: false });
        expect(await h.call('reload')).toMatchObject({ ok: true, rebuilt: true, tab_id: WEB_TAB });
        expect(host.notifies.at(-1)).toMatchObject({ verb: 'pane-open', args: { paneID: WEB_PANE, tabs: [{ id: WEB_TAB }] } });
        expect(await h.get()).toMatchObject({ tabs: [{ id: WEB_TAB, live: true }] });
    });

    it('a moved browser keeps its watch and uses the new workspace without restarting its session', async () => {
        const h = harness(), other = id('aaaaaaaa', 2), shell = id('dddddddd', 2), host = attachFakeHost(h.service);
        const watched = pluginObject(h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE }));
        h.store.dispatch({ type: 'create-workspace', id: other, paneID: shell, name: 'Other', color: 'blue', now: NOW });
        h.store.dispatch({ type: 'move-pane-to-workspace', paneID: WEB_PANE, toWorkspaceID: other });
        await flush();
        expect(await h.get()).toMatchObject({ workspaceID: other });
        expect(h.emit).toHaveBeenCalledWith('browser.changed', { subscription: watched['subscription'], paneID: WEB_PANE }, 'sample.browser');
        expect(host.notifies.filter(row => row.verb === 'pane-close')).toHaveLength(0);
    });

    it('invalidates a browser watch for native batch picks, same-count comments, focus, removal and cancellation', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        const watched = pluginObject(h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE }));
        h.service.batch.start(WEB_PANE);
        const armed = h.service.armBatch(WEB_PANE);
        host.answer({ ok: true }, 'inspect-arm'); await armed; await flush();
        const initial = pluginObject(pluginObject(await h.get())['inspection']);
        expect(initial).toMatchObject({ armed: true, tabID: WEB_TAB, batchVisible: true, batchItems: 0 });
        h.emit.mockClear();
        const nonce = h.service.inspect.armOf(WEB_PANE)!.nonce;
        host.emit('inspect', WEB_PANE, { nonce, selector: '#pick', tag: 'button', text: 'Pick me', url: 'https://example.com' }, WEB_TAB);
        await flush();
        const picked = pluginObject(pluginObject(await h.get())['inspection']);
        expect(picked).toMatchObject({ armed: true, batchItems: 1, batchFocusedID: expect.any(String) });
        expect(Number(picked['revision'])).toBeGreaterThan(Number(initial['revision']));
        expect(h.emit).toHaveBeenCalledWith('browser.changed', { subscription: watched['subscription'], paneID: WEB_PANE }, 'sample.browser');
        const itemID = String(picked['batchFocusedID']);
        h.emit.mockClear();
        host.emit('batch-marker', WEB_PANE, { commentChanged: { id: itemID, comment: 'Native page edit' } }, WEB_TAB);
        await flush();
        const commented = pluginObject(pluginObject(await h.get())['inspection']);
        expect(commented).toMatchObject({ batchItems: 1, batchFocusedID: itemID });
        expect(Number(commented['revision'])).toBeGreaterThan(Number(picked['revision']));
        expect(await h.call('batch.state')).toMatchObject({ batch: { items: [{ id: itemID, comment: 'Native page edit' }] } });
        expect(h.emit).toHaveBeenCalledTimes(1);
        host.emit('batch-marker', WEB_PANE, { dismiss: {} }, WEB_TAB); await flush();
        expect(await h.get()).toMatchObject({ inspection: { batchFocusedID: null } });
        host.emit('batch-marker', WEB_PANE, { remove: { id: itemID } }, WEB_TAB); await flush();
        expect(await h.get()).toMatchObject({ inspection: { batchItems: 0, batchVisible: true } });
        host.emit('inspect', WEB_PANE, { nonce, cancelled: true }, WEB_TAB); await flush();
        expect(await h.get()).toMatchObject({ inspection: { armed: false, batchVisible: false, batchItems: 0 } });
    });

    it('invalidates native single-shot inspection results and clear without leaking picker nonces or captured DOM into snapshots', async () => {
        const h = harness(), host = attachFakeHost(h.service);
        h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
        h.send({ command: 'web-inspect', pane_id: WEB_PANE });
        host.answer({ ok: true }, 'inspect-arm'); await flush();
        expect(await h.get()).toMatchObject({ inspection: { armed: true, pendingResults: 0 } });
        h.emit.mockClear();
        const nonce = h.service.inspect.armOf(WEB_PANE)!.nonce;
        host.emit('inspect', WEB_PANE, { nonce: 'wrong', selector: '#ignored' }, WEB_TAB); await flush();
        expect(h.emit).not.toHaveBeenCalled();
        host.emit('inspect', WEB_PANE, { nonce, selector: '#private', tag: 'div', outerHTML: '<div>captured page payload</div>' }, WEB_TAB); await flush();
        const snapshot = await h.get();
        expect(snapshot).toMatchObject({ inspection: { armed: false, pendingResults: 1 } });
        expect(JSON.stringify(snapshot)).not.toContain(nonce);
        expect(JSON.stringify(snapshot)).not.toContain('captured page payload');
        expect(h.emit).toHaveBeenCalledTimes(1);
        const revision = Number(pluginObject(pluginObject(snapshot)['inspection'])['revision']);
        h.reply({ command: 'web-inspect-result', pane_id: WEB_PANE, clear: true }); await flush();
        const cleared = pluginObject(pluginObject(await h.get())['inspection']);
        expect(cleared['pendingResults']).toBe(0);
        expect(Number(cleared['revision'])).toBeGreaterThan(revision);
        expect(h.emit).toHaveBeenCalledTimes(2);
    });

    it('keeps inspection metadata bounded when queued native payloads exceed the plugin result limit', async () => {
        const h = harness();
        h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
        for (let index = 0; index < 32; index++) h.service.inspect.enqueue(WEB_PANE, {
            tabID: WEB_TAB, selector: `#row-${index}`, xpath: '', tag: 'div', elementID: '', outerHTML: 'x'.repeat(16 * 1024),
            attributes: {}, rect: { x: 0, y: 0, w: 1, h: 1 }, text: '', contextHTML: '', url: 'https://example.com', capturedAt: NOW, comment: ''
        });
        await flush();
        const snapshot = await h.get();
        expect(snapshot).toMatchObject({ inspection: { pendingResults: 32 } });
        expect(JSON.stringify(snapshot).length).toBeLessThan(2048);
        expect(h.emit).toHaveBeenCalledTimes(1);
        await expect(h.call('inspectResult')).rejects.toThrow('256 KiB');
        expect(h.service.inspect.queued(WEB_PANE)).toHaveLength(32);
        h.service.inspect.clearQueue(WEB_PANE); await flush();
        expect(await h.get()).toMatchObject({ inspection: { pendingResults: 0 } });
        expect(h.emit).toHaveBeenCalledTimes(2);
    });

    it.each(['private session', 'host replacement', 'host disconnect', 'renderer rebuild'] as const)('disarms obsolete picker nonces on %s while retaining collected batch items', async change => {
        const h = harness(), host = attachFakeHost(h.service);
        h.browser.watch({ pluginID: 'sample.browser' }, { paneID: WEB_PANE });
        const armed = h.call('batch.toggle'); host.answer({ ok: true }, 'inspect-arm'); await armed;
        const nonce = h.service.inspect.armOf(WEB_PANE)!.nonce;
        host.emit('inspect', WEB_PANE, { nonce, selector: '#collected', tag: 'button', text: 'Collected' }, WEB_TAB); await flush();
        expect(h.service.batch.sessionOf(WEB_PANE)?.items).toHaveLength(1);
        h.emit.mockClear();
        if (change === 'private session') await h.call('setPrivate', { isPrivate: true });
        else if (change === 'host replacement') attachFakeHost(h.service, 'new shell');
        else if (change === 'host disconnect') host.release();
        else h.service.rebuildPane(WEB_PANE);
        await flush();
        expect(await h.get()).toMatchObject({ inspection: { armed: false, tabID: null, batchVisible: true, batchItems: 1 } });
        expect(h.emit).toHaveBeenCalledTimes(1);
        h.service.handleHostEvent({ event: 'inspect', paneID: WEB_PANE, tabID: WEB_TAB, payload: { nonce, selector: '#obsolete', tag: 'button' } });
        expect(h.service.batch.sessionOf(WEB_PANE)?.items).toHaveLength(1);
    });
});
