import { describe, expect, it } from 'vitest';

import { createRingBuffer } from './ring.js';

describe('console ring buffer (web-pane.md §2.1)', () => {
    it('assigns strictly increasing seqs that are never recycled', () => {
        const ring = createRingBuffer<string>(3);
        ring.append('a');
        ring.append('b');
        ring.append('c');
        expect(ring.entries.map((entry) => entry.seq)).toEqual([0, 1, 2]);
        expect(ring.nextSeq).toBe(3);

        ring.append('d');
        // Eviction keeps the seq namespace: the survivor seqs are unchanged.
        expect(ring.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
        expect(ring.entries.map((entry) => entry.value)).toEqual(['b', 'c', 'd']);
    });

    it('counts evictions until they are acknowledged', () => {
        const ring = createRingBuffer<number>(2);
        for (const value of [1, 2, 3, 4, 5]) ring.append(value);
        expect(ring.dropped).toBe(3);
        expect(ring.acknowledgeDrops()).toBe(3);
        expect(ring.acknowledgeDrops()).toBe(0);
        ring.append(6);
        expect(ring.acknowledgeDrops()).toBe(1);
    });

    it('returns entries at or after `since`, whole buffer for 0', () => {
        const ring = createRingBuffer<string>(10);
        for (const value of ['a', 'b', 'c', 'd']) ring.append(value);
        expect(ring.entriesSince(0).map((entry) => entry.value)).toEqual(['a', 'b', 'c', 'd']);
        expect(ring.entriesSince(2).map((entry) => entry.value)).toEqual(['c', 'd']);
        expect(ring.entriesSince(4)).toEqual([]);
        expect(ring.entriesSince(99)).toEqual([]);
    });

    it('preserves the seq namespace across clear, so a --since poller sees the gap', () => {
        const ring = createRingBuffer<string>(4);
        ring.append('a');
        ring.append('b');
        ring.clear();
        expect(ring.entries).toEqual([]);
        expect(ring.nextSeq).toBe(2);
        ring.append('c');
        expect(ring.entries[0]?.seq).toBe(2);
        // A poller that asked for `since=2` gets only the post-clear line, never a duplicate.
        expect(ring.entriesSince(2).map((entry) => entry.value)).toEqual(['c']);
    });

    it('rejects a nonsense capacity rather than silently keeping nothing', () => {
        expect(() => createRingBuffer<string>(0)).toThrow(/positive integer/);
        expect(() => createRingBuffer<string>(1.5)).toThrow(/positive integer/);
    });
});
