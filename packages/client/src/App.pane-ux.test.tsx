/**
 * Assembly tests for the pane-UX wave: the header context menu, terminal search, reopen-closed
 * pane, the scratchpad, and the active-agents delete gate.
 *
 * Same shape as `App.test.tsx` — the whole client against a scripted daemon socket — because
 * the thing worth protecting is the WIRING: a right-click has to produce the Swift menu's
 * items, ⌘F has to leave as `terminal-search`, a reply has to reach the renderer, and ⌘W on a
 * workspace with a running agent has to stop and ask.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import type { JsonObject } from '@nex/protocol';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createNexRuntime, createNexStore, type NexRuntime } from './state';
import { createFakeRendererFactory, type FakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const PANE_WEB = 'DDDDDDDD-0000-4000-8000-000000000003';
const NOW = 1_755_500_000_000;

interface FixtureOptions {
    /** A second workspace, so "Move to Workspace ▸" has somewhere to point. */
    readonly second?: boolean;
    /** A second pane in W1, so ⌘W is a pane close rather than a workspace delete. */
    readonly split?: boolean;
    /** Workspace-wide synchronise-input, so the menu grows its exclude item. */
    readonly sync?: boolean;
    /** A running agent in PANE_A, so the delete gate fires. */
    readonly agent?: boolean;
    /** A closed pane on the undo stack, so ⇧⌘T has something to pop. */
    readonly closed?: boolean;
    /** A WEB pane in W1, so the menu grows §S43's two shed-control rows. */
    readonly web?: boolean;
    /**
     * The daemon already has a search open on PANE_A. Built by dispatching the real reducers,
     * because the search fields ride the workspace envelope rather than a delta kind of their
     * own — a hand-written event would be a guess at the shape.
     */
    readonly search?: { needle?: string; total?: number | null; selected?: number | null } | undefined;
}

function snapshotState(options: FixtureOptions = {}): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'dev', color: 'blue', now: NOW });
    if (options.second === true) {
        store.dispatch({
            type: 'create-workspace',
            id: W2,
            paneID: 'DDDDDDDD-0000-4000-8000-000000000009',
            name: 'other',
            color: 'green',
            now: NOW
        });
        store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    }
    if (options.split === true || options.closed === true) {
        store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID: PANE_B,
            direction: 'horizontal',
            sourcePaneID: PANE_A,
            label: 'worker',
            now: NOW
        });
    }
    if (options.closed === true) {
        store.dispatch({ type: 'close-pane', workspaceID: W1, paneID: PANE_B });
    }
    if (options.web === true) {
        store.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PANE_WEB,
            tabID: 'FFFFFFFF-0000-4000-8000-000000000001',
            url: 'https://example.com',
            sourcePaneID: PANE_A,
            direction: 'horizontal',
            now: NOW
        });
    }
    if (options.sync === true) {
        store.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
    }
    if (options.agent === true) {
        store.dispatch({
            type: 'pane-agent-event',
            paneID: PANE_A,
            workspaceID: W1,
            now: NOW,
            event: { type: 'setPaneStatus', status: 'running' }
        });
    }
    if (options.search !== undefined) {
        store.dispatch({ type: 'focus-pane', workspaceID: W1, paneID: PANE_A });
        store.dispatch({ type: 'toggle-search', workspaceID: W1 });
        if (options.search.needle !== undefined) {
            store.dispatch({ type: 'set-search-needle', workspaceID: W1, needle: options.search.needle });
        }
        if (options.search.total !== undefined) {
            store.dispatch({
                type: 'set-search-counts',
                workspaceID: W1,
                paneID: PANE_A,
                total: options.search.total,
                ...(options.search.selected === undefined ? {} : { selected: options.search.selected })
            });
        }
    }
    // The wire shape, not the raw state: `ws/serialize.ts` replaces the undo STACK with its
    // depth, and `reopenClosedPane` reads exactly that field to decide whether ⇧⌘T has anything
    // to pop. A fixture that skipped the swap would leave the client thinking the stack is empty.
    const state = store.getState() as unknown as {
        workspaces: { recentlyClosedPanes: readonly unknown[] }[];
    };
    return {
        ...(state as unknown as JsonObject),
        workspaces: state.workspaces.map((workspace) => {
            const { recentlyClosedPanes, ...rest } = workspace;
            return { ...rest, recentlyClosedCount: recentlyClosedPanes.length };
        })
    } as unknown as JsonObject;
}

