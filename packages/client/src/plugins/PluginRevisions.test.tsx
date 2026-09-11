import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { decodePluginManifest, type JsonObject, type PluginInfo, type PluginRevisionInfo } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandReply } from '../connection';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from '../state';
import { PluginRevisions } from './PluginRevisions';
import { PluginsTab } from './PluginsTab';
import { WorkbenchProvider, useWorkbenchLayout } from './Workbench';

const ID = 'sample.revisions', CURRENT = 'c'.repeat(64), OLD = 'a'.repeat(64), BLOCKED = 'b'.repeat(64);
const plugin: PluginInfo = { manifest: decodePluginManifest({ id: ID, name: 'Versioned Plugin', version: '2.0.0', apiVersion: 1, trust: 'full' }),
    revision: CURRENT, instanceID: 'epoch:1', enabled: true, status: 'running', error: null };
const retained: PluginRevisionInfo[] = [
    { manifest: plugin.manifest, revision: CURRENT, installedAt: 1_750_000_000_000, selected: true, problem: null },
    { manifest: { ...plugin.manifest, version: '1.0.0' }, revision: OLD, installedAt: null, selected: false, problem: null },
    { manifest: { ...plugin.manifest, version: '0.9.0' }, revision: BLOCKED, installedAt: 1_740_000_000_000, selected: false, problem: 'Saved view state version 2 is incompatible with version 1.' },
];
const runtimes: KelpiRuntime[] = [];
afterEach(() => { cleanup(); for (const runtime of runtimes.splice(0)) runtime.dispose(); localStorage.clear(); vi.restoreAllMocks(); });
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const reply = (entries: PluginRevisionInfo[]): CommandReply => ({ ok: true, result: entries as never });
function setup() {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: 'ws://versions.test/ws', socketFactory: sockets.factory, notifications: null });
    runtimes.push(runtime);
    let installed = plugin;
    const read = vi.fn<() => Promise<CommandReply>>().mockResolvedValue(reply(retained));
    const write = vi.fn<(args: JsonObject) => Promise<CommandReply>>().mockResolvedValue({ ok: true, result: null });
    const calls = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        const args = JSON.parse(String(payload['text'])) as JsonObject;
        switch (payload['action']) {
            case 'history': return read();
            case 'rollback': return write(args);
            case 'list': return { ok: true, result: [installed] as never };
            case 'identity': return { ok: true, result: { daemonID: 'version-daemon' } };
            case 'settings': return { ok: true, result: {} };
            case 'services': return { ok: true, result: [] };
            default: return { ok: true, result: null };
        }
    });
    runtime.connect(); completeHandshake(sockets.last());
    const changed = (next = installed): void => {
        installed = next;
        sockets.last().emit({ type: 'plugins-changed', plugins: [next], epoch: 'epoch', daemonID: 'version-daemon' });
    };
    return { runtime, sockets, read, write, calls, changed };
}
function Tab(props: { runtime: KelpiRuntime }) {
    const layout = useWorkbenchLayout(props.runtime);
    return <WorkbenchProvider layout={layout} runtime={props.runtime} chords={[]}><PluginsTab runtime={props.runtime} /></WorkbenchProvider>;
}
const chooseOld = () => screen.getByRole('button', { name: `Use version 1.0.0 (${OLD.slice(0, 12)})` }) as HTMLButtonElement;
const row = (revision: string) => document.querySelector<HTMLElement>(`[data-plugin-revision="${revision}"]`)!;
async function expand(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'Versions' }));
    await waitFor(() => expect(row(CURRENT)?.textContent).toContain('Current'));
}

