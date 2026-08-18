import { WS_PROTOCOL_VERSION, type WireMessage } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createSyncHub, WS_CLOSE_CODES, type SyncHub, type SyncSession } from './sync.js';
import { PANE_A, recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };

interface Recorded {
    readonly message: WireMessage;
    readonly reply: ReplyHandle | null;
}

interface Fixture {
    readonly hub: SyncHub;
    readonly store: ReturnType<typeof storeHarness>;
    readonly calls: Recorded[];
    readonly paneID: string;
    connect(): { session: SyncSession; transport: RecordedTransport };
}

function fixture(answer?: (message: WireMessage, reply: ReplyHandle) => void): Fixture {
    const paneID = PANE_A;
    const store = storeHarness(seededState(W1, paneID));
    const calls: Recorded[] = [];
    const dispatcher: ControlDispatcher = (message, reply) => {
        calls.push({ message, reply });
        if (reply === null) return;
        if (answer !== undefined) {
            answer(message, reply);
            return;
        }
        reply.send({ ok: true, command: message.command });
        reply.close();
    };
    const hub = createSyncHub({ store: store.store, dispatcher, daemon: DAEMON, now: () => 1_700_000_000_000 });
    return {
        hub,
        store,
        calls,
        paneID,
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            return { session, transport };
        }
    };
}

function hello(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: 'tok',
        client: { kind: 'browser', name: 'nex-web' },
        ...overrides
    });
}

describe('handshake', () => {
    it('answers hello with welcome then a snapshot', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());

        expect(transport.json.map((m) => m['type'])).toEqual(['welcome', 'snapshot']);
        const welcome = transport.json[0] as Record<string, unknown>;
        expect(welcome['protocolVersion']).toBe(WS_PROTOCOL_VERSION);
        expect(welcome['clientID']).toBe(session.clientID);
        expect(welcome['daemon']).toEqual({ version: '0.1.0', build: '42', pid: 4242 });

        const snapshot = transport.json[1] as Record<string, unknown>;
        expect(snapshot['seq']).toBe(0);
        const state = snapshot['state'] as Record<string, unknown>;
        expect(state['homeDirectory']).toBeUndefined();
        expect((state['workspaces'] as unknown[]).length).toBe(1);
        expect(session.ready).toBe(true);
        expect(session.client?.kind).toBe('browser');
    });

    it('rejects a protocol mismatch and closes', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello({ protocolVersion: WS_PROTOCOL_VERSION + 1 }));

        expect(transport.json).toHaveLength(1);
        expect(transport.json[0]).toMatchObject({
            type: 'rejected',
            code: 'protocol-mismatch',
            protocolVersion: WS_PROTOCOL_VERSION
        });
        expect(transport.closes[0]?.code).toBe(WS_CLOSE_CODES.protocolMismatch);
        expect(session.ready).toBe(false);
        expect(f.hub.sessions).toHaveLength(0);
    });

    it('rejects a bad token', () => {
        const store = storeHarness(seededState());
        const hub = createSyncHub({
            store: store.store,
            dispatcher: () => {},
            daemon: DAEMON,
            validateToken: (token) => token === 'good'
        });
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(hello({ token: 'bad' }));
        expect(transport.json[0]).toMatchObject({ type: 'rejected', code: 'unauthorized' });
        expect(transport.closes[0]?.code).toBe(WS_CLOSE_CODES.unauthorized);
        expect(session.ready).toBe(false);
    });

    it('refuses anything before the handshake', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));
        expect(transport.json[0]).toMatchObject({ type: 'rejected', code: 'server-error' });
        expect(session.ready).toBe(false);
    });

    it('tells a resuming client to resync until instance ids exist', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello({ resumeFromSeq: 7 }));
        expect(transport.json.map((m) => m['type'])).toEqual(['welcome', 'resync-required', 'snapshot']);
        expect(transport.json[1]).toMatchObject({ reason: 'seq-gap' });
    });

    it('ignores malformed frames and unknown message types', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        const before = transport.json.length;
        session.handleMessage('not json');
        session.handleMessage(JSON.stringify({ type: 'from-the-future', payload: 1 }));
        session.handleMessage(JSON.stringify(['array']));
        expect(transport.json).toHaveLength(before);
    });
});

