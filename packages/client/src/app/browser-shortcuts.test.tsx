import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { parseKeyTrigger } from '@kelpi/core/config';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientKeyBindings } from '../chrome/keys';
import { registerModal } from '../chrome/modal-presence';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { createWebPaneCommands } from '../webpane/commands';
import { WEB_CHROME_TEXT_ATTRIBUTE } from '../webpane/priority';
import { browserShortcutChords, dispatchBrowserShortcut, useBrowserShortcuts } from './browser-shortcuts';
import { TerminalShortcutContext, type TerminalShortcutHost } from './terminal-shortcuts';

const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0).reverse()) dispose(); vi.restoreAllMocks(); });
function fixture(tabCount = 2) {
    const shellID = crypto.randomUUID(), paneID = crypto.randomUUID(), workspaceID = crypto.randomUUID();
    const tabs = Array.from({ length: tabCount }, () => crypto.randomUUID());
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: workspaceID, paneID: shellID, name: 'Owner', color: 'blue', now: 1 });
    state.dispatch({ type: 'open-web-pane', workspaceID, paneID, tabID: tabs[0]!, url: 'http://fixture', now: 2 });
    for (const tabID of tabs.slice(1)) state.dispatch({ type: 'web-tab-open', workspaceID, paneID, tabID, url: 'http://second', makeActive: true });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    disposals.push(() => runtime.dispose());
    const raw = vi.fn(async (_payload: Record<string, unknown>) => ({ ok: true }));
    const commands = createWebPaneCommands({ raw });
    const closePane = vi.spyOn(runtime.commands, 'closePane').mockResolvedValue({ ok: true });
    const focusAddress = vi.fn(), showFind = vi.fn();
    const options = { runtime, paneID, commands, visible: true, focusAddress, showFind };
    let sequence = 1;
    const update = () => runtime.store.getState().applySnapshot(++sequence, JSON.parse(JSON.stringify(state.getState())));
    return { runtime, paneID, shellID, workspaceID, tabs, state, raw, commands, closePane, focusAddress, showFind, options, update };
}
const key = (code: string, options: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...options });
const host = (bindings: string[] = []): TerminalShortcutHost => ({ bindings: clientKeyBindings(bindings, true), onError: vi.fn() });

