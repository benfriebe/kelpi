/**
 * Per-pane PTY streams, multiplexed over the one socket (WP3.1).
 *
 * The binary channel is `[type][16-byte paneID][payload]` (`@kelpi/protocol` `ws/pty.ts`), so a
 * chunk of terminal output is demultiplexed without a JSON parse and handed straight to the
 * pane's renderer. **Terminal bytes never enter the zustand store** — that is the whole point
 * of keeping this module independent of `state/`.
 *
 * Attach protocol (`daemon/src/ws/streams.ts`):
 *   1. client sends `attach-pane` with its measured geometry,
 *   2. daemon replies with one `replay` frame (the server-side VT snapshot),
 *   3. `output` frames follow, gaplessly — the daemon flips the pane live in the same turn
 *      the snapshot resolved, so nothing is lost or duplicated between the two.
 *
 * Flow control is the client's job to honour: the daemon counts unacked payload bytes per
 * (client, pane) and stops draining that pane's ring buffer for us past
 * `PTY_FLOW_CONTROL_WINDOW_BYTES`. We therefore ack **as data is consumed** — coalesced on a
 * short timer so a chatty pane doesn't cost one frame per chunk, and flushed immediately once
 * a quarter of the window is outstanding. Replay bytes count too: the daemon charges them to
 * the same window.
 *
 * On reconnect every subscribed pane is re-attached and the ack counters reset — the daemon's
 * per-connection stream state died with the old socket, and the fresh `replay` re-seeds the
 * renderer.
 */

import {
    PTY_FLOW_CONTROL_WINDOW_BYTES,
    PTY_FRAME_TYPES,
    decodeResizePayload,
    encodeAckPayload,
    encodePtyFrame,
    type PtyFrameType,
    type PtyResize,
    type WsVtModes
} from '@kelpi/protocol';

import type { KelpiConnection } from './socket';

export interface PtySubscription {
    /**
     * Own this pane's renderer stream. Replaces previous subscribers with a fresh attach;
     * the next subscriber likewise replaces this one. Manual renderer credits must never
     * share an auto-ack subscriber's window or start without an authoritative replay.
     */
    readonly exclusive?: boolean | undefined;
    /** Current visible renderer geometry at attach/reconnect; absent means no size claim. */
    readonly getGeometry?: (() => { cols: number; rows: number } | undefined) | undefined;
    /**
     * Attach replay (the pane's screen as of attach). Falls back to `onData` when absent.
     *
     * `grid` is the cols/rows the snapshot was SERIALISED at (#166), when the daemon said — an
     * older daemon sends no `replayGrid` frame and the argument is undefined, which means "keep
     * doing what you did before", not "80x24". It is the grid the bytes can be parsed at and
     * nothing else: a subscriber whose engine is at a different one will glue a soft-wrapped row
     * to its continuation, because `@xterm/addon-serialize` leaves out the newline between them
     * (`daemon/src/ws/streams.ts` `sendReplayWithGrid` has the full argument).
     *
     * The `onData` fallback gets no grid, deliberately: a subscriber that does not distinguish a
     * replay from live output has no reset to hang a resize off either.
     */
    readonly onReplay?: ((data: Uint8Array, grid?: PtyResize | undefined) => void) | undefined;
    readonly onData: (data: Uint8Array) => void;
    readonly onExit?: ((exitCode: number | null, signal?: string) => void) | undefined;
    /** The daemon dropped our backlog and re-seeded us; the next replay is authoritative. */
    readonly onResync?: ((reason: string) => void) | undefined;
    /**
     * The pane's VT modes, once on attach (right behind the replay) and then on every change.
     *
     * This rides the pane STREAM rather than the store because it is per-pane terminal state,
     * and because its only consumer is the renderer host: the port encodes DEC mouse reports
     * itself (§TERM-037 — no renderer it ships implements them), and the encoder needs to know
     * which tracking mode and which coordinate format the application asked for.
     */
    readonly onModes?: ((modes: WsVtModes) => void) | undefined;
    /** Initial geometry; sent with `attach-pane` so the replay matches what we render. */
    readonly cols?: number | undefined;
    readonly rows?: number | undefined;
    /**
     * Ack delivered bytes automatically (default). Set false when the renderer's write is
     * asynchronous and you want to ack from its completion callback via `handle.ack()`.
     */
    readonly autoAck?: boolean | undefined;
}

