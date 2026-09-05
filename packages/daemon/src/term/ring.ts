/**
 * Bounded raw-output ring buffer (belt-and-braces next to the headless VT).
 *
 * `../kelpi-docs/research/ghostty-web.md` §3c: a raw ring buffer alone is NOT sufficient for
 * `pane capture` (that needs a VT interpreter server-side), but it is a cheap complement:
 * byte-perfect "last N bytes" replay for debugging, and a fallback tail if the VT ever
 * gets wedged. One per pane, default 1 MiB, oldest bytes evicted on overflow.
 *
 * Storage is a single pre-allocated `Uint8Array` written circularly, so appends are
 * O(bytes) with no allocation on the hot path.
 */

/** Default per-pane capacity: 1 MiB (ARCHITECTURE.md "bounded raw ring buffer (~1MB/pane)"). */
export const DEFAULT_RING_CAPACITY_BYTES = 1024 * 1024;

export class RawRingBuffer {
    private readonly buf: Uint8Array;
    /** Index of the oldest byte. Only meaningful while `full`. */
    private start = 0;
    /** Number of bytes currently stored (<= capacity). */
    private size = 0;
    /** Total bytes ever appended (never decreases; wraps at Number.MAX_SAFE_INTEGER). */
    private written = 0;

    constructor(capacityBytes: number = DEFAULT_RING_CAPACITY_BYTES) {
        const capacity = Number.isFinite(capacityBytes) ? Math.floor(capacityBytes) : 0;
        this.buf = new Uint8Array(Math.max(1, capacity));
    }

    /** Bytes the ring can hold before it starts evicting. */
    get capacity(): number {
        return this.buf.length;
    }

    /** Bytes currently retained. */
    get byteLength(): number {
        return this.size;
    }

    /** Bytes ever appended, including evicted ones. */
    get totalWritten(): number {
        return this.written;
    }

    /** True once the ring has wrapped at least once (i.e. bytes have been evicted). */
    get evicted(): boolean {
        return this.written > this.size;
    }

    append(data: Uint8Array): void {
        const n = data.length;
        if (n === 0) return;
        this.written += n;

        const cap = this.buf.length;
        if (n >= cap) {
            // The chunk alone overflows the ring: keep only its tail.
            this.buf.set(data.subarray(n - cap), 0);
            this.start = 0;
            this.size = cap;
            return;
        }

        // Write position = start + size (mod capacity).
        const end = (this.start + this.size) % cap;
        const firstRun = Math.min(n, cap - end);
        this.buf.set(data.subarray(0, firstRun), end);
        if (firstRun < n) this.buf.set(data.subarray(firstRun), 0);

        const overflow = this.size + n - cap;
        if (overflow > 0) {
            this.start = (this.start + overflow) % cap;
            this.size = cap;
        } else {
            this.size += n;
        }
    }

    /**
     * Copy of the most recent bytes, oldest-first.
     * `maxBytes` omitted (or >= byteLength) returns everything retained.
     */
    snapshotTail(maxBytes?: number): Uint8Array {
        let want = this.size;
        if (maxBytes !== undefined) {
            const limit = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0;
            want = Math.min(this.size, Math.max(0, limit));
        }
        const out = new Uint8Array(want);
        if (want === 0) return out;

        const cap = this.buf.length;
        const from = (this.start + (this.size - want)) % cap;
        const firstRun = Math.min(want, cap - from);
        out.set(this.buf.subarray(from, from + firstRun), 0);
        if (firstRun < want) out.set(this.buf.subarray(0, want - firstRun), firstRun);
        return out;
    }

    clear(): void {
        this.start = 0;
        this.size = 0;
    }
}
