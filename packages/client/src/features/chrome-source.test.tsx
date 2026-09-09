import { StrictMode, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiStore, type KelpiRuntime } from '../state';
import { ZERO_SYSTEM_STATS } from '@kelpi/protocol';
import { createChromeFeatureSource, type ChromeFeatureHost } from './chrome-source';
import { bindToolbarFeature, createToolbarActions } from './toolbar';
import { createStatusbarActions, statusbarModel, useStatusbarActions } from './statusbar';
import { createPluginChrome } from '../plugins/chrome';
import { usePluginChrome } from '../plugins/use-chrome';

function fixture() {
    const daemon = createDaemonStore(emptyDaemonState('/home/test'));
    for (const id of ['one', 'two']) daemon.dispatch({ type: 'create-workspace', id, paneID: `pane-${id}`, name: id, color: 'blue', now: 1 });
    const store = createKelpiStore();
    const sync = () => store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    sync(); store.getState().setConnectionStatus('connected'); store.getState().setActiveWorkspace('one');
    const commands = { cycleLayout: vi.fn().mockResolvedValue({ ok: true }), selectLayout: vi.fn().mockResolvedValue({ ok: true }),
        setSyncInput: vi.fn().mockResolvedValue({ ok: true }), takeSizeControl: vi.fn() };
    const runtime = { store, commands, focusPane: vi.fn((workspaceID: string, paneID: string) => store.getState().setFocusEcho(workspaceID, paneID)) } as unknown as KelpiRuntime;
    let remote = false;
    const host: ChromeFeatureHost = {
        runtime, sidebars: { 'sidebar.primary': { id: 'kelpi.workspaces', title: 'Workspaces', placements: ['sidebar.primary'] }, 'sidebar.secondary': { id: 'kelpi.inspector', title: 'Inspector', placements: ['sidebar.secondary'] } },
        sidebarVisible: true, inspectorVisible: false, remoteWorkspaceSelected: () => remote, shellAvailable: false,
        associations: { workspaceID: 'one', values: [] },
        plugins: { menu: vi.fn(() => []), items: vi.fn(() => []), runItem: vi.fn(() => true) } as unknown as ChromeFeatureHost['plugins'],
        toggleSidebar: vi.fn(), toggleInspector: vi.fn(), openSettings: vi.fn(), openHelp: vi.fn(), openPalette: vi.fn(), shellAction: vi.fn(), restartControlServer: vi.fn(), restartUI: vi.fn(), selectPane: vi.fn()
    };
    return { daemon, store, sync, runtime, commands, host, source: createChromeFeatureSource(host), remote(value: boolean) { remote = value; } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shared toolbar and status feature contracts', () => {
    it('shows physical sidebar placement and invokes the selected native host after a swap', () => {
        const h = fixture(), source = createChromeFeatureSource({ ...h.host, sidebars: {
            'sidebar.primary': h.host.sidebars['sidebar.secondary'], 'sidebar.secondary': h.host.sidebars['sidebar.primary']
        } });
        expect(source.snapshot().sidebars).toEqual({ left: { viewID: 'kelpi.inspector', title: 'Inspector', visible: false }, right: { viewID: 'kelpi.workspaces', title: 'Workspaces', visible: true } });
        source.execute('kelpi.sidebar.left', {}); expect(h.host.toggleInspector).toHaveBeenCalledOnce();
        source.execute('kelpi.sidebar.right', {}); expect(h.host.toggleSidebar).toHaveBeenCalledOnce();
    });
    it('rejects stale workspace actions, disconnected mutations, unknown commands and remote selection', async () => {
        const h = fixture(), model = createPluginChrome(h.source);
        const before = model.getChrome(); expect(before.workspace?.id).toBe('one');
        h.store.getState().setActiveWorkspace('two');
        expect(() => model.execute('kelpi.layout.cycle', { workspaceID: before.workspace!.id })).toThrow('no longer selected');
        await model.execute('kelpi.layout.select.tiled', { workspaceID: 'two' });
        expect(h.commands.selectLayout).toHaveBeenCalledExactlyOnceWith({ paneID: 'pane-two', layout: 'tiled' });
        h.remote(true); expect(() => model.execute('kelpi.input.toggleSync', { workspaceID: 'two' })).toThrow('disabled');
        expect(model.getChrome().remoteWorkspaceSelected).toBe(true); h.remote(false);
        h.store.getState().setConnectionStatus('reconnecting', 'wss://private.test?token=secret');
        expect(() => model.execute('kelpi.layout.cycle', { workspaceID: 'two' })).toThrow('disabled');
        expect(JSON.stringify(model.getChrome())).not.toContain('secret');
        model.execute('kelpi.window.openPlugins', {}); expect(h.host.openSettings).toHaveBeenCalledExactlyOnceWith('plugins');
        expect(() => model.execute('kelpi.window.installCLI', {})).toThrow('unavailable');
        expect(() => model.execute('kelpi.layout.select.invented', {})).toThrow('unavailable');
        expect(h.commands.cycleLayout).not.toHaveBeenCalled(); expect(h.commands.setSyncInput).not.toHaveBeenCalled(); model.dispose();
    });
    it('returns daemon command failures to the caller and never retries a mutation', async () => {
        const h = fixture(); h.commands.setSyncInput.mockResolvedValue({ ok: false, error: 'Operation refused' });
        await expect(h.source.execute('kelpi.input.toggleSync', { workspaceID: 'one' })).rejects.toThrow('Operation refused');
        expect(h.commands.setSyncInput).toHaveBeenCalledOnce();
    });
    it('projects live agents and real metrics while preserving unknown sampler state', () => {
        const h = fixture(); expect(h.source.snapshot().systemStats).toBeNull();
        h.daemon.dispatch({ type: 'pane-agent-event', paneID: 'pane-two', workspaceID: 'two', now: 5, event: { type: 'setPaneStatus', status: 'running' } }); h.sync();
        const sample = { ...ZERO_SYSTEM_STATS, cpuPercent: 37 };
        h.store.setState(state => ({ systemStats: { ...state.systemStats, loaded: true, stats: sample }, settings: { ...state.settings, value: { ...state.settings.value, chrome: { ...state.settings.value.chrome, showSystemStats: true, enabledSystemStats: ['cpu'] } } } }));
        const snapshot = h.source.snapshot(); expect(snapshot.agents.running).toBe(1);
        expect(snapshot.agentPanes).toEqual([expect.objectContaining({ workspaceID: 'two', paneID: 'pane-two', bucket: 'running' })]);
        expect(snapshot.systemStats).toEqual([{ id: 'cpu', title: 'CPU', text: '37%', detail: '37% busy' }]);
        expect(statusbarModel(h.store.getState(), []).summary).toEqual(snapshot.agents);
    });
    it('uses the public command registry to render and invoke native toolbar controls', () => {
        const h = fixture(), execute = vi.fn(), model = h.source.snapshot();
        const binding = bindToolbarFeature({ model, presentation: { panes: h.daemon.getState().workspaces[0]!.panes }, contributions: null, execute });
        render(binding.render({ visible: true, trafficLightInset: 86 }));
        fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
        expect(execute).toHaveBeenCalledWith('kelpi.sidebar.left');
        fireEvent.click(screen.getByRole('button', { name: 'Toggle inspector' }));
        expect(execute).toHaveBeenCalledWith('kelpi.sidebar.right');
        expect(screen.getByTestId('top-bar').getAttribute('data-traffic-light-inset')).toBe('86');
    });
    it('rechecks item and menu contribution rules before invoking another plugin', () => {
        const h = fixture(), run = vi.fn(() => false);
        h.host.plugins.menu = vi.fn(() => [{ id: 'sample.menu', title: 'Run', enabled: true, run }] as never);
        h.host.plugins.items = vi.fn(placement => placement === 'statusbar' ? [{ id: 'sample.item', text: 'Live', badge: '2', enabled: true, command: 'sample.run', tone: 'success' }] as never : []);
        const snapshot = h.source.snapshot(); expect(snapshot.items[0]).toMatchObject({ text: 'Live', badge: '2', commandID: 'item:statusbar:sample.item' });
        expect(() => h.source.execute('menu:sample.menu', { workspaceID: 'one' })).toThrow('no longer available');
        h.source.execute('item:statusbar:sample.item', { workspaceID: 'one' }); expect(h.host.plugins.runItem).toHaveBeenCalledExactlyOnceWith('statusbar', 'sample.item');
        h.host.plugins.items = vi.fn(() => []);
        expect(() => h.source.execute('item:statusbar:sample.item', { workspaceID: 'one' })).toThrow('unavailable');
    });
    it('keeps retained keyboard actions bound to current workspace and pane getters', () => {
        const h = fixture(); let workspace = 'one';
        const actions = createToolbarActions({ commands: h.commands, activeWorkspaceID: () => workspace, focusedPaneID: () => `pane-${workspace}`, run: vi.fn(() => true), setInspectorVisible: vi.fn() });
        workspace = 'two'; actions.cycleLayout(); actions.toggleSyncInput();
        expect(h.commands.cycleLayout).toHaveBeenCalledExactlyOnceWith({ paneID: 'pane-two' });
        expect(h.commands.setSyncInput).toHaveBeenCalledExactlyOnceWith({ action: 'toggle', workspace: 'two' });
    });
    it('cancels queued status caret handoffs on navigation or disposal and rejects removed panes', () => {
        const h = fixture(), frames = new Map<number, FrameRequestCallback>(); let next = 0;
        vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++next, fn); return next; });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
        const caret = vi.fn(), activateWorkspace = vi.fn((id: string) => h.store.getState().setActiveWorkspace(id));
        const actions = createStatusbarActions({ runtime: h.runtime, activateWorkspace, handBackCaret: caret });
        actions.selectPane('two', 'pane-two'); expect(caret).toHaveBeenCalledOnce();
        h.store.getState().setActiveWorkspace('one'); frames.get(1)!(1); expect(caret).toHaveBeenCalledOnce();
        expect(() => actions.selectPane('two', 'removed')).toThrow('no longer available');
        actions.selectPane('one', 'pane-one'); expect(frames.has(2)).toBe(true); actions.dispose(); expect(frames.has(2)).toBe(false);
        expect(() => actions.selectPane('one', 'pane-one')).toThrow('unavailable');
    });
    it('recreates window chrome and status actions after StrictMode effect replay', () => {
        const h = fixture(), observed = vi.fn();
        function View() {
            const chrome = usePluginChrome(h.runtime, h.source);
            useLayoutEffect(() => chrome?.subscribe(observed), [chrome]); return null;
        }
        const actions = renderHook(() => useStatusbarActions({ runtime: h.runtime, activateWorkspace: h.host.selectPane as never, handBackCaret: vi.fn() }), { wrapper: StrictMode });
        expect(() => actions.result.current.selectPane('one', 'pane-one')).not.toThrow();
        const view = render(<StrictMode><View /></StrictMode>); expect(observed).toHaveBeenCalled();
        view.unmount(); actions.unmount(); expect(() => actions.result.current.selectPane('one', 'pane-one')).toThrow('unavailable');
    });
});
