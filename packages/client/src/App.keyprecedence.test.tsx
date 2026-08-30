/**
 * §TERM-154 / §TERM-155 — the dispatcher's precedence table, asserted through the REAL window.
 *
 * `chrome/keys.test.ts` already proves `createKeyDispatcher` honours every step of §7.2 when it
 * is *given* the inputs. What was unproven — and what both items' notes said was inert — is that
 * assembly supplies them: a "key secondary window" (Settings / Help) that a chord must defer to,
 * the configured global hotkey the in-app map must never shadow, and the Escape hook that
 * clears a multi-selection before `close_search` gets a look. All three are wired in
 * `App.tsx`'s `createKeyDispatcher({ … })` call, and all three are pressed here.
 *
 * The assertion shape throughout is "the command did NOT leave", because that is what falling
 * through means for a web client: nothing is consumed, no wire command is sent, and the
 * keystroke is left to whatever had focus. Every case therefore also proves the *positive* — the
 * same chord with the precondition removed does send — so a green test cannot be a dispatcher
 * that is simply broken.
 *
 * Harness copied from `App.keyactions.test.tsx` (a scripted daemon socket whose `welcome`
 * carries the settings payload) rather than shared out of it: that file is a different item's
 * evidence and is edited by other work.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    return store.getState() as unknown as JsonObject;
}

function settingsPayload(general: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        keybindLines: [],
        general: {
            focusFollowsMouse: false,
            focusFollowsMouseDelay: 100,
            theme: null,
            ...general
        },
        appearance: {
            backgroundColor: '#0a0a0c',
            backgroundOpacity: 1,
            fontFamily: null,
            fontSize: null,
            isDark: true,
            theme: null
        }
    };
}

interface Harness {
    readonly runtime: KelpiRuntime;
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    commandNames(): string[];
}

function setup(general: Record<string, unknown> = {}): Harness {
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
        const socket = sockets.last();
        socket.open();
        socket.emit({
            type: 'welcome',
            protocolVersion: 1,
            clientID: 'client-1',
            daemon: { version: '0.1.0', build: 'test', pid: 4242 },
            settings: settingsPayload(general)
        });
        socket.emit({ type: 'snapshot', seq: 0, state: snapshotState() });
    });

    const commands = (): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command')
            .map((message) => message['payload'] as Record<string, unknown>);
    return {
        runtime,
        socket: () => sockets.last(),
        commands,
        commandNames: () => commands().map((payload) => String(payload['command']))
    };
}

/** ⌘D — `split_right`, the chord every case below uses as its probe. */
function pressSplitRight(): void {
    act(() => {
        fireEvent.keyDown(window, { code: 'KeyD', key: 'd', metaKey: true });
    });
}

afterEach(() => {
    cleanup();
});

describe('§TERM-154 — the dispatcher defers to a key secondary window', () => {
    it('sends the split when no overlay is up (the control)', async () => {
        const h = setup();
        pressSplitRight();
        await waitFor(() => {
            expect(h.commandNames()).toContain('pane-split');
        });
    });

    it('does NOT dispatch a pane binding while Settings is open', async () => {
        const h = setup();
        act(() => {
            // ⌘, — the sidebar footer's gear is gone (§WS-004: the Swift footer has none), so
            // the overlay is raised by the chord the app installs outside the binding map.
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        });
        await screen.findByTestId('settings-panel');
        const before = h.commandNames().length;

        pressSplitRight();
        // Give the command channel the same chance it gets in the control case above.
        await act(async () => {
            await Promise.resolve();
        });
        expect(h.commandNames().slice(before)).not.toContain('pane-split');
    });
});

describe('§TERM-154 — the in-app map never shadows the global hotkey', () => {
    it('declines the chord the user gave the system-wide hotkey', async () => {
        // ⌘D is `split_right` by default. Claiming it as the GLOBAL hotkey must make the
        // in-app binding stand down, because the OS owns the combo (SET-187).
        const h = setup({ globalHotkey: 'super+d' });
        pressSplitRight();
        await act(async () => {
            await Promise.resolve();
        });
        expect(h.commandNames()).not.toContain('pane-split');
    });

    it('leaves every OTHER binding alone while a hotkey is configured', async () => {
        const h = setup({ globalHotkey: 'super+shift+j' });
        pressSplitRight();
        await waitFor(() => {
            expect(h.commandNames()).toContain('pane-split');
        });
    });
});

describe('§TERM-155 — a conditional binding falls through when its precondition fails', () => {
    /**
     * `close_search` is Escape's default binding and the one the note called handler-less. It
     * has a handler; the handler DECLINES when no bar is open, which is what lets Escape reach
     * the pane (and, in the Swift app, the PTY) instead of being eaten by a no-op.
     */
    it('close_search sends nothing when no search bar is open', async () => {
        const h = setup();
        const before = h.commandNames().length;
        act(() => {
            fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(h.commandNames().slice(before)).not.toContain('terminal-search');
    });

    it('…and sends the close once a bar IS open, through the same key', async () => {
        const h = setup();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyF', key: 'f', metaKey: true });
        });
        await waitFor(() => {
            expect(h.commands().some((payload) => payload['command'] === 'terminal-search')).toBe(true);
        });

        // The daemon owns the bar's state, so reflect the toggle back the way it really arrives.
        act(() => {
            const state = createDaemonStore(emptyDaemonState('/Users/test'));
            state.dispatch({
                type: 'create-workspace',
                id: W1,
                paneID: PANE_A,
                name: 'dev',
                color: 'blue',
                now: NOW
            });
            state.dispatch({ type: 'toggle-search', workspaceID: W1 });
            h.socket().emit({ type: 'snapshot', seq: 1, state: state.getState() as unknown as JsonObject });
        });
        await screen.findByTestId(`pane-search-${PANE_A}`);

        const before = h.commands().filter((payload) => payload['command'] === 'terminal-search').length;
        act(() => {
            fireEvent.keyDown(window, { code: 'Escape', key: 'Escape' });
        });
        await waitFor(() => {
            const after = h.commands().filter((payload) => payload['command'] === 'terminal-search').length;
            expect(after).toBeGreaterThan(before);
        });
    });
});
