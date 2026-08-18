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
            { type: 'delta', seq: 8, events: [{ kind: 'pane-removed', workspaceID: 'W', paneID: 'A' }] },
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

    it('names every delta event kind the daemon store emits', () => {
        const events: WsDeltaEvent[] = [
            { kind: 'workspace-upserted', id: 'W', workspace: { name: 'main', recentlyClosedCount: 0 } },
            { kind: 'workspace-removed', id: 'W' },
            { kind: 'pane-upserted', workspaceID: 'W', paneID: 'A', lane: 'visible', index: 0, pane: { type: 'shell' } },
            { kind: 'pane-removed', workspaceID: 'W', paneID: 'A' },
            {
                kind: 'layout-changed',
                workspaceID: 'W',
                layout: { kind: 'leaf', paneID: 'A' },
                zoomedPaneID: null,
                savedLayout: null,
                currentLayoutIndex: null
            },
            { kind: 'focus-changed', workspaceID: 'W', focusedPaneID: 'A', focusHistory: ['A'] },
            {
                kind: 'sync-changed',
                workspaceID: 'W',
                isSyncInputActive: true,
                syncInputExcluded: [],
                syncedPaneIDs: ['A', 'B']
            },
            {
                kind: 'agent-status-changed',
                workspaceID: 'W',
                paneID: 'A',
                status: 'running',
                agentSessionID: null,
                agentKind: 'claude',
                agentStartedAt: 1_700_000_000_000,
                backgroundTaskCount: 0
            },
            { kind: 'group-upserted', id: 'G', index: 0, group: { name: 'projects' } },
            { kind: 'group-removed', id: 'G' },
            {
                kind: 'order-changed',
                workspaceOrder: ['W'],
                groupOrder: ['G'],
                topLevelOrder: [{ kind: 'workspace', id: 'W' }]
            },
            { kind: 'active-workspace-changed', workspaceID: 'W' },
            { kind: 'label-presets-changed', presets: [{ name: 'ship', color: { kind: 'named', color: 'gray' } }] },
            { kind: 'repos-changed', repos: [{ id: 'R', path: '/tmp/repo' }] }
        ];
        expect(events.map((event) => event.kind).sort()).toEqual([...WS_DELTA_KINDS].sort());
        // JSON round-trip: every declared shape must survive the wire unchanged.
        for (const event of events) expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    });

    it('enumerates the handshake rejection codes', () => {
        expect([...WS_REJECTION_CODES]).toEqual(['protocol-mismatch', 'unauthorized', 'server-error']);
    });
});