describe('browser shortcuts in replaceable chrome', () => {
    it('combines browser priority and configured actions without claiming ordinary HTML editing', () => {
        const h = host(['super+shift+j=web_back', 'super+y=copy', 'super+shift+x=close_pane']);
        const chords = browserShortcutChords(h, ['8/Comma', '8/KeyC', '8/KeyV', '8/Backspace', '8/KeyY']);
        expect(chords).toEqual(expect.arrayContaining(['8/KeyL', '8/KeyR', '8/ArrowLeft', '8/ArrowRight', '8/KeyT', '8/KeyW', '12/BracketLeft', '12/BracketRight', '8/Equal', '12/Equal', '8/Minus', '8/Digit0', '8/KeyF', '12/KeyJ', '12/KeyX', '8/Comma']));
        for (const chord of ['8/KeyC', '8/KeyV', '8/Backspace', '8/KeyY']) expect(chords).not.toContain(chord);
        expect(browserShortcutChords({ ...h, globalHotkey: parseKeyTrigger('super+r') })).not.toContain('8/KeyR');
        expect(browserShortcutChords({ ...h, windowChords: ['8/Comma'] })).toContain('8/Comma');
    });

    it('targets every native browser chord at the exact remote pane and its live active tab', () => {
        const primary = fixture(), remote = fixture(), h = host();
        const options = { ...remote.options, host: h };
        for (const event of [key('KeyL'), key('KeyR'), key('ArrowLeft'), key('ArrowRight'), key('KeyT'), key('KeyW'), key('BracketLeft', { shiftKey: true }), key('BracketRight', { shiftKey: true }), key('Equal'), key('Equal', { shiftKey: true }), key('Minus'), key('Digit0'), key('KeyF')]) {
            expect(dispatchBrowserShortcut(event, options)).toBe(true);
        }
        expect(remote.focusAddress).toHaveBeenCalledOnce(); expect(remote.showFind).toHaveBeenCalledOnce();
        expect(remote.raw.mock.calls.map(([payload]) => payload)).toEqual([
            { command: 'web-reload', pane_id: remote.paneID },
            { command: 'web-back', pane_id: remote.paneID }, { command: 'web-forward', pane_id: remote.paneID },
            { command: 'web-tab-new', pane_id: remote.paneID, url: '', make_active: true },
            { command: 'web-tab-close', pane_id: remote.paneID, tab: remote.tabs[1] },
            { command: 'web-tab-select', pane_id: remote.paneID, tab: remote.tabs[0] },
            { command: 'web-tab-select', pane_id: remote.paneID, tab: remote.tabs[0] },
            ...['in', 'in', 'out', 'reset'].map(direction => ({ command: 'web-zoom', pane_id: remote.paneID, tab_id: remote.tabs[1], direction })),
        ]);
        expect(primary.raw).not.toHaveBeenCalled(); expect(primary.closePane).not.toHaveBeenCalled(); expect(remote.closePane).not.toHaveBeenCalled();
    });

    it('re-reads tab selection and active-tab fallback on each event', () => {
        const remote = fixture(), options = { ...remote.options, host: host() };
        remote.state.dispatch({ type: 'web-tab-select', workspaceID: remote.workspaceID, paneID: remote.paneID, tabID: remote.tabs[0]! }); remote.update();
        dispatchBrowserShortcut(key('Digit0'), options);
        expect(remote.raw).toHaveBeenLastCalledWith({ command: 'web-zoom', pane_id: remote.paneID, tab_id: remote.tabs[0], direction: 'reset' });
        remote.state.dispatch({ type: 'web-tab-close', workspaceID: remote.workspaceID, paneID: remote.paneID, tabID: remote.tabs[0]! }); remote.update();
        dispatchBrowserShortcut(key('KeyW'), options);
        expect(remote.closePane).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID });
        expect(remote.raw).toHaveBeenCalledOnce();
    });

    it('honors the resolved close binding when native priority defers a single-tab close', () => {
        const primary = fixture(), remote = fixture(1);
        expect(dispatchBrowserShortcut(key('KeyW'), { ...remote.options, host: host() })).toBe(true);
        expect(remote.closePane).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID });
        expect(primary.closePane).not.toHaveBeenCalled(); remote.closePane.mockClear();
        expect(dispatchBrowserShortcut(key('KeyW'), { ...remote.options, host: host(['super+w=unbind']) })).toBe(false);
        expect(dispatchBrowserShortcut(key('KeyW'), { ...remote.options, host: host(['super+w=split_right']) })).toBe(false);
        expect(remote.closePane).not.toHaveBeenCalled();
        expect(dispatchBrowserShortcut(key('KeyX', { shiftKey: true }), { ...remote.options, host: host(['super+shift+x=close_pane']) })).toBe(true);
        expect(remote.closePane).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID });
    });

    it('runs configured browser actions and uses owning pane close for a configured single-tab action', () => {
        const remote = fixture(1), h = host(['super+shift+j=web_back', 'super+shift+l=web_focus_url_bar', 'super+shift+w=web_tab_close', 'super+shift+f=toggle_search']);
        const options = { ...remote.options, host: h };
        for (const code of ['KeyJ', 'KeyL', 'KeyW', 'KeyF']) expect(dispatchBrowserShortcut(key(code, { shiftKey: true }), options)).toBe(true);
        expect(remote.raw).toHaveBeenCalledExactlyOnceWith({ command: 'web-back', pane_id: remote.paneID });
        expect(remote.focusAddress).toHaveBeenCalledOnce(); expect(remote.showFind).toHaveBeenCalledOnce();
        expect(remote.closePane).toHaveBeenCalledExactlyOnceWith({ paneID: remote.paneID });
    });

    it('swallows delayed editing-navigation relays when the chrome now holds a text caret', () => {
        const remote = fixture(); const input = document.createElement('input'); input.setAttribute(WEB_CHROME_TEXT_ATTRIBUTE, '');
        document.body.append(input); input.focus(); disposals.push(() => input.remove());
        for (const event of [key('ArrowLeft'), key('ArrowRight'), key('BracketLeft', { shiftKey: true }), key('BracketRight', { shiftKey: true })]) {
            expect(dispatchBrowserShortcut(event, { ...remote.options, host: host() })).toBe(true);
            expect(dispatchBrowserShortcut(event, { ...remote.options, host: host(), nativeChrome: true })).toBe(false);
        }
        expect(remote.raw).not.toHaveBeenCalled();
        expect(dispatchBrowserShortcut(key('KeyR'), { ...remote.options, host: host() })).toBe(true);
        expect(remote.raw).toHaveBeenCalledExactlyOnceWith({ command: 'web-reload', pane_id: remote.paneID });
    });

    it('declines unrelated window/HTML editing chords and consumes blocked, hidden or stale owner actions', () => {
        const remote = fixture(), primary = fixture(), h = host(); const options = { ...remote.options, host: h };
        for (const code of ['KeyC', 'KeyV', 'Backspace', 'KeyD', 'KeyP', 'Comma']) expect(dispatchBrowserShortcut(key(code), options)).toBe(false);
        expect(dispatchBrowserShortcut(key('KeyR'), { ...options, visible: false })).toBe(true);
        expect(dispatchBrowserShortcut(key('KeyR'), { ...options, host: { ...h, blocked: () => true } })).toBe(true);
        expect(dispatchBrowserShortcut(key('KeyR'), { ...options, host: { ...h, globalHotkey: parseKeyTrigger('super+r') } })).toBe(true);
        const release = registerModal();
        try { expect(dispatchBrowserShortcut(key('KeyF'), options)).toBe(true); } finally { release(); }
        expect(dispatchBrowserShortcut(key('KeyR'), { ...options, paneID: primary.paneID })).toBe(true);
        expect(dispatchBrowserShortcut(key('KeyR'), { ...options, paneID: remote.shellID })).toBe(true);
        remote.runtime.store.getState().applySnapshot(2, { ...remote.runtime.store.getState().daemon.state, workspaces: [] });
        expect(dispatchBrowserShortcut(key('KeyR'), options)).toBe(true);
        expect(remote.raw).not.toHaveBeenCalled(); expect(primary.raw).not.toHaveBeenCalled(); expect(remote.showFind).not.toHaveBeenCalled();
    });

    it('reports owning native command refusals and async chrome callback failures', async () => {
        const remote = fixture(), h = host();
        remote.raw.mockResolvedValue({ ok: false, error: 'remote host unavailable' } as any);
        dispatchBrowserShortcut(key('KeyR'), { ...remote.options, host: h });
        await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('Browser', 'remote host unavailable'));
        dispatchBrowserShortcut(key('KeyL'), { ...remote.options, host: h, focusAddress: async () => { throw new Error('surface disposed'); } });
        await vi.waitFor(() => expect(h.onError).toHaveBeenCalledWith('Browser', 'surface disposed'));
    });

    it('takes the current window bindings from context and refreshes hook visibility', () => {
        const remote = fixture(), h = host(['super+shift+j=web_back']);
        const hook = renderHook(({ visible }) => useBrowserShortcuts({ ...remote.options, visible }), {
            initialProps: { visible: true },
            wrapper: ({ children }) => <TerminalShortcutContext.Provider value={h}>{children}</TerminalShortcutContext.Provider>,
        });
        expect(hook.result.current.chords).toContain('12/KeyJ');
        expect(hook.result.current.onKey(key('KeyJ', { shiftKey: true }))).toBe(true); expect(remote.raw).toHaveBeenCalledOnce();
        hook.rerender({ visible: false }); hook.result.current.onKey(key('KeyJ', { shiftKey: true })); expect(remote.raw).toHaveBeenCalledOnce();
        hook.rerender({ visible: true });
        const input = document.createElement('input'); input.setAttribute(WEB_CHROME_TEXT_ATTRIBUTE, ''); document.body.append(input); input.focus();
        expect(hook.result.current.onNativeKey(key('ArrowLeft'))).toBe(false); input.remove();
        hook.unmount();
    });
});
