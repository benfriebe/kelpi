import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { PaneChromeSnapshot, ViewAPI } from '../index.js';

/**
 * The `pane.chrome` half of the browser SDK, against the packaged `browser.js`.
 *
 * Its sibling is `settings.test.ts` and the shape is the same, with one thing worth saying out
 * loud: the pane chrome feed has to be INDEPENDENT of the other three. A window can have a Settings
 * presenter, an interaction presenter and a header presenter attached to different views at once,
 * and a `pane-chrome` frame acknowledging an `interaction` sequence (or the other way round) would
 * clear somebody else's liveness watchdog.
 */
const snapshot = (withheld = 0, panes = 1): PaneChromeSnapshot => ({
    placement: 'pane.chrome',
    formFactor: 'desktop',
    visible: true,
    workspaceID: 'ws-1',
    focusedPaneID: 'pane-1',
    zoomedPaneID: null,
    panes: Array.from({ length: panes }, (_, index) => ({
        paneID: `pane-${index + 1}`,
        kind: 'shell',
        status: 'idle',
        focused: index === 0,
        title: '~/code/kelpi',
        titleParts: { head: '~/code', tail: '/kelpi' },
        directory: '~/code/kelpi',
        label: null,
        branch: 'main',
        changes: null,
        agent: null,
        zoom: { zoomed: false, available: true },
        sync: { active: false, excluded: false },
        height: 24,
        rect: { x: 0, y: index * 300, width: 640, height: 21 },
        size: { width: 640, badges: { label: true, agent: true, branch: true }, buttons: 4, folded: 0 },
        // The row a presenter redraws: a display name, an icon name, an enabled flag and a ref.
        controls: [
            { ref: 'c0', kind: 'action', label: 'Split right (⌘D)', icon: 'split-right', enabled: true, pinned: false },
            { ref: 'c1', kind: 'action', label: 'Close pane (⌘W)', icon: 'close', enabled: true, pinned: true }
        ],
        items: [{ ref: 'i0', text: 'Ready', tooltip: null, badge: null, tone: 'success', enabled: true }],
        contributions: 1,
        renaming: false
    })),
    withheld
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
    const push = (sequence: number, withheld = 0): Promise<void> => receive({ type: 'pane-chrome', sequence, value: snapshot(withheld) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}

describe('browser window pane chrome presenter', () => {
    it('reads the current frame and marshals every presenter call', async () => {
        const h = harness();
        const reading = h.api.ui.getPaneChrome(); h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getPaneChrome', args: {} });
        await h.reply(h.calls()[0], snapshot()); expect(await reading).toEqual(snapshot());
        const pending = [
            h.api.ui.reportPresenterReady(),
            h.api.ui.focusChromePane('pane-1'),
            h.api.ui.splitPane('pane-1', 'vertical'),
            h.api.ui.toggleZoom('pane-1'),
            h.api.ui.renamePane('pane-1'),
            h.api.ui.closePane('pane-1'),
            h.api.ui.activatePaneControl('pane-1', 'c0'),
            h.api.ui.runPaneHeaderItem('pane-1', 'i0'),
            h.api.ui.openPaneMenu('pane-1'),
            h.api.ui.beginPaneDrag('pane-1'),
            h.api.ui.setPaneChromeHeight('pane-1', 48),
            h.api.ui.setPaneChromeHeight('pane-1', null),
        ];
        await tick();
        expect(h.calls().slice(1).map(message => [message.method, message.args])).toEqual([
            ['ui.reportPresenterReady', {}],
            ['ui.focusChromePane', { paneID: 'pane-1' }],
            ['ui.splitPane', { paneID: 'pane-1', direction: 'vertical' }],
            ['ui.toggleZoom', { paneID: 'pane-1' }],
            // The FIELD is the host's: the call takes a pane and never a name.
            ['ui.renamePane', { paneID: 'pane-1' }],
            ['ui.closePane', { paneID: 'pane-1' }],
            ['ui.activatePaneControl', { paneID: 'pane-1', ref: 'c0' }],
            ['ui.runPaneHeaderItem', { paneID: 'pane-1', ref: 'i0' }],
            ['ui.openPaneMenu', { paneID: 'pane-1' }],
            // The press stays in the presenter's document; only the fact of it crosses.
            ['ui.beginPaneDrag', { paneID: 'pane-1' }],
            ['ui.setPaneChromeHeight', { paneID: 'pane-1', pixels: 48 }],
            // `null` survives the marshalling: it is a withdrawal, not a missing argument.
            ['ui.setPaneChromeHeight', { paneID: 'pane-1', pixels: null }],
        ]);
        for (const message of h.calls().slice(1)) await h.reply(message, null);
        expect(await Promise.all(pending)).toEqual(pending.map(() => undefined));
    });

    it('keeps the workspace focus verb, which takes two arguments and another placement', async () => {
        const h = harness(); h.connect();
        void h.api.ui.focusPane('ws-1', 'pane-1'); await tick();
        expect(h.calls().at(-1)).toMatchObject({ method: 'ui.focusPane', args: { workspaceID: 'ws-1', paneID: 'pane-1' } });
    });

    it('coalesces slow presenters, acknowledges in order and stays independent of the other feeds', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred(), observed = vi.fn(() => held.promise), settings = vi.fn();
        const stop = h.api.ui.onPaneChrome(observed); await tick();
        h.api.ui.onSettingsPresentation(settings);
        await h.receive({ type: 'settings', sequence: 1, value: { placement: 'settings.window' } });
        const second = h.push(2), third = h.push(3, 2); await tick();
        expect(observed).toHaveBeenCalledOnce(); expect(settings).toHaveBeenCalledOnce();
        stop(); await Promise.all([second, third]);
        expect(h.acks('pane-chrome')).toEqual([1, 2, 3]); expect(h.acks('settings')).toEqual([1]);
        expect(observed).toHaveBeenCalledOnce();
        const current = vi.fn(); h.api.ui.onPaneChrome(current); await tick();
        expect(current).toHaveBeenCalledExactlyOnceWith(snapshot(2));
        expect(Object.isFrozen(current.mock.calls[0]![0].panes[0])).toBe(true);
        h.events.get('pagehide')?.(); await h.push(4); expect(current).toHaveBeenCalledOnce();
        held.resolve();
    });

    it('bounds presenter listeners and reports an unavailable placement to the view that asked', async () => {
        const h = harness(); h.connect();
        const onError = vi.fn(), listener = vi.fn();
        h.api.ui.onPaneChrome(() => {}, onError); await tick();
        expect(h.calls()).toHaveLength(1); expect(h.calls()[0].method).toBe('ui.getPaneChrome');
        const stops = Array.from({ length: 63 }, () => h.api.ui.onPaneChrome(() => {}));
        expect(() => h.api.ui.onPaneChrome(() => {})).toThrow(/Too many pane-chrome listeners/);
        for (const stop of stops) stop();
        await h.reply(h.calls()[0], null, 'Pane chrome is unavailable for this view.'); await tick();
        expect(h.calls()).toHaveLength(1);
        h.api.ui.onPaneChrome(listener); await tick();
        expect(listener).not.toHaveBeenCalled();
        expect(onError.mock.calls[0]![0].message).toContain('unavailable');
    });
});
