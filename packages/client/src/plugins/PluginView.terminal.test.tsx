import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePluginManifest, decodePtyFrame, encodePtyFrame, PTY_FRAME_TYPES, type JsonObject, type PluginInfo } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { completeHandshake, createFakeSocketFactory } from '../connection/testing';
import { paneHandle } from '../terminal/pane-registry';
import { PluginView } from './PluginView';
import { usePlugins } from './client';

const PANE = 'AAAAAAAA-2222-4333-8444-555555555555', VIEW = 'terminal.test.renderer';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function setup(granted = true) {
    vi.stubGlobal('MessageChannel', MessageChannel);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${crypto.randomUUID()}.test/ws`, socketFactory: sockets.factory, notifications: null });
    const state = createDaemonStore(emptyDaemonState('/tmp'));
    state.dispatch({ type: 'create-workspace', id: 'W', paneID: PANE, name: 'Work', color: 'blue', now: 1 });
    runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(state.getState())) });
    const manifest = decodePluginManifest({ id: 'terminal.test', version: '1.0.0', apiVersion: 1, trust: 'full', contributes: {
        views: [{ id: VIEW, title: 'Test terminal', entry: 'ui/index.html', placements: ['terminal'] }]
    } });
    const plugin: PluginInfo = { manifest, enabled: true, revision: 'r1', instanceID: 'i1', status: 'inactive', error: null };
    const requests = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => {
        if (payload['action'] === 'list') return { ok: true, result: [plugin] as never };
        if (payload['action'] === 'identity') return { ok: true, result: { daemonID: 'D' } };
        if (payload['action'] === 'attach') return { ok: true, result: { lease: 'lease', html: '<div></div>', entry: 'ui/index.html', context: { daemonID: 'D', paneID: PANE, workspaceID: 'W' }, state: {}, stateVersion: 1 } };
        return { ok: true, result: null };
    });
    const catalog = renderHook(() => usePlugins(runtime));
    const onError = vi.fn();
    const props = { runtime, pluginID: manifest.id, viewID: VIEW, paneID: PANE, workspaceID: 'W', onError, visible: true, focused: true,
        ...(granted ? { terminal: { paneID: PANE, ptyApi: runtime.pty, focused: true, visible: true } } : {}) };
    const view = render(<PluginView {...props} />);
    await waitFor(() => expect(screen.getByTitle('Test terminal').getAttribute('srcdoc')).toContain('kelpi-plugin-ready'));
    const frame = screen.getByTitle('Test terminal') as HTMLIFrameElement;
    const nonce = /"nonce":"([^"]+)"/.exec(frame.srcdoc)![1];
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'kelpi-plugin-ready', nonce } })));
    const child = (send.mock.calls as unknown as Array<[unknown, unknown, MessagePort[]]>)[0]![2][0]!;
    const received: Array<Record<string, any>> = [];
    child.on('message', message => received.push(message));
    const attach = async () => {
        child.postMessage({ type: 'call', id: 'attach', method: 'terminal.attach', args: { session: 'one', cols: 100, rows: 30 } });
        await waitFor(() => expect(received.some(item => item.type === 'reply' && item.id === 'attach')).toBe(true));
        return received.find(item => item.type === 'reply' && item.id === 'attach')!;
    };
    const ack = (message: Record<string, any>) => child.postMessage({ type: 'terminal-ack', session: 'one', generation: message.generation, sequence: message.sequence });
    return { runtime, sockets, requests, received, view, props, child, onError, attach, ack,
        dispose: () => { view.unmount(); catalog.unmount(); child.close(); runtime.dispose(); } };
}

describe('selected terminal renderer through its private view port', () => {
    it('routes claimed terminal edits to the owning host callback before preserving window shortcut dispatch', async () => {
        const h = await setup(), editing = vi.fn((key: { code: string }) => key.code === 'KeyC'), windowKey = vi.fn();
        window.addEventListener('keydown', windowKey);
        try {
            h.view.rerender(<PluginView {...h.props} claimedChords={['8/KeyC', '8/KeyP']} onTerminalKey={editing} />);
            h.child.postMessage({ type: 'key', key: 'c', code: 'KeyC', metaKey: true });
            await waitFor(() => expect(editing).toHaveBeenCalledOnce());
            expect(windowKey).not.toHaveBeenCalled();
            h.child.postMessage({ type: 'key', key: 'p', code: 'KeyP', metaKey: true });
            await waitFor(() => expect(windowKey).toHaveBeenCalledOnce());
            expect(windowKey.mock.calls[0]![0]).toMatchObject({ code: 'KeyP', metaKey: true });
            h.child.postMessage({ type: 'key', key: 'q', code: 'KeyQ', metaKey: true });
            h.view.rerender(<PluginView {...h.props} visible={false} claimedChords={['8/KeyC']} onTerminalKey={editing} />);
            h.child.postMessage({ type: 'key', key: 'c', code: 'KeyC', metaKey: true });
            await new Promise(resolve => setTimeout(resolve, 10));
            expect(editing).toHaveBeenCalledTimes(2); expect(windowKey).toHaveBeenCalledOnce();
        } finally { window.removeEventListener('keydown', windowKey); h.dispose(); }
    });

    it('uses the existing window PTY and delivers raw replay before live output with consumed acknowledgements', async () => {
        const h = await setup();
        try {
            expect((await h.attach()).error).toBeUndefined();
            expect(h.sockets.last().lastOfType('attach-pane')).toMatchObject({ paneID: PANE, cols: 100, rows: 30 });
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'api')).toBe(false);
            await waitFor(() => expect(h.received.some(item => item.type === 'terminal-frame')).toBe(true));
            h.ack(h.received.find(item => item.type === 'terminal-frame')!);
            const replay = new Uint8Array([0x1b, 0x5b, 0x32, 0x4a, 0xf0, 0x9f, 0x98, 0x80]);
            act(() => {
                h.sockets.last().emitBinary(encodePtyFrame(PTY_FRAME_TYPES.replay, PANE, replay)!);
                h.sockets.last().emitBinary(encodePtyFrame(PTY_FRAME_TYPES.output, PANE, new TextEncoder().encode('live'))!);
            });
            // Each generation begins with its current presentation; consume all non-byte frames.
            await waitFor(() => {
                for (const message of h.received.filter(item => item.type === 'terminal-frame' && item.frame.type === 'presentation')) h.ack(message);
                expect(h.received.some(item => item.frame?.type === 'replay')).toBe(true);
            });
            const delivered = h.received.find(item => item.frame?.type === 'replay')!;
            expect([...delivered.frame.data]).toEqual([...replay]);
            expect(h.received.some(item => item.frame?.type === 'output')).toBe(false);
            h.ack(delivered);
            await waitFor(() => expect(h.received.some(item => item.frame?.type === 'output')).toBe(true));
            expect(paneHandle(PANE)).not.toBeNull();
        } finally { h.dispose(); }
        expect(paneHandle(PANE)).toBeNull();
    });

    it('reads selection at action time, targets phone actions, and makes stale input inert after disposal', async () => {
        const h = await setup();
        try {
            await h.attach();
            const handle = paneHandle(PANE)!;
            const selection = handle.readSelection!();
            await waitFor(() => expect(h.received.some(item => item.type === 'terminal-action' && item.action.type === 'selection')).toBe(true));
            const request = h.received.find(item => item.type === 'terminal-action' && item.action.type === 'selection')!;
            h.child.postMessage({ type: 'terminal-action-reply', session: 'one', id: request.id, result: '' });
            expect(await selection).toBe('');
            handle.dispatchKey({ key: 'Escape', code: 'Escape' });
            await waitFor(() => expect(h.received.some(item => item.action?.type === 'dispatchKey')).toBe(true));
            h.child.postMessage({ type: 'terminal-input', session: 'one', direct: false, data: new TextEncoder().encode('key') });
            await waitFor(() => expect(h.sockets.last().frames.map(decodePtyFrame).some(item => item?.type === PTY_FRAME_TYPES.input)).toBe(true));
            const before = h.sockets.last().frames.length;
            h.view.unmount(); handle.write('stale');
            expect(h.sockets.last().frames).toHaveLength(before);
            expect(h.sockets.last().lastOfType('detach-pane')).toMatchObject({ paneID: PANE });
        } finally { h.dispose(); }
    });

    it('rejects attachment outside the selected feature and releases a failed view', async () => {
        const ungranted = await setup(false);
        try {
            expect((await ungranted.attach()).error).toContain('selected terminal renderer');
            expect(ungranted.sockets.last().lastOfType('attach-pane')).toBeUndefined();
        } finally { ungranted.dispose(); }
        const h = await setup();
        try {
            await h.attach();
            h.child.postMessage({ type: 'view-error', message: 'bad renderer' });
            await waitFor(() => expect(h.onError).toHaveBeenCalledWith('bad renderer'));
            expect(paneHandle(PANE)).toBeNull();
            expect(h.sockets.last().lastOfType('detach-pane')).toMatchObject({ paneID: PANE });
            expect(h.requests.mock.calls.some(([payload]) => payload['action'] === 'release')).toBe(true);
        } finally { h.dispose(); }
    });
});
