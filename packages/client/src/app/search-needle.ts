/**
 * §TERM-116 — the terminal-search needle's debounce.
 *
 * Swift: `WorkspaceFeature.swift:1742-1835`. Every `searchNeedleChanged` effect is
 * `.cancellable(id: SearchDebounceID.debounce, cancelInFlight: true)`, so a keystroke cancels
 * whatever the previous one had in flight, and a needle **shorter than 3 characters** sleeps
 * 300 ms before it runs ("Debounce short queries to avoid expensive partial searches"). Three
 * characters or more runs immediately, and an empty needle issues the bare clear immediately —
 * clearing the field must never wait on a timer.
 *
 * Why it matters more here than there: the port's search is a *round trip*. The needle goes
 * over the socket, the daemon flushes the pane's write queue and scans up to 10 000 lines of
 * scrollback, and the answer comes back as workspace state. Without this, a one-character
 * needle typed into a large buffer was one full scan **per keystroke** — the exact cost the
 * Swift comment names, paid across a socket.
 *
 * Deliberately NOT a general-purpose debounce: the timing rule is the product behaviour under
 * test, so it lives in its own module with its own clock seam rather than inside a `useMemo` in
 * `App.tsx` where nothing could hold the clock still either side of the 300 ms.
 *
 * One divergence from the Swift, recorded because it is observable. Swift's *empty* branch
 * returns a non-cancellable effect, so a 300 ms sleep left over from the 1-character needle the
 * user just deleted still fires ~300 ms after the field is cleared and re-highlights a needle
 * that is no longer there. Here every path cancels the pending timer first, which is what the
 * item's own `src:` line describes ("all search effects are cancel-in-flight on a shared
 * debounce id") and what a person clearing a search means.
 */

/** Needles shorter than this run through the timer; this long or longer run immediately. */
export const SEARCH_DEBOUNCE_MIN_LENGTH = 3;

/** How long a short needle waits, in milliseconds (Swift: `.milliseconds(300)`). */
export const SEARCH_DEBOUNCE_MS = 300;

export interface SearchNeedleSchedulerOptions {
    /** Runs the search for real (the socket round trip). */
    readonly send: (needle: string) => void;
    readonly delayMs?: number | undefined;
    readonly minLength?: number | undefined;
    /** Timer seam, so a test can hold the clock still. Defaults to the globals. */
    readonly setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface SearchNeedleScheduler {
    /** A keystroke. Returns true when the needle went out NOW, false when it was deferred. */
    push: (needle: string) => boolean;
    /** Drop anything pending (the bar closed, the pane went away, the component unmounted). */
    cancel: () => void;
    /** Is a deferred needle waiting? Exposed for tests and for the audit's counter. */
    pending: () => boolean;
}

/**
 * `needle.length === 0 || needle.length >= minLength` ⇒ immediate; otherwise deferred.
 *
 * Exported because it is the whole rule, and a test that asserts the rule directly is cheaper
 * to read than one that infers it from timer bookkeeping.
 */
export function searchNeedleIsImmediate(needle: string, minLength = SEARCH_DEBOUNCE_MIN_LENGTH): boolean {
    return needle.length === 0 || needle.length >= minLength;
}

export function createSearchNeedleScheduler(
    options: SearchNeedleSchedulerOptions
): SearchNeedleScheduler {
    const delayMs = options.delayMs ?? SEARCH_DEBOUNCE_MS;
    const minLength = options.minLength ?? SEARCH_DEBOUNCE_MIN_LENGTH;
    const setTimer =
        options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
    const clearTimer =
        options.clearTimer ?? ((handle: unknown) => { clearTimeout(handle as ReturnType<typeof setTimeout>); });

    let handle: unknown = null;

    const cancel = (): void => {
        if (handle === null) return;
        clearTimer(handle);
        handle = null;
    };

    return {
        push(needle: string): boolean {
            // Cancel-in-flight FIRST, on every path: this is the shared debounce id.
            cancel();
            if (searchNeedleIsImmediate(needle, minLength)) {
                options.send(needle);
                return true;
            }
            handle = setTimer(() => {
                handle = null;
                options.send(needle);
            }, delayMs);
            return false;
        },
        cancel,
        pending: () => handle !== null
    };
}
