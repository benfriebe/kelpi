import {
    PTY_FLOW_CONTROL_WINDOW_BYTES,
    PTY_FRAME_TYPES,
    decodeAckPayload,
    decodePtyFrame,
    encodePtyFrame
} from '@nex/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyClient } from './pty';
import { NexConnection } from './socket';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './testing';

const PANE = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function harness(options: { ackThresholdBytes?: number; ackIntervalMs?: number } = {}) {
    const sockets = createFakeSocketFactory();
    const connection = new NexConnection({
        url: 'ws://daemon.test/ws',
        token: 't',
        socketFactory: sockets.factory,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
        heartbeatIntervalMs: 0
    });
    const client = new PtyClient(connection, options);
    connection.connect();
    completeHandshake(sockets.last());
    return {
        connection,
        client,
        socket: (): FakeWebSocket => sockets.last(),
        json: (type: string): Record<string, unknown>[] =>
            sockets.last().messages().filter((message) => message['type'] === type),
        frames: (): ReturnType<typeof decodePtyFrame>[] => sockets.last().frames.map((frame) => decodePtyFrame(frame)),
        serverSend(type: number, paneID: string, payload: Uint8Array): void {
            const frame = encodePtyFrame(type as 1 | 2 | 3 | 4 | 5, paneID, payload);
            sockets.last().emitBinary(frame as Uint8Array);
        },
        redial(): void {
            sockets.last().serverClose();
            vi.advanceTimersByTime(10);
            completeHandshake(sockets.last());
        }
    };
}

describe('PTY frame round trip', () => {
    it('encodes and decodes an input frame with the pane id in the header', () => {
        const payload = encoder.encode('ls -la\r');
        const frame = encodePtyFrame(PTY_FRAME_TYPES.input, PANE, payload) as Uint8Array;
        const decoded = decodePtyFrame(frame);

        expect(decoded?.type).toBe(PTY_FRAME_TYPES.input);
        expect(decoded?.paneID).toBe(PANE.toUpperCase());
        expect(decoder.decode(decoded?.payload)).toBe('ls -la\r');
    });
});

describe('PtyClient subscription', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('attaches with the measured geometry and demultiplexes replay then output', () => {
        const h = harness();
        const replays: string[] = [];
        const data: string[] = [];
        h.client.subscribe(PANE, {
            cols: 120,
            rows: 40,
            onReplay: (bytes) => replays.push(decoder.decode(bytes)),
            onData: (bytes) => data.push(decoder.decode(bytes))
        });

        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE, cols: 120, rows: 40 }]);

        h.serverSend(PTY_FRAME_TYPES.replay, PANE, encoder.encode('screen'));
        h.serverSend(PTY_FRAME_TYPES.output, PANE, encoder.encode('live'));
        // A frame for a pane we never subscribed to is not ours.
        h.serverSend(PTY_FRAME_TYPES.output, OTHER, encoder.encode('someone else'));

        expect(replays).toEqual(['screen']);
        expect(data).toEqual(['live']);
    });

    it('writes input as binary frames and resizes over the JSON channel', () => {
        const h = harness();
        const handle = h.client.subscribe(PANE, { onData: () => {} });

        handle.write('hi');
        handle.resize(100, 30);

        const input = h.frames().find((frame) => frame?.type === PTY_FRAME_TYPES.input);
        expect(input?.paneID).toBe(PANE.toUpperCase());
        expect(decoder.decode(input?.payload)).toBe('hi');
        expect(h.json('resize-pane')).toEqual([{ type: 'resize-pane', paneID: PANE, cols: 100, rows: 30 }]);

        // A transient 0-size measurement pass never reaches the daemon.
        handle.resize(0, 0);
        expect(h.json('resize-pane')).toHaveLength(1);
    });

    it('detaches when the last subscriber goes away', () => {
        const h = harness();
        const first = h.client.subscribe(PANE, { onData: () => {} });
        const second = h.client.subscribe(PANE, { onData: () => {} });

        first.unsubscribe();
        expect(h.json('detach-pane')).toHaveLength(0);
        second.unsubscribe();
        expect(h.json('detach-pane')).toEqual([{ type: 'detach-pane', paneID: PANE }]);
        expect(h.client.paneIDs).toEqual([]);
    });

    it('re-attaches every subscribed pane after a reconnect', () => {
        const h = harness();
        h.client.subscribe(PANE, { cols: 80, rows: 24, onData: () => {} });
        h.redial();

        expect(h.json('attach-pane')).toEqual([{ type: 'attach-pane', paneID: PANE, cols: 80, rows: 24 }]);
    });

    it('surfaces pane exit and flow-control resync notices', () => {
        const h = harness();
        const exits: (number | null)[] = [];
        const resyncs: string[] = [];
        h.client.subscribe(PANE, { onData: () => {}, onExit: (code) => exits.push(code), onResync: (r) => resyncs.push(r) });

        h.socket().emit({ type: 'pty-resync', paneID: PANE, reason: 'flow-control-drop' });
        h.socket().emit({ type: 'pane-exit', paneID: PANE, exitCode: 0 });

        expect(resyncs).toEqual(['flow-control-drop']);
        expect(exits).toEqual([0]);
    });
});

