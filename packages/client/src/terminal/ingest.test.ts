import { describe, expect, it } from 'vitest';

import { PENDING_LIVE_LIMIT_BYTES, createTerminalIngest, type IngestTarget } from './ingest';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function recorder(): IngestTarget & { writes: string[]; resets: number } {
    const writes: string[] = [];
    return {
        writes,
        resets: 0,
        write(data: Uint8Array | string): void {
            writes.push(typeof data === 'string' ? data : decoder.decode(data));
        },
        reset(): void {
            this.resets += 1;
        }
    };
}

describe('terminal ingest', () => {
    it('paints the replay snapshot before any live bytes', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.replay(encoder.encode('SNAPSHOT'));
        ingest.live(encoder.encode('live-1'));
        ingest.live(encoder.encode('live-2'));

        expect(target.writes).toEqual(['SNAPSHOT', 'live-1', 'live-2']);
        // Even the first replay resets: a "fresh" engine can arrive with another pane's screen
        // on it (ghostty-web shares one WASM instance), and the snapshot has no leading clear.
        expect(target.resets).toBe(1);
        expect(ingest.replays).toBe(1);
    });

    it('holds live bytes that arrive before the replay and flushes them after it', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.live(encoder.encode('early'));
        expect(target.writes).toEqual([]);
        expect(ingest.awaitingReplay).toBe(true);

        ingest.replay(encoder.encode('SNAPSHOT'));
        ingest.live(encoder.encode('after'));

        expect(target.writes).toEqual(['SNAPSHOT', 'early', 'after']);
    });

    it('resets the engine before every replay so a stale screen cannot linger', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.replay(encoder.encode('FIRST'));
        ingest.live(encoder.encode('output'));
        // reconnect / pty-resync: the daemon re-seeds us
        ingest.expectReplay();
        ingest.live(encoder.encode('stale'));
        ingest.replay(encoder.encode('SECOND'));

        expect(target.resets).toBe(2);
        expect(target.writes).toEqual(['FIRST', 'output', 'SECOND', 'stale']);
        expect(ingest.replays).toBe(2);
    });

    it('seals the target while paused — a poisoned engine hears nothing more (run-F N1)', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.replay('SNAPSHOT');
        ingest.live('before');
        expect(target.writes).toEqual(['SNAPSHOT', 'before']);

        // The renderer just threw `RangeError: offset is out of bounds` from inside WASM.
        ingest.pause();
        ingest.live('after-1');
        ingest.replay('RESEED');
        ingest.live('after-2');

        expect(ingest.paused).toBe(true);
        // Not one byte, and not the reset either: the dead engine is never touched again.
        expect(target.writes).toEqual(['SNAPSHOT', 'before']);
        expect(target.resets).toBe(1);
    });

    it('releases what it held, in order and behind a reset, when it resumes', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.replay('SNAPSHOT');
        ingest.pause();
        ingest.live('lost-to-the-reseed');
        ingest.replay('RESEED');
        ingest.live('after-1');
        ingest.live('after-2');
        ingest.resume();

        // The re-seed supersedes anything queued behind it (the daemon snapshots at attach),
        // and it still leads with the reset a replay always gets.
        expect(target.resets).toBe(2);
        expect(target.writes).toEqual(['SNAPSHOT', 'RESEED', 'after-1', 'after-2']);
        expect(ingest.paused).toBe(false);
    });

    it('keeps holding after a resume while a replay is still awaited', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.pause();
        ingest.live('early');
        ingest.resume();
        expect(target.writes).toEqual([]);

        ingest.replay('SNAPSHOT');
        expect(target.writes).toEqual(['SNAPSHOT', 'early']);
    });

    it('drops a replay held behind a pause when a newer one arrives', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.pause();
        ingest.replay('STALE');
        ingest.live('behind-the-stale-one');
        ingest.resume();
        // `resume()` released the stale pair; a newer snapshot now supersedes both.
        expect(target.writes).toEqual(['STALE', 'behind-the-stale-one']);

        ingest.pause();
        ingest.replay('OLD');
        ingest.replay('NEW');
        ingest.resume();

        expect(target.writes).toEqual(['STALE', 'behind-the-stale-one', 'NEW']);
    });

    it('bounds the hold buffer instead of growing without limit', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        const chunk = 'x'.repeat(64 * 1024);
        const chunks = Math.ceil(PENDING_LIVE_LIMIT_BYTES / chunk.length) + 4;
        for (let index = 0; index < chunks; index += 1) ingest.live(chunk);
        ingest.replay('SNAPSHOT');

        const held = target.writes.length - 1;
        expect(held).toBeLessThan(chunks);
        expect(held * chunk.length).toBeLessThanOrEqual(PENDING_LIVE_LIMIT_BYTES);
        expect(target.writes[0]).toBe('SNAPSHOT');
    });
});
