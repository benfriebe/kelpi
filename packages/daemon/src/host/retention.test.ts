import { describe, expect, it } from 'vitest';

import { DEFAULT_RETENTION_BYTES, RetentionRing } from './retention.js';

const seq = (from: number, count: number): Uint8Array =>
    Uint8Array.from({ length: count }, (_, i) => (from + i) & 0xff);

describe('RetentionRing', () => {
    it('defaults to 4 MiB', () => {
        expect(new RetentionRing().capacity).toBe(DEFAULT_RETENTION_BYTES);
        expect(DEFAULT_RETENTION_BYTES).toBe(4 * 1024 * 1024);
    });

    it('gives every chunk its absolute offset', () => {
        const ring = new RetentionRing(64);
        expect(ring.append(seq(0, 5))).toBe(0);
        expect(ring.append(seq(5, 3))).toBe(5);
        expect(ring.append(new Uint8Array(0))).toBe(8);
        expect(ring.produced).toBe(8);
        expect(ring.start).toBe(0);
    });

    it('reads from any offset it still holds, splitting chunks', () => {
        const ring = new RetentionRing(64);
        ring.append(seq(0, 5));
        ring.append(seq(5, 5));
        const read = ring.readFrom(3);
        expect(read).toMatchObject({ from: 3, gap: false });
        expect([...read.bytes]).toEqual([3, 4, 5, 6, 7, 8, 9]);
        expect(ring.readFrom(10).bytes.length).toBe(0);
        expect(ring.readFrom(99).from).toBe(10);
    });

    it('evicts the oldest bytes past capacity and reports a gap for them', () => {
        const ring = new RetentionRing(6);
        ring.append(seq(0, 4));
        ring.append(seq(4, 4)); // 8 bytes into 6: bytes 0..1 go
        expect(ring.byteLength).toBe(6);
        expect(ring.start).toBe(2);
        const read = ring.readFrom(0);
        expect(read).toMatchObject({ from: 2, gap: true });
        expect([...read.bytes]).toEqual([2, 3, 4, 5, 6, 7]);
    });

    it('keeps everything after a pin, however much, and asks for a pause', () => {
        const ring = new RetentionRing(4);
        ring.append(seq(0, 4));
        ring.setPin(2); // the checkpoint covers 0..1
        expect(ring.start).toBe(2);
        ring.append(seq(4, 6));
        expect(ring.byteLength).toBe(8);
        expect(ring.overPinnedCapacity).toBe(true);
        const read = ring.readFrom(2);
        expect(read.gap).toBe(false);
        expect([...read.bytes]).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('trims back to capacity once unpinned', () => {
        const ring = new RetentionRing(4);
        ring.setPin(0);
        ring.append(seq(0, 10));
        expect(ring.byteLength).toBe(10);
        ring.setPin(null);
        expect(ring.byteLength).toBe(4);
        expect(ring.overPinnedCapacity).toBe(false);
        expect([...ring.readFrom(0).bytes]).toEqual([6, 7, 8, 9]);
    });

    it('clamps a pin to what exists', () => {
        const ring = new RetentionRing(16);
        ring.append(seq(0, 3));
        ring.setPin(50);
        expect(ring.pin).toBe(3);
        expect(ring.byteLength).toBe(0);
    });
});
