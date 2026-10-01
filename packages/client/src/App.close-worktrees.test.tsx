/**
 * ⌘W on the last pane and the workspace's worktrees (graft-git.md §8.7).
 *
 * Closing the last pane deletes the workspace. With `workspace-delete-worktrees = ask` and a
 * row that could be a linked worktree, ⌘W asks the daemon for the plan first and raises the
 * delete gate only when there is something to choose; a workspace that only works in a main
 * checkout still closes at once, without a round trip.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PANE_A = 'dddddddd-0000-4000-8000-000000000001';
const PANE_B = 'dddddddd-0000-4000-8000-000000000002';
const R1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const WORKTREE = '/Users/test/kelpi/worktrees/app/feature';
const NOW = 1_755_500_000_000;

afterEach(cleanup);

function snapshotState(rowPath: string): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'create-workspace', id: W2, paneID: PANE_B, name: 'beta', color: 'green', now: NOW });
    store.dispatch({
        type: 'add-repo',
        repo: { id: R1, path: '/Users/test/code/app', name: 'app', remoteURL: null, lastAccessedAt: 0, isAutoDiscovered: false }
    });
    store.dispatch({
        type: 'add-repo-association',
        workspaceID: W1,
        association: { id: 'A1', repoID: R1, worktreePath: rowPath, branchName: 'feature', isAutoDetected: false }
    });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

function mount(rowPath: string) {
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
        completeHandshake(sockets.last(), { state: snapshotState(rowPath) });
    });
    const frames = (name: string) =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command')
            .filter((message) => (message['payload'] as Record<string, unknown>)['command'] === name);
    return {
        commands: (name: string) => frames(name).map((message) => message['payload'] as Record<string, unknown>),
        async reply(name: string, reply: JsonObject): Promise<void> {
            await act(async () => {
                sockets.last().emit({ type: 'command-reply', id: frames(name).at(-1)?.['id'], reply });
                await Promise.resolve();
            });
        }
    };
}

function commandW(): void {
    act(() => {
        fireEvent.keyDown(window, { code: 'KeyW', key: 'w', metaKey: true });
    });
}

const PLAN = {
    ok: true,
    worktrees: [
        {
            worktree_path: WORKTREE,
            repo_path: '/Users/test/code/app',
            associations: [{ workspace_id: W1, association_id: 'A1' }],
            branch: 'feature',
            managed: true,
            commits_only_here: 0,
            blocked: null,
            recommended: true,
            branch_deletable: true
        }
    ]
};

describe('⌘W and the workspace worktrees (graft-git §8.7)', () => {
    it('asks for the plan, then raises the gate with the list, and deletes what was ticked', async () => {
        const h = mount(WORKTREE);
        commandW();
        expect(h.commands('worktree-cleanup-preview')).toEqual([{ command: 'worktree-cleanup-preview', workspace_ids: [W1] }]);
        expect(h.commands('delete-workspace')).toEqual([]);

        await h.reply('worktree-cleanup-preview', PLAN);
        const gate = screen.getByTestId('agent-delete-gate');
        expect(gate.getAttribute('aria-label')).toBe('Delete workspace');
        // No agents here, so no agents warning and no "Don't ask again" for them.
        expect(screen.queryByTestId('agent-delete-suppress')).toBeNull();
        expect((screen.getByTestId('worktree-cleanup-check') as HTMLInputElement).checked).toBe(true);

        act(() => {
            fireEvent.click(screen.getByTestId('agent-delete-confirm'));
        });
        expect(h.commands('delete-workspace')).toEqual([
            { command: 'delete-workspace', workspace_id: W1, force: true, allow_last: true, worktree_paths: [WORKTREE], delete_branches: true }
        ]);
    });

    it('a second ⌘W while the plan is out does not ask again', async () => {
        const h = mount(WORKTREE);
        commandW();
        commandW();
        expect(h.commands('worktree-cleanup-preview')).toHaveLength(1);
        await h.reply('worktree-cleanup-preview', { ok: true, worktrees: [] });
        expect(h.commands('delete-workspace')).toHaveLength(1);
    });

    it('closes at once when the plan has nothing to offer', async () => {
        const h = mount(WORKTREE);
        commandW();
        await h.reply('worktree-cleanup-preview', { ok: true, worktrees: [] });
        expect(screen.queryByTestId('agent-delete-gate')).toBeNull();
        expect(h.commands('delete-workspace')).toEqual([
            { command: 'delete-workspace', workspace_id: W1, force: true, allow_last: true }
        ]);
    });

    it('never asks git about a workspace that only works in its main checkout', () => {
        const h = mount('/Users/test/code/app');
        commandW();
        expect(h.commands('worktree-cleanup-preview')).toEqual([]);
        expect(h.commands('delete-workspace')).toEqual([
            { command: 'delete-workspace', workspace_id: W1, force: true, allow_last: true }
        ]);
    });
});
