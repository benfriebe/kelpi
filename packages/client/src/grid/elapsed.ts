/**
 * Elapsed-time labels and the one shared 1-second ticker behind them.
 *
 * agent-lifecycle.md §9.2 and §12 rule 12: the elapsed clock is a *render-side* concern —
 * it must never dispatch state actions, and it must never mint a timer per badge (a
 * 40-pane workspace would run 40 intervals drifting against each other). One module-level
 * interval publishes the current whole second; every badge subscribes through
 * `useSyncExternalStore`, so they all tick on the same edge and the interval only exists
 * while something is actually showing a clock.
 */

import { useSyncExternalStore } from 'react';

/**
 * `chromeElapsedLabel(start, now)` (shell-ui.md §2 "Utility formats", agent-lifecycle.md
 * §9.2). Both arguments are epoch SECONDS — which the store's `agentStartedAt` is NOT (it is
 * epoch MILLISECONDS, stamped with `Date.now()` by the agent state machine), so the caller
 * converts: `PaneHeader.agentBadge` is the one that does, and the formatter stays
 * unit-agnostic. Negatives clamp to 0. Examples: `9s`, `4m 9s`, `1h 3m`.
 */
export function chromeElapsedLabel(startSeconds: number, nowSeconds: number): string {
    const total = Math.max(0, Math.floor(nowSeconds - startSeconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

// ── the shared ticker ───────────────────────────────────────────────────────────────

function readClock(): number {
    return Math.floor(Date.now() / 1000);
}

let currentSecond = readClock();
let interval: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function tick(): void {
    const next = readClock();
    if (next === currentSecond) return;
    currentSecond = next;
    for (const listener of listeners) listener();
}

function subscribeSecond(listener: () => void): () => void {
    listeners.add(listener);
    if (interval === null) {
        // Re-read on start: the cached value may be stale if nothing subscribed for a while.
        currentSecond = readClock();
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
 * `getSnapshot` returns a cached value (never `Date.now()` directly) — React calls it on
 * every render and would loop forever on a value that changes every call.
 */
export function useSecondsTicker(active: boolean): number {
    return useSyncExternalStore(
        active ? subscribeSecond : noopSubscribe,
        () => currentSecond,
        () => currentSecond
    );
}

/** Test seam: how many components are currently holding the ticker open. */
export function tickerListenerCount(): number {
    return listeners.size;
}
