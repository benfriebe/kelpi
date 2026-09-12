import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiStore, type KelpiRuntime } from '../state';
import { createPaletteFeatureSource, type PaletteFeatureHost } from './palette-source';

type MenuEntry = { id: string; title: string; pluginName: string; enabled: boolean; shortcut?: string; run: () => boolean };

function fixture() {
    const daemon = createDaemonStore(emptyDaemonState('/home/test'));
    for (const id of ['one', 'two']) daemon.dispatch({ type: 'create-workspace', id, paneID: `pane-${id}`, name: id, color: 'blue', now: 1 });
    const store = createKelpiStore();
    const sync = (): void => store.getState().applySnapshot(0, JSON.parse(JSON.stringify(daemon.getState())));
    sync();
    store.getState().setConnectionStatus('connected');
    store.getState().setActiveWorkspace('one');
    const runtime = { store, focusPane: vi.fn(), activateWorkspace: vi.fn() } as unknown as KelpiRuntime;
    let menu: MenuEntry[] = [];
    // Stands in for `plugins/contributions.ts`'s store, which is where a `when`/`enablement` flip,
    // a disable, a reload or a new `palette` menu actually lands. None of it touches the mirror.
    const contributionListeners = new Set<() => void>();
    const notifyContributions = (): void => { for (const listener of [...contributionListeners]) listener(); };
    const actions = {
        splitFocused: vi.fn(() => true), closeFocused: vi.fn(() => true), reopenClosedPane: vi.fn(() => true),
        createScratchpad: vi.fn(() => true), toggleSearch: vi.fn(() => true), toggleZoomFocused: vi.fn(() => true),
        cycleLayout: vi.fn(() => true), toggleSyncInput: vi.fn(() => true), newWorkspace: vi.fn(() => true)
    };
    const host: PaletteFeatureHost = {
        runtime,
        plugins: { menu: vi.fn(() => menu) } as unknown as PaletteFeatureHost['plugins'],
        subscribeContributions: (listener: () => void) => { contributionListeners.add(listener); return () => { contributionListeners.delete(listener); }; },
        actions,
        shortcut: vi.fn((action: string) => (action === 'create_scratchpad' ? '⌘N' : undefined)) as PaletteFeatureHost['shortcut'],
        openSettings: vi.fn(),
        activateWorkspace: vi.fn(),
        focusPane: vi.fn(),
        homeDirectory: '/home/test'
    };
    return {
        daemon, store, sync, host, actions, runtime,
        source: createPaletteFeatureSource(host),
        setMenu(next: MenuEntry[]) { menu = next; notifyContributions(); },
        notifyContributions
    };
}

/** Every leaf of the projection, so a closure hidden three levels down is still caught. */
function leaves(value: unknown, path = 'items'): string[] {
    if (typeof value === 'function') return [path];
    if (Array.isArray(value)) return value.flatMap((child, index) => leaves(child, `${path}[${index}]`));
    if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => leaves(child, `${path}.${key}`));
    return [];
}

afterEach(() => { vi.restoreAllMocks(); });

