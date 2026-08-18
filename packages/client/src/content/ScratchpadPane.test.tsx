/**
 * Scratchpads: an editor with no file behind it (§7), and the typing debounce in front of it.
 *
 * The debounce is tested through the REAL `ContentClient` over a fake socket rather than a fake
 * api, because "one `content-set-text` per burst, carrying the last text" is a property of the
 * client's timer, not of the component — and a regression there would put one wire command per
 * keystroke on the socket.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandClient, NexConnection, completeHandshake, createFakeSocketFactory } from '../connection';
import { createContentClient, type ContentClient } from './client';
import { ScratchpadPane } from './ScratchpadPane';
import { contentState } from './testing';

const PANE = 'DDDDDDDD-0000-4000-8000-000000000004';

interface Harness {
    readonly content: ContentClient;
    payloads(): Record<string, unknown>[];
    /** Deliver the daemon's snapshot for the pane. */
    push(text: string, revision?: number): void;
}

function harness(): Harness {
    const sockets = createFakeSocketFactory();
    const connection = new NexConnection({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 }
    });
    const content = createContentClient({ connection, commands: new CommandClient(connection) });
    connection.connect();
    act(() => {
        completeHandshake(sockets.last());
    });

    return {
        content,
        payloads: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        push(text, revision = 1): void {
            act(() => {
                sockets.last().emit({
                    type: 'content-updated',
                    paneID: PANE,
                    state: contentState({
                        paneID: PANE,
                        type: 'scratchpad',
                        mode: 'edit',
                        filePath: null,
                        html: null,
                        assetBase: null,
                        revision,
                        text
                    })
                });
            });
        }
    };
}

function area(): HTMLTextAreaElement {
    return screen.getByTestId(`content-textarea-${PANE}`) as HTMLTextAreaElement;
}

function textCommands(h: Harness): Record<string, unknown>[] {
    return h.payloads().filter((payload) => payload['command'] === 'content-set-text');
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('scratchpad pane', () => {
    it('is always an editor, seeded from the daemon’s buffer', () => {
        const h = harness();
        render(<ScratchpadPane paneID={PANE} content={h.content} />);
        // Read-only until the first snapshot: typing into the empty pre-load buffer would send a
        // `content-set-text` that wipes the restored scratchpad.
        expect(area().readOnly).toBe(true);

        h.push('todo: ship M5\n');

        expect(area().value).toBe('todo: ship M5\n');
        expect(area().readOnly).toBe(false);
        expect(h.payloads().at(0)).toMatchObject({ command: 'content-subscribe', pane_id: PANE });
    });

    it('coalesces a burst of keystrokes into one content-set-text', () => {
        const h = harness();
        render(<ScratchpadPane paneID={PANE} content={h.content} />);
        h.push('');

        fireEvent.change(area(), { target: { value: 'a' } });
        fireEvent.change(area(), { target: { value: 'ab' } });
        fireEvent.change(area(), { target: { value: 'abc' } });
        expect(textCommands(h)).toHaveLength(0);

        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(textCommands(h)).toHaveLength(1);
        expect(textCommands(h)[0]).toMatchObject({ pane_id: PANE, text: 'abc' });
    });

    it('starts a new window for typing that continues after a flush', () => {
        const h = harness();
        render(<ScratchpadPane paneID={PANE} content={h.content} />);
        h.push('');

        fireEvent.change(area(), { target: { value: 'one' } });
        act(() => {
            vi.advanceTimersByTime(300);
        });
        fireEvent.change(area(), { target: { value: 'one two' } });
        act(() => {
            vi.advanceTimersByTime(300);
        });

        expect(textCommands(h).map((payload) => payload['text'])).toEqual(['one', 'one two']);
    });

    it('does not wait out the debounce when the pane goes away', () => {
        const h = harness();
        const view = render(<ScratchpadPane paneID={PANE} content={h.content} />);
        h.push('');

        fireEvent.change(area(), { target: { value: 'unsaved' } });
        view.unmount();

        // The unmount flush beat the timer: the text is on the wire, and only once.
        expect(textCommands(h)).toHaveLength(1);
        expect(textCommands(h)[0]).toMatchObject({ text: 'unsaved' });
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(textCommands(h)).toHaveLength(1);
        expect(h.payloads().at(-1)).toMatchObject({ command: 'content-unsubscribe', pane_id: PANE });
    });
});
