/**
 * When a parked web tab gives its GPU memory back (issue #466). The timing rule is kept pure so
 * it can be tested without Electron; `./tab.ts` supplies the two Electron calls.
 *
 * Every tab is built with `backgroundThrottling: false` so an agent's `wait` keeps polling in a
 * tab nobody is looking at. In Electron that flag does more than stop timer throttling: it stops
 * Chromium ever telling the renderer it is hidden. A tab that was on screen once and then went
 * back to the off-screen holder (a workspace switch, a tab switch, a menu over the pane) kept
 * compositing and kept its GPU tiles for as long as Kelpi ran. On 2026-11-09 the live app had 38
 * web tabs and a 2.8 GB GPU process, 2.3 GB of it in 575 IOSurfaces.
 *
 * **What a sleeping tab is.** `./tab.ts` turns throttling ON and then hides and re-shows the view
 * inside the holder. Throttling on lets the hide reach the renderer; the hide-and-show is the
 * visibility change that delivers it. Measured on Electron 43.4 with six parked views each
 * animating a full-window canvas:
 *
 *   | state                      | page sees  | rAF/s | 100 ms timer/s | GPU process |
 *   |----------------------------|------------|-------|----------------|-------------|
 *   | parked, as before #466     | visible    | 1     | 10             | 523 MB      |
 *   | parked and asleep          | visible    | 0     | 10             | 235 MB      |
 *   | asleep, then woken         | visible    | 120   | 10             | 520 MB      |
 *
 * So the page keeps running its timers at full speed (a `wait` still polls ten times a second)
 * and only the compositor stops. Placing a sleeping tab wakes it, and the next park leaves it
 * awake until the delay below runs out again.
 *
 * **Why a delay.** Most parks are short: a menu over the pane, a workspace the person flips back
 * to a moment later. A tab that slept has to draw its page again when it comes back, while one
 * that stayed awake still has its last frame. So a tab is put to sleep only after it has been
 * parked, with nothing using it, for `PARKED_TAB_SLEEP_MS`.
 *
 * **Why an automation verb wakes it.** Not for the timers, which keep running. A
 * `Page.captureScreenshot` taken while the tab is asleep left the PAGE hidden afterwards, and a
 * hidden page is throttled to one timer wake-up a second (measured: 10/s before the capture,
 * 1/s after, until the next placement). A capture on a woken tab leaves the page visible. So
 * every verb that touches the page wakes the tab first, and the tab goes back to sleep once
 * nothing has used it for the same delay.
 *
 * **Only tabs that were on screen.** A tab that has never been placed was never shown, so its
 * renderer is already hidden and holds no tiles. Waking one would SHOW it: Electron's
 * `setBackgroundThrottling` calls `WasShown()` on a hidden view, whichever way it is set
 * (measured: ten never-shown views took the GPU process from 14 MB to 600 MB). Such a tab is
 * never put to sleep, so it is never woken either.
 */

/** How long a parked tab stays awake with nothing using it before it gives its GPU memory back. */
export const PARKED_TAB_SLEEP_MS = 60_000;

/**
 * The delay to use: `PARKED_TAB_SLEEP_MS`, or `KELPI_WEB_TAB_SLEEP_MS` when it is a positive
 * whole number of milliseconds. The override exists for the web smoke, which checks a sleep and
 * a wake and cannot spend a minute waiting for each.
 */
export function parkedTabSleepDelay(env: Readonly<Record<string, string | undefined>>): number {
    const raw = env['KELPI_WEB_TAB_SLEEP_MS'];
    if (raw === undefined || !/^\d+$/.test(raw)) return PARKED_TAB_SLEEP_MS;
    const ms = Number(raw);
    return ms > 0 ? ms : PARKED_TAB_SLEEP_MS;
}

export interface ParkSleepHooks {
    /** Put the parked view to sleep (`./tab.ts`: throttling on, then the hide that delivers it). */
    doze(): void;
    /** Wake a view `doze` put to sleep (throttling off). Never called on any other view. */
    wake(reason: ParkWakeReason): void;
    readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export type ParkWakeReason = 'placed' | 'used';

export interface ParkSleepTimers {
    readonly set: (callback: () => void, ms: number) => unknown;
    readonly clear: (handle: unknown) => void;
}

export interface ParkSleepOptions {
    readonly delayMs?: number | undefined;
    /** Test seam; defaults to the global `setTimeout` / `clearTimeout`. */
    readonly timers?: ParkSleepTimers | undefined;
}

export interface ParkSleep {
    /** The view went into the shell window. Wakes it if it was asleep. */
    placed(): void;
    /** The view went back to the holder. It goes to sleep after the delay if nothing uses it. */
    parked(): void;
    /**
     * Something is about to use the page (an agent verb, a navigation). Wakes the view if it is
     * asleep and keeps it awake until the returned release is called, then for the delay again.
     * The release is safe to call more than once.
     */
    use(): () => void;
    readonly asleep: boolean;
    dispose(): void;
}

const defaultTimers: ParkSleepTimers = {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
};

export function createParkSleep(hooks: ParkSleepHooks, options: ParkSleepOptions = {}): ParkSleep {
    const delayMs = options.delayMs ?? PARKED_TAB_SLEEP_MS;
    const timers = options.timers ?? defaultTimers;

    let embedded = false;
    /** False until the first placement: a never-shown view has nothing to give back. */
    let everPlaced = false;
    let asleep = false;
    let busy = 0;
    let disposed = false;
    let timer: unknown = null;

    const cancel = (): void => {
        if (timer === null) return;
        timers.clear(timer);
        timer = null;
    };

    const fire = (): void => {
        timer = null;
        if (disposed || embedded || busy > 0 || asleep) return;
        try {
            hooks.doze();
            asleep = true;
        } catch (error) {
            // Left awake, exactly as every parked tab was before #466.
            hooks.onError?.(error, 'park-sleep-doze');
        }
    };

    const schedule = (): void => {
        cancel();
        if (disposed || embedded || !everPlaced || busy > 0 || asleep) return;
        timer = timers.set(fire, delayMs);
    };

    const wake = (reason: ParkWakeReason): void => {
        if (!asleep) return;
        // Cleared first: a wake that throws must not leave the books saying "asleep" for a view
        // that may now be awake, or the next sleep would be skipped for ever.
        asleep = false;
        try {
            hooks.wake(reason);
        } catch (error) {
            hooks.onError?.(error, `park-sleep-wake (${reason})`);
        }
    };

    return {
        placed() {
            if (disposed) return;
            embedded = true;
            everPlaced = true;
            cancel();
            wake('placed');
        },

        parked() {
            if (disposed) return;
            embedded = false;
            schedule();
        },

        use() {
            if (disposed) return () => {};
            busy += 1;
            cancel();
            wake('used');
            let released = false;
            return () => {
                if (released) return;
                released = true;
                busy -= 1;
                schedule();
            };
        },

        get asleep() {
            return asleep;
        },

        dispose() {
            disposed = true;
            cancel();
        }
    };
}
