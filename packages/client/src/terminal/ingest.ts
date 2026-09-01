/**
 * Terminal byte ingest: the ordering gate between the PTY stream and the engine.
 *
 * The daemon's contract (terminal-surface.md §4, `ws/streams.ts`) is that an attaching client
 * gets exactly one `replay` frame followed by gapless `output`. This module holds the client
 * half of that bargain across four hazards:
 *
 *   1. **Engine load.** The WASM engine arrives asynchronously; bytes may land first.
 *   2. **Reconnect / flow-control resync.** The daemon re-seeds the stream (`pty-resync`).
 *      Either way a SECOND replay arrives for a renderer that already has content on screen.
 *      The snapshot IS the whole screen, so it must land on a reset terminal —
 *      appending it would leave the stale screen above the restored one — a subsequent replay
 *      always resets first.
 *   3. **Out-of-order arrival.** Live bytes seen while a replay is still pending are held and
 *      released only after the snapshot painted (the attach path's
 *      "pre-live bytes are already inside the pending replay" rule).
 *   4. **A poisoned engine.** A WASM fault mid-write leaves the engine unusable for anything,
 *      even a replay — so the last thing a failed engine ever hears is the write that killed
 *      it (`pause()` / `resume()` around the rebuild).
 *
 * **Replays are applied in TIME-BUDGETED CHUNKS, and a newer replay supersedes an older one
 * mid-application.** The engine's `write()` parses its whole payload in ONE synchronous WASM
 * call (`vendor/ghostty-web-patched`'s `writeInternal`), so a multi-megabyte snapshot — a
 * resumed agent session's 10 000-line buffer — used to wedge the main thread for its whole
 * parse. And it compounds: a wedged thread cannot run the socket handlers, so flow-control
 * acks stall, the daemon's queue overflows, and the overflow's own re-seed is ANOTHER
 * full-buffer replay (measured 2026-09-01: divider drags on an 8.8 MB session locked the UI —
 * "bricked" — until restart). Chunking bounds each task's parse work so acks and paint keep
 * flowing, and supersession makes a stacked replay cost only the chunks already written: the
 * remainder is abandoned, a CAN byte aborts any escape sequence the cut left open, and the
 * new snapshot's reset repaints the whole truth.
 */

/** How many bytes one write into the engine may carry during a chunked replay. */
export const REPLAY_CHUNK_BYTES = 64 * 1024;

/** How long one task may keep writing chunks before yielding to the event loop. */
export const REPLAY_TICK_BUDGET_MS = 8;

/** Live bytes held while a replay is pending; beyond this the hold is dropped WHOLE. */
export const PENDING_LIVE_LIMIT_BYTES = 256 * 1024;

/**
 * CAN (0x18) aborts an escape sequence in progress. Written before the reset when a replay
 * supersedes an INCOMPLETE application: the abandoned stream may have ended mid-sequence, and
 * without the abort the parser would eat the reset's own bytes as the sequence's tail.
 */
const CANCEL_SEQUENCE = '\x18';

export interface IngestTarget {
    write(data: Uint8Array | string): void;
    reset(): void;
}

export interface IngestOptions {
    readonly chunkBytes?: number | undefined;
    readonly tickBudgetMs?: number | undefined;
    /** Schedule a continuation task; returns the cancel. Defaults to `setTimeout(run, 0)`. */
    readonly schedule?: ((run: () => void) => () => void) | undefined;
    readonly now?: (() => number) | undefined;
}

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
    /** Whether a replay is currently awaited OR still being applied in chunks. */
    readonly awaitingReplay: boolean;
    /** Whether the target is sealed off. */
    readonly paused: boolean;
}

/** Slice [offset, offset+chunk), backing off one unit rather than splitting a surrogate pair. */
function sliceChunk(
    data: Uint8Array | string,
    offset: number,
    chunkBytes: number
): { chunk: Uint8Array | string; next: number } {
    if (typeof data !== 'string') {
        const end = Math.min(data.length, offset + chunkBytes);
        return { chunk: data.subarray(offset, end), next: end };
    }
    let end = Math.min(data.length, offset + chunkBytes);
    // A byte-array boundary is safe anywhere (the parser streams), but a STRING boundary that
    // splits a surrogate pair turns an astral codepoint into two U+FFFDs at encode time.
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    return { chunk: data.slice(offset, Math.max(end, offset + 1)), next: Math.max(end, offset + 1) };
}

