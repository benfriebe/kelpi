/**
 * PTY streams over the client-sync socket (WP2.7, `@nex/protocol` `ws/pty.ts`).
 *
 * One binary channel per client multiplexes every pane it is attached to:
 * `[type][16-byte paneID][payload]`. Terminal bytes therefore never touch the JSON channel
 * and never enter a client store (ARCHITECTURE.md "PTY streams").
 *
 * Attach semantics (terminal-surface.md §4, §9): the daemon replays the pane's server-side
 * VT snapshot, then goes live. Ordering is the whole trick —
 *
 *   1. the pane is registered as "attaching"; live bytes for it are ignored while it is,
 *   2. the snapshot is taken through `snapshotAsync()` when the terminal state offers one
 *      (xterm's `write()` is asynchronous, so the sync `snapshot()` can miss bytes that
 *      have been fed but not yet parsed — see `term/service.ts`), and
 *   3. the continuation flips the pane live **synchronously**, so no I/O callback can run
 *      between the snapshot settling and the first live byte.
 *
 * That gives exactly-once delivery: everything up to the snapshot is in the replay, and
 * everything after it arrives as `output`.
 *
 * Flow control (`PTY_FLOW_CONTROL_WINDOW_BYTES`): the daemon counts unacked payload bytes
 * per (client, pane). Past the window it stops sending to THAT client and queues; past the
 * queue bound it drops the queue and marks the pane for resync — the PTY is never paused
 * and other viewers are never slowed down, because a slow phone must not stall an agent.
 * On resume the client gets a fresh `replay` (the screen it would have rebuilt anyway)
 * plus a `pty-resync` notice on the JSON channel.
 *
 * This module deliberately does NOT feed `TerminalStateService` — boot owns the single
 * `pty.onData → term.feed` wiring, and doing it here would double-feed every pane.
 */

import {
    PTY_FLOW_CONTROL_WINDOW_BYTES,
    PTY_FRAME_TYPES,
    decodeAckPayload,
    decodePtyFrame,
    decodeResizePayload,
    encodePtyFrame,
    type JsonObject,
    type PtyFrameType
} from '@nex/protocol';

import type { PtyManager, TerminalStateService } from '../seams.js';

/** Per-(client, pane) bytes buffered while the client is over its window before we drop. */
export const DEFAULT_CLIENT_QUEUE_BYTES = 1024 * 1024;

/** JSON notice that a client's stream was truncated and has been re-seeded from a replay. */
export const PTY_RESYNC_MESSAGE_TYPE = 'pty-resync';

export interface PaneStreamTransport {
    /** Binary frame (already encoded). */
    sendFrame(frame: Uint8Array): void;
    /** JSON side-channel: `pane-exit`, `pty-resync`. */
    sendJson(message: JsonObject): void;
}

export interface PaneGeometry {
    readonly cols: number;
    readonly rows: number;
}

export interface PaneStreamStats {
    readonly live: boolean;
    readonly unacked: number;
    readonly queuedBytes: number;
    readonly paused: boolean;
    readonly resyncPending: boolean;
    readonly sentBytes: number;
}

export interface PaneStreamSession {
    /** Panes this client is currently subscribed to. */
    readonly paneIDs: readonly string[];
    /** Subscribe: applies the client-measured geometry, replays, then streams live output. */
    attach(paneID: string, size?: PaneGeometry | undefined): Promise<void>;
    detach(paneID: string): void;
    /** One binary frame from the client (`input` / `ack` / `resize`). */
    handleFrame(frame: Uint8Array): void;
    /** Client-measured geometry is authoritative: PTY first, then the server-side VT. */
    resize(paneID: string, cols: number, rows: number): void;
    stats(paneID: string): PaneStreamStats | undefined;
    close(): void;
}