describe('delta stream', () => {
    it('streams store events in order with monotonic seq', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());

        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'renamed' });
        f.store.dispatch({ type: 'set-workspace-color', id: W1, color: 'red' });

        const deltas = transport.ofType('delta');
        expect(deltas.map((delta) => delta['seq'])).toEqual([1, 2]);
        const first = deltas[0]?.['events'] as Record<string, unknown>[];
        expect(first[0]?.['kind']).toBe('workspace-upserted');
        expect((first[0]?.['workspace'] as Record<string, unknown>)['name']).toBe('renamed');
        expect(f.hub.seq).toBe(2);
    });

    it('gives a late client a snapshot anchored at the current seq, then the next delta', () => {
        const f = fixture();
        const early = f.connect();
        early.session.handleMessage(hello());
        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'first' });

        const late = f.connect();
        late.session.handleMessage(hello());
        const snapshot = late.transport.ofType('snapshot')[0] as Record<string, unknown>;
        expect(snapshot['seq']).toBe(1);
        const workspaces = (snapshot['state'] as Record<string, unknown>)['workspaces'] as Record<string, unknown>[];
        expect(workspaces[0]?.['name']).toBe('first');

        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'second' });
        expect(late.transport.ofType('delta').map((delta) => delta['seq'])).toEqual([2]);
        expect(early.transport.ofType('delta').map((delta) => delta['seq'])).toEqual([1, 2]);
    });

    it('stops sending to a closed session', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.close();
        f.store.dispatch({ type: 'rename-workspace', id: W1, name: 'after' });
        expect(transport.ofType('delta')).toHaveLength(0);
        expect(f.hub.sessions).toHaveLength(0);
    });
});

describe('reports', () => {
    it('routes a focus report into the store and tracks the client active workspace', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());

        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));

        expect(f.store.state().workspaces[0]?.focusedPaneID).toBe(f.paneID);
        expect(f.store.state().lastActiveWorkspaceID).toBe(W1);
        expect(session.activeWorkspaceID).toBe(W1);
        expect(session.focusedPaneID).toBe(f.paneID);
    });

    it('accepts a null focus report (nothing focused)', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));
        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: null }));
        expect(f.store.state().workspaces[0]?.focusedPaneID).toBeNull();
        expect(session.focusedPaneID).toBeNull();
    });

    it('tracks visibility for the notification suppression rule', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        expect(f.hub.presence()).toMatchObject({ clients: 1, visibleClients: 0, anyVisible: false });

        session.handleMessage(
            JSON.stringify({
                type: 'visibility-report',
                workspaceID: W1,
                visiblePaneIDs: [f.paneID],
                documentVisible: true
            })
        );

        expect(session.documentVisible).toBe(true);
        expect([...session.visiblePaneIDs]).toEqual([f.paneID]);
        expect(f.hub.presence()).toMatchObject({ visibleClients: 1, anyVisible: true });
    });

    it('answers ping with pong', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'ping', id: 'p1' }));
        expect(transport.ofType('pong')).toEqual([{ type: 'pong', id: 'p1' }]);
    });
});

