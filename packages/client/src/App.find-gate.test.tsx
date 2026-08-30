/**
 * §CONT-051 — ⌘F over a markdown pane opens the find bar for the PREVIEW only.
 *
 * The Swift reducer routes ⌘F by pane type *and* by mode: a markdown pane in edit mode is
 * refused, because the find bar searches the rendered document and there is no rendered
 * document while the editor is up (the `NSTextView` answers ⌘F with its own native find bar,
 * §CONT-072 — in a browser that is the host's find, which the app must not shadow).
 *
 * The port's daemon already made that split (`canHostSearch` admits markdown only while
 * `!pane.isEditing`); the CLIENT binding did not, so ⌘E-then-⌘F drew a find bar over the
 * editor. This drives the real App against a scripted daemon socket, in both modes.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { contentState } from './content/testing';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_MD = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;
const DOCUMENT = '<html><head></head><body><h1>Readme</h1><p>alpha beta</p></body></html>';

function snapshotState(editing: boolean): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({
        type: 'open-markdown-pane',
        workspaceID: W1,
        paneID: PANE_MD,
        filePath: '/repo/README.md',
        now: NOW
    });
    if (editing) {
        store.dispatch({ type: 'set-markdown-editing', workspaceID: W1, paneID: PANE_MD, editing: true });
    }
    // `open-markdown-pane` focuses the new pane, which is what ⌘F reads.
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    /** Answer the pane's `content-subscribe` with a state in the given mode. */
    seedContent(mode: 'view' | 'edit'): Promise<void>;
}

function setup(editing: boolean): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState(editing) });
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
        sent,
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        async seedContent(mode) {
            const frame = frameFor('content-subscribe');
            if (frame === undefined) throw new Error('no content-subscribe frame was sent');
            await act(async () => {
                sockets.last().emit({
                    type: 'command-reply',
                    id: frame['id'] as string,
                    reply: {
                        ok: true,
                        pane_id: PANE_MD,
                        state: contentState({
                            paneID: PANE_MD,
                            mode,
                            html: DOCUMENT,
                            text: '# Readme\n\nalpha beta\n'
                        })
                    }
                });
                await Promise.resolve();
            });
        }
    };
}

/** Returns false when the app CONSUMED the chord (`preventDefault` + `stopPropagation`). */
function pressFind(): boolean {
    let notCancelled = true;
    act(() => {
        notCancelled = fireEvent.keyDown(window, { code: 'KeyF', key: 'f', metaKey: true });
    });
    return notCancelled;
}

afterEach(cleanup);

describe('CONT-051: ⌘F over a markdown pane', () => {
    it('opens the find bar over the preview', async () => {
        const h = setup(false);
        await h.seedContent('view');
        expect(screen.queryByTestId(`content-find-${PANE_MD}`)).toBeNull();

        const notCancelled = pressFind();
        expect(screen.getByTestId(`content-find-${PANE_MD}`)).toBeTruthy();
        // The app took the chord: it is not left for the host's own find.
        expect(notCancelled).toBe(false);
        // Never a terminal search: the content pane answered the binding itself.
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);
    });

    /**
     * The keystroke has to be REFUSED, not merely unrendered — an editor draws no find bar
     * either way, so "no bar appeared" proves nothing on its own. What the refusal buys is
     * that the chord is left ALONE: a handler that accepts it also consumes it
     * (`preventDefault` + `stopPropagation`, `chrome/keys.ts` `consume`), and the host's own
     * find — the port's stand-in for the editor's native find bar (§CONT-072) — never opens.
     * So ⌘F in edit mode used to do nothing at all, twice over.
     */
    it('declines in edit mode, leaving the chord unconsumed for the host', async () => {
        const h = setup(true);
        await h.seedContent('edit');
        // Precondition: the editor really is up (the textarea, not the preview iframe).
        expect(screen.getByTestId(`content-textarea-${PANE_MD}`)).toBeTruthy();

        const notCancelled = pressFind();
        expect(notCancelled).toBe(true);
        expect(screen.queryByTestId(`content-find-${PANE_MD}`)).toBeNull();
        // …and nothing was sent instead: no terminal search on a markdown pane either.
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);

        // ⌘E back to the preview: the daemon re-renders and pushes the view-mode state. The
        // pane comes back without a bar, because no request was ever recorded for it.
        act(() => {
            h.socket().emit({
                type: 'content-updated',
                paneID: PANE_MD,
                state: contentState({ paneID: PANE_MD, mode: 'view', revision: 9, html: DOCUMENT })
            });
        });
        expect(screen.getByTestId(`content-iframe-${PANE_MD}`)).toBeTruthy();
        expect(screen.queryByTestId(`content-find-${PANE_MD}`)).toBeNull();
    });
});
