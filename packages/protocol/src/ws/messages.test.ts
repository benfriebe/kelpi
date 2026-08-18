import { describe, expect, it } from 'vitest';

import {
    WS_DELTA_KINDS,
    WS_PROTOCOL_VERSION,
    WS_REJECTION_CODES,
    type WsClientMessage,
    type WsDeltaEvent,
    type WsServerMessage
} from './messages.js';

describe('client-sync protocol envelope', () => {
    it('pins a positive integer protocol version', () => {
        expect(Number.isInteger(WS_PROTOCOL_VERSION)).toBe(true);
        expect(WS_PROTOCOL_VERSION).toBeGreaterThan(0);
    });

    it('round-trips the hello handshake as JSON', () => {
        const hello: WsClientMessage = {
            type: 'hello',
            protocolVersion: WS_PROTOCOL_VERSION,
            token: 'abc',
            client: { kind: 'browser', name: 'nex-web', version: '0.1.0' },
            resumeFromSeq: 12
        };
        expect(JSON.parse(JSON.stringify(hello))).toEqual(hello);
    });

    it('round-trips reports, snapshots and deltas', () => {
        const messages: (WsClientMessage | WsServerMessage)[] = [
            { type: 'attach-pane', paneID: 'A', cols: 120, rows: 40 },
            { type: 'detach-pane', paneID: 'A' },
            { type: 'focus-report', workspaceID: 'W', paneID: null },
            { type: 'visibility-report', workspaceID: 'W', visiblePaneIDs: ['A'], documentVisible: true },
            { type: 'command', id: '1', payload: { command: 'pane-list' } },
            { type: 'snapshot', seq: 7, state: { workspaces: [] } },
            { type: 'delta', seq: 8, events: [{ kind: 'pane-removed', id: 'A' }] },
            { type: 'command-reply', id: '1', reply: { ok: true } },
            {
                type: 'notification',
                kind: 'agent-waiting',
                paneID: 'A',
                workspaceID: 'W',
                title: 'Claude',
                body: 'waiting for input',
                dedupeKey: 'nex-A'
            },
            { type: 'pane-exit', paneID: 'A', exitCode: 0 },
            { type: 'resync-required', reason: 'seq-gap' }
        ];
        for (const message of messages) expect(JSON.parse(JSON.stringify(message))).toEqual(message);
    });

    it('names every delta event kind it can carry', () => {
        const events: WsDeltaEvent[] = [
            { kind: 'app-patch', value: { activeWorkspaceID: 'W' } },
            { kind: 'workspace-upserted', id: 'W', value: { name: 'main' } },
            { kind: 'workspace-removed', id: 'W' },
            { kind: 'group-upserted', id: 'G', value: { name: 'projects' } },
            { kind: 'group-removed', id: 'G' },
            { kind: 'pane-upserted', id: 'A', value: { type: 'shell' } },
            { kind: 'pane-removed', id: 'A' },
            { kind: 'layout-changed', workspaceID: 'W', layout: { leaf: 'A' } }
        ];
        expect(events.map((event) => event.kind).sort()).toEqual([...WS_DELTA_KINDS].sort());
    });

    it('enumerates the handshake rejection codes', () => {
        expect([...WS_REJECTION_CODES]).toEqual(['protocol-mismatch', 'unauthorized', 'server-error']);
    });
});
