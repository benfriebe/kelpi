/**
 * ⌘F over a content pane opens THAT pane's find bar: the preview's over a rendered markdown
 * document (§CONT-051, §3.13), the built-in editor's over the text of a markdown pane in edit
 * mode or a scratchpad (§4.4, issue #305).
 *
 * The editors used to decline the binding so the chord would fall through to "the host's own
 * find", the port's stand-in for `NSTextView`'s native find bar (§CONT-072). That assumed a
 * browser: the Electron shell has no find for the key to reach, so ⌘F in an editor did nothing
 * at all. The one content body that still declines is an external `$EDITOR` session (CONT-081),
 * which is a terminal running someone else's program.
 *
 * Driven through the real App against a scripted daemon socket, so the keystroke goes through
 * the real dispatcher (`chrome/keys.ts`) and, for an editor, lands on the real textarea.
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
const PANE_SP = 'DDDDDDDD-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;
const DOCUMENT = '<html><head></head><body><h1>Readme</h1><p>alpha beta</p></body></html>';
const SOURCE = '# Readme\n\nalpha beta\n';

/** What the focused content pane is: a preview, the built-in editor, `$EDITOR`, a scratchpad. */
type Body = 'preview' | 'edit' | 'external' | 'scratchpad';

function snapshotState(body: Body): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    if (body === 'scratchpad') {
        // `create-scratchpad` focuses the new pane, exactly as the daemon does after ⇧⌘N.
        store.dispatch({ type: 'create-scratchpad', workspaceID: W1, paneID: PANE_SP, now: NOW });
        return store.getState() as unknown as JsonObject;
    }
    // `open-markdown-pane` focuses the new pane, which is what ⌘F reads.
    store.dispatch({
        type: 'open-markdown-pane',
        workspaceID: W1,
        paneID: PANE_MD,
        filePath: '/repo/README.md',
        now: NOW
    });
    if (body !== 'preview') {
        store.dispatch({
            type: 'set-markdown-editing',
            workspaceID: W1,
            paneID: PANE_MD,
            editing: true,
            ...(body === 'external' ? { externalEditorCommand: 'vim /repo/README.md' } : {})
        });
    }
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
    /** Answer the focused pane's `content-subscribe` with a state in the given mode. */
    seedContent(): Promise<void>;
}

function setup(body: Body): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState(body) });
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
            const paneID = body === 'scratchpad' ? PANE_SP : PANE_MD;
            const state =
                body === 'scratchpad'
                    ? contentState({
                          paneID,
                          type: 'scratchpad',
                          mode: 'edit',
                          filePath: null,
                          html: null,
                          assetBase: null,
                          text: 'notes: alpha beta\nmore beta\n'
                      })
                    : contentState({ paneID, mode: body === 'preview' ? 'view' : 'edit', html: DOCUMENT, text: SOURCE });
            await act(async () => {
                sockets.last().emit({
                    type: 'command-reply',
                    id: frame['id'] as string,
                    reply: { ok: true, pane_id: paneID, state }
                });
                await Promise.resolve();
            });
        }
    };
}

/**
 * ⌘F, fired where the caret lives: on the window for a preview (whose keys reach the host only
 * through the frame's relay), on the editor's own textarea for an editor. Returns false when the
 * app CONSUMED the chord (`preventDefault` + `stopPropagation`).
 */
function pressFind(target: Window | Element = window): boolean {
    let notCancelled = true;
    act(() => {
        notCancelled = fireEvent.keyDown(target, { code: 'KeyF', key: 'f', metaKey: true });
    });
    return notCancelled;
}

function textarea(paneID: string): HTMLTextAreaElement {
    return screen.getByTestId(`content-textarea-${paneID}`) as HTMLTextAreaElement;
}

afterEach(cleanup);

describe('CONT-051: ⌘F over a markdown pane', () => {
    it('opens the find bar over the preview', async () => {
        const h = setup('preview');
        await h.seedContent();
        expect(screen.queryByTestId(`content-find-${PANE_MD}`)).toBeNull();

        const notCancelled = pressFind();
        expect(screen.getByTestId(`content-find-${PANE_MD}`)).toBeTruthy();
        // The preview's bar, over the frame: it is the iframe, not a textarea, underneath.
        expect(screen.getByTestId(`content-iframe-${PANE_MD}`)).toBeTruthy();
        // The app took the chord: it is not left for the host's own find.
        expect(notCancelled).toBe(false);
        // Never a terminal search: the content pane answered the binding itself.
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);
    });

    /**
     * Issue #305: this used to be REFUSED, leaving the chord unconsumed for a host find the
     * desktop app does not have. It now opens the editor's own bar over the source text.
     */
    it('opens the EDITOR find bar in edit mode, and takes the chord', async () => {
        const h = setup('edit');
        await h.seedContent();
        const editor = textarea(PANE_MD);

        const notCancelled = pressFind(editor);
        expect(notCancelled).toBe(false);
        const field = screen.getByTestId(`content-find-input-${PANE_MD}`) as HTMLInputElement;
        expect(document.activeElement).toBe(field);
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);

        // It searches the text being edited: `beta` in the source, selected in the textarea.
        fireEvent.change(field, { target: { value: 'beta' } });
        expect(screen.getByTestId(`content-find-count-${PANE_MD}`).textContent).toBe('1/1');
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([16, 20]);

        // ⌘E back to the preview: the editor (and its bar) goes, and the preview comes up
        // WITHOUT a bar of its own, because nothing asked the preview for one.
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

    /**
     * CONT-081's external `$EDITOR` is a terminal surface running someone else's program over
     * the file. It has no find of ours to open, so the chord is still left alone for it.
     */
    it('still declines over an external $EDITOR session, leaving the chord unconsumed', () => {
        const h = setup('external');

        const notCancelled = pressFind();
        expect(notCancelled).toBe(true);
        expect(screen.queryByTestId(`content-find-${PANE_MD}`)).toBeNull();
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);
    });
});

describe('issue #305: ⌘F in a scratchpad', () => {
    it('opens the find bar from the textarea; typing selects, Escape hands the caret back', async () => {
        const h = setup('scratchpad');
        await h.seedContent();
        const editor = textarea(PANE_SP);
        expect(screen.queryByTestId(`content-find-${PANE_SP}`)).toBeNull();

        const notCancelled = pressFind(editor);
        // Consumed: the keystroke is the app's, not a stray `f` in the buffer.
        expect(notCancelled).toBe(false);
        expect(editor.value).toBe('notes: alpha beta\nmore beta\n');
        expect(h.commands().some((command) => command['command'] === 'terminal-search')).toBe(false);

        const field = screen.getByTestId(`content-find-input-${PANE_SP}`) as HTMLInputElement;
        expect(document.activeElement).toBe(field);
        fireEvent.change(field, { target: { value: 'beta' } });
        expect(screen.getByTestId(`content-find-count-${PANE_SP}`).textContent).toBe('1/2');
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([13, 17]);

        fireEvent.keyDown(field, { key: 'Enter' });
        expect(screen.getByTestId(`content-find-count-${PANE_SP}`).textContent).toBe('2/2');
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([23, 27]);

        fireEvent.keyDown(field, { key: 'Escape' });
        expect(screen.queryByTestId(`content-find-${PANE_SP}`)).toBeNull();
        expect(document.activeElement).toBe(editor);
        expect([editor.selectionStart, editor.selectionEnd]).toEqual([23, 27]);
    });
});