interface Harness {
    readonly runtime: NexRuntime;
    readonly renderers: FakeRendererFactory;
    socket(): FakeWebSocket;
    sent(): Record<string, unknown>[];
    commands(): Record<string, unknown>[];
    /** The `command` frame (id included) whose payload names `command`. */
    frameFor(command: string): Record<string, unknown> | undefined;
    reply(command: string, payload: JsonObject): void;
}

function setup(options: FixtureOptions = {}): Harness {
    const sockets = createFakeSocketFactory();
    const store = createNexStore();
    const runtime = createNexRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    const renderers = createFakeRendererFactory();
    render(<App runtime={runtime} createRenderer={renderers.factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState(options) });
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
        runtime,
        renderers,
        socket: () => sockets.last(),
        sent,
        commands: () =>
            sent()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>),
        frameFor,
        reply(command, payload) {
            const frame = frameFor(command);
            if (frame === undefined) throw new Error(`no ${command} frame was sent`);
            act(() => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'] as string, reply: payload });
            });
        }
    };
}

function openPaneMenu(paneID = PANE_A): void {
    fireEvent.contextMenu(screen.getByTestId(`pane-header-${paneID}`));
}

/** Menu labels without their shortcut hint (a row renders "Split Right" + "⌘D" side by side). */
function menuLabels(): string[] {
    return [...screen.getByTestId('context-menu').querySelectorAll('[data-menu-item]')].map((node) => {
        const label = node.querySelector('span.flex-1');
        return (label?.textContent ?? node.textContent ?? '').trim();
    });
}

afterEach(cleanup);

describe('pane context menu (TERM-106…TERM-111)', () => {
    it('opens on a header right-click with the Swift menu’s items', () => {
        setup();
        openPaneMenu();
        const labels = menuLabels();
        expect(labels).toContain('Rename…');
        expect(labels).toContain('Close Pane');
        expect(labels).toContain('Split Right');
        expect(labels).toContain('Split Down');
        expect(labels).toContain('New Web Pane');
        expect(labels).toContain('Copy Working Directory');
    });

    it('offers the Status submenu for a shell pane, checkmarking the current value', () => {
        setup({ agent: true });
        openPaneMenu();
        fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-item="status"]') as Element);
        const submenu = screen.getByTestId('context-submenu');
        expect((submenu.textContent ?? '')).toContain('Awaiting Input');
        const running = submenu.querySelector('[data-menu-item="status-running"]');
        expect((running?.textContent ?? '').startsWith('✓')).toBe(true);
    });

    it('sends set-pane-status from the Status submenu', async () => {
        const h = setup();
        openPaneMenu();
        fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-item="status"]') as Element);
        fireEvent.click(screen.getByTestId('context-submenu').querySelector('[data-menu-item="status-running"]') as Element);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'set-pane-status',
                pane_id: PANE_A,
                status: 'running'
            });
        });
    });

    it('lists only OTHER workspaces under Move to Workspace, and moves the pane there', async () => {
        const h = setup({ second: true });
        openPaneMenu();
        const move = screen.getByTestId('context-menu').querySelector('[data-menu-item="move-to-workspace"]');
        expect(move).not.toBeNull();
        fireEvent.click(move as Element);
        const submenu = screen.getByTestId('context-submenu');
        expect(submenu.textContent).toContain('other');
        expect(submenu.textContent).not.toContain('dev');
        fireEvent.click(submenu.querySelector(`[data-menu-item="move-${W2}"]`) as Element);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-move-to-workspace',
                pane_id: PANE_A,
                name: W2
            });
        });
    });

    it('omits Move to Workspace when there is nowhere to move to', () => {
        setup();
        openPaneMenu();
        expect(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="move-to-workspace"]')
        ).toBeNull();
    });

    it('grows the sync exclude item only while the workspace is synced', async () => {
        const withoutSync = setup({ split: true });
        openPaneMenu();
        expect(menuLabels()).not.toContain('Exclude from Sync');
        cleanup();

        const h = setup({ split: true, sync: true });
        openPaneMenu();
        expect(menuLabels()).toContain('Exclude from Sync');
        fireEvent.click(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="sync-exclude"]') as Element
        );
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'pane-sync-exclude',
                target: PANE_A,
                excluded: true
            });
        });
        expect(withoutSync).toBeTruthy();
    });

    it('hides Open in Finder outside the Electron shell', () => {
        setup();
        openPaneMenu();
        expect(menuLabels()).not.toContain('Open in Finder');
    });

    it('opens the header’s inline rename field from Rename…', () => {
        setup();
        openPaneMenu();
        fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-item="rename"]') as Element);
        expect(screen.getByTestId(`pane-rename-input-${PANE_A}`)).toBeTruthy();
    });

    it('closes the focused pane from Close Pane', async () => {
        const h = setup({ split: true });
        openPaneMenu(PANE_B);
        fireEvent.click(screen.getByTestId('context-menu').querySelector('[data-menu-item="close"]') as Element);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close', pane_id: PANE_B });
        });
    });
});

