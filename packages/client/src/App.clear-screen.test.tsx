/**
 * ⌘K over a terminal pane, assembled.
 *
 * The chord is a bound action (`clear_screen`) that asks the daemon to clear the focused pane
 * (`clear-screen`), because the history is the daemon's. The whole client against a scripted
 * daemon socket, so what is asserted is the wire traffic.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

async function setup() {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    // The action declines until the pane has a live renderer, which is what registers its handle.
    await waitFor(() =>
        expect(
            document.querySelector(`[data-pane-id="${PANE_A}"][data-terminal-status]`)?.getAttribute('data-terminal-status')
        ).toBe('live')
    );
    const frames = (): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command')
            .filter((message) => (message['payload'] as Record<string, unknown>)['command'] === 'clear-screen');
    return {
        cleared: () => frames().map((message) => (message['payload'] as Record<string, unknown>)['pane_id']),
        reply(reply: Record<string, unknown>) {
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frames().at(-1)?.['id'], reply });
            });
        }
    };
}

const pressClear = (): boolean => fireEvent.keyDown(window, { code: 'KeyK', key: 'k', metaKey: true });

afterEach(() => {
    cleanup();
});

describe('⌘K over a terminal pane', () => {
    it('asks the daemon to clear the focused pane', async () => {
        const h = await setup();

        pressClear();

        expect(h.cleared()).toEqual([PANE_A]);
    });

    it('consumes the chord, so no `k` reaches the terminal behind it', async () => {
        await setup();

        // `fireEvent` answers false when a listener called preventDefault.
        expect(pressClear()).toBe(false);
    });

    it('says so when the daemon refuses', async () => {
        const h = await setup();

        pressClear();
        h.reply({ ok: false, error: 'pane not found: gone' });

        expect(await screen.findByText('pane not found: gone')).toBeTruthy();
    });

    it('leaves the chord alone while it is unbound', async () => {
        const h = await setup();

        fireEvent.keyDown(window, { code: 'KeyK', key: 'k', metaKey: true, shiftKey: true });

        expect(h.cleared()).toEqual([]);
    });
});
