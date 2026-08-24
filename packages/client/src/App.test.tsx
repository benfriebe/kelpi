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
import { contentState } from './content/testing';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory, type FakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_C = 'DDDDDDDD-0000-4000-8000-000000000003';
const PANE_D = 'DDDDDDDD-0000-4000-8000-000000000004';
const WEB_TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

/**
 * A snapshot payload built by the DAEMON's own store, so the fixture is whatever the daemon
 * would actually send rather than a hand-written guess at the shape.
 */
function snapshotState(options: { markdown?: boolean; diff?: boolean; web?: boolean } = {}): JsonObject {
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
    if (options.diff === true) {
        store.dispatch({
            type: 'open-diff-pane',
            workspaceID: W1,
            paneID: PANE_C,
            repoPath: '/repo',
            now: NOW
        });
    }
    if (options.web === true) {
        // Real daemon state, sidecar included: the chrome reads `workspace.webPanes[paneID]`.
        store.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PANE_D,
            tabID: WEB_TAB,
            url: 'https://example.com',
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

function setup(
    options: { markdown?: boolean; diff?: boolean; web?: boolean; snapshot?: boolean } = {}
): Harness {
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
        // A rejection forgets the remembered token; keep that out of jsdom's shared storage.
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    const renderers = createFakeRendererFactory();

    render(<App runtime={runtime} createRenderer={renderers.factory} />);

    if (options.snapshot !== false) {
        const fixture: { markdown?: boolean; diff?: boolean; web?: boolean } = {};
        if (options.markdown === true) fixture.markdown = true;
        if (options.diff === true) fixture.diff = true;
        if (options.web === true) fixture.web = true;
        act(() => {
            completeHandshake(sockets.last(), { state: snapshotState(fixture) });
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

    it('shows the daemon’s refusal, and what to do about it, instead of a spinner', () => {
        const h = setup({ snapshot: false });
        act(() => {
            h.socket().open();
            h.socket().emit({
                type: 'rejected',
                code: 'unauthorized',
                reason: 'bad-token',
                message: "invalid or missing daemon token — open the client via 'nexd url'",
                protocolVersion: 1
            });
            h.socket().serverClose(4003, 'bad-token');
        });

        const splash = screen.getByTestId('connection-splash');
        expect(splash.dataset['status']).toBe('rejected');
        // The daemon's sentence is on screen verbatim, at body size rather than as a footnote.
        const error = screen.getByTestId('connection-error');
        expect(error.textContent).toContain('invalid or missing daemon token');
        expect(error.className).toContain('text-[13px]');
        // And the splash names the one command that produces a working link.
        expect(splash.textContent).toContain('nexd url');
        expect(screen.getByTestId('connection-retry')).toBeTruthy();
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

    it('subscribes a markdown pane to the daemon’s content and renders what comes back', async () => {
        const h = setup({ markdown: true });

        const subscribe = h
            .sent()
            .find(
                (message) =>
                    message['type'] === 'command' &&
                    (message['payload'] as Record<string, unknown>)['command'] === 'content-subscribe'
            );
        expect(subscribe).toBeDefined();
        expect(subscribe?.['payload']).toMatchObject({ pane_id: PANE_B });

        await act(async () => {
            h.socket().emit({
                type: 'command-reply',
                id: subscribe?.['id'] as string,
                reply: {
                    ok: true,
                    pane_id: PANE_B,
                    state: contentState({
                        paneID: PANE_B,
                        html: '<html><head></head><body><h1>Readme</h1></body></html>'
                    })
                }
            });
            await Promise.resolve();
        });

        // Untrusted document, so: sandboxed, scripts only, never the app's origin.
        const frame = screen.getByTestId(`content-iframe-${PANE_B}`);
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('srcdoc')).toContain('<h1>Readme</h1>');
        // …and the shell pane beside it still gets a real engine.
        expect(screen.getByTestId(`pane-${PANE_A}`)).toBeTruthy();
    });

    it('gives a web pane its chrome, with an honest card where the page would be', () => {
        const h = setup({ web: true });

        // The chrome is ordinary DOM, so every client draws it, URL bar filled from the tab…
        expect((screen.getByTestId(`web-url-${PANE_D}`) as HTMLInputElement).value).toBe(
            'https://example.com'
        );
        expect(screen.getByTestId(`web-page-${PANE_D}`)).toBeTruthy();
        // …but this client is a plain browser (no `?shellWindow=`), so nothing can paint the
        // page itself, and no geometry is reported for a view that will never be placed.
        expect(screen.getByTestId(`web-external-${PANE_D}`).textContent).toContain('Open in the Nex app');
        expect(h.sent().some((message) => message['type'] === 'web-geometry-report')).toBe(false);
        // A single tab hides the strip (§16.4).
        expect(screen.queryByTestId(`web-tabs-${PANE_D}`)).toBeNull();
    });

    it('sends the URL bar’s text as `web-navigate`', async () => {
        const h = setup({ web: true });

        const input = screen.getByTestId(`web-url-${PANE_D}`);
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: 'example.org' } });
        fireEvent.submit(input);

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'web-navigate',
                pane_id: PANE_D,
                url: 'example.org'
            });
        });
    });

    it('reveals a pane on the daemon’s say-so: workspace first, focus last (§8.5)', async () => {
        const h = setup();

        act(() => {
            h.socket().emit({ type: 'reveal-pane', workspaceID: W1, paneID: PANE_A });
        });

        // The workspace activation is immediate; the focus report lands a tick later, after
        // the window has restored whatever focus it had.
        await waitFor(() => {
            expect(h.lastOfType('focus-report')).toMatchObject({ workspaceID: W1, paneID: PANE_A });
        });
    });

    it('ignores a reveal aimed at a different shell window', async () => {
        const h = setup();
        const before = h.sent().length;
        act(() => {
            h.socket().emit({
                type: 'reveal-pane',
                workspaceID: W1,
                paneID: PANE_A,
                windowID: 'some-other-window'
            });
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
        // This client is a browser: a window-scoped reveal is not addressed to it, so it says
        // nothing at all — no focus report, no workspace activation.
        expect(h.sent().length).toBe(before);
    });
});

