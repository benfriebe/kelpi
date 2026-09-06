import { describe, expect, it, vi } from 'vitest';

import { createFrameTick } from './frame-tick';

/** A hand-cranked frame clock: `schedule` queues, `flush` is the frame. */
function frames(): { schedule: (run: () => void) => number; cancel: (handle: number) => void; flush: () => void; queued: number } {
    const pending = new Map<number, () => void>();
    let next = 1;
    return {
        schedule(run: () => void): number {
            const handle = next++;
            pending.set(handle, run);
            return handle;
        },
        cancel(handle: number): void {
            pending.delete(handle);
        },
        flush(): void {
            const due = [...pending.entries()];
            pending.clear();
            for (const [, run] of due) run();
        },
        get queued(): number {
            return pending.size;
        }
    };
}

describe('createFrameTick (issue #78)', () => {
    it('runs once however many reports arrive before the frame', () => {
        const clock = frames();
        const run = vi.fn();
        const tick = createFrameTick(run, clock);

        // Twelve panes, two reports each: the shape of one workspace switch.
        for (let i = 0; i < 24; i += 1) tick.request();
        expect(run).not.toHaveBeenCalled();
        expect(clock.queued).toBe(1);

        clock.flush();
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('schedules again for the next frame once it has run', () => {
        const clock = frames();
        const run = vi.fn();
        const tick = createFrameTick(run, clock);

        tick.request();
        clock.flush();
        tick.request();
        expect(tick.pending).toBe(true);
        clock.flush();
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('lets the run itself ask for another frame', () => {
        const clock = frames();
        let asked = false;
        const tick = createFrameTick(() => {
            if (asked) return;
            asked = true;
            tick.request();
        }, clock);

        tick.request();
        clock.flush();
        // The handle is cleared before the callback, so the re-request is not swallowed.
        expect(tick.pending).toBe(true);
    });

    it('cancels a scheduled run, and cancelling twice is harmless', () => {
        const clock = frames();
        const run = vi.fn();
        const tick = createFrameTick(run, clock);

        tick.request();
        tick.cancel();
        tick.cancel();
        clock.flush();
        expect(run).not.toHaveBeenCalled();
        expect(tick.pending).toBe(false);
    });

    it('uses the host frame clock when no schedule is supplied', async () => {
        const run = vi.fn();
        const tick = createFrameTick(run);
        tick.request();
        tick.request();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(run).toHaveBeenCalledTimes(1);
    });
});