describe('palette feature source', () => {
    it('projects workspaces, panes and verbs as descriptors that carry no closures', () => {
        const h = fixture();
        h.setMenu([{ id: 'sample.menu:palette', title: 'Run Lab', pluginName: 'UI Lab', enabled: true, shortcut: '⌥L', run: () => true }]);
        const items = h.source.snapshot().items;
        expect(leaves(items)).toEqual([]);
        expect(JSON.parse(JSON.stringify(items))).toEqual(items);
        expect(items.map((item) => item.id).slice(0, 4)).toEqual(['ws:one', 'pane:pane-one', 'ws:two', 'pane:pane-two']);
        // Contributions lead the command block, exactly as assembly ordered them.
        expect(items[4]).toMatchObject({ id: 'sample.menu:palette', kind: 'command', subtitle: 'UI Lab', shortcut: '⌥L', disabled: false });
        expect(items.find((item) => item.id === 'cmd:new-scratchpad')).toMatchObject({ title: 'New Scratchpad', shortcut: '⌘N' });
        expect(items.find((item) => item.id === 'cmd:settings')).toMatchObject({ shortcut: '⌘,' });
        // A verb the binding map has no chord for carries no `shortcut` key at all.
        expect(items.find((item) => item.id === 'cmd:close-pane')).not.toHaveProperty('shortcut');
    });

    it('runs a native verb exactly once and refuses one that reports it could not run', async () => {
        const h = fixture();
        await h.source.execute('cmd:new-scratchpad', {});
        expect(h.actions.createScratchpad).toHaveBeenCalledOnce();
        await h.source.execute('cmd:new-pane', {});
        expect(h.actions.splitFocused).toHaveBeenCalledExactlyOnceWith('horizontal');
        await h.source.execute('cmd:plugins', {});
        expect(h.host.openSettings).toHaveBeenCalledExactlyOnceWith('plugins');

        // A native verb with nothing to act on (Find in Pane with no focused pane, Close Pane in an
        // empty workspace) answers false. The palette has always been SILENT there, so `execute`
        // resolves rather than raising a failure toast for an ordinary no-op.
        h.actions.closeFocused.mockReturnValue(false);
        await expect(h.source.execute('cmd:close-pane', {})).resolves.toBeUndefined();
        expect(h.actions.closeFocused).toHaveBeenCalledOnce();
        h.actions.toggleSearch.mockReturnValue(false);
        await expect(h.source.execute('cmd:search-pane', {})).resolves.toBeUndefined();

        await expect(h.source.execute('cmd:invented', {})).rejects.toThrow('unavailable');
    });

    it('re-resolves a contribution at activation and refuses one whose enablement turned false', async () => {
        const h = fixture();
        const run = vi.fn(() => true);
        h.setMenu([{ id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: true, run }]);
        expect(h.source.snapshot().items.find((item) => item.id === 'lab.menu')?.disabled).toBe(false);
        await h.source.execute('lab.menu', {});
        expect(run).toHaveBeenCalledOnce();

        // `when`/`enablement` turned false since the descriptor was read: the stale row is refused
        // and the contribution is never asked to run.
        h.setMenu([{ id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: false, run }]);
        await expect(h.source.execute('lab.menu', {})).rejects.toThrow('disabled');
        expect(run).toHaveBeenCalledOnce();

        // Still listed and enabled, but the plugin went away between read and dispatch: `runMenu`
        // answers false and the refusal is reported rather than swallowed.
        const gone = vi.fn(() => false);
        h.setMenu([{ id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: true, run: gone }]);
        await expect(h.source.execute('lab.menu', {})).rejects.toThrow('no longer available');
        expect(gone).toHaveBeenCalledOnce();

        // Uninstalled outright: no descriptor, no dispatch.
        h.setMenu([]);
        await expect(h.source.execute('lab.menu', {})).rejects.toThrow('unavailable');
        expect(h.source.snapshot().items.some((item) => item.id === 'lab.menu')).toBe(false);
    });

    /**
     * A contribution names its own menu ids. One that starts `ws:` or `pane:` used to be routed as a
     * workspace jump by a prefix test and was therefore permanently unrunnable; routing is on the
     * DESCRIPTOR's kind, so it runs, and a real collision still resolves the way the rendered list
     * does (the mirror's row first).
     */
    it('routes a contribution whose id looks like a workspace or pane id, and lets a real row win a collision', async () => {
        const h = fixture();
        const run = vi.fn(() => true);
        h.setMenu([
            { id: 'pane:sidebar-tools', title: 'Sidebar Tools', pluginName: 'UI Lab', enabled: true, run },
            { id: 'ws:one', title: 'Shadowed', pluginName: 'UI Lab', enabled: true, run }
        ]);
        await h.source.execute('pane:sidebar-tools', { workspaceID: null, paneID: null });
        expect(run).toHaveBeenCalledOnce();

        // `ws:one` is a real workspace row too, and the row is what the list shows first.
        await h.source.execute('ws:one', {});
        expect(run).toHaveBeenCalledOnce();
        expect(h.host.activateWorkspace).toHaveBeenCalledExactlyOnceWith('one');
    });

    it('activates a workspace before focusing its pane and refuses a vanished or mismatched target', async () => {
        const h = fixture();
        const order: string[] = [];
        (h.host.activateWorkspace as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('activate'); });
        (h.host.focusPane as ReturnType<typeof vi.fn>).mockImplementation(() => { order.push('focus'); });

        await h.source.execute('pane:pane-two', { workspaceID: 'two' });
        expect(order).toEqual(['activate', 'focus']);
        expect(h.host.activateWorkspace).toHaveBeenCalledExactlyOnceWith('two');
        expect(h.host.focusPane).toHaveBeenCalledExactlyOnceWith('two', 'pane-two');

        await h.source.execute('ws:one', {});
        expect(h.host.activateWorkspace).toHaveBeenLastCalledWith('one');
        expect(h.host.focusPane).toHaveBeenCalledOnce();

        // The row the presenter is holding named another workspace than the caller's target.
        await expect(h.source.execute('pane:pane-two', { workspaceID: 'one' })).rejects.toThrow('no longer available');

        // The pane closed between the read and the activation.
        h.daemon.dispatch({ type: 'close-pane', workspaceID: 'two', paneID: 'pane-two' });
        h.sync();
        await expect(h.source.execute('pane:pane-two', {})).rejects.toThrow('no longer available');
        await expect(h.source.execute('ws:invented', {})).rejects.toThrow('no longer available');
    });

    /**
     * Assembly creates the source at the top of its render body, where the surface it is handed to
     * is created, and fills the host in further down once the contribution registry and the action
     * table exist. So one stable source must read the LATEST host, and must answer safely before
     * there is one.
     */
    it('reads the latest host through a getter and answers safely before assembly supplies one', async () => {
        const h = fixture();
        let host: PaletteFeatureHost | null = null;
        const source = createPaletteFeatureSource(() => host);
        expect(source.snapshot().items).toEqual([]);
        expect(source.subscribe(vi.fn())).toBeTypeOf('function');
        await expect(source.execute('cmd:new-scratchpad', {})).rejects.toThrow('not ready');

        host = h.host;
        expect(source.snapshot().items.some((item) => item.id === 'ws:one')).toBe(true);
        await source.execute('cmd:new-scratchpad', {});
        expect(h.actions.createScratchpad).toHaveBeenCalledOnce();
    });

    /**
     * The contribution half of the universe is invisible to the mirror, so watching the store alone
     * would leave an OPEN palette showing rows whose `enablement` has since flipped. At 44292eb the
     * list was live because it was a `useMemo` over `pluginCommands.commands`.
     */
    it('republishes when a contribution changes, not only when the mirror moves', () => {
        const h = fixture();
        h.setMenu([{ id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: true, run: () => true }]);
        const listener = vi.fn();
        const off = h.source.subscribe(listener);
        expect(h.source.snapshot().items.find((item) => item.id === 'lab.menu')?.disabled).toBe(false);

        // An enablement flip: no store write anywhere, so only the contribution feed can carry it.
        const workspaces = h.store.getState().daemon.state.workspaces;
        h.setMenu([{ id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: false, run: () => true }]);
        expect(listener).toHaveBeenCalledOnce();
        expect(h.store.getState().daemon.state.workspaces).toBe(workspaces);
        expect(h.source.snapshot().items.find((item) => item.id === 'lab.menu')?.disabled).toBe(true);

        // A newly contributed palette menu is the same event.
        h.setMenu([
            { id: 'lab.menu', title: 'Run Lab', pluginName: 'UI Lab', enabled: false, run: () => true },
            { id: 'lab.second', title: 'Second', pluginName: 'UI Lab', enabled: true, run: () => true }
        ]);
        expect(listener).toHaveBeenCalledTimes(2);
        expect(h.source.snapshot().items.some((item) => item.id === 'lab.second')).toBe(true);

        off();
        h.notifyContributions();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('notifies subscribers when the mirror changes and stops after unsubscribe', () => {
        const h = fixture();
        const listener = vi.fn();
        const off = h.source.subscribe(listener);
        h.daemon.dispatch({ type: 'create-workspace', id: 'three', paneID: 'pane-three', name: 'three', color: 'green', now: 3 });
        h.sync();
        expect(listener).toHaveBeenCalled();
        expect(h.source.snapshot().items.some((item) => item.id === 'ws:three')).toBe(true);
        const seen = listener.mock.calls.length;
        // A store write that cannot change the universe must not wake the presenter.
        h.store.getState().setPaletteQuery('scratch');
        expect(listener.mock.calls.length).toBe(seen);
        off();
        h.daemon.dispatch({ type: 'create-workspace', id: 'four', paneID: 'pane-four', name: 'four', color: 'red', now: 4 });
        h.sync();
        expect(listener.mock.calls.length).toBe(seen);
    });
});
