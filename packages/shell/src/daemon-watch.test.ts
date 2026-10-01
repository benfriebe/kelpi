/**
 * #312: the shell notices a stopped daemon, says so, and notices one coming back, with a fake
 * clock, fake timers and a scripted run dir.
 */

import { describe, expect, it } from 'vitest';

import type { DaemonLocation, DaemonPresence } from './daemon.js';
import { createDaemonWatch, type DaemonWatchOptions } from './daemon-watch.js';

const LOCATION = { url: 'http://127.0.0.1:53358', token: 't', port: 53358, pid: 61173, spawned: false } as unknown as DaemonLocation;
const GONE: DaemonPresence = { kind: 'gone', runDir: '/run', reason: 'ECONNREFUSED' };
const BUSY: DaemonPresence = { kind: 'busy', runDir: '/run', reason: 'timeout' };
const READY: DaemonPresence = { kind: 'ready', location: LOCATION };

function rig(presences: DaemonPresence[], options: DaemonWatchOptions = {}) {
    let now = 0;
    const timers: { at: number; callback: () => void }[] = [];
    const adopted: DaemonLocation[] = [];
    const stopped: string[] = [];
    const lines: string[] = [];
    let asked = 0;
    const watch = createDaemonWatch(
        {
            find: () => Promise.resolve(presences[Math.min(asked++, presences.length - 1)] as DaemonPresence),
            adopt: (location) => adopted.push(location),
            stopped: (runDir) => stopped.push(runDir),
            log: (line) => lines.push(line),
            now: () => now,
            setTimer: (callback, ms) => {
                const timer = { at: now + ms, callback };
                timers.push(timer);
                return timer;
            },
            clearTimer: (timer) => {
                const index = timers.indexOf(timer as (typeof timers)[number]);
                if (index >= 0) timers.splice(index, 1);
            }
        },
        { stoppedAfterMs: 8_000, checkEveryMs: 2_000, stoppedCheckEveryMs: 5_000, ...options }
    );
    /** Run every timer due by `ms` from now, letting each probe settle. */
    const advance = async (ms: number): Promise<void> => {
        const until = now + ms;
        for (;;) {
            timers.sort((a, b) => a.at - b.at);
            const next = timers[0];
            if (next === undefined || next.at > until) break;
            timers.shift();
            now = next.at;
            next.callback();
            for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
        }
        now = until;
    };
    return { watch, adopted, stopped, lines, advance, asked: () => asked };
}

describe('the daemon watch (#312)', () => {
    it('does nothing until a connection fails', async () => {
        const r = rig([GONE]);
        await r.advance(60_000);
        expect(r.asked()).toBe(0);
        expect(r.watch.state).toBe('healthy');
    });

    it('calls the daemon stopped once nothing has listened for the grace period, then keeps looking slowly', async () => {
        const r = rig([GONE]);
        r.watch.suspect('the status connection dropped');
        await r.advance(7_999);
        expect(r.stopped).toEqual([]);
        expect(r.watch.state).toBe('checking');
        await r.advance(1);
        expect(r.stopped).toEqual(['/run']);
        expect(r.watch.state).toBe('stopped');
        const before = r.asked();
        await r.advance(15_000);
        expect(r.asked() - before).toBe(3);
        // Said once, not once per look.
        expect(r.stopped).toEqual(['/run']);
    });

    it('adopts a daemon that comes back, even after it was called stopped (a `kelpid start` from a terminal)', async () => {
        const r = rig([GONE, GONE, GONE, GONE, GONE, GONE, READY]);
        r.watch.suspect('the window could not load the daemon');
        await r.advance(30_000);
        expect(r.stopped).toHaveLength(1);
        expect(r.adopted).toEqual([LOCATION]);
        expect(r.watch.state).toBe('healthy');
        expect(r.lines.at(-1)).toContain('it was stopped; reconnecting');
    });

    it('adopts a successor straight away (`kelpid restart`), with no stopped page', async () => {
        const r = rig([GONE, READY]);
        r.watch.suspect('the status connection dropped');
        await r.advance(2_000);
        expect(r.adopted).toEqual([LOCATION]);
        expect(r.stopped).toEqual([]);
    });

    it('never calls a busy daemon stopped', async () => {
        const r = rig([BUSY]);
        r.watch.suspect('the status connection dropped');
        await r.advance(120_000);
        expect(r.stopped).toEqual([]);
        expect(r.watch.state).toBe('checking');
    });

    it('stops looking when a connection works again, and a second suspicion starts afresh', async () => {
        const r = rig([GONE]);
        r.watch.suspect('the status connection dropped');
        await r.advance(4_000);
        r.watch.healthy();
        const asked = r.asked();
        await r.advance(60_000);
        expect(r.asked()).toBe(asked);
        expect(r.stopped).toEqual([]);
        r.watch.suspect('the status connection dropped');
        await r.advance(7_000);
        expect(r.stopped).toEqual([]);
        await r.advance(1_000);
        expect(r.stopped).toEqual(['/run']);
    });

    it('waits while a start is in flight, and goes back to looking when it fails', async () => {
        const r = rig([GONE]);
        r.watch.suspect('x');
        await r.advance(8_000);
        r.watch.starting();
        const asked = r.asked();
        await r.advance(30_000);
        expect(r.asked()).toBe(asked);
        r.watch.startFailed();
        expect(r.watch.state).toBe('stopped');
        await r.advance(5_000);
        expect(r.asked()).toBe(asked + 1);
    });

    it('ignores a suspicion while it is already looking, and everything after dispose', async () => {
        const r = rig([GONE]);
        r.watch.suspect('first');
        r.watch.suspect('second');
        expect(r.lines.filter((line) => line.includes('looking for a daemon'))).toHaveLength(1);
        r.watch.dispose();
        await r.advance(60_000);
        expect(r.stopped).toEqual([]);
    });
});
