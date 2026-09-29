/**
 * #288: dropping files onto a terminal pane, assembled.
 *
 * A drop from Finder carries `Files` and no path the page can read, so inside the desktop app the
 * page parks the `File`s, asks this window's shell for their paths (`shell-action`
 * `resolve-dropped-files`), and types the escaped answer into the pane through `drop-text`, the
 * paste pipeline. A drag that names its paths as text still types them at once; a browser, which
 * has no shell to ask, says why nothing was typed; and a pane-rearrange drag is not a drop at all.
 *
 * The whole client against a scripted daemon socket, so what is asserted is the wire traffic.
 */

import { DROPPED_FILES_STASH, type JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'cccccccc-0000-4000-8000-000000000288';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(name: string): Record<string, unknown>[];
    frameID(name: string): unknown;
    /** Answer the newest command of this name. */
    reply(name: string, reply: Record<string, unknown>): void;
}

function setup(shellWindow: string | null): Harness {
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
    const frameID = (name: string): unknown => frames(name).at(-1)?.['id'];
    return {
        socket: () => sockets.last(),
        commands: (name) => frames(name).map((message) => message['payload'] as Record<string, unknown>),
        frameID,
        reply(name, reply) {
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frameID(name), reply });
            });
        }
    };
}

/** A `DataTransfer` as Chromium builds one for a Finder drop: `Files`, and no path as text. */
function finderTransfer(files: readonly File[], entries: Record<string, string> = {}): Record<string, unknown> {
    const list: Record<number, File> & { length: number } = { length: files.length };
    files.forEach((file, index) => {
        list[index] = file;
    });
    return {
        types: [...Object.keys(entries), ...(files.length > 0 ? ['Files'] : [])],
        files: list,
        dropEffect: 'none',
        getData: (format: string) => entries[format] ?? ''
    };
}

const terminalRoot = (): Element => {
    const root = document.querySelector(`[data-pane-id="${PANE_A}"][data-terminal-status]`);
    if (root === null) throw new Error('no terminal pane root');
    return root;
};
const terminalHost = (): Element => {
    const host = terminalRoot().querySelector('[data-terminal-host]');
    if (host === null) throw new Error('no terminal host');
    return host;
};

const pageStash = (): Map<string, unknown> | undefined =>
    (globalThis as unknown as Record<string, Map<string, unknown> | undefined>)[DROPPED_FILES_STASH];

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
    delete (globalThis as unknown as Record<string, unknown>)[DROPPED_FILES_STASH];
});

