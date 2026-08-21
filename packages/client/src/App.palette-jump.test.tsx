/**
 * §APP-037 — confirming a command-palette row scrolls the destination into view.
 *
 * The Swift's `AppReducer+CommandPalette.swift:76-114` sets the sidebar's scroll target when a
 * row is confirmed, so a workspace that was off-screen (or inside a collapsed group) is visible
 * when it becomes active. The port activated it and left the sidebar where it was.
 *
 * jsdom has no layout, so what is asserted is the call the sidebar makes on the destination's
 * own row element — which is the mechanism, and the only observable part of it anywhere.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createNexRuntime, createNexStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    // The client's active workspace is its own: leave alpha active and jump to beta.
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

afterEach(cleanup);

describe('command palette jump', () => {
    it('scrolls the confirmed workspace’s row into view', async () => {
        const scrolled: Element[] = [];
        Element.prototype.scrollIntoView = function (this: Element): void {
            scrolled.push(this);
        };
        const sockets = createFakeSocketFactory();
        const store = createNexStore();
        const runtime = createNexRuntime({
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

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input');
        act(() => {
            fireEvent.change(input as HTMLInputElement, { target: { value: 'beta' } });
        });
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        expect(row.textContent).toContain('beta');
        scrolled.length = 0;
        act(() => {
            fireEvent.click(row);
        });

        expect(store.getState().ui.activeWorkspaceID).toBe(W2);
        await waitFor(() => {
            // The sidebar's own row for the destination is what got scrolled.
            const rows = screen.getAllByTestId('workspace-row');
            const beta = rows.find((candidate) => candidate.textContent?.includes('beta'));
            expect(beta).toBeDefined();
            expect(scrolled.some((element) => element === beta || element.contains(beta as Node))).toBe(true);
        });
        vi.restoreAllMocks();
    });
});
