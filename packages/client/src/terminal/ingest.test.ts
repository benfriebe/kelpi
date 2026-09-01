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

    /**
     * N23: an overflowing hold is dropped WHOLE, never spliced.
     *
     * Drop-oldest looks kinder and is the corrupting choice: a terminal stream is one parse, so
     * removing a chunk from the middle hands the VT a continuation of something that never
     * arrived — a codepoint short of its bytes (U+FFFD, at whatever width the row was) and an
     * escape sequence short of its final byte, which then eats the text behind it. The daemon
     * already reasons this way about its own queue ("once a byte is lost the queue is no longer
     * a faithful continuation of the stream"); this is the client saying the same thing.
     */
    it('drops the whole hold on overflow rather than splicing the stream', () => {
        const target = recorder();
        const ingest = createTerminalIngest(target);

        const chunk = 'x'.repeat(64 * 1024);
        const chunks = Math.ceil(PENDING_LIVE_LIMIT_BYTES / chunk.length) + 4;
        for (let index = 0; index < chunks; index += 1) ingest.live(chunk);
        // The tail that arrives after the overflow is a continuation of bytes that were dropped,
        // so it must not be written either — only the replay may repaint the screen.
        ingest.live('TAIL');
        expect(ingest.drops).toBeGreaterThan(0);

        ingest.replay('SNAPSHOT');
        const afterReplay = target.writes.slice(1);
        expect(target.writes[0]).toBe('SNAPSHOT');
        // Whatever survived is an unbroken suffix of the held stream, and never a splice across
        // a dropped chunk: the first thing released is the first chunk held since the drop.
        expect(afterReplay.every((write) => write === chunk || write === 'TAIL')).toBe(true);
        // The point of the drop: the release is bounded and starts from a chunk boundary that
        // nothing was cut out ahead of.
        expect(afterReplay.length * chunk.length).toBeLessThanOrEqual(PENDING_LIVE_LIMIT_BYTES);
    });

    it('keeps a replay parked behind a pause when the live tail overflows', () => {
        // The hold can carry the snapshot itself (`replay()` while paused). Dropping it with the
        // tail would leave `resume()` resetting the engine and then writing nothing — a blank
        // pane until the next resize.
        const target = recorder();
        const ingest = createTerminalIngest(target);

        ingest.pause();
        ingest.replay('SNAPSHOT');
        const chunk = 'y'.repeat(64 * 1024);
        for (let index = 0; index < Math.ceil(PENDING_LIVE_LIMIT_BYTES / chunk.length) + 4; index += 1) {
            ingest.live(chunk);
        }
        ingest.resume();

        expect(ingest.drops).toBeGreaterThan(0);
        expect(target.resets).toBe(1);
        expect(target.writes[0]).toBe('SNAPSHOT');
    });
});

/**
 * The 2026-09-01 lockup class: the engine's `write()` parses its whole payload in one
 * synchronous WASM call, so a multi-megabyte replay (a resumed 8.8 MB agent session, resized)
 * wedged the main thread, starved the flow-control acks, and the overflow re-seeds stacked
 * MORE full-buffer replays until the app read as bricked. Chunked application with
 * supersession is the fix under test here.
 */
describe('chunked replay application', () => {
    function manualScheduler(): { flush: () => void; pending: () => number } {
        const queue: (() => void)[] = [];
        return {
            schedule(run: () => void): () => void {
                queue.push(run);
                return () => {
                    const index = queue.indexOf(run);
                    if (index >= 0) queue.splice(index, 1);
                };
            },
            flush(): void {
                while (queue.length > 0) queue.shift()?.();
            },
            pending(): number {
                return queue.length;
            }
        } as { flush: () => void; pending: () => number; schedule: (run: () => void) => () => void };
    }

    const options = (scheduler: { schedule: (run: () => void) => () => void }) => ({
        chunkBytes: 4,
        // A zero budget forces one chunk per tick — the pathological pacing, fully observable.
        tickBudgetMs: 0,
        schedule: scheduler.schedule,
        now: () => 1
    });

    it('applies a large replay across ticks, in order, holding live bytes until it completes', () => {
        const scheduler = manualScheduler();
        const target = recorder();
        const ingest = createTerminalIngest(target, options(scheduler as never));

        ingest.replay('ABCDEFGHIJ');
        // First tick ran synchronously: reset + the first chunk are already down.
        expect(target.resets).toBe(1);
        expect(target.writes).toEqual(['ABCD']);
        expect(ingest.awaitingReplay).toBe(true);

        // Live bytes during application are held — they postdate the snapshot's tail.
        ingest.live('tail');
        expect(target.writes).toEqual(['ABCD']);

        (scheduler as { flush: () => void }).flush();
        expect(target.writes).toEqual(['ABCD', 'EFGH', 'IJ', 'tail']);
        expect(ingest.awaitingReplay).toBe(false);
    });

    it('a newer replay supersedes an incomplete one: remainder abandoned behind a CAN abort', () => {
        const scheduler = manualScheduler();
        const target = recorder();
        const ingest = createTerminalIngest(target, options(scheduler as never));

        ingest.replay('OLD-SNAPSHOT-1');
        expect(target.writes).toEqual(['OLD-']);
        ingest.live('held-behind-old');

        ingest.replay('NEWXY');
        (scheduler as { flush: () => void }).flush();

        // The cut may have left the parser mid-sequence, so the abort byte precedes the new
        // application's reset; not one further chunk of the OLD snapshot was written, and the
        // bytes held behind it went with it (they are inside the new snapshot).
        expect(target.writes).toEqual(['OLD-', '\x18', 'NEWX', 'Y']);
        expect(target.resets).toBe(2);
        expect(ingest.replays).toBe(2);
    });

    it('a pause mid-application parks the snapshot and resume re-applies it from scratch', () => {
        const scheduler = manualScheduler();
        const target = recorder();
        const ingest = createTerminalIngest(target, options(scheduler as never));

        ingest.replay('SNAPSHOT');
        expect(target.writes).toEqual(['SNAP']);
        ingest.pause();
        ingest.live('after-fault');
        (scheduler as { flush: () => void }).flush();
        // Sealed: nothing more reached the (poisoned) target.
        expect(target.writes).toEqual(['SNAP']);

        ingest.resume();
        (scheduler as { flush: () => void }).flush();
        // The rebuilt engine gets the WHOLE snapshot again, then the held tail.
        expect(target.writes).toEqual(['SNAP', 'SNAP', 'SHOT', 'after-fault']);
        expect(target.resets).toBe(2);
    });

    it('never splits a surrogate pair at a string chunk boundary', () => {
        const scheduler = manualScheduler();
        const target = recorder();
        const ingest = createTerminalIngest(target, options(scheduler as never));

        // '🙂' is a surrogate pair; placed so a naive 4-unit cut would land between its halves.
        ingest.replay('abc🙂def');
        (scheduler as { flush: () => void }).flush();

        expect(target.writes.join('')).toBe('abc🙂def');
        for (const write of target.writes) {
            const last = write.charCodeAt(write.length - 1);
            expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
    });
});
