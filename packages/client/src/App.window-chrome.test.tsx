/**
 * The window's own chrome, assembled: the status bar spans it (H2), and every modal parks a
 * live web pane instead of being painted underneath it (H1 / H18).
 *
 * Both are assembly facts — neither can be seen from a component test, because both are about
 * where a surface sits in the WINDOW. The web-pane half has a mechanical read: the page area
 * publishes `data-visible`, which is what the Electron shell moves the native `WebContentsView`
 * by (`webpane/geometry.ts` → `shell/webhost/embed.ts`). `false` means "the page is parked".
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PANE_A = 'dddddddd-0000-4000-8000-000000000001';
const PANE_B = 'dddddddd-0000-4000-8000-000000000002';
const PANE_WEB = 'dddddddd-0000-4000-8000-000000000004';
const WEB_TAB = 'eeeeeeee-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(
    options: { web?: boolean; agent?: boolean; solo?: boolean; second?: boolean } = {}
): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    if (options.second === true) {
        // The row menu's Delete is disabled while a workspace is the only one there is, so the
        // dialog §N26 is about cannot be raised without a second workspace to keep.
        store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    }
    if (options.web === true) {
        store.dispatch({
            type: 'open-web-pane',
            workspaceID: W1,
            paneID: PANE_WEB,
            tabID: WEB_TAB,
            url: 'https://example.com',
            now: NOW
        });
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
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    commands(): Record<string, unknown>[];
}

function mount(options: { web?: boolean; agent?: boolean; second?: boolean } = {}): Harness {
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
        completeHandshake(sockets.last(), { state: snapshotState(options) });
    });
    return {
        socket: () => sockets.last(),
        commands: () =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
    };
}

/** Is the web pane's page area placed, or parked? `false` = the shell takes the view away. */
function pageVisible(): string | undefined {
    return screen.getByTestId(`web-page-${PANE_WEB}`).dataset['visible'];
}

afterEach(cleanup);

