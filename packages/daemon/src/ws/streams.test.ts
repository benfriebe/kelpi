import { PTY_FRAME_TYPES, decodePtyFrame, encodeAckPayload, encodePtyFrame, encodeResizePayload } from '@nex/protocol';
import { describe, expect, it } from 'vitest';

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

function harness(options: { windowBytes?: number; maxQueuedBytes?: number } = {}): Harness {
    const pty = stubPty();
    const term = stubTerm();
    const transport = recordingTransport();
    const geometry: { paneID: string; cols: number; rows: number }[] = [];
    const hub = createPaneStreamHub({
        pty: pty.manager,
        term: term.service,
        onGeometry: (paneID, cols, rows) => geometry.push({ paneID, cols, rows }),
        ...(options.windowBytes !== undefined ? { windowBytes: options.windowBytes } : {}),
        ...(options.maxQueuedBytes !== undefined ? { maxQueuedBytes: options.maxQueuedBytes } : {})
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
                return { type: decoded.type as number, paneID: decoded.paneID, text: textOf(decoded.payload) };
            })
    };
}

describe('attach → replay → live', () => {
    it('replays the terminal snapshot, then streams live output', async () => {
        const h = harness();
        h.term.setSnapshot(PANE_A, 'scrollback');

        await h.session.attach(PANE_A, { cols: 100, rows: 30 });
        h.pty.emit(PANE_A, 'live-1');
        h.pty.emit(PANE_A, 'live-2');

        expect(h.frames()).toEqual([
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

    it('reports every applied grid so the NEXT spawn of the pane starts there', async () => {
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

        h.term.setSnapshot(PANE_A, 'REBUILT');
        ack(h.session, PANE_A, 4);

        const frames = h.frames();
        expect(frames.at(-1)).toEqual({ type: PTY_FRAME_TYPES.replay, paneID: PANE_A, text: 'REBUILT' });
        expect(h.transport.ofType('pty-resync')).toEqual([
            { type: 'pty-resync', paneID: PANE_A, reason: 'flow-control-drop' }
        ]);
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
        expect(h.transport.ofType('pty-resync')).toEqual([]);
        ack(h.session, PANE_A, 4);
        expect(h.transport.ofType('pty-resync')).toHaveLength(1);
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