export interface PtyStreamHandle {
    readonly paneID: string;
    /** Keyboard / paste bytes upstream (mirrored to sync siblings, terminal-surface.md §8.2). */
    write(data: Uint8Array | string): void;
    /**
     * Bytes for THIS pane only: client-encoded mouse reports and kitty key releases, which
     * §8.2 / §11 keep out of the sync-group fan-out. Rides its own frame type so the daemon
     * can take the un-mirrored write without inspecting the bytes (#51).
     */
    writeDirect(data: Uint8Array | string): void;
    /**
     * Client-measured geometry; the daemon resizes the PTY and its server-side VT.
     *
     * `force` re-sends a grid the daemon has already been told, which the short circuit below
     * otherwise swallows. One caller, one reason (#166): a pane that has been a cached non-owner
     * takes size control without its box changing, and the claim has to reach the PTY.
     */
    resize(cols: number, rows: number, force?: boolean): void;
    /** Report consumed bytes (only needed with `autoAck: false`). */
    ack(bytes: number): void;
    /** Bytes delivered to this client that the daemon has not seen acked yet. */
    readonly unacked: number;
    unsubscribe(): void;
}

export interface PtyClientOptions {
    /** Flush pending acks once this many bytes are outstanding. */
    readonly ackThresholdBytes?: number | undefined;
    /** Coalescing window for small chunks. */
    readonly ackIntervalMs?: number | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
}

interface PaneEntry {
    readonly subscriptions: Set<PtySubscription>;
    readonly exclusive: boolean;
    readonly getGeometry: (() => { cols: number; rows: number } | undefined) | undefined;
    geometryReported: boolean;
    cols: number;
    rows: number;
    attached: boolean;
    /** Delivered-but-unacked bytes (mirrors the daemon's own counter for this pane). */
    unacked: number;
    pendingAck: number;
    ackTimer: ReturnType<typeof setTimeout> | null;
    /** Last `pane-modes` for this pane; replayed to a subscriber that joins later. */
    modes: WsVtModes | null;
    /**
     * The grid the NEXT replay for this pane was serialised at (`replayGrid`, #166), or null.
     *
     * HELD, NOT APPLIED. The daemon sends the grid frame immediately before the replay it
     * belongs to, in the same turn, and this entry is what carries it the few microseconds
     * between the two. Keeping it here rather than telling the renderer straight away is the
     * safety property: a grid that arrives without its replay (a send that failed, an old
     * daemon's unrelated frame, a future daemon that reorders) does NOTHING, because resizing an
     * engine that is then never re-seeded leaves it holding a grid whose contents it has not
     * been told — the one state §N24's paint hold exists to cover, and it only covers a second.
     *
     * Cleared when it is consumed by a replay, and on reconnect: the grid is a statement about a
     * specific snapshot and the next socket's first replay will make its own.
     *
     * A grid whose replay never arrived would therefore be consumed by the NEXT replay, which
     * would be the wrong grid for those bytes. It is unreachable rather than guarded: the daemon
     * emits the pair from one synchronous function with nothing between the two sends
     * (`ws/streams.ts` `sendReplayWithGrid`), a WebSocket delivers in order, and the only way to
     * lose the second half is a `sendFrame` that throws — which on a real socket means the
     * connection is going away, and a reconnect clears this. Guarding it would mean a timer per
     * pane to expire a four-byte fact that is never late.
     */
    replayGrid: PtyResize | null;
}

const encoder = new TextEncoder();

export class PtyClient {
    private readonly panes = new Map<string, PaneEntry>();
    private readonly unsubscribers: (() => void)[] = [];
    private readonly ackThreshold: number;
    private readonly ackIntervalMs: number;
    private disposed = false;