export interface PaneStreamHubOptions {
    readonly pty: PtyManager;
    readonly term: TerminalStateService;
    /** Unacked bytes before a client's pane stream pauses. */
    readonly windowBytes?: number | undefined;
    /** Queue bound before the drop-oldest + resync path kicks in. */
    readonly maxQueuedBytes?: number | undefined;
    /**
     * Every client-reported grid, as it is applied. Boot uses it to remember what a pane was
     * last rendered at so the next spawn starts there instead of at 80×24 (`pty/geometry.ts`).
     */
    readonly onGeometry?: ((paneID: string, cols: number, rows: number) => void) | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

export interface PaneStreamHub {
    createSession(transport: PaneStreamTransport): PaneStreamSession;
    readonly sessionCount: number;
    /** Panes with at least one attached client (diagnostics / future render gating). */
    attachedPaneIDs(): string[];
    close(): void;
}

interface PaneEntry {
    /** Bumped on every (re)attach so a late snapshot for a detached pane is discarded. */
    generation: number;
    live: boolean;
    unacked: number;
    queue: Uint8Array[];
    queuedBytes: number;
    resyncPending: boolean;
    sentBytes: number;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

interface AsyncSnapshotCapable {
    snapshotAsync?: (paneID: string) => Promise<{ data: Uint8Array; cols: number; rows: number }>;
}

/**
 * Prefer the terminal state's async snapshot: it settles the pending write chain first, so
 * bytes fed a moment ago are inside the replay instead of missing from it.
 */
async function snapshotOf(
    term: TerminalStateService,
    paneID: string
): Promise<{ data: Uint8Array; cols: number; rows: number }> {
    const async = (term as TerminalStateService & AsyncSnapshotCapable).snapshotAsync;
    if (typeof async === 'function') return await async.call(term, paneID);
    return term.snapshot(paneID);
}

export function createPaneStreamHub(options: PaneStreamHubOptions): PaneStreamHub {
    const { pty, term } = options;
    const windowBytes = Math.max(1, options.windowBytes ?? PTY_FLOW_CONTROL_WINDOW_BYTES);
    const maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? DEFAULT_CLIENT_QUEUE_BYTES);
    const sessions = new Set<SessionImpl>();
    let closed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    class SessionImpl implements PaneStreamSession {
        private readonly panes = new Map<string, PaneEntry>();
        private disposed = false;

        constructor(private readonly transport: PaneStreamTransport) {}

        get paneIDs(): readonly string[] {
            return [...this.panes.keys()];
        }

        has(paneID: string): boolean {
            return this.panes.has(paneID);
        }

        async attach(paneID: string, size?: PaneGeometry | undefined): Promise<void> {
            if (this.disposed || closed) return;

            const existing = this.panes.get(paneID);
            if (existing !== undefined) {
                // Re-attaching an attached pane is a geometry update, not a second replay.
                if (size !== undefined) this.resize(paneID, size.cols, size.rows);
                return;
            }

            const entry: PaneEntry = {
                generation: 1,
                live: false,
                unacked: 0,
                queue: [],
                queuedBytes: 0,
                resyncPending: false,
                sentBytes: 0
            };
            this.panes.set(paneID, entry);

            // Size before snapshotting so the replay matches what the client will render.
            if (size !== undefined) this.resize(paneID, size.cols, size.rows);

            let snapshot: { data: Uint8Array; cols: number; rows: number };
            try {
                snapshot = await snapshotOf(term, paneID);
            } catch (error) {
                report(error, `pty-attach ${paneID}`);
                this.panes.delete(paneID);
                return;
            }

            // Nothing below may await: the pane goes live in the same turn the snapshot
            // resolved in, which is what makes the replay/live handover gapless.
            if (this.disposed || closed) return;
            if (this.panes.get(paneID) !== entry) return;

            this.send(paneID, entry, PTY_FRAME_TYPES.replay, snapshot.data);
            entry.live = true;
        }

        detach(paneID: string): void {
            this.panes.delete(paneID);
        }

        resize(paneID: string, cols: number, rows: number): void {
            // Zero-size guard (terminal-surface.md §15.4): a transient 0×0 layout pass must
            // never reach the PTY.
            if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
            const safeCols = Math.trunc(cols);
            const safeRows = Math.trunc(rows);
            if (safeCols <= 0 || safeRows <= 0) return;
            try {
                pty.resize(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `pty-resize ${paneID}`);
            }
            try {
                term.resize(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `term-resize ${paneID}`);
            }
            try {
                options.onGeometry?.(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `geometry ${paneID}`);
            }
        }

        handleFrame(frame: Uint8Array): void {
            if (this.disposed) return;
            const decoded = decodePtyFrame(frame);
            if (decoded === undefined) return;
            const entry = this.panes.get(decoded.paneID);
            // A frame for a pane this client never attached is ignored: input has to follow
            // an attach, so a stray frame is either a race with detach or a buggy client.
            if (entry === undefined) return;

            switch (decoded.type) {
                case PTY_FRAME_TYPES.input:
                    if (decoded.payload.length === 0) return;
                    try {
                        // Sync-group mirroring happens inside the manager (seams.ts).
                        pty.write(decoded.paneID, decoded.payload);
                    } catch (error) {
                        report(error, `pty-write ${decoded.paneID}`);
                    }
                    return;
                case PTY_FRAME_TYPES.ack: {
                    const consumed = decodeAckPayload(decoded.payload);
                    if (consumed === undefined) return;
                    this.ack(decoded.paneID, entry, consumed);
                    return;
                }
                case PTY_FRAME_TYPES.resize: {
                    const size = decodeResizePayload(decoded.payload);
                    if (size === undefined) return;
                    this.resize(decoded.paneID, size.cols, size.rows);
                    return;
                }
                default:
                    // `output` / `replay` are server→client only; ignore (forward-compat).
                    return;
            }
        }

        stats(paneID: string): PaneStreamStats | undefined {
            const entry = this.panes.get(paneID);
            if (entry === undefined) return undefined;
            return {
                live: entry.live,
                unacked: entry.unacked,
                queuedBytes: entry.queuedBytes,
                paused: entry.unacked >= windowBytes,
                resyncPending: entry.resyncPending,
                sentBytes: entry.sentBytes
            };
        }

        close(): void {
            if (this.disposed) return;
            this.disposed = true;
            this.panes.clear();
            sessions.delete(this);
        }

        // ── internals ───────────────────────────────────────────────────────────────

        deliver(paneID: string, chunk: Uint8Array): void {
            const entry = this.panes.get(paneID);
            if (entry === undefined || chunk.length === 0) return;
            // Pre-live bytes are already inside the pending replay snapshot.
            if (!entry.live) return;
            if (entry.resyncPending || entry.unacked >= windowBytes) {
                this.enqueue(entry, chunk);
                return;
            }
            this.send(paneID, entry, PTY_FRAME_TYPES.output, chunk);
        }

        paneExited(paneID: string, exitCode: number): void {
            if (!this.panes.has(paneID)) return;
            this.transport.sendJson({ type: 'pane-exit', paneID, exitCode });
            this.panes.delete(paneID);
        }

        private enqueue(entry: PaneEntry, chunk: Uint8Array): void {
            if (entry.resyncPending) return; // already stale; the replay supersedes it
            entry.queue.push(chunk);
            entry.queuedBytes += chunk.length;
            if (entry.queuedBytes <= maxQueuedBytes) return;
            // Drop-oldest, all the way: once a byte is lost the queue is no longer a
            // faithful continuation of the stream, so the pane is re-seeded on resume.
            entry.queue = [];
            entry.queuedBytes = 0;
            entry.resyncPending = true;
        }

        private ack(paneID: string, entry: PaneEntry, consumed: number): void {
            entry.unacked = Math.max(0, entry.unacked - consumed);
            if (entry.unacked >= windowBytes) return;

            if (entry.resyncPending) {
                let snapshot: { data: Uint8Array; cols: number; rows: number };
                try {
                    snapshot = term.snapshot(paneID);
                } catch (error) {
                    report(error, `pty-resync ${paneID}`);
                    return;
                }
                entry.resyncPending = false;
                entry.queue = [];
                entry.queuedBytes = 0;
                this.send(paneID, entry, PTY_FRAME_TYPES.replay, snapshot.data);
                this.transport.sendJson({
                    type: PTY_RESYNC_MESSAGE_TYPE,
                    paneID,
                    reason: 'flow-control-drop'
                });
                return;
            }

            while (entry.queue.length > 0 && entry.unacked < windowBytes) {
                const chunk = entry.queue.shift() as Uint8Array;
                entry.queuedBytes -= chunk.length;
                this.send(paneID, entry, PTY_FRAME_TYPES.output, chunk);
            }
            if (entry.queue.length === 0) entry.queuedBytes = 0;
        }

        private send(paneID: string, entry: PaneEntry, type: PtyFrameType, payload: Uint8Array): void {
            const frame = encodePtyFrame(type, paneID, payload);
            if (frame === undefined) {
                report(new Error(`pane id is not a UUID: ${paneID}`), 'pty-frame');
                return;
            }
            entry.unacked += payload.length;
            entry.sentBytes += payload.length;
            try {
                this.transport.sendFrame(frame);
            } catch (error) {
                report(error, `pty-send ${paneID}`);
            }
        }
    }

    const offData = pty.onData((paneID, data) => {
        if (closed || data.length === 0) return;
        for (const session of sessions) session.deliver(paneID, data);
    });

    const offExit = pty.onExit((paneID, exitCode) => {
        if (closed) return;
        for (const session of sessions) session.paneExited(paneID, exitCode);
    });

    return {
        createSession(transport) {
            const session = new SessionImpl(transport);
            if (!closed) sessions.add(session);
            return session;
        },
        get sessionCount() {
            return sessions.size;
        },
        attachedPaneIDs() {
            const ids = new Set<string>();
            for (const session of sessions) for (const paneID of session.paneIDs) ids.add(paneID);
            return [...ids];
        },
        close() {
            if (closed) return;
            closed = true;
            offData();
            offExit();
            for (const session of [...sessions]) session.close();
            sessions.clear();
        }
    };
}
