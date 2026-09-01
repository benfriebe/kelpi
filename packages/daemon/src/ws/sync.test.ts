import { isWireCommand, WS_PROTOCOL_VERSION, type WireMessage } from '@kelpi/protocol';
import { enclosingSplitPath, ratioAtPath, type PaneLayout } from '@kelpi/core/layout';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher, ReplyHandle } from '../seams.js';
import { G1, harness as storeHarness, HOME, NOW, seededState, W1, W2 } from '../store/testing.js';
import {
    BAD_TOKEN_MESSAGE,
    createSyncHub,
    isWsOnlyCommand,
    WS_CLOSE_CODES,
    WS_ONLY_COMMANDS,
    type SyncHub,
    type SyncPaneBridge,
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
        client: { kind: 'browser', name: 'kelpi-web' },
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
        // §APP-069: `home` rides the identity so the client can abbreviate the DAEMON's paths
        // to `~`. It is display-only, and deliberately still absent from the mirror below.
        expect(welcome['daemon']).toEqual({ version: '0.1.0', build: '42', pid: 4242, home: HOME });

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
        expect(BAD_TOKEN_MESSAGE).toContain('kelpid url');
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
        // The audit's "the daemon and the window disagree indefinitely": a `kelpi workspace
        // create` from a terminal moves the daemon's last-active, and the window that is still
        // showing the OLD workspace then clicks its row — an unchanged report for this
        // connection, but the only signal the daemon gets. While `setActiveWorkspace` returned
        // early on its own value being unchanged, that click could never pull the answer back
        // and `kelpi workspace list`'s ACTIVE column stayed wrong for the rest of the session.
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

    /**
     * §WS-112 — activation opens the group the destination is hidden in, EVERY time.
     *
     * The churn guard ("this workspace is already the last-active, do nothing") used to swallow
     * the whole action, including the expand. A workspace can be the last-active and still be
     * inside a group the user collapsed after arriving: re-activating it (⌘1–9, the palette, a
     * status-popover row) then did nothing at all and the sidebar kept the group shut around the
     * workspace it had just said the user was in.
     */
    it('expands a collapsed parent group even when the workspace is already active', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        const report = JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID });
        session.handleMessage(report);
        expect(f.store.state().lastActiveWorkspaceID).toBe(W1);

        // The user files the active workspace into a group and collapses it.
        f.store.dispatch(
            { type: 'create-group', id: G1, name: 'Client', now: NOW },
            { type: 'move-workspace-to-group', id: W1, groupID: G1, index: null },
            { type: 'set-group-collapsed', id: G1, collapsed: true }
        );
        expect(f.store.state().groups[0]?.isCollapsed).toBe(true);

        // …and activates it again. Same id as the last-active: the guard must still let the
        // expand through.
        session.handleMessage(report);
        expect(f.store.state().groups[0]?.isCollapsed).toBe(false);
        expect(f.store.state().lastActiveWorkspaceID).toBe(W1);
    });

    it('still says nothing when the re-assert has no work to do', () => {
        // The other half of the guard, unchanged: an idempotent report for a workspace whose
        // group is already open produces no dispatch at all, so a client that reports on every
        // click does not churn the delta stream.
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        const report = JSON.stringify({ type: 'focus-report', workspaceID: W1, paneID: f.paneID });
        session.handleMessage(report);
        const before = transport.ofType('delta').length;
        session.handleMessage(report);
        session.handleMessage(report);
        expect(transport.ofType('delta').length).toBe(before);
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

    /**
     * §LAY-061 — the divider drag's split-path spelling.
     *
     * The `tiled` tree below is the shape that had no wire spelling at all: the ROOT split's
     * two children are themselves splits, so no pane's `enclosingSplitPath` is `"d"` and
     * `pane-resize` — which addresses a PANE — cannot move that divider.
     */
    describe('set-split-ratio', () => {
        const PANE_C = '22222222-3333-4444-8555-666666666666';
        const PANE_D = '33333333-4444-4555-8666-777777777777';

        function tiled(): Fixture {
            const f = fixture();
            for (const paneID of [PANE_B, PANE_C, PANE_D]) {
                f.store.dispatch({
                    type: 'split-pane',
                    workspaceID: W1,
                    paneID,
                    direction: 'horizontal',
                    now: NOW
                });
            }
            // `tiled` over four panes is split(h, split(v, …), split(v, …)) — root children
            // are both splits, and the action stamps `currentLayoutIndex`.
            f.store.dispatch({ type: 'select-layout', workspaceID: W1, kind: 'tiled' });
            return f;
        }

        const layoutOf = (f: Fixture): PaneLayout =>
            f.store.state().workspaces[0]?.layout ?? { kind: 'empty' };

        it('moves a divider no pane can address, and clears the layout index', () => {
            const f = tiled();
            // The premise: every pane's enclosing split is a CHILD of the root, never the root.
            for (const paneID of [PANE_A, PANE_B, PANE_C, PANE_D]) {
                expect(enclosingSplitPath(layoutOf(f), paneID)?.path).not.toBe('d');
            }
            expect(f.store.state().workspaces[0]?.currentLayoutIndex).not.toBeNull();

            const reply = send(f, {
                command: 'set-split-ratio',
                workspace_id: W1,
                split_path: 'd',
                ratio: 0.7
            });
            expect(reply).toEqual({ ok: true, workspace_id: W1, split_path: 'd', ratio: 0.7 });
            expect(ratioAtPath(layoutOf(f), 'd')).toBeCloseTo(0.7);
            // A manual resize breaks the tracked predefined layout (LAY-048's rule).
            expect(f.store.state().workspaces[0]?.currentLayoutIndex).toBeNull();
        });

        it('reports the STORED ratio, so a drag past the clamp is corrected', () => {
            const f = tiled();
            const reply = send(f, {
                command: 'set-split-ratio',
                workspace_id: W1,
                split_path: 'dR',
                ratio: 0.02
            });
            expect(reply).toMatchObject({ ok: true, ratio: 0.1 });
            expect(ratioAtPath(layoutOf(f), 'dR')).toBeCloseTo(0.1);
        });

        it('refuses a stale path instead of silently no-op’ing', () => {
            const f = tiled();
            const before = layoutOf(f);
            // "dLL" is a LEAF, not a split: in the model that is a no-op, which over a wire
            // would read as success.
            expect(
                send(f, { command: 'set-split-ratio', workspace_id: W1, split_path: 'dLL', ratio: 0.7 })
            ).toEqual({ ok: false, error: "no split at path 'dLL'" });
            expect(layoutOf(f)).toEqual(before);
        });

        it('refuses an unknown workspace, a missing path and a non-numeric ratio', () => {
            const f = tiled();
            expect(
                send(f, { command: 'set-split-ratio', workspace_id: 'nope', split_path: 'd', ratio: 0.5 })['ok']
            ).toBe(false);
            expect(send(f, { command: 'set-split-ratio', workspace_id: W1, split_path: 'd' })['ok']).toBe(false);
            expect(
                send(f, { command: 'set-split-ratio', workspace_id: W1, split_path: 'd', ratio: 'wide' })['ok']
            ).toBe(false);
            expect(send(f, { command: 'set-split-ratio', workspace_id: W1, ratio: 0.5 })['ok']).toBe(false);
        });
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

        // SET-062: the text colour is the other half of §6.2's encoding, with two meanings
        // `color` does not have — absent leaves it alone, `null`/`auto` is the luminance rule.
        it('stores a text colour, and takes null (or "auto") back to the luminance rule', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship', color: 'blue', text_color: '#ffffff' });
            expect(f.store.state().labelPresets[0]?.textColor).toEqual({ kind: 'custom', hex: '#ffffff' });
            send(f, { command: 'update-label-preset', id: 'ship', text_color: null });
            expect(f.store.state().labelPresets[0]?.textColor).toBeNull();
            send(f, { command: 'update-label-preset', id: 'ship', text_color: '#000000' });
            send(f, { command: 'update-label-preset', id: 'ship', text_color: 'auto' });
            expect(f.store.state().labelPresets[0]?.textColor).toBeNull();
            // Absent = unchanged: a recolor must not silently reset the text colour.
            send(f, { command: 'update-label-preset', id: 'ship', text_color: 'white' });
            send(f, { command: 'update-label-preset', id: 'ship', color: 'purple' });
            expect(f.store.state().labelPresets[0]?.textColor).toEqual({ kind: 'named', color: 'white' });
        });

        // SET-059: "the chosen text colour is only applied when the add actually creates a new
        // preset", so a duplicate name cannot recolour the preset that already holds it.
        it('never lets a duplicate add recolour the existing preset', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship', color: 'blue', text_color: '#ffffff' });
            expect(send(f, { command: 'add-label-preset', name: 'ship', text_color: '#000000' })['ok']).toBe(
                false
            );
            expect(f.store.state().labelPresets[0]?.textColor).toEqual({ kind: 'custom', hex: '#ffffff' });
        });

        // A rename moves the preset's identity, so the text colour has to follow it.
        it('applies a text colour to the RENAMED preset when both arrive together', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'ship', color: 'blue' });
            send(f, { command: 'update-label-preset', id: 'ship', name: 'shipped', text_color: '#ffffff' });
            expect(f.store.state().labelPresets).toEqual([
                {
                    name: 'shipped',
                    color: { kind: 'named', color: 'blue' },
                    textColor: { kind: 'custom', hex: '#ffffff' }
                }
            ]);
        });

        // SET-065's reorder: by NAME plus a target index, so a stale client index cannot
        // scramble the list, and an index off either end clamps rather than failing.
        it('reorders by name and target index, clamping to the list', () => {
            const f = fixture();
            send(f, { command: 'add-label-preset', name: 'a' });
            send(f, { command: 'add-label-preset', name: 'b' });
            send(f, { command: 'add-label-preset', name: 'c' });
            expect(send(f, { command: 'move-label-preset', id: 'c', index: 0 })).toMatchObject({
                ok: true,
                id: 'c',
                index: 0
            });
            expect(presets(f).map((preset) => preset.name)).toEqual(['c', 'a', 'b']);
            send(f, { command: 'move-label-preset', id: 'c', index: 99 });
            expect(presets(f).map((preset) => preset.name)).toEqual(['a', 'b', 'c']);
            expect(send(f, { command: 'move-label-preset', id: 'nope', index: 0 })['ok']).toBe(false);
            expect(send(f, { command: 'move-label-preset', id: 'a' })['ok']).toBe(false);
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
            dedupeKey: `kelpi-${f.paneID}`
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
            dedupeKey: `kelpi-${f.paneID}`
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

/**
 * §SET-200 / §SET-201: the global-hotkey registration outcome, relayed.
 *
 * The daemon registers nothing and has no opinion about accelerators — the Electron shell owns
 * `globalShortcut`. What it owns is being the only thing every window shares, so it relays the
 * shell's report and REMEMBERS the last one: a claimed hotkey is a standing condition, and a
 * Settings window opened an hour later still has to be able to explain the dead chord.
 */
describe('hotkey-status relay', () => {
    const report = (overrides: Record<string, unknown> = {}): string =>
        JSON.stringify({
            type: 'hotkey-status',
            accelerator: null,
            configString: 'ctrl+alt+n',
            ok: false,
            error: 'This shortcut is already claimed by another app.',
            source: 'launch',
            ...overrides
        });

    it('fans a shell report out to every attached client', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        shell.session.handleMessage(report());
        const relayed = window.transport.ofType('hotkey-status')[0] as Record<string, unknown>;
        expect(relayed).toEqual({
            type: 'hotkey-status',
            accelerator: null,
            configString: 'ctrl+alt+n',
            ok: false,
            error: 'This shortcut is already claimed by another app.',
            source: 'launch'
        });
    });

    it('replays the last report to a client that attaches afterwards', () => {
        const f = fixture();
        const shell = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        shell.session.handleMessage(report());

        const late = f.connect();
        late.session.handleMessage(hello());
        expect(late.transport.ofType('hotkey-status')).toHaveLength(1);
        // …and after the handshake, not before it: a client must have its snapshot first.
        expect(late.transport.json.map((m) => m['type'])).toEqual([
            'welcome',
            'snapshot',
            'hotkey-status'
        ]);
    });

    it('replaces the remembered report, so a success clears a standing failure', () => {
        const f = fixture();
        const shell = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        shell.session.handleMessage(report());
        shell.session.handleMessage(
            report({ ok: true, error: null, accelerator: 'Control+Alt+N', source: 'settings' })
        );

        const late = f.connect();
        late.session.handleMessage(hello());
        const replayed = late.transport.ofType('hotkey-status')[0] as Record<string, unknown>;
        expect(replayed['ok']).toBe(true);
        expect(replayed['error']).toBeNull();
    });

    it('drops a malformed report rather than remembering it', () => {
        const f = fixture();
        const shell = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        // No `ok` field: nothing can be concluded, and a stored bad frame would be re-sent to
        // every future client.
        shell.session.handleMessage(JSON.stringify({ type: 'hotkey-status', error: 'nope' }));

        const late = f.connect();
        late.session.handleMessage(hello());
        expect(late.transport.ofType('hotkey-status')).toHaveLength(0);
    });

    it('normalizes an unknown source rather than passing it through', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());
        shell.session.handleMessage(report({ source: 'whatever' }));
        expect(
            (window.transport.ofType('hotkey-status')[0] as Record<string, unknown>)['source']
        ).toBe('settings');
    });
});

