/**
 * The root arrangement, assembled: every route onto it lands on one set of verbs.
 *
 * `plugins/arrangement.test.ts` covers the model and `plugins/Workbench.arrangement.test.tsx` the
 * slots and the store. What only assembly has is the routes: the ⌃⌘↩ chord (with and without a
 * workspace on screen), the View menu's relayed rows, the strip the host draws where a hidden
 * toolbar was, the entry toast, and the `window-chrome` report that hides the traffic lights.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import {
    RESET_WINDOW_ARRANGEMENT_COMMAND,
    TOGGLE_BOTTOM_PANEL_COMMAND,
    TOGGLE_STATUS_BAR_COMMAND,
    TOGGLE_TOOLBAR_COMMAND,
    TOGGLE_ZEN_MODE_COMMAND
} from './app/file-menu';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-0000000000a1';
const PANE_A = 'DDDDDDDD-0000-4000-8000-0000000000a1';
const SHELL_WINDOW = 'cccccccc-0000-4000-8000-0000000000a1';
const STORE_KEY = 'kelpi.workbench.layout.v1:daemon.test';

function snapshotState(withWorkspace: boolean): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    if (withWorkspace) store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: 1 });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    fire(command: string): void;
    reports(): Record<string, unknown>[];
}

function setup(options: { workspace?: boolean } = {}): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState(options.workspace ?? true) });
    });
    return {
        socket: () => sockets.last(),
        fire: (command) => {
            act(() => {
                sockets.last().emit({ type: 'menu-command', command });
            });
        },
        reports: () => sockets.last().messages().filter((message) => message['type'] === 'window-chrome')
    };
}

const zenChord = (): void => {
    fireEvent.keyDown(window, { code: 'Enter', key: 'Enter', metaKey: true, ctrlKey: true });
};
const strip = (): HTMLElement | null => screen.queryByTestId('restore-strip');
const toolbar = (): HTMLElement | null => screen.queryByTestId('top-bar');
const footer = (): HTMLElement | null => screen.queryByTestId('status-footer');
const sidebarPhase = (): string | null => screen.queryByTestId('sidebar-slot')?.getAttribute('data-sidebar-phase') ?? null;

afterEach(() => {
    cleanup();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
});

describe('Zen Mode, assembled', () => {
    it('hides the toolbar, status bar and sidebar on ⌃⌘↩, draws the strip, and says how to leave', async () => {
        setup();
        expect(toolbar()).not.toBeNull();
        expect(footer()).not.toBeNull();
        expect(strip()).toBeNull();

        zenChord();
        expect(toolbar()).toBeNull();
        expect(footer()).toBeNull();
        expect(strip()?.getAttribute('data-zen')).toBe('true');
        await waitFor(() => {
            expect(screen.queryByTestId('sidebar-slot')).toBeNull();
        });
        // One native toast, naming the live chord.
        expect(screen.getByText('Press ⌃⌘Return, or click the handle at the top of the window, to leave Zen Mode.')).toBeDefined();
        expect(screen.getByTestId('restore-strip-handle').getAttribute('aria-label')).toBe('Exit Zen Mode (⌃⌘Return)');

        // The same chord leaves, and everything recorded comes back; the toast goes with it.
        zenChord();
        expect(screen.queryByText(/to leave Zen Mode\./)).toBeNull();
        expect(toolbar()).not.toBeNull();
        expect(footer()).not.toBeNull();
        expect(strip()).toBeNull();
        await waitFor(() => {
            expect(sidebarPhase()).toBe('open');
        });
    });

    it('leaves from the strip’s handle, restoring exactly the pre-Zen arrangement', async () => {
        const h = setup();
        h.fire(TOGGLE_STATUS_BAR_COMMAND);
        expect(footer()).toBeNull();
        zenChord();
        // A sidebar shown inside Zen Mode is a live toggle, not a way out.
        fireEvent.keyDown(window, { code: 'KeyS', key: 's', metaKey: true, shiftKey: true });
        await waitFor(() => {
            expect(screen.queryByTestId('sidebar-slot')).not.toBeNull();
        });
        expect(strip()?.getAttribute('data-zen')).toBe('true');

        fireEvent.click(screen.getByTestId('restore-strip-handle'));
        expect(toolbar()).not.toBeNull();
        // The status bar was hidden before Zen Mode, so it stays hidden after.
        expect(footer()).toBeNull();
        expect(strip()).toBeNull();
    });

    it('answers its chord with no workspace on screen, so an empty daemon cannot strand it', () => {
        setup({ workspace: false });
        zenChord();
        expect(strip()?.getAttribute('data-zen')).toBe('true');
        zenChord();
        expect(strip()).toBeNull();
    });
});

describe('the View menu rows and the strip outside Zen Mode', () => {
    it('relays each row onto its verb, and the strip gives back only the toolbar', () => {
        const h = setup();
        h.fire(TOGGLE_TOOLBAR_COMMAND);
        expect(toolbar()).toBeNull();
        expect(footer()).not.toBeNull();
        expect(strip()?.getAttribute('data-zen')).toBe('false');
        expect(screen.getByTestId('restore-strip-handle').getAttribute('aria-label')).toBe('Show Toolbar');
        fireEvent.click(screen.getByTestId('restore-strip-handle'));
        expect(toolbar()).not.toBeNull();

        h.fire(TOGGLE_STATUS_BAR_COMMAND);
        expect(footer()).toBeNull();
        // Nothing is selected for the bottom panel, so its row has nothing to do.
        h.fire(TOGGLE_BOTTOM_PANEL_COMMAND);
        expect(JSON.parse(localStorage.getItem(STORE_KEY)!).visible['panel.bottom']).toBe(true);
        h.fire(TOGGLE_ZEN_MODE_COMMAND);
        expect(strip()?.getAttribute('data-zen')).toBe('true');
        h.fire(RESET_WINDOW_ARRANGEMENT_COMMAND);
        expect(toolbar()).not.toBeNull();
        expect(footer()).not.toBeNull();
        expect(strip()).toBeNull();
    });

    it('pins the relay names the shell sends (`shell/src/menu.ts` asserts the same literals)', () => {
        expect([TOGGLE_ZEN_MODE_COMMAND, TOGGLE_TOOLBAR_COMMAND, TOGGLE_STATUS_BAR_COMMAND, TOGGLE_BOTTOM_PANEL_COMMAND, RESET_WINDOW_ARRANGEMENT_COMMAND])
            .toEqual(['toggle-zen-mode', 'toggle-toolbar', 'toggle-status-bar', 'toggle-bottom-panel', 'reset-window-arrangement']);
    });
});

describe('the persisted arrangement, assembled', () => {
    it('saves Zen Mode and opens the next window in it, toolbar never drawn', () => {
        setup();
        zenChord();
        const saved = JSON.parse(localStorage.getItem(STORE_KEY)!);
        expect(saved.zenSnapshot).toEqual({ topbar: true, statusbar: true, 'panel.bottom': true, sidebar: true, inspector: false });
        cleanup();
        setup();
        expect(toolbar()).toBeNull();
        expect(strip()?.getAttribute('data-zen')).toBe('true');
        expect(screen.queryByTestId('sidebar-slot')).toBeNull();
    });

    it('persists the Inspector with the rest, so an Inspector left open reopens', async () => {
        setup();
        fireEvent.keyDown(window, { code: 'KeyI', key: 'i', metaKey: true });
        await waitFor(() => {
            expect(screen.getByTestId('inspector')).toBeTruthy();
        });
        cleanup();
        setup();
        await waitFor(() => {
            expect(screen.getByTestId('inspector')).toBeTruthy();
        });
    });
});

describe('the traffic lights', () => {
    it('reports the toolbar hidden and shown to this window’s shell, and again on every connect', () => {
        window.history.replaceState({}, '', `/?shellWindow=${SHELL_WINDOW}`);
        const h = setup();
        expect(h.reports()).toEqual([{ type: 'window-chrome', titleBarHidden: false, windowID: SHELL_WINDOW }]);
        zenChord();
        expect(h.reports().at(-1)).toEqual({ type: 'window-chrome', titleBarHidden: true, windowID: SHELL_WINDOW });
        // A band that is not the toolbar says nothing new.
        const count = h.reports().length;
        h.fire(TOGGLE_STATUS_BAR_COMMAND);
        expect(h.reports()).toHaveLength(count);
        zenChord();
        expect(h.reports().at(-1)).toEqual({ type: 'window-chrome', titleBarHidden: false, windowID: SHELL_WINDOW });
    });

    it('has no shell to tell in a browser tab', () => {
        const h = setup();
        zenChord();
        expect(h.reports()).toEqual([]);
    });
});
