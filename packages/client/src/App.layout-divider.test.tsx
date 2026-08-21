/**
 * §LAY-061 — assembly test for the divider drag that `pane-resize` cannot express.
 *
 * The unit tests either side of this one prove the halves: `PaneGrid.test.tsx` proves the
 * grid raises a commit with `paneID: null` for a divider whose two children are both splits,
 * and `daemon/src/ws/sync.test.ts` proves `set-split-ratio` moves that split. What is only
 * true if the app is WIRED is that the gesture reaches the socket at all — the previous
 * version of `onSetRatio` returned early on exactly that commit, so the drag was previewed and
 * then silently dropped. This drives the real App against a scripted daemon socket and watches
 * the frame leave.
 *
 * The 2×2 `tiled` layout is built by the daemon's own reducers (a hand-written tree could be a
 * shape the daemon never produces).
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@nex/daemon/store';
import type { JsonObject } from '@nex/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { firePointer, stubBoundingRect } from './grid/testing';
import { createNexRuntime, createNexStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANES = [
    'DDDDDDDD-0000-4000-8000-000000000001',
    'DDDDDDDD-0000-4000-8000-000000000002',
    'DDDDDDDD-0000-4000-8000-000000000003',
    'DDDDDDDD-0000-4000-8000-000000000004'
] as const;
const NOW = 1_755_500_000_000;
const SIZE = { width: 800, height: 600 };

/** One workspace, four panes, laid out `tiled` — root children are both splits. */
function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANES[0], name: 'dev', color: 'blue', now: NOW });
    for (const paneID of PANES.slice(1)) {
        store.dispatch({
            type: 'split-pane',
            workspaceID: W1,
            paneID,
            direction: 'horizontal',
            now: NOW
        });
    }
    store.dispatch({ type: 'select-layout', workspaceID: W1, kind: 'tiled' });
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

function setup() {
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
        completeHandshake(sockets.last(), { state: snapshotState() });
    });

    // jsdom measures everything as 0×0, so the grid would draw no dividers at all. Pin the
    // container's box and re-run the grid's own measurement (no ResizeObserver in jsdom, so it
    // listens for `resize`).
    const container = screen.getByTestId('pane-grid');
    Object.defineProperty(container, 'clientWidth', { configurable: true, value: SIZE.width });
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: SIZE.height });
    stubBoundingRect(container, { left: 0, top: 0, ...SIZE });
    act(() => {
        window.dispatchEvent(new Event('resize'));
    });

    return {
        commands: (): Record<string, unknown>[] =>
            sockets
                .last()
                .messages()
                .filter((message) => message['type'] === 'command')
                .map((message) => message['payload'] as Record<string, unknown>)
    };
}

afterEach(cleanup);

describe('LAY-061: dragging a divider no pane can address', () => {
    it('sends set-split-ratio for the root divider of a tiled layout', () => {
        const h = setup();
        const divider = screen.getByTestId('divider-d');
        // On the root bar, clear of the two column dividers' bands.
        act(() => firePointer(divider, 'pointerdown', { clientX: 399, clientY: 100 }));
        act(() => firePointer(window, 'pointermove', { clientX: 459, clientY: 100 }));
        act(() => firePointer(window, 'pointerup', { clientX: 459, clientY: 100 }));

        const sent = h.commands().filter((command) => command['command'] === 'set-split-ratio');
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.at(-1)).toMatchObject({ workspace_id: W1, split_path: 'd' });
        expect(sent.at(-1)?.['ratio']).toBeCloseTo((399 + 60) / 798, 6);
        // …and it is NOT spelled as a pane resize, which could only have named the wrong split.
        expect(h.commands().some((command) => command['command'] === 'pane-resize')).toBe(false);
    });

    it('still spells an addressable divider as pane-resize', () => {
        const h = setup();
        // "dL" is the left column's divider: its children are leaves, so a pane names it.
        const divider = screen.getByTestId('divider-dL');
        act(() => firePointer(divider, 'pointerdown', { clientX: 100, clientY: 299 }));
        act(() => firePointer(window, 'pointermove', { clientX: 100, clientY: 359 }));
        act(() => firePointer(window, 'pointerup', { clientX: 100, clientY: 359 }));

        expect(h.commands().some((command) => command['command'] === 'pane-resize')).toBe(true);
        expect(h.commands().some((command) => command['command'] === 'set-split-ratio')).toBe(false);
    });
});