    constructor(
        private readonly connection: KelpiConnection,
        private readonly options: PtyClientOptions = {}
    ) {
        this.ackThreshold = Math.max(1, options.ackThresholdBytes ?? Math.floor(PTY_FLOW_CONTROL_WINDOW_BYTES / 4));
        this.ackIntervalMs = Math.max(0, options.ackIntervalMs ?? 16);

        this.unsubscribers.push(
            connection.on('frame', (frame) => {
                const entry = this.panes.get(frame.paneID);
                if (entry === undefined) return;
                if (frame.type === PTY_FRAME_TYPES.replayGrid) {
                    // #166: the grid the replay BEHIND this frame was serialised at. Held on the
                    // entry until that replay lands (see `replayGrid` on `PaneEntry`); a grid
                    // whose cols/rows do not decode, or are zero, is dropped rather than guessed.
                    const grid = decodeResizePayload(frame.payload);
                    entry.replayGrid = grid !== undefined && grid.cols > 0 && grid.rows > 0 ? grid : null;
                    return;
                }
                if (frame.type === PTY_FRAME_TYPES.replay) {
                    const grid = entry.replayGrid;
                    entry.replayGrid = null;
                    this.deliver(entry, frame.paneID, frame.payload, true, grid ?? undefined);
                    return;
                }
                if (frame.type === PTY_FRAME_TYPES.output) {
                    this.deliver(entry, frame.paneID, frame.payload, false);
                }
                // `input` / `ack` / `resize` are client→server only; ignore (forward compat).
            })
        );

        this.unsubscribers.push(
            connection.on('pane-exit', (message) => {
                const entry = this.panes.get(message.paneID);
                if (entry === undefined) return;
                // The daemon drops the pane from its session on exit; keep the subscription so
                // a restarted pane with the same id re-attaches, but stop pretending we are
                // attached.
                entry.attached = false;
                for (const subscription of [...entry.subscriptions]) {
                    try {
                        subscription.onExit?.(message.exitCode, message.signal);
                    } catch (error) {
                        this.report(error, `pane-exit ${message.paneID}`);
                    }
                }
            })
        );

        this.unsubscribers.push(
            connection.on('pane-modes', (message) => {
                const entry = this.panes.get(message.paneID);
                if (entry === undefined) return;
                // Remembered so a viewer that subscribes LATER (a second pane view, a re-mount
                // between the attach and the next DECSET) starts from the real modes instead of
                // from "no mouse tracking" — which would silently disable reporting.
                entry.modes = message.modes;
                for (const subscription of [...entry.subscriptions]) {
                    try {
                        subscription.onModes?.(message.modes);
                    } catch (error) {
                        this.report(error, `pane-modes ${message.paneID}`);
                    }
                }
            })
        );

        this.unsubscribers.push(
            connection.on('pty-resync', (message) => {
                const entry = this.panes.get(message.paneID);
                if (entry === undefined) return;
                entry.unacked = 0;
                entry.pendingAck = 0;
                for (const subscription of [...entry.subscriptions]) {
                    try {
                        subscription.onResync?.(message.reason);
                    } catch (error) {
                        this.report(error, `pty-resync ${message.paneID}`);
                    }
                }
            })
        );

        this.unsubscribers.push(
            connection.on('status', (status) => {
                if (status === 'connected') {
                    this.reattachAll();
                    return;
                }
                for (const entry of this.panes.values()) {
                    entry.attached = false;
                    entry.unacked = 0;
                    entry.pendingAck = 0;
                    // A grid describes one snapshot on one socket (#166); the re-attach brings
                    // its own.
                    entry.replayGrid = null;
                    this.clearAckTimer(entry);
                }
            })
        );
    }

    get paneIDs(): readonly string[] {
        return [...this.panes.keys()];
    }

    /** Attached panes and their flow-control counters (diagnostics / tests). */
    stats(paneID: string): { attached: boolean; unacked: number; pendingAck: number } | undefined {
        const entry = this.panes.get(paneID);
        if (entry === undefined) return undefined;
        return { attached: entry.attached, unacked: entry.unacked, pendingAck: entry.pendingAck };
    }

