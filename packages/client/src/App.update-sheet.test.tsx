/**
 * #286: the update sheet, assembled. Inside the desktop app the page draws the shell's update
 * flow from `update-state` frames addressed to its window, acknowledges a revealed one with
 * `update-action` `shown`, and sends its buttons back as `update-action`. In a browser nothing
 * happens: there is no shell window to draw for.
 *
 * The whole client against a scripted daemon socket, so what is asserted is the wire traffic.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'cccccccc-0000-4000-8000-000000000286';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

function setup(shellWindow: string | null): { socket: () => FakeWebSocket; actions: () => Record<string, unknown>[] } {
    window.history.replaceState({}, '', shellWindow === null ? '/' : `/?shellWindow=${shellWindow}`);
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
    return {
        socket: () => sockets.last(),
        actions: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
                .filter((payload) => payload['command'] === 'shell-action' && payload['action'] === 'update-action')
    };
}

const OFFER = {
    type: 'update-state',
    windowID: SHELL_WINDOW,
    seq: 3,
    reveal: true,
    view: { phase: 'available', currentVersion: '0.2.2', version: '0.2.3', notes: '## Fixes\n\n- One' },
    notesHTML: '<h2>Fixes</h2>\n<ul>\n<li>One</li>\n</ul>\n'
};

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('the update sheet in the desktop app (#286)', () => {
    it('draws a revealed offer, acknowledges it, and sends Update Now to this window\'s shell', () => {
        const h = setup(SHELL_WINDOW);
        act(() => {
            h.socket().emit(OFFER);
        });
        expect(screen.getByTestId('update-title').textContent).toBe('Kelpi 0.2.3 is available');
        expect(screen.getByTestId('update-notes').querySelector('h2')?.textContent).toBe('Fixes');
        expect(h.actions()).toEqual([
            expect.objectContaining({ window_id: SHELL_WINDOW, update_action: 'shown', seq: 3 })
        ]);
        fireEvent.click(screen.getByTestId('update-now'));
        expect(h.actions().at(-1)).toMatchObject({ window_id: SHELL_WINDOW, update_action: 'update-now' });
        expect(h.actions().at(-1)?.['seq']).toBeUndefined();

        // The shell answers with the next state; the open sheet follows it.
        act(() => {
            h.socket().emit({ ...OFFER, seq: 4, view: { phase: 'downloading', currentVersion: '0.2.2', version: '0.2.3' } });
        });
        expect(screen.getByTestId('update-title').textContent).toBe('Downloading Kelpi 0.2.3…');
    });

    it('Later closes the sheet and tells the shell', () => {
        const h = setup(SHELL_WINDOW);
        act(() => {
            h.socket().emit(OFFER);
        });
        fireEvent.click(screen.getByTestId('update-later'));
        expect(screen.queryByTestId('update-sheet')).toBeNull();
        expect(h.actions().at(-1)).toMatchObject({ update_action: 'later' });
    });

    it('ignores a frame addressed to another window', () => {
        const h = setup(SHELL_WINDOW);
        act(() => {
            h.socket().emit({ ...OFFER, windowID: 'someone-else' });
        });
        expect(screen.queryByTestId('update-sheet')).toBeNull();
        expect(h.actions()).toEqual([]);
    });

    it('draws nothing in a browser', () => {
        const h = setup(null);
        act(() => {
            h.socket().emit(OFFER);
        });
        expect(screen.queryByTestId('update-sheet')).toBeNull();
        expect(h.actions()).toEqual([]);
    });
});
