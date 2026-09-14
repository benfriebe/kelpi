/**
 * #144: the two `PaneGrid` mounts must agree on which gestures they commit.
 *
 * `PaneGrid` declares every callback optional, so a mount that forgets one loses the gesture
 * SILENTLY: the drag runs, the drop zone highlights, and `onMovePane?.()` is a no-op. That has
 * now been the failure twice for `RemoteWorkspaceView` (the divider commit in #54, the pane
 * move in #144), which is why this compares the mounts rather than testing one more callback.
 *
 * It mocks `PaneGrid` down to a prop recorder, renders the primary window and then the remote
 * view, and asserts that every `on*` handler the primary mount supplies is also supplied by the
 * remote one. The handlers the remote view deliberately leaves out are listed below WITH their
 * reason, and the list is compared exactly: adding a new callback to `App`, or closing one of
 * these gaps, has to come past this test.
 */

import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import type { JsonObject } from '@kelpi/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { RemoteWorkspaceView } from './app/RemoteWorkspaceView';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const recorder = vi.hoisted(() => ({ mounts: [] as Record<string, unknown>[] }));

// Both mounts import this same module (`./grid` from here, `../grid` from `app/`), so one
// mock records both. Everything else in the barrel stays real.
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

/**
 * Handlers the remote view does not pass, each because the primary shell (not the remote
 * pane area) owns the thing it drives, or because the verb has no remote spelling yet.
 * A NEW entry here is a decision, not an oversight, which is the whole point of the list.
 */
const REMOTE_GAPS: readonly string[] = [
    // The window owns the pane context menu and the window-level web-pane verbs; the remote
    // host explicitly stands its window shortcuts down (`blockWindowShortcuts`).
    'onPaneContextMenu',
    'onNewWebPane',
    // Document-pane header verbs (§TERM-103, M5). The remote DocumentPane renders, but these
    // buttons are still unwired against the owning daemon, tracked separately from #144.
    'onToggleMarkdownEdit',
    'onRefreshDiff',
    'onCopyDocument',
    'onSetFontSize',
    // Agent-status verbs: restart and the 600 ms focus-dwell clear (agent-lifecycle.md §5.8).
    'onRestartAgent',
    'onDwellClear'
];

/** One workspace, one pane: enough for either mount to render its grid. */
function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE, name: 'dev', color: 'blue', now: NOW });
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

/** The props the most recent `PaneGrid` mount received. */
function lastMount(): Record<string, unknown> {
    const props = recorder.mounts.at(-1);
    expect(props).toBeDefined();
    return props as Record<string, unknown>;
}

/** Every `on*` callback a mount actually supplied. */
function handlers(props: Record<string, unknown>): string[] {
    return Object.keys(props)
        .filter((name) => /^on[A-Z]/.test(name) && typeof props[name] === 'function')
        .sort();
}

function renderPrimary(): Record<string, unknown> {
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
    const renderers = createFakeRendererFactory();
    render(<App runtime={runtime} createRenderer={renderers.factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    return lastMount();
}

function renderRemote(): Record<string, unknown> {
    const sockets = createFakeSocketFactory();
    const runtime = createKelpiRuntime({
        url: 'ws://remote.test/ws',
        socketFactory: sockets.factory,
        store: createKelpiStore(),
        notifications: null
    });
    runtime.connect();
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={W1} />);
    return lastMount();
}

beforeEach(() => {
    recorder.mounts.length = 0;
});
afterEach(cleanup);

describe('PaneGrid mount parity (#144)', () => {
    it('gives the remote workspace every grid handler the primary window has, bar the listed gaps', () => {
        const primary = handlers(renderPrimary());
        cleanup();
        const remote = handlers(renderRemote());

        expect(primary).toContain('onMovePane');
        const missing = primary.filter((name) => !remote.includes(name));
        expect(missing).toEqual([...REMOTE_GAPS].sort());
        // Nothing in the gap list may quietly stop being a gap without being struck from it.
        expect(remote.filter((name) => REMOTE_GAPS.includes(name))).toEqual([]);
    });

    it('commits the direct-manipulation gestures on BOTH mounts', () => {
        // The gestures the grid completes on its own and then hands to the mount: a dropped
        // pane, a dragged divider, the empty-layout "New Pane" button. Each is a silent loss
        // when unwired, so neither mount may be missing one.
        const gestures = ['onMovePane', 'onSetRatio', 'onCreatePane'];
        const primary = handlers(renderPrimary());
        cleanup();
        const remote = handlers(renderRemote());
        expect(gestures.filter((name) => !primary.includes(name))).toEqual([]);
        expect(gestures.filter((name) => !remote.includes(name))).toEqual([]);
    });
});