describe('PtyClient ack pacing', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function acks(frames: ReturnType<typeof decodePtyFrame>[]): number[] {
        return frames
            .filter((frame) => frame?.type === PTY_FRAME_TYPES.ack)
            .map((frame) => decodeAckPayload(frame?.payload as Uint8Array) ?? -1);
    }

    it('coalesces small chunks onto the timer instead of one ack per chunk', () => {
        const h = harness({ ackThresholdBytes: 1000, ackIntervalMs: 16 });
        h.client.subscribe(PANE, { onData: () => {} });

        h.serverSend(PTY_FRAME_TYPES.output, PANE, encoder.encode('abc'));
        h.serverSend(PTY_FRAME_TYPES.output, PANE, encoder.encode('de'));
        expect(acks(h.frames())).toEqual([]);
        expect(h.client.stats(PANE)?.unacked).toBe(5);

        vi.advanceTimersByTime(16);
        expect(acks(h.frames())).toEqual([5]);
        expect(h.client.stats(PANE)?.unacked).toBe(0);
    });

    it('flushes immediately once the outstanding window fills', () => {
        const h = harness({ ackThresholdBytes: 8, ackIntervalMs: 1000 });
        h.client.subscribe(PANE, { onData: () => {} });

        h.serverSend(PTY_FRAME_TYPES.output, PANE, new Uint8Array(10));
        expect(acks(h.frames())).toEqual([10]);
    });

    it('acks replay bytes too (the daemon charges them to the same window)', () => {
        const h = harness({ ackThresholdBytes: 4, ackIntervalMs: 1000 });
        h.client.subscribe(PANE, { onData: () => {}, onReplay: () => {} });

        h.serverSend(PTY_FRAME_TYPES.replay, PANE, new Uint8Array(64));
        expect(acks(h.frames())).toEqual([64]);
    });

    it('defers to the consumer when autoAck is off', () => {
        const h = harness({ ackThresholdBytes: 4, ackIntervalMs: 1000 });
        const handle = h.client.subscribe(PANE, { autoAck: false, onData: () => {} });

        h.serverSend(PTY_FRAME_TYPES.output, PANE, new Uint8Array(32));
        expect(acks(h.frames())).toEqual([]);
        expect(h.client.stats(PANE)?.unacked).toBe(32);

        handle.ack(32);
        expect(acks(h.frames())).toEqual([32]);
    });

    it('defaults the flush threshold to a quarter of the protocol window', () => {
        const h = harness();
        h.client.subscribe(PANE, { onData: () => {} });

        h.serverSend(PTY_FRAME_TYPES.output, PANE, new Uint8Array(PTY_FLOW_CONTROL_WINDOW_BYTES / 4));
        expect(acks(h.frames())).toEqual([PTY_FLOW_CONTROL_WINDOW_BYTES / 4]);
    });
});