describe('commands', () => {
    it('dispatches an allowlisted command and returns its reply', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'c1', payload: { command: 'ping' } }));

        expect(f.calls.map((call) => call.message.command)).toEqual(['ping']);
        expect(f.calls[0]?.reply).not.toBeNull();
        expect(transport.ofType('command-reply')).toEqual([
            { type: 'command-reply', id: 'c1', reply: { ok: true, command: 'ping' } }
        ]);
    });

    it('acknowledges fire-and-forget commands so the client RPC settles', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(
            JSON.stringify({ type: 'command', id: 'c2', payload: { command: 'stop', pane_id: f.paneID } })
        );

        expect(f.calls.map((call) => call.message.command)).toEqual(['stop']);
        expect(f.calls[0]?.reply).toBeNull();
        expect(transport.ofType('command-reply')).toEqual([{ type: 'command-reply', id: 'c2', reply: { ok: true } }]);
    });

    it('replays the session_id dual-fire without a second reply', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(
            JSON.stringify({
                type: 'command',
                id: 'c3',
                payload: { command: 'stop', pane_id: f.paneID, session_id: 'abc' }
            })
        );

        expect(f.calls.map((call) => call.message.command)).toEqual(['stop', 'session-start']);
        expect(f.calls.every((call) => call.reply === null)).toBe(true);
        expect(transport.ofType('command-reply')).toHaveLength(1);
    });

    it('answers a malformed command instead of dropping it', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'c4', payload: { command: 'nonsense' } }));

        expect(f.calls).toHaveLength(0);
        const reply = transport.ofType('command-reply')[0]?.['reply'] as Record<string, unknown>;
        expect(reply['ok']).toBe(false);
        expect(typeof reply['error']).toBe('string');
    });

    it('never leaves a client hanging when a handler answers nothing', () => {
        const f = fixture((_message, reply) => {
            reply.close();
        });
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'c5', payload: { command: 'ping' } }));
        expect(transport.ofType('command-reply')[0]?.['reply']).toMatchObject({ ok: false });
    });

    it('fires reply-handle disconnect callbacks when the connection goes away', () => {
        let disconnected = false;
        const f = fixture((_message, reply) => {
            reply.onDisconnect(() => {
                disconnected = true;
            });
            reply.send({ ok: true });
            // deliberately left open: this is the web-console --follow shape
        });
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'c6', payload: { command: 'ping' } }));
        expect(disconnected).toBe(false);
        session.close();
        expect(disconnected).toBe(true);
    });
});

describe('broadcast', () => {
    it('fans a notification out to every ready client', () => {
        const f = fixture();
        const a = f.connect();
        const b = f.connect();
        a.session.handleMessage(hello());
        b.session.handleMessage(hello());

        f.hub.broadcast({
            type: 'notification',
            kind: 'agent-waiting',
            paneID: f.paneID,
            workspaceID: W1,
            title: 'dev',
            body: 'Agent is waiting for input',
            dedupeKey: `nex-${f.paneID}`
        });

        expect(a.transport.ofType('notification')).toHaveLength(1);
        expect(b.transport.ofType('notification')).toHaveLength(1);
    });

    it('suppresses a pane notification for the client that shows that pane focused', () => {
        const f = fixture();
        const focused = f.connect();
        const other = f.connect();
        focused.session.handleMessage(hello());
        other.session.handleMessage(hello());

        focused.session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));
        focused.session.handleMessage(
            JSON.stringify({
                type: 'visibility-report',
                workspaceID: W1,
                visiblePaneIDs: [f.paneID],
                documentVisible: true
            })
        );

        expect(f.hub.isPaneAttended(W1, f.paneID)).toBe(true);

        f.hub.broadcast({
            type: 'notification',
            kind: 'agent-waiting',
            paneID: f.paneID,
            workspaceID: W1,
            title: 'dev',
            body: 'Agent is waiting for input',
            dedupeKey: `nex-${f.paneID}`
        });

        expect(focused.transport.ofType('notification')).toHaveLength(0);
        expect(other.transport.ofType('notification')).toHaveLength(1);
    });

    it('does not suppress non-notification events', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));
        session.handleMessage(
            JSON.stringify({
                type: 'visibility-report',
                workspaceID: W1,
                visiblePaneIDs: [f.paneID],
                documentVisible: true
            })
        );
        f.hub.broadcast({ type: 'pane-exit', paneID: f.paneID, exitCode: 0 });
        expect(transport.ofType('pane-exit')).toHaveLength(1);
    });

    it('says nobody is attended when no client is connected (headless notifies)', () => {
        const f = fixture();
        expect(f.hub.isPaneAttended(W1, f.paneID)).toBe(false);
        expect(f.hub.presence().anyVisible).toBe(false);
    });

    it('closes every session on hub close', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        f.hub.close();
        expect(transport.closes.at(-1)?.code).toBe(1001);
        expect(f.hub.sessions).toHaveLength(0);
    });
});
