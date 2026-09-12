import type { TerminalAction, TerminalFrame, TerminalModes, TerminalPresentation } from '../../../plugin-sdk/terminal';
import type { PtyStreamHandle } from '../connection/pty';
import type { TerminalPtyApi } from '../terminal/TerminalPane';

export type { TerminalAction, TerminalFrame, TerminalPresentation } from '../../../plugin-sdk/terminal';

export const TERMINAL_SCOPE_LIMITS = {
    replayBytes: 16 * 1024 * 1024,
    liveBytes: 1024 * 1024,
    frames: 2048,
    inputBytes: 128 * 1024,
    selectionBytes: 256 * 1024,
    actions: 16,
    attachments: 128,
    frameTimeoutMs: 30_000,
    actionTimeoutMs: 5_000,
} as const;

export type TerminalHostMessage =
    | { readonly type: 'terminal-frame'; readonly session: string; readonly generation: number; readonly sequence: number; readonly frame: TerminalFrame }
    | { readonly type: 'terminal-action'; readonly session: string; readonly id: string; readonly action: TerminalAction };

export interface TerminalScopeOptions {
    readonly paneID: string;
    readonly pty: TerminalPtyApi;
    readonly presentation: TerminalPresentation;
    readonly send: (message: TerminalHostMessage) => void;
    readonly fail: (error: Error) => void;
    readonly onResize?: ((cols: number, rows: number) => void) | undefined;
    readonly frameTimeoutMs?: number | undefined;
    readonly actionTimeoutMs?: number | undefined;
}

export interface TerminalScope {
    attach(args: unknown): { readonly session: string; readonly paneID: string };
    receive(data: unknown): boolean;
    update(presentation: TerminalPresentation): void;
    action(action: TerminalAction): Promise<unknown>;
    /** Host line-editing actions use the renderer's mirrored input stream. */
    write(data: string): void;
    readonly attached: boolean;
    readonly cellHeight: number;
    dispose(): void;
}

interface Delivery {
    readonly generation: number;
    readonly frame: TerminalFrame;
    readonly credit: number;
}
interface PendingAction {
    readonly action: TerminalAction;
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function count(value: unknown, max = 65535): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}
function bytes(frame: TerminalFrame): number { return frame.type === 'output' || frame.type === 'replay' ? frame.data.byteLength : 0; }
const encoder = new TextEncoder();

/**
 * A selected terminal view's one renderer attachment, over its existing window connection.
 * The view receives one frame at a time. Supersession lets in-flight and queued output
 * finish before the newest replay: snapshots cannot reproduce a program's device queries.
 * Old generations never earn new PTY credit, including their retained parser checkpoints.
 * Bounds fail the whole view so its bundled fallback can attach to an authoritative screen.
 */