describe('a Finder drop onto a terminal pane in the desktop app (#288)', () => {
    it('asks this window’s shell for the paths, then types them escaped through the paste pipeline', async () => {
        const h = setup(SHELL_WINDOW);
        const shot = new File(['png'], 'Screen Shot 1.png', { type: 'image/png' });
        const notes = new File(['md'], "it's $notes.md");
        fireEvent.drop(terminalHost(), { dataTransfer: finderTransfer([shot, notes]) });

        const [request] = h.commands('shell-action');
        expect(request).toMatchObject({ command: 'shell-action', action: 'resolve-dropped-files', window_id: SHELL_WINDOW });
        const requestID = request?.['request_id'];
        expect(typeof requestID).toBe('string');
        // The Files wait on the page, under the id, for the shell to read.
        expect(pageStash()?.get(String(requestID))).toEqual([shot, notes]);
        // Nothing is typed until the paths are known.
        expect(h.commands('drop-text')).toEqual([]);

        h.reply('shell-action', { ok: true });
        act(() => {
            h.socket().emit({
                type: 'dropped-files-result',
                requestID,
                paths: ['/Users/test/Desktop/Screen Shot 1.png', "/Users/test/it's $notes.md"],
                unresolved: 0,
                windowID: SHELL_WINDOW
            });
        });
        await waitFor(() => {
            expect(h.commands('drop-text')).toEqual([
                expect.objectContaining({
                    command: 'drop-text',
                    pane_id: PANE_A,
                    text: "/Users/test/Desktop/Screen\\ Shot\\ 1.png /Users/test/it\\'s\\ \\$notes.md"
                })
            ]);
        });
        expect(pageStash()?.has(String(requestID))).toBe(false);
    });

    it('counts a drop on the pane’s edge padding (outside the engine host) as a terminal drop', () => {
        const h = setup(SHELL_WINDOW);
        fireEvent.drop(terminalRoot(), { dataTransfer: finderTransfer([new File(['x'], 'x.txt')]) });
        expect(h.commands('shell-action')).toEqual([expect.objectContaining({ action: 'resolve-dropped-files' })]);
        // Not the window route: no "use ⌘O" refusal.
        expect(document.body.textContent).not.toContain('⌘O');
    });

    it('types nothing, and says why, when no path comes back', async () => {
        const h = setup(SHELL_WINDOW);
        fireEvent.drop(terminalHost(), { dataTransfer: finderTransfer([new File(['x'], 'from-a-web-page.png')]) });
        const requestID = h.commands('shell-action')[0]?.['request_id'];
        act(() => {
            h.socket().emit({ type: 'dropped-files-result', requestID, paths: [], unresolved: 1, windowID: SHELL_WINDOW });
        });
        await waitFor(() => {
            expect(document.body.textContent).toContain('not a file on disk');
        });
        expect(h.commands('drop-text')).toEqual([]);
    });

    it('types nothing, and says why, when the daemon refuses (a shell that cannot read paths)', async () => {
        const h = setup(SHELL_WINDOW);
        fireEvent.drop(terminalHost(), { dataTransfer: finderTransfer([new File(['x'], 'x.txt')]) });
        h.reply('shell-action', { ok: false, error: `no desktop window ${SHELL_WINDOW} is connected that can read a dropped file's path` });
        await waitFor(() => {
            expect(document.body.textContent).toContain("can read a dropped file's path");
        });
        expect(h.commands('drop-text')).toEqual([]);
        expect(pageStash()?.size ?? 0).toBe(0);
    });
});

describe('the other terminal drop routes (TERM-040 / TERM-041)', () => {
    it('types a path the drag names as text at once, a .md included, without asking the shell', () => {
        const h = setup(SHELL_WINDOW);
        fireEvent.drop(terminalHost(), {
            dataTransfer: finderTransfer([], { 'text/uri-list': 'file:///repo/My%20Spec.md' })
        });
        expect(h.commands('drop-text')).toEqual([expect.objectContaining({ pane_id: PANE_A, text: '/repo/My\\ Spec.md' })]);
        expect(h.commands('shell-action')).toEqual([]);
        // A terminal types what is dropped on it: no markdown pane opens.
        expect(h.commands('open')).toEqual([]);
    });

    it('in a browser, types nothing and says why instead of doing nothing', async () => {
        const h = setup(null);
        fireEvent.drop(terminalHost(), { dataTransfer: finderTransfer([new File(['x'], 'x.png')]) });
        await waitFor(() => {
            expect(document.body.textContent).toContain('a browser does not reveal where a dropped file lives');
        });
        expect(h.commands('shell-action')).toEqual([]);
        expect(h.commands('drop-text')).toEqual([]);
    });

    it('ignores a drop that carries neither a path nor a file (plain text)', () => {
        const h = setup(SHELL_WINDOW);
        fireEvent.drop(terminalHost(), { dataTransfer: finderTransfer([], { 'text/plain': 'just some words' }) });
        expect(h.commands('drop-text')).toEqual([]);
        expect(h.commands('shell-action')).toEqual([]);
    });

    it('never mistakes a pane-rearrange drag for a file drop: it is pointer events, not a drop', () => {
        const h = setup(SHELL_WINDOW);
        const header = screen.getByTestId(`pane-header-${PANE_A}`);
        const host = terminalHost();
        fireEvent.pointerDown(header, { pointerId: 1, button: 0, buttons: 1, clientX: 20, clientY: 10 });
        fireEvent.pointerMove(host, { pointerId: 1, buttons: 1, clientX: 120, clientY: 120 });
        fireEvent.pointerMove(host, { pointerId: 1, buttons: 1, clientX: 140, clientY: 160 });
        fireEvent.pointerUp(host, { pointerId: 1, button: 0, clientX: 140, clientY: 160 });
        expect(h.commands('drop-text')).toEqual([]);
        expect(h.commands('shell-action')).toEqual([]);
        expect(pageStash()?.size ?? 0).toBe(0);
    });
});
