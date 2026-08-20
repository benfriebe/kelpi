/**
 * Assembly tests for the GUI file-open routes, the Help overlay and the ••• menu
 * (CONT-120…122, APP-020/APP-027/APP-053/APP-054/APP-103, TERM-052).
 *
 * The same shape as `App.test.tsx`: the whole client against a scripted daemon socket, so what
 * is asserted is the wire traffic a gesture actually produces — not that a handler was called.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { contentState } from './content/testing';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_MD = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function snapshotState(options: { markdown?: 'preview' | 'external' } = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({
        type: 'create-workspace',
        id: W1,
        paneID: PANE_A,
        name: 'dev',
        color: 'blue',
        now: NOW
    });
    if (options.markdown !== undefined) {
        store.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PANE_MD,
            filePath: '/repo/README.md',
            now: NOW
        });
    }
    if (options.markdown === 'external') {
        store.dispatch({
            type: 'set-markdown-editing',
            workspaceID: W1,
            paneID: PANE_MD,
            editing: true,
            externalEditorCommand: "/usr/bin/env PATH='/bin' nvim '/repo/README.md'"
        });
    }
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    readonly runtime: NexRuntime;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    lastCommand(name: string): Record<string, unknown> | undefined;
    /** Answer the newest in-flight command with `{ok:true, ...extra}`. */
    reply(extra: Record<string, unknown>): void;
}

function setup(options: { markdown?: 'preview' | 'external' } = {}): Harness {
    const sockets = createFakeSocketFactory();
    const store = createNexStore();
    const runtime = createNexRuntime({
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
        completeHandshake(sockets.last(), { state: snapshotState(options) });
    });

    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    const commandFrames = (): Record<string, unknown>[] =>
        sent().filter((message) => message['type'] === 'command');
    return {
        runtime,
        socket: () => sockets.last(),
        sent,
        commands: () => commandFrames().map((message) => message['payload'] as Record<string, unknown>),
        lastCommand: (name) =>
            [...commandFrames()]
                .reverse()
                .map((message) => message['payload'] as Record<string, unknown>)
                .find((payload) => payload['command'] === name),
        reply(extra) {
            const frame = [...commandFrames()].reverse()[0];
            if (frame === undefined) throw new Error('no command in flight');
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'], reply: { ok: true, ...extra } });
            });
        }
    };
}

function drop(node: Element, entries: Record<string, string>, files = 0): void {
    const dataTransfer = {
        types: Object.keys(entries).concat(files > 0 ? ['Files'] : []),
        files: { length: files },
        dropEffect: 'none',
        getData: (format: string) => entries[format] ?? ''
    };
    fireEvent.drop(node, { dataTransfer });
}

afterEach(cleanup);

describe('drag-and-drop a markdown file (CONT-121 / APP-103)', () => {
    it('opens a dropped .md path through the `open` verb', () => {
        const h = setup();
        drop(screen.getByTestId('nex-app'), { 'text/uri-list': 'file:///repo/README.md' });
        expect(h.lastCommand('open')).toMatchObject({ command: 'open', path: '/repo/README.md' });
    });

    it('refuses a non-markdown drop with a toast rather than silence', async () => {
        const h = setup();
        drop(screen.getByTestId('nex-app'), { 'text/uri-list': 'file:///repo/photo.png' });
        expect(h.lastCommand('open')).toBeUndefined();
        await waitFor(() => {
            expect(document.body.textContent).toContain('not a .md file');
        });
    });

    it('explains a pathless File drop and points at ⌘O', async () => {
        const h = setup();
        drop(screen.getByTestId('nex-app'), {}, 1);
        expect(h.lastCommand('open')).toBeUndefined();
        await waitFor(() => {
            expect(document.body.textContent).toContain('⌘O');
        });
    });

    it('highlights only for a file-shaped drag (TERM-041)', () => {
        setup();
        const app = screen.getByTestId('nex-app');
        fireEvent.dragEnter(app, { dataTransfer: { types: ['application/x-nex-pane'], files: { length: 0 } } });
        expect(app.dataset['dropActive']).toBe('false');
        fireEvent.dragEnter(app, { dataTransfer: { types: ['Files'], files: { length: 1 } } });
        expect(app.dataset['dropActive']).toBe('true');
        expect(screen.getByTestId('drop-overlay')).toBeTruthy();
        fireEvent.dragLeave(app);
        fireEvent.dragLeave(app);
        expect(app.dataset['dropActive']).toBe('false');
    });
});

describe('⌘O (CONT-120 / APP-020)', () => {
    it('prompts for a path in a browser and sends `open`', () => {
        const h = setup();
        const prompt = vi.spyOn(globalThis, 'prompt').mockReturnValue('  /repo/NOTES.md ');
        fireEvent.keyDown(window, { code: 'KeyO', key: 'o', metaKey: true });
        expect(prompt).toHaveBeenCalledWith(expect.stringContaining('Choose a Markdown file to open'));
        expect(h.lastCommand('open')).toMatchObject({ path: '/repo/NOTES.md' });
        prompt.mockRestore();
    });

    it('sends nothing when the prompt is cancelled', () => {
        const h = setup();
        const prompt = vi.spyOn(globalThis, 'prompt').mockReturnValue(null);
        fireEvent.keyDown(window, { code: 'KeyO', key: 'o', metaKey: true });
        expect(h.lastCommand('open')).toBeUndefined();
        prompt.mockRestore();
    });
});

