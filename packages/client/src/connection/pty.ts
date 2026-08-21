/**
 * Per-pane PTY streams, multiplexed over the one socket (WP3.1).
 *
 * The binary channel is `[type][16-byte paneID][payload]` (`@nex/protocol` `ws/pty.ts`), so a
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
    encodeAckPayload,
    encodePtyFrame,
    type PtyFrameType,
    type WsVtModes
} from '@nex/protocol';

import type { NexConnection } from './socket';

export interface PtySubscription {
    /** Attach replay (the pane's screen as of attach). Falls back to `onData` when absent. */
    readonly onReplay?: ((data: Uint8Array) => void) | undefined;
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
    /** Keyboard / paste bytes upstream. */
    write(data: Uint8Array | string): void;
    /** Client-measured geometry; the daemon resizes the PTY and its server-side VT. */
    resize(cols: number, rows: number): void;
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
    cols: number;
    rows: number;
    attached: boolean;
    /** Delivered-but-unacked bytes (mirrors the daemon's own counter for this pane). */
    unacked: number;
    pendingAck: number;
    ackTimer: ReturnType<typeof setTimeout> | null;
    /** Last `pane-modes` for this pane; replayed to a subscriber that joins later. */
    modes: WsVtModes | null;
}

const encoder = new TextEncoder();

export class PtyClient {
    private readonly panes = new Map<string, PaneEntry>();
    private readonly unsubscribers: (() => void)[] = [];
    private readonly ackThreshold: number;
    private readonly ackIntervalMs: number;
    private disposed = false;

    constructor(
        private readonly connection: NexConnection,
        private readonly options: PtyClientOptions = {}
    ) {
        this.ackThreshold = Math.max(1, options.ackThresholdBytes ?? Math.floor(PTY_FLOW_CONTROL_WINDOW_BYTES / 4));
        this.ackIntervalMs = Math.max(0, options.ackIntervalMs ?? 16);

        this.unsubscribers.push(
            connection.on('frame', (frame) => {
                const entry = this.panes.get(frame.paneID);
                if (entry === undefined) return;
                if (frame.type === PTY_FRAME_TYPES.replay) {
                    this.deliver(entry, frame.paneID, frame.payload, true);
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
        let entry = this.panes.get(paneID);
        const fresh = entry === undefined;
        if (entry === undefined) {
            entry = {
                subscriptions: new Set<PtySubscription>(),
                cols: subscription.cols ?? 80,
                rows: subscription.rows ?? 24,
                attached: false,
                unacked: 0,
                pendingAck: 0,
                ackTimer: null,
                modes: null
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
        return {
            paneID,
            write(data: Uint8Array | string): void {
                client.write(paneID, data);
            },
            resize(cols: number, rows: number): void {
                client.resize(paneID, cols, rows);
            },
            ack(bytes: number): void {
                client.queueAck(paneID, target, bytes);
            },
            get unacked(): number {
                return target.unacked;
            },
            unsubscribe(): void {
                client.unsubscribe(paneID, subscription);
            }
        };
    }

    write(paneID: string, data: Uint8Array | string): void {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        if (bytes.length === 0) return;
        this.sendFrame(PTY_FRAME_TYPES.input, paneID, bytes);
    }

    resize(paneID: string, cols: number, rows: number): void {
        const entry = this.panes.get(paneID);
        // A transient 0×0 measurement pass must never reach the PTY (terminal-surface §15.4);
        // the daemon guards too, but sending it would still stomp the stored geometry.
        if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
        const safeCols = Math.trunc(cols);
        const safeRows = Math.trunc(rows);
        if (safeCols <= 0 || safeRows <= 0) return;
        if (entry !== undefined) {
            if (entry.cols === safeCols && entry.rows === safeRows) return;
            entry.cols = safeCols;
            entry.rows = safeRows;
        }
        this.sendResize(paneID, safeCols, safeRows);
    }

    unsubscribe(paneID: string, subscription: PtySubscription): void {
        const entry = this.panes.get(paneID);
        if (entry === undefined) return;
        entry.subscriptions.delete(subscription);
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
        this.connection.send({ type: 'attach-pane', paneID, cols: entry.cols, rows: entry.rows });
    }

    private reattachAll(): void {
        for (const [paneID, entry] of this.panes.entries()) {
            entry.unacked = 0;
            entry.pendingAck = 0;
            this.clearAckTimer(entry);
            entry.attached = true;
            this.connection.send({ type: 'attach-pane', paneID, cols: entry.cols, rows: entry.rows });
        }
    }

    private sendResize(paneID: string, cols: number, rows: number): void {
        // The JSON form works before the attach settles (the daemon resizes PTY + VT without
        // consulting the stream table), which the binary `resize` frame does not.
        this.connection.send({ type: 'resize-pane', paneID, cols, rows });
    }

    private deliver(entry: PaneEntry, paneID: string, payload: Uint8Array, replay: boolean): void {
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
                if (replay && subscription.onReplay !== undefined) subscription.onReplay(payload);
                else subscription.onData(payload);
            } catch (error) {
                this.report(error, `pty-deliver ${paneID}`);
            }
        }
        if (autoAck) this.queueAck(paneID, entry, payload.length);
    }

    private queueAck(paneID: string, entry: PaneEntry, bytes: number): void {
        if (bytes <= 0) return;
        entry.pendingAck += bytes;
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

export function createPtyClient(connection: NexConnection, options: PtyClientOptions = {}): PtyClient {
    return new PtyClient(connection, options);
}
