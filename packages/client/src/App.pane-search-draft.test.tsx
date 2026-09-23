/**
 * The needle a find bar is HANDED, as the window assembles it: the pane search presenter's frame
 * and the native bar's seed.
 *
 * The daemon's `searchNeedle` trails the field by up to the 300 ms short-needle debounce and a round
 * trip, and the two bars change hands mid-search - a presenter that paints while the user is typing
 * into the native bar, the native bar coming back when a presenter fails. So both are handed the
 * needle this window typed while it is still on its way, and the daemon's once it has caught up.
 * `app/search-needle.test.ts` pins when a needle is in transit; this pins that `App` hands it over,
 * that the case toggle sends it rather than dropping it, and that a keystroke costs one render
 * rather than two.
 *
 * `PaneGrid` is mocked down to a prop recorder, as `App.remote-grid-parity.test.tsx` does: the
 * session (`search`), the write path (`searchActions`) and the native bar (`renderPaneOverlay`)
 * are exactly what the grid is given.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { SEARCH_DEBOUNCE_MS } from './app/search-needle';
import { completeHandshake, createFakeSocketFactory, type FakeWebSocket } from './connection';
import type { PaneSearchActions, PaneSearchSession } from './pane-search';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const recorder = vi.hoisted(() => ({ mounts: [] as Record<string, unknown>[] }));

vi.mock('./grid', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./grid')>();
    return {
        ...actual,
        PaneGrid: (props: Record<string, unknown>) => {
            recorder.mounts.push(props);
            return null;
        }
    };
});

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

/** The daemon's own reducers, so the search fields ride the envelope exactly as they would. */
function daemon(needle?: string) {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE, name: 'dev', color: 'blue', now: NOW });
    store.dispatch({ type: 'toggle-search', workspaceID: W1 });
    if (needle !== undefined) store.dispatch({ type: 'set-search-needle', workspaceID: W1, needle });
    return store;
}

function envelope(store: ReturnType<typeof daemon>): JsonObject {
    const state = store.getState() as unknown as { workspaces: { recentlyClosedPanes: readonly unknown[] }[] };
    return {
        ...(state as unknown as JsonObject),
        workspaces: state.workspaces.map((workspace) => {
            const { recentlyClosedPanes, ...rest } = workspace;
            return { ...rest, recentlyClosedCount: recentlyClosedPanes.length };
        })
    } as unknown as JsonObject;
}

interface Harness {
    socket(): FakeWebSocket;
    /** The terminal-search `set` payloads sent so far. */
    sets(): Record<string, unknown>[];
    /** The daemon storing a needle: the delta every attached window receives. */
    echo(needle: string): void;
    /** The daemon answering the last `set`, with every microtask the answer schedules run. */
    answer(): Promise<void>;
    grid(): { search: PaneSearchSession | null; searchActions: PaneSearchActions; seed(): string };
    mounts(): number;
}

let seq = 0;

function setup(): Harness {
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
        completeHandshake(sockets.last(), { state: envelope(daemon()) });
    });
    const commands = (): Record<string, unknown>[] =>
        sockets
            .last()
            .messages()
            .filter((message) => message['type'] === 'command');
    return {
        socket: () => sockets.last(),
        sets: () =>
            commands()
                .map((message) => message['payload'] as Record<string, unknown>)
                .filter((payload) => payload['command'] === 'terminal-search' && payload['action'] === 'set'),
        echo(needle) {
            const workspace = (envelope(daemon(needle))['workspaces'] as JsonObject[])[0]!;
            seq += 1;
            act(() => {
                sockets.last().emit({ type: 'delta', seq, events: [{ kind: 'workspace-upserted', id: W1, workspace }] });
            });
        },
        async answer() {
            const frame = [...commands()]
                .reverse()
                .find((message) => (message['payload'] as Record<string, unknown>)['action'] === 'set');
            if (frame === undefined) throw new Error('no set was sent');
            await act(async () => {
                sockets.last().emit({ type: 'command-reply', id: frame['id'] as string, reply: { ok: true } });
                for (let index = 0; index < 5; index += 1) await Promise.resolve();
            });
        },
        grid() {
            const props = recorder.mounts.at(-1)!;
            // The DESKTOP grid: `focusFollowsMouse` is passed by that mount alone.
            expect(props).toHaveProperty('focusFollowsMouse');
            const overlay = props['renderPaneOverlay'] as (paneID: string) => ReactElement<{ needle: string }> | null;
            return {
                search: props['search'] as PaneSearchSession | null,
                searchActions: props['searchActions'] as PaneSearchActions,
                seed: () => overlay(PANE)!.props.needle
            };
        },
        mounts: () => recorder.mounts.length
    };
}

beforeEach(() => {
    recorder.mounts.length = 0;
    seq = 0;
});
afterEach(cleanup);

describe('the needle a find bar is handed', () => {
    it('is the needle still in transit, for the presenter\'s frame and the native bar\'s seed alike', async () => {
        const h = setup();
        expect(h.grid().search?.needle).toBe('');
        // A short needle: it waits out the debounce, so the daemon has nothing yet.
        act(() => h.grid().searchActions.setNeedle(PANE, 'ab'));
        expect(h.sets()).toHaveLength(0);
        expect(h.grid().search?.needle).toBe('ab');
        expect(h.grid().seed()).toBe('ab');
        // The debounce runs out and the needle goes; still unanswered, so still handed over.
        await waitFor(() => expect(h.sets().at(-1)).toMatchObject({ needle: 'ab' }), { timeout: SEARCH_DEBOUNCE_MS * 4 });
        expect(h.grid().search?.needle).toBe('ab');
        // The daemon stores it (the delta comes before the reply) and answers.
        h.echo('ab');
        expect(h.grid().search?.needle).toBe('ab');
        const beforeAnswer = h.mounts();
        await h.answer();
        // Caught up, and the answer costs no render: the workspace already says the same thing.
        expect(h.mounts()).toBe(beforeAnswer);
        expect(h.grid().seed()).toBe('ab');
        // A later needle from somewhere else is not masked by the draft that was.
        h.echo('zz');
        expect(h.grid().search?.needle).toBe('zz');
        expect(h.grid().seed()).toBe('zz');
    });

    it('is sent at once, with the new case flag, when the toggle lands inside the debounce', async () => {
        const h = setup();
        act(() => h.grid().searchActions.setNeedle(PANE, 'ab'));
        act(() => h.grid().searchActions.setCaseSensitive(PANE, true));
        expect(h.sets()).toHaveLength(1);
        expect(h.sets()[0]).toMatchObject({ needle: 'ab', case_sensitive: true });
        // Flushed, not duplicated: nothing more goes out when the debounce would have run out.
        await new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 100));
        expect(h.sets()).toHaveLength(1);
    });

    it('is re-sent from the draft, not the daemon\'s older needle, when the toggle lands mid round trip', () => {
        const h = setup();
        act(() => h.grid().searchActions.setNeedle(PANE, 'abcd'));
        expect(h.sets()).toHaveLength(1);
        act(() => h.grid().searchActions.setCaseSensitive(PANE, true));
        expect(h.sets()).toHaveLength(2);
        expect(h.sets()[1]).toMatchObject({ needle: 'abcd', case_sensitive: true });
    });
});
