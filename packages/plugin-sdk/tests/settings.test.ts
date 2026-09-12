import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsPresenterSnapshot, ViewAPI } from '../index.js';

const snapshot = (sectionID = 'general', dirty = 0): SettingsPresenterSnapshot => ({
    placement: 'settings.window', formFactor: 'desktop', visible: true,
    sections: [
        { id: 'general', title: 'General', icon: 'gearshape', native: false },
        // Plugins is the recovery floor: it is listed so a presenter can route to it, and drawn
        // by the bundled panel whatever is selected.
        { id: 'plugins', title: 'Plugins', icon: 'puzzlepiece.extension', native: true },
    ],
    sectionID, native: sectionID === 'plugins',
    groups: sectionID === 'plugins' ? [] : [{ id: 'general.window', title: 'Window' }],
    fields: sectionID === 'plugins' ? [] : [{
        id: 'general.confirmQuit', sectionID: 'general', groupID: 'general.window', kind: 'toggle',
        label: 'Confirm before quitting', detail: 'Ask before closing the last window.', value: true,
    }],
    dirty,
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
    const push = (sequence: number, sectionID = 'general'): Promise<void> => receive({ type: 'settings', sequence, value: snapshot(sectionID, sequence) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}

describe('browser window Settings presenter', () => {
    it('reads the current projection and marshals every presenter call', async () => {
        const h = harness();
        const reading = h.api.ui.getSettingsPresentation(); h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getSettingsPresentation', args: {} });
        await h.reply(h.calls()[0], snapshot()); expect(await reading).toEqual(snapshot());
        const pending = [
            h.api.ui.reportPresenterReady(),
            h.api.ui.setSettingsSection('appearance'),
            h.api.ui.setSettingsDraft('general.tcpPort', '19400'),
            h.api.ui.commitSettingsField('general.tcpPort'),
            h.api.ui.resetSettingsField('general.tcpPort'),
            h.api.ui.closeSettings(),
        ];
        await tick();
        expect(h.calls().slice(1).map(message => [message.method, message.args])).toEqual([
            ['ui.reportPresenterReady', {}],
            ['ui.setSettingsSection', { id: 'appearance' }],
            ['ui.setSettingsDraft', { fieldID: 'general.tcpPort', text: '19400' }],
            ['ui.commitSettingsField', { fieldID: 'general.tcpPort' }],
            ['ui.resetSettingsField', { fieldID: 'general.tcpPort' }],
            ['ui.closeSettings', {}],
        ]);
        for (const message of h.calls().slice(1)) await h.reply(message, null);
        expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });

    it('coalesces slow presenters, acknowledges in order and stays independent of interaction', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred(), observed = vi.fn(() => held.promise), interaction = vi.fn();
        const stop = h.api.ui.onSettingsPresentation(observed); await tick();
        h.api.ui.onInteraction(interaction);
        await h.receive({ type: 'interaction', sequence: 1, value: { placement: 'interaction.prompts' } });
        const second = h.push(2), third = h.push(3, 'plugins'); await tick();
        expect(observed).toHaveBeenCalledOnce(); expect(interaction).toHaveBeenCalledOnce();
        stop(); await Promise.all([second, third]);
        expect(h.acks('settings')).toEqual([1, 2, 3]); expect(h.acks('interaction')).toEqual([1]);
        expect(observed).toHaveBeenCalledOnce();
        const current = vi.fn(); h.api.ui.onSettingsPresentation(current); await tick();
        expect(current).toHaveBeenCalledExactlyOnceWith(snapshot('plugins', 3));
        expect(Object.isFrozen(current.mock.calls[0]![0].sections[0])).toBe(true);
        h.events.get('pagehide')?.(); await h.push(4); expect(current).toHaveBeenCalledOnce();
        held.resolve();
    });

    it('bounds presenter listeners and reports an unavailable placement to the view that asked', async () => {
        const h = harness(); h.connect();
        const onError = vi.fn(), listener = vi.fn();
        h.api.ui.onSettingsPresentation(() => {}, onError); await tick();
        expect(h.calls()).toHaveLength(1); expect(h.calls()[0].method).toBe('ui.getSettingsPresentation');
        const stops = Array.from({ length: 63 }, () => h.api.ui.onSettingsPresentation(() => {}));
        expect(() => h.api.ui.onSettingsPresentation(() => {})).toThrow(/Too many settings listeners/);
        for (const stop of stops) stop();
        await h.reply(h.calls()[0], null, 'Settings presentation is unavailable for this view.'); await tick();
        expect(h.calls()).toHaveLength(1);
        h.api.ui.onSettingsPresentation(listener); await tick();
        expect(listener).not.toHaveBeenCalled();
        expect(onError.mock.calls[0]![0].message).toContain('unavailable');
    });
});
