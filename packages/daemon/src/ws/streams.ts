/**
 * PTY streams over the client-sync socket (WP2.7, `@kelpi/protocol` `ws/pty.ts`).
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
 * Resize semantics: the same three steps run again once a pane's geometry has held still for
 * `DEFAULT_RESIZE_RESYNC_MS`. A pane has two emulators — this one and the client's — and a
 * resize is what makes them disagree over identical bytes; the settled-resize replay is what
 * puts the client's VT back onto this buffer. It is server-initiated (no new wire verb: the
 * client already applies a mid-stream `replay` by resetting and rewriting) and it cannot
 * loop, because a replay provokes no resize on the client and an unchanged grid arms no
 * timer here. A viewer that does not own PTY sizing can request this same handover for its
 * session alone: its local renderer resized even though the server's geometry stayed put.
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
    WS_PANE_MODES_MESSAGE,
    decodeAckPayload,
    decodePtyFrame,
    decodeResizePayload,
    encodePtyFrame,
    type JsonObject,
    type PtyFrameType,
    type WsMouseFormat,
    type WsMouseTrackingMode,
    type WsVtModes
} from '@kelpi/protocol';

import type { PtyManager, TerminalStateService, VtModes } from '../seams.js';

/**
 * The wire form of a pane's modes. The two mouse members are optional on the seam (so every
 * existing `VtModes` literal stays valid) and mandatory on the wire, and this is where the
 * defaults are applied — "absent" means "no mouse mode", never "unknown".
 */
function wireModes(modes: VtModes): WsVtModes {
    return {
        applicationCursorKeys: modes.applicationCursorKeys,
        bracketedPaste: modes.bracketedPaste,
        mouseTracking: (modes.mouseTracking ?? 'none') as WsMouseTrackingMode,
        mouseFormat: (modes.mouseFormat ?? 'x10') as WsMouseFormat,
        kittyKeyboardFlags: modes.kittyKeyboardFlags ?? 0
    };
}

/** Per-(client, pane) bytes buffered while the client is over its window before we drop. */
export const DEFAULT_CLIENT_QUEUE_BYTES = 1024 * 1024;

/**
 * How long a pane's geometry must hold still before every attached client is reconciled to
 * the daemon's buffer — the settle window of the post-resize resync (see `resyncPane`).
 *
 * There are TWO terminal emulators per pane: this daemon's `@xterm/headless`, which owns the
 * buffer everything server-side reads, and the client's engine, fed the same bytes over the
 * wire. They resize independently, on independent schedules, and a resize is the one event
 * that makes two VTs holding identical bytes disagree — one may rewrap where the other does
 * not, and a chunk that crosses the gesture is parsed at a different width on each side.
 * Nothing used to reconcile them afterwards, so a live window drag could leave the CLIENT
 * painting a stack of stale prompt copies while `pane capture` (this side) read a clean
 * screen. The client is what the user is looking at, so the divergence is the defect.
 *
 * 150 ms sits behind the client's own resize debounce (100 ms, with a 100 ms ceiling so a
 * continuous gesture still republishes ~10×/s — `TerminalPane.tsx`), which is what turns a
 * drag storm into exactly ONE resync per settled gesture instead of one per step.
 */
export const DEFAULT_RESIZE_RESYNC_MS = 150;

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
    /**
     * Client-measured geometry is authoritative: the server-side VT first, then the PTY (the
     * ioctl is what raises SIGWINCH, so the VT must already be at the new width when the
     * shell's repaint arrives), and a settled change is followed by a resync.
     */
    resize(paneID: string, cols: number, rows: number): void;
    /** Replay this session's attached pane after a local resize; never changes server geometry. */
    requestReplay(paneID: string): void;
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
     * Settle window for the post-resize resync (`DEFAULT_RESIZE_RESYNC_MS`). Tests shorten
     * it; a negative value turns the resync off entirely.
     */
    readonly resizeResyncMs?: number | undefined;
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
    /**
     * A pane's VT modes changed: tell every client attached to it (§TERM-037).
     *
     * Targeted rather than broadcast, because a mode is per-pane stream state — a client that is
     * not rendering the pane has nothing to encode against and does not need the traffic.
     */
    modesChanged(paneID: string, modes: VtModes): void;
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
    /** A flow-control re-seed is awaiting its snapshot; a second ack must not start another. */
    reseeding: boolean;
    sentBytes: number;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

