/**
 * §APP-067 / §WS-156 — the detail area with no active workspace.
 *
 * `ContentView.swift:237-249`: a terminal glyph, "No workspace selected", and a "Create
 * Workspace" button that raises the new-workspace sheet. The port had the *pane*-level empty
 * state ("No panes" / "New Pane") and nothing at the workspace level, on the reasoning that the
 * state was unreachable — the daemon refuses to delete the last workspace and creates "Default"
 * on a fresh boot.
 *
 * It is reachable. ⌘W on the last pane of the last workspace deletes that workspace (§TERM-077 /
 * §WS-109's rule, which the shipped app also lets reach zero), and a daemon whose delete the GUI
 * drives can land on an empty list. What a window must never be is a dead end, which is why the
 * Swift put a BUTTON in this state rather than a message — and why the test below is about the
 * button as much as the copy.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

/** A daemon with NO workspaces at all — every one of them deleted. */
function emptySnapshot(): JsonObject {
    return createDaemonStore(emptyDaemonState('/Users/test')).getState() as unknown as JsonObject;
}

/** The ordinary one-workspace snapshot, for the "it is not always on screen" half. */
function populatedSnapshot(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
}

function setup(state: JsonObject): Harness {
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
        completeHandshake(sockets.last(), { state });
    });
    return {
        socket: () => sockets.last(),
        commands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
    };
}

afterEach(cleanup);

describe('the no-workspace empty state (§APP-067 / §WS-156)', () => {
    it('shows the glyph, the copy and a Create Workspace button when nothing is active', () => {
        setup(emptySnapshot());

        const empty = screen.getByTestId('no-workspace-empty');
        expect(empty.textContent).toContain('No workspace selected');
        expect(screen.getByTestId('no-workspace-create').textContent).toContain('Create Workspace');
    });

    /**
     * L30 — `ContentView.swift:238-247`, to the number: `VStack(spacing: 8)`, a `.quaternary`
     * glyph (the label colour at 10%, the same transcription the empty GRID uses), and a plain
     * `Button` with no `.keyboardShortcut`. The port had 12 px of stack, a `textTertiary` glyph
     * one whole tier brighter, and an `autoFocus` that made Return raise a sheet — Return is
     * bound on the grid's "New Pane" (`PaneGridView.swift:504`) and nowhere else.
     */
    it('is the Swift’s metrics: 8 px stack, a quaternary glyph, no autofocus', () => {
        setup(emptySnapshot());

        const empty = screen.getByTestId('no-workspace-empty');
        expect(empty.className).toContain('gap-2');
        expect(empty.className).not.toContain('gap-3');
        expect(screen.getByTestId('no-workspace-glyph').style.color).toBe(
            'color-mix(in srgb, var(--kelpi-fg, #E6E6EA) 10%, transparent)'
        );
        const button = screen.getByTestId('no-workspace-create');
        expect(button.hasAttribute('autofocus')).toBe(false);
        expect(document.activeElement).not.toBe(button);
    });

    it('REPLACES the grid rather than sitting on top of it', () => {
        setup(emptySnapshot());

        // The shipped app's `else` branch swaps the detail view out. Both placeholders on screen
        // at once — "No workspace selected" over "No panes" — is the thing this avoids.
        expect(screen.queryByTestId('pane-grid-empty')).toBeNull();
        expect(screen.queryByTestId('pane-grid')).toBeNull();
    });

    it('opens the New Workspace SHEET from its button, not a bare create', async () => {
        // `showNewWorkspaceSheet()` — the same §APP-018 gesture ⌘N makes, which is what stops
        // this state being a dead end.
        const h = setup(emptySnapshot());

        fireEvent.click(screen.getByTestId('no-workspace-create'));

        await waitFor(() => {
            expect(screen.getByTestId('new-workspace-form')).toBeTruthy();
        });
        expect(h.commands().filter((command) => command['command'] === 'workspace-create')).toHaveLength(
            0
        );
    });

    it('is not on screen while a workspace IS active', () => {
        setup(populatedSnapshot());
        expect(screen.queryByTestId('no-workspace-empty')).toBeNull();
    });

    it('is not what a client with no snapshot shows — that is the connection splash', () => {
        // A client that has never had a snapshot has no workspace either, and "No workspace
        // selected" would be a lie about a daemon it has not spoken to yet.
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

        expect(screen.queryByTestId('no-workspace-empty')).toBeNull();
    });
});

/**
 * N14 — the honest "no" that lets ⌘W still close the window.
 *
 * The shell's Close row asks this page first and closes the window only when the answer is not
 * `true`. With nothing to close the answer has to BE false: a client that always claimed the
 * keystroke would make the window unclosable from the menu bar, which is a worse defect than the
 * one N14 fixes.
 */
describe('the shell’s Close request with nothing to close (N14)', () => {
    it('answers false, so the shell falls back to closing the window', () => {
        setup(emptySnapshot());

        const request = (window as unknown as Record<string, unknown>)['__kelpiShellClosePane'];
        expect(typeof request).toBe('function');
        expect((request as () => boolean)()).toBe(false);
    });
});
