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
    /**
     * Runs the search for real (the socket round trip). Return the request's promise and the
     * scheduler knows when it has been answered, which is what `inTransit()` needs; anything else
     * counts as answered on the spot.
     */
    readonly send: (needle: string) => unknown;
    /** Told whenever `inTransit()` changes: the needle just pushed, or null once caught up. */
    readonly onTransit?: ((needle: string | null) => void) | undefined;
    readonly delayMs?: number | undefined;
    readonly minLength?: number | undefined;
    /** Timer seam, so a test can hold the clock still. Defaults to the globals. */
    readonly setTimer?: ((fn: () => void, ms: number) => unknown) | undefined;
    readonly clearTimer?: ((handle: unknown) => void) | undefined;
}

export interface SearchNeedleScheduler {
    /** A keystroke. Returns true when the needle went out NOW, false when it was deferred. */
    push: (needle: string) => boolean;
    /**
     * Drop anything pending (the bar closed, the pane went away, the component unmounted), and
     * forget the needle in transit: a request still on the wire belongs to a session that is over.
     */
    cancel: () => void;
    /**
     * Send a deferred needle NOW instead of dropping it. Returns true when there was one to send.
     *
     * For a gesture that has to recount whatever was typed last - the case toggle - where
     * `cancel()` would lose a short needle still waiting out its 300 ms: the daemon would never
     * see it, and the field would go on showing a needle nothing had counted.
     */
    flush: () => boolean;
    /** Is a deferred needle waiting? Exposed for tests and for the audit's counter. */
    pending: () => boolean;
    /**
     * The needle last pushed, for as long as the daemon may not have it: waiting out the debounce,
     * or sent and not yet answered. Null once every request carrying one has been answered.
     *
     * The daemon's `searchNeedle` trails the field by up to a debounce and a round trip, and a bar
     * that is HANDED the needle rather than reading its own field - a presenter taking over from the
     * native bar mid-word, or the native bar coming back from a failed presenter - has to be handed
     * this one, or it strands whatever was typed in the last 300 ms. Answered is late enough: the
     * daemon stores the needle before it recounts, so the delta carrying it arrives before the reply.
     */
    inTransit: () => string | null;
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

function thenable(value: unknown): value is PromiseLike<unknown> {
    return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
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
    let deferred: string | null = null;
    /** The needle in transit, and how many requests are still unanswered. */
    let latest: string | null = null;
    let unanswered = 0;
    /** Bumped by `cancel()`, so an answer to a request from a session that is over counts for nothing. */
    let epoch = 0;

    const transit = (needle: string | null): void => {
        if (latest === needle) return;
        latest = needle;
        options.onTransit?.(needle);
    };
    const settleIfIdle = (): void => {
        if (handle === null && unanswered === 0) transit(null);
    };
    const stopTimer = (): void => {
        if (handle === null) return;
        clearTimer(handle);
        handle = null;
        deferred = null;
    };
    const send = (needle: string): void => {
        const request = options.send(needle);
        if (!thenable(request)) {
            settleIfIdle();
            return;
        }
        unanswered += 1;
        const sentIn = epoch;
        const answered = (): void => {
            if (sentIn !== epoch) return;
            unanswered -= 1;
            settleIfIdle();
        };
        request.then(answered, answered);
    };

    return {
        push(needle: string): boolean {
            // Cancel-in-flight FIRST, on every path: this is the shared debounce id.
            stopTimer();
            transit(needle);
            if (searchNeedleIsImmediate(needle, minLength)) {
                send(needle);
                return true;
            }
            deferred = needle;
            handle = setTimer(() => {
                handle = null;
                deferred = null;
                send(needle);
            }, delayMs);
            return false;
        },
        cancel(): void {
            stopTimer();
            epoch += 1;
            unanswered = 0;
            transit(null);
        },
        flush(): boolean {
            const needle = deferred;
            if (needle === null) return false;
            stopTimer();
            send(needle);
            return true;
        },
        pending: () => handle !== null,
        inTransit: () => latest
    };
}
