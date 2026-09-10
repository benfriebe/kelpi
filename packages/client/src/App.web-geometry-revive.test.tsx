/**
 * Issue #34 - a web pane's page comes back after the connection that placed it went away.
 *
 * The defect is an assembly one: the reporter, the connection and the daemon each behave
 * correctly on their own terms, and the dead state exists only where the three meet. The
 * daemon parks every view a closing connection had placed; the client that reconnects is the
 * SAME client, so its dedupe cache still says "already sent" and the re-render that follows
 * produces nothing. The view then sits in the shell's off-screen holder for ever.
 *
 * So this test drives the wire (drop the socket, hand back a fresh handshake) and reads the
 * wire (did a placement go out again) rather than reaching into the reporter - the reporter's
 * own rules are pinned in `webpane/geometry.test.ts`.
 */

import type { BrowserSnapshot, JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const SHELL_PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const OTHER_PANE = 'DDDDDDDD-0000-4000-8000-000000000002';
const WEB_PANE = 'DDDDDDDD-0000-4000-8000-000000000004';
const WEB_TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'window-under-test';
const NOW = 1_755_500_000_000;

/** The hole the pane's chrome leaves for the page, as a real window would measure it. */
const HOLE = { x: 220, y: 91, width: 529, height: 705 };

const BROWSER_STATE: BrowserSnapshot = {
    paneID: WEB_PANE,
    workspaceID: W1,
    isPrivate: false,
    activeTabID: WEB_TAB,
    tabs: [{ id: WEB_TAB, url: 'https://example.com', title: '', live: true, loading: false, canGoBack: false, canGoForward: false }],
    host: { available: true, id: 'fixture-host', name: 'Kelpi', windowID: SHELL_WINDOW },
    favourites: [],
    inspection: { revision: 0, armed: false, tabID: null, pendingResults: 0, batchVisible: false, batchItems: 0, batchFocusedID: null }
};

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    // W2 first: the newest workspace is the active one, and the fixture has to open on the
    // workspace the web pane lives in. It exists so "the user switched away" is reachable here.
    store.dispatch({ type: 'create-workspace', id: W2, paneID: OTHER_PANE, name: 'other', color: 'red', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W1, paneID: SHELL_PANE, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({
        type: 'open-web-pane',
        workspaceID: W1,
        paneID: WEB_PANE,
        tabID: WEB_TAB,
        url: 'https://example.com',
        now: NOW
    });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    /** Answer every command still outstanding, so the drop below is an IDLE one. */
    settle(): void;
    /** Every geometry report this socket carried, oldest first. */
    reports(socket?: FakeWebSocket): Record<string, unknown>[];
    /** Just the placements - `visible:true`, the ones that put a view on screen. */
    placements(socket?: FakeWebSocket): Record<string, unknown>[];
    /** Drop the socket the way a dead daemon does, and let the backoff redial. */
    drop(): Promise<FakeWebSocket>;
}

function setup(): Harness {
    window.history.replaceState({}, '', `/?shellWindow=${SHELL_WINDOW}`);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: (url) => {
            sockets.factory(url);
            const socket = sockets.last();
            const send = socket.send.bind(socket);
            socket.send = (data) => {
                send(data);
                if (typeof data !== 'string') return;
                const message = JSON.parse(data) as Record<string, unknown>;
                const payload = message['payload'] as Record<string, unknown> | undefined;
                if (message['type'] !== 'command' || payload?.['command'] !== 'plugin' || payload['action'] !== 'browser-state') return;
                expect(JSON.parse(payload['text'] as string)).toEqual({ paneID: WEB_PANE });
                // The assembled browser now confirms native host ownership before placing
                // pixels. Answer that read over the same wire, including after a redial.
                queueMicrotask(() => {
                    if (socket.readyState === 1) socket.emit({ type: 'command-reply', id: message['id'], reply: { ok: true, result: BROWSER_STATE } });
                });
            };
            return socket;
        },
        store: createKelpiStore(),
        notifications: null,
        tokenStorage: null,
        // The heartbeat is the real-world TRIGGER (issue #34), not the defect: any drop reaches
        // the same state, and this test drives the drop directly.
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    const reports = (socket?: FakeWebSocket): Record<string, unknown>[] =>
        (socket ?? sockets.last())
            .messages()
            .filter((message) => message['type'] === 'web-geometry-report' && message['paneID'] === WEB_PANE);
    /**
     * The issue is about a drop while the app is IDLE, and an idle client has no command in
     * flight. A command that is still outstanding when the socket goes rejects, and a rejected
     * command raises a toast - which registers as a modal surface (H1) and legitimately parks
     * every web pane's view for six seconds. That park is correct behaviour and would mask the
     * defect entirely, so the harness settles the handshake's commands first.
     */
    const settle = (): void => {
        const socket = sockets.last();
        const answered = new Set(
            socket
                .messages()
                .filter((message) => message['type'] === 'command-reply')
                .map((message) => message['id'])
        );
        act(() => {
            for (const message of socket.messages()) {
                if (message['type'] !== 'command' || answered.has(message['id'])) continue;
                socket.emit({ type: 'command-reply', id: message['id'], reply: { ok: true } });
            }
        });
    };
    return {
        socket: () => sockets.last(),
        settle,
        reports,
        placements: (socket) => reports(socket).filter((message) => message['visible'] === true),
        async drop() {
            settle();
            const before = sockets.last();
            act(() => {
                before.serverClose();
            });
            // The backoff is 10 ms in this harness; the redial creates the next fake socket.
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 40));
            });
            const next = sockets.last();
            expect(next).not.toBe(before);
            act(() => {
                completeHandshake(next, { state: snapshotState() });
            });
            return next;
        }
    };
}

