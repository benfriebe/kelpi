/**
 * §N29 — a click that lands in a web pane's PAGE moves the focus ring.
 *
 * The page is a native `WebContentsView` the shell composites over this document, so the click
 * produces no DOM event here at all: the shell reports it, the daemon fans it out as
 * `web-view-focus`, and this client has to answer it exactly as it answers a terminal body click.
 * Assembly-level on purpose — what the defect was about is the RING and its consequences
 * (keybindings, the header badge, the palette's handoff), all of which hang off the one piece of
 * state a body click sets, so the test drives the message and reads the state, not the handler.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore, type KelpiRuntime } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const SHELL_PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const WEB_PANE = 'DDDDDDDD-0000-4000-8000-000000000004';
const WEB_TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const SHELL_WINDOW = 'window-under-test';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: SHELL_PANE, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({
        type: 'open-web-pane',
        workspaceID: W1,
        paneID: WEB_PANE,
        tabID: WEB_TAB,
        url: 'https://example.com',
        now: NOW
    });
    // Opening a web pane focuses it, and the whole defect is about focus that is somewhere
    // ELSE when the page is clicked — so the fixture starts with the ring on the shell pane.
    store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: SHELL_PANE });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    readonly runtime: KelpiRuntime;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    focusReports(): Record<string, unknown>[];
    webCommands(command: string): Record<string, unknown>[];
}

/**
 * `shellWindow` decides whether this client has native views at all, and the whole message is
 * scoped by it — so the harness has to be the window the report names. `history.replaceState`
 * runs before the render because `App` reads the parameter once, on mount.
 */
function setup(options: { shellWindow?: string | null } = {}): Harness {
    const marker = options.shellWindow === undefined ? SHELL_WINDOW : options.shellWindow;
    window.history.replaceState({}, '', marker === null ? '/' : `/?shellWindow=${marker}`);
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
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
    return {
        runtime,
        socket: () => sockets.last(),
        sent,
        focusReports: () => sent().filter((message) => message['type'] === 'focus-report'),
        webCommands: (command) =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
                .filter((payload) => payload['command'] === command)
    };
}

function viewFocus(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { type: 'web-view-focus', paneID: WEB_PANE, workspaceID: W1, windowID: SHELL_WINDOW, ...extra };
}

function focusedPaneID(): string | null {
    const focused = document.querySelector('[data-pane-id][data-focused="true"]');
    return focused === null ? null : focused.getAttribute('data-pane-id');
}

afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
});

describe('a click in a web pane’s page (§N29)', () => {
    it('moves the focus ring to the web pane', async () => {
        const h = setup();
        // The shell pane is the workspace's first, so it starts with the ring.
        expect(focusedPaneID()).toBe(SHELL_PANE);
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
    });

    it('takes the SAME path a terminal body click takes: the daemon hears an ordinary focus-report', async () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(h.focusReports().at(-1)).toMatchObject({ workspaceID: W1, paneID: WEB_PANE });
        });
    });

    it('lights the web pane’s header and dims the one it left (the badge consequence)', async () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(screen.getByTestId(`pane-header-${WEB_PANE}`).getAttribute('data-focused')).toBe('true');
        });
        expect(screen.getByTestId(`pane-header-${SHELL_PANE}`).getAttribute('data-focused')).toBe('false');
    });

    it('releases the caret the outgoing pane’s surface was holding (N19/N20)', async () => {
        const h = setup();
        // Stand in for the terminal's hidden textarea: a focusable inside the pane's marked
        // surface, holding `document.activeElement` exactly as the engine's own does.
        const surface = document.querySelector(`[data-pane-id="${SHELL_PANE}"] [data-pane-surface]`);
        expect(surface).not.toBeNull();
        const caret = document.createElement('textarea');
        (surface as HTMLElement).appendChild(caret);
        caret.focus();
        expect(document.activeElement).toBe(caret);

        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
        // Left holding the caret, the next keystroke after the renderer got focus back would
        // have gone to a pane that no longer wears the ring.
        expect(document.activeElement).not.toBe(caret);
    });

    it('leaves a CHROME text field alone — the URL bar is the Swift’s NSText exemption', async () => {
        const h = setup();
        const url = screen.getByTestId(`web-url-${WEB_PANE}`);
        (url as HTMLInputElement).focus();
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
        expect(document.activeElement).toBe(url);
    });

    it('does not trap the ring: clicking back into a terminal still takes it (the reverse direction)', async () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
        // The terminal body's own gesture — `onMouseDownCapture` → `onFocusRequest` — which is
        // the DOM path that already worked and must keep working now the page can move focus.
        const terminal = document.querySelector(`[data-pane-id="${SHELL_PANE}"] [data-terminal-status]`);
        expect(terminal).not.toBeNull();
        fireEvent.mouseDown(terminal as Element);
        await waitFor(() => {
            expect(focusedPaneID()).toBe(SHELL_PANE);
        });
        expect(screen.getByTestId(`pane-header-${WEB_PANE}`).getAttribute('data-focused')).toBe('false');
        expect(h.focusReports().at(-1)).toMatchObject({ workspaceID: W1, paneID: SHELL_PANE });
    });

    it('the palette’s §10.4 handoff comes back to the web pane, not to nothing', async () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
        const before = h.webCommands('web-focus-view').length;

        // ⌘P, then Escape: the palette closes and hands the keyboard back to the focused pane.
        // For every other pane type that is a DOM focus; a web pane's surface is a native view
        // in the shell, so the handoff has to go over the wire or it is a silent no-op and the
        // user has to click the page again.
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input');
        expect(input).not.toBeNull();
        act(() => {
            fireEvent.keyDown(input as HTMLInputElement, { code: 'Escape', key: 'Escape' });
        });
        await waitFor(() => {
            expect(h.webCommands('web-focus-view').length).toBeGreaterThan(before);
        });
        expect(h.webCommands('web-focus-view').at(-1)).toMatchObject({ pane_id: WEB_PANE });
    });

    it('ignores a report addressed to a DIFFERENT shell window', () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus({ windowID: 'someone-elses-window' }));
        });
        expect(focusedPaneID()).toBe(SHELL_PANE);
        expect(h.focusReports().some((report) => report['paneID'] === WEB_PANE)).toBe(false);
    });

    it('ignores it in a plain browser tab, which has no native view to have been clicked', () => {
        const h = setup({ shellWindow: null });
        act(() => {
            h.socket().emit(viewFocus({ windowID: undefined }));
        });
        expect(focusedPaneID()).toBe(SHELL_PANE);
    });

    it('ignores a report for a workspace this window is not showing (a switch raced it)', () => {
        const h = setup();
        act(() => {
            h.socket().emit(viewFocus({ workspaceID: W2 }));
        });
        expect(focusedPaneID()).toBe(SHELL_PANE);
    });

    it('ignores a malformed report rather than moving the ring to nothing', () => {
        const h = setup();
        act(() => {
            h.socket().emit({ type: 'web-view-focus', workspaceID: W1, windowID: SHELL_WINDOW });
            h.socket().emit({ type: 'web-view-focus', paneID: WEB_PANE, windowID: SHELL_WINDOW });
        });
        expect(focusedPaneID()).toBe(SHELL_PANE);
    });
});

