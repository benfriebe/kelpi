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

import type { ReactElement } from 'react';

import { focusPaneSurface } from '../app/pane-focus';
import { CommandClient, KelpiConnection, completeHandshake, createFakeSocketFactory } from '../connection';
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
    const connection = new KelpiConnection({
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
        // #106: no editor at all until the first snapshot, exactly as `MarkdownPane` does it.
        // A textarea over the empty pre-load buffer could take the caret and then refuse the
        // text it was waiting for.
        expect(screen.queryByTestId(`content-textarea-${PANE}`)).toBeNull();
        expect(screen.getByTestId(`content-status-${PANE}`).textContent).toBe('');

        h.push('todo: ship M5\n');

        expect(area().value).toBe('todo: ship M5\n');
        expect(area().readOnly).toBe(false);
        expect(h.payloads().at(0)).toMatchObject({ command: 'content-subscribe', pane_id: PANE });
    });

    /**
     * Issue #106 - a workspace switch and back, with the caret arriving first.
     *
     * The grid mounts only the active workspace's panes, so ⌘ 2 then ⌘ 1 unmounts the
     * scratchpad and remounts it from scratch: `ContentClient` dropped its entry on the last
     * unsubscribe, so the text arrives a round trip after the first render. In that window
     * `App`'s post-switch handoff calls `focusPaneSurface` every frame
     * (`handCaretToPaneWhenReady`), which queries the DOM for the pane's surface and knows
     * nothing about this component's props - the route `857f70f`'s `focused` gate left open.
     * The caret landed on the empty textarea, "the typist wins" then refused the snapshot, and
     * the first keystroke replaced the daemon's copy with that one character, for every client
     * and across restarts.
     */
    it('does not let the caret arriving first overwrite the daemon’s copy (#106)', () => {
        const h = harness();
        const Grid = (): ReactElement => (
            <div data-pane-id={PANE} data-focused="true">
                <ScratchpadPane paneID={PANE} content={h.content} focused visible />
            </div>
        );

        const first = render(<Grid />);
        h.push('the whole scratchpad\n');
        expect(area().value).toBe('the whole scratchpad\n');
        first.unmount();

        // Back again. The snapshot has not arrived yet.
        render(<Grid />);
        expect(screen.queryByTestId(`content-textarea-${PANE}`)).toBeNull();
        // The handoff finds nothing to hand the caret to, and keeps asking (1.5 s budget).
        expect(focusPaneSurface(PANE)).toBe(false);
        // Nothing editable exists, so nothing can be typed into the pre-load buffer.
        expect(textCommands(h)).toHaveLength(0);

        h.push('the whole scratchpad\n', 2);

        // Now the caret lands, on a field seeded from the real text.
        expect(focusPaneSurface(PANE)).toBe(true);
        expect(document.activeElement).toBe(area());
        expect(area().value).toBe('the whole scratchpad\n');

        // And the first keystroke extends the scratchpad instead of replacing it.
        fireEvent.change(area(), { target: { value: 'the whole scratchpad\nx' } });
        act(() => {
            vi.advanceTimersByTime(300);
        });
        expect(textCommands(h).map((payload) => payload['text'])).toEqual([
            'the whole scratchpad\nx'
        ]);
    });

    /**
     * Issue #106, the underlying rule: "the typist wins" is about unsaved local edits.
     *
     * The render gate above means a scratchpad no longer reaches this state, but
     * `focusPaneSurface` can focus any editor's textarea and the markdown editor passes
     * `focused` ungated, so the guard itself has to be right.
     */
    it('adopts the first snapshot into a field that holds the caret but has not been typed in', () => {
        const h = harness();
        render(<ScratchpadPane paneID={PANE} content={h.content} focused visible />);
        h.push('restored\n');
        act(() => {
            area().focus();
        });
        expect(document.activeElement).toBe(area());

        // Another client saved while this field sat focused and untouched.
        h.push('saved elsewhere\n', 2);
        expect(area().value).toBe('saved elsewhere\n');

        // Once this typist has typed, they win, as they always did.
        fireEvent.change(area(), { target: { value: 'mine' } });
        h.push('theirs', 3);
        expect(area().value).toBe('mine');
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
