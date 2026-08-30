/**
 * §WS-100 — the sidebar's one-shot scroll target is set by EVERY path that makes a workspace
 * active, not only by this client's own `workspace-create` reply.
 *
 * The Swift sets it inside `setActiveWorkspace` (`AppReducer.swift:1434-1452`), so ⌘1–9,
 * next/previous, a sidebar click, the menu-bar popover, a notification's "Open" and the palette
 * all inherit it for free. The port activates through a bridge call, so each caller has to go
 * through assembly's `activateWorkspaceAndReveal` — which is exactly what this pins down, one
 * gesture at a time. (The palette's own path has its own file, `App.palette-jump.test.tsx`.)
 *
 * jsdom has no layout, so the sidebar's reveal takes its no-box-model branch and hands the row
 * to `scrollIntoView` — which is the observable end of the mechanism, and the same thing
 * `App.palette-jump.test.tsx` asserts.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const W3 = 'AAAAAAAA-0000-4000-8000-000000000003';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_C = 'DDDDDDDD-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W3, paneID: PANE_C, name: 'gamma', color: 'red', now: NOW });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

let scrolled: Element[] = [];

function mount(): { store: ReturnType<typeof createKelpiStore> } {
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    scrolled.length = 0;
    return { store };
}

/** The sidebar row for a workspace, or the element the reveal handed to `scrollIntoView`. */
function rowFor(name: string): HTMLElement | undefined {
    return screen.getAllByTestId('workspace-row').find((row) => row.textContent?.includes(name));
}

function revealed(name: string): boolean {
    const row = rowFor(name);
    if (row === undefined) return false;
    return scrolled.some((element) => element === row || element.contains(row));
}

beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element): void {
        scrolled.push(this);
    };
});

afterEach(cleanup);

describe('every activation path queues the sidebar reveal (§WS-100)', () => {
    it('⌘2 — switch_to_workspace_N', async () => {
        const { store } = mount();
        act(() => {
            fireEvent.keyDown(window, { code: 'Digit2', key: '2', metaKey: true });
        });
        expect(store.getState().ui.activeWorkspaceID).toBe(W2);
        await waitFor(() => {
            expect(revealed('beta')).toBe(true);
        });
    });

    it('next / previous workspace', async () => {
        const { store } = mount();
        act(() => {
            fireEvent.keyDown(window, { code: 'ArrowDown', key: 'ArrowDown', metaKey: true, altKey: true });
        });
        expect(store.getState().ui.activeWorkspaceID).toBe(W2);
        await waitFor(() => {
            expect(revealed('beta')).toBe(true);
        });

        scrolled.length = 0;
        act(() => {
            fireEvent.keyDown(window, { code: 'ArrowUp', key: 'ArrowUp', metaKey: true, altKey: true });
        });
        expect(store.getState().ui.activeWorkspaceID).toBe(W1);
        await waitFor(() => {
            expect(revealed('alpha')).toBe(true);
        });
    });

    it('a plain click on a sidebar row', async () => {
        const { store } = mount();
        const gamma = rowFor('gamma');
        expect(gamma).toBeDefined();
        act(() => {
            fireEvent.click(gamma as HTMLElement);
        });
        expect(store.getState().ui.activeWorkspaceID).toBe(W3);
        await waitFor(() => {
            expect(revealed('gamma')).toBe(true);
        });
    });

    /**
     * The socket path. `kelpi workspace create` is revealed to every attached client by the
     * daemon; this client's handler for that message is its `setActiveWorkspace`, so it queues
     * the reveal exactly like the local gestures do.
     */
    it('a reveal pushed by the daemon (the CLI’s own create)', async () => {
        const sockets = createFakeSocketFactory();
        const store = createKelpiStore();
        const runtime = createKelpiRuntime({
            url: 'ws://daemon.test/ws',
            token: 'tok',
            socketFactory: sockets.factory,
            store,
            notifications: null,
            tokenStorage: null,
            heartbeatIntervalMs: 0,
            backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
        });
        render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
        act(() => {
            completeHandshake(sockets.last(), { state: snapshotState() });
        });
        scrolled.length = 0;

        act(() => {
            sockets.last().emit({ type: 'reveal-pane', workspaceID: W3, paneID: PANE_C });
        });
        await waitFor(() => {
            expect(store.getState().ui.activeWorkspaceID).toBe(W3);
        });
        await waitFor(() => {
            expect(revealed('gamma')).toBe(true);
        });
    });
});
