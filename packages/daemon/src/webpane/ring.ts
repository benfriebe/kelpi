/**
 * The console ring buffer (web-pane.md §2.1).
 *
 * Fixed capacity, every entry paired with a monotonically increasing `seq` that is NEVER recycled —
 * not on eviction, not on `clear()`. That is the whole point: a `--since N` poller must never
 * see a seq twice, and the gap it observes after a clear is the honest signal that lines went
 * away.
 *
 * `droppedSinceLastDrain` counts evictions and is reset by exactly two paths (§17.5): a poll
 * drain's acknowledge, and the follow fan-out that attached the count to a pushed line.
 */

export interface RingEntry<T> {
    readonly seq: number;
    readonly value: T;
}

export interface RingBuffer<T> {
    readonly capacity: number;
    /** Live entries, insertion order (seq strictly increasing). */
    readonly entries: readonly RingEntry<T>[];
    /** The seq the next append will use; always greater than every live seq. */
    readonly nextSeq: number;
    readonly dropped: number;
    append(value: T): RingEntry<T>;
    /** Entries with `seq >= since`; `since <= 0` returns the whole live buffer. */
    entriesSince(since: number): readonly RingEntry<T>[];
    /** Returns and resets `droppedSinceLastDrain`. */
    acknowledgeDrops(): number;
    /** Empties the buffer. The seq namespace is preserved deliberately. */
    clear(): void;
}

export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
    if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new Error(`ring buffer capacity must be a positive integer, got ${String(capacity)}`);
    }
    let entries: RingEntry<T>[] = [];
    let nextSeq = 0;
    let dropped = 0;

    return {
        capacity,
        get entries() {
            return entries;
        },
        get nextSeq() {
            return nextSeq;
        },
        get dropped() {
            return dropped;
        },
        append(value) {
            if (entries.length >= capacity) {
                entries.shift();
                dropped += 1;
            }
            const entry: RingEntry<T> = { seq: nextSeq, value };
            nextSeq += 1;
            entries.push(entry);
            return entry;
        },
        entriesSince(since) {
            if (since <= 0) return [...entries];
            // Entries are seq-sorted, so a binary search for the first `seq >= since` is enough.
            let low = 0;
            let high = entries.length;
            while (low < high) {
                const mid = (low + high) >> 1;
                const entry = entries[mid] as RingEntry<T>;
                if (entry.seq >= since) high = mid;
                else low = mid + 1;
            }
            return entries.slice(low);
        },
        acknowledgeDrops() {
            const value = dropped;
            dropped = 0;
            return value;
        },
        clear() {
            entries = [];
        }
    };
}
