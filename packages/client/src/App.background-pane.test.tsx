/**
 * #295 - a pane opened in the BACKGROUND must not take the keyboard.
 *
 * An agent in one pane runs `kelpi pane split` (or `pane create`, `web open`, `open notes.md`)
 * while the user types in another. The daemon adds the pane without moving `focusedPaneID`, and
 * this client must then leave the DOM caret exactly where it was: in the terminal the user is
 * typing into. Three things could still steal it, and each is exercised here:
 *
 *   - the new terminal's engine, whose `open()` ends with an unconditional `this.focus()`
 *     (`autoFocusOnOpen` models it), and which the pane's mount-time undo has to hand back;
 *   - WEB-002's blank-pane rule, which gives a blank web pane's URL bar the caret on arrival;
 *   - a markdown pane's own mount.
 *
 * The other half is the window's own gestures: ⌘D and ⌘⇧O still send `focus: true`, and when the
 * daemon answers with the new pane focused, the caret follows it.
 *
 * Assembly-level on purpose: the defect is about who holds `document.activeElement` after a real
 * delta lands, which no unit below `App` can see.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState, type DomainAction } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory, type FakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_NEW = 'DDDDDDDD-0000-4000-8000-000000000009';
const TAB_NEW = 'EEEEEEEE-0000-4000-8000-000000000009';
const NOW = 1_755_500_000_000;
/** Past every mount-time caret handoff window (`CARET_HANDOFF_BUDGET_MS` is 1.5 s). */
const SETTLE_MS = 1700;

interface Harness {
    readonly renderers: FakeRendererFactory;
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    /** Apply `action` to the daemon's store and ship the result as the next delta. */
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
    await settle();
    let seq = 0;
    return {
        renderers,
        socket: () => sockets.last(),
        commands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        daemon(action) {
            daemonStore.dispatch(action);
            const workspace = daemonStore.getState().workspaces[0] as unknown as JsonObject;
            seq += 1;
            act(() => {
                sockets.last().emit({ type: 'delta', seq, events: [{ kind: 'workspace-upserted', id: W1, workspace }] });
            });
        }
    };
}

async function settle(ms = SETTLE_MS): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, ms));
    });
}

function hostOf(paneID: string): HTMLElement {
    const host = document.querySelector(`[data-pane-id="${paneID}"] [data-terminal-host]`);
    expect(host).not.toBeNull();
    return host as HTMLElement;
}

function ringOn(): string | null {
    return document.querySelector('[data-pane-id][data-focused="true"]')?.getAttribute('data-pane-id') ?? null;
}

/** The user's terminal holds the caret: its engine's own textarea, focused at open. */
async function userTypingInA(): Promise<{ h: Harness; caret: Element }> {
    const h = await setup();
    const host = hostOf(PANE_A);
    await waitFor(() => {
        expect(host.contains(document.activeElement)).toBe(true);
    });
    expect(ringOn()).toBe(PANE_A);
    return { h, caret: document.activeElement as Element };
}

afterEach(cleanup);

describe('a pane the daemon adds in the background leaves the caret alone (#295)', () => {
    it('a background terminal split: the new engine\'s own grab is handed back to the user\'s pane', async () => {
        const { h, caret } = await userTypingInA();
        h.daemon({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PANE_NEW,
            direction: 'horizontal',
            sourcePaneID: PANE_A,
            now: NOW,
            focus: false
        });
        await waitFor(() => {
            expect(h.renderers.instances.length).toBeGreaterThanOrEqual(2);
        });
        expect(document.querySelector(`[data-pane-id="${PANE_NEW}"]`)).not.toBeNull();
        await settle();
        expect(document.activeElement).toBe(caret);
        expect(hostOf(PANE_NEW).contains(document.activeElement)).toBe(false);
        expect(ringOn()).toBe(PANE_A);
    });

    it('a background BLANK web pane: WEB-002 does not hand its URL bar the caret', async () => {
        const { h, caret } = await userTypingInA();
        h.daemon({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PANE_NEW,
            tabID: TAB_NEW,
            url: '',
            sourcePaneID: PANE_A,
            now: NOW,
            focus: false
        });
        await waitFor(() => {
            expect(document.querySelector(`[data-testid="web-url-${PANE_NEW}"]`)).not.toBeNull();
        });
        await settle();
        expect(document.activeElement).toBe(caret);
        expect(ringOn()).toBe(PANE_A);
    });

    it('a background markdown preview leaves the caret in the user\'s terminal', async () => {
        const { h, caret } = await userTypingInA();
        h.daemon({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PANE_NEW,
            filePath: '/Users/test/notes.md',
            sourcePaneID: PANE_A,
            now: NOW,
            focus: false
        });
        await waitFor(() => {
            expect(document.querySelector(`[data-pane-id="${PANE_NEW}"]`)).not.toBeNull();
        });
        await settle();
        expect(document.activeElement).toBe(caret);
        expect(ringOn()).toBe(PANE_A);
    });
});

describe('the window\'s own gestures still focus the new pane (#295)', () => {
    it('⌘D sends focus: true, and the caret follows the daemon\'s focus into the new terminal', async () => {
        const { h } = await userTypingInA();
        fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-split', pane_id: PANE_A, focus: true });
        });
        // Play the daemon's answer to a focusing split.
        h.daemon({ type: 'focus-pane', workspaceID: W1, paneID: PANE_A });
        h.daemon({ type: 'split-pane', workspaceID: W1, paneID: PANE_NEW, direction: 'horizontal', sourcePaneID: PANE_A, now: NOW, focus: true });
        await waitFor(() => {
            expect(ringOn()).toBe(PANE_NEW);
        });
        await settle();
        expect(hostOf(PANE_NEW).contains(document.activeElement)).toBe(true);
    });

    it('⌘⇧O sends focus: true, and a focused blank web pane gives its URL bar the caret', async () => {
        const { h } = await userTypingInA();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyO', key: 'O', metaKey: true, shiftKey: true });
        });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'web-open', url: 'about:blank', focus: true });
        });
        h.daemon({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PANE_NEW,
            tabID: TAB_NEW,
            url: '',
            now: NOW,
            focus: true
        });
        await waitFor(() => {
            expect(ringOn()).toBe(PANE_NEW);
        });
        await waitFor(() => {
            expect(document.activeElement?.getAttribute('data-testid')).toBe(`web-url-${PANE_NEW}`);
        });
    });
});
