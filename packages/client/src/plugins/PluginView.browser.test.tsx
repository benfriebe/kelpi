import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, type PluginInfo } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createWebPaneCommands } from '../webpane/commands';
import { PluginView } from './PluginView';
import { usePlugins } from './client';

const PANE = 'AAAAAAAA-2222-4333-8444-555555555555', TAB = 'BBBBBBBB-2222-4333-8444-555555555555', VIEW = 'browser.test.renderer';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup(granted = true) {
    vi.stubGlobal('MessageChannel', MessageChannel);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: 'W', paneID: 'SHELL', name: 'Work', color: 'blue', now: 1 });
    state.dispatch({ type: 'open-web-pane', workspaceID: 'W', paneID: PANE, tabID: TAB, url: 'https://example.test', now: 2 });
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    const manifest = decodePluginManifest({ id: 'browser.test', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: VIEW, title: 'Test browser', entry: 'ui/index.html', placements: ['browser'] }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID: 'D' } };
        if (payload['action'] === 'attach') return { ok: true, result: { lease: 'lease', html: '<div></div>', entry: 'ui/index.html', context: { daemonID: 'D', paneID: PANE, workspaceID: 'W' }, state: {}, stateVersion: 1 } };
        return { ok: true, result: null };
    });
    const catalog = renderHook(() => usePlugins(runtime)), onError = vi.fn(), onGeometry = vi.fn(), onHidden = vi.fn();
    const commands = createWebPaneCommands(runtime.commands);
    const browser = { paneID: PANE, commands, tabs: [{ id: TAB, url: 'https://example.test', live: true }], activeTabID: TAB,
        focused: true, visible: true, embedded: true, available: true, onGeometry, onHidden, findToken: 0, focusURLToken: 0 };
    const props = { runtime, pluginID: manifest.id, viewID: VIEW, paneID: PANE, workspaceID: 'W', onError, visible: true, focused: true,
        ...(granted ? { browser } : {}) };
    const view = render(<PluginView {...props} />);
    await waitFor(() => expect(screen.getByTitle('Test browser').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
    const frame = screen.getByTitle('Test browser') as HTMLIFrameElement;
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 50, left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300, toJSON: () => ({}) });
    Object.defineProperties(frame, { clientWidth: { configurable: true, value: 400 }, clientHeight: { configurable: true, value: 300 } });
    const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
    const child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
    const received: Array<Record<string, any>> = [];
    child.on('message', message => {
        received.push(message);
        if (message.type === 'browser-presentation') child.postMessage({ type: 'browser-ack', session: message.session, sequence: message.sequence });
        if (message.type === 'browser-action') child.postMessage({ type: 'browser-action-reply', session: message.session, id: message.id, result: null });
    });
    const attach = async () => {
        child.postMessage({ type: 'call', id: 'attach', method: 'browser.attach', args: { session: 'one', rect: { x: 0, y: 40, w: 400, h: 260 }, visible: true } });
        await waitFor(() => expect(received.some(item => item.type === 'reply' && item.id === 'attach')).toBe(true));
        return received.find(item => item.type === 'reply' && item.id === 'attach')!;
    };
    return { runtime, requests, received, view, props, browser, commands, frame, child, onError, onGeometry, onHidden, attach,
        dispose: () => { view.unmount(); catalog.unmount(); child.close(); runtime.dispose(); } };
}

