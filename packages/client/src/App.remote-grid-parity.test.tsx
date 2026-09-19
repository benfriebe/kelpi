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
 *
 * #216 widened it to the VALUE props, which turned out to be the same failure wearing another
 * hat: `homeDirectory` unpassed printed a raw `/Users/…` in every remote pane header, and
 * `focusFollowsMouse` unpassed left hover-focus dead on a remote daemon's workspace. They get
 * the same treatment: a second list, `VALUE_GAPS`, compared exactly in both directions, so a
 * value prop added to the primary mount forces a decision here rather than being inherited by
 * one mount and silently not the other.
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
    'onDwellClear',
    /*
     * Pane chrome phase B. A `pane.chrome` presenter is ONE view per window with one frame, one
     * acknowledgement stream and one all-or-nothing failure latch; a remote workspace is a second
     * grid of a second daemon's panes inside the same window, so hosting one there would be a
     * second presenter for a placement the whole window has exactly one selection for. The remote
     * grid therefore keeps the bundled header, and these two are inert without it: the rename
     * request is raised by `onRequestRename` into `renameRequest`, which is itself a listed value
     * gap, and the failure toast has no presenter to report on.
     */
    'onRequestRename',
    'onPaneChromeFailure'
];

/**
 * The VALUE props the remote view does not pass, each with the reason it is not a bug (#216).
 * Same contract as `REMOTE_GAPS`: an entry here is a decision, and a gap that quietly closes
 * has to be struck from the list.
 */
const VALUE_GAPS: readonly string[] = [
    // The §AGNT-056 gate on the 600 ms dwell clear. Inert without `onDwellClear`, which is
    // itself a listed gap, and it reads THIS window's `shell-activation`, which says nothing
    // about a remote daemon.
    'dwellEnabled',
    // Terminal cols/rows for the resize badge. Needs a per-pane geometry registry fed by the
    // panes' own `onDimensionsChange`; absent, the badge degrades to pixels (`resizeBadgeText`).
    'getPaneDimensions',
    // "Open the inline rename field", raised by the context menu's Rename…, and the menu
    // (`onPaneContextMenu`) is a listed handler gap, so nothing here can raise the request.
    'renameRequest',
    // The terminal search overlay, drawn from the workspace's `searchingPaneID` and wired to the
    // window's search verbs; the remote CommandClient has no search spelling yet.
    'renderPaneOverlay',
    // One presenter per window (see `onRequestRename` above): the remote grid draws the bundled
    // header, so it neither opts into the placement nor feeds it the footer's change counts.
    'paneChromePresenter',
    'changesFor'
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

/**
 * Every prop that is NOT an `on*` handler: the data and render slots the grid draws from.
 *
 * Presence, not value: `homeDirectory={daemon.info?.home}` is a real pass even when the fixture
 * daemon sent no home, and a mount that stops passing the prop is what this is watching for.
 */
function values(props: Record<string, unknown>): string[] {
    return Object.keys(props)
        .filter((name) => !/^on[A-Z]/.test(name))
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
    const props = lastMount();
    // The DESKTOP grid, not the phone shell's: `focusFollowsMouse` is passed by that mount
    // alone. If a form-factor change ever made `phoneActive` true under jsdom, this is a
    // legible failure instead of a silent substitution of the other mount.
    expect(props).toHaveProperty('focusFollowsMouse');
    return props;
}

function renderRemote(): Record<string, unknown> {
    // Forget the primary window's mounts: without this, a remote view that stopped mounting a
    // grid at all would hand `lastMount()` the PRIMARY props back and pass vacuously.
    recorder.mounts.length = 0;
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

    it('gives the remote workspace every grid VALUE prop the primary window has, bar the listed gaps (#216)', () => {
        const primary = values(renderPrimary());
        cleanup();
        const remote = values(renderRemote());

        // The two the issue was filed for, so this cannot pass by both mounts dropping them.
        expect(primary).toContain('homeDirectory');
        expect(primary).toContain('focusFollowsMouse');
        const missing = primary.filter((name) => !remote.includes(name));
        expect(missing).toEqual([...VALUE_GAPS].sort());
        // Nothing in the gap list may quietly stop being a gap without being struck from it.
        expect(remote.filter((name) => VALUE_GAPS.includes(name))).toEqual([]);
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
