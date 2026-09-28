/**
 * A terminal's recent output, addressed by absolute offset (`docs/terminal-host.md` §4).
 *
 * Every byte a PTY produces gets an offset: its position in that terminal's output stream. The
 * host keeps the most recent `capacity` bytes so a daemon that reattaches can be sent what it
 * missed. A **pin** marks the offset of the latest checkpoint while no daemon is streaming the
 * terminal: nothing at or after the pin may be evicted, because the checkpoint only describes the
 * screen up to that byte. Bytes before a pin are dropped at once, since the checkpoint covers
 * them. When pinned output outgrows `capacity`, `overPinnedCapacity` tells the host to stop
 * reading the PTY rather than lose output (§4).
 *
 * Storage is the list of chunks as the PTY delivered them, so an append never copies.
 */

/** Default per-terminal retention: 4 MiB. */
export const DEFAULT_RETENTION_BYTES = 4 * 1024 * 1024;

interface Chunk {
    readonly offset: number;
    bytes: Uint8Array;
}

export interface RetainedRead {
    /** Offset of the first byte in `bytes`. */
    readonly from: number;
    readonly bytes: Uint8Array;
    /** True when bytes the caller asked for had already been evicted. */
    readonly gap: boolean;
}

export class RetentionRing {
    private chunks: Chunk[] = [];
    private size = 0;
    private total = 0;
    private pinAt: number | null = null;

    constructor(readonly capacity: number = DEFAULT_RETENTION_BYTES) {}

    /** Bytes ever appended; the offset the next byte will get. */
    get produced(): number {
        return this.total;
    }

    /** Offset of the oldest byte still held. */
    get start(): number {
        return this.total - this.size;
    }

    get byteLength(): number {
        return this.size;
    }

    get pin(): number | null {
        return this.pinAt;
    }

    /** Pinned and holding more than `capacity`: the host should pause the PTY. */
    get overPinnedCapacity(): boolean {
        return this.pinAt !== null && this.size > this.capacity;
    }

    /** Appends a chunk; returns the offset of its first byte. */
    append(bytes: Uint8Array): number {
        const offset = this.total;
        if (bytes.length === 0) return offset;
        this.chunks.push({ offset, bytes });
        this.size += bytes.length;
        this.total += bytes.length;
        this.evict();
        return offset;
    }

    /**
     * Pin at `offset` (clamped to what exists), or unpin with null. A checkpoint pin drops the
     * bytes it covers; a `hold` pin (`dropCovered: false`) keeps them, in case the checkpoint that
     * follows lands a little earlier.
     */
    setPin(offset: number | null, dropCovered = true): void {
        this.pinAt = offset === null ? null : Math.min(Math.max(0, offset), this.total);
        if (this.pinAt !== null && dropCovered) this.dropBefore(this.pinAt);
        this.evict();
    }

    /** Everything held from `offset` on. Asking for evicted bytes returns what is left, with `gap`. */
    readFrom(offset: number): RetainedRead {
        const start = this.start;
        const from = Math.min(Math.max(offset, start), this.total);
        const gap = offset < start;
        const parts: Uint8Array[] = [];
        let length = 0;
        for (const chunk of this.chunks) {
            const end = chunk.offset + chunk.bytes.length;
            if (end <= from) continue;
            const part = chunk.offset < from ? chunk.bytes.subarray(from - chunk.offset) : chunk.bytes;
            parts.push(part);
            length += part.length;
        }
        return { from, bytes: join(parts, length), gap };
    }

    private dropBefore(offset: number): void {
        while (this.chunks.length > 0) {
            const first = this.chunks[0]!;
            const end = first.offset + first.bytes.length;
            if (end <= offset) {
                this.chunks.shift();
                this.size -= first.bytes.length;
            } else {
                if (first.offset < offset) this.trimFirst(offset - first.offset);
                return;
            }
        }
    }

    /** Trims to `capacity`, never past the pin. */
    private evict(): void {
        while (this.size > this.capacity && this.chunks.length > 0) {
            const first = this.chunks[0]!;
            const excess = this.size - this.capacity;
            // Bytes of the first chunk that may go: all of them unpinned, those before the pin otherwise.
            const evictable =
                this.pinAt === null
                    ? first.bytes.length
                    : Math.max(0, Math.min(first.bytes.length, this.pinAt - first.offset));
            if (evictable === 0) return;
            if (evictable === first.bytes.length && excess >= first.bytes.length) {
                this.chunks.shift();
                this.size -= first.bytes.length;
            } else {
                this.trimFirst(Math.min(evictable, excess));
                if (evictable < excess) return;
            }
        }
    }

    private trimFirst(count: number): void {
        const first = this.chunks[0]!;
        this.chunks[0] = { offset: first.offset + count, bytes: first.bytes.subarray(count) };
        this.size -= count;
    }
}

function join(parts: readonly Uint8Array[], length: number): Uint8Array {
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
