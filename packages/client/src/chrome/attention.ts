/**
 * The web port of the dock bounce: a one-shot title flash for an unfocused tab.
 *
 * agent-lifecycle.md §7.1: when an agent stops with nobody looking (`shouldBounce`), the daemon
 * broadcasts `attention-request`; the macOS shell answers with a dock bounce, and the "web
 * client equivalent" is "a one-shot attention signal (e.g. title flash / favicon pulse) when
 * the client tab is unfocused". The socket decoded the event and the bridge exposed it as
 * `onAttention`, but nothing in the browser client ever supplied that callback, so a tab left
 * on another desktop got no signal at all (issue #57 agl-m2). This is the consumer.
 *
 * Why a title flash and not a favicon pulse: the tab title is the one thing every browser
 * repaints on demand (Safari re-reads no icon a script swaps in, `favicon.ts`), so it is the
 * signal that actually reaches a background tab everywhere.
 *
 * Coexistence with the §8.4 title badge (`favicon.ts` writes `(N) Kelpi` on every summary
 * change): the flash never owns the title. It remembers what it found, alternates it with the
 * attention label a few times, and on every tick checks whether something ELSE wrote the title
 * in between, adopting that as the new resting title. It restores only when the title still
 * reads what it last wrote, so a badge update mid-flash wins and is never clobbered.
 *
 * Everything is injectable and the whole thing degrades to a no-op without a document, for the
 * same reason the favicon controller does: an attention signal must never be able to break the
 * app.
 */

/** The slice of `Document` the flash needs; jsdom's and a plain object both satisfy it. */
export interface AttentionDocument {
    title: string;
    readonly hidden: boolean;
    hasFocus(): boolean;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** The slice of `Window`: `focus` fires on the window, not the document. */
export interface AttentionView {
    addEventListener(type: 'focus', listener: () => void): void;
    removeEventListener(type: 'focus', listener: () => void): void;
}

export interface AttentionSignalOptions {
    readonly document?: AttentionDocument | null | undefined;
    readonly view?: AttentionView | null | undefined;
    /** The text the title alternates with. */
    readonly label?: string | undefined;
    /** How many times the label is shown; the flash always ends on the resting title. */
    readonly flashes?: number | undefined;
    /** Time each phase (label or resting title) stays up. */
    readonly intervalMs?: number | undefined;
    readonly setTimeout?: ((callback: () => void, ms: number) => unknown) | undefined;
    readonly clearTimeout?: ((handle: unknown) => void) | undefined;
}

export interface AttentionSignal {
    /**
     * Flash the title if the tab is unfocused or hidden; a no-op while the user is looking at
     * it (the dock bounce is suppressed the same way, by `shouldBounce`'s `!isAppActive`), and
     * a no-op while a flash is already running, so a burst of stops reads as one signal.
     */
    request(): void;
    /** Cancels a running flash and puts the resting title back. */
    dispose(): void;
}

export const DEFAULT_ATTENTION_LABEL = 'Agent is waiting for input';
export const DEFAULT_ATTENTION_FLASHES = 3;
export const DEFAULT_ATTENTION_INTERVAL_MS = 700;

export function createAttentionSignal(options: AttentionSignalOptions = {}): AttentionSignal {
    const doc = options.document ?? (globalThis.document as unknown as AttentionDocument | undefined) ?? null;
    const view = options.view ?? (globalThis.window as unknown as AttentionView | undefined) ?? null;
    const label = options.label ?? DEFAULT_ATTENTION_LABEL;
    const flashes = Math.max(1, options.flashes ?? DEFAULT_ATTENTION_FLASHES);
    const intervalMs = options.intervalMs ?? DEFAULT_ATTENTION_INTERVAL_MS;
    const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

    let timer: unknown = null;
    let resting: string | null = null;
    /** What this module last wrote; a title that reads differently was written by someone else. */
    let expected: string | null = null;
    let remaining = 0;
    let listening = false;

    const tabHasAttention = (): boolean => {
        if (doc === null) return true;
        return !doc.hidden && doc.hasFocus();
    };

    const stopListening = (): void => {
        if (!listening) return;
        listening = false;
        doc?.removeEventListener('visibilitychange', onFocusReturned);
        view?.removeEventListener('focus', onFocusReturned);
    };

    const finish = (): void => {
        if (timer !== null) {
            cancel(timer);
            timer = null;
        }
        stopListening();
        if (doc !== null && resting !== null && expected !== null && doc.title === expected) {
            doc.title = resting;
        }
        resting = null;
        expected = null;
        remaining = 0;
    };

    /** The user came back: the flash has done its job, end it on the resting title now. */
    function onFocusReturned(): void {
        if (tabHasAttention()) finish();
    }

    const tick = (): void => {
        timer = null;
        if (doc === null) return;
        // A badge update (or anything else) landed since the last write: that is the new
        // resting title, not the stale one captured at the start.
        if (expected !== null && doc.title !== expected) resting = doc.title;
        if (remaining <= 0) {
            finish();
            return;
        }
        const showLabel = doc.title !== label;
        if (showLabel) {
            expected = label;
            doc.title = label;
        } else {
            remaining -= 1;
            expected = resting ?? doc.title;
            doc.title = expected;
        }
        timer = schedule(tick, intervalMs);
    };

    return {
        request(): void {
            if (doc === null) return;
            if (timer !== null) return;
            if (tabHasAttention()) return;
            resting = doc.title;
            expected = doc.title;
            remaining = flashes;
            if (!listening) {
                listening = true;
                doc.addEventListener('visibilitychange', onFocusReturned);
                view?.addEventListener('focus', onFocusReturned);
            }
            tick();
        },
        dispose(): void {
            finish();
        }
    };
}