beforeEach(() => {
    // jsdom lays nothing out, so the pane's hole measures 0×0 and every report would be a
    // degenerate one the daemon normalises to `visible:false`. Only the page hole is stubbed:
    // a blanket stub would move every other measurement in the app.
    const real = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
        if ((this as HTMLElement).dataset?.['testid'] !== `web-page-${WEB_PANE}`) return real.call(this);
        return {
            ...HOLE,
            top: HOLE.y,
            left: HOLE.x,
            right: HOLE.x + HOLE.width,
            bottom: HOLE.y + HOLE.height,
            toJSON: () => ({})
        } as DOMRect;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('a web pane’s view survives the connection that placed it (issue #34)', () => {
    it('places the pane once while the layout is still', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.placements()).toHaveLength(1);
        });
        expect(h.placements()[0]).toMatchObject({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            visible: true,
            shellWindowID: SHELL_WINDOW
        });
        // Rule 1 still holds: nothing moved, so nothing else goes on the wire.
        expect(h.reports()).toHaveLength(1);
    });

    it('re-places it after the socket drops and reconnects, with no user action', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.placements()).toHaveLength(1);
        });

        const next = await h.drop();

        // The daemon parked every view this client had placed when the old socket closed. The
        // layout has not moved, so before issue #34 the re-render produced a deduped report -
        // i.e. nothing - and the page stayed in the holder for ever.
        await waitFor(() => {
            expect(h.placements(next)).not.toHaveLength(0);
        });
        expect(h.placements(next).at(-1)).toMatchObject({
            paneID: WEB_PANE,
            tabID: WEB_TAB,
            visible: true,
            shellWindowID: SHELL_WINDOW,
            rect: { x: HOLE.x + 2, w: HOLE.width - 4 }
        });
    });

    it('re-places it when the daemon says a host has taken over (the host-drop path)', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.placements()).toHaveLength(1);
        });
        const socket = h.socket();

        // No client socket moved here at all: the SHELL's host connection went away and came
        // back, and the daemon dropped every report while it had nowhere to send them.
        act(() => {
            socket.emit({ type: 'web-geometry-resync', windowID: SHELL_WINDOW });
        });

        await waitFor(() => {
            expect(h.placements()).toHaveLength(2);
        });
        expect(h.placements().at(-1)).toMatchObject({ paneID: WEB_PANE, visible: true });
    });

    it('ignores a resync addressed to another shell window', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.placements()).toHaveLength(1);
        });
        act(() => {
            h.socket().emit({ type: 'web-geometry-resync', windowID: 'some-other-window' });
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(h.placements()).toHaveLength(1);
    });

    it('leaves a pane the user hid parked: a reconnect is not a reason to show it again', async () => {
        const h = setup();
        await waitFor(() => {
            expect(h.placements()).toHaveLength(1);
        });
        // The workspace switch a `reveal-pane` performs is the ordinary way a web pane's view
        // goes back to the holder, and it must STAY back.
        act(() => {
            h.socket().emit({ type: 'reveal-pane', workspaceID: W2, paneID: OTHER_PANE });
        });
        await waitFor(() => {
            expect(h.reports().at(-1)).toMatchObject({ visible: false });
        });

        const next = await h.drop();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
        });
        expect(h.placements(next)).toHaveLength(0);
    });
});
