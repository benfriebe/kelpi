/**
 * #283: the folder chooser, assembled. Settings ▸ Repositories inside the desktop app asks the
 * daemon for a folder panel (`shell-action` `choose-folder-dialog`) when Add Repo or Scan
 * Directory is pressed on an empty field, and acts on the `choose-folder-result` that comes back.
 * In a browser the hook is absent and the buttons wait for a typed path, as they always did.
 *
 * The whole client against a scripted daemon socket, so what is asserted is the wire traffic.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'cccccccc-0000-4000-8000-000000000283';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(name: string): Record<string, unknown>[];
    /** The frame id of the newest command with this name. */
    frameID(name: string): unknown;
}

function setup(shellWindow: string | null): Harness {
    // `App` reads the marker once, on mount, so it has to be in the URL before the render.
    window.history.replaceState({}, '', shellWindow === null ? '/' : `/?shellWindow=${shellWindow}`);
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
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    const frames = (name: string): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command')
            .filter((message) => (message['payload'] as Record<string, unknown>)['command'] === name);
    return {
        socket: () => sockets.last(),
        commands: (name) => frames(name).map((message) => message['payload'] as Record<string, unknown>),
        frameID: (name) => frames(name).at(-1)?.['id']
    };
}

function openRepositories(h: Harness): void {
    act(() => {
        h.socket().emit({ type: 'menu-command', command: 'settings', windowID: SHELL_WINDOW });
    });
    fireEvent.click(screen.getByTestId('settings-tab-button-repositories'));
}

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('Settings ▸ Repositories in the desktop app (#283)', () => {
    it('Add Repo on an empty field asks this window’s shell for a folder, then adds the answer', async () => {
        const h = setup(SHELL_WINDOW);
        openRepositories(h);
        const add = screen.getByTestId('repo-add') as HTMLButtonElement;
        expect(add.disabled).toBe(false);
        fireEvent.click(add);

        const [request] = h.commands('shell-action');
        expect(request).toMatchObject({ command: 'shell-action', action: 'choose-folder-dialog', window_id: SHELL_WINDOW });
        const requestID = request?.['request_id'];
        expect(typeof requestID).toBe('string');
        act(() => {
            h.socket().emit({ type: 'command-reply', id: h.frameID('shell-action'), reply: { ok: true } });
        });
        expect(h.commands('repo-add')).toEqual([]);

        act(() => {
            h.socket().emit({ type: 'choose-folder-result', requestID, path: '/Users/test/src/app', windowID: SHELL_WINDOW });
        });
        await waitFor(() => {
            expect(h.commands('repo-add')).toEqual([expect.objectContaining({ path: '/Users/test/src/app' })]);
        });
        expect(screen.getByTestId('repo-notice').textContent).toBe('Added /Users/test/src/app');
    });

    it('Scan Directory on an empty field scans the folder chosen, and a cancel does nothing', async () => {
        const h = setup(SHELL_WINDOW);
        openRepositories(h);

        fireEvent.click(screen.getByTestId('repo-scan'));
        const first = h.commands('shell-action').at(-1)?.['request_id'];
        act(() => {
            h.socket().emit({ type: 'choose-folder-result', requestID: first, path: null, windowID: SHELL_WINDOW });
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(h.commands('repo-scan')).toEqual([]);
        expect(screen.queryByTestId('repo-notice')).toBeNull();

        fireEvent.click(screen.getByTestId('repo-scan'));
        const second = h.commands('shell-action').at(-1)?.['request_id'];
        expect(second).not.toBe(first);
        act(() => {
            h.socket().emit({ type: 'choose-folder-result', requestID: second, path: '/Users/test/src', windowID: SHELL_WINDOW });
        });
        await waitFor(() => {
            expect(h.commands('repo-scan')).toEqual([expect.objectContaining({ path: '/Users/test/src' })]);
        });
    });

    it('a typed path is used as before, with no panel', () => {
        const h = setup(SHELL_WINDOW);
        openRepositories(h);
        fireEvent.change(screen.getByTestId('repo-path'), { target: { value: '/typed/repo' } });
        fireEvent.click(screen.getByTestId('repo-add'));
        expect(h.commands('shell-action')).toEqual([]);
        expect(h.commands('repo-add')).toEqual([expect.objectContaining({ path: '/typed/repo' })]);
    });

    it('toasts a refused request instead of leaving the click silent', async () => {
        const h = setup(SHELL_WINDOW);
        openRepositories(h);
        fireEvent.click(screen.getByTestId('repo-add'));
        act(() => {
            h.socket().emit({
                type: 'command-reply',
                id: h.frameID('shell-action'),
                reply: { ok: false, error: 'shell-action requires action open-file-dialog | install-cli | check-for-updates' }
            });
        });
        await waitFor(() => {
            expect(document.body.textContent).toContain('Choose folder');
        });
        expect(h.commands('repo-add')).toEqual([]);
    });
});

describe('Settings ▸ Repositories in a browser (#283)', () => {
    it('keeps both buttons disabled until a path is typed, and never asks for a panel', () => {
        const h = setup(null);
        act(() => {
            h.socket().emit({ type: 'menu-command', command: 'settings' });
        });
        fireEvent.click(screen.getByTestId('settings-tab-button-repositories'));
        expect((screen.getByTestId('repo-add') as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByTestId('repo-scan') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByTestId('repo-add'));
        expect(h.commands('shell-action')).toEqual([]);
    });
});