describe('selected browser surface through its private view port', () => {
    it('grants only the selected renderer access to native placement', async () => {
        const h = await setup(false);
        try { expect((await h.attach()).error).toContain('selected browser view'); expect(h.onGeometry).not.toHaveBeenCalled(); }
        finally { h.dispose(); }
    });
    it('places only inside the iframe and parks on plugin coverage without closing a tab', async () => {
        const h = await setup();
        try {
            expect((await h.attach()).error).toBeUndefined();
            await waitFor(() => expect(h.onGeometry).toHaveBeenLastCalledWith({ paneID: PANE, tabID: TAB, rect: { x: 102, y: 90, w: 396, h: 258 }, visible: true, devicePixelRatio: 1 }));
            h.child.postMessage({ type: 'browser-covered', session: 'one', covered: true });
            await waitFor(() => expect(screen.getByTestId(`web-page-${PANE}`).getAttribute('data-visible')).toBe('false'));
            expect(h.onHidden).toHaveBeenCalledWith(PANE);
            h.child.postMessage({ type: 'browser-covered', session: 'one', covered: false });
            await waitFor(() => expect(screen.getByTestId(`web-page-${PANE}`).getAttribute('data-visible')).toBe('true'));
            expect(h.requests.mock.calls.some(([payload]) => ['web-tab-close', 'web-private', 'pane-close'].includes(String(payload['command'])))).toBe(false);
        } finally { h.dispose(); }
    });
    it('cleans placement and leases on view failure, leaving native recovery intact', async () => {
        const h = await setup();
        try {
            await h.attach(); h.child.postMessage({ type: 'view-error', message: 'browser failed' });
            await waitFor(() => expect(h.onError).toHaveBeenCalledWith('browser failed'));
            expect(h.onHidden).toHaveBeenCalledWith(PANE);
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release')).toBe(true);
            expect(h.requests.mock.calls.some(([payload]) => payload['command'] === 'web-tab-close')).toBe(false);
        } finally { h.dispose(); }
    });
    it('retains a find request while the replacement is still attaching', async () => {
        const h = await setup();
        try {
            h.view.rerender(<PluginView {...h.props} browser={{ ...h.browser, findToken: 1 }} />);
            await h.attach();
            await waitFor(() => expect(h.received.some(item => item.type === 'browser-action' && item.action.type === 'showFind')).toBe(true));
            expect(h.requests.mock.calls.some(([payload]) => payload['command'] === 'web-blur-view')).toBe(true);
        } finally { h.dispose(); }
    });
    it('tracks opaque-frame text focus and routes owner shortcuts before window dispatch', async () => {
        const h = await setup(), onKey = vi.fn(() => true), windowKey = vi.fn(); window.addEventListener('keydown', windowKey);
        try {
            await h.attach(); h.view.rerender(<PluginView {...h.props} claimedChords={['8/KeyR']} onBrowserKey={onKey} />);
            h.child.postMessage({ type: 'browser-text-focus', session: 'one', editing: true });
            await waitFor(() => expect(h.frame.hasAttribute('data-web-chrome-text')).toBe(true));
            h.child.postMessage({ type: 'key', key: 'r', code: 'KeyR', metaKey: true });
            await waitFor(() => expect(onKey).toHaveBeenCalledOnce()); expect(windowKey).not.toHaveBeenCalled();
        } finally { window.removeEventListener('keydown', windowKey); h.dispose(); }
    });
    it('preserves a pointer-directed address caret while pane focus catches up', async () => {
        const h = await setup();
        try {
            await h.attach();
            h.view.rerender(<PluginView {...h.props} focused={false} browser={{ ...h.browser, focused: false }} />);
            await waitFor(() => expect(h.received.some(item => item.type === 'browser-presentation' && item.value.focused === false)).toBe(true));
            h.received.length = 0;
            const focused = vi.spyOn(h.runtime, 'focusPane').mockImplementation(() => {
                h.view.rerender(<PluginView {...h.props} browser={h.browser} />);
            });
            h.child.postMessage({ type: 'focus' });
            await waitFor(() => expect(focused).toHaveBeenCalledWith('W', PANE));
            h.child.postMessage({ type: 'browser-text-focus', session: 'one', editing: true });
            await waitFor(() => expect(h.frame.hasAttribute('data-web-chrome-text')).toBe(true));
            expect(h.received.filter(item => item.type === 'browser-action')).toEqual([]);
        } finally { h.dispose(); }
    });
    it('does not move the address caret after native blur fails', async () => {
        const h = await setup();
        try {
            await h.attach();
            const blur = vi.spyOn(h.commands, 'blurView').mockResolvedValue({ ok: false, error: 'Native host changed.' });
            h.received.length = 0;
            h.view.rerender(<PluginView {...h.props} browser={{ ...h.browser, focusURLToken: 1 }} />);
            await waitFor(() => expect(blur).toHaveBeenCalledWith(PANE));
            await act(async () => { await Promise.resolve(); });
            expect(h.received.some(item => item.type === 'browser-action' && item.action.type === 'focusAddress')).toBe(false);
            expect(h.onError).not.toHaveBeenCalled();
        } finally { h.dispose(); }
    });
    it('fails the current view when native focus fails', async () => {
        const h = await setup();
        try {
            await h.attach();
            vi.spyOn(h.commands, 'focusView').mockResolvedValue({ ok: false, error: 'Native host changed.' });
            h.child.postMessage({ type: 'browser-focus', session: 'one' });
            await waitFor(() => expect(h.onError).toHaveBeenCalledWith('Native host changed.'));
            expect(h.onHidden).toHaveBeenCalledWith(PANE);
        } finally { h.dispose(); }
    });
    it('shows the host-owned unavailable card while retaining remote controls', async () => {
        const h = await setup();
        try {
            h.view.rerender(<PluginView {...h.props} browser={{ ...h.browser, embedded: false, available: false, reason: 'This page is hosted on the remote desktop.' }} />);
            await h.attach();
            await waitFor(() => expect(screen.getByTestId(`web-external-${PANE}`).textContent).toContain('remote desktop'));
            expect(h.onGeometry).not.toHaveBeenCalled();
            h.child.postMessage({ type: 'browser-focus', session: 'one' });
            expect(h.requests.mock.calls.some(([payload]) => payload['command'] === 'web-focus-view')).toBe(false);
        } finally { h.dispose(); }
    });
});
