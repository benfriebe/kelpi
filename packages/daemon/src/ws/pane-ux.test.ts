/**
 * The pane-UX WS verbs, driven end to end through a real `SyncHub` session: the manual status
 * override, terminal search, reopen-closed-pane, create-scratchpad and reveal-path.
 *
 * Round-trips rather than direct handler calls, for the reason `polish.test.ts` states: the
 * thing worth protecting is the WHOLE path — matched before the wire decode (every one of these
 * is deliberately absent from `WIRE_COMMANDS`), routed to its channel, answered on the
 * connection that asked, and — for the async ones — settled through `command-reply` rather than
 * returned inline.
 */

import { WS_PROTOCOL_VERSION, type JsonObject } from '@kelpi/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { harness as storeHarness, id, seededState, W1 } from '../store/testing.js';
import type { TerminalMatch } from '../term/search.js';
import { createPaneLifecycleChannel, type PaneLifecycleChannel } from './panes.js';
import { createTerminalSearchChannel } from './search.js';
import { createSyncHub, isWsOnlyCommand, type SyncHub, type SyncSession } from './sync.js';
import { recordingTransport, type RecordedTransport } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };
const PANE = id('dddddddd', 100);

const noopDispatcher: ControlDispatcher = (_message, reply) => {
    reply?.send({ ok: true });
    reply?.close();
};

interface Fixture {
    readonly hub: SyncHub;
    readonly store: ReturnType<typeof storeHarness>;
    setMatches(matches: readonly TerminalMatch[]): void;
    connect(): { session: SyncSession; transport: RecordedTransport };
}

function fixture(options: { panes?: PaneLifecycleChannel } = {}): Fixture {
    const store = storeHarness(seededState(W1, PANE));
    let matches: readonly TerminalMatch[] = [];
    const hub = createSyncHub({
        store: store.store,
        dispatcher: noopDispatcher,
        daemon: DAEMON,
        now: () => 1_700_000_000_000,
        search: createTerminalSearchChannel({
            store: store.store,
            term: { searchAsync: () => Promise.resolve(matches) }
        }),
        ...(options.panes === undefined ? {} : { panes: options.panes })
    });
    return {
        hub,
        store,
        setMatches(next) {
            matches = next;
        },
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

function send(session: SyncSession, transport: RecordedTransport, payload: JsonObject): string {
    const id = `req-${String(transport.json.length)}`;
    session.handleMessage(JSON.stringify({ type: 'command', id, payload }));
    return id;
}

function replyFor(transport: RecordedTransport, id: string): JsonObject {
    const reply = [...transport.json]
        .reverse()
        .find((message) => message['type'] === 'command-reply' && message['id'] === id);
    if (reply === undefined) throw new Error(`no reply for ${id}`);
    return reply['reply'] as JsonObject;
}

function ask(session: SyncSession, transport: RecordedTransport, payload: JsonObject): JsonObject {
    return replyFor(transport, send(session, transport, payload));
}

/** The async verbs answer on a later microtask; drain it before reading. */
async function askAsync(
    session: SyncSession,
    transport: RecordedTransport,
    payload: JsonObject
): Promise<JsonObject> {
    const id = send(session, transport, payload);
    // One macrotask drains every microtask the handler chain queued.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return replyFor(transport, id);
}

describe('set-pane-status', () => {
    it('is a WS-only verb', () => {
        expect(isWsOnlyCommand('set-pane-status')).toBe(true);
    });

    it('forces a pane into running and arms the elapsed clock', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        const reply = ask(session, transport, {
            command: 'set-pane-status',
            pane_id: PANE,
            status: 'running'
        });
        expect(reply).toMatchObject({ ok: true, pane_id: PANE, workspace_id: W1, status: 'running' });
        const pane = f.store.state().workspaces[0]?.panes[0];
        expect(pane?.status).toBe('running');
        expect(pane?.agentStartedAt).toBe(1_700_000_000_000);
    });

    it('clears the background task count so no stale "N running" lingers', () => {
        const f = fixture();
        f.store.dispatch({
            type: 'pane-agent-event',
            paneID: PANE,
            workspaceID: W1,
            now: 1,
            event: { type: 'agentStopped', backgroundTaskCount: 3 }
        });
        expect(f.store.state().workspaces[0]?.panes[0]?.backgroundTaskCount).toBe(3);
        const { session, transport } = f.connect();
        ask(session, transport, { command: 'set-pane-status', pane_id: PANE, status: 'idle' });
        expect(f.store.state().workspaces[0]?.panes[0]?.backgroundTaskCount).toBe(0);
    });

    it('refuses an unknown status and an unknown pane', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'set-pane-status', pane_id: PANE, status: 'busy' })).toMatchObject(
            { ok: false }
        );
        expect(
            ask(session, transport, { command: 'set-pane-status', pane_id: 'ghost', status: 'idle' })
        ).toEqual({ ok: false, error: "no pane matches 'ghost'" });
        expect(ask(session, transport, { command: 'set-pane-status', status: 'idle' })).toMatchObject({
            ok: false
        });
    });
});