/**
 * Issue #32 - the caret leaves a web pane's URL bar when the PANE does.
 *
 * The suite above is §N29's direction, where the page takes focus and the ring follows it here.
 * This is the one the port had no rule for: `shouldGrabFocus` will not take a caret held by chrome,
 * so the web pane has to let go itself or the terminal draws as focused and every keystroke keeps
 * landing in an address bar the user has left. Assembly-level because the defect is about the caret
 * and the RING agreeing, and no single component holds both.
 */
describe('the caret follows the ring OUT of a web pane (issue #32)', () => {
    /** Put the ring on the web pane and the caret in its URL bar - the state the bug needs. */
    async function editingTheAddress(h: Harness): Promise<HTMLInputElement> {
        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
        const url = screen.getByTestId(`web-url-${WEB_PANE}`) as HTMLInputElement;
        url.focus();
        expect(document.activeElement).toBe(url);
        return url;
    }

    /** Move the ring to the terminal the way its body click does. */
    async function focusTheTerminal(h: Harness): Promise<void> {
        const terminal = document.querySelector(`[data-pane-id="${SHELL_PANE}"] [data-terminal-status]`);
        expect(terminal).not.toBeNull();
        fireEvent.mouseDown(terminal as Element);
        await waitFor(() => {
            expect(focusedPaneID()).toBe(SHELL_PANE);
        });
    }

    it('lets go of the URL bar when another pane takes the ring', async () => {
        const h = setup();
        const url = await editingTheAddress(h);

        await focusTheTerminal(h);

        expect(document.activeElement).not.toBe(url);
    });

    // The knock-on the issue names: while chrome text holds the caret the dispatcher refuses every
    // non-menu-bar binding (`chrome/keys.ts`, `MENU_BAR_ACTIONS`). Applied to a caret the user has
    // left behind, that killed the pane keymap on the pane they had moved TO.
    it('gives the keymap back to the pane that now wears the ring', async () => {
        const h = setup();
        await editingTheAddress(h);
        await focusTheTerminal(h);

        // Dispatched at whatever holds the caret: a real keystroke's target IS `activeElement`, and
        // firing at `window` would hand the dispatcher a target no `editable()` test can fail.
        act(() => {
            fireEvent.keyDown(document.activeElement ?? window, {
                code: 'BracketRight',
                key: ']',
                metaKey: true
            });
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });
    });

    // The suite above proves a page click keeps the caret; this proves it keeps the DRAFT, which is
    // what the user actually loses if the page-focus and pane-focus paths are ever confused.
    it('a click into the page does not cancel a URL edit in the same pane (WEB-043)', async () => {
        const h = setup();
        const url = screen.getByTestId(`web-url-${WEB_PANE}`) as HTMLInputElement;
        url.focus();
        fireEvent.change(url, { target: { value: 'half-typed-add' } });

        act(() => {
            h.socket().emit(viewFocus());
        });
        await waitFor(() => {
            expect(focusedPaneID()).toBe(WEB_PANE);
        });

        expect(document.activeElement).toBe(url);
        expect(url.value).toBe('half-typed-add');
    });
});
