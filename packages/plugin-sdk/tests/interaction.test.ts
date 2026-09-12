import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { InteractionSnapshot, ViewAPI } from '../index.js';

const snapshot = (query = ''): InteractionSnapshot => ({
    placement: 'interaction.palette', formFactor: 'desktop', visible: true, paletteOpen: true,
    palette: { sessionID: 'session-1', query, scope: 'all', items: [], selectedID: null, remoteWorkspaceSelected: false },
    // Notifications stay bundled in this release, so no frame carries one.
    prompt: null, queued: 0, notifications: [],
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
    const messages = (): any[] => port.postMessage.mock.calls.map(([message]) => message);
    const calls = (): any[] => messages().filter(message => message.type === 'call');
    const acks = (topic: string): number[] => messages().filter(message => message.type === `${topic}-ack`).map(message => message.sequence);
    const receive = (data: unknown): Promise<void> => Promise.resolve(port.onmessage({ data }));
    const connect = (): void => { events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'private' }, ports: [port] }); };
    const push = (sequence: number, query = `query ${sequence}`): Promise<void> => receive({ type: 'interaction', sequence, value: snapshot(query) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}

describe('browser window interaction presenter', () => {
    it('reads the current snapshot and marshals every presenter call', async () => {
        const h = harness();
        const reading = h.api.ui.getInteraction(); h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getInteraction', args: {} });
        await h.reply(h.calls()[0], snapshot()); expect(await reading).toEqual(snapshot());
        const pending = [
            h.api.ui.reportPresenterReady(),
            h.api.ui.setPaletteQuery('session-1', 'settings'),
            h.api.ui.setPaletteSelection('session-1', null),
            h.api.ui.activatePaletteItem('session-1', 'kelpi.window.openSettings'),
            h.api.ui.dismissPalette('session-1'),
            h.api.ui.respondInteraction('request-1', null),
        ];
        await tick();
        expect(h.calls().slice(1).map(message => [message.method, message.args])).toEqual([
            ['ui.reportPresenterReady', {}],
            ['ui.setPaletteQuery', { sessionID: 'session-1', text: 'settings' }],
            ['ui.setPaletteSelection', { sessionID: 'session-1', itemID: null }],
            ['ui.activatePaletteItem', { sessionID: 'session-1', itemID: 'kelpi.window.openSettings' }],
            ['ui.dismissPalette', { sessionID: 'session-1' }],
            ['ui.respondInteraction', { requestID: 'request-1', value: null }],
        ]);
        for (const message of h.calls().slice(1)) await h.reply(message, null);
        expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });

    it('coalesces slow presenters, acknowledges in order and stays independent of chrome', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred(), observed = vi.fn(() => held.promise), chrome = vi.fn();
        const stop = h.api.ui.onInteraction(observed); await tick();
        h.api.ui.onChrome(chrome);
        await h.receive({ type: 'chrome', sequence: 1, value: { workspace: null } });
        const second = h.push(2), third = h.push(3); await tick();
        expect(observed).toHaveBeenCalledOnce(); expect(chrome).toHaveBeenCalledOnce();
        stop(); await Promise.all([second, third]);
        expect(h.acks('interaction')).toEqual([1, 2, 3]); expect(h.acks('chrome')).toEqual([1]);
        expect(observed).toHaveBeenCalledOnce();
        const current = vi.fn(); h.api.ui.onInteraction(current); await tick();
        expect(current).toHaveBeenCalledExactlyOnceWith(snapshot('query 3'));
        expect(Object.isFrozen(current.mock.calls[0]![0].palette)).toBe(true);
        h.events.get('pagehide')?.(); await h.push(4); expect(current).toHaveBeenCalledOnce();
        held.resolve();
    });

    it('bounds presenter listeners and reports an unavailable placement to the view that asked', async () => {
        const h = harness(); h.connect();
        const onError = vi.fn(), listener = vi.fn();
        h.api.ui.onInteraction(() => {}, onError); await tick();
        expect(h.calls()).toHaveLength(1); expect(h.calls()[0].method).toBe('ui.getInteraction');
        const stops = Array.from({ length: 63 }, () => h.api.ui.onInteraction(() => {}));
        expect(() => h.api.ui.onInteraction(() => {})).toThrow(/Too many interaction listeners/);
        for (const stop of stops) stop();
        await h.reply(h.calls()[0], null, 'Interaction presentation is unavailable for this view.'); await tick();
        expect(h.calls()).toHaveLength(1);
        h.api.ui.onInteraction(listener); await tick();
        expect(listener).not.toHaveBeenCalled();
        expect(onError.mock.calls[0]![0].message).toContain('unavailable');
    });
});