    subscribe(paneID: string, subscription: PtySubscription): PtyStreamHandle {
        if (this.disposed) throw new Error('PTY client is disposed.');
        let entry = this.panes.get(paneID);
        if (entry !== undefined && (subscription.exclusive === true || entry.exclusive)) {
            // Flush the old stream before detaching. A renderer change is a viewer handoff,
            // never a process restart. Stale handles retain this entry but become inert.
            this.flushAck(paneID, entry);
            this.clearAckTimer(entry);
            this.panes.delete(paneID);
            this.connection.send({ type: 'detach-pane', paneID });
            entry = undefined;
        }
        const fresh = entry === undefined;
        if (entry === undefined) {
            entry = {
                subscriptions: new Set<PtySubscription>(),
                exclusive: subscription.exclusive === true,
                getGeometry: subscription.getGeometry,
                geometryReported: false,
                cols: subscription.cols ?? 80,
                rows: subscription.rows ?? 24,
                attached: false,
                unacked: 0,
                pendingAck: 0,
                ackTimer: null,
                modes: null,
                replayGrid: null
            };
            this.panes.set(paneID, entry);
        }
        const target = entry;
        target.subscriptions.add(subscription);
        if (subscription.cols !== undefined) target.cols = subscription.cols;
        if (subscription.rows !== undefined) target.rows = subscription.rows;
        // A subscriber joining an already-attached pane gets the modes it missed; a fresh one
        // gets them from the daemon's post-replay `pane-modes` a moment from now.
        if (!fresh && target.modes !== null) {
            try {
                subscription.onModes?.(target.modes);
            } catch (error) {
                this.report(error, `pane-modes ${paneID}`);
            }
        }

        if (fresh) {
            this.attach(paneID, target);
        } else if (subscription.cols !== undefined || subscription.rows !== undefined) {
            // A second viewer with its own geometry re-sizes rather than re-replaying: the
            // daemon treats a re-attach of an attached pane as a geometry update anyway.
            this.sendResize(paneID, target.cols, target.rows);
        }

        const client = this;
        const active = (): boolean => !client.disposed && client.panes.get(paneID) === target && target.subscriptions.has(subscription);
        return {
            paneID,
            write(data: Uint8Array | string): void {
                if (active()) client.write(paneID, data);
            },
            writeDirect(data: Uint8Array | string): void {
                if (active()) client.writeDirect(paneID, data);
            },
            resize(cols: number, rows: number, force?: boolean): void {
                if (active()) client.resize(paneID, cols, rows, force);
            },
            ack(bytes: number): void {
                if (active()) client.queueAck(paneID, target, bytes);
            },
            get unacked(): number {
                return active() ? target.unacked : 0;
            },
            unsubscribe(): void {
                if (active()) client.unsubscribe(paneID, subscription);
            }
        };
    }

    write(paneID: string, data: Uint8Array | string): void {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        if (bytes.length === 0) return;
        this.sendFrame(PTY_FRAME_TYPES.input, paneID, bytes);
    }

    writeDirect(paneID: string, data: Uint8Array | string): void {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        if (bytes.length === 0) return;
        this.sendFrame(PTY_FRAME_TYPES.inputDirect, paneID, bytes);
    }

    resize(paneID: string, cols: number, rows: number, force = false): void {
        const entry = this.panes.get(paneID);
        // A transient 0×0 measurement pass must never reach the PTY (terminal-surface §15.4);
        // the daemon guards too, but sending it would still stomp the stored geometry.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        const safeCols = Math.trunc(cols);
        const safeRows = Math.trunc(rows);
        if (safeCols <= 0 || safeRows <= 0) return;
        if (entry !== undefined) {
            if (!force && entry.geometryReported && entry.cols === safeCols && entry.rows === safeRows) return;
            entry.cols = safeCols;
            entry.rows = safeRows;
            entry.geometryReported = true;
        }
        this.sendResize(paneID, safeCols, safeRows, force);
    }

