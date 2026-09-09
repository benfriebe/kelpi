import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { KelpiError, type ViewAPI } from '../index.js';

describe('injected browser SDK', () => {
    it('keeps interactive requests alive beyond the ordinary RPC deadline', async () => {
        vi.useFakeTimers();
        try {
            const events = new Map<string, (...args: any[]) => void>();
            const parent = { postMessage: vi.fn() };
            const port = { start: vi.fn(), postMessage: vi.fn(), onmessage: (_event: any): void | Promise<void> => {} };
            const context = vm.createContext({
                __KELPI_VIEW__: { nonce: 'prompt', state: {}, stateVersion: 1, context: { daemonID: 'D' } },
                parent, TextEncoder, setTimeout, clearTimeout, console,
                document: { documentElement: { style: { setProperty: vi.fn() } } },
                addEventListener: (name: string, listener: (...args: any[]) => void) => events.set(name, listener),
                removeEventListener: (name: string) => events.delete(name),
            });
            const shared = fs.readFileSync(new URL('../api.js', import.meta.url), 'utf8').replace(/^export /gm, '');
            vm.runInContext(`(()=>{${shared}\n${fs.readFileSync(new URL('../browser.js', import.meta.url), 'utf8')}})()`, context);
            const api = (context as typeof context & { kelpi: ViewAPI }).kelpi;
            events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'prompt' }, ports: [port] });
            const settled = vi.fn();
            const prompts = Promise.all([
                api.ui.showQuickPick({ title: 'Pick', items: [{ id: 'one', label: 'One' }] }),
                api.ui.showInput({ title: 'Name' }),
                api.ui.showDialog({ title: 'Confirm', message: 'Continue?', actions: [{ id: 'yes', label: 'Yes' }] }),
                api.ui.showNotification({ message: 'Done' })
            ]).then(value => { settled(value); return value; });
            const ordinary = api.workspaces.list().catch(error => error);
            await vi.advanceTimersByTimeAsync(36_000);
            expect(await ordinary).toMatchObject({ code: 'TRANSPORT_ERROR', message: 'Kelpi call timed out' });
            expect(settled).not.toHaveBeenCalled();
            const calls = port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'call' && message.method.startsWith('ui.show'));
            expect(calls.map(message => message.method)).toEqual(['ui.showQuickPick', 'ui.showInput', 'ui.showDialog', 'ui.showNotification']);
            for (const [index, message] of calls.entries()) await port.onmessage({ data: { type: 'reply', id: message.id, result: ['one', 'Late name', 'yes', null][index] } });
            expect(await prompts).toEqual(['one', 'Late name', 'yes', null]);
        } finally { vi.useRealTimers(); }
    });

    it('shares the typed facade and waits for the private host channel', async () => {
        const events = new Map<string, (...args: any[]) => void>();
        const parent = { postMessage: vi.fn() };
        const port = { start: vi.fn(), postMessage: vi.fn((message: any) => {
            if (message.type !== 'call') return;
            queueMicrotask(() => { void port.onmessage({ data: { type: 'reply', id: message.id, result: { ok: true, workspaces: [{ id: 'W', pane_count: 3 }] } } }); });
        }), onmessage: (_event: any): void | Promise<void> => {} };
        const scope = {
            __KELPI_VIEW__: { nonce: 'private', state: {}, stateVersion: 1, context: { daemonID: 'D' } },
            parent, TextEncoder, setTimeout, clearTimeout, console,
            document: { documentElement: { style: { setProperty: vi.fn() } } },
            addEventListener: (name: string, listener: (...args: any[]) => void) => events.set(name, listener),
            removeEventListener: (name: string) => events.delete(name),
        };
        const context = vm.createContext(scope);
        const shared = fs.readFileSync(new URL('../api.js', import.meta.url), 'utf8').replace(/^export /gm, '');
        const browser = fs.readFileSync(new URL('../browser.js', import.meta.url), 'utf8');
        vm.runInContext(`(()=>{${shared}\n${browser}})()`, context);
        const api = (context as typeof context & { kelpi: ViewAPI }).kelpi;
        const observed = vi.fn(); const stopObserving = api.onContext(observed);
        const cancelled = vi.fn(); api.onContext(cancelled)();
        const listing = api.workspaces.list();
        await Promise.resolve(); expect(port.postMessage).not.toHaveBeenCalled();
        events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'wrong' }, ports: [port] });
        expect(port.start).not.toHaveBeenCalled();
        events.get('message')?.({ source: parent, data: { type: 'kelpi-plugin-connect', nonce: 'private' }, ports: [port] });
        expect(await listing).toEqual([{ id: 'W', paneCount: 3 }]);
        expect(observed).toHaveBeenCalledWith(expect.objectContaining({ context: { daemonID: 'D' }, visible: true, stateVersion: 1 }));
        expect(cancelled).not.toHaveBeenCalled();
        expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'call', method: 'command', args: { payload: { command: 'workspace-list' }, context: {} } }));
        expect(api.terminal).toHaveProperty('capture');
        expect(api.ui).toHaveProperty('focusPane');
        expect(api.commands).not.toHaveProperty('register');
        expect(api).not.toHaveProperty('providers');
        await port.onmessage({ data: { type: 'context', value: { visible: false, chords: ['8/KeyK'] } } });
        expect(observed).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
        const calls = port.postMessage.mock.calls.length;
        const key = { metaKey: true, code: 'KeyK', preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
        events.get('focusin')?.({}); events.get('pointerdown')?.({}); events.get('keydown')?.(key);
        expect(port.postMessage).toHaveBeenCalledTimes(calls);
        expect(key.preventDefault).not.toHaveBeenCalled();
        await port.onmessage({ data: { type: 'context', value: { visible: true } } });
        events.get('keydown')?.(key);
        expect(key.preventDefault).toHaveBeenCalledOnce();
        expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'key', code: 'KeyK' }));
        const environmentCalls = observed.mock.calls.length;
        const queuedUpdate = port.onmessage({ data: { type: 'context', value: { visible: false } } });
        stopObserving(); await queuedUpdate;
        expect(observed).toHaveBeenCalledTimes(environmentCalls);
        const workbench = { slots: [{ id: 'sidebar.primary', title: 'Left sidebar', viewID: 'kelpi.workspaces' }], views: [], activeTabs: {} };
        port.postMessage.mockImplementation((message: any) => {
            queueMicrotask(() => { void port.onmessage({ data: { type: 'reply', id: message.id, result: message.method === 'ui.getWorkbench' ? workbench : null } }); });
        });
        expect(await api.ui.getWorkbench()).toEqual(workbench);
        expect(await api.ui.selectView('sidebar.primary', 'sample.board.home')).toBeUndefined();
        expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'ui.selectView', args: { slot: 'sidebar.primary', viewID: 'sample.board.home' } }));
        await api.ui.activateTab('sample.board.container', 'sample.board.second');
        expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'ui.activateTab', args: { containerID: 'sample.board.container', slotID: 'sample.board.second' } }));
        port.postMessage.mockImplementation((message: any) => {
            queueMicrotask(() => { void port.onmessage({ data: { type: 'reply', id: message.id, error: 'view detached' } }); });
        });
        const error = await api.workspaces.list().catch(error => error);
        expect(error).toBeInstanceOf(KelpiError);
        expect(error).toMatchObject({ code: 'TRANSPORT_ERROR', message: 'view detached' });
    });
});
