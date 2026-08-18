/**
 * One shared 1-second ticker for the whole chrome.
 *
 * shell-ui.md §15 "Timers to reproduce" lists a 1s elapsed/clock ticker; agent-lifecycle.md
 * §12 rule 12 adds that it must be render-side and must never mint a timer per badge. One
 * module-level interval publishes the current whole second and every consumer subscribes
 * through `useSyncExternalStore`, so the footer clock, the footer's agent elapsed label and
 * any popover row tick on the same edge — and the interval only exists while something is
 * actually showing a clock.
 */

import { useSyncExternalStore } from 'react';

function readSecond(): number {
    return Math.floor(Date.now() / 1000);
}

let currentSecond = readSecond();
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
    const next = readSecond();
    if (next === currentSecond) return;
    currentSecond = next;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (interval === null) {
        currentSecond = readSecond();
        interval = setInterval(tick, 1000);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && interval !== null) {
            clearInterval(interval);
            interval = null;
        }
    };
}

function noopSubscribe(): () => void {
    return () => {};
}

/**
 * The current epoch second, re-rendering the caller once per second while `active`.
 * `getSnapshot` returns a cached value — React calls it on every render and would loop
 * forever on a value that changes every call.
 */
export function useSecondsTicker(active = true): number {
    return useSyncExternalStore(
        active ? subscribe : noopSubscribe,
        () => currentSecond,
        () => currentSecond
    );
}

/** Test seam: how many components currently hold the ticker open. */
export function tickerListenerCount(): number {
    return listeners.size;
}
