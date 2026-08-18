/**
 * The WS half of the host seam: registration (both ways in), RPC routing, host events, the
 * takeover rules, and the client-facing console subscription.
 *
 * Driven through the real `SyncHub` with a recording transport, so the framing asserted here
 * is exactly what the Electron shell will see on the wire.
 */

import { WS_PROTOCOL_VERSION } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

import type { ControlDispatcher } from '../seams.js';
import { createStore, emptyDaemonState, type NexStore } from '../store/index.js';
import {
    createSyncHub,
    WEB_CONSOLE_LINE_MESSAGE,
    WEB_HOST_CAPABILITY,
    type SyncHub,
    type SyncSession
} from '../ws/sync.js';
import { recordingTransport, type RecordedTransport } from '../ws/testing.js';
import { NO_HOST_ERROR } from './host.js';
import { createWebPaneService, type WebPaneService } from './service.js';
import { HOME, id, SHELL_PANE, WEB_PANE, WEB_TAB, WORKSPACE, NOW } from './testing.js';

const DAEMON = { version: '0.1.0', build: '42', pid: 4242 };

interface Fixture {
    readonly hub: SyncHub;
    readonly store: NexStore;
    readonly service: WebPaneService;
    connect(): { session: SyncSession; transport: RecordedTransport };
}

function fixture(): Fixture {
    const store = createStore(emptyDaemonState(HOME));
    store.dispatch({
        type: 'create-workspace',
        id: WORKSPACE,
        paneID: SHELL_PANE,
        name: 'w1',
        color: 'blue',
        now: NOW
    });
    store.dispatch({
        type: 'open-web-pane',
        workspaceID: WORKSPACE,
        paneID: WEB_PANE,
        tabID: WEB_TAB,
        url: 'https://example.com',
        now: NOW
    });
    const service = createWebPaneService({ store, now: () => NOW });
    const dispatcher: ControlDispatcher = (_message, reply) => {
        reply?.send({ ok: true });
        reply?.close();
    };
    const hub = createSyncHub({ store, dispatcher, daemon: DAEMON, webPanes: service });
    return {
        hub,
        store,
        service,
        connect() {
            const transport = recordingTransport();
            const session = hub.createSession(transport);
            return { session, transport };
        }
    };
}

function hello(client: Record<string, unknown> = { kind: 'electron', name: 'nex-shell' }): string {
    return JSON.stringify({
        type: 'hello',
        protocolVersion: WS_PROTOCOL_VERSION,
        token: 'tok',
        client
    });
}

describe('host registration', () => {
    it('claims the role with an explicit host-register and acks it', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane', name: 'shell' }));

        const registered = transport.ofType('host-registered');
        expect(registered).toHaveLength(1);
        expect(registered[0]).toMatchObject({ role: 'web-pane', superseded: false });
        expect(f.service.hasHost).toBe(true);
        // Registration replays the existing web panes so the shell can build its views.
        expect(transport.ofType('host-notify').map((message) => message['verb'])).toEqual(['pane-open']);
    });

    it('claims the role straight from the hello capability list', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(
            hello({ kind: 'electron', name: 'nex-shell', capabilities: [WEB_HOST_CAPABILITY] })
        );
        expect(transport.ofType('host-registered')).toHaveLength(1);
        expect(f.service.hasHost).toBe(true);
    });

    it('ignores host traffic from a connection that never registered', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                payload: { level: 'log', message: 'spoofed' }
            })
        );
        expect(f.service.console.drain(WEB_PANE).lines).toEqual([]);
    });

    it('hands the role to the newest host and tells the old one', async () => {
        const f = fixture();
        const first = f.connect();
        first.session.handleMessage(hello());
        first.session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));

        const stranded = f.service.call('url', {});
        const second = f.connect();
        second.session.handleMessage(hello());
        second.session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));

        expect(first.transport.ofType('host-revoked')[0]).toMatchObject({ reason: 'superseded' });
        await expect(stranded).resolves.toEqual({ ok: false, error: 'web pane host disconnected' });
        expect(second.transport.ofType('host-registered')[0]).toMatchObject({ superseded: true });

        // The superseded connection can no longer answer RPCs or push events.
        void f.service.call('capture', {});
        const rpc = second.transport.ofType('host-rpc')[0] as Record<string, unknown>;
        first.session.handleMessage(
            JSON.stringify({ type: 'host-rpc-reply', id: rpc['id'], reply: { ok: true, stale: true } })
        );
        first.session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                payload: { level: 'log', message: 'from the old host' }
            })
        );
        expect(f.service.console.drain(WEB_PANE).lines).toEqual([]);
    });

    it('frees the slot when the host disconnects or unregisters', async () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));
        session.handleMessage(JSON.stringify({ type: 'host-unregister' }));
        expect(f.service.hasHost).toBe(false);
        await expect(f.service.call('url', {})).resolves.toEqual({ ok: false, error: NO_HOST_ERROR });

        const again = f.connect();
        again.session.handleMessage(hello());
        again.session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));
        expect(f.service.hasHost).toBe(true);
        again.session.close();
        expect(f.service.hasHost).toBe(false);
    });
});

