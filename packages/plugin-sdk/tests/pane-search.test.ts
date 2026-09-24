import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { PaneSearchSnapshot, ViewAPI } from '../index.js';

/**
 * The `pane.search` half of the browser SDK, against the packaged `browser.js`.
 *
 * Its sibling is `pane-chrome.test.ts` and the shape is the same, with the same thing worth saying
 * out loud: the pane search feed has to be INDEPENDENT of the other four. A window can have a
 * Settings presenter, an interaction presenter, a header presenter and a find-bar presenter
 * attached to different views at once, and a `pane-search` frame acknowledging a `pane-chrome`
 * sequence (or the other way round) would clear somebody else's liveness watchdog.
 *
 * The second thing this file is for is the absence of a verb: there is no way to OPEN a search from
 * a presenter, and that has to be asserted rather than assumed.
 */
const snapshot = (needle = 'anchor', total: number | null = 17): PaneSearchSnapshot => ({
    placement: 'pane.search',
    formFactor: 'desktop',
    visible: true,
    paneID: 'pane-1',
    kind: 'shell',
    needle,
    needleTruncated: false,
    caseSensitive: false,
    total,
    selected: total === null ? null : 2,
    match: { line: 412, col: 6, length: needle.length, linesFromBottom: 12 },
    box: { x: 526, y: 8, width: 266, height: 35 }
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
    const push = (sequence: number, needle = 'anchor'): Promise<void> => receive({ type: 'pane-search', sequence, value: snapshot(needle) });
    const reply = (message: any, result: unknown, error?: string): Promise<void> => receive({ type: 'reply', id: message.id, result, error });
    return { api, connect, port, events, calls, acks, receive, push, reply, log };
}

describe('browser window pane search presenter', () => {
    it('reads the current frame and marshals every presenter call', async () => {
        const h = harness();
        const reading = h.api.ui.getPaneSearch(); h.connect(); await tick();
        expect(h.calls()[0]).toMatchObject({ method: 'ui.getPaneSearch', args: {} });
        await h.reply(h.calls()[0], snapshot()); expect(await reading).toEqual(snapshot());
        const pending = [
            h.api.ui.reportPresenterReady(),
            h.api.ui.setSearchNeedle('pane-1', 'marker'),
            h.api.ui.setSearchCaseSensitive('pane-1', true),
            h.api.ui.searchNext('pane-1'),
            h.api.ui.searchPrevious('pane-1'),
            h.api.ui.setSearchBoxSize('pane-1', { width: 320, height: 56 }),
            h.api.ui.setSearchBoxSize('pane-1', null),
            h.api.ui.closeSearch('pane-1'),
        ];
        await tick();
        expect(h.calls().slice(1).map(message => [message.method, message.args])).toEqual([
            ['ui.reportPresenterReady', {}],
            ['ui.setSearchNeedle', { paneID: 'pane-1', text: 'marker' }],
            ['ui.setSearchCaseSensitive', { paneID: 'pane-1', on: true }],
            ['ui.searchNext', { paneID: 'pane-1' }],
            ['ui.searchPrevious', { paneID: 'pane-1' }],
            // Copied field by field rather than passed through, so nothing a caller hung off the
            // object reaches the host.
            ['ui.setSearchBoxSize', { paneID: 'pane-1', size: { width: 320, height: 56 } }],
            // `null` survives the marshalling: it is a withdrawal, not a missing argument.
            ['ui.setSearchBoxSize', { paneID: 'pane-1', size: null }],
            ['ui.closeSearch', { paneID: 'pane-1' }],
        ]);
        for (const message of h.calls().slice(1)) await h.reply(message, null);
        expect(await Promise.all(pending)).toEqual(pending.map(() => undefined));
    });

    it('offers no way to open a search, and no way to reveal a match', async () => {
        // Opening stays ⌘F, the menu, the palette row and `terminal.search`. A presenter that could
        // open the bar could put a text field over any pane at any moment; and the reveal belongs to
        // the terminal renderer, which receives search through its own contract.
        const h = harness();
        const ui = h.api.ui as unknown as Record<string, unknown>;
        expect(ui['openSearch']).toBeUndefined();
        expect(ui['toggleSearch']).toBeUndefined();
        expect(ui['revealMatch']).toBeUndefined();
    });

    it('keeps the domain search verb, which is a named plugin acting under its own identity', async () => {
        const h = harness(); h.connect();
        void h.api.terminal.search('ws-1', 'toggle'); await tick();
        // It is a WS command rather than a `ui.*` call, which is the point: it is the domain verb a
        // named plugin already had, not a presenter grant riding in on this placement.
        expect(h.calls().at(-1)).toMatchObject({
            method: 'command',
            args: { payload: { command: 'terminal-search', action: 'toggle', workspace_id: 'ws-1' } }
        });
    });

    it('coalesces slow presenters, acknowledges in order and stays independent of the other feeds', async () => {
        const h = harness(); h.connect(); await h.push(1);
        const held = deferred(), observed = vi.fn(() => held.promise), chrome = vi.fn();
        const stop = h.api.ui.onPaneSearch(observed); await tick();
        h.api.ui.onPaneChrome(chrome);
        await h.receive({ type: 'pane-chrome', sequence: 1, value: { placement: 'pane.chrome' } });
        const second = h.push(2), third = h.push(3, 'later'); await tick();
        expect(observed).toHaveBeenCalledOnce(); expect(chrome).toHaveBeenCalledOnce();
        stop(); await Promise.all([second, third]);
        expect(h.acks('pane-search')).toEqual([1, 2, 3]); expect(h.acks('pane-chrome')).toEqual([1]);
        expect(observed).toHaveBeenCalledOnce();
        const current = vi.fn(); h.api.ui.onPaneSearch(current); await tick();
        expect(current).toHaveBeenCalledExactlyOnceWith(snapshot('later'));
        expect(Object.isFrozen(current.mock.calls[0]![0].box)).toBe(true);
        h.events.get('pagehide')?.(); await h.push(4); expect(current).toHaveBeenCalledOnce();
        held.resolve();
    });

    it('bounds presenter listeners and reports an unavailable placement to the view that asked', async () => {
        const h = harness(); h.connect();
        const onError = vi.fn(), listener = vi.fn();
        h.api.ui.onPaneSearch(() => {}, onError); await tick();
        expect(h.calls()).toHaveLength(1); expect(h.calls()[0].method).toBe('ui.getPaneSearch');
        const stops = Array.from({ length: 63 }, () => h.api.ui.onPaneSearch(() => {}));
        expect(() => h.api.ui.onPaneSearch(() => {})).toThrow(/Too many pane-search listeners/);
        for (const stop of stops) stop();
        await h.reply(h.calls()[0], null, 'Pane search is unavailable for this view.'); await tick();
        expect(h.calls()).toHaveLength(1);
        h.api.ui.onPaneSearch(listener); await tick();
        expect(listener).not.toHaveBeenCalled();
        expect(onError.mock.calls[0]![0].message).toContain('unavailable');
    });
});
