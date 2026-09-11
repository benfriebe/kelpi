import { PTY_FRAME_TYPES, decodePtyFrame, decodeResizePayload, encodeAckPayload, encodePtyFrame, encodeResizePayload } from '@kelpi/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPaneStreamHub, type PaneStreamHub, type PaneStreamSession } from './streams.js';
import { PANE_A, PANE_B, bytes, recordingTransport, stubPty, stubTerm, textOf, type RecordedTransport, type StubPty, type StubTerm } from './testing.js';

interface Harness {
    readonly hub: PaneStreamHub;
    readonly pty: StubPty;
    readonly term: StubTerm;
    readonly transport: RecordedTransport;
    readonly session: PaneStreamSession;
    /** Every grid reported to boot's geometry cache, in order. */
    readonly geometry: { paneID: string; cols: number; rows: number }[];
    /** Decoded frames the client would have received, in order. */
    frames(): { type: number; paneID: string; text: string }[];
}

function harness(
    options: { windowBytes?: number; maxQueuedBytes?: number; resizeResyncMs?: number } = {}
): Harness {
    const pty = stubPty();
    const term = stubTerm();
    const transport = recordingTransport();
    const geometry: { paneID: string; cols: number; rows: number }[] = [];
    const hub = createPaneStreamHub({
        pty: pty.manager,
        term: term.service,
        onGeometry: (paneID, cols, rows) => geometry.push({ paneID, cols, rows }),
        ...(options.windowBytes !== undefined ? { windowBytes: options.windowBytes } : {}),
        ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {}),
        ...(options.resizeResyncMs !== undefined ? { resizeResyncMs: options.resizeResyncMs } : {})
    });
    const session = hub.createSession(transport);
    return {
        hub,
        pty,
        term,
        transport,
        session,
        geometry,
        frames: () =>
            transport.frames.map((frame) => {
                const decoded = decodePtyFrame(frame);
                if (decoded === undefined) throw new Error('undecodable frame');
                // #166: a `replayGrid` carries two uint16s, not text. Rendered as `CxR` so the
                // expectations below read as what they are — the grid the replay behind it was
                // serialised at — instead of as four bytes of mojibake.
                if (decoded.type === (PTY_FRAME_TYPES.replayGrid as number)) {
                    const grid = decodeResizePayload(decoded.payload);
                    return {
                        type: decoded.type as number,
                        paneID: decoded.paneID,
                        text: grid === undefined ? 'undecodable' : `${String(grid.cols)}x${String(grid.rows)}`
                    };
                }
                return { type: decoded.type as number, paneID: decoded.paneID, text: textOf(decoded.payload) };
            })
    };
}

