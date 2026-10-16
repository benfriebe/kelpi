import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { contentState } from '../content/testing';
import { clearDocumentDraft, getDocumentDraft, stageDocumentDraft } from '../plugins/document-drafts';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from '../state';
import { PhoneRemoteWorkspace } from './PhoneRemoteWorkspace';

const WORKSPACE = 'AAAAAAAA-0000-0000-0000-000000000001';
const FIRST = 'BBBBBBBB-0000-0000-0000-000000000001';
const SECOND = 'BBBBBBBB-0000-0000-0000-000000000002';
const runtimes: KelpiRuntime[] = [];
afterEach(() => {
    cleanup();
    for (const runtime of runtimes.splice(0)) {
        clearDocumentDraft(runtime, FIRST); clearDocumentDraft(runtime, SECOND); runtime.dispose();
    }
    vi.restoreAllMocks();
});

function setup() {
    const daemon = createDaemonStore(emptyDaemonState('/tmp'));
    daemon.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: 'terminal', name: 'Remote', color: 'blue', now: 1 });
    daemon.dispatch({ type: 'create-scratchpad', workspaceID: WORKSPACE, paneID: FIRST, now: 2 });
    daemon.dispatch({ type: 'create-scratchpad', workspaceID: WORKSPACE, paneID: SECOND, now: 3 });
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    runtimes.push(runtime); runtime.connect();
    completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(daemon.getState())) });
    runtime.store.getState().setFocusEcho(WORKSPACE, FIRST);
    const sources = new Map([[FIRST, 'First document'], [SECOND, 'Second document']]);
    const socket = sockets.last(), send = socket.send.bind(socket);
    vi.spyOn(socket, 'send').mockImplementation(data => {
        send(data);
        if (typeof data !== 'string') return;
        const frame = JSON.parse(data) as { type: string; id: string; payload: JsonObject };
        if (frame.type !== 'command') return;
        const payload = frame.payload, paneID = String(payload['pane_id']);
        let reply: Record<string, unknown> = { ok: true };
        if (payload['command'] === 'plugin') {
            if (payload['action'] === 'list') reply['result'] = [];
            else if (payload['action'] === 'identity') reply['result'] = { daemonID: 'phone-remote-daemon' };
            else if (payload['action'] === 'document') {
                const input = JSON.parse(String(payload['text'])) as { args: { paneID: string } };
                reply['result'] = { paneID: input.args.paneID, workspaceID: WORKSPACE, kind: 'scratchpad', mode: 'edit', path: null,
                    text: sources.get(input.args.paneID), revision: 'source:1', dirty: false, loaded: true, error: null };
            }
        } else if (payload['command'] === 'content-subscribe' || payload['command'] === 'content-set-text') {
            const editing = payload['command'] === 'content-set-text';
            if (editing) sources.set(paneID, String(payload['text']));
            reply['state'] = contentState({ paneID, workspaceID: WORKSPACE, type: 'scratchpad', mode: 'edit',
                text: sources.get(paneID) ?? '', dirty: editing, revision: editing ? 2 : 1 });
        }
        // Exercise DocumentPane's own ContentClient and asynchronous subscription replies.
        queueMicrotask(() => socket.emit({ type: 'command-reply', id: frame.id, reply }));
    });
    const commands = (command: string) => socket.messages().filter(frame => frame['type'] === 'command')
        .map(frame => frame['payload'] as JsonObject).filter(payload => payload['command'] === command);
    const view = render(<PhoneRemoteWorkspace runtime={runtime} workspaceID={WORKSPACE} hostName="Remote" mode="pane" />);
    const showSecond = () => act(() => runtime.store.getState().setFocusEcho(WORKSPACE, SECOND));
    return { runtime, commands, view, showSecond };
}

describe('remote phone documents', () => {
    it('loads a new focused document into a fresh editor and sends edits only to that pane', async () => {
        const h = setup();
        await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('First document'));
        const firstEditor = screen.getByRole('textbox') as HTMLTextAreaElement;
        act(() => firstEditor.focus());
        expect(document.activeElement).toBe(firstEditor);
        h.showSecond();
        await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second document'));
        const secondEditor = screen.getByRole('textbox') as HTMLTextAreaElement;
        expect(secondEditor).not.toBe(firstEditor);
        fireEvent.change(secondEditor, { target: { value: `${secondEditor.value}!` } });
        fireEvent.blur(secondEditor);
        await waitFor(() => expect(h.commands('content-set-text')).toEqual([
            { command: 'content-set-text', pane_id: SECOND, text: 'Second document!' }
        ]));
        expect(h.commands('content-subscribe').map(payload => payload['pane_id'])).toEqual([FIRST, SECOND]);
    });

    it('keeps recovery drafts protected when the phone shows another pane or leaves the workspace', async () => {
        const h = setup();
        await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('First document'));
        act(() => { stageDocumentDraft(h.runtime, FIRST, 'Unapplied remote input', 'source:1', 'custom.editor'); });
        h.showSecond();
        await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Second document'));
        // PhonePaneSheet can close any listed pane, including one whose body is unmounted.
        await expect(h.runtime.commands.closePane({ paneID: FIRST })).rejects.toThrow('unapplied local edits');
        h.view.unmount();
        await expect(h.runtime.commands.closePane({ paneID: FIRST })).rejects.toThrow('unapplied local edits');
        expect(h.commands('pane-close')).toEqual([]);
        expect(getDocumentDraft(h.runtime, FIRST)?.text).toBe('Unapplied remote input');
    });
});

/**
 * #267: a remote daemon's terminal is drawn at that daemon's size: its own, else the remote
 * ghostty `font-size`, never the engine's built-in 13 (which is what every other viewer of the
 * same PTY would not be drawing).
 */
describe('a remote terminal on the phone', () => {
    it("is drawn at the remote daemon's ghostty font-size, and at its own size when it has one", async () => {
        const { createFakeRendererFactory, installFakeResizeObserver } = await import('../terminal/testing');
        const observers = installFakeResizeObserver();
        try {
            const daemon = createDaemonStore(emptyDaemonState('/tmp'));
            daemon.dispatch({ type: 'create-workspace', id: WORKSPACE, paneID: FIRST, name: 'Remote', color: 'blue', now: 1 });
            const sockets = createFakeSocketFactory();
            const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
            runtimes.push(runtime); runtime.connect();
            completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(daemon.getState())) });
            const current = runtime.store.getState().settings.value;
            runtime.store.getState().applySettings({ ...current, appearance: { ...current.appearance, fontSize: 17 } });
            const renderers = createFakeRendererFactory();
            render(<PhoneRemoteWorkspace runtime={runtime} workspaceID={WORKSPACE} hostName="Remote" mode="pane" createRenderer={renderers.factory} />);
            await waitFor(() => expect(renderers.instances.at(-1)?.options?.fontSize).toBe(17));

            daemon.dispatch({ type: 'set-terminal-font-size', workspaceID: WORKSPACE, paneID: FIRST, size: 21 });
            act(() => { runtime.store.getState().applySnapshot(1, JSON.parse(JSON.stringify(daemon.getState()))); });
            await waitFor(() => expect(renderers.instances.at(-1)?.options?.fontSize).toBe(21));
        } finally {
            observers.restore();
        }
    });
});