describe('terminal-search over the socket', () => {
    it('opens, counts, navigates and closes', async () => {
        const f = fixture();
        const { session, transport } = f.connect();

        const opened = await askAsync(session, transport, {
            command: 'terminal-search',
            action: 'toggle',
            workspace_id: W1
        });
        expect(opened).toMatchObject({ ok: true, pane_id: PANE, needle: '' });

        f.setMatches([
            { line: 10, col: 0, length: 6, linesFromBottom: 90 },
            { line: 40, col: 3, length: 6, linesFromBottom: 60 }
        ]);
        const set = await askAsync(session, transport, {
            command: 'terminal-search',
            action: 'set',
            workspace_id: W1,
            needle: 'marker'
        });
        expect(set).toMatchObject({ ok: true, total: 2, selected: null });

        const next = await askAsync(session, transport, {
            command: 'terminal-search',
            action: 'next',
            workspace_id: W1
        });
        expect(next).toMatchObject({ selected: 0 });
        expect(next['match']).toMatchObject({ lines_from_bottom: 90 });

        const closed = await askAsync(session, transport, {
            command: 'terminal-search',
            action: 'close',
            workspace_id: W1
        });
        expect(closed).toMatchObject({ ok: true, pane_id: null, total: null });
    });

    it('says so when the daemon has no search channel', async () => {
        const store = storeHarness(seededState(W1, PANE));
        const hub = createSyncHub({ store: store.store, dispatcher: noopDispatcher, daemon: DAEMON });
        const transport = recordingTransport();
        const session = hub.createSession(transport);
        session.handleMessage(
            JSON.stringify({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, client: { kind: 'browser' } })
        );
        expect(ask(session, transport, { command: 'terminal-search', action: 'toggle', workspace_id: W1 })).toEqual({
            ok: false,
            error: 'terminal search is not available'
        });
    });
});

describe('reopen-closed-pane / create-scratchpad / reveal-path over the socket', () => {
    it('answers "not available" without a pane channel', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'reopen-closed-pane', workspace_id: W1 })).toEqual({
            ok: false,
            error: 'reopen-closed-pane is not available'
        });
        expect(ask(session, transport, { command: 'create-scratchpad', workspace_id: W1 })).toEqual({
            ok: false,
            error: 'create-scratchpad is not available'
        });
    });

    it('routes through the channel when one is wired', () => {
        const calls: { command: string; payload: Record<string, unknown> }[] = [];
        const channel: PaneLifecycleChannel = {
            run(command, payload) {
                calls.push({ command, payload });
                return { ok: true, pane_id: 'NEW' };
            }
        };
        const f = fixture({ panes: channel });
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'create-scratchpad', workspace_id: W1 })).toEqual({
            ok: true,
            pane_id: 'NEW'
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.command).toBe('create-scratchpad');
    });

    it('turns a throwing channel into an error reply rather than a dropped RPC', () => {
        const channel: PaneLifecycleChannel = {
            run() {
                throw new Error('boom');
            }
        };
        const f = fixture({ panes: channel });
        const { session, transport } = f.connect();
        expect(ask(session, transport, { command: 'reveal-path', path: '/tmp' })).toMatchObject({ ok: false });
    });

    it('broadcasts a reveal that the shell can act on', () => {
        const store = storeHarness(seededState(W1, PANE));
        const broadcasts: Record<string, unknown>[] = [];
        const channel = createPaneLifecycleChannel({
            ctx: {
                store: store.store,
                pty: {
                    spawn: () => {},
                    has: () => false,
                    write: () => {},
                    writeDirect: () => {},
                    resize: () => {},
                    kill: () => {},
                    killAll: async () => {},
                    setSyncGroup: () => {},
                    onData: () => () => {},
                    onExit: () => () => {}
                },
                term: {
                    attach: () => {},
                    feed: () => {},
                    resize: () => {},
                    capture: () => '',
                    snapshot: () => ({ data: new Uint8Array(0), cols: 0, rows: 0 }),
                    modes: () => ({ applicationCursorKeys: false, bracketedPaste: false }),
                    dispose: () => {}
                },
                input: { sendText: () => {}, sendNamedKey: () => {} },
                version: { version: '0.1.0', build: '1', protocol: 1 },
                broadcast: (event) => broadcasts.push(event)
            }
        });
        expect(channel.run('reveal-path', { path: '/tmp/x', select: true })).toMatchObject({ ok: true });
        expect(broadcasts).toEqual([{ type: 'reveal-path', path: '/tmp/x', select: true }]);
    });
});