/** One turn of the event loop: long enough for an awaited snapshot to land. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('attach → replay → live', () => {
    it('replays the terminal snapshot, then streams live output', async () => {
        const h = harness();
        h.term.setSnapshot(PANE_A, 'scrollback');

        await h.session.attach(PANE_A, { cols: 100, rows: 30 });
        h.pty.emit(PANE_A, 'live-1');
        h.pty.emit(PANE_A, 'live-2');

        expect(h.frames()).toEqual([
            // #166: every replay is preceded by the grid it was serialised at, for every client.
            // This one owns sizing, so the grid is the one it just asked for; a non-owner gets
            // the same frame carrying the OWNER's grid, which is the whole point.
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '100x30' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'scrollback' },
            { type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'live-1' },
            { type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'live-2' }
        ]);
    });

    it('applies the client-measured geometry before snapshotting', async () => {
        const h = harness();
        await h.session.attach(PANE_A, { cols: 120, rows: 40 });
        expect(h.pty.resizes).toEqual([{ paneID: PANE_A, cols: 120, rows: 40 }]);
        expect(h.term.resizes).toEqual([{ paneID: PANE_A, cols: 120, rows: 40 }]);
    });

    it('reports every applied grid so the KELPIT spawn of the pane starts there', async () => {
        // Without this the pane is re-born at 80×24 on the next daemon boot and prints its
        // first prompt at a width nothing will ever render it at (`pty/geometry.ts`).
        const h = harness();
        await h.session.attach(PANE_A, { cols: 120, rows: 40 });
        h.session.resize(PANE_A, 169, 47);

        expect(h.geometry).toEqual([
            { paneID: PANE_A, cols: 120, rows: 40 },
            { paneID: PANE_A, cols: 169, rows: 47 }
        ]);
    });

    it('never reports a zero-size layout pass', async () => {
        const h = harness();
        await h.session.attach(PANE_A, { cols: 0, rows: 0 });
        h.session.resize(PANE_A, Number.NaN, 40);

        expect(h.geometry).toEqual([]);
    });

    it('never duplicates bytes that land while the snapshot is settling', async () => {
        const h = harness();
        h.term.asyncSnapshots = true;

        const attaching = h.session.attach(PANE_A);
        // Output that arrives mid-attach is fed to the terminal state (boot's job) and is
        // therefore part of the snapshot the attach is about to take.
        h.pty.emit(PANE_A, 'during');
        h.term.service.feed(PANE_A, bytes('during'));
        await attaching;
        h.pty.emit(PANE_A, 'after');

        expect(h.frames()).toEqual([
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '80x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'during' },
            { type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'after' }
        ]);
    });

    it('only streams panes this client attached', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_B, 'not mine');
        expect(h.frames().filter((frame) => frame.paneID === PANE_B)).toEqual([]);
    });

    it('re-attaching an attached pane updates geometry without a second replay', async () => {
        const h = harness();
        h.term.setSnapshot(PANE_A, 'x');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        await h.session.attach(PANE_A, { cols: 90, rows: 25 });
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.replay)).toHaveLength(1);
        expect(h.pty.resizes.at(-1)).toEqual({ paneID: PANE_A, cols: 90, rows: 25 });
    });

    it('stops delivering after detach and reports pane exit', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.detach(PANE_A);
        h.pty.emit(PANE_A, 'ignored');
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.output)).toEqual([]);

        await h.session.attach(PANE_B);
        h.pty.exit(PANE_B, 3);
        expect(h.transport.ofType('pane-exit')).toEqual([{ type: 'pane-exit', paneID: PANE_B, exitCode: 3 }]);
        expect(h.session.paneIDs).toEqual([]);
    });
});

describe('client → daemon frames', () => {
    it('writes input bytes to the PTY (sync-group mirroring lives in the manager)', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.input, PANE_A, bytes('ls\r')) as Uint8Array);
        expect(h.pty.writes).toEqual([{ paneID: PANE_A, data: 'ls\r' }]);
        expect(h.pty.directWrites).toEqual([]);
    });

    it('writes inputDirect bytes un-mirrored: mouse reports and kitty releases stay in their pane (#51)', async () => {
        // terminal-surface.md §8.2 lists mouse input and key releases as NOT mirrored; the
        // manager mirrors whatever `write` receives, so the frame type must pick `writeDirect`.
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.inputDirect, PANE_A, bytes('\x1b[<0;3;4M')) as Uint8Array);
        expect(h.pty.directWrites).toEqual([{ paneID: PANE_A, data: '\x1b[<0;3;4M' }]);
        expect(h.pty.writes).toEqual([{ paneID: PANE_A, data: '\x1b[<0;3;4M' }]);
        // An empty payload is dropped, exactly as an empty `input` frame is.
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.inputDirect, PANE_A) as Uint8Array);
        expect(h.pty.directWrites).toHaveLength(1);
    });

    it('applies resize frames to the PTY and the terminal state', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.resize, PANE_A, encodeResizePayload(132, 43)) as Uint8Array);
        expect(h.pty.resizes.at(-1)).toEqual({ paneID: PANE_A, cols: 132, rows: 43 });
        expect(h.term.resizes.at(-1)).toEqual({ paneID: PANE_A, cols: 132, rows: 43 });
    });

    it('drops zero-size resizes (transient layout passes)', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.resize, PANE_A, encodeResizePayload(0, 0)) as Uint8Array);
        expect(h.pty.resizes).toEqual([]);
        expect(h.term.resizes).toEqual([]);
    });

    it('ignores frames for panes the client never attached', () => {
        const h = harness();
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.input, PANE_A, bytes('rm -rf /')) as Uint8Array);
        expect(h.pty.writes).toEqual([]);
    });

    it('ignores truncated and unknown frames', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.handleFrame(new Uint8Array([0x02, 0x01]));
        h.session.handleFrame(new Uint8Array(20).fill(0x7f));
        expect(h.pty.writes).toEqual([]);
    });
});

describe('ack-based flow control', () => {
    const ack = (session: PaneStreamSession, paneID: string, count: number): void => {
        session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.ack, paneID, encodeAckPayload(count)) as Uint8Array);
    };

    it('pauses a pane whose client stops acking, and resumes on ack', async () => {
        const h = harness({ windowBytes: 8 });
        await h.session.attach(PANE_A);

        h.pty.emit(PANE_A, '12345678'); // fills the window exactly
        h.pty.emit(PANE_A, 'queued-a');
        h.pty.emit(PANE_A, 'queued-b');

        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.output).map((frame) => frame.text)).toEqual([
            '12345678'
        ]);
        expect(h.session.stats(PANE_A)).toMatchObject({ paused: true, queuedBytes: 16 });

        ack(h.session, PANE_A, 8);

        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.output).map((frame) => frame.text)).toEqual([
            '12345678',
            'queued-a'
        ]);

        ack(h.session, PANE_A, 8);
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.output).map((frame) => frame.text)).toEqual([
            '12345678',
            'queued-a',
            'queued-b'
        ]);
        // The last drained chunk is itself unacked, so the pane is at the window again
        // until the client confirms it.
        expect(h.session.stats(PANE_A)).toMatchObject({ queuedBytes: 0, unacked: 8, paused: true });
        ack(h.session, PANE_A, 8);
        expect(h.session.stats(PANE_A)).toMatchObject({ queuedBytes: 0, unacked: 0, paused: false });
    });

    it('never backpressures the PTY: a stalled client does not stop other clients', async () => {
        const h = harness({ windowBytes: 4 });
        const other = h.hub.createSession(recordingTransport());
        await h.session.attach(PANE_A);
        await other.attach(PANE_A);

        h.pty.emit(PANE_A, 'aaaa');
        h.pty.emit(PANE_A, 'bbbb');
        h.pty.emit(PANE_A, 'cccc');

        expect(h.session.stats(PANE_A)?.paused).toBe(true);
        // The unacked client queues; the PTY was never asked to stop and the second client
        // is equally free to fall behind on its own budget.
        expect(other.stats(PANE_A)?.sentBytes).toBe(4);
    });

    it('drops the queue and re-seeds with a replay when the client falls too far behind', async () => {
        const h = harness({ windowBytes: 4, maxQueuedBytes: 8 });
        await h.session.attach(PANE_A);

        h.pty.emit(PANE_A, 'aaaa'); // sent, fills the window
        h.pty.emit(PANE_A, 'bbbb'); // queued
        h.pty.emit(PANE_A, 'cccc'); // queued (at the bound)
        h.pty.emit(PANE_A, 'dddd'); // overflows → queue dropped, resync armed

        expect(h.session.stats(PANE_A)).toMatchObject({ resyncPending: true, queuedBytes: 0 });

        const notice = vi.spyOn(h.transport, 'sendJson');
        const replay = vi.spyOn(h.transport, 'sendFrame');
        h.term.setSnapshot(PANE_A, 'REBUILT');
        ack(h.session, PANE_A, 4);
        // The re-seed takes the FLUSHING snapshot (N23), so it lands a turn later.
        await settle();

        const frames = h.frames();
        expect(frames.at(-1)).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'REBUILT' });
        expect(h.transport.ofType('pty-resync')).toEqual([
            { type: 'pty-resync', paneID: PANE_A, reason: 'flow-control-drop' }
        ]);
        // A late notice would invalidate the snapshot and zero its newly charged credit.
        expect(notice.mock.invocationCallOrder[0]).toBeLessThan(replay.mock.invocationCallOrder[0]!);
        expect(h.session.stats(PANE_A)).toMatchObject({ resyncPending: false });

        // Live output continues after the resync.
        ack(h.session, PANE_A, 7);
        h.pty.emit(PANE_A, 'next');
        expect(h.frames().at(-1)).toEqual({ type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'next' });
    });

    it('holds the resync until the client is back inside the window', async () => {
        const h = harness({ windowBytes: 4, maxQueuedBytes: 4 });
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, 'aaaa');
        h.pty.emit(PANE_A, 'bbbb');
        h.pty.emit(PANE_A, 'cccc');
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);

        ack(h.session, PANE_A, 0);
        await settle();
        expect(h.transport.ofType('pty-resync')).toEqual([]);
        ack(h.session, PANE_A, 4);
        await settle();
        expect(h.transport.ofType('pty-resync')).toHaveLength(1);
    });

    /**
     * N23, the flow-control half: the re-seed must take the FLUSHING snapshot, must zero the
     * window it re-seeds, and must not start twice.
     *
     * `feed()` only queues — xterm parses asynchronously — so the sync `snapshot()` this path
     * used to call described everything parsed SO FAR and silently omitted chunks fed a moment
     * ago. Those chunks had also been dropped from this client's queue, so they were gone from
     * its screen for the life of the pane: a hole in the middle of a byte stream, which is the
     * shape of every corruption in this family.
     */
    it('re-seeds from the flushing snapshot, so a chunk mid-parse is not lost', async () => {
        const h = harness({ windowBytes: 4, maxQueuedBytes: 4 });
        h.term.asyncSnapshots = true; // the real service: `snapshotAsync` settles the write chain
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, 'aaaa');
        h.pty.emit(PANE_A, 'bbbb');
        h.pty.emit(PANE_A, 'cccc');
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);

        // What the emulator has PARSED…
        h.term.setSnapshot(PANE_A, 'REBUILT');
        // …and the chunk boot fed a moment later, still inside the write chain when the ack
        // arrives. It was dropped from this client's queue too, so it exists nowhere else: only
        // a flushing snapshot can put it back on screen.
        h.term.feedMidParse(PANE_A, '+mid-parse');

        /*
         * The fixture DISCRIMINATES, and this line is why the assertion below means anything:
         * the two snapshots differ, so a re-seed that reads the sync one is visibly a different
         * replay rather than the same bytes by another route. (Both of this pair's assertions
         * used to hold on the pre-fix source — `snapshot()` and `snapshotAsync()` returned
         * identical data — which is a net that catches nothing.)
         */
        expect(textOf(h.term.service.snapshot(PANE_A).data)).toBe('REBUILT');

        ack(h.session, PANE_A, 4);
        await vi.waitFor(() => expect(h.transport.ofType('pty-resync')).toHaveLength(1));

        expect(h.frames().at(-1)).toEqual({
            type: PTY_FRAME_TYPES.replay,
            paneID: PANE_A,
            text: 'REBUILT+mid-parse'
        });
    });

    it('zeroes the window it re-seeds, so the pane cannot stall on stale acks', async () => {
        // The client zeroes its own unacked/pending the instant a replay lands, dropping any ack
        // it had not flushed yet. A daemon that kept charging those bytes would never let this
        // client out of its window again — the same fix the settled-resize path has.
        //
        // The window has to be CHARGED at the moment of the re-seed or this measures nothing:
        // an ack that drains it to zero leaves "the replay's own byte" outstanding whether or
        // not the path zeroes anything. So the ack below is PARTIAL — it brings the client back
        // inside its window (which is what starts the re-seed) with five of eight bytes still
        // charged, the shape §N23 measured.
        const h = harness({ windowBytes: 8, maxQueuedBytes: 4 });
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, 'aaaaaaaa'); // sent, fills the window exactly
        h.pty.emit(PANE_A, 'bbbb'); // queued (at the bound)
        h.pty.emit(PANE_A, 'cccc'); // overflows → queue dropped, resync armed
        expect(h.session.stats(PANE_A)).toMatchObject({ unacked: 8, resyncPending: true });

        h.term.setSnapshot(PANE_A, 'S');
        ack(h.session, PANE_A, 3); // 8 − 3 = 5 charged, and 5 < 8 → the re-seed starts
        await settle();

        // Exactly the replay's own byte is outstanding — nothing from before it. Pre-fix the
        // five stale bytes stayed charged and this read 6.
        expect(h.session.stats(PANE_A)?.unacked).toBe(1);
    });

    it('does not wipe a client screen when the pane was disposed before the re-seed', async () => {
        // The same rule the settled-resize path has: an empty snapshot is not a re-seed, it is a
        // blank screen. A flow-control drop that races a pane close must not paint one.
        const h = harness({ windowBytes: 4, maxQueuedBytes: 4 });
        h.term.setSnapshot(PANE_A, 'content');
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, 'aaaa');
        h.pty.emit(PANE_A, 'bbbb');
        h.pty.emit(PANE_A, 'cccc');
        h.term.service.dispose(PANE_A);

        ack(h.session, PANE_A, 4);
        await settle();

        expect(h.transport.ofType('pty-resync')).toEqual([]);
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.replay)).toHaveLength(1);
    });

    it('starts one re-seed however many acks arrive while the snapshot settles', async () => {
        const h = harness({ windowBytes: 4, maxQueuedBytes: 4 });
        h.term.asyncSnapshots = true;
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, 'aaaa');
        h.pty.emit(PANE_A, 'bbbb');
        h.pty.emit(PANE_A, 'cccc');

        h.term.setSnapshot(PANE_A, 'ONE');
        ack(h.session, PANE_A, 4);
        ack(h.session, PANE_A, 0);
        ack(h.session, PANE_A, 0);
        await vi.waitFor(() => expect(h.transport.ofType('pty-resync')).toHaveLength(1));
        await settle();

        expect(h.transport.ofType('pty-resync')).toHaveLength(1);
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.replay)).toHaveLength(2);
    });
});

