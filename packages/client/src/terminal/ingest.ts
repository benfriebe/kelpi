/**
 * Replay-then-live ordering for one pane's byte stream.
 *
 * The daemon's attach protocol (`daemon/src/ws/streams.ts`) is: register the pane as
 * "attaching" → take the server-side VT snapshot → flip live **synchronously**. So a client
 * gets exactly one `replay` frame followed by gapless `output`. This module holds the client
 * half of that contract, which matters in four places the transport cannot cover:
 *
 *   1. **Reconnect / resync.** `PtyClient` re-attaches every subscribed pane after a redial,
 *      and the daemon re-seeds a client whose flow-control queue it dropped (`pty-resync`).
 *      Either way a SECOND replay arrives for a renderer that already has content on screen.
 *      The snapshot is a plain `@xterm/addon-serialize` VT stream with **no leading clear**
 *      (verified: it opens straight with the first line's text and ends with the mode set), so
 *      appending it would leave the stale screen above the restored one — a subsequent replay
 *      therefore resets first (the adapter implements that as an in-stream RIS).
 *   2. **Late engines.** ghostty-web loads its WASM asynchronously; the renderer adapter
 *      queues writes until `open()` lands, preserving order across the gap.
 *   3. **Out-of-order arrival.** Live bytes seen while a replay is still pending are held and
 *      flushed *after* it, rather than painted first (the lossless reading of the daemon's own
 *      "pre-live bytes are already inside the pending replay" rule).
 *   4. **A dying engine.** `pause()` seals the target off the instant a renderer is poisoned
 *      and is about to be replaced (run-F N1). Nothing more reaches it — not a live chunk, not
 *      even a replay — so the last thing a failed engine ever hears is the write that killed
 *      it. What arrives while sealed is held, and `resume()` releases it in order behind a
 *      reset, so re-pointing the same ingest at a working engine loses nothing.
 */

/** The slice of `TerminalRenderer` this needs — so it is testable without an engine. */
export interface IngestTarget {
    write(data: Uint8Array | string): void;
    reset(): void;
}

/** Live bytes held while a replay is pending; beyond this the hold is dropped WHOLE. */
export const PENDING_LIVE_LIMIT_BYTES = 256 * 1024;

export interface TerminalIngest {
    /** A `replay` frame: the pane's screen as of attach. */
    replay(data: Uint8Array | string): void;
    /** An `output` frame. */
    live(data: Uint8Array | string): void;
    /**
     * A fresh replay is coming (reconnect, `pty-resync`): hold live bytes until it lands so a
     * stale tail cannot paint over the re-seeded screen.
     */
    expectReplay(): void;
    /**
     * Seal the target: the engine behind it is poisoned and must never be written to again
     * (run-F N1). Bytes that arrive while sealed are held, not dropped.
     */
    pause(): void;
    /** Unseal and release everything held, in arrival order, behind a reset if a replay landed. */
    resume(): void;
    /** Replay frames applied so far (diagnostics / tests). */
    readonly replays: number;
    /** Times an overflowing hold was dropped whole rather than spliced (diagnostics / tests). */
    readonly drops: number;
    /** Whether a replay is currently awaited. */
    readonly awaitingReplay: boolean;
    /** Whether the target is sealed off. */
    readonly paused: boolean;
}

export function createTerminalIngest(target: IngestTarget): TerminalIngest {
    let replays = 0;
    let drops = 0;
    let awaiting = true;
    let paused = false;
    /** A replay landed while sealed: the release has to lead with a reset, as `replay()` does. */
    let heldReplay = false;
    let held: (Uint8Array | string)[] = [];
    let heldBytes = 0;

    /**
     * Hold a live chunk until the replay that supersedes it lands.
     *
     * **Overflow drops the hold WHOLE, never its oldest chunks (N23).** A terminal stream is not
     * a set of independent chunks: cut one out of the middle and everything after it is parsed
     * against state that never happened — a multi-byte codepoint loses its continuation and
     * renders as U+FFFD, an escape sequence loses its final byte and eats the text that follows
     * it. Drop-oldest therefore turned an overflow into a spliced stream, painted at full width;
     * the same shape as the daemon's own flow-control rule ("once a byte is lost the queue is no
     * longer a faithful continuation of the stream", `ws/streams.ts`), which drops its queue
     * whole and re-seeds. Dropping everything here is safe for the same reason it is there:
     * bytes are only ever held while a replay is AWAITED (the attach snapshot, or the one a
     * `pty-resync` promises) or while the target is sealed pending a rebuilt engine, and every
     * one of those paths ends in a replay that resets the screen and describes it completely.
     */
    const hold = (data: Uint8Array | string): void => {
        held.push(data);
        heldBytes += data.length;
        if (heldBytes <= PENDING_LIVE_LIMIT_BYTES) return;
        // A replay parked at the head of the hold (`replay()` while paused) is the screen
        // itself, not a continuation of anything — it survives, and the live tail behind it goes.
        const snapshot = heldReplay ? held[0] : undefined;
        held = snapshot === undefined ? [] : [snapshot];
        heldBytes = snapshot === undefined ? 0 : snapshot.length;
        drops += 1;
    };

    /** Hand everything held to the target and clear the buffer. */
    const release = (): void => {
        const pending = held;
        held = [];
        heldBytes = 0;
        for (const chunk of pending) target.write(chunk);
    };

    return {
        replay(data: Uint8Array | string): void {
            replays += 1;
            awaiting = false;
            if (heldReplay) {
                // A newer snapshot supersedes an older one and everything queued behind it —
                // the daemon's snapshot is taken at attach, so those bytes are already in it.
                held = [];
                heldBytes = 0;
                heldReplay = false;
            }
            if (paused) {
                // A replay supersedes anything held behind it — the same rule the live path
                // follows — and it must still be preceded by a reset when it is released.
                held = [data];
                heldBytes = data.length;
                heldReplay = true;
                return;
            }
            /**
             * ALWAYS reset first — including the first replay, into what ought to be a fresh
             * engine.
             *
             * The snapshot carries no leading clear (see the header note), so it describes the
             * cells it mentions and says nothing about the rest. "A fresh engine starts blank"
             * turned out to be an assumption rather than a fact: ghostty-web runs every
             * terminal through one shared WASM instance, and a pane mounted where another had
             * just been torn down came up showing the PREVIOUS pane's screen with its own
             * prompt painted over row 1. Revealing a newly created workspace (run-B L3) is what
             * exposed it — until then nothing ever put a brand-new pane on screen a moment
             * after another pane left it. One RIS per attach makes the replay the whole truth.
             */
            target.reset();
            target.write(data);
            release();
        },
        live(data: Uint8Array | string): void {
            if (paused || awaiting) {
                hold(data);
                return;
            }
            target.write(data);
        },
        expectReplay(): void {
            awaiting = true;
        },
        pause(): void {
            paused = true;
        },
        resume(): void {
            if (!paused) return;
            paused = false;
            // Still waiting on the snapshot that supersedes everything: keep holding, exactly
            // as the un-paused path does.
            if (awaiting) return;
            if (heldReplay) {
                heldReplay = false;
                target.reset();
            }
            release();
        },
        get replays(): number {
            return replays;
        },
        get drops(): number {
            return drops;
        },
        get awaitingReplay(): boolean {
            return awaiting;
        },
        get paused(): boolean {
            return paused;
        }
    };
}
