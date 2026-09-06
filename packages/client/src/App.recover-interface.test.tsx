/**
 * View ▸ Recover Interface, the client's half (issue #79).
 *
 * `chrome/gesture-reset.test.ts` asserts the registry and `sidebar-resizer-lockout.test.tsx`
 * asserts what a reset does to a live drag. This one asserts the part neither can see: that the
 * shell's `menu-command` relay actually reaches `resetGestures`, so the row on the menu and the
 * function that unsticks a gesture are wired to each other.
 *
 * The two halves meet at the command string, which is stated in both packages (the shell cannot
 * be imported from here) and pinned in both suites - `shell/src/menu.test.ts` holds the other
 * one. A rename on either side fails here rather than producing a row that relays into nothing.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { RECOVER_INTERFACE_COMMAND } from './app/file-menu';
import { registerGestureReset } from './chrome/gesture-reset';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
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

function setup(): { socket: () => FakeWebSocket } {
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
    return { socket: () => sockets.last() };
}

afterEach(cleanup);

describe('View ▸ Recover Interface (#79)', () => {
    it('the shell’s relay reaches every registered gesture reset', () => {
        const h = setup();
        const reset = vi.fn();
        const off = registerGestureReset(reset);
        try {
            act(() => {
                h.socket().emit({ type: 'menu-command', command: RECOVER_INTERFACE_COMMAND });
            });
            expect(reset).toHaveBeenCalledWith('manual');
        } finally {
            off();
        }
    });

    it('sends nothing to the daemon: recovery is entirely local', () => {
        const h = setup();
        const before = h.socket().messages().length;

        act(() => {
            h.socket().emit({ type: 'menu-command', command: RECOVER_INTERFACE_COMMAND });
        });

        // No reload, no navigation, no state reset - the row must be safe to hit at any moment,
        // including one where the daemon is the thing that is stuck.
        expect(h.socket().messages().length).toBe(before);
    });

    it('is inert when nothing is stuck', () => {
        const h = setup();
        expect(() =>
            act(() => {
                h.socket().emit({ type: 'menu-command', command: RECOVER_INTERFACE_COMMAND });
            })
        ).not.toThrow();
    });

    it('pins the command string the shell states independently', () => {
        expect(RECOVER_INTERFACE_COMMAND).toBe('recover-interface');
    });
});
