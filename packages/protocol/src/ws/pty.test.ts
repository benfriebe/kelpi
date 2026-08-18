import { describe, expect, it } from 'vitest';

import {
    decodeAckPayload,
    decodePtyFrame,
    decodeResizePayload,
    encodeAckPayload,
    encodePtyFrame,
    encodeResizePayload,
    PTY_FRAME_HEADER_BYTES,
    PTY_FRAME_TYPES,
    uuidFromBytes,
    uuidToBytes
} from './pty.js';

const PANE = '1B4E4E5A-9F2B-4C58-8D1F-2A81D9A3E111';

describe('pane id ↔ bytes', () => {
    it('round-trips a canonical uuid', () => {
        const bytes = uuidToBytes(PANE);
        expect(bytes?.length).toBe(16);
        expect(uuidFromBytes(bytes as Uint8Array)).toBe(PANE);
    });

    it('normalizes lowercase input to the uppercase canonical form', () => {
        expect(uuidFromBytes(uuidToBytes(PANE.toLowerCase()) as Uint8Array)).toBe(PANE);
    });

    it('rejects malformed ids and short buffers', () => {
        expect(uuidToBytes('not-a-uuid')).toBeUndefined();
        expect(uuidToBytes('')).toBeUndefined();
        expect(uuidFromBytes(new Uint8Array(15))).toBeUndefined();
    });
});

describe('pty frames', () => {
    it('uses a [1-byte type][16-byte paneID][payload] layout', () => {
        const payload = new Uint8Array([0x68, 0x69]);
        const frame = encodePtyFrame(PTY_FRAME_TYPES.output, PANE, payload) as Uint8Array;
        expect(frame.length).toBe(PTY_FRAME_HEADER_BYTES + payload.length);
        expect(frame[0]).toBe(PTY_FRAME_TYPES.output);
        expect(decodePtyFrame(frame)).toMatchObject({ type: PTY_FRAME_TYPES.output, paneID: PANE });
        expect([...(decodePtyFrame(frame)?.payload ?? [])]).toEqual([0x68, 0x69]);
    });

    it('encodes empty payloads (header only)', () => {
        const frame = encodePtyFrame(PTY_FRAME_TYPES.replay, PANE) as Uint8Array;
        expect(frame.length).toBe(PTY_FRAME_HEADER_BYTES);
        expect(decodePtyFrame(frame)?.payload.length).toBe(0);
    });

    it('refuses to encode with a malformed pane id', () => {
        expect(encodePtyFrame(PTY_FRAME_TYPES.input, 'nope')).toBeUndefined();
    });

    it('ignores truncated frames and unknown frame types', () => {
        expect(decodePtyFrame(new Uint8Array(PTY_FRAME_HEADER_BYTES - 1))).toBeUndefined();
        const frame = encodePtyFrame(PTY_FRAME_TYPES.output, PANE) as Uint8Array;
        frame[0] = 0x7f;
        expect(decodePtyFrame(frame)).toBeUndefined();
    });
});

describe('flow-control and resize payloads', () => {
    it('round-trips ack byte counts as uint32 BE', () => {
        for (const value of [0, 1, 4096, 0xffffffff]) {
            expect(decodeAckPayload(encodeAckPayload(value))).toBe(value);
        }
    });

    it('saturates and truncates out-of-range ack counts', () => {
        expect(decodeAckPayload(encodeAckPayload(-5))).toBe(0);
        expect(decodeAckPayload(encodeAckPayload(0x1_0000_0000))).toBe(0xffffffff);
        expect(decodeAckPayload(encodeAckPayload(12.9))).toBe(12);
        expect(decodeAckPayload(new Uint8Array(3))).toBeUndefined();
    });

    it('round-trips cols/rows as two uint16 BE', () => {
        expect(decodeResizePayload(encodeResizePayload(120, 40))).toEqual({ cols: 120, rows: 40 });
        expect(decodeResizePayload(encodeResizePayload(0, 0))).toEqual({ cols: 0, rows: 0 });
        expect(decodeResizePayload(encodeResizePayload(70000, -3))).toEqual({ cols: 0xffff, rows: 0 });
        expect(decodeResizePayload(new Uint8Array(2))).toBeUndefined();
    });
});