describe('host RPC + events over the socket', () => {
    it('round-trips one RPC and settles the caller', async () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));

        const pending = f.service.call('actuate', { paneID: WEB_PANE, method: 'click' });
        const rpc = transport.ofType('host-rpc')[0] as Record<string, unknown>;
        expect(rpc['verb']).toBe('actuate');
        session.handleMessage(
            JSON.stringify({ type: 'host-rpc-reply', id: rpc['id'], reply: { ok: true, matched: true } })
        );
        await expect(pending).resolves.toEqual({ ok: true, matched: true });
    });

    it('feeds console lines and page-state changes into daemon state', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));

        session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                tabID: WEB_TAB,
                payload: { level: 'warn', message: 'careful', url: 'https://example.com/' }
            })
        );
        expect(f.service.console.drain(WEB_PANE).lines[0]).toMatchObject({
            level: 'warn',
            message: 'careful',
            tab_id: WEB_TAB
        });

        session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'page-state',
                paneID: WEB_PANE,
                tabID: WEB_TAB,
                payload: { url: 'https://example.com/next', title: 'Next' }
            })
        );
        const web = f.store.getState().workspaces[0]?.webPanes[WEB_PANE];
        expect(web?.tabs[0]).toEqual({ id: WEB_TAB, url: 'https://example.com/next', title: 'Next' });
    });
});

describe('client console subscription', () => {
    it('answers with the catch-up drain and then streams one message per line', () => {
        const f = fixture();
        const host = f.connect();
        host.session.handleMessage(hello());
        host.session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));

        const client = f.connect();
        client.session.handleMessage(hello({ kind: 'browser' }));
        host.session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                tabID: WEB_TAB,
                payload: { level: 'log', message: 'before' }
            })
        );

        client.session.handleMessage(
            JSON.stringify({
                type: 'command',
                id: 'c1',
                payload: { command: 'web-console-subscribe', pane_id: WEB_PANE }
            })
        );
        const reply = client.transport.ofType('command-reply')[0]?.['reply'] as Record<string, unknown>;
        expect(reply).toMatchObject({ ok: true, pane_id: WEB_PANE, next_since: 1, follow: true });
        expect((reply['lines'] as unknown[])).toHaveLength(1);

        host.session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                tabID: WEB_TAB,
                payload: { level: 'error', message: 'live' }
            })
        );
        const streamed = client.transport.ofType(WEB_CONSOLE_LINE_MESSAGE);
        expect(streamed).toHaveLength(1);
        expect(streamed[0]?.['line']).toMatchObject({ seq: 1, level: 'error', message: 'live' });

        // Unsubscribe stops the stream; a dropped connection would do the same.
        client.session.handleMessage(
            JSON.stringify({
                type: 'command',
                id: 'c2',
                payload: { command: 'web-console-unsubscribe', pane_id: WEB_PANE }
            })
        );
        host.session.handleMessage(
            JSON.stringify({
                type: 'host-event',
                event: 'console',
                paneID: WEB_PANE,
                tabID: WEB_TAB,
                payload: { level: 'log', message: 'after' }
            })
        );
        expect(client.transport.ofType(WEB_CONSOLE_LINE_MESSAGE)).toHaveLength(1);
        expect(f.service.console.subscribers(WEB_PANE)).toBe(0);
    });

    it('requires pane_id and reports when web panes are unavailable', () => {
        const f = fixture();
        const { session, transport } = f.connect();
        session.handleMessage(hello({ kind: 'browser' }));
        session.handleMessage(
            JSON.stringify({ type: 'command', id: 'x', payload: { command: 'web-console-subscribe' } })
        );
        expect(transport.ofType('command-reply')[0]?.['reply']).toEqual({
            ok: false,
            error: 'web-console-subscribe requires pane_id'
        });

        const bare = createSyncHub({
            store: f.store,
            dispatcher: () => {},
            daemon: DAEMON
        });
        const transport2 = recordingTransport();
        const session2 = bare.createSession(transport2);
        session2.handleMessage(hello({ kind: 'browser' }));
        session2.handleMessage(
            JSON.stringify({
                type: 'command',
                id: 'x',
                payload: { command: 'web-console-subscribe', pane_id: WEB_PANE }
            })
        );
        expect(transport2.ofType('command-reply')[0]?.['reply']).toEqual({
            ok: false,
            error: 'web panes are not available'
        });
    });

    it('drops a client subscription when its connection closes', () => {
        const f = fixture();
        const host = f.connect();
        host.session.handleMessage(hello());
        host.session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));
        const client = f.connect();
        client.session.handleMessage(hello({ kind: 'browser' }));
        client.session.handleMessage(
            JSON.stringify({
                type: 'command',
                id: 'c1',
                payload: { command: 'web-console-subscribe', pane_id: WEB_PANE }
            })
        );
        expect(f.service.console.subscribers(WEB_PANE)).toBe(1);
        client.session.close();
        expect(f.service.console.subscribers(WEB_PANE)).toBe(0);
    });
});

describe('unknown ids', () => {
    it('ignores a reply for a call nobody made', () => {
        const f = fixture();
        const { session } = f.connect();
        session.handleMessage(hello());
        session.handleMessage(JSON.stringify({ type: 'host-register', role: 'web-pane' }));
        expect(() =>
            session.handleMessage(
                JSON.stringify({ type: 'host-rpc-reply', id: id('00000000', 1), reply: { ok: true } })
            )
        ).not.toThrow();
    });
});
