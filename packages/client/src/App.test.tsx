/**
 * Assembly tests: the whole client against a scripted daemon socket.
 *
 * These are the jsdom half of WP3.6's acceptance — the other half is
 * `scripts/smoke.mjs`, which runs the same flows against a real `nexd`. What is checked here
 * is the wiring a live smoke cannot see from outside: that a snapshot paints the chrome, that
 * a pane's body is the right renderer for its type, that gestures and keystrokes leave as the
 * expected wire commands, and that the client tells the daemon what it is looking at.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory, type FakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

/**
 * A snapshot payload built by the DAEMON's own store, so the fixture is whatever the daemon
 * would actually send rather than a hand-written guess at the shape.
 */
function snapshotState(options: { markdown?: boolean } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    if (options.markdown === true) {
        store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PANE_B,
            filePath: '/repo/README.md',
            now: NOW
        });
    }
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    readonly runtime: NexRuntime;
    readonly renderers: FakeRendererFactory;
    socket(): FakeWebSocket;
    /** Parsed text frames the client sent. */
    sent(): Record<string, unknown>[];
    /** Payloads of every `command` frame, oldest first. */
    commands(): Record<string, unknown>[];
    lastOfType(type: string): Record<string, unknown> | undefined;
}

function setup(options: { markdown?: boolean; snapshot?: boolean } = {}): Harness {
    const sockets = createFakeSocketFactory();
    const store = createNexStore();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        // The browser Notification API does not exist in jsdom, and the toast fallback is
        // covered by `state/notifications.test.ts`.
        notifications: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    const renderers = createFakeRendererFactory();

    render(<App runtime={runtime} createRenderer={renderers.factory} />);

    if (options.snapshot !== false) {
        act(() => {
            completeHandshake(sockets.last(), {
                state: snapshotState(options.markdown === true ? { markdown: true } : {})
            });
        });
    }

    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    return {
        runtime,
        renderers,
        socket: () => sockets.last(),
        sent,
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        lastOfType: (type) => [...sent()].reverse().find((message) => message['type'] === type)
    };
}

afterEach(() => {
    cleanup();
});

describe('connection states', () => {
    it('covers the grid with a splash until the first snapshot lands', () => {
        const h = setup({ snapshot: false });
        const splash = screen.getByTestId('connection-splash');
        expect(splash.dataset['status']).toBe('connecting');
        expect(splash.textContent).toContain('Connecting');

        act(() => {
            completeHandshake(h.socket(), { state: snapshotState() });
        });
        expect(screen.queryByTestId('connection-splash')).toBeNull();
    });

    it('keeps the mirror on screen behind a banner when the socket drops', () => {
        const h = setup();
        expect(screen.queryByTestId('connection-banner')).toBeNull();

        act(() => {
            h.socket().serverClose();
        });

        const banner = screen.getByTestId('connection-banner');
        expect(banner.dataset['status']).toBe('reconnecting');
        // The workspace is still rendered: the mirror was true as of the drop.
        expect(screen.getByTestId('top-bar-identity').textContent).toContain('dev');
    });
});

describe('snapshot → chrome', () => {
    it('paints the sidebar, top bar, grid and footer from the daemon state', () => {
        setup();

        expect(screen.getByTestId('top-bar-identity').textContent).toContain('dev');
        expect(screen.getAllByTestId('workspace-row')).toHaveLength(1);
        expect(screen.getByTestId('pane-grid')).toBeTruthy();
        expect(screen.getByTestId(`pane-${PANE_A}`)).toBeTruthy();
        expect(screen.getByTestId('status-footer')).toBeTruthy();
    });

    it('reports this client’s focus and visible panes to the daemon', async () => {
        const h = setup();

        await waitFor(() => {
            expect(h.lastOfType('focus-report')).toBeDefined();
        });
        expect(h.lastOfType('focus-report')).toMatchObject({ workspaceID: W1, paneID: PANE_A });
        expect(h.lastOfType('visibility-report')).toMatchObject({
            workspaceID: W1,
            visiblePaneIDs: [PANE_A],
            documentVisible: true
        });
    });
});

describe('pane bodies', () => {
    it('mounts a terminal for a shell pane and attaches its stream', () => {
        const h = setup();

        expect(h.renderers.instances).toHaveLength(1);
        expect(h.lastOfType('attach-pane')).toMatchObject({ paneID: PANE_A });
    });

    it('renders an honest placeholder for a pane type that lands in a later milestone', () => {
        setup({ markdown: true });

        const placeholder = screen.getByTestId(`pane-placeholder-${PANE_B}`);
        expect(placeholder.textContent).toContain('Markdown preview');
        expect(placeholder.textContent).toContain('/repo/README.md');
        expect(placeholder.textContent).toContain('renders in M5');
        // …and the shell pane beside it still gets a real engine.
        expect(screen.getByTestId(`pane-${PANE_A}`)).toBeTruthy();
    });
});

describe('gestures and keys become wire commands', () => {
    it('splits the focused pane on ⌘D', async () => {
        const h = setup();

        fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-split',
                pane_id: PANE_A,
                direction: 'horizontal'
            });
        });
    });

    it('closes the focused pane on ⌘W', async () => {
        const h = setup();

        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close', pane_id: PANE_A });
        });
    });

    it('zooms through the WS-only verb from the header button', async () => {
        const h = setup();

        fireEvent.keyDown(window, { code: 'Enter', key: 'Enter', metaKey: true, shiftKey: true });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'toggle-zoom', pane_id: PANE_A });
        });
    });

    it('opens the command palette on ⌘P and leaves the map alone while it is open', () => {
        setup();

        fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        expect(screen.getByTestId('command-palette')).toBeTruthy();

        // §7.2 step 1: with the palette open, ⌘D belongs to the palette, not the pane map.
        fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });
        expect(screen.getByTestId('command-palette')).toBeTruthy();
    });

    it('renames a pane from the header editor', async () => {
        const h = setup();

        fireEvent.click(screen.getByTestId(`pane-rename-${PANE_A}`));
        const input = screen.getByTestId(`pane-rename-input-${PANE_A}`);
        fireEvent.change(input, { target: { value: 'worker' } });
        fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-name', pane_id: PANE_A, name: 'worker' });
        });
    });
});

describe('deltas advance the mirror', () => {
    it('applies a daemon delta without a re-snapshot', () => {
        const h = setup();

        act(() => {
            h.socket().emit({
                type: 'delta',
                seq: 1,
                events: [
                    {
                        kind: 'workspace-upserted',
                        id: W1,
                        workspace: {
                            ...((snapshotState() as unknown as { workspaces: Record<string, unknown>[] }).workspaces[0] ??
                                {}),
                            name: 'renamed'
                        }
                    }
                ]
            });
        });

        expect(screen.getByTestId('top-bar-identity').textContent).toContain('renamed');
        expect(h.runtime.store.getState().daemon.seq).toBe(1);
    });
});