describe('terminal search (TERM-113…TERM-120)', () => {
    it('⌘F over a terminal leaves as terminal-search toggle, and no bar appears until the daemon says so', async () => {
        const h = setup();
        fireEvent.keyDown(window, { code: 'KeyF', key: 'f', metaKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'terminal-search',
                action: 'toggle',
                workspace_id: W1
            });
        });
        // The bar is DAEMON state: nothing is drawn optimistically.
        expect(screen.queryByTestId(`pane-search-${PANE_A}`)).toBeNull();
    });

    it('paints the overlay for the pane the daemon says is being searched', () => {
        setup({ search: {} });
        expect(screen.getByTestId(`pane-search-${PANE_A}`)).toBeTruthy();
    });

    it('types a needle, steps to a match, and scrolls the renderer to it', async () => {
        const h = setup({ search: {} });

        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE_A}`), { target: { value: 'MARKER' } });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'terminal-search',
                action: 'set',
                needle: 'MARKER'
            });
        });

        fireEvent.keyDown(screen.getByTestId(`pane-search-input-${PANE_A}`), { key: 'Enter' });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'terminal-search', action: 'next' });
        });

        h.reply('terminal-search', {
            ok: true,
            workspace_id: W1,
            pane_id: PANE_A,
            needle: 'MARKER',
            total: 3,
            selected: 0,
            match: { line: 40, col: 6, length: 6, lines_from_bottom: 60 }
        });

        await waitFor(() => {
            expect(h.renderers.instances.at(-1)?.revealed.at(-1)).toEqual({
                linesFromBottom: 60,
                col: 6,
                length: 6
            });
        });
    });

    it('renders the daemon’s counter, including the "-/N" pre-selection state', () => {
        setup({ search: { needle: 'MARKER', total: 3 } });
        fireEvent.change(screen.getByTestId(`pane-search-input-${PANE_A}`), { target: { value: 'MARKER' } });
        expect(screen.getByTestId(`pane-search-count-${PANE_A}`).textContent).toBe('-/3');
    });

    it('Escape closes the search over the wire', async () => {
        const h = setup({ search: { needle: 'x', total: 1, selected: 0 } });
        fireEvent.keyDown(screen.getByTestId(`pane-search-input-${PANE_A}`), { key: 'Escape' });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'terminal-search', action: 'close' });
        });
    });
});

describe('reopen-closed-pane and the scratchpad', () => {
    it('⇧⌘T pops the daemon’s undo stack', async () => {
        const h = setup({ closed: true });
        fireEvent.keyDown(window, { code: 'KeyT', key: 'T', metaKey: true, shiftKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'reopen-closed-pane',
                workspace_id: W1
            });
        });
    });

    it('⇧⌘T stays quiet when nothing has been closed', async () => {
        const h = setup();
        const before = h.commands().length;
        fireEvent.keyDown(window, { code: 'KeyT', key: 'T', metaKey: true, shiftKey: true });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(h.commands()).toHaveLength(before);
    });

    it('⇧⌘N creates a scratchpad', async () => {
        const h = setup();
        fireEvent.keyDown(window, { code: 'KeyN', key: 'N', metaKey: true, shiftKey: true });
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'create-scratchpad', workspace_id: W1 });
        });
    });
});

describe('the ⌘W active-agents gate (TERM-077 / WS-109)', () => {
    it('asks before deleting a workspace whose agent is still running', async () => {
        const h = setup({ agent: true });
        const before = h.commands().length;
        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

        const gate = await screen.findByTestId('agent-delete-gate');
        expect(gate.dataset['activeAgents']).toBe('1');
        expect(gate.textContent).toContain('1 active agent');
        expect(gate.textContent).toContain('will terminate it');
        // Nothing has gone out yet — the alert is IN FRONT of the delete, not after it.
        expect(h.commands()).toHaveLength(before);

        fireEvent.click(screen.getByTestId('agent-delete-cancel'));
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
        expect(h.commands()).toHaveLength(before);
    });

    it('deletes on confirm, and honours "Don’t ask again" whichever button ends the dialog', async () => {
        const h = setup({ agent: true });
        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
        await screen.findByTestId('agent-delete-gate');
        fireEvent.click(screen.getByTestId('agent-delete-suppress'));
        fireEvent.click(screen.getByTestId('agent-delete-confirm'));

        await waitFor(() => {
            // §WS-156: the gate was raised BY ⌘W, so the confirmation inherits ⌘W's own
            // permission to reach zero workspaces — the GUI verb, not the CLI's.
            expect(h.commands().at(-1)).toMatchObject({
                command: 'delete-workspace',
                workspace_id: W1,
                force: true,
                allow_last: true
            });
        });
        expect(
            h.commands().some(
                (payload) =>
                    payload['command'] === 'set-general-setting' &&
                    payload['key'] === 'confirm-workspace-delete' &&
                    payload['value'] === 'false'
            )
        ).toBe(true);
    });
});

/**
 * N14 — the shell's File ▸ Close (⌘W), arriving as a request rather than as a window close.
 *
 * The menu row in the main process no longer decides anything: it evaluates
 * `window.__nexShellClosePane()` in this page and only closes the WINDOW if the answer is not
 * `true` (`shell/src/menu.ts`). What is asserted here is this end of that contract — the global
 * exists, it runs the same `close_pane` a keystroke runs, and one ⌘W can never close two panes
 * however many routes it arrives by.
 */
describe('the shell’s Close request (N14)', () => {
    const askShellClose = (): boolean => {
        const request = (window as unknown as Record<string, unknown>)['__nexShellClosePane'];
        if (typeof request !== 'function') throw new Error('the client installed no close bridge');
        return (request as () => boolean)();
    };

    it('closes the focused pane and answers "handled", so the window stays', async () => {
        const h = setup({ split: true });

        let handled = false;
        act(() => {
            handled = askShellClose();
        });

        expect(handled).toBe(true);
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({ command: 'pane-close' });
        });
    });

    it('does not close a second pane when the keystroke already closed one', async () => {
        const h = setup({ split: true });

        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
        await waitFor(() => {
            expect(h.commands().filter((payload) => payload['command'] === 'pane-close')).toHaveLength(1);
        });

        // The same ⌘W reaching the menu row anyway (whether a native accelerator can still fire
        // after a cross-origin frame preventDefaults it is not observable from in here, so this
        // side is written to be correct either way).
        let handled = false;
        act(() => {
            handled = askShellClose();
        });

        expect(handled).toBe(true);
        expect(h.commands().filter((payload) => payload['command'] === 'pane-close')).toHaveLength(1);
    });

    /**
     * The residual N14's row named, and the decision that closes it: with the command palette
     * up, step 1 used to decline ⌘W, the bridge answered `false`, and the shell's Close row took
     * the WINDOW. ⌘W now closes the palette — the topmost closeable thing — by both routes.
     */
    describe('with the command palette open', () => {
        const openPalette = async (): Promise<void> => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
            await screen.findByTestId('command-palette');
        };

        it('⌘W closes the palette and leaves both the panes and the window alone', async () => {
            const h = setup({ split: true });
            await openPalette();
            const before = h.commands().length;

            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

            await waitFor(() => {
                expect(screen.queryByTestId('command-palette')).toBeNull();
            });
            expect(h.commands()).toHaveLength(before);
        });

        it('answers the shell “handled”, which is what stops the window closing', async () => {
            const h = setup({ split: true });
            await openPalette();
            const before = h.commands().length;

            let handled = false;
            act(() => {
                handled = askShellClose();
            });

            expect(handled).toBe(true);
            await waitFor(() => {
                expect(screen.queryByTestId('command-palette')).toBeNull();
            });
            expect(h.commands()).toHaveLength(before);
        });

        it('does not then take a pane when the same ⌘W arrives by the menu route as well', async () => {
            const h = setup({ split: true });
            await openPalette();
            const before = h.commands().length;

            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
            await waitFor(() => {
                expect(screen.queryByTestId('command-palette')).toBeNull();
            });

            let handled = false;
            act(() => {
                handled = askShellClose();
            });

            // Answered from the coalescing mark the overlay close leaves, not by closing a pane.
            expect(handled).toBe(true);
            expect(h.commands()).toHaveLength(before);
        });
    });

    /**
     * Settings is the deliberate exception: its key recorder arms a capture listener on `window`
     * to record chords the map would otherwise eat — ⌘W among them — so the chord is ANSWERED
     * (the window is safe) but the overlay is not closed out from under it. Escape and the close
     * button remain its dismiss.
     */
    describe('with Settings open', () => {
        const openSettings = async (): Promise<void> => {
            fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
            await screen.findByTestId('settings-window');
        };

        it('answers the shell "handled" but leaves the overlay — the recorder keeps ⌘W', async () => {
            const h = setup({ split: true });
            await openSettings();
            const before = h.commands().length;

            let handled = false;
            act(() => {
                handled = askShellClose();
            });

            expect(handled).toBe(true);
            expect(screen.queryByTestId('settings-window')).not.toBeNull();
            expect(h.commands()).toHaveLength(before);
        });

        it('and the keystroke closes neither the overlay nor a pane', async () => {
            const h = setup({ split: true });
            await openSettings();
            const before = h.commands().length;

            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });

            expect(screen.queryByTestId('settings-window')).not.toBeNull();
            expect(h.commands()).toHaveLength(before);
        });
    });

    it('is the dispatcher’s answer, not a private path: the delete gate still stops it', async () => {
        const h = setup({ agent: true });
        const before = h.commands().length;

        act(() => {
            askShellClose();
        });

        // Same gate ⌘W raises — the request goes through `close_pane`, so it inherits every
        // condition the keystroke has.
        const gate = await screen.findByTestId('agent-delete-gate');
        expect(gate.dataset['activeAgents']).toBe('1');
        expect(h.commands()).toHaveLength(before);
    });
});

/*
 * SPACING-REVIEW S43's reachability half — **owner-directed**, 2026-08-29.
 *
 * `webpane/WebPane.tsx` ▸ `webChromeFit` SHEDS the dev-tools button below ~272 px of pane and
 * the element-pickup button below ~244 px, so the address bar stops collapsing to a 16 px stub.
 * Shedding is only honest if the verb still has a route, and these two had none: the bindable
 * `web_*` actions cover back/forward/reload/tabs/zoom/url and neither of them.
 *
 * So the pane's own context menu carries both, at EVERY width — a menu whose contents change as
 * a pane is dragged narrower would be a worse affordance than a stable one. A deliberate
 * addition to `PaneHeaderView.swift:353-364`'s list, and the only one.
 */
describe('pane context menu — a web pane’s shed controls (S43, owner-directed)', () => {
    it('carries Element Pickup and Toggle Developer Tools, and only for a web pane', () => {
        setup({ web: true });
        openPaneMenu(PANE_WEB);
        const labels = menuLabels();
        expect(labels).toContain('Element Pickup');
        expect(labels).toContain('Toggle Developer Tools');
        cleanup();

        setup();
        openPaneMenu();
        expect(menuLabels()).not.toContain('Element Pickup');
        expect(menuLabels()).not.toContain('Toggle Developer Tools');
    });

    it('reaches the same verb the shed button did', async () => {
        const h = setup({ web: true });
        openPaneMenu(PANE_WEB);
        fireEvent.click(
            screen.getByTestId('context-menu').querySelector('[data-menu-item="web-batch-toggle"]') as Element
        );
        await waitFor(() => {
            expect(h.commands().at(-1)).toMatchObject({
                command: 'web-batch-toggle',
                pane_id: PANE_WEB
            });
        });
    });
});