describe('hub lifecycle', () => {
    it('unsubscribes from the PTY manager and drops sessions on close', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        expect(h.hub.attachedPaneIDs()).toEqual([PANE_A]);
        h.hub.close();
        h.pty.emit(PANE_A, 'after-close');
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.output)).toEqual([]);
        expect(h.hub.sessionCount).toBe(0);
    });
});

describe('VT modes on the stream (§TERM-037…§TERM-039)', () => {
    it('sends the pane modes right after the replay', async () => {
        // The client encodes DEC mouse reports itself, so an attach that carried no modes would
        // leave a mouse-mode TUI unreportable until the app happened to re-assert DECSET.
        const h = harness();
        h.term.setModes({
            applicationCursorKeys: true,
            bracketedPaste: false,
            mouseTracking: 'drag',
            mouseFormat: 'sgr'
        });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });

        expect(h.transport.ofType('pane-modes')).toEqual([
            {
                type: 'pane-modes',
                paneID: PANE_A,
                modes: {
                    applicationCursorKeys: true,
                    bracketedPaste: false,
                    mouseTracking: 'drag',
                    mouseFormat: 'sgr',
                    // The wire form is total: a mode the seam left absent is sent as its
                    // default, never omitted, so a client never has to guess (§TERM-030).
                    kittyKeyboardFlags: 0
                }
            }
        ]);
    });

    it('defaults the mouse pair when the terminal state does not carry it', async () => {
        // The seam's two mouse members are optional so every existing `VtModes` literal stays
        // valid; absent has to mean "no mouse mode", never "unknown".
        const h = harness();
        h.term.setModes({ applicationCursorKeys: false, bracketedPaste: true });
        await h.session.attach(PANE_A);

        expect(h.transport.ofType('pane-modes').at(0)).toMatchObject({
            modes: { mouseTracking: 'none', mouseFormat: 'x10', bracketedPaste: true }
        });
    });

    it('carries the kitty keyboard flags to the client (§TERM-030)', async () => {
        // Same reason as the mouse pair, one wave later: the client encodes key events itself
        // because the engine has no `keyup` listener, so the negotiated flags have to cross the
        // socket as state rather than stay inside the daemon's VT.
        const h = harness();
        h.term.setModes({
            applicationCursorKeys: false,
            bracketedPaste: false,
            mouseTracking: 'none',
            mouseFormat: 'x10',
            kittyKeyboardFlags: 11
        });
        await h.session.attach(PANE_A);

        expect(h.transport.ofType('pane-modes').at(0)).toMatchObject({
            modes: { kittyKeyboardFlags: 11 }
        });
    });

    it('pushes a later change to every session attached to that pane, and to no other', async () => {
        const h = harness();
        const other = h.hub.createSession(recordingTransport());
        await h.session.attach(PANE_A);
        await h.session.attach(PANE_B);
        await other.attach(PANE_B);
        const before = h.transport.ofType('pane-modes').length;

        h.hub.modesChanged(PANE_B, {
            applicationCursorKeys: false,
            bracketedPaste: false,
            mouseTracking: 'any',
            mouseFormat: 'urxvt'
        });

        const pushed = h.transport.ofType('pane-modes').slice(before);
        expect(pushed).toEqual([
            {
                type: 'pane-modes',
                paneID: PANE_B,
                modes: {
                    applicationCursorKeys: false,
                    bracketedPaste: false,
                    mouseTracking: 'any',
                    mouseFormat: 'urxvt',
                    kittyKeyboardFlags: 0
                }
            }
        ]);
    });

    it('does not push modes for a pane the session never attached', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        const before = h.transport.ofType('pane-modes').length;
        h.hub.modesChanged(PANE_B, { applicationCursorKeys: false, bracketedPaste: false });
        expect(h.transport.ofType('pane-modes')).toHaveLength(before);
    });

    it('stops pushing modes once the pane is detached', async () => {
        const h = harness();
        await h.session.attach(PANE_A);
        h.session.detach(PANE_A);
        const before = h.transport.ofType('pane-modes').length;
        h.hub.modesChanged(PANE_A, { applicationCursorKeys: false, bracketedPaste: false });
        expect(h.transport.ofType('pane-modes')).toHaveLength(before);
    });
});

