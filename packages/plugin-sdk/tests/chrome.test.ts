import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { ChromeSnapshot, ViewAPI } from '../index.js';
const snapshot = (name = 'Workspace'): ChromeSnapshot => ({ workspace: { name } } as ChromeSnapshot);
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
    const acks = (): number[] => port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'chrome-ack').map(message => message.sequence);
    const receive = (data: unknown): Promise<void> => Promise.resolve(port.onmessage({ data }));
    const connect = (): void => { events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'private' }, ports: [port] }); };
    const push = (sequence: number, name = `Workspace ${sequence}`): Promise<void> => receive({ type: 'chrome', sequence, value: snapshot(name) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}


describe('browser window chrome', () => {
    it('routes exact command targets and receives current snapshots', async () => {
        const h = harness();
        const reading = h.api.ui.getChrome(); h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getChrome', args: {} });
        await h.reply(h.calls()[0], snapshot()); expect(await reading).toEqual(snapshot());
        const execution = h.api.ui.executeChromeCommand('kelpi.layout.select.tiled', { workspaceID: 'workspace' });
        await tick(); expect(h.calls()[1]).toMatchObject({ method: 'ui.executeChromeCommand', args: { id: 'kelpi.layout.select.tiled', target: { workspaceID: 'workspace' } } });
        await h.reply(h.calls()[1], null); expect(await execution).toBeUndefined();
    });
    it('coalesces slow subscribers, cancels pending delivery, and keeps navigation independent', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred(), observed = vi.fn(() => held.promise), navigation = vi.fn();
        const stop = h.api.ui.onChrome(observed); await tick();
        h.api.ui.onNavigation(navigation);
        await h.receive({ type: 'navigation', sequence: 1, value: { hosts: [], active: null } });
        const second = h.push(2), third = h.push(3); await tick();
        expect(observed).toHaveBeenCalledOnce(); expect(navigation).toHaveBeenCalledOnce();
        stop(); await Promise.all([second, third]); expect(h.acks()).toEqual([1, 2, 3]);
        expect(observed).toHaveBeenCalledOnce();
        const current = vi.fn(); h.api.ui.onChrome(current); await tick();
        expect(current).toHaveBeenCalledExactlyOnceWith(snapshot('Workspace 3'));
        expect(Object.isFrozen(current.mock.calls[0]![0].workspace)).toBe(true);
        h.events.get('pagehide')?.(); await h.push(4); expect(current).toHaveBeenCalledOnce();
        held.resolve();
    });
    it('resnapshots only once on initial subscribe and never applies an obsolete reply', async () => {
        const h = harness(), first = vi.fn(), second = vi.fn();
        h.api.ui.onChrome(first); h.api.ui.onChrome(second); h.connect(); await tick();
        expect(h.calls()).toHaveLength(1); expect(h.calls()[0].method).toBe('ui.getChrome');
        await h.push(1, 'Current'); await h.reply(h.calls()[0], snapshot('Obsolete')); await tick();
        expect(first).toHaveBeenCalledExactlyOnceWith(snapshot('Current'));
        expect(second).toHaveBeenCalledExactlyOnceWith(snapshot('Current'));
    });
    it('reports unavailable chrome only to a view that requested it', async () => {
        const h = harness(); h.connect(); await tick(); expect(h.calls()).toHaveLength(0);
        const onError = vi.fn(), listener = vi.fn(); h.api.ui.onChrome(listener, onError); await tick();
        await h.reply(h.calls()[0], null, 'Window chrome is unavailable in this window.'); await tick();
        expect(listener).not.toHaveBeenCalled(); expect(onError.mock.calls[0]![0].message).toContain('unavailable');
    });
});
