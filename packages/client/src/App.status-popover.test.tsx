/**
 * §APP-076 — the status footer's count popover hands the caret to the destination pane.
 *
 * The Swift makes the destination surface first responder *while the popover still holds key*
 * (`StatusBarView.swift:303-316`), so the main window's own responder restoration cannot revert
 * the selection back to the pane the user came from. The port's equivalent is the double
 * hand-off in `onSelectStatusPane`: `focusPaneSurface` now, and again on the next animation
 * frame — the second one is the load-bearing half, because a jump that CROSSES workspaces has
 * no destination pane mounted at all when the row is clicked (the row itself is a button that is
 * about to unmount with the popover).
 *
 * That is what this drives: a running agent in a workspace the client is NOT looking at, a click
 * on its popover row, and then the three things the jump owes — the workspace switched, the
 * daemon was told which pane has focus, and the DOM focus landed inside the destination pane's
 * own terminal host, which did not exist when the click happened.
 *
 * jsdom cannot make a `<div>` the active element, so what is recorded is the `focus()` call and
 * the element it was made on — the same way `App.reveal-paths.test.tsx` records `scrollIntoView`.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PANE_A = 'dddddddd-0000-4000-8000-000000000001';
const PANE_B = 'dddddddd-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

/**
 * alpha is active and boring; beta — somewhere else entirely — has the running agent.
 * `localWaiter` additionally parks an agent awaiting input in alpha, the same-workspace case.
 */
function snapshotState(options: { localWaiter?: boolean } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    store.dispatch({
        type: 'pane-agent-event',
        paneID: PANE_B,
        workspaceID: W2,
        now: NOW,
        event: { type: 'setPaneStatus', status: 'running' }
    });
    if (options.localWaiter === true) {
        store.dispatch({
            type: 'pane-agent-event',
            paneID: PANE_A,
            workspaceID: W1,
            now: NOW,
            event: { type: 'setPaneStatus', status: 'waitingForInput' }
        });
    }
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

let focused: Element[] = [];
let realFocus: () => void;

beforeEach(() => {
    focused = [];
    realFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function record(this: HTMLElement): void {
        focused.push(this);
    };
});

afterEach(() => {
    HTMLElement.prototype.focus = realFocus;
    cleanup();
});

interface Harness {
    readonly store: ReturnType<typeof createKelpiStore>;
    socket(): FakeWebSocket;
}

function mount(options: { localWaiter?: boolean } = {}): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState(options) });
    });
    focused.length = 0;
    return { store, socket: () => sockets.last() };
}

/** The terminal host the renderer opens inside a pane, if that pane is mounted at all. */
function terminalHost(paneID: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-pane-id="${paneID}"] [data-terminal-host]`);
}

/** The focus reports this client put on the wire, in order (`connection/commands.ts`). */
function focusReports(socket: FakeWebSocket): { workspaceID: string; paneID: string | null }[] {
    return socket
        .messages()
        .filter((message) => message['type'] === 'focus-report')
        .map((message) => ({
            workspaceID: String(message['workspaceID'] ?? ''),
            paneID: message['paneID'] === null ? null : String(message['paneID'] ?? '')
        }));
}

describe('the status footer’s count popover (§APP-076)', () => {
    it('jumps across workspaces and lands the caret on the destination surface', async () => {
        const harness = mount();

        // Precondition, and the whole reason the hand-off has to be deferred: the destination
        // pane is in another workspace, so nothing of it is on screen yet.
        expect(harness.store.getState().ui.activeWorkspaceID).toBe(W1);
        expect(terminalHost(PANE_B)).toBeNull();
        expect(screen.getByTestId('count-running').getAttribute('data-count')).toBe('1');

        act(() => {
            fireEvent.click(screen.getByTestId('count-running'));
        });
        const row = screen.getAllByTestId('bucket-row')[0] as HTMLElement;
        expect(row.textContent).toContain('beta');

        act(() => {
            fireEvent.click(row);
        });

        // 1. the workspace switched…
        expect(harness.store.getState().ui.activeWorkspaceID).toBe(W2);
        // …and the popover closed behind it.
        expect(screen.queryByTestId('bucket-popover')).toBeNull();

        // 2. …the daemon was told which pane now has focus…
        await waitFor(() => {
            expect(focusReports(harness.socket())).toContainEqual({ workspaceID: W2, paneID: PANE_B });
        });

        // 3. …and the caret landed inside the destination pane, on the host that did not exist
        //    when the row was clicked. Without the second, frame-deferred hand-off this is the
        //    assertion that fails: the first call finds no host and the click is swallowed.
        await waitFor(() => {
            const host = terminalHost(PANE_B);
            expect(host).not.toBeNull();
            expect(focused.some((element) => element === host || host?.contains(element) === true)).toBe(true);
        });
    });

    /**
     * The same hand-off inside one workspace, where the destination IS mounted — the first
     * (synchronous) call is the one that lands, and the popover must still close and report.
     */
    it('jumps to a pane in the workspace already on screen', async () => {
        const harness = mount({ localWaiter: true });
        expect(screen.getByTestId('count-waiting').getAttribute('data-count')).toBe('1');

        act(() => {
            fireEvent.click(screen.getByTestId('count-waiting'));
        });
        const row = screen.getAllByTestId('bucket-row')[0] as HTMLElement;
        expect(row.textContent).toContain('alpha');
        focused.length = 0;
        act(() => {
            fireEvent.click(row);
        });

        expect(harness.store.getState().ui.activeWorkspaceID).toBe(W1);
        await waitFor(() => {
            const host = terminalHost(PANE_A);
            expect(host).not.toBeNull();
            expect(focused.some((element) => element === host || host?.contains(element) === true)).toBe(true);
        });
        expect(focusReports(harness.socket())).toContainEqual({ workspaceID: W1, paneID: PANE_A });
    });
});
