/**
 * #307 - a workspace created in the BACKGROUND must not take the window.
 *
 * An agent runs `kelpi workspace create` while the user types in a pane. The daemon adds the
 * workspace without revealing it or moving its own active workspace, and this client must then
 * stay where it was: the same active workspace, the same ring, `document.activeElement` still in
 * the user's terminal. What it does instead is point at the new row: scroll it into view and
 * give it a short highlight (`app/new-workspace-cue.ts`).
 *
 * The other half is the window's own gesture: a create from the window sends `focus: true`, and
 * the client activates what it created from the reply.
 *
 * Assembly-level on purpose: the defect is about which workspace the window shows and who holds
 * the caret after a real delta lands, which no unit below `App` can see.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState, type DomainAction } from '@kelpi/daemon/store';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, selectActiveWorkspaceID, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_W2 = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

interface Harness {
    readonly runtime: KelpiRuntime;
    socket(): FakeWebSocket;
    /** Apply `action` to the daemon's store and ship what it emitted as the next delta. */
    daemon(action: DomainAction): void;
}

async function setup(): Promise<Harness> {
    const daemonStore = createDaemonStore(emptyDaemonState('/Users/test'));
    daemonStore.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });

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
    const renderers = createFakeRendererFactory({ autoFocusOnOpen: true });
    render(<App runtime={runtime} createRenderer={renderers.factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: daemonStore.getState() as unknown as JsonObject });
    });
    let seq = 0;
    let pending: unknown[] = [];
    daemonStore.subscribe((batch) => {
        pending.push(...batch);
    });
    return {
        runtime,
        socket: () => sockets.last(),
        daemon(action) {
            daemonStore.dispatch(action);
            const events = JSON.parse(JSON.stringify(pending)) as JsonObject[];
            pending = [];
            seq += 1;
            act(() => {
                sockets.last().emit({ type: 'delta', seq, events });
            });
        }
    };
}

function rowOf(workspaceID: string): HTMLElement | null {
    return document.querySelector(`[data-testid="workspace-row"][data-workspace-id="${workspaceID}"]`);
}

/** The user's terminal in W1 holds the caret. */
async function userTypingInW1(): Promise<{ h: Harness; caret: Element }> {
    const h = await setup();
    const host = await waitFor(() => {
        const found = document.querySelector(`[data-pane-id="${PANE_A}"] [data-terminal-host]`);
        expect(found).not.toBeNull();
        return found as HTMLElement;
    });
    await waitFor(() => {
        expect(host.contains(document.activeElement)).toBe(true);
    });
    return { h, caret: document.activeElement as Element };
}

afterEach(cleanup);

describe('a workspace the daemon creates in the background leaves the window alone (#307)', () => {
    it('stays on the user\'s workspace and pane, and points at the new row instead', async () => {
        const { h, caret } = await userTypingInW1();
        h.daemon({ type: 'create-workspace', id: W2, paneID: PANE_W2, name: 'worker', color: 'red', now: NOW, focus: false });

        await waitFor(() => {
            expect(rowOf(W2)).not.toBeNull();
        });
        expect(selectActiveWorkspaceID(h.runtime.store.getState())).toBe(W1);
        expect(rowOf(W1)?.getAttribute('data-active')).toBe('true');
        expect(rowOf(W2)?.getAttribute('data-active')).toBe('false');
        expect(document.activeElement).toBe(caret);
        // The cue: the new row wears the highlight, the user's does not.
        await waitFor(() => {
            expect(rowOf(W2)?.getAttribute('data-just-created')).toBe('true');
        });
        expect(rowOf(W1)?.hasAttribute('data-just-created')).toBe(false);
        // Nothing was asked of the daemon about the new workspace: no activation, no visibility
        // report, no focus. (The client's activation rides `reportVisibility`, keyed on the id.)
        expect(JSON.stringify(h.socket().messages())).not.toContain(W2);
    });

    it('does not highlight what it attached to: the first snapshot is adopted', async () => {
        await userTypingInW1();
        expect(document.querySelector('[data-just-created]')).toBeNull();
    });
});
