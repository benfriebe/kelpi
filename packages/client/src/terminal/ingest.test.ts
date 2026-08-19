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
