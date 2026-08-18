import { describe, expect, it } from 'vitest';

import { DEFAULT_RING_CAPACITY_BYTES, RawRingBuffer } from './ring.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const seq = (from: number, count: number): Uint8Array =>
    Uint8Array.from({ length: count }, (_, i) => (from + i) & 0xff);

describe('RawRingBuffer', () => {
    it('defaults to a 1 MiB capacity', () => {
        expect(DEFAULT_RING_CAPACITY_BYTES).toBe(1024 * 1024);
        expect(new RawRingBuffer().capacity).toBe(1024 * 1024);
    });

    it('retains everything while below capacity', () => {
        const ring = new RawRingBuffer(16);
        ring.append(bytes(1, 2, 3));
        ring.append(bytes(4, 5));
        expect(ring.byteLength).toBe(5);
        expect(ring.totalWritten).toBe(5);
        expect(ring.evicted).toBe(false);
        expect([...ring.snapshotTail()]).toEqual([1, 2, 3, 4, 5]);
    });

    it('ignores empty appends', () => {
        const ring = new RawRingBuffer(8);
        ring.append(new Uint8Array(0));
        expect(ring.byteLength).toBe(0);
        expect(ring.totalWritten).toBe(0);
        expect(ring.snapshotTail()).toEqual(new Uint8Array(0));
    });

    it('evicts the oldest bytes once full, across the wrap point', () => {
        const ring = new RawRingBuffer(8);
        ring.append(seq(1, 6)); // 1..6
        ring.append(seq(7, 6)); // 7..12 -> evicts 1..4
        expect(ring.byteLength).toBe(8);
        expect(ring.capacity).toBe(8);
        expect(ring.totalWritten).toBe(12);
        expect(ring.evicted).toBe(true);
        expect([...ring.snapshotTail()]).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('keeps only the tail of a chunk larger than the whole ring', () => {
        const ring = new RawRingBuffer(4);
        ring.append(seq(1, 3));
        ring.append(seq(10, 10)); // 10..19
        expect(ring.byteLength).toBe(4);
        expect([...ring.snapshotTail()]).toEqual([16, 17, 18, 19]);
        expect(ring.totalWritten).toBe(13);
    });

    it('stays byte-exact over many small wrapping appends', () => {
        const ring = new RawRingBuffer(5);
        const expected: number[] = [];
        for (let i = 0; i < 40; i++) {
            ring.append(bytes(i, i + 100));
            expected.push(i, i + 100);
        }
        expect([...ring.snapshotTail()]).toEqual(expected.slice(-5));
        expect(ring.byteLength).toBe(5);
    });

    it('snapshotTail(maxBytes) returns the most recent bytes only', () => {
        const ring = new RawRingBuffer(8);
        ring.append(seq(1, 6));
        expect([...ring.snapshotTail(3)]).toEqual([4, 5, 6]);
        expect([...ring.snapshotTail(0)]).toEqual([]);
        expect([...ring.snapshotTail(99)]).toEqual([1, 2, 3, 4, 5, 6]);
        expect([...ring.snapshotTail(-4)]).toEqual([]);
    });

    it('snapshotTail(maxBytes) spans the wrap point correctly', () => {
        const ring = new RawRingBuffer(6);
        ring.append(seq(1, 5)); // 1..5
        ring.append(seq(6, 4)); // 6..9 -> keeps 4..9
        expect([...ring.snapshotTail()]).toEqual([4, 5, 6, 7, 8, 9]);
        expect([...ring.snapshotTail(4)]).toEqual([6, 7, 8, 9]);
    });

    it('returns copies, not views into the backing store', () => {
        const ring = new RawRingBuffer(8);
        ring.append(seq(1, 4));
        const tail = ring.snapshotTail();
        tail[0] = 0xff;
        expect([...ring.snapshotTail()]).toEqual([1, 2, 3, 4]);
    });

    it('clears retained bytes but not the lifetime counter', () => {
        const ring = new RawRingBuffer(8);
        ring.append(seq(1, 4));
        ring.clear();
        expect(ring.byteLength).toBe(0);
        expect(ring.totalWritten).toBe(4);
        ring.append(seq(9, 2));
        expect([...ring.snapshotTail()]).toEqual([9, 10]);
    });

    it('never allocates a zero-length store', () => {
        expect(new RawRingBuffer(0).capacity).toBe(1);
        expect(new RawRingBuffer(Number.NaN).capacity).toBe(1);
    });
});