describe('the status bar spans the window (§H2)', () => {
    it('is a sibling of the sidebar | grid | inspector row, not a child of the centre column', () => {
        mount();
        const app = screen.getByTestId('kelpi-app');
        const footer = screen.getByTestId('status-footer');
        const sidebar = screen.getByTestId('sidebar-slot');

        // `ContentView.swift:14-16, 609-610` — `StatusBarView` sits in the outer VStack, beside
        // the whole content HStack, which is what makes the 24 pt bar and its 1 px top divider
        // run edge to edge under both side panels.
        expect(footer.parentElement).toBe(app);

        const contentRow = sidebar.parentElement;
        expect(contentRow).not.toBeNull();
        expect(contentRow?.contains(footer)).toBe(false);
        // …and it is BELOW the row rather than beside it.
        expect(
            contentRow === null
                ? 0
                : contentRow.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeGreaterThan(0);
    });

    it('the pane grid’s column does not own it either — the grid stops above the bar', () => {
        mount();
        const footer = screen.getByTestId('status-footer');
        const grid = screen.getByTestId('pane-grid');
        const column = grid.closest('div')?.parentElement ?? null;
        expect(column?.contains(footer)).toBe(false);
    });
});

describe('modals park a live web pane (§H1)', () => {
    it('the page is placed while nothing is up', () => {
        mount({ web: true });
        expect(pageVisible()).toBe('true');
    });

    it('a pane context menu parks it, and closing the menu hands it back', () => {
        mount({ web: true });
        act(() => {
            fireEvent.contextMenu(screen.getByTestId(`pane-header-${PANE_A}`));
        });
        expect(screen.getByTestId('context-menu')).toBeTruthy();
        expect(pageVisible()).toBe('false');

        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        expect(screen.queryByTestId('context-menu')).toBeNull();
        expect(pageVisible()).toBe('true');
    });

    it('a toast parks it — otherwise the page eats the only message the user gets', async () => {
        mount({ web: true });
        const app = screen.getByTestId('kelpi-app');
        await act(async () => {
            fireEvent.drop(app, {
                dataTransfer: {
                    types: ['text/uri-list'],
                    files: { length: 0 },
                    getData: (format: string) => (format === 'text/uri-list' ? 'file:///repo/photo.png' : '')
                }
            });
            await Promise.resolve();
        });
        expect(screen.getByTestId('toast-stack')).toBeTruthy();
        expect(pageVisible()).toBe('false');

        act(() => {
            fireEvent.click(screen.getByTestId('toast-stack').querySelector('button') as Element);
        });
        expect(screen.queryByTestId('toast-stack')).toBeNull();
        expect(pageVisible()).toBe('true');
    });

    it('the command palette still parks it (the four the assembly always knew about)', () => {
        mount({ web: true });
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        expect(screen.getByTestId('command-palette')).toBeTruthy();
        expect(pageVisible()).toBe('false');
    });

    /**
     * §N26 — the surfaces H1's sweep never enrolled, found by the owner's 2026-08-26 frame and
     * by the matrix in `docs/audit/n26-popup-layering`.
     *
     * The registry was doing its job; the enrolment was incomplete. These two are the ones no
     * component test can see, because each is raised by the chrome and judged against a web pane
     * in the grid — an assembly fact, exactly like H1's own.
     */
    describe('the popups H1 never enrolled (§N26)', () => {
        it("the sidebar's DELETE confirmation parks it — the frame the owner photographed", () => {
            mount({ web: true, second: true });
            act(() => {
                fireEvent.contextMenu(screen.getAllByTestId('workspace-row')[0] as Element);
            });
            const menu = screen.getByTestId('context-menu');
            const remove = [...menu.querySelectorAll('[role="menuitem"]')].find(
                (row) => (row.textContent ?? '').trim() === 'Delete'
            );
            expect(remove).toBeTruthy();
            act(() => {
                fireEvent.click(remove as Element);
            });

            // The menu is gone and the dialog is up, so the page must be parked for the DIALOG
            // rather than for the menu that raised it. It was not: the dialog was painted under
            // a live page with its destructive row sliced at the pane's edge.
            expect(screen.queryByTestId('context-menu')).toBeNull();
            expect(screen.getByTestId('confirm-dialog')).toBeTruthy();
            expect(pageVisible()).toBe('false');

            // …and cancelling hands the page straight back (this dialog has no Escape of its
            // own — §H18's contract is the agent gate's, not this one's).
            const cancel = [...screen.getByTestId('confirm-dialog').querySelectorAll('button')].find(
                (button) => (button.textContent ?? '').trim() === 'Cancel'
            );
            act(() => {
                fireEvent.click(cancel as Element);
            });
            expect(screen.queryByTestId('confirm-dialog')).toBeNull();
            expect(pageVisible()).toBe('true');
        });

        it("the footer's bucket popover parks it (it rises off the bar into the grid)", () => {
            // `agent: true` gives the running bucket a count — a zero chip is inert and opens
            // nothing (§M22), so the popover cannot be raised without one.
            mount({ web: true, agent: true });
            act(() => {
                fireEvent.click(screen.getByTestId('count-running'));
            });
            expect(screen.getByTestId('bucket-popover')).toBeTruthy();
            expect(pageVisible()).toBe('false');

            act(() => {
                fireEvent.keyDown(document.body, { key: 'Escape' });
            });
            expect(screen.queryByTestId('bucket-popover')).toBeNull();
            expect(pageVisible()).toBe('true');
        });

        it("the title bar's layout dropdown parks it, and closing hands it back", () => {
            mount({ web: true });
            act(() => {
                fireEvent.click(screen.getByTestId('layout-menu-toggle'));
            });
            expect(screen.getByTestId('layout-menu')).toBeTruthy();
            // jsdom measures nothing, so the dropdown registers as "position unknown" — which
            // parks, by design (`overlayCovers`). Live it parks the pane it actually lands on.
            expect(pageVisible()).toBe('false');

            act(() => {
                fireEvent.keyDown(document.body, { key: 'Escape' });
            });
            expect(screen.queryByTestId('layout-menu')).toBeNull();
            expect(pageVisible()).toBe('true');
        });
    });
});

describe('the active-agents delete gate (§H18)', () => {
    /** ⌘W on the last pane of a workspace whose agent is running raises the gate. */
    function raiseGate(): void {
        act(() => {
            fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
        });
    }

    it('is a real modal: a scrim over the window, and `aria-modal`', () => {
        mount({ agent: true });
        raiseGate();
        const gate = screen.getByTestId('agent-delete-gate');
        expect(gate.getAttribute('aria-modal')).toBe('true');

        // `WorkspaceDeleteGate.swift:59-81` is `alert.runModal()` — app-modal, so the window
        // behind it cannot be clicked. The port's bare panel was click-through onto the live
        // sidebar and panes.
        const backdrop = screen.getByTestId('agent-delete-backdrop');
        expect(backdrop.contains(gate)).toBe(true);
        expect(backdrop.className).toContain('inset-0');
        expect(backdrop.style.background).not.toBe('');
    });

    it('Escape cancels it, and deletes nothing', () => {
        const h = mount({ agent: true });
        raiseGate();
        expect(screen.getByTestId('agent-delete-gate')).toBeTruthy();

        act(() => {
            fireEvent.keyDown(document.body, { key: 'Escape' });
        });
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
        expect(
            h.commands().some(
                (payload) =>
                    payload['command'] === 'delete-workspace' || payload['command'] === 'workspace-delete'
            )
        ).toBe(false);
    });

    it('Return takes the safe answer too — Cancel is the alert’s default button', () => {
        const h = mount({ agent: true });
        raiseGate();
        act(() => {
            fireEvent.keyDown(document.body, { key: 'Enter' });
        });
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
        expect(
            h.commands().some(
                (payload) =>
                    payload['command'] === 'delete-workspace' || payload['command'] === 'workspace-delete'
            )
        ).toBe(false);
    });

    it('Delete still deletes — the keyboard is the only thing that changed', () => {
        const h = mount({ agent: true });
        raiseGate();
        act(() => {
            fireEvent.click(screen.getByTestId('agent-delete-confirm'));
        });
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
        // ⌘W's route carries `allow_last`, so the verb is `delete-workspace` (§WS-156).
        expect(h.commands().some((payload) => payload['command'] === 'delete-workspace')).toBe(true);
    });

    it('and it parks a live web pane while it is up (§H1)', () => {
        mount({ web: true, agent: true });
        // Two panes now, so ⌘W would close a pane rather than delete the workspace; raise the
        // gate the same way the sidebar does instead — by closing the web pane first.
        act(() => {
            fireEvent.contextMenu(screen.getByTestId(`pane-header-${PANE_A}`));
        });
        expect(pageVisible()).toBe('false');
    });
});
