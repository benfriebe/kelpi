/**
 * One render per frame, however many reports arrive (issue #78).
 *
 * Several independent producers can say "this changed" inside one gesture, each from its own
 * task. The pane geometries on a workspace switch are the case this was written for: every
 * pane reports its grid from a `setTimeout(0)` visibility effect and again when its engine
 * finishes opening, so a switch of twelve panes bumps App state about two dozen times, none of
 * them batched by React because none of them share an event. The DATA is not the problem (it
 * lives in a ref, and anything that reads it reads the truth); the RENDERS are, and a screen
 * cannot show more than one per frame anyway.
 *
 * So: `request()` as often as you like, `run` happens once, on the next frame.
 *
 * `requestAnimationFrame` rather than a microtask or a timer because this exists to schedule a
 * PAINT, and the frame is the unit a paint is shown in: a microtask would coalesce a burst
 * that lands in one task and nothing else. The fallback is a timer, for a host that has no rAF
 * (jsdom without `pretendToBeVisual`, a non-DOM embedder): the tick still lands, one task later
 * instead of one frame later, rather than being dropped.
 *
 * A frame callback never fires in a hidden window (browsers park rAF entirely), which is
 * correct here: nothing is painting, and the ref already holds the current value for whoever
 * asks. The next report after the window comes back schedules the render that shows it.
 */
export interface FrameTick {
    /** Ask for a run on the next frame. Idempotent while one is already scheduled. */
    request(): void;
    /** Drop a scheduled run (unmount). */
    cancel(): void;
    /** Is a run scheduled? (diagnostics / tests) */
    readonly pending: boolean;
}

export interface FrameTickOptions {
    /** Schedule `run`; returns a handle for `cancel`. Defaults to `requestAnimationFrame`. */
    readonly schedule?: ((run: () => void) => number) | undefined;
    readonly cancel?: ((handle: number) => void) | undefined;
}

function defaultSchedule(run: () => void): number {
    if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(() => run());
    return setTimeout(run, 0) as unknown as number;
}

function defaultCancel(handle: number): void {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export function createFrameTick(run: () => void, options: FrameTickOptions = {}): FrameTick {
    const schedule = options.schedule ?? defaultSchedule;
    const cancelScheduled = options.cancel ?? defaultCancel;
    let handle: number | null = null;

    return {
        request(): void {
            if (handle !== null) return;
            handle = schedule(() => {
                // Cleared BEFORE the callback runs, so a report raised by the render itself
                // schedules the next frame rather than being swallowed by this one.
                handle = null;
                run();
            });
        },
        cancel(): void {
            if (handle === null) return;
            const scheduled = handle;
            handle = null;
            cancelScheduled(scheduled);
        },
        get pending(): boolean {
            return handle !== null;
        }
    };
}