    unsubscribe(paneID: string, subscription: PtySubscription): void {
        const entry = this.panes.get(paneID);
        if (entry === undefined) return;
        if (!entry.subscriptions.delete(subscription)) return;
        if (entry.subscriptions.size > 0) return;
        this.flushAck(paneID, entry);
        this.clearAckTimer(entry);
        this.panes.delete(paneID);
        this.connection.send({ type: 'detach-pane', paneID });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.unsubscribers) off();
        this.unsubscribers.length = 0;
        for (const [paneID, entry] of [...this.panes.entries()]) {
            this.clearAckTimer(entry);
            this.panes.delete(paneID);
            this.connection.send({ type: 'detach-pane', paneID });
        }
    }

    // ── internals ──────────────────────────────────────────────────────────────────

    private attach(paneID: string, entry: PaneEntry): void {
        if (!this.connection.isConnected) return;
        entry.attached = true;
        entry.unacked = 0;
        entry.pendingAck = 0;
        const geometry = entry.getGeometry === undefined ? { cols: entry.cols, rows: entry.rows } : entry.getGeometry();
        entry.geometryReported = geometry !== undefined;
        if (geometry !== undefined) { entry.cols = geometry.cols; entry.rows = geometry.rows; }
        this.connection.send({ type: 'attach-pane', paneID, ...geometry });
    }

    private reattachAll(): void {
        for (const [paneID, entry] of this.panes.entries()) {
            entry.unacked = 0;
            entry.pendingAck = 0;
            this.clearAckTimer(entry);
            this.attach(paneID, entry);
        }
    }

    private sendResize(paneID: string, cols: number, rows: number, force = false): void {
        // The JSON form works before the attach settles (the daemon resizes PTY + VT without
        // consulting the stream table), which the binary `resize` frame does not.
        //
        // `force` rides only when it is true, so an ordinary report is the byte-identical message it
        // has always been. It tells the daemon "act on this even though the numbers have not
        // changed" (#166): a claim on the PTY from the client that has just taken size control, and
        // the one "re-seed me" request the protocol has from the client that has just lost it
        // (`protocol/src/ws/messages.ts` ▸ `WsResizePaneMessage.force`).
        this.connection.send({ type: 'resize-pane', paneID, cols, rows, ...(force ? { force: true } : {}) });
    }

    private deliver(
        entry: PaneEntry,
        paneID: string,
        payload: Uint8Array,
        replay: boolean,
        grid?: PtyResize | undefined
    ): void {
        if (replay) {
            // A replay supersedes anything still in flight for this pane.
            entry.unacked = 0;
            entry.pendingAck = 0;
        }
        entry.unacked += payload.length;

        let autoAck = false;
        for (const subscription of [...entry.subscriptions]) {
            if (subscription.autoAck !== false) autoAck = true;
            try {
                if (replay && subscription.onReplay !== undefined) subscription.onReplay(payload, grid);
                else subscription.onData(payload);
            } catch (error) {
                this.report(error, `pty-deliver ${paneID}`);
            }
        }
        if (autoAck) this.queueAck(paneID, entry, payload.length);
    }

    private queueAck(paneID: string, entry: PaneEntry, bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes <= 0 || this.panes.get(paneID) !== entry) return;
        // A duplicated completion callback cannot grant credit for bytes never delivered.
        entry.pendingAck += Math.min(bytes, Math.max(0, entry.unacked - entry.pendingAck));
        if (entry.pendingAck <= 0) return;
        if (entry.pendingAck >= this.ackThreshold) {
            this.flushAck(paneID, entry);
            return;
        }
        if (entry.ackTimer !== null) return;
        entry.ackTimer = setTimeout(() => {
            entry.ackTimer = null;
            this.flushAck(paneID, entry);
        }, this.ackIntervalMs);
    }

    private flushAck(paneID: string, entry: PaneEntry): void {
        this.clearAckTimer(entry);
        const bytes = entry.pendingAck;
        if (bytes <= 0) return;
        entry.pendingAck = 0;
        entry.unacked = Math.max(0, entry.unacked - bytes);
        this.sendFrame(PTY_FRAME_TYPES.ack, paneID, encodeAckPayload(bytes));
    }

    private clearAckTimer(entry: PaneEntry): void {
        if (entry.ackTimer === null) return;
        clearTimeout(entry.ackTimer);
        entry.ackTimer = null;
    }

    private sendFrame(type: PtyFrameType, paneID: string, payload: Uint8Array): void {
        const frame = encodePtyFrame(type, paneID, payload);
        if (frame === undefined) {
            this.report(new Error(`pane id is not a UUID: ${paneID}`), 'pty-frame');
            return;
        }
        this.connection.sendFrame(frame);
    }

    private report(error: unknown, context: string): void {
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    }
}

export function createPtyClient(connection: KelpiConnection, options: PtyClientOptions = {}): PtyClient {
    return new PtyClient(connection, options);
}