describe('retained plugin versions in Settings', () => {
    it('loads on demand and shows current code, dates and an actionable compatibility reason', async () => {
        const h = setup(), selectRevision = vi.fn(async () => true);
        render(<PluginRevisions runtime={h.runtime} plugin={plugin} busy={false} selectRevision={selectRevision} />);
        expect(h.read).not.toHaveBeenCalled();
        await expand();
        expect(h.calls).toHaveBeenCalledWith({ command: 'plugin', action: 'history', text: JSON.stringify({ pluginID: ID }) }, { timeoutMs: 35_000 });
        expect(row(CURRENT).querySelector('code')?.getAttribute('title')).toBe(CURRENT);
        expect(row(CURRENT).querySelector('time')?.dateTime).toBe(new Date(retained[0]!.installedAt!).toISOString());
        expect(row(OLD).textContent).toContain('Installation date unavailable');
        expect(chooseOld().disabled).toBe(false);
        const blocked = within(row(BLOCKED)).getByRole('button') as HTMLButtonElement;
        expect(blocked.disabled).toBe(true);
        expect(document.getElementById(blocked.getAttribute('aria-describedby')!)?.textContent).toBe(retained[2]!.problem);
        fireEvent.click(blocked); expect(selectRevision).not.toHaveBeenCalled();
        expect(within(row(CURRENT)).queryByRole('button')).toBeNull();
    });

    it('sends the explicit full revision, shares pending state, preserves current on failure and keeps bundled recovery reachable', async () => {
        const h = setup(), request = deferred<CommandReply>(); h.write.mockReturnValueOnce(request.promise);
        render(<Tab runtime={h.runtime} />); await expand();
        fireEvent.click(chooseOld()); fireEvent.click(chooseOld());
        expect(h.write).toHaveBeenCalledExactlyOnceWith({ pluginID: ID, revision: OLD });
        expect(chooseOld().disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Refresh versions' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Restore bundled views' }) as HTMLButtonElement).disabled).toBe(false);
        expect(row(CURRENT).textContent).toContain('Current');
        await act(async () => request.resolve({ ok: false, error: 'Activation failed; the previous revision was restored.' }));
        expect(screen.getByRole('alert').textContent).toContain('previous revision was restored');
        expect(row(CURRENT).textContent).toContain('Current');
        expect(chooseOld().disabled).toBe(false);
        expect(h.read).toHaveBeenCalledTimes(1);
    });

    it('refreshes from the committed lifecycle broadcast and allows switching a disabled or failed plugin for recovery', async () => {
        const h = setup();
        h.write.mockImplementation(async () => {
            const next = { ...plugin, manifest: retained[1]!.manifest, revision: OLD, instanceID: 'epoch:2', enabled: false, status: 'disabled' as const };
            h.read.mockResolvedValue(reply(retained.map(entry => ({ ...entry, selected: entry.revision === OLD }))));
            h.changed(next); return { ok: true, result: [next] as never };
        });
        render(<Tab runtime={h.runtime} />); await expand(); fireEvent.click(chooseOld());
        await waitFor(() => expect(row(OLD)?.textContent).toContain('Current'));
        expect(within(row(CURRENT)).getByRole('button')).toBeTruthy();
        expect((within(row(CURRENT)).getByRole('button') as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
        expect(h.read.mock.calls.length).toBeGreaterThan(1);
        act(() => h.changed({ ...plugin, revision: OLD, manifest: retained[1]!.manifest, instanceID: 'epoch:3', status: 'failed', error: 'Backend stopped' }));
        await waitFor(() => expect((within(row(CURRENT)).getByRole('button') as HTMLButtonElement).disabled).toBe(false));
        expect(screen.getByText('Backend stopped')).toBeTruthy();
    });

    it('ignores superseded reads and refreshes compatibility after another plugin changes', async () => {
        const h = setup(), old = deferred<CommandReply>(); h.read.mockReturnValueOnce(old.promise);
        render(<PluginRevisions runtime={h.runtime} plugin={plugin} busy={false} selectRevision={async () => true} />);
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        h.read.mockResolvedValue(reply(retained)); act(() => h.changed());
        await waitFor(() => expect(row(CURRENT)?.textContent).toContain('Current'));
        await act(async () => old.resolve(reply([])));
        expect(row(CURRENT).textContent).toContain('Current');
        const compatibility = deferred<CommandReply>(), reason = 'Required dependency is disabled.';
        expect(chooseOld().disabled).toBe(false);
        h.read.mockReturnValueOnce(compatibility.promise);
        act(() => h.changed());
        expect(screen.getByText('Loading version history…')).toBeTruthy();
        expect(chooseOld().disabled).toBe(true);
        expect(screen.queryByText(reason)).toBeNull();
        await act(async () => compatibility.resolve(reply(retained.map(entry => ({ ...entry, problem: entry.revision === OLD ? reason : entry.problem })))));
        expect(await screen.findByText(reason)).toBeTruthy();
        expect(screen.queryByText('Loading version history…')).toBeNull();
        expect(chooseOld().disabled).toBe(true);
    });

    it.each(['runtime', 'plugin', 'revision', 'instance'] as const)('retires a pending history read when the %s changes', async change => {
        const first = setup(), second = setup(), stale = deferred<CommandReply>();
        first.read.mockReturnValueOnce(stale.promise);
        const view = render(<PluginRevisions runtime={first.runtime} plugin={plugin} busy={false} selectRevision={async () => true} />);
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        const next = { ...plugin,
            ...(change === 'plugin' ? { manifest: { ...plugin.manifest, id: 'sample.other' } } : {}),
            ...(change === 'revision' ? { revision: OLD } : {}), ...(change === 'instance' ? { instanceID: 'epoch:2' } : {}) };
        const fresh = retained.map(entry => ({ ...entry, manifest: { ...entry.manifest, id: next.manifest.id } }));
        first.read.mockResolvedValue(reply(fresh)); second.read.mockResolvedValue(reply(fresh));
        view.rerender(<PluginRevisions runtime={change === 'runtime' ? second.runtime : first.runtime} plugin={next} busy={false} selectRevision={async () => true} />);
        await waitFor(() => expect(row(CURRENT)?.textContent).toContain('Current'));
        await act(async () => stale.resolve({ ok: false, error: 'Stale daemon failure' }));
        expect(screen.queryByText('Stale daemon failure')).toBeNull();
        expect(row(CURRENT).textContent).toContain('Current');
    });

    it('invalidates old-instance replies as soon as a broadcast arrives, before new props commit', async () => {
        const h = setup(), stale = deferred<CommandReply>(); h.read.mockReturnValueOnce(stale.promise);
        const view = render(<PluginRevisions runtime={h.runtime} plugin={plugin} busy={false} selectRevision={async () => true} />);
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        const next = { ...plugin, instanceID: 'epoch:2' };
        act(() => h.changed(next));
        await act(async () => stale.resolve(reply(retained)));
        expect(row(CURRENT)).toBeNull();
        expect(h.read).toHaveBeenCalledTimes(1);
        view.rerender(<PluginRevisions runtime={h.runtime} plugin={next} busy={false} selectRevision={async () => true} />);
        await waitFor(() => expect(row(CURRENT)?.textContent).toContain('Current'));
    });

    it('retries errors and malformed responses, and unsubscribes when collapsed or unmounted', async () => {
        const h = setup(); h.read.mockResolvedValueOnce({ ok: false, error: 'Unable to read retained versions' });
        const view = render(<PluginRevisions runtime={h.runtime} plugin={plugin} busy={false} selectRevision={async () => true} />);
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Unable to read retained versions');
        h.read.mockResolvedValueOnce({ ok: true, result: [{ ...retained[0], revision: 'not a revision' }] as never });
        fireEvent.click(screen.getByRole('button', { name: 'Refresh versions' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('invalid plugin version history'));
        fireEvent.click(screen.getByRole('button', { name: 'Refresh versions' }));
        await waitFor(() => expect(row(CURRENT)?.textContent).toContain('Current'));
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        const calls = h.read.mock.calls.length;
        act(() => h.changed()); expect(h.read).toHaveBeenCalledTimes(calls);
        view.unmount(); act(() => h.changed()); expect(h.read).toHaveBeenCalledTimes(calls);
    });

    it('ignores an old runtime mutation failure while a new runtime can switch immediately', async () => {
        const first = setup(), second = setup(), stale = deferred<CommandReply>(); first.write.mockReturnValueOnce(stale.promise);
        const view = render(<Tab runtime={first.runtime} />); await expand(); fireEvent.click(chooseOld());
        view.rerender(<Tab runtime={second.runtime} />);
        await expand();
        await waitFor(() => expect(chooseOld().disabled).toBe(false));
        fireEvent.click(chooseOld());
        await waitFor(() => expect(second.write).toHaveBeenCalledExactlyOnceWith({ pluginID: ID, revision: OLD }));
        await act(async () => stale.resolve({ ok: false, error: 'Old runtime failure' }));
        expect(screen.queryByText('Old runtime failure')).toBeNull();
        expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not carry a pending switch into another owner on the same mounted panel', async () => {
        const first = setup(), second = setup(), stale = deferred<boolean>(), oldSelect = vi.fn(() => stale.promise), freshSelect = vi.fn(async () => true);
        const view = render(<PluginRevisions runtime={first.runtime} plugin={plugin} busy={false} selectRevision={oldSelect} />);
        await expand(); fireEvent.click(chooseOld());
        view.rerender(<PluginRevisions runtime={second.runtime} plugin={plugin} busy={false} selectRevision={freshSelect} />);
        await waitFor(() => expect(chooseOld().disabled).toBe(false)); fireEvent.click(chooseOld());
        expect(freshSelect).toHaveBeenCalledExactlyOnceWith(OLD);
        await act(async () => stale.reject(new Error('Old switch failed')));
        expect(screen.queryByText('Old switch failed')).toBeNull();
        expect(row(CURRENT).textContent).toContain('Current');
    });

    it('revokes a read on disconnect and loads fresh history after reconnecting', async () => {
        const h = setup(), stale = deferred<CommandReply>(); h.read.mockReturnValueOnce(stale.promise);
        render(<PluginRevisions runtime={h.runtime} plugin={plugin} busy={false} selectRevision={async () => true} />);
        fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
        act(() => h.runtime.connection.close());
        expect(screen.getByRole('alert').textContent).toBe('Reconnect to load version history.');
        expect((screen.getByRole('button', { name: 'Refresh versions' }) as HTMLButtonElement).disabled).toBe(true);
        await act(async () => stale.resolve(reply(retained)));
        expect(row(CURRENT)).toBeNull();
        act(() => { h.runtime.connect(); completeHandshake(h.sockets.last()); });
        await waitFor(() => expect(chooseOld().disabled).toBe(false));
        expect(screen.queryByRole('alert')).toBeNull();
    });
});
