/**
 * §APP-037 — what confirming a command-palette row owes the destination.
 *
 * Two clauses, both from `AppReducer+CommandPalette.swift:76-114`, which sets the sidebar's
 * scroll target AND sends `.refreshGitStatus` when a row is confirmed:
 *
 *   1. a workspace that was off-screen (or inside a collapsed group) is scrolled into view —
 *      the port activated it and left the sidebar where it was;
 *   2. the switch re-runs `git status` rather than landing on whatever the watcher last knew.
 *
 * jsdom has no layout, so clause 1 is asserted through the call the sidebar makes on the
 * destination's own row element — the mechanism, and the only observable part of it anywhere.
 * Clause 2 is asserted on the wire: the `workspace-repo-status` frame the client sends, and the
 * `refresh` flag on it.
 */

import type { JsonObject } from '@nex/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createNexRuntime, createNexStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const W2 = 'AAAAAAAA-0000-4000-8000-000000000002';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const PANE_B = 'DDDDDDDD-0000-4000-8000-000000000002';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    // Both workspaces track a repo, so the inspector/footer feed is live for either of them —
    // which is what makes the forced `git status` on arrival observable at all.
    for (const [workspaceID, suffix] of [
        [W1, 'alpha'],
        [W2, 'beta']
    ] as const) {
        store.dispatch({
            type: 'add-repo-association',
            workspaceID,
            association: {
                id: `assoc-${suffix}`,
                repoID: `repo-${suffix}`,
                worktreePath: `/Users/test/code/${suffix}`,
                branchName: 'main',
                isAutoDetected: false
            }
        });
    }
    // The client's active workspace is its own: leave alpha active and jump to beta.
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

/** Every `workspace-repo-status` command this client has put on the wire, in order. */
function repoStatusReads(socket: { messages(): Record<string, unknown>[] }): {
    workspaceID: string;
    refresh: boolean;
}[] {
    return socket
        .messages()
        .filter((message) => message['type'] === 'command')
        .map((message) => message['payload'] as Record<string, unknown> | undefined)
        .filter((payload): payload is Record<string, unknown> => payload?.['command'] === 'workspace-repo-status')
        .map((payload) => ({
            workspaceID: String(payload['workspace_id'] ?? ''),
            refresh: payload['refresh'] === true
        }));
}

afterEach(cleanup);

describe('command palette jump', () => {
    it('scrolls the confirmed workspace’s row into view', async () => {
        const scrolled: Element[] = [];
        Element.prototype.scrollIntoView = function (this: Element): void {
            scrolled.push(this);
        };
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
        render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
        act(() => {
            completeHandshake(sockets.last(), { state: snapshotState() });
        });

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input');
        act(() => {
            fireEvent.change(input as HTMLInputElement, { target: { value: 'beta' } });
        });
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        expect(row.textContent).toContain('beta');
        scrolled.length = 0;
        act(() => {
            fireEvent.click(row);
        });

        expect(store.getState().ui.activeWorkspaceID).toBe(W2);
        await waitFor(() => {
            // The sidebar's own row for the destination is what got scrolled.
            const rows = screen.getAllByTestId('workspace-row');
            const beta = rows.find((candidate) => candidate.textContent?.includes('beta'));
            expect(beta).toBeDefined();
            expect(scrolled.some((element) => element === beta || element.contains(beta as Node))).toBe(true);
        });
        vi.restoreAllMocks();
    });

    /**
     * §APP-037's other clause: the Swift confirm sends `.refreshGitStatus`, so arriving in a
     * workspace re-runs git. The inspector is SHUT here — which is the normal case for a palette
     * jump, and the case where the port previously read the watcher's last known values and
     * asked the daemon for nothing.
     */
    it('forces a git-status refresh for the workspace it lands on', async () => {
        Element.prototype.scrollIntoView = function (this: Element): void {
            /* no layout in jsdom; the other test owns this clause */
        };
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
        render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
        act(() => {
            completeHandshake(sockets.last(), { state: snapshotState() });
        });
        const socket = sockets.last();

        // The ambient feed for the workspace already on screen does NOT force git: a footer that
        // is always visible must not double the daemon's own polling.
        await waitFor(() => {
            expect(repoStatusReads(socket).length).toBeGreaterThan(0);
        });
        expect(repoStatusReads(socket).every((read) => !read.refresh)).toBe(true);

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input');
        act(() => {
            fireEvent.change(input as HTMLInputElement, { target: { value: 'beta' } });
        });
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        expect(row.textContent).toContain('beta');
        act(() => {
            fireEvent.click(row);
        });

        await waitFor(() => {
            const forced = repoStatusReads(socket).filter((read) => read.refresh);
            expect(forced).toEqual([{ workspaceID: W2, refresh: true }]);
        });
        // …and the forced read is spent once. The follow-up reads for the same workspace (a
        // delta, the 30 s poll) go back to the cheap form.
        const afterJump = repoStatusReads(socket).filter((read) => read.workspaceID === W2);
        expect(afterJump.filter((read) => read.refresh)).toHaveLength(1);
        vi.restoreAllMocks();
    });

    /**
     * One confirm, one command — found while sweeping N19's palette entry point.
     *
     * `CommandPalette.confirm` calls `item.run?.()` and then `props.onConfirm(item)`, and
     * `App`'s `onPaletteConfirm` used to call `item.run?.()` AGAIN for every
     * `kind === 'command'` item. A single ⌘P → Enter therefore fired every palette command
     * twice: two panes from "New Scratchpad" (live: the audit's `scratchpad-create` step read
     * `1 → 3, 2 scratchpad(s)`), two splits from "Split Right", and a silent no-op from a
     * toggle whose second call undid the first. Neither side's tests could see it — the
     * component's pass a mock `onConfirm`, and the ones above assert routing rather than
     * repetition — so the assertion that closes it counts what reached the WIRE.
     */
    it('runs a confirmed command exactly once', () => {
        Element.prototype.scrollIntoView = function (this: Element): void {
            /* no layout in jsdom */
        };
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
        render(<App runtime={runtime} createRenderer={createFakeRendererFactory().factory} />);
        act(() => {
            completeHandshake(sockets.last(), { state: snapshotState() });
        });
        const socket = sockets.last();

        act(() => {
            fireEvent.keyDown(window, { code: 'KeyP', key: 'p', metaKey: true });
        });
        const input = screen.getByTestId('command-palette').querySelector('input');
        act(() => {
            fireEvent.change(input as HTMLInputElement, { target: { value: 'New Scratchpad' } });
        });
        const row = screen.getAllByTestId('palette-row')[0] as HTMLElement;
        expect(row.textContent).toContain('New Scratchpad');
        act(() => {
            fireEvent.click(row);
        });

        const created = socket
            .messages()
            .filter((message) => message['type'] === 'command')
            .map((message) => message['payload'] as Record<string, unknown> | undefined)
            .filter((payload) => payload?.['command'] === 'create-scratchpad');
        expect(created).toHaveLength(1);
        vi.restoreAllMocks();
    });
});