/**
 * §AGNT-056: `shell-activation`, relayed.
 *
 * The Swift reads `NSApplication.didBecomeActiveNotification` in the same process as the pane
 * grid; here the grid is in the renderer and activation is known only to the shell, so the fact
 * travels the one channel both share. The daemon's job is fan-out and nothing else — and,
 * unlike the hotkey outcome, it must NOT remember: a replayed "window W is inactive" would
 * suspend a fresh client's dwell timers on a premise about a window that may not exist any more.
 */
describe('shell-activation relay', () => {
    it('fans a shell report out to every attached client, windowID intact', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', active: false, windowID: 'WIN-1' }));
        expect(window.transport.ofType('shell-activation')[0]).toEqual({
            type: 'shell-activation',
            active: false,
            windowID: 'WIN-1'
        });

        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', active: true, windowID: 'WIN-1' }));
        expect(window.transport.ofType('shell-activation')[1]).toEqual({
            type: 'shell-activation',
            active: true,
            windowID: 'WIN-1'
        });
    });

    it('relays an unscoped report without inventing a window id', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', active: true }));
        expect(window.transport.ofType('shell-activation')[0]).toEqual({ type: 'shell-activation', active: true });
    });

    it('never replays activation to a client that attaches afterwards', () => {
        const f = fixture();
        const shell = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', active: false, windowID: 'WIN-1' }));

        const late = f.connect();
        late.session.handleMessage(hello());
        expect(late.transport.ofType('shell-activation')).toHaveLength(0);
    });

    it('drops a report with no boolean `active` rather than guessing one', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', windowID: 'WIN-1' }));
        shell.session.handleMessage(JSON.stringify({ type: 'shell-activation', active: 'yes' }));
        expect(window.transport.ofType('shell-activation')).toHaveLength(0);
    });
});