/**
 * The post-resize resync (`DEFAULT_RESIZE_RESYNC_MS`).
 *
 * A pane has two emulators — the daemon's and the client's — and a resize is what makes them
 * disagree over identical bytes. These cover the three properties the seam has to hold: one
 * replay per SETTLED gesture, no byte lost or doubled around it, and no way for it to loop.
 */
type Snapshot = ReturnType<StubTerm['service']['snapshot']>;
type AsyncTerm = StubTerm['service'] & { snapshotAsync(paneID: string): Promise<Snapshot> };

/**
 * Hold the NEXT snapshot open, then resolve or reject it by hand.
 *
 * `resyncPane` takes every target off live before it awaits its snapshot, so "what happens
 * inside that await" is a real state the hub can be in for as long as the emulator keeps
 * parsing, and it is the only way to express a resize landing mid-resync with a clock that
 * can be advanced by hand. One-shot: the call after this one runs the real implementation.
 */
function deferNextSnapshot(h: Harness): { finish(): void; fail(): void } {
    const service = h.term.service as AsyncTerm;
    const snapshot = service.snapshotAsync.bind(service);
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    vi.spyOn(service, 'snapshotAsync').mockImplementationOnce(async (paneID) => {
        await pending;
        return snapshot(paneID);
    });
    return { finish, fail: () => fail(new Error('snapshot failed')) };
}

describe('session-local resize replay', () => {
    const SETTLE = 40;

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('coalesces local resizes into one replay for the requesting session without changing geometry', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        const ownerTransport = recordingTransport();
        const owner = h.hub.createSession(ownerTransport);
        await owner.attach(PANE_A, { cols: 80, rows: 24 });
        await h.session.attach(PANE_A);
        await h.session.attach(PANE_B);
        h.term.setSnapshot(PANE_A, 'current-screen');

        for (let step = 0; step < 10; step += 1) {
            h.session.requestReplay(PANE_A);
            await vi.advanceTimersByTimeAsync(SETTLE / 2);
        }
        expect(h.frames()).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(SETTLE * 3);

        // Two frames per replay since #166 (grid, then snapshot). The grid is the OWNER's
        // 80x24 every time: this session never owned sizing, so its own `requestReplay` moves
        // the daemon's emulator not at all — it is handed the owner's grid to mirror.
        expect(h.frames()).toEqual([
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '80x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: '' },
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_B, text: '80x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_B, text: '' },
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '80x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'current-screen' }
        ]);
        expect(ownerTransport.frames).toHaveLength(2);
        expect(h.term.resizes).toEqual([{ paneID: PANE_A, cols: 80, rows: 24 }]);
        expect(h.pty.resizes).toEqual(h.term.resizes);
        expect(h.geometry).toEqual(h.term.resizes);
        expect(h.transport.ofType('pty-resync')).toEqual([]);
        h.hub.close();
    });

    it('includes pending bytes exactly once and leaves other viewers live while its snapshot settles', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        const otherTransport = recordingTransport();
        const other = h.hub.createSession(otherTransport);
        await h.session.attach(PANE_A);
        await other.attach(PANE_A);
        const snapshot = deferNextSnapshot(h);
        h.session.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(h.session.stats(PANE_A)?.live).toBe(false);
        expect(other.stats(PANE_A)?.live).toBe(true);

        h.term.feedMidParse(PANE_A, 'during');
        h.pty.emit(PANE_A, 'during');
        // Grid + replay from the attach (#166), and nothing since: this session is off live.
        expect(h.frames()).toHaveLength(2);
        expect(otherTransport.frames).toHaveLength(3);
        snapshot.finish();
        await vi.advanceTimersByTimeAsync(0);
        h.pty.emit(PANE_A, 'after');

        expect(h.frames().slice(2)).toEqual([
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '80x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'during' },
            { type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'after' }
        ]);
        expect(otherTransport.frames).toHaveLength(4);
        h.hub.close();
    });

    it('replaces the old flow-control window and queued tail with the replay', async () => {
        const h = harness({ resizeResyncMs: SETTLE, windowBytes: 8, maxQueuedBytes: 8 });
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, '12345678');
        h.pty.emit(PANE_A, 'tail');
        expect(h.session.stats(PANE_A)).toMatchObject({ unacked: 8, queuedBytes: 4 });
        h.term.setSnapshot(PANE_A, 'seed');

        h.session.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE);

        expect(h.session.stats(PANE_A)).toMatchObject({ live: true, unacked: 4, queuedBytes: 0 });
        expect(h.frames().at(-1)).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'seed' });
        h.pty.emit(PANE_A, '+');
        expect(h.frames().at(-1)).toEqual({ type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: '+' });
        h.hub.close();
    });

    it('leaves an existing flow-control reseed to the ACK path', async () => {
        const h = harness({ resizeResyncMs: SETTLE, windowBytes: 8, maxQueuedBytes: 4 });
        await h.session.attach(PANE_A);
        h.pty.emit(PANE_A, '12345678');
        h.pty.emit(PANE_A, 'overflow');
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);
        h.term.setSnapshot(PANE_A, 'seed');

        h.session.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(h.frames().filter((frame) => frame.type === PTY_FRAME_TYPES.replay)).toHaveLength(1);
        const ack = encodePtyFrame(PTY_FRAME_TYPES.ack, PANE_A, encodeAckPayload(8))!;
        h.session.handleFrame(ack);
        await vi.advanceTimersByTimeAsync(0);

        expect(h.frames().at(-1)).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'seed' });
        expect(h.session.stats(PANE_A)).toMatchObject({ live: true, unacked: 4, resyncPending: false });
        expect(h.transport.ofType('pty-resync')).toHaveLength(1);
        h.hub.close();
    });

    it.each(['finish', 'fail'] as const)('retires an in-flight snapshot after detach and reattach (%s)', async (complete) => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A);
        const stale = deferNextSnapshot(h);
        h.session.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(h.session.stats(PANE_A)?.live).toBe(false);

        h.session.detach(PANE_A);
        h.term.setSnapshot(PANE_A, 'new-attachment');
        const current = deferNextSnapshot(h);
        const attaching = h.session.attach(PANE_A);
        stale[complete]();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.session.stats(PANE_A)?.live).toBe(false);
        expect(h.frames()).toHaveLength(2); // the first attach's grid + replay (#166)

        current.finish();
        await attaching;
        expect(h.frames().at(-1)).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'new-attachment' });
        expect(h.session.stats(PANE_A)).toMatchObject({ live: true, unacked: 'new-attachment'.length });
        h.hub.close();
    });

    it.each(['detach', 'exit', 'close', 'hub-close', 'dispose'] as const)('cancels a pending replay when the pane is unavailable (%s)', async (action) => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A);
        const snapshot = vi.spyOn(h.term.service as AsyncTerm, 'snapshotAsync');
        h.session.requestReplay(PANE_A);
        if (action === 'detach') h.session.detach(PANE_A);
        else if (action === 'exit') h.pty.exit(PANE_A, 0);
        else if (action === 'close') h.session.close();
        else if (action === 'hub-close') h.hub.close();
        else h.term.service.dispose(PANE_A);

        await vi.advanceTimersByTimeAsync(SETTLE * 2);
        expect(snapshot).not.toHaveBeenCalled();
        expect(h.frames()).toHaveLength(2); // the attach's grid + replay, and nothing after it
        h.hub.close();
    });

    it('ignores unattached panes and respects disabled resize replays', async () => {
        const h = harness({ resizeResyncMs: -1 });
        await h.session.attach(PANE_A);
        h.session.requestReplay(PANE_A);
        const other = harness({ resizeResyncMs: SETTLE });
        other.session.requestReplay(PANE_B);

        await vi.advanceTimersByTimeAsync(SETTLE * 2);
        expect(h.frames()).toHaveLength(2); // the attach's grid + replay (#166)
        expect(other.frames()).toEqual([]);
        h.hub.close();
        other.hub.close();
    });
});

