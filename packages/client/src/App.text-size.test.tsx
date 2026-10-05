/**
 * ⌘= / ⌘- / ⌘0 over a terminal pane, through the whole client (config-keybindings.md §7.6).
 *
 * The same shape as `App.openflow.test.tsx`: the whole client against a scripted daemon socket,
 * so what is asserted is the wire traffic the chord produces and the size the pane's renderer is
 * built with, not that a handler was called.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function snapshotState(options: { ownSize?: number } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'split-pane', workspaceID: W1, paneID: PANE_B, sourcePaneID: PANE_A, direction: 'horizontal', now: NOW, focus: false });
    if (options.ownSize !== undefined) {
        store.dispatch({ type: 'set-terminal-font-size', workspaceID: W1, paneID: PANE_A, size: options.ownSize });
    }
    return store.getState() as unknown as JsonObject;
}

function setup(options: { ownSize?: number } = {}) {
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const renderers = createFakeRendererFactory();
    const runtime: KelpiRuntime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={renderers.factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState(options) });
    });
    const commands = (name: string): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command')
            .map((message) => message['payload'] as Record<string, unknown>)
            .filter((payload) => payload['command'] === name);
    const setScope = (fontSizeScope: 'pane' | 'all'): void => {
        const current = store.getState().settings.value;
        act(() => {
            store.getState().applySettings({ ...current, general: { ...current.general, fontSizeScope } });
        });
    };
    return { runtime, renderers, commands, setScope };
}

const chord = (code: string, key: string): void => {
    fireEvent.keyDown(window, { code, key, metaKey: true });
};

afterEach(cleanup);

describe('terminal text size, per pane (font-size-scope = pane, the default)', () => {
    it("⌘= asks the daemon for the focused pane's own size, one point over the default", () => {
        const h = setup();
        chord('Equal', '=');
        expect(h.commands('pane-font-size')).toEqual([{ command: 'pane-font-size', pane_id: PANE_A, size: 14 }]);
        expect(h.commands('set-ghostty-setting')).toEqual([]);
    });

    it("⌘- steps from the pane's own size, and ⌘0 drops it", () => {
        const h = setup({ ownSize: 18 });
        chord('Minus', '-');
        chord('Digit0', '0');
        expect(h.commands('pane-font-size')).toEqual([
            { command: 'pane-font-size', pane_id: PANE_A, size: 17 },
            { command: 'pane-font-size', pane_id: PANE_A, reset: true }
        ]);
    });

    it("draws a pane at its own size and leaves the one beside it on the default", () => {
        const h = setup({ ownSize: 18 });
        const sizes = h.renderers.instances.map((renderer) => renderer.options?.fontSize);
        expect(sizes).toContain(18);
        expect(sizes.filter((size) => size === 18)).toHaveLength(1);
    });
});

describe('terminal text size, every pane (font-size-scope = all)', () => {
    it('never sends pane-font-size', () => {
        const h = setup();
        h.setScope('all');
        chord('Equal', '=');
        chord('Digit0', '0');
        expect(h.commands('pane-font-size')).toEqual([]);
    });
});
