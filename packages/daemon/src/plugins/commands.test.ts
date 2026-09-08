import { describe, expect, it, vi } from 'vitest';
import { WS_PROTOCOL_VERSION, type JsonObject } from '@kelpi/protocol';
import { createStore } from '../store/store.js';
import { seededState, W1 } from '../store/testing.js';
import { createSyncHub } from '../ws/sync.js';
import { recordingTransport } from '../ws/testing.js';
import type { ReplyHandle } from '../seams.js';

describe('plugins use the shared Kelpi command path', () => {
    it('routes UI-only and CLI commands without registering a client or claiming PTY size', async () => {
        const store = createStore(seededState());
        const dispatch = vi.fn((_msg, reply: ReplyHandle | null) => { reply?.send({ ok: true, value: 'cli' }); reply?.close(); });
        const hub = createSyncHub({ store, dispatcher: dispatch, daemon: { version: '1', build: 'test' } });
        try {
            const context = { daemonID: 'daemon', workspaceID: W1, windowID: 'W' };
            expect(await hub.executeCommand({ command: 'workspace-list' }, context, new AbortController().signal)).toEqual({ ok: true, value: 'cli' });
            expect(await hub.executeCommand({ command: 'rename-workspace', workspace_id: W1, name: 'via plugin' }, context, new AbortController().signal)).toMatchObject({ ok: true });
            expect(store.getState().workspaces[0]?.name).toBe('via plugin');
            expect(hub.presence()).toEqual({ clients: 0, visibleClients: 0, anyVisible: false });
            expect(hub.sessions).toHaveLength(0);
        } finally { hub.close(); }
    });
    it('settles aborted commands and releases handler subscriptions', async () => {
        const disconnect = vi.fn();
        const hub = createSyncHub({ store: createStore(seededState()), dispatcher: (_msg, reply) => reply?.onDisconnect(disconnect), daemon: { version: '1', build: 'test' } });
        const abort = new AbortController();
        try {
            const command = hub.executeCommand({ command: 'workspace-list' }, { daemonID: 'D' }, abort.signal);
            abort.abort(); await expect(command).rejects.toThrow('cancelled');
            await Promise.resolve(); expect(disconnect).toHaveBeenCalledOnce();
        } finally { hub.close(); }
    });
    it('preserves authenticated window context and refuses paired-device installation', () => {
        const run = vi.fn((_action: string, _args: JsonObject, reply: ReplyHandle) => { reply.send({ ok: true }); reply.close(); });
        const releaseClient = vi.fn();
        const hub = createSyncHub({ store: createStore(seededState()), dispatcher: () => {}, daemon: { version: '1', build: 'test' }, validateToken: () => true, plugins: { run, releaseClient } });
        try {
            const transport = recordingTransport(); const session = hub.createSession(transport);
            session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, token: 'kd_test', client: { kind: 'browser', windowID: 'WIN' } }));
            session.handleMessage(JSON.stringify({ type: 'command', id: 'install', payload: { command: 'plugin', action: 'install', text: '{}' } }));
            expect(session.ready).toBe(true);
            expect(run).not.toHaveBeenCalled();
            expect(transport.json.at(-1)).toMatchObject({ type: 'command-reply', reply: { ok: false, error: 'plugin management requires the daemon owner' } });
            session.handleMessage(JSON.stringify({ type: 'command', id: 'list', payload: { command: 'plugin', action: 'list', text: '{}' } }));
            expect(run).toHaveBeenCalledWith('list', {}, expect.anything(), expect.objectContaining({ clientID: session.clientID, windowID: 'WIN' }));
            session.close(); expect(releaseClient).toHaveBeenCalledWith(session.clientID);
        } finally { hub.close(); }
    });
});