describe('settled-resize resync', () => {
    const SETTLE = 40;

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    /** Replay frames for a pane, oldest first. */
    const replays = (h: Harness, paneID: string): string[] =>
        h.frames()
            .filter((frame) => frame.type === PTY_FRAME_TYPES.replay && frame.paneID === paneID)
            .map((frame) => frame.text);

    it('reconciles the client to the daemon buffer once the geometry settles', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });

        h.term.setSnapshot(PANE_A, 'reflowed-screen');
        h.session.resize(PANE_A, 60, 24);
        expect(replays(h, PANE_A)).toEqual(['attached']); // nothing yet: the gesture is live

        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(replays(h, PANE_A)).toEqual(['attached', 'reflowed-screen']);
    });

    it('coalesces a resize STORM into exactly one resync', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.term.setSnapshot(PANE_A, 'settled');

        // 40 steps of a live drag, each one inside the settle window of the last.
        for (let step = 0; step < 40; step += 1) {
            h.session.resize(PANE_A, 80 - step, 24);
            await vi.advanceTimersByTimeAsync(SETTLE / 2);
        }
        expect(replays(h, PANE_A)).toHaveLength(1); // the attach replay only

        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(replays(h, PANE_A)).toEqual(['', 'settled']);
    });

    it('never resyncs twice for one settled gesture, however long the pane then idles', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);

        await vi.advanceTimersByTimeAsync(SETTLE);
        const afterSettle = replays(h, PANE_A).length;
        await vi.advanceTimersByTimeAsync(SETTLE * 20);

        expect(replays(h, PANE_A)).toHaveLength(afterSettle);
    });

    it('cannot loop: a resize to the grid the pane already has arms nothing', async () => {
        // The replay itself provokes no resize on the client (its `resize()` short-circuits on
        // an unchanged grid), and this is the other half of the same guard — so even a client
        // that re-published its geometry on every replay could not ping-pong.
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        const before = replays(h, PANE_A).length;

        h.session.resize(PANE_A, 80, 24);
        h.session.resize(PANE_A, 80, 24);
        await vi.advanceTimersByTimeAsync(SETTLE * 4);

        expect(replays(h, PANE_A)).toHaveLength(before);
    });

    it('does not resync the geometry an attach just snapshotted at', async () => {
        // `attach()` sizes the pane and THEN snapshots, so the first grid a pane is seen at is
        // already what the client is looking at; a replay 150 ms later would be pure traffic.
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 120, rows: 40 });
        await vi.advanceTimersByTimeAsync(SETTLE * 4);

        expect(replays(h, PANE_A)).toHaveLength(1);
    });

    it('loses no byte that lands while the snapshot settles, and doubles none', async () => {
        /*
         * REAL timers, because the ordering under test is the event loop's own: the settle
         * timer and the emit are both `setTimeout(…, 0)` (timers phase, registration order)
         * and the stub's async snapshot resolves on a `setImmediate` (check phase), so the
         * bytes land *strictly inside* the snapshot's await — the window the attach path
         * calls "pre-live bytes are already inside the pending replay". Nothing about that
         * window is expressible with a clock that can be advanced by hand.
         */
        vi.useRealTimers();
        const h = harness({ resizeResyncMs: 0 });
        h.term.asyncSnapshots = true;
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        const framesBefore = h.frames().length;

        h.session.resize(PANE_A, 60, 24);
        // Fast typing across the settle: boot feeds the terminal from the same synchronous
        // `pty.onData` emission this hub delivers from, so `snapshotAsync()`'s flush loop
        // picks these up — they are dropped from the STREAM precisely because they are
        // inside the snapshot.
        setTimeout(() => {
            h.pty.emit(PANE_A, 'typed-1');
            h.term.service.feed(PANE_A, bytes('typed-1'));
            h.pty.emit(PANE_A, 'typed-2');
            h.term.service.feed(PANE_A, bytes('typed-2'));
        }, 0);
        // Wait for the replay FRAME, not a fixed interval: a loaded suite can stall this
        // worker past any constant (a 30 ms sleep here died in a full battery run), while the
        // interleaving under test — bytes inside the snapshot's await — is fixed by the
        // timer/check phase ordering above, not by how long the poll takes. A duplicate, if
        // the suppression broke, is emitted in the SAME synchronous flip that sends the
        // replay, so exact equality right after the first frame still proves "doubles none".
        const deadline = Date.now() + 5000;
        while (h.frames().length === framesBefore && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }

        expect(h.frames().slice(framesBefore)).toEqual([
            { type: PTY_FRAME_TYPES.replayGrid, paneID: PANE_A, text: '60x24' },
            { type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'typed-1typed-2' }
        ]);

        // …and the stream is live again straight behind it.
        h.pty.emit(PANE_A, 'after');
        expect(h.frames().slice(framesBefore + 2)).toEqual([
            { type: PTY_FRAME_TYPES.output, paneID: PANE_A, text: 'after' }
        ]);
    });

    it('re-seeds every client attached to the pane from ONE snapshot', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        const secondTransport = recordingTransport();
        const second = h.hub.createSession(secondTransport);
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        await second.attach(PANE_A, { cols: 80, rows: 24 });
        h.term.setSnapshot(PANE_A, 'shared');

        // One client drags its window; the OTHER client's VT is just as diverged.
        h.session.resize(PANE_A, 61, 25);
        await vi.advanceTimersByTimeAsync(SETTLE);

        const decodeReplays = (frames: Uint8Array[]): string[] =>
            frames
                .map((frame) => decodePtyFrame(frame))
                .filter((frame) => frame !== undefined && frame.type === PTY_FRAME_TYPES.replay)
                .map((frame) => textOf((frame as { payload: Uint8Array }).payload));
        expect(decodeReplays(h.transport.frames)).toEqual(['', 'shared']);
        expect(decodeReplays(secondTransport.frames)).toEqual(['', 'shared']);
    });

    it('keeps the flow-control counters in step with the client on a resync', async () => {
        // The client zeroes its own unacked/pending the moment a replay lands, dropping any ack
        // it had not flushed. A daemon that kept charging those bytes would stall the pane.
        const h = harness({ resizeResyncMs: SETTLE, windowBytes: 64 });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.pty.emit(PANE_A, 'x'.repeat(50));
        expect(h.session.stats(PANE_A)?.unacked).toBe(50);

        h.term.setSnapshot(PANE_A, 'seed');
        h.session.resize(PANE_A, 60, 24);
        await vi.advanceTimersByTimeAsync(SETTLE);

        expect(h.session.stats(PANE_A)?.unacked).toBe('seed'.length);
        expect(h.session.stats(PANE_A)?.live).toBe(true);
    });

    it('leaves the flow-control re-seed to the ack path when one is already pending', async () => {
        const h = harness({ resizeResyncMs: SETTLE, windowBytes: 16, maxQueuedBytes: 8 });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.pty.emit(PANE_A, 'x'.repeat(20)); // over the window
        h.pty.emit(PANE_A, 'y'.repeat(20)); // over the queue bound → resyncPending
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);
        const before = replays(h, PANE_A).length;

        h.session.resize(PANE_A, 60, 24);
        await vi.advanceTimersByTimeAsync(SETTLE);

        expect(replays(h, PANE_A)).toHaveLength(before);
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);
    });

    it('sends nothing to a client that detached during the settle', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);
        h.session.detach(PANE_A);

        await vi.advanceTimersByTimeAsync(SETTLE * 2);
        expect(replays(h, PANE_A)).toHaveLength(1);
    });

    it('drops a pending resync when the pane process exits', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);
        h.pty.exit(PANE_A, 0);

        await vi.advanceTimersByTimeAsync(SETTLE * 2);
        expect(replays(h, PANE_A)).toHaveLength(1);
    });

    it('drops pending resyncs when the hub closes', async () => {
        const h = harness({ resizeResyncMs: SETTLE });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);
        h.hub.close();

        await vi.advanceTimersByTimeAsync(SETTLE * 2);
        expect(replays(h, PANE_A)).toHaveLength(1);
    });

    it('does not wipe a client screen when the pane was disposed mid-gesture', async () => {
        // `snapshot()` of a disposed pane is EMPTY, and an empty replay resets the engine to
        // a blank screen. A resize that races a pane close must not do that.
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'content');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);
        h.term.service.dispose(PANE_A);

        await vi.advanceTimersByTimeAsync(SETTLE * 2);

        expect(replays(h, PANE_A)).toEqual(['content']);
    });

    it('can be switched off entirely', async () => {
        const h = harness({ resizeResyncMs: -1 });
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        h.session.resize(PANE_A, 60, 24);

        await vi.advanceTimersByTimeAsync(1000);
        expect(replays(h, PANE_A)).toHaveLength(1);
    });

    it('still reconciles a resize that settled INSIDE an in-flight resync (#165)', async () => {
        // The hole behind "the garbage is a steady state".
        //
        // `resyncPane` takes every target off live BEFORE it awaits the snapshot, so a second
        // `resyncPane` for the same pane while that await is outstanding used to find no live
        // target, return with `targets.length === 0`, and be gone. Nothing re-arms a settle
        // timer except another APPLIED geometry change, so the dropped reconciliation was the
        // LAST one, for the geometry the user is now looking at.
        //
        // The await is not a microtask: `snapshotAsync` flushes the emulator's write chain
        // first (`term/service.ts` `flush` loops while `done < issued`), so a pane that keeps
        // printing through the gesture (a TUI repainting, a spinner) holds it open for
        // exactly as long as the gesture lasts.
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });

        // The shrink settles and its resync starts, then stalls on the snapshot.
        const stalled = deferNextSnapshot(h);
        h.term.setSnapshot(PANE_A, 'narrow');
        h.session.resize(PANE_A, 26, 24);
        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(replays(h, PANE_A)).toEqual(['attached']);

        // The widen lands inside that await and settles there.
        h.session.resize(PANE_A, 120, 24);
        await vi.advanceTimersByTimeAsync(SETTLE);
        expect(replays(h, PANE_A)).toEqual(['attached']); // still nothing: the snapshot is held

        h.term.setSnapshot(PANE_A, 'wide');
        stalled.finish();
        await vi.advanceTimersByTimeAsync(0);

        // TWO post-attach replays: the stalled one, and the one the widen was owed. Without
        // the owed-resync bookkeeping the second never happens and the client keeps whatever
        // the shrink's repaint left on its canvas for good.
        expect(replays(h, PANE_A)).toEqual(['attached', 'wide', 'wide']);
    });

    it('keeps a session-local replay session-local when it is owed (#165)', async () => {
        // A non-owner's local resize replays for THAT viewer only and changes no server
        // geometry, so an owed reconciliation must be run at the scope it was asked for: an
        // owner's broadcast must not shrink to one session, and a viewer's request must not
        // grow into a replay that resets every other client's engine for nothing.
        const h = harness({ resizeResyncMs: SETTLE });
        const viewerTransport = recordingTransport();
        const viewer = h.hub.createSession(viewerTransport);
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        await viewer.attach(PANE_A);

        const stalled = deferNextSnapshot(h);
        h.session.resize(PANE_A, 26, 24); // the owner: a broadcast resync, which stalls
        await vi.advanceTimersByTimeAsync(SETTLE);

        viewer.requestReplay(PANE_A); // the viewer, while that is in flight
        await vi.advanceTimersByTimeAsync(SETTLE);

        h.term.setSnapshot(PANE_A, 'settled');
        stalled.finish();
        await vi.advanceTimersByTimeAsync(0);

        const viewerReplays = viewerTransport.frames
            .map((frame) => decodePtyFrame(frame))
            .filter((frame) => frame !== undefined && frame.type === PTY_FRAME_TYPES.replay)
            .map((frame) => textOf(frame!.payload));
        // The owner got its broadcast resync; the viewer got that one PLUS the session-local
        // replay it was owed, and the owner did not get a second copy of the viewer's.
        expect(replays(h, PANE_A)).toEqual(['attached', 'settled']);
        expect(viewerReplays).toEqual(['attached', 'settled', 'settled']);
    });

    it('retries ONCE when the snapshot throws, and then stops (#165)', async () => {
        // The same hole with a different cause. The catch puts `live` back but the queue was
        // already emptied on the promise that the snapshot supersedes it, and no snapshot was
        // sent: the client keeps the gesture's own repaint and nothing re-arms. One retry
        // repairs it, because a snapshot is the authoritative buffer and a later one
        // reconciles just as well as the one that failed.
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });

        const failing = deferNextSnapshot(h);
        h.term.setSnapshot(PANE_A, 'reflowed');
        h.session.resize(PANE_A, 60, 24);
        await vi.advanceTimersByTimeAsync(SETTLE);
        failing.fail();
        await vi.advanceTimersByTimeAsync(0);

        expect(replays(h, PANE_A)).toEqual(['attached', 'reflowed']);
    });

    it('does not poll forever when every snapshot throws (#165)', async () => {
        // The cap on the retry above: a snapshot that keeps failing must not turn the settle
        // window into a 150 ms poll for the life of the pane. One retry per gesture, and the
        // next APPLIED grid change is what buys the next one.
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        const errors: string[] = [];
        const service = h.term.service as AsyncTerm;
        vi.spyOn(service, 'snapshotAsync').mockImplementation(async () => {
            errors.push('called');
            throw new Error('snapshot failed');
        });

        h.session.resize(PANE_A, 60, 24);
        await vi.advanceTimersByTimeAsync(SETTLE * 20);

        // The settled resync plus its one retry, and nothing after that.
        expect(errors).toHaveLength(2);
        expect(replays(h, PANE_A)).toEqual(['attached']);
    });

    it('renews the retry budget on the NEXT applied grid change (#165)', async () => {
        // The other half of the cap: one retry PER GESTURE, not one per pane for the life of the
        // daemon. `noteGeometry` clears the budget when it arms a timer, and without that line
        // every test above still passes while a pane that ever had a failing snapshot never gets
        // a retry again.
        const h = harness({ resizeResyncMs: SETTLE });
        h.term.setSnapshot(PANE_A, 'attached');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        const calls: string[] = [];
        const service = h.term.service as AsyncTerm;
        vi.spyOn(service, 'snapshotAsync').mockImplementation(async () => {
            calls.push('called');
            throw new Error('snapshot failed');
        });

        h.session.resize(PANE_A, 60, 24);
        await vi.advanceTimersByTimeAsync(SETTLE * 20);
        expect(calls).toHaveLength(2); // this gesture's resync plus its retry

        h.session.resize(PANE_A, 40, 24);
        await vi.advanceTimersByTimeAsync(SETTLE * 20);
        expect(calls).toHaveLength(4); // a new gesture, a new resync, a new retry
    });

    it("renews it for a non-owner's local resize too, which changes no server geometry (#165)", async () => {
        // A viewer that does not own PTY sizing replays through `requestReplay`, which never
        // reaches `noteGeometry` (the point of it is that the server's grid does NOT move). So
        // the owner path above is not enough: without the renewal in `requestReplay` a viewer
        // whose snapshot threw once gets zero retries until an owner happens to resize the pane.
        const h = harness({ resizeResyncMs: SETTLE });
        const viewerTransport = recordingTransport();
        const viewer = h.hub.createSession(viewerTransport);
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });
        await viewer.attach(PANE_A);
        const calls: string[] = [];
        const service = h.term.service as AsyncTerm;
        vi.spyOn(service, 'snapshotAsync').mockImplementation(async () => {
            calls.push('called');
            throw new Error('snapshot failed');
        });

        viewer.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE * 20);
        expect(calls).toHaveLength(2); // the viewer's resync plus its retry

        viewer.requestReplay(PANE_A);
        await vi.advanceTimersByTimeAsync(SETTLE * 20);
        expect(calls).toHaveLength(4); // a second local gesture, a second retry
    });
});
/**
 * kelpi #166 — the replay says how wide it is.
 *
 * The defect these pin: PTY geometry follows ONE client (`ws/sync.ts` `sizeOwnerID`), so a
 * viewer renders a snapshot serialised at somebody else's column count, and the serialiser
 * glues a soft-wrapped row to its continuation on the promise that the replaying terminal wraps
 * at the same column. The daemon cannot fix the viewer's engine from here; what it can do is
 * stop withholding the number, which is what every case below is about.
 *
 * The shape a NON-OWNER has at this seam is `attach(paneID)` with no size and no `resize` ever
 * (`ws/sync.ts:2095` passes the measured size only `if (this.ownsSize())`, and `:1541` applies a
 * `resize-pane` only for the owner), so that is how the viewer is driven here.
 */