interface AsyncSnapshotCapable {
    snapshotAsync?: (paneID: string) => Promise<{ data: Uint8Array; cols: number; rows: number }>;
    has?: (paneID: string) => boolean;
}

/**
 * Does the emulator still hold this pane? `TerminalStateService` widens with `has()` and the
 * seam does not declare it, so an implementation without it answers "yes" — the same
 * duck-typing `snapshotOf` uses.
 *
 * The resync is the only caller: `snapshot()` of a pane the service has already disposed is
 * an EMPTY snapshot, and an empty replay would reset a client's screen to nothing.
 */
function paneIsKnown(term: TerminalStateService, paneID: string): boolean {
    const has = (term as TerminalStateService & AsyncSnapshotCapable).has;
    if (typeof has !== 'function') return true;
    return has.call(term, paneID);
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
    const resizeResyncMs = options.resizeResyncMs ?? DEFAULT_RESIZE_RESYNC_MS;
    const sessions = new Set<SessionImpl>();
    /** Last grid APPLIED per pane — the resync's change detector, hub-wide. */
    const grids = new Map<string, PaneGeometry>();
    /** In-flight settle timers, one per pane: a storm re-arms, it never stacks. */
    const resyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
    /**
     * Panes whose snapshot is being awaited right now, and the reconciliations that were due
     * while it was (kelpi #165).
     *
     * `resyncPane` takes every target OFF live BEFORE it awaits the snapshot, so a second
     * `resyncPane` for the same pane while that await is outstanding finds no live target,
     * returns with `targets.length === 0`, and is simply gone. Nothing re-arms a settle timer
     * except another APPLIED geometry change (`noteGeometry`), and the user's last gesture is
     * the widen, so the resize whose reconciliation was dropped is the one whose geometry the
     * screen is left showing: a steady state, which is how #165 was reported.
     *
     * The await is not short. `snapshotAsync` flushes the emulator's write chain first
     * (`term/service.ts` `flush`, a wait-for-quiescence loop over `done < issued`), so a pane
     * that keeps printing (a TUI repainting through a drag, a spinner) holds it open for as
     * long as it keeps talking, which is exactly the window a resize gesture lands in.
     *
     * So the due reconciliation is REMEMBERED rather than dropped, and run once the in-flight
     * one lands, at the scope it asked for. That scope is what the entry's `all` flag and
     * `sessions` set carry: a broadcast (an owner resize, so every attached client) must not
     * be downgraded to one session, and a single session's `requestReplay` (a non-owner's
     * local resize, which changes no server geometry) must not be upgraded into a replay that
     * resets every other client's engine for nothing.
     *
     * This cannot loop. An owed entry is only ever created by a resync that found one already
     * in flight, it is consumed once, and the run that consumes it can only be owed again by
     * yet another timer. There are exactly TWO things that arm a timer, and neither can be armed
     * by a resync: `noteGeometry`, only on a grid that CHANGED, and `SessionImpl.requestReplay`,
     * only from a client telling us its own grid moved. A replay provokes neither. It is bytes
     * into a VT, the client's `resize()` short-circuits on an unchanged grid, so it publishes no
     * new geometry for `noteGeometry` to see and asks for no new replay through `requestReplay`.
     * Every arming event is therefore externally driven, and the chain ends.
     */
    const resyncInFlight = new Set<string>();
    const resyncOwed = new Map<string, { all: boolean; sessions: Set<SessionImpl> }>();
    /**
     * Panes that have already spent their one post-failure retry for the current gesture.
     *
     * A snapshot that THROWS is the same hole with a different cause: `resyncPane` has already
     * emptied the queue and taken the targets off live on the promise that the snapshot
     * supersedes them, and its catch puts `live` back without ever sending one. The screen
     * keeps whatever the gesture left on it and, again, nothing re-arms. One retry repairs it
     * (a snapshot is the authoritative buffer, so a later one reconciles just as well as the
     * one that failed); the cap is what keeps a persistently failing snapshot from turning
     * into a 150 ms poll for the life of the pane. A new gesture gets a new retry, and BOTH
     * kinds of gesture count: `noteGeometry` for an owner resize, and `requestReplay` for a
     * non-owner's local one (which changes no server geometry, so it never reaches the former).
     *
     * The budget is PANE-scoped, not session-scoped, which is a deliberate simplification with
     * one visible consequence: a viewer's `requestReplay` landing inside an owner's retry window
     * renews the budget the owner's gesture had spent, so that pane can see three snapshot
     * attempts rather than two. Bounded the same way everything else here is, by externally
     * driven gestures, so it cannot run away; not worth a per-session map to tighten.
     */
    const resyncRetried = new Set<string>();
    let closed = false;

    const report = (error: unknown, context: string): void => {
        options.onError?.(toError(error), context);
    };

    const clearResyncTimer = (paneID: string): void => {
        const pending = resyncTimers.get(paneID);
        if (pending === undefined) return;
        clearTimeout(pending);
        resyncTimers.delete(paneID);
    };

    /**
     * A grid was applied to a pane. Arm the settle timer **only when it actually changed**.
     *
     * This is the first of the two guards that make a resync-triggered loop impossible: a
     * resize to the size the pane already has schedules nothing, so nothing a replay could
     * provoke on the client (it provokes nothing — a replay is bytes into a VT, and the
     * client's own `resize()` short-circuits on an unchanged grid) can come back round.
     *
     * The FIRST grid seen for a pane is recorded and nothing else: `attach()` sizes the pane
     * and then snapshots, so a fresh client is already looking at that geometry and a replay
     * 150 ms later would be pure traffic.
     */
    const noteGeometry = (paneID: string, cols: number, rows: number): void => {
        const previous = grids.get(paneID);
        grids.set(paneID, { cols, rows });
        if (closed || resizeResyncMs < 0) return;
        if (previous === undefined) return;
        if (previous.cols === cols && previous.rows === rows) return;
        clearResyncTimer(paneID);
        // A new gesture, so a new post-failure retry is allowed (see `resyncRetried`).
        resyncRetried.delete(paneID);
        const timer = setTimeout(() => {
            resyncTimers.delete(paneID);
            void resyncPane(paneID);
        }, resizeResyncMs);
        // A pending resync must never be the reason the daemon cannot exit.
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
            (timer as { unref: () => void }).unref();
        }
        resyncTimers.set(paneID, timer);
    };

    /** Remember a reconciliation that is due but cannot be sent yet (see `resyncOwed`). */
    const oweResync = (paneID: string, onlySession?: SessionImpl): void => {
        let owed = resyncOwed.get(paneID);
        if (owed === undefined) {
            owed = { all: false, sessions: new Set<SessionImpl>() };
            resyncOwed.set(paneID, owed);
        }
        if (onlySession === undefined) {
            // A broadcast subsumes every session-local request already owed.
            owed.all = true;
            owed.sessions.clear();
            return;
        }
        if (!owed.all) owed.sessions.add(onlySession);
    };

    /** Run whatever was owed while this pane's snapshot was in flight, at its original scope. */
    const runOwedResync = (paneID: string): void => {
        const owed = resyncOwed.get(paneID);
        if (owed === undefined) return;
        resyncOwed.delete(paneID);
        if (owed.all) {
            void resyncPane(paneID);
            return;
        }
        for (const session of owed.sessions) void resyncPane(paneID, session);
    };

    /**
     * The pane's geometry has settled: hand every attached client a fresh snapshot so its VT
     * is the daemon's VT again, whatever the two did to themselves during the gesture.
     *
     * The ordering is the attach path's, for the same reason and with the same guarantee
     * (see the module header). Each target is taken OFF live before the snapshot is
     * requested, so bytes that land while it settles are dropped from the stream rather than
     * racing ahead of the replay — and they are not lost, because `snapshotAsync()` flushes
     * the emulator's write queue in a loop (`term/service.ts` `flush`) and boot feeds the
     * terminal from the same synchronous `pty.onData` emission this hub delivers from. A
     * chunk is therefore either inside the snapshot or arrives after the pane is live again;
     * nothing in between can run, because everything after the await is microtask-only.
     *
     * One snapshot serves every targeted session. Owner resizes target all viewers; a
     * non-owner's local resize targets only that session and never changes server geometry.
     */
    const resyncPane = async (paneID: string, onlySession?: SessionImpl): Promise<void> => {
        if (closed) return;
        // This pane's snapshot is already being awaited, and every live target went off live
        // before that await: the loop below would find nothing and return, and nothing would
        // ever re-arm. Owe it instead (see `resyncOwed`).
        if (resyncInFlight.has(paneID)) {
            oweResync(paneID, onlySession);
            return;
        }
        // A pane the emulator has already disposed would snapshot EMPTY, and an empty replay
        // is not a reconciliation — it is a client screen wiped by a resize that raced a
        // close. Leave it to the detach that is already on its way.
        if (!paneIsKnown(term, paneID)) return;
        const targets: { session: SessionImpl; entry: PaneEntry }[] = [];
        for (const session of onlySession === undefined ? sessions : [onlySession]) {
            const entry = session.entryFor(paneID);
            // Skip a pane still attaching (its own replay is coming, and it is being taken
            // AFTER this resize) and one already marked for a flow-control re-seed (the ack
            // path owns that replay and will send a newer snapshot than this one).
            if (entry === undefined || !entry.live || entry.resyncPending) continue;
            targets.push({ session, entry });
        }
        if (targets.length === 0) return;

        for (const target of targets) {
            target.entry.live = false;
            // Anything queued predates the snapshot, so the snapshot supersedes it.
            target.entry.queue = [];
            target.entry.queuedBytes = 0;
        }

        let snapshot: { data: Uint8Array; cols: number; rows: number };
        resyncInFlight.add(paneID);
        try {
            snapshot = await snapshotOf(term, paneID);
        } catch (error) {
            report(error, `pty-resize-resync ${paneID}`);
            for (const target of targets) {
                if (target.session.entryFor(paneID) === target.entry) target.entry.live = true;
            }
            resyncInFlight.delete(paneID);
            // The reconciliation this call owed is still owed: the queue is gone and nothing
            // was sent, so the client is left with whatever the gesture painted. Owe it to
            // ourselves, once per gesture (see `resyncRetried`). A re-throw lands in this
            // same catch a microtask later rather than recursing, and the cap stops it there.
            if (!resyncRetried.has(paneID)) {
                resyncRetried.add(paneID);
                oweResync(paneID, onlySession);
            }
            runOwedResync(paneID);
            return;
        }
        resyncInFlight.delete(paneID);

        // Nothing below may await — same rule as `attach`.
        for (const target of targets) {
            // Identity, not presence: a detach + re-attach during the settle installs a NEW
            // entry with a replay of its own, and this stale one must not paint over it.
            if (target.session.entryFor(paneID) !== target.entry) continue;
            target.session.sendResync(paneID, target.entry, snapshot.data);
        }

        // Anything that came due while the snapshot was in flight was skipped by the guard at
        // the top of this function and is waiting here. Run it now, at the scope it asked for.
        runOwedResync(paneID);
    };

    class SessionImpl implements PaneStreamSession {
        private readonly panes = new Map<string, PaneEntry>();
        private readonly replayTimers = new Map<string, ReturnType<typeof setTimeout>>();
        private disposed = false;

        constructor(private readonly transport: PaneStreamTransport) {}

        get paneIDs(): readonly string[] {
            return [...this.panes.keys()];
        }

        has(paneID: string): boolean {
            return this.panes.has(paneID);
        }

        /** The hub's read of this session's stream state for a pane (resync targeting). */
        entryFor(paneID: string): PaneEntry | undefined {
            return this.panes.get(paneID);
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
                reseeding: false,
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
            // The pane's VT modes, right behind the replay it belongs to (§TERM-037): the client
            // encodes DEC mouse reports itself, so an attach that did not carry the modes would
            // leave a mouse-mode TUI unreportable until the app happened to re-assert DECSET.
            // After `live`, so this can never precede the replay a client renders first.
            this.sendModes(paneID);
        }

        detach(paneID: string): void {
            this.clearReplayTimer(paneID);
            this.panes.delete(paneID);
        }

        requestReplay(paneID: string): void {
            if (this.disposed || closed || resizeResyncMs < 0) return;
            const entry = this.panes.get(paneID);
            if (entry === undefined) return;
            this.clearReplayTimer(paneID);
            // A new gesture, so a new post-failure retry, exactly as `noteGeometry` does it for
            // an owner resize. Without this a non-owner NEVER renewed the budget, because its
            // local resize changes no server geometry and so never reaches `noteGeometry`: one
            // thrown snapshot and that viewer got no retry again until an owner happened to
            // resize the pane. See `resyncRetried`.
            resyncRetried.delete(paneID);
            const timer = setTimeout(() => {
                this.replayTimers.delete(paneID);
                if (this.panes.get(paneID) !== entry) return;
                // A non-owner's local grid change needs the same replay/live handover as
                // an owner resize, but only for this viewer and without resizing the PTY.
                void resyncPane(paneID, this);
            }, resizeResyncMs);
            if (typeof (timer as { unref?: () => void }).unref === 'function') {
                (timer as { unref: () => void }).unref();
            }
            this.replayTimers.set(paneID, timer);
        }

        resize(paneID: string, cols: number, rows: number): void {
            // Zero-size guard (terminal-surface.md §15.4): a transient 0×0 layout pass must
            // never reach the PTY.
            if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
            const safeCols = Math.trunc(cols);
            const safeRows = Math.trunc(rows);
            if (safeCols <= 0 || safeRows <= 0) return;
            /*
             * VT FIRST, then PTY.
             *
             * The PTY resize is the ioctl that raises SIGWINCH, and the shell starts
             * repainting for the NEW geometry the moment it lands. If the server-side VT were
             * still at the old width when that output arrived, a repaint emitted for geometry
             * N would be parsed at geometry N-1 — wrapped at the wrong column, with cursor
             * arithmetic that no longer matches the screen. Doing the VT first closes that
             * window down to the output already in flight when the ioctl fires, which is the
             * same race an in-process terminal has.
             *
             * Honest about what this ordering did NOT buy: it was measured against the
             * resize-trail defect on its own and moved the count not at all (that was the
             * emulator's reflow policy — `term/service.ts` `NO_REFLOW` — and the resync
             * below). It is here because the argument stands, not because it fixed a bug.
             */
            try {
                term.resize(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `term-resize ${paneID}`);
            }
            try {
                pty.resize(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `pty-resize ${paneID}`);
            }
            try {
                options.onGeometry?.(paneID, safeCols, safeRows);
            } catch (error) {
                report(error, `geometry ${paneID}`);
            }
            // Last, and hub-wide rather than per-session: a resize by ANY client diverges
            // EVERY client's VT from this one, so the settle timer belongs to the pane.
            noteGeometry(paneID, safeCols, safeRows);
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
                case PTY_FRAME_TYPES.inputDirect:
                    if (decoded.payload.length === 0) return;
                    try {
                        // Client-encoded mouse reports and kitty key releases: terminal-surface.md
                        // §8.2 lists both as NOT mirrored, and the manager cannot tell them from
                        // keystrokes by their bytes, so the client sends them as their own frame
                        // type and they take the un-mirrored write (issue #51).
                        pty.writeDirect(decoded.paneID, decoded.payload);
                    } catch (error) {
                        report(error, `pty-write-direct ${decoded.paneID}`);
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
            for (const paneID of this.replayTimers.keys()) this.clearReplayTimer(paneID);
            this.panes.clear();
            sessions.delete(this);
        }

        // ── internals ───────────────────────────────────────────────────────────────

        private clearReplayTimer(paneID: string): void {
            const timer = this.replayTimers.get(paneID);
            if (timer === undefined) return;
            clearTimeout(timer);
            this.replayTimers.delete(paneID);
        }

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
            this.detach(paneID);
        }

        /**
         * Re-seed this session's view of a pane from a snapshot taken a moment ago
         * (`resyncPane`). Sends the SAME `replay` frame an attach does, so the client applies
         * it through the machinery it already has: `ingest.replay()` resets the engine and
         * writes the snapshot, which is the only way to erase a divergence rather than paint
         * over it. No JSON notice rides with it — a notice that arrived without its replay
         * (a snapshot that threw) would leave the client's ingest holding live bytes forever.
         */
        sendResync(paneID: string, entry: PaneEntry, data: Uint8Array): void {
            if (this.disposed || closed) return;
            // The client zeroes its own unacked/pending counters the moment a replay lands
            // (`client/src/connection/pty.ts`), which drops the acks it had not flushed yet.
            // Zero ours in the same breath or those bytes stay charged against this client's
            // window for the life of the pane — and enough of them stall it.
            entry.unacked = 0;
            this.send(paneID, entry, PTY_FRAME_TYPES.replay, data);
            entry.live = true;
        }

        /** Push this pane's current VT modes, if this session is attached to it. */
        sendModes(paneID: string, modes?: VtModes | undefined): void {
            if (this.disposed || !this.panes.has(paneID)) return;
            let current = modes;
            if (current === undefined) {
                try {
                    current = term.modes(paneID);
                } catch (error) {
                    report(error, `pane-modes ${paneID}`);
                    return;
                }
            }
            try {
                this.transport.sendJson({
                    type: WS_PANE_MODES_MESSAGE,
                    paneID,
                    // `sendJson` takes a `JsonObject`, and an interface has no index signature;
                    // the cast is the shape assertion, not a widening.
                    modes: { ...wireModes(current) } as unknown as JsonObject
                });
            } catch (error) {
                report(error, `pane-modes-send ${paneID}`);
            }
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
                void this.reseed(paneID, entry);
                return;
            }

            while (entry.queue.length > 0 && entry.unacked < windowBytes) {
                const chunk = entry.queue.shift() as Uint8Array;
                entry.queuedBytes -= chunk.length;
                this.send(paneID, entry, PTY_FRAME_TYPES.output, chunk);
            }
            if (entry.queue.length === 0) entry.queuedBytes = 0;
        }

        /**
         * Re-seed a client whose backlog was dropped (`enqueue`), once it is back inside its
         * window.
         *
         * Two things this used to get wrong, both of them byte-level (N23):
         *
         *   - **It read the SYNC snapshot.** `feed()` only queues — xterm parses asynchronously
         *     — so `snapshot()` describes everything parsed *so far* and silently omits chunks
         *     that were fed a moment ago. Those chunks were also dropped from this client's
         *     queue, so they were gone from its screen for the life of the pane. The attach and
         *     settled-resize paths both take the FLUSHING snapshot for exactly this reason; this
         *     one now does too. Nothing is racing ahead of it while it settles: `resyncPending`
         *     is still set, so `deliver` keeps enqueueing-and-dropping, and every one of those
         *     bytes is inside the snapshot being taken.
         *   - **It left `unacked` charged.** The client zeroes its own counters the instant a
         *     replay lands (`client/src/connection/pty.ts`), dropping any ack it had not flushed
         *     — so the bytes it was holding stayed charged against its window here, forever, and
         *     enough of them stall the pane. `sendResync` has zeroed them since it was written;
         *     this path had the same bug and not the same fix.
         *
         * Re-entrancy: acks keep arriving while the snapshot settles, so the flag says one
         * re-seed is already in flight and the second ack does nothing.
         */
        private async reseed(paneID: string, entry: PaneEntry): Promise<void> {
            if (entry.reseeding || this.disposed || closed) return;
            // A pane the emulator has already disposed snapshots EMPTY, and an empty replay is
            // not a re-seed — it is a client screen wiped by a race with a close (`resyncPane`
            // makes the same check for the same reason). Leave it to the detach on its way.
            if (!paneIsKnown(term, paneID)) return;
            entry.reseeding = true;
            let snapshot: { data: Uint8Array; cols: number; rows: number };
            try {
                snapshot = await snapshotOf(term, paneID);
            } catch (error) {
                report(error, `pty-resync ${paneID}`);
                entry.reseeding = false;
                return;
            }
            // Nothing below may await — the same rule `attach` and `resyncPane` follow, and what
            // makes the replay/live handover gapless.
            entry.reseeding = false;
            if (this.disposed || closed) return;
            // Identity, not presence: a detach + re-attach during the settle installs a NEW entry
            // with a replay of its own, and this stale one must not paint over it.
            if (this.panes.get(paneID) !== entry) return;
            entry.resyncPending = false;
            entry.queue = [];
            entry.queuedBytes = 0;
            entry.unacked = 0;
            // Invalidate the old client parser generation and byte credit BEFORE replay.
            // A notice after replay would erase its fresh credit and make an acknowledged
            // renderer discard the snapshot while waiting for a replay that never follows.
            this.transport.sendJson({
                type: PTY_RESYNC_MESSAGE_TYPE,
                paneID,
                reason: 'flow-control-drop'
            });
            this.send(paneID, entry, PTY_FRAME_TYPES.replay, snapshot.data);
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
        // The process is gone: a settle timer would snapshot a terminal that is being torn
        // down, and the remembered grid would make the KELPIT process in this pane id look
        // like it had never been resized.
        clearResyncTimer(paneID);
        grids.delete(paneID);
        // The same reasoning for the rest of the per-pane resync bookkeeping: a retry budget
        // and an owed reconciliation for a dead pane are a leak and a pointless replay. NOT
        // `resyncInFlight`: that one means "a snapshot is being awaited", which is still true
        // and is cleared by the resync that owns it (clearing it here would let a second
        // resync start on top of the first).
        resyncRetried.delete(paneID);
        resyncOwed.delete(paneID);
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
        modesChanged(paneID, modes) {
            if (closed) return;
            for (const session of sessions) session.sendModes(paneID, modes);
        },
        close() {
            if (closed) return;
            closed = true;
            offData();
            offExit();
            for (const paneID of [...resyncTimers.keys()]) clearResyncTimer(paneID);
            grids.clear();
            resyncInFlight.clear();
            resyncOwed.clear();
            resyncRetried.clear();
            for (const session of [...sessions]) session.close();
            sessions.clear();
        }
    };
}
