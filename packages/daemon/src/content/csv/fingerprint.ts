/**
 * Append detection for csv documents (#324, docs/csv-pane.md §3.9).
 *
 * When a clean document's file grows on the same inode, only the new tail is indexed, which is
 * safe only if every byte already indexed is unchanged: a rewrite that moved record boundaries
 * would leave the index pointing at the wrong offsets. A fingerprint is a sample of the indexed
 * bytes, hashed per window: the head (64 KiB), sixteen 4 KiB windows spread evenly over the
 * rest, and the last 4 KiB. A grown file must reproduce every window at the same offsets before
 * the document trusts it as an append; anything else is a full reload.
 *
 * Windows are recorded from the bytes as they are SCANNED (`FingerprintBuilder` rides along with
 * the scan), so a rewrite that lands while a scan is running cannot be fingerprinted as if it
 * were what the index describes. After a save the written file is sampled from its new fd.
 */

import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';

export const FINGERPRINT_HEAD_BYTES = 64 * 1024;
export const FINGERPRINT_WINDOW_BYTES = 4 * 1024;
export const FINGERPRINT_SAMPLES = 16;
/** Windows kept after a run of appends (the head, the newest windows, a thinned rest). */
export const FINGERPRINT_MAX_WINDOWS = 2 * (FINGERPRINT_SAMPLES + 1) + 1;

export interface ByteRange {
    readonly start: number;
    readonly length: number;
}

export interface FingerprintWindow extends ByteRange {
    readonly hash: string;
}

export type Fingerprint = readonly FingerprintWindow[];

/**
 * Where to sample `[from, to)`: the head (when `withHead`), then 17 windows spread evenly up to
 * the end, the last of which is the tail. A range smaller than the whole sample is one window.
 */
export function sampleRanges(from: number, to: number, withHead: boolean): ByteRange[] {
    const size = to - from;
    if (size <= 0) return [];
    const head = withHead ? FINGERPRINT_HEAD_BYTES : 0;
    if (size <= head + (FINGERPRINT_SAMPLES + 1) * FINGERPRINT_WINDOW_BYTES) return [{ start: from, length: size }];
    const ranges: ByteRange[] = [];
    if (withHead) ranges.push({ start: from, length: head });
    const first = from + head;
    const span = to - FINGERPRINT_WINDOW_BYTES - first;
    for (let i = 0; i <= FINGERPRINT_SAMPLES; i += 1) {
        ranges.push({ start: first + Math.floor((span * i) / FINGERPRINT_SAMPLES), length: FINGERPRINT_WINDOW_BYTES });
    }
    return ranges;
}

const sha1 = (): Hash => createHash('sha1');

interface Pending extends ByteRange {
    readonly hash: Hash;
    filled: number;
    broken: boolean;
}

/** Hashes the sampled windows from the chunks a scan reads, in order. */
export class FingerprintBuilder {
    private readonly windows: Pending[];

    constructor(ranges: readonly ByteRange[]) {
        this.windows = ranges.map(range => ({ ...range, hash: sha1(), filled: 0, broken: false }));
    }

    /** `chunk` holds the file's bytes at `[position, position + chunk.length)`. */
    feed(chunk: Buffer, position: number): void {
        const end = position + chunk.length;
        for (const window of this.windows) {
            if (window.broken || window.filled === window.length) continue;
            const at = window.start + window.filled;
            if (at >= end) continue;
            if (at < position) {
                window.broken = true; // a gap: the scan skipped bytes this window needs
                continue;
            }
            const take = Math.min(window.start + window.length, end) - at;
            window.hash.update(chunk.subarray(at - position, at - position + take));
            window.filled += take;
        }
    }

    /** The fingerprint, or null when the scan stopped before every window was read. */
    finish(): Fingerprint | null {
        const out: FingerprintWindow[] = [];
        for (const window of this.windows) {
            if (window.broken || window.filled !== window.length) return null;
            out.push({ start: window.start, length: window.length, hash: window.hash.digest('hex') });
        }
        return out;
    }
}

function readWindow(fd: number, range: ByteRange): string | null {
    const buffer = Buffer.allocUnsafe(range.length);
    let got = 0;
    while (got < range.length) {
        const n = fs.readSync(fd, buffer, got, range.length - got, range.start + got);
        if (n <= 0) return null;
        got += n;
    }
    return sha1().update(buffer).digest('hex');
}

/** Sample `ranges` of `fd` now (a file this daemon just wrote). Null when a read comes up short. */
export function readFingerprint(fd: number, ranges: readonly ByteRange[]): Fingerprint | null {
    const out: FingerprintWindow[] = [];
    try {
        for (const range of ranges) {
            const hash = readWindow(fd, range);
            if (hash === null) return null;
            out.push({ ...range, hash });
        }
    } catch {
        return null;
    }
    return out;
}

/** Does `fd` still hold the same bytes at every window? */
export function fingerprintMatches(fd: number, fingerprint: Fingerprint): boolean {
    try {
        for (const window of fingerprint) {
            if (readWindow(fd, window) !== window.hash) return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * The fingerprint after an append was indexed: the old windows (verified just before) plus the
 * new region's. A long run of appends thins the older windows evenly, keeping the head.
 */
export function extendFingerprint(old: Fingerprint, added: Fingerprint): Fingerprint {
    const all = [...old, ...added];
    if (all.length <= FINGERPRINT_MAX_WINDOWS || old.length === 0) return all;
    const head = old[0] as FingerprintWindow;
    const older = old.slice(1);
    const keep = Math.max(0, FINGERPRINT_MAX_WINDOWS - 1 - added.length);
    const thinned: FingerprintWindow[] = [];
    for (let i = 0; i < keep && older.length > 0; i += 1) {
        const window = older[Math.floor((i * older.length) / keep)] as FingerprintWindow;
        if (thinned[thinned.length - 1] !== window) thinned.push(window);
    }
    return [head, ...thinned, ...added];
}