describe('replay geometry (#166)', () => {
    const SETTLE = 40;

    it("carries the DAEMON's grid to a viewer that never sized the pane", async () => {
        const h = harness();
        const viewerTransport = recordingTransport();
        const viewer = h.hub.createSession(viewerTransport);
        h.term.setSnapshot(PANE_A, 'owner-width-screen');

        await h.session.attach(PANE_A, { cols: 73, rows: 19 });
        await viewer.attach(PANE_A);

        const frames = viewerTransport.frames.map((frame) => decodePtyFrame(frame));
        expect(frames.map((frame) => frame?.type)).toEqual([
            PTY_FRAME_TYPES.replayGrid,
            PTY_FRAME_TYPES.replay
        ]);
        expect(decodeResizePayload(frames[0]?.payload as Uint8Array)).toEqual({ cols: 73, rows: 19 });
        expect(textOf(frames[1]?.payload as Uint8Array)).toBe('owner-width-screen');
        // And nothing about the viewer's attach moved the pane: the grid it was told is the
        // owner's because the owner's is the only one there is.
        expect(h.term.resizes).toEqual([{ paneID: PANE_A, cols: 73, rows: 19 }]);
    });

    it('carries it again on the settled-resize resync, for owner and viewer alike', async () => {
        vi.useFakeTimers();
        try {
            const h = harness({ resizeResyncMs: SETTLE });
            const viewerTransport = recordingTransport();
            const viewer = h.hub.createSession(viewerTransport);
            await h.session.attach(PANE_A, { cols: 80, rows: 24 });
            await viewer.attach(PANE_A);
            h.term.setSnapshot(PANE_A, 'reflowed');

            // The OWNER drags its window; the daemon's emulator follows it, and both clients
            // are reconciled to the buffer it now holds.
            h.session.resize(PANE_A, 61, 25);
            await vi.advanceTimersByTimeAsync(SETTLE * 2);

            const gridsOf = (transport: RecordedTransport): { cols: number; rows: number }[] =>
                transport.frames
                    .map((frame) => decodePtyFrame(frame))
                    .filter((frame) => frame?.type === PTY_FRAME_TYPES.replayGrid)
                    .map((frame) => decodeResizePayload(frame?.payload as Uint8Array) as { cols: number; rows: number });

            expect(gridsOf(h.transport)).toEqual([
                { cols: 80, rows: 24 },
                { cols: 61, rows: 25 }
            ]);
            // The viewer's is IDENTICAL. Its own box is irrelevant here and that is the fix:
            // the one grid the snapshot can be parsed at is the one the daemon holds.
            expect(gridsOf(viewerTransport)).toEqual([
                { cols: 80, rows: 24 },
                { cols: 61, rows: 25 }
            ]);
            h.hub.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("reports the owner's grid to a viewer whose own local resize asked for the replay", async () => {
        vi.useFakeTimers();
        try {
            const h = harness({ resizeResyncMs: SETTLE });
            const viewerTransport = recordingTransport();
            const viewer = h.hub.createSession(viewerTransport);
            await h.session.attach(PANE_A, { cols: 73, rows: 19 });
            await viewer.attach(PANE_A);
            h.term.setSnapshot(PANE_A, 'still-the-owners-screen');

            // This is what a non-owner's window resize becomes: `requestReplay`, never a
            // `resize` (`ws/sync.ts:1541-1546`). The pane's grid must not move, and the replay
            // must state it.
            viewer.requestReplay(PANE_A);
            await vi.advanceTimersByTimeAsync(SETTLE * 2);

            const last = viewerTransport.frames.slice(-2).map((frame) => decodePtyFrame(frame));
            expect(last.map((frame) => frame?.type)).toEqual([
                PTY_FRAME_TYPES.replayGrid,
                PTY_FRAME_TYPES.replay
            ]);
            expect(decodeResizePayload(last[0]?.payload as Uint8Array)).toEqual({ cols: 73, rows: 19 });
            expect(textOf(last[1]?.payload as Uint8Array)).toBe('still-the-owners-screen');
            expect(h.term.resizes).toEqual([{ paneID: PANE_A, cols: 73, rows: 19 }]);
            h.hub.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('charges the grid frame to nobody: four bytes per replay would stall a pane', async () => {
        // The client acks what it FEEDS its engine, and it never feeds this frame to anything
        // (it holds the numbers and applies them to the replay). Charging them would leak four
        // bytes of window per replay for the life of the pane — 512 KB of window, gone one
        // resync at a time — so `sendReplayWithGrid` sends it outside the meter.
        const h = harness();
        h.term.setSnapshot(PANE_A, '12345');
        await h.session.attach(PANE_A, { cols: 80, rows: 24 });

        expect(h.session.stats(PANE_A)).toMatchObject({ unacked: 5, sentBytes: 5 });
    });

    it('re-seeds a dropped client in the order pty-resync, grid, replay', async () => {
        /*
         * The flow-control re-seed is the third replay site and the one a revert can hide: its
         * other tests read `frames().at(-1)`, which is the replay either way, so taking the grid
         * back out of `reseed` left them green. This one pins the whole ordering across BOTH
         * channels, which is where that path's correctness actually lives:
         *
         *   - the `pty-resync` notice leads, because a notice that arrived after the replay would
         *     erase the byte credit the replay just granted (`reseed`'s own comment), and
         *   - the grid sits between the two, because the client holds it until the replay lands and
         *     drops it if anything else arrives first.
         */
        const h = harness({ windowBytes: 8, maxQueuedBytes: 4 });
        h.term.setSnapshot(PANE_A, 'reseeded');
        await h.session.attach(PANE_A, { cols: 61, rows: 25 });
        const before = h.transport.outbound.length;

        h.pty.emit(PANE_A, '12345678');
        h.pty.emit(PANE_A, 'overflowing');
        expect(h.session.stats(PANE_A)?.resyncPending).toBe(true);
        h.session.handleFrame(encodePtyFrame(PTY_FRAME_TYPES.ack, PANE_A, encodeAckPayload(8)) as Uint8Array);
        await settle();

        const sent = h.transport.outbound.slice(before).map((entry) => {
            if (entry.kind === 'json') return `json:${String(entry.message['type'])}`;
            const decoded = decodePtyFrame(entry.frame);
            if (decoded?.type === (PTY_FRAME_TYPES.replayGrid as number)) {
                const grid = decodeResizePayload(decoded.payload) as { cols: number; rows: number };
                return `grid:${String(grid.cols)}x${String(grid.rows)}`;
            }
            return `frame:${String(decoded?.type)}:${textOf(decoded?.payload as Uint8Array)}`;
        });
        expect(sent).toEqual(['json:pty-resync', 'grid:61x25', `frame:${String(PTY_FRAME_TYPES.replay)}:reseeded`]);
    });

    it('sends no grid for a pane the emulator no longer holds, but still sends the replay', async () => {
        // `term/service.ts` `snapshot()` answers `{cols: 0, rows: 0}` for a pane it has thrown
        // away. A client must never resize an engine to nothing, so the pair degrades to the
        // single frame it was before #166 rather than carrying a grid that means "gone".
        const h = harness();
        h.term.setSnapshot(PANE_A, 'whatever');
        h.term.setGrid(PANE_A, 0, 0);
        await h.session.attach(PANE_A);

        expect(h.frames()).toEqual([{ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'whatever' }]);
    });
});