export function createTerminalIngest(target: IngestTarget, options: IngestOptions = {}): TerminalIngest {
    const chunkBytes = Math.max(1, options.chunkBytes ?? REPLAY_CHUNK_BYTES);
    const tickBudgetMs = Math.max(0, options.tickBudgetMs ?? REPLAY_TICK_BUDGET_MS);
    const schedule =
        options.schedule ??
        ((run: () => void): (() => void) => {
            const timer = setTimeout(run, 0);
            return () => clearTimeout(timer);
        });
    const now = options.now ?? (() => Date.now());

    let replays = 0;
    let drops = 0;
    let awaiting = true;
    let paused = false;
    /** A replay landed while sealed: the release has to lead with a reset, as `replay()` does. */
    let heldReplay = false;
    let held: (Uint8Array | string)[] = [];
    let heldBytes = 0;
    /** The chunked application in flight, or null. */
    let applying: { data: Uint8Array | string; offset: number; cancel: (() => void) | null } | null =
        null;

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
     * `pty-resync` promises), still APPLYING, or while the target is sealed pending a rebuilt
     * engine — and every one of those paths ends in (or began with) a replay that resets the
     * screen. The one residual, pre-existing and accepted: a drop whose release is NOT behind a
     * fresh replay shows a discontinuity until the daemon's next re-seed.
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

    const cancelApplication = (): void => {
        if (applying === null) return;
        applying.cancel?.();
        applying = null;
    };

    /** Write chunks until done or the budget expires; completion releases the held tail. */
    const pump = (): void => {
        const current = applying;
        if (current === null) return;
        current.cancel = null;
        const start = now();
        while (current.offset < current.data.length) {
            const { chunk, next } = sliceChunk(current.data, current.offset, chunkBytes);
            current.offset = next;
            target.write(chunk);
            // A write may have poisoned the engine and `pause()`d us reentrantly, or a newer
            // replay may have superseded this application from a handler the write fired.
            if (applying !== current) return;
            if (now() - start >= tickBudgetMs && current.offset < current.data.length) {
                current.cancel = schedule(pump);
                return;
            }
        }
        applying = null;
        awaiting = false;
        release();
    };

    /**
     * Reset, then apply the snapshot in chunks. `abortOpenSequence` is set when this replay
     * supersedes an INCOMPLETE application, whose cut may have left the parser mid-sequence.
     */
    const beginApplication = (data: Uint8Array | string, abortOpenSequence: boolean): void => {
        cancelApplication();
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
        if (abortOpenSequence) target.write(CANCEL_SEQUENCE);
        target.reset();
        awaiting = true;
        applying = { data, offset: 0, cancel: null };
        // The first tick runs synchronously: a normal-sized screen applies in one chunk and
        // the pane paints now, exactly as it did before chunking existed.
        pump();
    };

    return {
        replay(data: Uint8Array | string): void {
            replays += 1;
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
                awaiting = false;
                held = [data];
                heldBytes = data.length;
                heldReplay = true;
                return;
            }
            const superseding = applying !== null;
            if (superseding) {
                // Bytes held for the OLD application are inside the new snapshot already.
                held = [];
                heldBytes = 0;
            }
            beginApplication(data, superseding);
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
            if (applying === null) return;
            // The engine is gone mid-application: park the FULL snapshot (a restart is a
            // reset + rewrite, so nothing already written is wasted work worth saving) ahead
            // of whatever live tail is held, and re-apply from scratch on resume.
            const parked = applying.data;
            cancelApplication();
            held = [parked, ...held];
            heldBytes += parked.length;
            heldReplay = true;
            awaiting = false;
        },
        resume(): void {
            if (!paused) return;
            paused = false;
            // Still waiting on the snapshot that supersedes everything: keep holding, exactly
            // as the un-paused path does.
            if (awaiting) return;
            if (heldReplay) {
                heldReplay = false;
                const [parked, ...tail] = held;
                held = tail;
                heldBytes = Math.max(0, heldBytes - (parked?.length ?? 0));
                if (parked !== undefined) {
                    // A rebuilt engine has a fresh parser; no open sequence to abort.
                    beginApplication(parked, false);
                    return;
                }
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