export function createTerminalScope(options: TerminalScopeOptions): TerminalScope {
    let disposed = false;
    let presentation = options.presentation;
    let presentationKey = JSON.stringify(presentation);
    let session: string | undefined;
    let stream: PtyStreamHandle | undefined;
    let geometry = { cols: 80, rows: 24 };
    /**
     * #166: the grid the LAST replay stated, or null when no replay has stated one.
     *
     * Only a positive grid overwrites it, exactly as the bundled pane's `replayGridRef` does: a
     * daemon that states nothing (pre-#166) says "keep doing what you did before", not "forget
     * what the last snapshot was serialised at". It exists for one question, asked once per
     * ownership change: did a replay land at a grid this renderer is not at?
     */
    let lastReplayGrid: { cols: number; rows: number } | null = null;
    /** Size control was gained while hidden; the first reveal's resize carries the claim. */
    let pendingClaim = false;
    let cellHeight = 16;
    let modes: TerminalModes | undefined;
    let generation = 1, sequence = 0, nextAction = 0;
    let queue: Delivery[] = [];
    let inFlight: (Delivery & { readonly sequence: number }) | undefined;
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    let drainQueued = false;
    let awaitingReplay = true;
    let resyncReason: string | undefined;
    const usedSessions = new Set<string>();
    const actions = new Map<string, PendingAction>();

    const detach = (): void => {
        session = undefined;
        queue = [];
        inFlight = undefined;
        if (frameTimer !== undefined) clearTimeout(frameTimer);
        frameTimer = undefined;
        stream?.unsubscribe();
        stream = undefined;
        lastReplayGrid = null;
        pendingClaim = false;
        for (const entry of actions.values()) { clearTimeout(entry.timer); entry.reject(new Error('Terminal renderer attachment ended.')); }
        actions.clear();
        cellHeight = 16;
        modes = undefined;
    };
    const fail = (error: Error): void => {
        if (disposed) return;
        disposed = true;
        detach();
        options.fail(error);
    };
    const post = (message: TerminalHostMessage): void => {
        try { options.send(message); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    };
    const drain = (): void => {
        if (disposed || !session || inFlight || !queue.length) return;
        const entry = queue.shift()!;
        inFlight = { ...entry, sequence: ++sequence };
        frameTimer = setTimeout(() => fail(new Error('Terminal renderer did not consume output in time.')), options.frameTimeoutMs ?? TERMINAL_SCOPE_LIMITS.frameTimeoutMs);
        post({ type: 'terminal-frame', session, generation: entry.generation, sequence, frame: entry.frame });
    };
    const scheduleDrain = (): void => {
        if (drainQueued) return;
        drainQueued = true;
        // attach's RPC reply can be sent before a synchronous fake/native replay is delivered.
        queueMicrotask(() => { drainQueued = false; drain(); });
    };
    const enqueue = (frame: TerminalFrame, credit = 0): void => {
        if (disposed || !session) return;
        if (frame.type === 'replay' && frame.data.byteLength > TERMINAL_SCOPE_LIMITS.replayBytes) {
            fail(new Error('Terminal replay exceeds the renderer limit.')); return;
        }
        if (frame.type === 'presentation') {
            const lastOutput = queue.findLastIndex(entry => entry.frame.type === 'output');
            queue = queue.filter((entry, index) => index <= lastOutput || entry.frame.type !== 'presentation');
        }
        queue.push({ generation, frame, credit });
        // Bound the whole replay backlog to two maximum-size snapshots, even when live bytes
        // depend on several smaller checkpoints. Coalesce checkpoints without live successors.
        // Live output has its own tighter bound and is never truncated or spliced.
        const pending = [...queue, ...(inFlight ? [inFlight] : [])];
        const liveBytes = pending.reduce((total, entry) => total + (entry.frame.type === 'output' ? bytes(entry.frame) : 0), 0);
        const replayBytes = pending.reduce((total, entry) => total + (entry.frame.type === 'replay' ? bytes(entry.frame) : 0), 0);
        if (replayBytes > 2 * TERMINAL_SCOPE_LIMITS.replayBytes) {
            fail(new Error('Terminal renderer replay backlog exceeded its limit.')); return;
        }
        if (queue.length + (inFlight ? 1 : 0) > TERMINAL_SCOPE_LIMITS.frames || liveBytes > TERMINAL_SCOPE_LIMITS.liveBytes) {
            fail(new Error('Terminal renderer output backlog exceeded its limit.')); return;
        }
        scheduleDrain();
    };
    const supersede = (): void => {
        generation += 1;
        // A live device query must still reach the parser, including when it spans frames.
        // Preserve its preceding replay/modes too: they establish the parser state used to
        // answer it. Only the suffix without live successors can be replaced by a snapshot.
        const lastOutput = queue.findLastIndex(entry => entry.frame.type === 'output');
        queue = queue.slice(0, lastOutput + 1);
        // Keep inFlight and its timeout. All retained generations complete with zero credit.
        enqueue({ type: 'presentation', value: presentation });
    };
    const write = (data: Uint8Array | string, direct = false, response = false): void => {
        if (disposed || !session || (!presentation.visible && !response)) return;
        const payload = typeof data === 'string' ? encoder.encode(data) : data;
        if (payload.byteLength > TERMINAL_SCOPE_LIMITS.inputBytes) { fail(new Error('Terminal input exceeds its limit.')); return; }
        if (direct) stream?.writeDirect(payload); else stream?.write(payload);
    };

    return {
        attach(args) {
            if (disposed) throw new Error('Terminal renderer scope is disposed.');
            if (session !== undefined) throw new Error('Terminal renderer is already attached.');
            const value = object(args);
            const id = value?.['session'];
            if (typeof id !== 'string' || !id || id.length > 160 || usedSessions.has(id) ||
                !count(value?.['cols']) || !count(value?.['rows'])) throw new Error('Invalid terminal attachment.');
            if (usedSessions.size >= TERMINAL_SCOPE_LIMITS.attachments) throw new Error('Too many terminal attachments for this view.');
            usedSessions.add(id);
            session = id;
            geometry = { cols: value['cols'], rows: value['rows'] };
            generation += 1;
            awaitingReplay = true;
            resyncReason = undefined;
            enqueue({ type: 'presentation', value: presentation });
            try {
                const attachedStream = options.pty.subscribe(options.paneID, {
                    exclusive: true,
                    autoAck: false,
                    cols: geometry.cols,
                    rows: geometry.rows,
                    getGeometry: () => presentation.visible ? geometry : undefined,
                    onReplay(data, grid) {
                        if (disposed || session !== id) return;
                        supersede();
                        if (resyncReason !== undefined) enqueue({ type: 'resync', reason: resyncReason });
                        resyncReason = undefined;
                        awaitingReplay = false;
                        // #166: the grid the daemon serialised this snapshot at rides ON the
                        // replay frame, so the renderer cannot apply one to the wrong bytes.
                        // It is metadata: no output credit is charged for it, and the frame's
                        // acknowledgement still grants exactly the byte count below.
                        const stated = grid !== undefined && count(grid.cols) && count(grid.rows) ? { cols: grid.cols, rows: grid.rows } : null;
                        if (stated !== null) lastReplayGrid = stated;
                        enqueue({ type: 'replay', data: data.slice(), grid: stated }, data.byteLength);
                        // Snapshot supersession can discard an undelivered mode update.
                        // Reapply the latest authoritative state after the parser resets.
                        if (modes) enqueue({ type: 'modes', modes });
                    },
                    onData(data) {
                        if (disposed || session !== id || awaitingReplay) return;
                        enqueue({ type: 'output', data: data.slice() }, data.byteLength);
                    },
                    onResync(reason) {
                        if (disposed || session !== id) return;
                        awaitingReplay = true;
                        resyncReason = reason;
                        supersede();
                        enqueue({ type: 'resync', reason });
                    },
                    onModes(next) { if (session === id) { modes = next; enqueue({ type: 'modes', modes }); } },
                    onExit(exitCode, signal) { if (session === id) enqueue({ type: 'exit', exitCode, ...(signal === undefined ? {} : { signal }) }); },
                });
                // A synchronous subscription callback may already have failed the scope.
                if (disposed || session !== id) attachedStream.unsubscribe(); else stream = attachedStream;
            } catch (error) { detach(); throw error; }
            if (presentation.visible) options.onResize?.(geometry.cols, geometry.rows);
            return { session: id, paneID: options.paneID };
        },
        receive(data) {
            const value = object(data);
            const type = value?.['type'];
            if (typeof type !== 'string' || !['terminal-ack', 'terminal-input', 'terminal-resize', 'terminal-detach', 'terminal-action-reply', 'terminal-metrics'].includes(type)) return false;
            if (disposed || session === undefined || value?.['session'] !== session) return true;
            if (type === 'terminal-ack') {
                if (!inFlight || value['generation'] !== inFlight.generation || value['sequence'] !== inFlight.sequence) return true;
                const done = inFlight;
                inFlight = undefined;
                if (frameTimer !== undefined) clearTimeout(frameTimer);
                frameTimer = undefined;
                if (done.generation === generation && done.credit > 0) stream?.ack(done.credit);
                scheduleDrain();
            } else if (type === 'terminal-input') {
                const response = value['response'] === true;
                if (response) {
                    // Parsers must answer live device queries even off screen. Bind that
                    // exception to the frame still being consumed. An in-flight output
                    // query still needs its answer after a visual replay supersedes it;
                    // snapshots do not reproduce DA/DSR requests. Its ACK gets no new credit.
                    // Superseded replay callbacks and completed callbacks cannot reply.
                    if (value['direct'] !== true || !inFlight ||
                        value['generation'] !== inFlight.generation || value['sequence'] !== inFlight.sequence ||
                        (inFlight.generation !== generation && inFlight.frame.type !== 'output') ||
                        (inFlight.frame.type !== 'replay' && inFlight.frame.type !== 'output')) return true;
                } else if (!presentation.visible) return true;
                const payload = value['data'];
                if (!ArrayBuffer.isView(payload) || Object.prototype.toString.call(payload) !== '[object Uint8Array]' || typeof value['direct'] !== 'boolean' ||
                    (value['response'] !== undefined && typeof value['response'] !== 'boolean')) { fail(new Error('Invalid terminal input.')); return true; }
                write(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), value['direct'], response);
            } else if (type === 'terminal-resize') {
                if (!presentation.visible) return true;
                if (!count(value['cols']) || !count(value['rows'])) { fail(new Error('Invalid terminal geometry.')); return true; }
                geometry = { cols: value['cols'], rows: value['rows'] };
                stream?.resize(geometry.cols, geometry.rows);
                options.onResize?.(geometry.cols, geometry.rows);
            } else if (type === 'terminal-metrics') {
                const height = value['cellHeight'];
                if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > 512) { fail(new Error('Invalid terminal cell height.')); return true; }
                cellHeight = height;
            } else if (type === 'terminal-detach') detach();
            else {
                const id = value['id'];
                if (typeof id !== 'string') return true;
                const pending = actions.get(id);
                if (!pending) return true;
                actions.delete(id); clearTimeout(pending.timer);
                if (typeof value['error'] === 'string') { pending.reject(new Error(value['error'].slice(0, 4096))); return true; }
                const result = value['result'];
                const valid = pending.action.type === 'selection'
                    ? typeof result === 'string' && encoder.encode(result).byteLength <= TERMINAL_SCOPE_LIMITS.selectionBytes
                    : pending.action.type === 'dispatchKey' || pending.action.type === 'paste' ? typeof result === 'boolean' : result === null;
                if (valid) pending.resolve(result); else pending.reject(new Error('Invalid terminal action result.'));
            }
            return true;
        },
        /**
         * #166: size control changing hands is the host's repair, not the renderer's.
         *
         * A renderer is told (`presentation.ownsSize`) and mirrors what it is sent; the one
         * forced PTY report each hand-off needs is issued here, from the transition itself, so
         * it happens once and cannot become a poll. `force` re-sends a grid the daemon already
         * has, which its short circuit would otherwise swallow.
         *
         * GAINED: the claim has to reach the PTY even though this box has not moved. Hidden, it
         * cannot: a hidden view claims no geometry, so the claim waits for the first reveal,
         * whose ordinary resize carries it.
         *
         * LOST: normally nothing. The taker's grid change arms a settled-resize resync whose
         * replay states the new grid. The exception is a replay that arrived BEFORE this
         * presentation: the last stated grid is then one this renderer is not at, nothing else
         * will move it, and one forced report asks the daemon (which reads a forced report from
         * a non-owner as "re-seed me") for the snapshot that re-states the grid. A hidden view
         * needs neither: it reports nothing, and its reveal resizes anyway.
         */
        update(next) {
            if (disposed) return;
            const key = JSON.stringify(next);
            if (key === presentationKey) return;
            const becameVisible = !presentation.visible && next.visible;
            const owned = presentation.ownsSize !== false, owns = next.ownsSize !== false;
            presentation = next; presentationKey = key;
            enqueue({ type: 'presentation', value: presentation });
            if (owns !== owned) {
                pendingClaim = false;
                // A reveal in the same update carries the claim on its own resize below,
                // so a hand-off never costs two reports.
                if (owns && (!next.visible || becameVisible)) pendingClaim = true;
                else if (owns) stream?.resize(geometry.cols, geometry.rows, true);
                else if (next.visible && lastReplayGrid !== null &&
                    (lastReplayGrid.cols !== geometry.cols || lastReplayGrid.rows !== geometry.rows)) {
                    stream?.resize(geometry.cols, geometry.rows, true);
                }
            }
            if (becameVisible) { const claim = pendingClaim; pendingClaim = false; stream?.resize(geometry.cols, geometry.rows, claim); }
        },
        action(action) {
            if (disposed || !session) return Promise.reject(new Error('Terminal renderer is not attached.'));
            if (actions.size >= TERMINAL_SCOPE_LIMITS.actions) return Promise.reject(new Error('Too many pending terminal actions.'));
            if (!presentation.visible && action.type !== 'selection' && action.type !== 'blur' && action.type !== 'hideKeyboard') return Promise.reject(new Error('Terminal renderer is hidden.'));
            if (action.type === 'paste' && encoder.encode(action.text).byteLength > TERMINAL_SCOPE_LIMITS.inputBytes) return Promise.reject(new Error('Terminal paste exceeds its limit.'));
            const id = String(++nextAction);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { actions.delete(id); reject(new Error('Terminal renderer action timed out.')); }, options.actionTimeoutMs ?? TERMINAL_SCOPE_LIMITS.actionTimeoutMs);
                actions.set(id, { action, resolve, reject, timer });
                post({ type: 'terminal-action', session: session!, id, action });
            });
        },
        write,
        get attached() { return !disposed && session !== undefined; },
        get cellHeight() { return cellHeight; },
        dispose() { if (!disposed) { disposed = true; detach(); } },
    };
}
