import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { NavigationSnapshot, ViewAPI } from '../index.js';

const snapshot = (name = 'Workspace'): NavigationSnapshot => ({
    hosts: [{ id: 'opaque-local', kind: 'local', name: 'This daemon', connection: 'connected', workspaces: [
        { id: 'workspace', name, color: 'blue', paneCount: 2, group: null },
    ] }],
    active: { hostID: 'opaque-local', workspaceID: 'workspace' },
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}
async function tick(): Promise<void> { for (let index = 0; index < 8; index++) await Promise.resolve(); }

function harness() {
    const events = new Map<string, (...args: any[]) => void>();
    const parent = { postMessage: vi.fn() };
    const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: (_event: any): void | Promise<void> => {} };
    const log = { ...console, error: vi.fn() };
    const context = vm.createContext({
        __KELPI_VIEW__: { nonce: 'private', state: {}, stateVersion: 1, context: { daemonID: 'owner' } },
        parent, TextEncoder, setTimeout, clearTimeout, console: log,
        document: { documentElement: { style: { setProperty: vi.fn() } } },
        addEventListener: (name: string, listener: (...args: any[]) => void) => events.set(name, listener),
        removeEventListener: (name: string) => events.delete(name),
    });
    const shared = fs.readFileSync(new URL('../api.js', import.meta.url), 'utf8').replace(/^export /gm, '');
    vm.runInContext(`(()=>{${shared}\n${fs.readFileSync(new URL('../browser.js', import.meta.url), 'utf8')}})()`, context);
    const api = (context as typeof context & { kelpi: ViewAPI }).kelpi;
    const calls = (): any[] => port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'call');
    const acks = (): number[] => port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'navigation-ack').map(message => message.sequence);
    const receive = (data: unknown): Promise<void> => Promise.resolve(port.onmessage({ data }));
    const connect = (): void => { events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'private' }, ports: [port] }); };
    const push = (sequence: number, name = `Workspace ${sequence}`): Promise<void> => receive({ type: 'navigation', sequence, value: snapshot(name) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}

describe('browser window navigation', () => {
    it('exposes bounded local UI calls with exact opaque selection arguments', async () => {
        const h = harness();
        const listing = h.api.ui.getNavigation();
        await tick(); expect(h.calls()).toHaveLength(0);
        h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getNavigation', args: {} });
        await h.reply(h.calls()[0], snapshot());
        expect(await listing).toEqual(snapshot());
        const selection = h.api.ui.selectWorkspace('opaque-remote', 'workspace-on-remote');
        await tick();
        expect(h.calls()[1]).toMatchObject({ method: 'ui.selectWorkspace', args: { hostID: 'opaque-remote', workspaceID: 'workspace-on-remote' } });
        await h.reply(h.calls()[1], null);
        expect(await selection).toBeUndefined();
    });

    it('delivers the cached initial snapshot and live updates without extra requests', async () => {
        const h = harness(); h.connect();
        await h.push(1, 'Initial');
        const observed = vi.fn(), cancelled = vi.fn();
        const stop = h.api.ui.onNavigation(observed);
        h.api.ui.onNavigation(cancelled)();
        await tick();
        expect(observed).toHaveBeenCalledExactlyOnceWith(snapshot('Initial'));
        expect(cancelled).not.toHaveBeenCalled();
        expect(h.calls()).toHaveLength(0);
        await h.push(2, 'Live');
        expect(observed).toHaveBeenLastCalledWith(snapshot('Live'));
        expect(h.acks()).toEqual([1, 2]);
        const value = observed.mock.calls[0]![0];
        expect(Object.isFrozen(value.hosts[0].workspaces[0])).toBe(true);
        stop(); await h.push(3);
        expect(observed).toHaveBeenCalledTimes(2);
        expect(h.acks()).toEqual([1, 2, 3]);
    });

    it('uses one initial request for listeners, and ignores a stale reply after a feed update', async () => {
        const h = harness();
        const first = vi.fn(), second = vi.fn();
        h.api.ui.onNavigation(first); h.api.ui.onNavigation(second);
        h.connect(); await tick();
        expect(h.calls()).toHaveLength(1);
        await h.push(1, 'Newer feed state');
        expect(first).toHaveBeenCalledExactlyOnceWith(snapshot('Newer feed state'));
        await h.reply(h.calls()[0], snapshot('Obsolete RPC state'));
        await tick();
        expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
        await h.push(2, 'Next');
        expect(first).toHaveBeenCalledTimes(2);
    });

    it('gets an initial snapshot by RPC if the feed has not arrived, then accepts sequence one', async () => {
        const h = harness(); h.connect();
        const observed = vi.fn(); h.api.ui.onNavigation(observed);
        await tick();
        await h.reply(h.calls()[0], snapshot('RPC initial'));
        await tick();
        expect(observed).toHaveBeenCalledExactlyOnceWith(snapshot('RPC initial'));
        await h.push(1, 'Feed initial');
        expect(observed).toHaveBeenLastCalledWith(snapshot('Feed initial'));
        expect(h.acks()).toEqual([1]);
    });

    it('waits for async listeners before acknowledging and retains only their latest queued value', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred();
        const observed = vi.fn(async (value: NavigationSnapshot) => { if (value.hosts[0]!.workspaces[0]!.name === 'Workspace 1') await held.promise; });
        h.api.ui.onNavigation(observed); await tick();
        const second = h.push(2), third = h.push(3);
        await tick();
        expect(observed).toHaveBeenCalledOnce();
        expect(h.acks()).toEqual([1]);
        held.resolve(); await Promise.all([second, third]);
        expect(observed.mock.calls.map(([value]) => value.hosts[0]!.workspaces[0]!.name)).toEqual(['Workspace 1', 'Workspace 3']);
        expect(h.acks()).toEqual([1, 2, 3]);
    });

    it('unsubscribe releases a never-settling listener and cancels its pending delivery', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const observed = vi.fn(() => new Promise<void>(() => {}));
        const stop = h.api.ui.onNavigation(observed); await tick();
        const queued = h.push(2); await tick();
        expect(h.acks()).toEqual([1]);
        stop(); await queued;
        expect(observed).toHaveBeenCalledOnce();
        expect(h.acks()).toEqual([1, 2]);
        const healthy = vi.fn(); h.api.ui.onNavigation(healthy); await tick();
        expect(healthy).toHaveBeenCalledExactlyOnceWith(snapshot('Workspace 2'));
    });

    it('isolates rejected listeners so healthy listeners and acknowledgements continue', async () => {
        const h = harness(); h.connect(); await h.push(1);
        h.api.ui.onNavigation(async () => { throw new Error('author callback'); });
        const observed = vi.fn(); h.api.ui.onNavigation(observed); await tick();
        await h.push(2);
        expect(observed).toHaveBeenCalledTimes(2);
        expect(h.log.error).toHaveBeenCalledWith('plugin navigation listener', expect.objectContaining({ message: 'author callback' }));
        expect(h.acks()).toEqual([1, 2]);
    });

    it('reports an unavailable owner to subscribers without sending unsolicited errors', async () => {
        const h = harness(); h.connect(); await tick();
        expect(h.port.postMessage).not.toHaveBeenCalled();
        const observed = vi.fn(), errors = vi.fn();
        h.api.ui.onNavigation(observed, errors); await tick();
        await h.reply(h.calls()[0], null, 'Workbench UI is unavailable for this daemon in this window.');
        await tick();
        expect(observed).not.toHaveBeenCalled();
        expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Workbench UI is unavailable for this daemon in this window.' }));
        expect(h.port.postMessage.mock.calls.some(([message]) => message.type === 'view-error')).toBe(false);
    });

    it('delivers size errors on the same bounded channel and reports a view error only when unhandled', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const errors = vi.fn(); h.api.ui.onNavigation(() => {}, errors); await tick();
        await h.receive({ type: 'navigation-error', sequence: 2, error: 'Navigation snapshot exceeds 256 KiB.' });
        expect(errors).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Navigation snapshot exceeds 256 KiB.' }));
        expect(h.acks()).toEqual([1, 2]);
        expect(h.port.postMessage.mock.calls.some(([message]) => message.type === 'view-error')).toBe(false);
        h.api.ui.onNavigation(() => {}); await tick();
        expect(h.port.postMessage).toHaveBeenCalledWith({ type: 'view-error', message: 'Navigation snapshot exceeds 256 KiB.' });
        await h.push(3, 'Recovered');
        expect(h.acks()).toEqual([1, 2, 3]);
    });

    it('cancels queued work and releases busy callbacks when the view is disposed', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const observed = vi.fn(() => new Promise<void>(() => {}));
        h.api.ui.onNavigation(observed); await tick();
        const queued = h.push(2); await tick();
        h.events.get('pagehide')?.({});
        await queued; await h.push(3);
        expect(observed).toHaveBeenCalledOnce();
        expect(h.acks()).toEqual([1]);
        expect(() => h.api.ui.onNavigation(() => {})).toThrow('disposal');
    });
});
