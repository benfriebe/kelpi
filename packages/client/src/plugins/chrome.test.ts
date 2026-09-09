import { describe, expect, it, vi } from 'vitest';
import type { KelpiRuntime } from '../state';
import { createPluginChrome, type ChromeSnapshot, type ChromeSource } from './chrome';
import { requestHostUI } from './host-ui';
import { createWindowFeed } from './window-feed';

export function chromeSnapshot(name = 'Workspace'): ChromeSnapshot {
    return { connection: 'connected', ready: true, remoteWorkspaceSelected: false,
        workspace: { id: 'workspace', name, color: 'blue', paneCount: 2, layout: 'tiled', syncInputActive: false, syncedPaneCount: 2 },
        focusedPane: null, sidebars: { left: { viewID: 'kelpi.workspaces', title: 'Workspaces', visible: true }, right: { viewID: 'kelpi.inspector', title: 'Inspector', visible: false } },
        sizeControl: 'this-window', layouts: [], commands: [], agents: { running: 0, waiting: 0, inactive: 0 }, agentPanes: [], git: null, systemStats: null, items: [] };
}
describe('window chrome snapshots and commands', () => {
    it('coalesces committed updates, freezes snapshots, and reads the latest source for requests', async () => {
        const execute = vi.fn(); const model = createPluginChrome({ snapshot: () => chromeSnapshot(), execute });
        const observed = vi.fn(); const stop = model.subscribe(observed);
        const value = observed.mock.calls[0]![0]; expect(Object.isFrozen(value.sidebars.left)).toBe(true);
        model.update({ snapshot: () => chromeSnapshot('Intermediate'), execute });
        model.update({ snapshot: () => chromeSnapshot('Latest'), execute });
        expect(model.getChrome().workspace?.name).toBe('Latest');
        await Promise.resolve(); expect(observed).toHaveBeenCalledTimes(2);
        expect(observed).toHaveBeenLastCalledWith(chromeSnapshot('Latest'));
        model.update({ snapshot: () => chromeSnapshot('Latest'), execute });
        await Promise.resolve(); expect(observed).toHaveBeenCalledTimes(2);
        stop(); model.update({ snapshot: () => chromeSnapshot('Disposed listener'), execute });
        await Promise.resolve(); expect(observed).toHaveBeenCalledTimes(2); model.dispose();
    });
    it('bounds complete message envelopes and recovers from oversized snapshots', async () => {
        const model = createPluginChrome({ snapshot: () => chromeSnapshot('x'.repeat(256 * 1024)), execute: () => {} });
        const observed = vi.fn(), failed = vi.fn(); model.subscribe(observed, failed);
        expect(observed).not.toHaveBeenCalled(); expect(failed.mock.calls[0]![0].message).toContain('256 KiB');
        model.update({ snapshot: () => chromeSnapshot(), execute: () => {} });
        await Promise.resolve(); expect(observed).toHaveBeenCalledOnce(); model.dispose();
    });
    it('retains only the latest snapshot behind a slow frame and requires its exact acknowledgement', async () => {
        const source = (name: string): ChromeSource => ({ snapshot: () => chromeSnapshot(name), execute: () => {} });
        const model = createPluginChrome(source('one')), sent = vi.fn();
        const stop = vi.spyOn(model, 'subscribe');
        const feed = createWindowFeed('chrome', (listener, error) => model.subscribe(listener, error), sent);
        model.update(source('two')); await Promise.resolve(); model.update(source('three')); await Promise.resolve();
        expect(sent).toHaveBeenCalledOnce(); feed.ack(2); feed.ack('1'); expect(sent).toHaveBeenCalledOnce();
        feed.ack(1); expect(sent).toHaveBeenLastCalledWith({ type: 'chrome', sequence: 2, value: chromeSnapshot('three') });
        expect(stop).toHaveBeenCalledOnce(); feed.dispose(); model.update(source('four')); await Promise.resolve();
        feed.ack(2); expect(sent).toHaveBeenCalledTimes(2); model.dispose();
    });
    it('validates targets before dispatch and prevents calls after window disposal', async () => {
        const execute = vi.fn(); const model = createPluginChrome({ snapshot: () => chromeSnapshot(), execute });
        for (const target of [{ workspaceID: '' }, { paneID: 42 }, { daemonID: 'other' }]) expect(() => model.execute('kelpi.pane.focus', target)).toThrow('target');
        expect(() => model.execute('', {})).toThrow('command'); expect(execute).not.toHaveBeenCalled();
        await model.execute('kelpi.pane.focus', { workspaceID: 'one', paneID: 'two' });
        expect(execute).toHaveBeenCalledExactlyOnceWith('kelpi.pane.focus', { workspaceID: 'one', paneID: 'two' });
        model.dispose(); expect(() => model.execute('kelpi.pane.focus', {})).toThrow('disposal');
    });
    it('binds all chrome calls to the owning primary runtime, with explicit unavailable errors', async () => {
        const runtime = {} as KelpiRuntime, other = {} as KelpiRuntime;
        const execute = vi.fn(), chrome = createPluginChrome({ snapshot: () => chromeSnapshot(), execute });
        const host = { runtime, chrome, request: vi.fn(() => null) };
        expect(requestHostUI(host, runtime, 'ui.getChrome', {})).toEqual(chromeSnapshot());
        await requestHostUI(host, runtime, 'ui.executeChromeCommand', { id: 'kelpi.sidebar.left', target: {} });
        expect(execute).toHaveBeenCalledExactlyOnceWith('kelpi.sidebar.left', {});
        expect(() => requestHostUI(host, other, 'ui.getChrome', {})).toThrow('unavailable');
        expect(() => requestHostUI({ ...host, chrome: null }, runtime, 'ui.getChrome', {})).toThrow('unavailable');
        expect(() => requestHostUI(host, runtime, 'ui.executeChromeCommand', { id: 'kelpi.sidebar.left', target: [] })).toThrow('target');
        expect(host.request).not.toHaveBeenCalled(); chrome.dispose();
    });
});
