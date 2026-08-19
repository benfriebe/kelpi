import { isWireCommand, WS_PROTOCOL_VERSION, type WireMessage } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { G1, harness as storeHarness, NOW, seededState, W1, W2 } from '../store/testing.js';
import {
    BAD_TOKEN_MESSAGE,
    createSyncHub,
    isWsOnlyCommand,
    WS_CLOSE_CODES,
    WS_ONLY_COMMANDS,
    type SyncHub,
    type SyncSession
} from './sync.js';
import { PANE_A, PANE_B, recordingTransport, type RecordedTransport } from './testing.js';

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

    /** A hub whose token is `good` — the shape the daemon builds when a run-dir token exists. */
    function tokenHub(): SyncHub {
        return createSyncHub({
            store: storeHarness(seededState()).store,
            dispatcher: () => {},
            daemon: DAEMON,
            validateToken: (token) => token === 'good'
        });
    }

    it('rejects a bad token with an actionable reason and a coded close', () => {
        const hub = tokenHub();
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(hello({ token: 'bad' }));
        expect(transport.json[0]).toMatchObject({
            type: 'rejected',
            code: 'unauthorized',
            reason: 'bad-token',
            message: BAD_TOKEN_MESSAGE
        });
        // The message has to tell a person what to do, not just what failed.
        expect(BAD_TOKEN_MESSAGE).toContain('nexd url');
        expect(transport.closes[0]?.code).toBe(WS_CLOSE_CODES.unauthorized);
        expect(session.ready).toBe(false);
    });

    it('rejects a hello with no token at all (the tokenless browser case)', () => {
        const hub = tokenHub();
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        // No `token` key whatsoever — what a client built from a bare origin sends.
        session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, client: {} }));
        expect(transport.json[0]).toMatchObject({ type: 'rejected', reason: 'bad-token' });
        expect(session.ready).toBe(false);
    });

    it('exempts an upgrade-authenticated connection that omits the hello token', () => {
        const hub = tokenHub();
        const transport = recordingTransport();
        // The Electron shell's bearer-header path (`shell/src/hello.ts` documents the rule).
        const session = hub.createSession(transport, undefined, { authenticated: true });
        session.handleMessage(JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, client: {} }));
        expect(transport.json.map((m) => m['type'])).toEqual(['welcome', 'snapshot']);
        expect(session.ready).toBe(true);
    });

    it('still checks a hello token that an upgrade-authenticated connection does present', () => {
        const hub = tokenHub();
        const transport = recordingTransport();
        const session = hub.createSession(transport, undefined, { authenticated: true });
        session.handleMessage(hello({ token: 'bad' }));
        expect(transport.json[0]).toMatchObject({ type: 'rejected', reason: 'bad-token' });
        expect(session.ready).toBe(false);
    });

    it('accepts anything when the daemon has no token (allowAnonymous / dev)', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello({ token: '' }));
        expect(transport.json.map((m) => m['type'])).toEqual(['welcome', 'snapshot']);
        expect(session.ready).toBe(true);
    });

    it('refuses anything before the handshake', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID }));
        expect(transport.json[0]).toMatchObject({
            type: 'rejected',
            code: 'server-error',
            reason: 'expected-hello'
        });
        expect(session.ready).toBe(false);
    });

    it('closes a connection that never says hello, and lets one that does live', async () => {
        const store = storeHarness(seededState());
        const hub = createSyncHub({
            store: store.store,
            dispatcher: () => {},
            daemon: DAEMON,
            helloTimeoutMs: 20
        });

        const idle = recordingTransport();
        const idleSession = hub.createSession(idle);
        const helloed = recordingTransport();
        hub.createSession(helloed).handleMessage(hello());

        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(idle.json[0]).toMatchObject({ type: 'rejected', reason: 'hello-timeout' });
        expect(idle.closes[0]?.code).toBe(WS_CLOSE_CODES.serverError);
        expect(idleSession.ready).toBe(false);
        // The deadline is disarmed by a successful handshake, not merely by time passing.
        expect(helloed.ofType('rejected')).toHaveLength(0);
        expect(helloed.closes).toHaveLength(0);
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

    it('lets an unchanged visibility report pull the last-active workspace back (run-B L3)', () => {
        // The audit's "the daemon and the window disagree indefinitely": a `nex workspace
        // create` from a terminal moves the daemon's last-active, and the window that is still
        // showing the OLD workspace then clicks its row — an unchanged report for this
        // connection, but the only signal the daemon gets. While `setActiveWorkspace` returned
        // early on its own value being unchanged, that click could never pull the answer back
        // and `nex workspace list`'s ACTIVE column stayed wrong for the rest of the session.
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        const report = JSON.stringify({
            type: 'visibility-report',
            workspaceID: W1,
            visiblePaneIDs: [f.paneID],
            documentVisible: true
        });

        session.handleMessage(report);
        expect(f.store.state().lastActiveWorkspaceID).toBe(W1);

        // Something else moves it — this is what a CLI `workspace create` does.
        f.store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'other', now: NOW });
        expect(f.store.state().lastActiveWorkspaceID).toBe(W2);

        // The same client re-asserts the workspace it never stopped showing.
        session.handleMessage(report);
        expect(f.store.state().lastActiveWorkspaceID).toBe(W1);
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

describe('WS-only commands', () => {
    /** Sends one WS-only command and returns its reply object. */
    function send(f: Fixture, payload: Record<string, unknown>): Record<string, unknown> {
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'ws1', payload }));
        // Never reaches the CLI dispatcher: these verbs are not wire commands.
        expect(f.calls).toHaveLength(0);
        return transport.ofType('command-reply')[0]?.['reply'] as Record<string, unknown>;
    }

    it('zooms the named pane, focusing it first', () => {
        const f = fixture();
        f.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PANE_B,
            direction: 'horizontal',
            now: 1
        });
        f.store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: PANE_B });

        const reply = send(f, { command: 'toggle-zoom', pane_id: f.paneID });
        expect(reply).toMatchObject({ ok: true, pane_id: f.paneID, zoomed_pane_id: f.paneID });
        const workspace = f.store.state().workspaces[0];
        expect(workspace?.zoomedPaneID).toBe(f.paneID);
        expect(workspace?.focusedPaneID).toBe(f.paneID);
        expect(workspace?.layout).toEqual({ kind: 'leaf', paneID: f.paneID });
    });

    it('un-zooms on a second toggle and restores the saved layout', () => {
        const f = fixture();
        f.store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PANE_B,
            direction: 'horizontal',
            now: 1
        });
        const before = f.store.state().workspaces[0]?.layout;

        send(f, { command: 'toggle-zoom', pane_id: f.paneID });
        send(f, { command: 'toggle-zoom', pane_id: f.paneID });

        const workspace = f.store.state().workspaces[0];
        expect(workspace?.zoomedPaneID).toBeNull();
        expect(workspace?.layout).toEqual(before);
    });

    it('rejects a zoom for an unknown pane', () => {
        const f = fixture();
        const reply = send(f, { command: 'toggle-zoom', pane_id: 'nope' });
        expect(reply['ok']).toBe(false);
        expect(reply['error']).toContain('nope');
    });

    it('collapses and expands a group', () => {
        const f = fixture();
        f.store.dispatch({ type: 'create-group', id: G1, name: 'projects', now: 1 });

        expect(send(f, { command: 'set-group-collapsed', group_id: G1, collapsed: true })).toEqual({
            ok: true,
            group_id: G1,
            collapsed: true
        });
        expect(f.store.state().groups[0]?.isCollapsed).toBe(true);

        send(f, { command: 'set-group-collapsed', group_id: G1, collapsed: false });
        expect(f.store.state().groups[0]?.isCollapsed).toBe(false);
    });

    it('renames a workspace', () => {
        const f = fixture();
        const reply = send(f, { command: 'rename-workspace', workspace_id: W1, name: '  renamed  ' });
        expect(reply).toEqual({ ok: true, workspace_id: W1, name: 'renamed' });
        expect(f.store.state().workspaces[0]?.name).toBe('renamed');
    });

    it('refuses an empty rename and an unknown workspace', () => {
        const f = fixture();
        expect(send(f, { command: 'rename-workspace', workspace_id: W1, name: '   ' })['ok']).toBe(false);
        expect(send(f, { command: 'rename-workspace', workspace_id: 'nope', name: 'x' })['ok']).toBe(false);
        expect(f.store.state().workspaces[0]?.name).toBe('dev');
    });

    it('keeps its vocabulary out of the CLI wire vocabulary', () => {
        expect([...WS_ONLY_COMMANDS].every((command) => isWsOnlyCommand(command))).toBe(true);
        expect(isWsOnlyCommand('pane-list')).toBe(false);
        for (const command of WS_ONLY_COMMANDS) expect(isWireCommand(command)).toBe(false);
    });

    // ── label presets (M8 Settings ▸ Labels, app-state-core.md §6.4) ─────────────────

    describe('label presets', () => {
        const presets = (f: Fixture): { name: string; color: unknown }[] =>
            f.store.state().labelPresets.map((preset) => ({ name: preset.name, color: preset.color }));

        it('adds a preset with §6.2’s one-string color, defaulting to gray', () => {
            const f = fixture();
            expect(send(f, { command: 'add-label-preset', name: '  ship  ', color: 'blue' })).toMatchObject({
                ok: true,
                name: 'ship'
            });
            send(f, { command: 'add-label-preset', name: 'wip' });
            send(f, { command: 'add-label-preset', name: 'custom', color: '#FF8800' });
            expect(presets(f)).toEqual([
                { name: 'ship', color: { kind: 'named', color: 'blue' } },
                { name: 'wip', color: { kind: 'named', color: 'gray' } },
                { name: 'custom', color: { kind: 'custom', hex: '#ff8800' } }
            ]);
        });

        it('tells the caller about a duplicate instead of no-op’ing silently', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship' });
            expect(send(f, { command: 'add-label-preset', name: 'ship' })).toEqual({
                ok: false,
                error: "label preset 'ship' already exists"
            });
            expect(send(f, { command: 'add-label-preset', name: '  ' })['ok']).toBe(false);
        });

        it('recolors without touching the name, and renames without touching the color', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship', color: 'blue' });
            send(f, { command: 'update-label-preset', id: 'ship', color: 'purple' });
            expect(presets(f)).toEqual([{ name: 'ship', color: { kind: 'named', color: 'purple' } }]);
            send(f, { command: 'update-label-preset', id: 'ship', name: 'shipped' });
            expect(presets(f)).toEqual([{ name: 'shipped', color: { kind: 'named', color: 'purple' } }]);
        });

        it('refuses a rename onto another preset, and an unknown id', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship' });
            send(f, { command: 'add-label-preset', name: 'wip' });
            expect(send(f, { command: 'update-label-preset', id: 'ship', name: 'wip' })['ok']).toBe(false);
            expect(send(f, { command: 'update-label-preset', id: 'nope', color: 'blue' })).toEqual({
                ok: false,
                error: "no label preset matches 'nope'"
            });
            expect(presets(f).map((preset) => preset.name)).toEqual(['ship', 'wip']);
        });

        // §6.4: deleting a preset never touches the workspaces wearing the label.
        it('removes a preset and leaves the workspace’s label string alone', () => {
            const f = fixture();
            f.store.dispatch({ type: 'workspace-labels', id: W1, op: 'set', values: ['ship'] });
            send(f, { command: 'add-label-preset', name: 'ship' });
            expect(send(f, { command: 'remove-label-preset', id: 'ship' })).toMatchObject({ ok: true, id: 'ship' });
            expect(presets(f)).toEqual([]);
            expect(f.store.state().workspaces[0]?.labels).toEqual(['ship']);
            expect(send(f, { command: 'remove-label-preset', id: 'ship' })['ok']).toBe(false);
        });

        it('answers with the post-mutation list so a client can render the reply', () => {
            const f = fixture();
            const reply = send(f, { command: 'add-label-preset', name: 'ship', color: 'blue' });
            expect(reply['label_presets']).toEqual([
                { name: 'ship', color: { kind: 'named', color: 'blue' }, textColor: null }
            ]);
        });
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
