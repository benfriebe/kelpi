/**
 * ⌘D / ⇧⌘D from a SCRATCHPAD pane — the split chords must work with the caret in the editor.
 *
 * A scratchpad is a `<textarea>` (`PlainTextEditor`), and it holds the caret from the moment
 * ⇧⌘N creates it. The dispatcher's "is the user typing into chrome?" test used to read that
 * textarea as a chrome field — only terminal hosts were excluded — so every non-menu-bar
 * binding (⌘D's `split_right`, ⇧⌘D's `split_down`) was refused exactly where a terminal pane
 * answered it. The fix teaches `isEditableTarget` the distinction `app/pane-focus.ts` already
 * documents: an element marked `data-pane-surface` is a PANE's surface, not chrome text.
 *
 * Driven through the real App against a scripted daemon socket (the `App.find-gate.test.tsx`
 * harness), because the thing worth protecting is the assembly: the keystroke lands on the
 * REAL textarea and has to leave as the same `pane-split` a terminal's ⌘D sends — while a
 * chrome field (the sidebar's inline rename) still suppresses it.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { contentState } from './content/testing';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_SP = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

/** A workspace whose focused pane is a scratchpad split off the boot terminal (⇧⌘N's result). */
function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    // `create-scratchpad` focuses the new pane, exactly as the daemon does after ⇧⌘N.
    store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: PANE_SP, now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    /** Answer the scratchpad's `content-subscribe`, so the editor leaves its read-only boot state. */
    seedContent(): Promise<void>;
}

function setup(): Harness {
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });

    const sent = (): Record<string, unknown>[] => sockets.last().messages();
    const frameFor = (command: string): Record<string, unknown> | undefined =>
        [...sent()]
            .reverse()
            .find(
                (message) =>
                    message['type'] === 'command' &&
                    (message['payload'] as Record<string, unknown>)['command'] === command
            );

    return {
        socket: () => sockets.last(),
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        async seedContent() {
            const frame = frameFor('content-subscribe');
            if (frame === undefined) throw new Error('no content-subscribe frame was sent');
            await act(async () => {
                sockets.last().emit({
                    type: 'command-reply',
                    id: frame['id'] as string,
                    reply: {
                        ok: true,
                        pane_id: PANE_SP,
                        state: contentState({
                            paneID: PANE_SP,
                            type: 'scratchpad',
                            mode: 'edit',
                            filePath: null,
                            html: null,
                            text: 'notes\n'
                        })
                    }
                });
                await Promise.resolve();
            });
        }
    };
}

/** The split chord, fired ON the scratchpad's textarea — the caret's real home while typing. */
function pressSplitOnEditor(shift: boolean): boolean {
    const editor = screen.getByTestId(`content-textarea-${PANE_SP}`);
    let notCancelled = true;
    act(() => {
        notCancelled = fireEvent.keyDown(editor, {
            code: 'KeyD',
            key: shift ? 'D' : 'd',
            metaKey: true,
            shiftKey: shift
        });
    });
    return notCancelled;
}

afterEach(cleanup);

describe('split chords from a scratchpad pane', () => {
    it('⌘D splits the scratchpad right, exactly as it would a terminal', async () => {
        const h = setup();
        await h.seedContent();

        const notCancelled = pressSplitOnEditor(false);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-split',
                pane_id: PANE_SP,
                direction: 'horizontal'
            });
        });
        // Consumed: the chord is not left to type a stray `d` into the buffer.
        expect(notCancelled).toBe(false);
    });

    it('⇧⌘D splits the scratchpad down, through the same textarea', async () => {
        const h = setup();
        await h.seedContent();

        const notCancelled = pressSplitOnEditor(true);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-split',
                pane_id: PANE_SP,
                direction: 'vertical'
            });
        });
        expect(notCancelled).toBe(false);
    });

    /**
     * The guard the old behavior existed for, kept: a CHROME text field still suppresses the
     * pane keymap. ⌘⇧R opens the sidebar's inline rename (a menu-bar-adjacent flow whose field
     * carries no pane-surface mark); ⌘D typed into it must reach the field, not split a pane.
     */
    it('still refuses ⌘D while a chrome text field (the inline rename) is focused', async () => {
        const h = setup();
        await h.seedContent();
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyR', key: 'R', metaKey: true, shiftKey: true });
        });
        const field = await screen.findByLabelText('Rename dev');

        const before = h.commands().filter((payload) => payload['command'] === 'pane-split').length;
        let notCancelled = true;
        act(() => {
            notCancelled = fireEvent.keyDown(field, { code: 'KeyD', key: 'd', metaKey: true });
        });
        await act(async () => {
            await Promise.resolve();
        });

        expect(h.commands().filter((payload) => payload['command'] === 'pane-split').length).toBe(before);
        // Unconsumed: the keystroke stays with the field the user is typing into.
        expect(notCancelled).toBe(true);
    });
});
