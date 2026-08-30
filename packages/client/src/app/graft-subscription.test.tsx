/**
 * `useGraft`'s subscription to the daemon's graft event stream (§GIT-044).
 *
 * `graft.test.ts` drives the controller directly and never mounts anything, so the half this
 * item is actually about — the client keeping its session mirror in step with `started` /
 * `updated` / `stopped` as they arrive, and *cancelling* that subscription on unmount — has no
 * coverage there. This file mounts the hook against a fake event source and pushes the exact
 * broadcast payloads `graft/wire.ts` produces.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useGraft, type GraftCommands, type GraftEventSource } from './graft';
import type { CommandReply } from '../connection';

const A1 = 'CCCCCCCC-0000-4000-8000-000000000001';
const A2 = 'CCCCCCCC-0000-4000-8000-000000000002';

afterEach(cleanup);

/** The `graft-changed` per-session object, exactly as `graftSessionEntry` emits it. */
function sessionEntry(
    associationID: string,
    status: string,
    branch = 'feature'
): Record<string, unknown> {
    return {
        association_id: associationID,
        worktree_path: `/work/${branch}`,
        parent_repo_root: '/work/repo',
        branch,
        status,
        last_sync_at: null
    };
}

interface Source extends GraftEventSource {
    /** Deliver one broadcast to every live listener. */
    emit(payload: Record<string, unknown>): void;
    readonly listeners: number;
}

function eventSource(): Source {
    const listeners = new Set<(payload: Record<string, unknown>) => void>();
    return {
        on(_event, listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        emit(payload) {
            for (const listener of [...listeners]) listener(payload);
        },
        get listeners() {
            return listeners.size;
        }
    };
}

/** The hook syncs on mount; this surface answers that call with an empty world. */
function quietCommands(): GraftCommands {
    const empty = async (): Promise<CommandReply> => ({ ok: true, sessions: [], orphans: [] });
    return {
        graftList: empty,
        graftStart: empty,
        graftStop: empty,
        graftRecoverOrphan: empty,
        graftDismissOrphan: empty
    };
}

describe('useGraft — the daemon event subscription (§GIT-044)', () => {
    it('tracks started → updated → stopped without anyone touching the toggle', async () => {
        const events = eventSource();
        const commands = quietCommands();
        const { result } = renderHook(() => useGraft({ commands, events }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(events.listeners).toBe(1);
        expect(result.current.state.sessions).toEqual({});

        // `started` — the engine published a session this client never asked for (another
        // window's toggle, or `kelpi graft start`).
        act(() => {
            events.emit({ type: 'graft-changed', sessions: [sessionEntry(A1, 'watching')] });
        });
        expect(result.current.state.sessions[A1]?.status).toBe('watching');
        expect(result.current.state.sessions[A1]?.parentRepoRoot).toBe('/work/repo');

        // `updated` — a sync pass in flight, then back to watching.
        act(() => {
            events.emit({ type: 'graft-changed', sessions: [sessionEntry(A1, 'syncing')] });
        });
        expect(result.current.state.sessions[A1]?.status).toBe('syncing');
        act(() => {
            events.emit({
                type: 'graft-changed',
                sessions: [sessionEntry(A1, 'watching'), sessionEntry(A2, 'watching', 'rival')]
            });
        });
        expect(Object.keys(result.current.state.sessions).sort()).toEqual([A1, A2]);

        // `stopped` — the engine's list is authoritative, so a session that left it is gone
        // here too. That is how a stop performed in another window reaches this one.
        act(() => {
            events.emit({ type: 'graft-changed', sessions: [sessionEntry(A2, 'watching', 'rival')] });
        });
        expect(result.current.state.sessions[A1]).toBeUndefined();
        expect(result.current.state.sessions[A2]?.branch).toBe('rival');
    });

    it('takes the orphan list from `graft-orphans` too', async () => {
        const events = eventSource();
        // Referentially stable, like the memoized command surface `App` passes.
        const commands = quietCommands();
        const { result } = renderHook(() => useGraft({ commands, events }));
        await act(async () => {
            await Promise.resolve();
        });

        act(() => {
            events.emit({
                type: 'graft-orphans',
                orphans: [
                    {
                        association_id: A1,
                        parent_repo_root: '/work/repo',
                        worktree_path: '/work/feature',
                        branch: 'feature'
                    }
                ]
            });
        });
        expect(result.current.state.orphans).toHaveLength(1);
        expect(result.current.state.orphans[0]?.parentRepoRoot).toBe('/work/repo');

        act(() => {
            events.emit({ type: 'graft-orphans', orphans: [] });
        });
        expect(result.current.state.orphans).toEqual([]);
    });

    it('is cancellable: unmounting drops the listener and later events change nothing', async () => {
        const events = eventSource();
        const commands = quietCommands();
        const { result, unmount } = renderHook(() => useGraft({ commands, events }));
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            events.emit({ type: 'graft-changed', sessions: [sessionEntry(A1, 'watching')] });
        });
        const before = result.current.state;
        expect(before.sessions[A1]?.status).toBe('watching');
        expect(events.listeners).toBe(1);

        unmount();
        expect(events.listeners).toBe(0);
        // Nothing is listening, so nothing is delivered — and nothing throws either.
        events.emit({ type: 'graft-changed', sessions: [] });
        expect(result.current.state).toBe(before);
    });

    it('ignores broadcasts that are not graft events', async () => {
        const events = eventSource();
        // Referentially stable, like the memoized command surface `App` passes.
        const commands = quietCommands();
        const { result } = renderHook(() => useGraft({ commands, events }));
        await act(async () => {
            await Promise.resolve();
        });
        act(() => {
            events.emit({ type: 'graft-changed', sessions: [sessionEntry(A1, 'watching')] });
            events.emit({ type: 'pane-output', paneID: A1 });
            events.emit({ type: 'snapshot', workspaces: [] });
        });
        expect(Object.keys(result.current.state.sessions)).toEqual([A1]);
        expect(result.current.state.orphans).toEqual([]);
    });
});
