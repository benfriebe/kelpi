import { describe, expect, it, vi } from 'vitest';
import { createKelpiAPI, KelpiError, type BrowserSnapshot } from '../index.js';

describe('shared browser facade', () => {
    it('uses the owning context only for implicit get/watch and leaves daemon watches scoped', async () => {
        const state = { paneID: 'local', host: { windowID: 'host-window' } } as BrowserSnapshot;
        const transport = vi.fn(async (method: string) => method === 'browser.watch' ? { subscription: 'watch', state } : state);
        let paneID = 'local';
        const api = createKelpiAPI(transport, () => ({ paneID }));
        expect(await api.browser.get()).toBe(state);
        paneID = 'next';
        expect(await api.browser.watch()).toEqual({ subscription: 'watch', state });
        await api.browser.get('explicit'); await api.browser.unwatch('watch');
        expect(transport.mock.calls).toEqual([
            ['browser.get', { paneID: 'local' }], ['browser.watch', { paneID: 'next' }],
            ['browser.get', { paneID: 'explicit' }], ['browser.unwatch', { subscription: 'watch' }],
        ]);
        const backend = createKelpiAPI(transport);
        await backend.browser.get(); expect(transport).toHaveBeenLastCalledWith('browser.get', {});
        expect(api.browser).not.toHaveProperty('attach');
        expect(Object.isFrozen(api.browser)).toBe(true);
    });

    it('preserves explicit pane/tab targeting across navigation, find, reload, private and inspector actions', async () => {
        const transport = vi.fn(async () => ({ ok: true, pane_id: 'pane', tab_id: 'tab', workspace_id: 'space', can_go_back: true }));
        const { browser } = createKelpiAPI(transport, () => ({ paneID: 'different' }));
        expect(await browser.navigate('pane', 'http://fixture', { tabID: 'tab' })).toEqual({ paneID: 'pane', tabID: 'tab', workspaceID: 'space', canGoBack: true });
        await browser.back('pane'); await browser.forward('pane', { tabID: 'tab' });
        await browser.reload('pane', { tabID: 'tab', hard: true }); await browser.stop('pane');
        await browser.focus('pane'); await browser.blur('pane'); await browser.url('pane');
        await browser.toggleDevTools('pane', { tabID: 'tab' });
        await browser.setPrivate('pane', true);
        await browser.find('pane', 'tab', 'next', 'needle'); await browser.zoom('pane', 'tab', 'reset');
        await browser.inspect('pane', { tabID: 'tab', sendTo: 'shell', submit: true });
        await browser.capture('pane', { tabID: 'tab', mode: 'dom' });
        expect(transport.mock.calls).toEqual([
            ['browser.navigate', { paneID: 'pane', url: 'http://fixture', tabID: 'tab' }],
            ['browser.back', { paneID: 'pane' }], ['browser.forward', { paneID: 'pane', tabID: 'tab' }],
            ['browser.reload', { paneID: 'pane', tabID: 'tab', hard: true }], ['browser.stop', { paneID: 'pane' }],
            ['browser.focus', { paneID: 'pane' }], ['browser.blur', { paneID: 'pane' }], ['browser.url', { paneID: 'pane' }],
            ['browser.devtools', { paneID: 'pane', tabID: 'tab' }], ['browser.setPrivate', { paneID: 'pane', isPrivate: true }],
            ['browser.find', { paneID: 'pane', tabID: 'tab', action: 'next', needle: 'needle' }],
            ['browser.zoom', { paneID: 'pane', tabID: 'tab', direction: 'reset' }],
            ['browser.inspect', { paneID: 'pane', tabID: 'tab', sendTo: 'shell', submit: true }],
            ['browser.capture', { paneID: 'pane', tabID: 'tab', mode: 'dom' }],
        ]);
    });

    it('keeps tab creation options and exact reorder permutations without retaining mutable input', async () => {
        const transport = vi.fn(async () => ({ ok: true, pane_id: 'pane' }));
        const { browser } = createKelpiAPI(transport);
        await browser.tabs.open('pane'); await browser.tabs.open('pane', 'http://fixture', { makeActive: false });
        await browser.tabs.select('pane', 'second'); await browser.tabs.close('pane', 'first');
        const order = ['third', 'second']; const reordered = browser.tabs.reorder('pane', order); order.reverse(); await reordered;
        expect(transport.mock.calls).toEqual([
            ['browser.tabs.open', { paneID: 'pane', url: '' }],
            ['browser.tabs.open', { paneID: 'pane', url: 'http://fixture', makeActive: false }],
            ['browser.tabs.select', { paneID: 'pane', tabID: 'second' }], ['browser.tabs.close', { paneID: 'pane', tabID: 'first' }],
            ['browser.tabs.reorder', { paneID: 'pane', order: ['third', 'second'] }],
        ]);
    });

    it('normalizes native favourite, cookie and inspect DTOs without changing page-owned keys', async () => {
        const transport = vi.fn(async (method: string) => {
            if (method.startsWith('browser.favourites')) return { ok: true, favourites: [{ id: 'saved', created_at: '2026-09-10T00:00:00.000Z', url: 'http://fixture', title: 'Title', label: 'Title' }], added: true, favourite_id: 'saved' };
            if (method === 'browser.cookies.list') return { ok: true, cookies: [{ name: 'session', value: 'x', domain: 'fixture', is_http_only: true, is_secure: false }] };
            return { ok: true, results: [{ tab_id: 'tab', outer_html: '<button data_test="x">', tag: 'button', selector: '#button', url: 'http://fixture', attributes: { data_test: 'x', 'aria-label': 'Button' } }] };
        });
        const { browser } = createKelpiAPI(transport);
        expect(await browser.favourites.list()).toEqual([{ id: 'saved', createdAt: '2026-09-10T00:00:00.000Z', url: 'http://fixture', title: 'Title', label: 'Title' }]);
        expect(await browser.favourites.toggle('http://fixture', 'Title')).toMatchObject({ favouriteID: 'saved', added: true });
        await browser.favourites.rename('saved', 'New'); await browser.favourites.move(0, 1); await browser.favourites.remove('saved');
        expect(await browser.cookies.list('pane')).toEqual([{ name: 'session', value: 'x', domain: 'fixture', isHttpOnly: true, isSecure: false }]);
        expect(await browser.inspectResult('pane', { clear: true })).toEqual([{ tabID: 'tab', outerHtml: '<button data_test="x">', tag: 'button', selector: '#button', url: 'http://fixture', attributes: { data_test: 'x', 'aria-label': 'Button' } }]);
        expect(transport).toHaveBeenLastCalledWith('browser.inspectResult', { paneID: 'pane', clear: true });
    });

    it('keeps script text and evaluated JSON exact while normalizing the native envelope', async () => {
        const value = { snake_key: [{ also_snake: 42 }], attributes: { still_snake: true } };
        const script = '({ snake_key: window.fixture_value })';
        const transport = vi.fn(async () => ({ ok: true, pane_id: 'pane', tab_id: 'tab', result: value }));
        const { browser } = createKelpiAPI(transport);
        const result = await browser.exec('pane', script, { tabID: 'tab' });
        expect(result).toEqual({ paneID: 'pane', tabID: 'tab', result: value });
        expect(result.result).toBe(value);
        expect(transport).toHaveBeenCalledExactlyOnceWith('browser.exec', { paneID: 'pane', script, tabID: 'tab' });
    });

    it('encodes cookie mutations, console cursors and batch actions using their native options', async () => {
        const transport = vi.fn(async () => ({ ok: true, pane_id: 'pane' }));
        const { browser } = createKelpiAPI(transport);
        await browser.cookies.set('pane', { name: 'token', value: 'secret', domain: 'fixture', path: '/', isSecure: true, isHttpOnly: false }, { original: { name: 'old', domain: 'fixture' } });
        await browser.cookies.clear('pane', { domain: 'fixture' }); await browser.cookies.delete('pane', 'token', { domain: 'fixture' });
        await browser.console('pane', { since: 41, level: 'warn', clear: true });
        await browser.batch.state('pane'); await browser.batch.toggle('pane'); await browser.batch.cancel('pane');
        await browser.batch.remove('pane', 'item'); await browser.batch.comment('pane', 'item', 'Note', { tabID: 'tab' });
        await browser.batch.focus('pane', null, 'panel'); await browser.batch.send('pane', null);
        expect(transport.mock.calls).toEqual([
            ['browser.cookies.set', { paneID: 'pane', cookie: { name: 'token', value: 'secret', domain: 'fixture', path: '/', is_secure: true, is_http_only: false }, original: { name: 'old', domain: 'fixture' } }],
            ['browser.cookies.clear', { paneID: 'pane', domain: 'fixture' }], ['browser.cookies.delete', { paneID: 'pane', name: 'token', domain: 'fixture' }],
            ['browser.console', { paneID: 'pane', since: 41, level: 'warn', clear: true }],
            ['browser.batch.state', { paneID: 'pane' }], ['browser.batch.toggle', { paneID: 'pane' }], ['browser.batch.cancel', { paneID: 'pane' }],
            ['browser.batch.remove', { paneID: 'pane', itemID: 'item' }], ['browser.batch.comment', { paneID: 'pane', itemID: 'item', comment: 'Note', tabID: 'tab' }],
            ['browser.batch.focus', { paneID: 'pane', itemID: null, origin: 'panel' }], ['browser.batch.send', { paneID: 'pane', sendTo: null }],
        ]);
    });

    it('retains native refusals and rejects malformed command/list replies', async () => {
        const refusal = { ok: false, error: 'web pane has no host', owner_window: 'other-window' };
        const transport = vi.fn(async () => refusal as unknown);
        const { browser } = createKelpiAPI(transport);
        await expect(browser.reload('pane')).rejects.toMatchObject({ name: 'KelpiError', code: 'COMMAND_FAILED', method: 'browser.reload', message: 'web pane has no host', details: refusal });
        transport.mockResolvedValueOnce({ message: 'bad' }); await expect(browser.stop('pane')).rejects.toMatchObject({ code: 'INVALID_REPLY' });
        transport.mockResolvedValueOnce({ ok: true, favourites: {} }); await expect(browser.favourites.list()).rejects.toMatchObject({ code: 'INVALID_REPLY' });
        const owned = new KelpiError('stale host', { code: 'BROWSER_STALE', method: 'browser.capture' });
        transport.mockRejectedValueOnce(owned); await expect(browser.capture('pane')).rejects.toBe(owned);
    });
});
