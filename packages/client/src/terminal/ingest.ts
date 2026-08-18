/**
 * Replay-then-live ordering for one pane's byte stream.
 *
 * The daemon's attach protocol (`daemon/src/ws/streams.ts`) is: register the pane as
 * "attaching" → take the server-side VT snapshot → flip live **synchronously**. So a client
 * gets exactly one `replay` frame followed by gapless `output`. This module holds the client
 * half of that contract, which matters in three places the transport cannot cover:
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
 */

/** The slice of `TerminalRenderer` this needs — so it is testable without an engine. */
export interface IngestTarget {
    write(data: Uint8Array | string): void;
    reset(): void;
}

/** Live bytes held while a replay is pending; beyond this the oldest chunks are dropped. */
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
    /** Replay frames applied so far (diagnostics / tests). */
    readonly replays: number;
    /** Whether a replay is currently awaited. */
    readonly awaitingReplay: boolean;
}

export function createTerminalIngest(target: IngestTarget): TerminalIngest {
    let replays = 0;
    let awaiting = true;
    let held: (Uint8Array | string)[] = [];
    let heldBytes = 0;

    const hold = (data: Uint8Array | string): void => {
        held.push(data);
        heldBytes += data.length;
        while (heldBytes > PENDING_LIVE_LIMIT_BYTES && held.length > 1) {
            const dropped = held.shift();
            if (dropped === undefined) break;
            heldBytes -= dropped.length;
        }
    };

    return {
        replay(data: Uint8Array | string): void {
            // The first replay paints into a fresh engine; every later one supersedes a screen
            // that is already there.
            if (replays > 0) target.reset();
            replays += 1;
            awaiting = false;
            target.write(data);
            const pending = held;
            held = [];
            heldBytes = 0;
            for (const chunk of pending) target.write(chunk);
        },
        live(data: Uint8Array | string): void {
            if (awaiting) {
                hold(data);
                return;
            }
            target.write(data);
        },
        expectReplay(): void {
            awaiting = true;
        },
        get replays(): number {
            return replays;
        },
        get awaitingReplay(): boolean {
            return awaiting;
        }
    };
}