/**
 * §WS-151: `workspace-selection`, relayed — `shell-activation` with the arrow reversed.
 *
 * The shipped app's File ▸ "Deselect All Workspaces" is `.disabled(selectedWorkspaceIDs.isEmpty)`,
 * one reducer read away from the menu that shows it. Here the menu is in the main process and
 * the selection is the sidebar's client-local state, so the count travels the one channel both
 * share. The daemon's job is fan-out and nothing else, and — like activation, unlike the hotkey
 * outcome — it must NOT remember: a replayed "3 selected" would un-grey the row for a window
 * whose page has since reloaded with nothing selected.
 */
describe('workspace-selection relay', () => {
    it('fans a client report out to every attached party, windowID intact', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        window.session.handleMessage(
            JSON.stringify({ type: 'workspace-selection', selected: 3, windowID: 'WIN-1' })
        );
        expect(shell.transport.ofType('workspace-selection')[0]).toEqual({
            type: 'workspace-selection',
            selected: 3,
            windowID: 'WIN-1'
        });

        window.session.handleMessage(
            JSON.stringify({ type: 'workspace-selection', selected: 0, windowID: 'WIN-1' })
        );
        expect(shell.transport.ofType('workspace-selection')[1]).toEqual({
            type: 'workspace-selection',
            selected: 0,
            windowID: 'WIN-1'
        });
    });

    it('relays an unscoped report without inventing a window id', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        window.session.handleMessage(JSON.stringify({ type: 'workspace-selection', selected: 1 }));
        expect(shell.transport.ofType('workspace-selection')[0]).toEqual({
            type: 'workspace-selection',
            selected: 1
        });
    });

    it('never replays a selection to a party that attaches afterwards', () => {
        const f = fixture();
        const window = f.connect();
        window.session.handleMessage(hello());
        window.session.handleMessage(
            JSON.stringify({ type: 'workspace-selection', selected: 2, windowID: 'WIN-1' })
        );

        const late = f.connect();
        late.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        expect(late.transport.ofType('workspace-selection')).toHaveLength(0);
    });

    it('drops an unusable count rather than guessing one', () => {
        const f = fixture();
        const shell = f.connect();
        const window = f.connect();
        shell.session.handleMessage(hello({ client: { kind: 'electron', name: 'kelpi-shell' } }));
        window.session.handleMessage(hello());

        window.session.handleMessage(JSON.stringify({ type: 'workspace-selection', windowID: 'WIN-1' }));
        window.session.handleMessage(JSON.stringify({ type: 'workspace-selection', selected: '2' }));
        window.session.handleMessage(JSON.stringify({ type: 'workspace-selection', selected: -1 }));
        expect(shell.transport.ofType('workspace-selection')).toHaveLength(0);
    });
});