describe('the shell’s menu relay (`menu-command`)', () => {
    it('opens Help when the shell’s Help menu fires', async () => {
        const h = setup();
        act(() => {
            h.socket().emit({ type: 'menu-command', command: 'help' });
        });
        await waitFor(() => {
            expect(screen.getByTestId('help-overlay')).toBeTruthy();
        });
    });

    it('ignores a relay addressed to a DIFFERENT shell window', () => {
        const h = setup();
        act(() => {
            h.socket().emit({ type: 'menu-command', command: 'help', windowID: 'someone-elses-window' });
        });
        expect(screen.queryByTestId('help-overlay')).toBeNull();
    });
});

describe('Help (APP-027 / APP-063)', () => {
    it('⌘? toggles the overlay, and it lists live shortcuts', async () => {
        setup();
        fireEvent.keyDown(window, { code: 'Slash', key: '?', metaKey: true, shiftKey: true });
        const overlay = await screen.findByTestId('help-overlay');
        expect(overlay.textContent).toContain('Keyboard Shortcuts');
        const splitRow = document.querySelector('[data-help-action="split_right"]');
        expect(splitRow?.textContent).toContain('⌘D');
        fireEvent.keyDown(window, { code: 'Slash', key: '/', metaKey: true });
        await waitFor(() => {
            expect(screen.queryByTestId('help-overlay')).toBeNull();
        });
    });
});

describe('the ••• title-bar menu (APP-052/053/054)', () => {
    it('opens with Settings, the state-reflecting Inspector item, Help and Restart Socket Server', () => {
        setup();
        fireEvent.click(screen.getByTestId('titlebar-menu-toggle'));
        const menu = screen.getByTestId('context-menu');
        const labels = [...menu.querySelectorAll('[data-menu-item]')].map((node) =>
            (node.querySelector('span.flex-1')?.textContent ?? '').trim()
        );
        expect(labels).toContain('Settings…');
        expect(labels).toContain('Show Inspector');
        expect(labels).toContain('Nex Help');
        expect(labels).toContain('Restart Socket Server');
        // A browser client never shows the two rows only a desktop shell can honour.
        expect(labels).not.toContain('Install CLI');
        expect(labels).not.toContain('Check for Updates…');
    });

    it('Restart Socket Server sends the verb and reports where it came back up', async () => {
        const h = setup();
        fireEvent.click(screen.getByTestId('titlebar-menu-toggle'));
        fireEvent.click(screen.getByText('Restart Socket Server'));
        expect(h.lastCommand('restart-control-server')).toMatchObject({
            command: 'restart-control-server'
        });
        h.reply({ socket_path: '/tmp/sandbox/nexd.sock' });
        await waitFor(() => {
            expect(document.body.textContent).toContain('/tmp/sandbox/nexd.sock');
        });
    });

    it('Nex Help opens the overlay', async () => {
        setup();
        fireEvent.click(screen.getByTestId('titlebar-menu-toggle'));
        fireEvent.click(screen.getByText('Nex Help'));
        expect(await screen.findByTestId('help-overlay')).toBeTruthy();
    });
});

describe('the external $EDITOR pane (CONT-081 / CONT-090)', () => {
    it('offers the affordance over a markdown preview and sends the verb', async () => {
        const h = setup({ markdown: 'preview' });
        // The preview only exists once the daemon has answered the pane's subscription.
        const subscribe = h
            .sent()
            .find(
                (message) =>
                    message['type'] === 'command' &&
                    (message['payload'] as Record<string, unknown>)['command'] === 'content-subscribe'
            );
        await act(async () => {
            h.socket().emit({
                type: 'command-reply',
                id: subscribe?.['id'] as string,
                reply: {
                    ok: true,
                    pane_id: PANE_MD,
                    state: contentState({ paneID: PANE_MD, html: '<html><body><h1>Readme</h1></body></html>' })
                }
            });
            await Promise.resolve();
        });
        const button = await screen.findByTestId(`open-external-editor-${PANE_MD}`);
        fireEvent.click(button);
        expect(h.lastCommand('markdown-external-editor')).toMatchObject({
            command: 'markdown-external-editor',
            pane_id: PANE_MD,
            action: 'open'
        });
    });

    it('draws a TERMINAL, not the preview, while the editor is hosted', () => {
        setup({ markdown: 'external' });
        // The pane is still a markdown pane in daemon state; the client routes on the command.
        expect(document.querySelector(`[data-pane-id="${PANE_MD}"][data-terminal-status]`)).not.toBeNull();
        expect(screen.queryByTestId(`open-external-editor-${PANE_MD}`)).toBeNull();
    });

    it('⌘E out of external-editor mode ends the session rather than toggling the textarea', () => {
        const h = setup({ markdown: 'external' });
        // Focus the hosted-editor pane the way a user does: click it.
        const pane = document.querySelector(`[data-pane-id="${PANE_MD}"][data-terminal-status]`);
        expect(pane).not.toBeNull();
        fireEvent.mouseDown(pane as Element);
        fireEvent.keyDown(window, { code: 'KeyE', key: 'e', metaKey: true });
        expect(h.lastCommand('markdown-external-editor')).toMatchObject({
            pane_id: PANE_MD,
            action: 'close'
        });
    });
});
