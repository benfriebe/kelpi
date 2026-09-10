import { PTY_FRAME_TYPES, decodeAckPayload, decodePtyFrame, type JsonObject } from '../../protocol/src/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PtyClient } from '../../client/src/connection/pty.js';
import { KelpiConnection } from '../../client/src/connection/socket.js';
import { completeHandshake, createFakeSocketFactory } from '../../client/src/connection/testing.js';
import { createTerminalScope, type TerminalHostMessage } from '../../client/src/plugins/terminal.js';
import { createPaneStreamHub } from '../../daemon/src/ws/streams.js';
import { PANE_A, bytes, stubPty, stubTerm, textOf } from '../../daemon/src/ws/testing.js';

type RendererFrame = Extract<TerminalHostMessage, { type: 'terminal-frame' }>;
const disposals: (() => void)[] = [];
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** Only the sockets, PTY process and emulator are doubles: all three flow-control owners are real. */
function harness(lateResyncNotice = false) {
    const sockets = createFakeSocketFactory();
    const connection = new KelpiConnection({
        url: 'ws://daemon.test/ws', token: 'test', socketFactory: sockets.factory,
        heartbeatIntervalMs: 0,
    });
    const client = new PtyClient(connection, { ackThresholdBytes: 1 });
    connection.connect();
    const socket = sockets.last();
    completeHandshake(socket);

    const process = stubPty();
    const term = stubTerm();
    term.asyncSnapshots = true;
    term.setSnapshot(PANE_A, 'boot');
    const fail = vi.fn();
    const hub = createPaneStreamHub({
        pty: process.manager, term: term.service, windowBytes: 4, maxQueuedBytes: 4,
        resizeResyncMs: -1, onError: fail,
    });
    let delayedNotice: JsonObject | undefined;
    const daemon = hub.createSession({
        sendJson(message) {
            // Counterfactual: reproduce the previous daemon order without modifying it.
            if (lateResyncNotice && message['type'] === 'pty-resync') delayedNotice = message;
            else socket.emit(message);
        },
        sendFrame(frame) {
            socket.emitBinary(frame);
            if (delayedNotice && decodePtyFrame(frame)?.type === PTY_FRAME_TYPES.replay) {
                socket.emit(delayedNotice);
                delayedNotice = undefined;
            }
        },
    });
    const attachments: Promise<void>[] = [];
    const recordSend = socket.send.bind(socket);
    socket.send = data => {
        recordSend(data);
        if (typeof data !== 'string') {
            daemon.handleFrame(socket.frames.at(-1)!);
            return;
        }
        const message = JSON.parse(data) as { type: string; paneID: string; cols: number; rows: number };
        if (message.type === 'attach-pane') {
            attachments.push(daemon.attach(message.paneID, { cols: message.cols, rows: message.rows }));
        } else if (message.type === 'detach-pane') daemon.detach(message.paneID);
        else if (message.type === 'resize-pane') daemon.resize(message.paneID, message.cols, message.rows);
    };

    const frames: RendererFrame[] = [];
    const scope = createTerminalScope({
        paneID: PANE_A, pty: client, presentation: { focused: true, visible: true }, fail,
        send(message) { if (message.type === 'terminal-frame') frames.push(message); },
    });
    disposals.push(() => { scope.dispose(); client.dispose(); connection.close(); hub.close(); });

    let consumed = 0;
    let screen = '';
    const consume = (): RendererFrame => {
        const message = frames[consumed++];
        expect(message, 'renderer must receive a frame before consuming it').toBeDefined();
        if (message!.frame.type === 'replay') screen = textOf(message!.frame.data);
        else if (message!.frame.type === 'output') screen += textOf(message!.frame.data);
        scope.receive({
            type: 'terminal-ack', session: message!.session,
            generation: message!.generation, sequence: message!.sequence,
        });
        return message!;
    };
    const drain = async (): Promise<void> => {
        for (let turn = 0; turn < 40; turn++) {
            await settle();
            if (consumed === frames.length) return;
            consume();
        }
        throw new Error('Renderer did not finish consuming its frames');
    };
    return {
        daemon, client, process, fail, frames, consume, drain,
        get screen() { return screen; },
        get next() { return frames[consumed]; },
        async attach() {
            scope.attach({ session: 'renderer-1', cols: 80, rows: 24 });
            await Promise.all(attachments);
            await drain();
        },
        output(text: string) {
            // Boot feeds the authoritative emulator before notifying stream subscribers.
            term.service.feed(PANE_A, bytes(text));
            process.emit(PANE_A, text);
        },
        credits() {
            return socket.frames.map(frame => decodePtyFrame(frame))
                .filter(frame => frame?.type === PTY_FRAME_TYPES.ack)
                .map(frame => decodeAckPayload(frame!.payload));
        },
    };
}

afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

describe('daemon stream through the selected terminal renderer', () => {
    it('recovers a dropped backlog with an authoritative replay and consumes its credit before continuing live output', async () => {
        const h = harness();
        await h.attach();
        expect(h.screen).toBe('boot');
        expect(h.credits()).toEqual([4]);

        h.output('aaaa'); // Sent, but the renderer has not consumed it.
        h.output('bbbb'); // Queued in the daemon's full window.
        h.output('cccc'); // Overflows its queue and arms an authoritative replay.
        await settle();
        expect(h.next?.frame.type).toBe('output');
        expect(h.daemon.stats(PANE_A)).toMatchObject({ unacked: 4, queuedBytes: 0, resyncPending: true });
        expect(h.client.stats(PANE_A)).toMatchObject({ unacked: 4, pendingAck: 0 });
        expect(h.credits()).toEqual([4]);

        h.consume(); // Renderer completion reaches PtyClient and starts the daemon reseed.
        await settle();
        expect(h.consume().frame.type).toBe('presentation');
        await settle();
        expect(h.consume().frame).toEqual({ type: 'resync', reason: 'flow-control-drop' });
        await settle();
        expect(h.next?.frame).toEqual({ type: 'replay', data: bytes('bootaaaabbbbcccc') });
        expect(h.screen).toBe('bootaaaa');
        expect(h.credits()).toEqual([4, 4]);
        expect(h.daemon.stats(PANE_A)).toMatchObject({ unacked: 16, paused: true, resyncPending: false });
        expect(h.client.stats(PANE_A)).toMatchObject({ unacked: 16, pendingAck: 0 });

        h.output('tail'); // The replacement replay also observes real daemon backpressure.
        expect(h.daemon.stats(PANE_A)?.queuedBytes).toBe(4);
        await h.drain();
        expect(h.screen).toBe('bootaaaabbbbcccctail');
        expect(h.frames.flatMap(message => message.frame.type === 'output' ? [textOf(message.frame.data)] : [])).toEqual(['aaaa', 'tail']);
        expect(h.credits()).toEqual([4, 4, 16, 4]);
        expect(h.daemon.stats(PANE_A)).toMatchObject({ unacked: 0, queuedBytes: 0, paused: false, resyncPending: false });
        expect(h.client.stats(PANE_A)).toMatchObject({ unacked: 0, pendingAck: 0 });
        expect(h.fail).not.toHaveBeenCalled();
    });

    it('detects the previous replay-before-notice order losing the replacement and stalling its byte credit', async () => {
        const h = harness(true);
        await h.attach();
        h.output('aaaa'); h.output('bbbb'); h.output('cccc');
        await h.drain();

        // Delivering the replay first lets the late notice discard it and reset its
        // fresh client credit. The daemon then waits for bytes the renderer never sees.
        expect(h.screen).toBe('bootaaaa');
        expect(h.frames.filter(message => message.frame.type === 'replay')).toHaveLength(1);
        expect(h.frames.some(message => message.frame.type === 'resync')).toBe(true);
        expect(h.credits()).toEqual([4, 4]);
        expect(h.client.stats(PANE_A)).toMatchObject({ unacked: 0, pendingAck: 0 });
        expect(h.daemon.stats(PANE_A)).toMatchObject({ unacked: 16, paused: true });
        h.output('tail'); await h.drain();
        expect(h.screen).toBe('bootaaaa');
        expect(h.daemon.stats(PANE_A)?.queuedBytes).toBe(4);
        expect(h.fail).not.toHaveBeenCalled();
    });
});