/**
 * §WS-156 / §APP-067 — the GUI's own workspace delete.
 *
 * The clause it exists for is the shipped app's asymmetry: `kelpi workspace delete` refuses at one
 * workspace, ⌘W on the last pane of the last one does not, and the window lands on "No workspace
 * selected". The port had one verb for both, so the GUI inherited the CLI's refusal.
 *
 * What is asserted here is the SEAM, because that is where the safety is: the flag that waives
 * the guard reaches the handler only on a message this layer CONSTRUCTED, and it is not a field
 * anything decoded off the control socket could carry (`decode.ts` never reads `allow_last`; the
 * dictionary in wire-protocol.md §7 has no entry for it).
 */
describe('the GUI’s delete-workspace (§WS-156)', () => {
    function drive(payload: Record<string, unknown>): Fixture {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'del1', payload }));
        return f;
    }

    it('constructs a workspace-delete carrying allow_last, and dispatches it', () => {
        const f = drive({ command: 'delete-workspace', workspace_id: W1, force: true, allow_last: true });

        expect(f.calls).toHaveLength(1);
        expect(f.calls[0]?.message).toEqual({
            command: 'workspace-delete',
            name: W1,
            force: true,
            allow_last: true
        });
        // Request/response, like the CLI's own delete: the caller's promise settles on a reply.
        expect(f.calls[0]?.reply).not.toBeNull();
    });

    it('never asserts allow_last on its own — the caller has to say so', () => {
        const f = drive({ command: 'delete-workspace', workspace_id: W1 });
        expect(f.calls[0]?.message).toMatchObject({ allow_last: false, force: false });
    });

    it('accepts `name` as well as `workspace_id`, and refuses neither', () => {
        expect(drive({ command: 'delete-workspace', name: 'w1' }).calls[0]?.message).toMatchObject({
            command: 'workspace-delete',
            name: 'w1'
        });

        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'command', id: 'del2', payload: { command: 'delete-workspace' } }));
        expect(f.calls).toHaveLength(0);
        expect(transport.ofType('command-reply')[0]?.['reply']).toEqual({
            ok: false,
            error: 'delete-workspace requires workspace_id'
        });
    });

    it('is NOT a wire command, so the CLI can never send it', () => {
        // The whole safety argument in one line: `allow_last` rides a verb the control socket's
        // decoder does not know, on a message the decoder never builds.
        expect(isWireCommand('delete-workspace')).toBe(false);
        expect(isWireCommand('workspace-delete')).toBe(true);
    });
});

