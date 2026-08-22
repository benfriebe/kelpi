/**
 * §TERM-046's client end — the `clipboard-write` relay.
 *
 * Two levels, because the item's client half has two failure modes and they are different:
 *
 *   1. the DECODE + decision (`createClipboardWriteHandler`): who writes, what is logged, and
 *      what a malformed frame does — which must be "nothing", never "wipe the clipboard";
 *   2. the WIRING (`connectStore`): a real frame arriving on a real `NexConnection` reaches the
 *      handler at all. That is the half that has been the actual bug in this port more than
 *      once — a tested decision nothing subscribes to.
 *
 * The seams (`writeText`, `log`) are injected throughout: jsdom has no clipboard, and a test
 * that reached the real one would be writing the developer's clipboard on every run.
 */

import { describe, expect, it, vi } from 'vitest';

import { NexConnection, completeHandshake, createFakeSocketFactory } from '../connection';
import { connectStore } from './bridge';
import {
    createClipboardWriteHandler,
    parseClipboardWrite,
    type ClipboardWriteOutcome
} from './clipboard';
import { createNexStore } from './store';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P1 = 'dddddddd-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'window-1';

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'clipboard-write',
        paneID: P1,
        workspaceID: W1,
        text: 'copied by the pane',
        bytes: 18,
        ...overrides
    };
}

describe('parseClipboardWrite', () => {
    it('reads a well-formed frame', () => {
        expect(parseClipboardWrite(frame())).toEqual({
            paneID: P1,
            workspaceID: W1,
            text: 'copied by the pane',
            bytes: 18
        });
    });

    it('ignores anything that is not a clipboard-write', () => {
        expect(parseClipboardWrite({ type: 'notification', paneID: P1 })).toBeNull();
        expect(parseClipboardWrite({})).toBeNull();
    });

    /**
     * The daemon already declines a zero-length OSC 52 (ghostty's clipboard CLEAR), so an empty
     * `text` here is a malformed frame — and clearing the user's clipboard because a frame was
     * malformed would be the worst available reading of it.
     */
    it('refuses an empty text rather than clearing the clipboard', () => {
        expect(parseClipboardWrite(frame({ text: '' }))).toBeNull();
        expect(parseClipboardWrite(frame({ text: 42 }))).toBeNull();
    });

    it('refuses a frame with no pane or workspace to attribute it to', () => {
        expect(parseClipboardWrite(frame({ paneID: '' }))).toBeNull();
        expect(parseClipboardWrite(frame({ workspaceID: undefined }))).toBeNull();
    });

    it('defaults a missing/garbage byte count to 0 rather than measuring the text', () => {
        expect(parseClipboardWrite(frame({ bytes: undefined }))?.bytes).toBe(0);
        expect(parseClipboardWrite(frame({ bytes: -5 }))?.bytes).toBe(0);
        expect(parseClipboardWrite(frame({ bytes: 'lots' }))?.bytes).toBe(0);
    });
});