describe('content pane commands', () => {
    it('toggles markdown edit mode from the header button', async () => {
        const h = setup({ markdown: true });

        fireEvent.click(screen.getByTestId(`pane-edit-toggle-${PANE_B}`));

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'markdown-set-mode',
                pane_id: PANE_B,
                mode: 'edit'
            });
        });
    });

    it('toggles markdown edit mode on ⌘E, and only for a markdown pane', async () => {
        const h = setup({ markdown: true });

        // Opening the markdown pane focused it, so the binding's condition holds.
        fireEvent.keyDown(window, { code: 'KeyE', key: 'e', metaKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'markdown-set-mode', pane_id: PANE_B });
        });

        // A shell pane declines the action, so the keystroke falls through untouched.
        const before = h.commands().length;
        act(() => {
            h.runtime.focusPane(W1, PANE_A);
        });
        fireEvent.keyDown(window, { code: 'KeyE', key: 'e', metaKey: true });
        expect(h.commands()).toHaveLength(before);
    });

    it('refreshes a diff pane from the header button', async () => {
        const h = setup({ diff: true });

        fireEvent.click(screen.getByTestId(`pane-refresh-${PANE_C}`));

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'diff-refresh', pane_id: PANE_C });
        });
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

    it('opens the New Workspace SHEET on ⌘N, and creates nothing by itself (§APP-018)', async () => {
        // `NexCommands.swift:10-13` spends ⌘N on `showNewWorkspaceSheet()`. This used to fire a
        // `workspace-create` straight out — the create WITHOUT the sheet: no name, no colour, no
        // group, no profile, no repositories, and nothing to cancel.
        const h = setup();
        expect(screen.queryByTestId('new-workspace-form')).toBeNull();

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });

        await waitFor(() => {
            expect(screen.getByTestId('new-workspace-form')).toBeTruthy();
        });
        expect(h.commands().filter((command) => command['command'] === 'workspace-create')).toHaveLength(
            0
        );
    });

    it('switches to the workspace the SHEET created, once the daemon names it', async () => {
        // run-B L3: the row appeared and the window stayed where it was — for the rest of the
        // session, because a per-client active workspace only moves when the client moves it.
        // Creating one is a deliberate act with an obvious destination (Swift's
        // `createWorkspace` sets `activeWorkspaceID`), so the reply is what switches.
        const h = setup();
        const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';

        fireEvent.keyDown(window, { code: 'KeyN', key: 'n', metaKey: true });
        const form = await screen.findByTestId('new-workspace-form');
        fireEvent.change(screen.getByLabelText('New workspace name'), { target: { value: 'built' } });
        fireEvent.submit(form);
        await waitFor(() => {
            expect(
                h.commands().filter((command) => command['command'] === 'workspace-create')
            ).toHaveLength(1);
        });
        const create = h
            .sent()
            .filter((message) => message['type'] === 'command')
            .find(
                (message) =>
                    (message['payload'] as Record<string, unknown>)['command'] === 'workspace-create'
            );
        // The name the SHEET collected rides the create — the half ⌘N could not carry before.
        expect((create?.['payload'] as Record<string, unknown>)['name']).toBe('built');

        await act(async () => {
            h.socket().emit({
                type: 'command-reply',
                id: create?.['id'] as string,
                reply: { ok: true, workspace_id: W2, workspace_name: 'built' }
            });
            await Promise.resolve();
        });

        expect(h.runtime.store.getState().ui.activeWorkspaceID).toBe(W2);
        expect(h.lastOfType('visibility-report')).toMatchObject({ workspaceID: W2 });
    });

    it('closes the focused pane on ⌘W', async () => {
        // A workspace with two panes: ⌘W closes the focused ONE (the last-pane rule below is
        // what makes the pane count load-bearing here).
        const h = setup({ markdown: true });

        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close' });
        });
    });

    /**
     * TERM-077 / WS-109: ⌘W on the LAST pane deletes the workspace instead of leaving an empty
     * one behind, and with no running agents nothing is asked first — exactly what
     * `NexCommands.handleClosePane` does.
     */
    it('deletes the workspace when ⌘W closes its last pane', async () => {
        const h = setup();

        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

        await waitFor(() => {
            // §WS-156: ⌘W is the ONE route allowed to reach zero workspaces, so it goes out on
            // the GUI's own WS-only verb with `allow_last` — the CLI's `workspace-delete` has no
            // such field and still refuses the last workspace.
            expect(h.commands().at(-1)).toMatchObject({
                command: 'delete-workspace',
                workspace_id: W1,
                force: true,
                allow_last: true
            });
        });
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
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

        // §M30: the header's rename pencil is gone — `PaneHeaderView.swift:222-272` has no such
        // button and the shipped app's rename is the header context menu's "Rename…" (`:354-356`).
        // One-for-one swap of the GESTURE only; every assertion below is unchanged.
        fireEvent.contextMenu(screen.getByTestId(`pane-header-${PANE_A}`));
        fireEvent.click(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="rename"]') as Element
        );
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