describe('size control (terminal-surface.md §5.1)', () => {
    interface BridgeLog {
        readonly attaches: { paneID: string; size: { cols: number; rows: number } | undefined }[];
        readonly resizes: { paneID: string; cols: number; rows: number }[];
    }

    function paneBridge(): BridgeLog & { bridge: SyncPaneBridge } {
        const attaches: BridgeLog['attaches'] = [];
        const resizes: BridgeLog['resizes'] = [];
        return {
            attaches,
            resizes,
            bridge: {
                attach(paneID, size) {
                    attaches.push({ paneID, size });
                },
                detach() {},
                resize(paneID, cols, rows) {
                    resizes.push({ paneID, cols, rows });
                },
                close() {}
            }
        };
    }

    function connectWithBridge(f: ReturnType<typeof fixture>) {
        const transport = recordingTransport();
        const log = paneBridge();
        const session = f.hub.createSession(transport, log.bridge);
        session.handleMessage(hello());
        return { session, transport, ...log };
    }

    const send = (session: SyncSession, message: Record<string, unknown>): void => {
        session.handleMessage(JSON.stringify(message));
    };

    const controlMessages = (transport: RecordedTransport): (string | null)[] =>
        transport.json
            .filter((m) => m['type'] === 'size-control')
            .map((m) => m['ownerClientID'] as string | null);

    it("a connection's FIRST attach claims ownership; the next client's first attach takes it over", () => {
        const f = fixture();
        const a = connectWithBridge(f);
        send(a.session, { type: 'attach-pane', paneID: f.paneID, cols: 120, rows: 40 });
        // The claim is broadcast, and the owner attached WITH its measured size.
        expect(controlMessages(a.transport)).toEqual([a.session.clientID]);
        expect(a.attaches).toEqual([{ paneID: f.paneID, size: { cols: 120, rows: 40 } }]);

        const b = connectWithBridge(f);
        // The standing owner is replayed at B's handshake completion.
        expect(controlMessages(b.transport)).toEqual([a.session.clientID]);
        send(b.session, { type: 'attach-pane', paneID: f.paneID, cols: 80, rows: 24 });
        // B's first attach takes over (last-connected-wins), and everyone hears it.
        expect(controlMessages(b.transport)).toEqual([a.session.clientID, b.session.clientID]);
        expect(controlMessages(a.transport)).toEqual([a.session.clientID, b.session.clientID]);
        expect(b.attaches).toEqual([{ paneID: f.paneID, size: { cols: 80, rows: 24 } }]);

        // A's LATER attaches do not steal ownership back — only take-size-control does.
        send(a.session, { type: 'attach-pane', paneID: f.paneID, cols: 120, rows: 40 });
        expect(controlMessages(a.transport)).toEqual([a.session.clientID, b.session.clientID]);
        // …and a non-owner attaches at the pane's CURRENT geometry (no size applied).
        expect(a.attaches[1]).toEqual({ paneID: f.paneID, size: undefined });
    });

    it("a non-owner's resize is cached, never applied; take-size-control applies the cache in one step", () => {
        const f = fixture();
        const a = connectWithBridge(f);
        send(a.session, { type: 'attach-pane', paneID: f.paneID, cols: 120, rows: 40 });
        const b = connectWithBridge(f);
        send(b.session, { type: 'attach-pane', paneID: f.paneID, cols: 80, rows: 24 });

        // A (non-owner now) resizes: recorded nowhere on the bridge…
        send(a.session, { type: 'resize-pane', paneID: f.paneID, cols: 200, rows: 60 });
        expect(a.resizes).toEqual([]);

        // …until A takes control, which applies its LAST-reported geometry immediately.
        send(a.session, { type: 'take-size-control' });
        expect(a.resizes).toEqual([{ paneID: f.paneID, cols: 200, rows: 60 }]);
        expect(controlMessages(b.transport).at(-1)).toBe(a.session.clientID);

        // The owner's resizes apply directly.
        send(a.session, { type: 'resize-pane', paneID: f.paneID, cols: 201, rows: 61 });
        expect(a.resizes).toHaveLength(2);
        // And the deposed owner's stop applying.
        send(b.session, { type: 'resize-pane', paneID: f.paneID, cols: 81, rows: 25 });
        expect(b.resizes).toEqual([]);
    });

    it('the departing owner hands control to the most recent remaining client, whose cache applies', () => {
        const f = fixture();
        const a = connectWithBridge(f);
        send(a.session, { type: 'attach-pane', paneID: f.paneID, cols: 120, rows: 40 });
        const b = connectWithBridge(f);
        send(b.session, { type: 'attach-pane', paneID: f.paneID, cols: 80, rows: 24 });

        b.session.close();
        // A is promoted and its cached layout applies — panes must not stay frozen at a
        // window that no longer exists.
        expect(controlMessages(a.transport).at(-1)).toBe(a.session.clientID);
        expect(a.resizes).toEqual([{ paneID: f.paneID, cols: 120, rows: 40 }]);

        // With nobody left, the owner clears; the next report from a new client claims.
        a.session.close();
        const c = connectWithBridge(f);
        expect(controlMessages(c.transport)).toEqual([]);
        send(c.session, { type: 'resize-pane', paneID: f.paneID, cols: 90, rows: 30 });
        expect(controlMessages(c.transport)).toEqual([c.session.clientID]);
        expect(c.resizes).toEqual([{ paneID: f.paneID, cols: 90, rows: 30 }]);
    });
});