describe('the clipboard write handler', () => {
    it('stands down inside a shell window — the main process owns that write', () => {
        const writeText = vi.fn(async () => undefined);
        const logs: string[] = [];
        const handle = createClipboardWriteHandler({
            shellWindowID: SHELL_WINDOW,
            writeText,
            log: (message) => logs.push(message)
        });
        expect(handle(frame())).toBe('shell');
        expect(writeText).not.toHaveBeenCalled();
        expect(logs[0]).toContain('via the Nex shell');
    });

    it('writes through navigator.clipboard in a plain browser', async () => {
        const written: string[] = [];
        const outcomes: ClipboardWriteOutcome[] = [];
        const logs: string[] = [];
        const handle = createClipboardWriteHandler({
            shellWindowID: null,
            writeText: async (text) => {
                written.push(text);
            },
            log: (message) => logs.push(message),
            onResult: (outcome) => outcomes.push(outcome)
        });
        expect(handle(frame())).toBe('browser');
        await vi.waitFor(() => expect(outcomes).toEqual(['browser']));
        expect(written).toEqual(['copied by the pane']);
        // Attributable: the pane and the size. Never the content.
        expect(logs[0]).toContain(P1.slice(0, 8));
        expect(logs[0]).toContain('18 bytes');
        expect(logs.join('\n')).not.toContain('copied by the pane');
    });

    it('survives a browser that refuses the write (no transient activation)', async () => {
        const outcomes: ClipboardWriteOutcome[] = [];
        const logs: string[] = [];
        const handle = createClipboardWriteHandler({
            shellWindowID: null,
            writeText: async () => {
                throw new Error('NotAllowedError');
            },
            log: (message) => logs.push(message),
            onResult: (outcome) => outcomes.push(outcome)
        });
        handle(frame());
        await vi.waitFor(() => expect(outcomes).toEqual(['refused']));
        expect(logs[0]).toContain('refused it');
        expect(logs[0]).toContain('NotAllowedError');
    });

    it('says so when the browser exposes no clipboard at all (plain HTTP)', () => {
        const logs: string[] = [];
        const handle = createClipboardWriteHandler({
            shellWindowID: null,
            writeText: null,
            log: (message) => logs.push(message)
        });
        expect(handle(frame())).toBe('unavailable');
        expect(logs[0]).toContain('no clipboard');
    });

    it('does nothing at all for a frame that is not a clipboard write', () => {
        const writeText = vi.fn(async () => undefined);
        const logs: string[] = [];
        const handle = createClipboardWriteHandler({
            shellWindowID: null,
            writeText,
            log: (message) => logs.push(message)
        });
        expect(handle({ type: 'notification' })).toBeNull();
        expect(handle(frame({ text: '' }))).toBeNull();
        expect(writeText).not.toHaveBeenCalled();
        expect(logs).toEqual([]);
    });
});

describe('the bridge relays a daemon clipboard-write', () => {
    function harness(shellWindowID: string | null) {
        const sockets = createFakeSocketFactory();
        const connection = new NexConnection({
            url: 'ws://daemon.test/ws',
            token: 't',
            socketFactory: sockets.factory,
            backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
            heartbeatIntervalMs: 0
        });
        const written: string[] = [];
        const logs: string[] = [];
        const store = createNexStore();
        const dispose = connectStore({
            store,
            connection,
            notifications: null,
            shellWindowID,
            clipboard: {
                writeText: async (text) => {
                    written.push(text);
                },
                log: (message) => logs.push(message)
            }
        });
        return { sockets, connection, written, logs, store, dispose };
    }

    it('carries the text to the clipboard writer, in a browser client', async () => {
        const h = harness(null);
        h.connection.connect();
        completeHandshake(h.sockets.last());
        h.sockets.last().emit(frame({ text: 'through the socket', bytes: 18 }) as never);
        await vi.waitFor(() => expect(h.written).toEqual(['through the socket']));
        h.dispose();
    });

    it('leaves the write to the shell when this page is a shell window’s', () => {
        const h = harness(SHELL_WINDOW);
        h.connection.connect();
        completeHandshake(h.sockets.last());
        h.sockets.last().emit(frame() as never);
        expect(h.written).toEqual([]);
        expect(h.logs[0]).toContain('via the Nex shell');
        h.dispose();
    });

    /**
     * The clipboard is the user's machine, not application state. A copied password must not end
     * up in a React store, in a devtools timeline, or in a toast.
     */
    it('writes nothing into the store', () => {
        const h = harness(null);
        h.connection.connect();
        completeHandshake(h.sockets.last());
        const before = h.store.getState().ui.toasts;
        h.sockets.last().emit(frame() as never);
        expect(h.store.getState().ui.toasts).toBe(before);
        expect(JSON.stringify(h.store.getState())).not.toContain('copied by the pane');
        h.dispose();
    });
});
