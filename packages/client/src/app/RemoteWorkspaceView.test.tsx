import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { decodePluginManifest, type PluginContributionInfo, type PluginInfo } from '@kelpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { firePointer, stubBoundingRect } from '../grid/testing';
import type { KelpiRuntime } from '../state';
import { createKelpiRuntime, createKelpiStore } from '../state';
import { createFakeSocketFactory, completeHandshake } from '../connection/testing';
import { PluginHostUIContext } from '../plugins/host-ui';
import { usePluginCommands } from '../plugins/commands';
import { createFakePtyApi } from '../terminal/testing';
import { RemoteWorkspaceView } from './RemoteWorkspaceView';
import { contentState } from '../content/testing';

afterEach(cleanup);

const WS = 'AAAAAAAA-0000-0000-0000-000000000001';
const SHELL = 'BBBBBBBB-0000-0000-0000-000000000001';
const NOTE = 'CCCCCCCC-0000-0000-0000-000000000001';
const TILE = [
    'DDDDDDDD-0000-0000-0000-000000000001',
    'DDDDDDDD-0000-0000-0000-000000000002',
    'DDDDDDDD-0000-0000-0000-000000000003',
    'DDDDDDDD-0000-0000-0000-000000000004'
] as const;
const SIZE = { width: 800, height: 600 };
/** The REMOTE machine's home, as its handshake reports it (#216). */
const HOME = '/home/remote';

interface Shape {
    readonly panes: Record<string, unknown>[];
    readonly layout: Record<string, unknown>;
    /** Sync input, as the mirror spells it on the wire (#216's `syncActive` pair). */
    readonly syncActive?: boolean;
    readonly syncExcluded?: readonly string[];
}

/** `a | b`: the default fixture, one shell and one content pane side by side. */
const SIDE_BY_SIDE: Shape = {
    panes: [pane(SHELL, 'shell'), pane(NOTE, 'markdown')],
    layout: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { kind: 'leaf', paneID: SHELL },
        second: { kind: 'leaf', paneID: NOTE }
    }
};

/** `(a / b) | (c / d)`: the 2x2 `tiled` shape whose ROOT divider no pane can name (§LAY-061). */
const TILED_2X2: Shape = {
    panes: TILE.map((id) => pane(id, 'shell')),
    layout: {
        kind: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: {
            kind: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: TILE[0] },
            second: { kind: 'leaf', paneID: TILE[1] }
        },
        second: {
            kind: 'split',
            direction: 'vertical',
            ratio: 0.5,
            first: { kind: 'leaf', paneID: TILE[2] },
            second: { kind: 'leaf', paneID: TILE[3] }
        }
    }
};

/** One shell pane whose cwd sits UNDER the remote home, so `~/…` is visible (#216). */
const UNDER_HOME: Shape = {
    panes: [pane(SHELL, 'shell', `${HOME}/src/kelpi`)],
    layout: { kind: 'leaf', paneID: SHELL }
};

function pane(id: string, type: string, workingDirectory = HOME): Record<string, unknown> {
    return {
        id,
        type,
        label: null,
        title: null,
        workingDirectory,
        gitBranch: null,
        status: 'idle',
        agentSessionID: null,
        agentKind: null,
        agentProfileName: null,
        agentStartedAt: null,
        backgroundTaskCount: 0
    };
}

function remoteRuntime(shape: Shape = SIDE_BY_SIDE): { runtime: KelpiRuntime; calls: string[] } {
    const store = createKelpiStore();
    store.getState().applySnapshot(0, {
        workspaces: [
            {
                id: WS,
                name: 'remote-ws',
                slug: 'remote-ws',
                color: 'blue',
                icon: null,
                profileName: null,
                repoAssociations: [],
                recentlyClosedCount: 0,
                webPanes: {},
                focusedPaneID: shape.panes[0]?.['id'] as string,
                zoomedPaneID: null,
                isSyncInputActive: shape.syncActive ?? false,
                syncInputExcluded: shape.syncExcluded ?? [],
                parkedPaneIDs: [],
                panes: shape.panes,
                layout: shape.layout
            }
        ],
        groups: [],
        topLevelOrder: [WS],
        lastActiveWorkspaceID: WS,
        repos: [],
        labelPresets: []
    });
    const calls: string[] = [];
    const runtime = {
        store,
        connection: { target: 'ws://remote.test/ws', status: 'idle', isConnected: false, on: () => () => {} },
        pty: createFakePtyApi(),
        commands: {
            registerCloseGuard: () => () => {},
            subscribeContent: (input: { paneID: string }) => {
                calls.push(`content:${input.paneID}`);
                return Promise.resolve({ ok: true, state: contentState({ paneID: input.paneID, text: 'Remote document', html: '<p>Remote document</p>' }) });
            },
            unsubscribeContent: () => Promise.resolve({ ok: true }),
            closePane: vi.fn((input: { paneID: string }) => {
                calls.push(`close:${input.paneID}`);
                return Promise.resolve({ ok: true });
            }),
            splitPane: vi.fn((input: { paneID: string; direction: string }) => {
                calls.push(`split:${input.paneID}:${input.direction}`);
                return Promise.resolve({ ok: true });
            }),
            renamePane: vi.fn(() => Promise.resolve({ ok: true })),
            toggleZoom: vi.fn(() => Promise.resolve({ ok: true })),
            setSplitRatio: vi.fn((paneID: string, share: number) => {
                calls.push(`resize:${paneID}:${share.toFixed(6)}`);
                return Promise.resolve({ ok: true });
            }),
            setSplitRatioAtPath: vi.fn((input: { workspaceID: string; splitPath: string; ratio: number }) => {
                calls.push(`ratio:${input.workspaceID}:${input.splitPath}:${input.ratio.toFixed(6)}`);
                return Promise.resolve({ ok: true });
            }),
            movePaneAdjacent: vi.fn((input: { target: string; anchor: string; zone: string }) => {
                calls.push(`move:${input.target}:${input.anchor}:${input.zone}`);
                return Promise.resolve({ ok: true });
            }),
            createPane: vi.fn((input: { workspace: string }) => {
                calls.push(`create:${input.workspace}`);
                return Promise.resolve({ ok: true });
            })
        },
        activateWorkspace: vi.fn((workspaceID: string) => {
            calls.push(`activate:${workspaceID}`);
        }),
        focusPane: vi.fn((workspaceID: string, paneID: string | null) => {
            calls.push(`focus:${workspaceID}:${String(paneID)}`);
        })
    };
    return { runtime: runtime as unknown as KelpiRuntime, calls };
}

describe('RemoteWorkspaceView (§1.7)', () => {
    it('renders remote terminal and document features through their owning runtime', async () => {
        const { runtime, calls } = remoteRuntime();
        render(
            <RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />
        );
        // The activation contract: the remote daemon fans PTY bytes by what we report.
        expect(calls).toContain(`activate:${WS}`);
        expect(document.querySelector('[data-pane-id]')).toBeTruthy();
        await waitFor(() => expect(calls).toContain(`content:${NOTE}`));
        expect(document.querySelector(`[data-document-pane="${NOTE}"]`)).toBeTruthy();
        expect(screen.queryByTestId(`remote-pane-placeholder-${NOTE}`)).toBeNull();
    });

    it('routes header gestures to the REMOTE commands', () => {
        const { runtime, calls } = remoteRuntime();
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />);
        fireEvent.click(screen.getByTestId(`pane-split-right-${SHELL}`));
        fireEvent.click(screen.getByTestId(`pane-close-${NOTE}`));
        expect(calls).toContain(`split:${SHELL}:horizontal`);
        expect(calls).toContain(`close:${NOTE}`);
    });

    /**
     * #54 (pane-layout.md §7.4): the remote view has NO `size` prop, so the grid measures its
     * container, which jsdom reports as 0x0 and draws no dividers for. Pin the box and re-run
     * the grid's own measurement (no ResizeObserver in jsdom, so it listens for `resize`), the
     * same way `App.layout-divider.test.tsx` does for the primary window.
     */
    function renderMeasured(shape: Shape = TILED_2X2): { calls: string[] } {
        const { runtime, calls } = remoteRuntime(shape);
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />);
        const container = screen.getByTestId('pane-grid');
        Object.defineProperty(container, 'clientWidth', { configurable: true, value: SIZE.width });
        Object.defineProperty(container, 'clientHeight', { configurable: true, value: SIZE.height });
        stubBoundingRect(container, { left: 0, top: 0, ...SIZE });
        act(() => {
            window.dispatchEvent(new Event('resize'));
        });
        return { calls };
    }

    /**
     * #54: the root divider of a 2x2 tiled layout has splits on BOTH sides, so `pane-resize`
     * cannot name it and the commit carries no pane. The view used to drop exactly that commit,
     * so on a remote daemon the divider previewed under the cursor and snapped back on release.
     * §7.4 says every drag commits; the path spelling (`set-split-ratio`, §LAY-061) is how.
     */
    it('commits a both-children-are-splits divider by split path to the REMOTE daemon (#54)', () => {
        const { calls } = renderMeasured();
        const divider = screen.getByTestId('divider-d');
        // On the root bar, clear of the two column dividers' bands (T-junction re-resolution).
        act(() => firePointer(divider, 'pointerdown', { clientX: 399, clientY: 100 }));
        act(() => firePointer(window, 'pointermove', { clientX: 459, clientY: 100 }));
        act(() => firePointer(window, 'pointerup', { clientX: 459, clientY: 100 }));
        const sent = calls.filter((call) => call.startsWith('ratio:'));
        expect(sent.length).toBeGreaterThan(0);
        // available = 798, firstSize = 399 at drag start, cumulative delta 60 (§7.4 maths).
        expect(sent.at(-1)).toBe(`ratio:${WS}:d:${((399 + 60) / 798).toFixed(6)}`);
        // ...and NOT as a pane resize, which could only have named the wrong split.
        expect(calls.some((call) => call.startsWith('resize:'))).toBe(false);
    });

    it('still spells an addressable divider as a pane resize on the REMOTE daemon', () => {
        const { calls } = renderMeasured();
        // "dL" is the left column's divider: its children are leaves, so a pane names it.
        const divider = screen.getByTestId('divider-dL');
        act(() => firePointer(divider, 'pointerdown', { clientX: 100, clientY: 299 }));
        act(() => firePointer(window, 'pointermove', { clientX: 100, clientY: 359 }));
        act(() => firePointer(window, 'pointerup', { clientX: 100, clientY: 359 }));
        expect(calls.some((call) => call.startsWith(`resize:${TILE[0]}:`))).toBe(true);
        expect(calls.some((call) => call.startsWith('ratio:'))).toBe(false);
    });

    /**
     * #144: the header drag commits through `onMovePane?.()`, which the view never passed, so
     * on a remote daemon the pane lifted, the drop zone highlighted and the drop was discarded
     * while the same gesture reordered a local workspace. The wire vocabulary is the second
     * half of the fix: `pane-move-adjacent` takes `right-of`, not the grid's `right`.
     */
    it('routes a header drag-and-drop to the REMOTE daemon as a pane move (#144)', () => {
        const { calls } = renderMeasured(SIDE_BY_SIDE);
        const header = screen.getByTestId(`pane-header-${SHELL}`);
        act(() => firePointer(header, 'pointerdown', { clientX: 40, clientY: 10, pointerId: 7 }));
        // Into the right half of the second pane (x 401..800), clear of its vertical centre.
        act(() => firePointer(window, 'pointermove', { clientX: 700, clientY: 300, pointerId: 7 }));
        act(() => firePointer(window, 'pointerup', { clientX: 700, clientY: 300, pointerId: 7 }));
        expect(calls).toContain(`move:${SHELL}:${NOTE}:right-of`);
    });

    it('says so when the workspace is gone or the daemon is still connecting', () => {
        const { runtime } = remoteRuntime();
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID="nope" />);
        expect(screen.getByTestId('remote-workspace-missing').textContent).toContain('Connecting to werk');
    });

    /**
     * #216: the grid's VALUE props, which this mount inherited less of than the primary one.
     *
     * `homeDirectory` and the focus-follows-mouse pair both come from THIS daemon's handshake:
     * the paths on screen are the remote machine's, so `~` needs the remote machine's home
     * (§APP-069), and the config that describes this workspace is the one that rode its own
     * `welcome`. Unpassed, the header printed a raw `/home/remote/…` and hover-focus was dead.
     */
    it("abbreviates a remote pane header's path against the REMOTE daemon's home (#216)", () => {
        const { runtime } = remoteRuntime(UNDER_HOME);
        runtime.store
            .getState()
            .setDaemonIdentity('client-1', { version: '0.1.0', build: 'test', pid: 4242, home: HOME });
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />);
        // Not `/home/remote/src/kelpi`, which is what an empty `homeDirectory` falls back to.
        expect(screen.getByTestId(`pane-title-${SHELL}`).textContent).toBe('~/src/kelpi');
    });

    it('focuses a remote pane on hover when the remote daemon has focus-follows-mouse on (#216)', () => {
        const { runtime, calls } = remoteRuntime();
        runtime.store.getState().applySettings({ general: { focusFollowsMouse: true, focusFollowsMouseDelay: 0 } });
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />);
        // React synthesises enter/leave from pointerover at the root container, as
        // `PaneGrid.test.tsx` does for the primary mount. `NOTE` is the unfocused pane.
        act(() =>
            screen
                .getByTestId(`pane-${NOTE}`)
                .dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body }))
        );
        expect(calls).toContain(`focus:${WS}:${NOTE}`);
    });

    it("wears the remote workspace's own SYNC badges (#216)", () => {
        const { runtime } = remoteRuntime({ ...SIDE_BY_SIDE, syncActive: true, syncExcluded: [NOTE] });
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />);
        expect(screen.getByTestId(`pane-sync-badge-${SHELL}`)).toBeTruthy();
        expect(screen.getByTestId(`pane-sync-off-badge-${NOTE}`)).toBeTruthy();
    });

    it('renders remote pane contributions from their own live state and dispatches only to that runtime', async () => {
        const pluginID = 'sample.remote-ui', commandID = `${pluginID}.run`, itemID = `${pluginID}.item`;
        const native = createDaemonStore(emptyDaemonState('/tmp'));
        native.dispatch({ type: 'create-workspace', id: WS, paneID: SHELL, name: 'Remote workspace', color: 'blue', now: 1 });
        native.dispatch({ type: 'open-markdown-pane', workspaceID: WS, paneID: NOTE, reusePaneID: SHELL, filePath: '/tmp/readme.md', now: 2 });
        const paneID = native.getState().workspaces[0]!.panes[0]!.id;
        const fixture = (name: string, ready: boolean) => {
            const sockets = createFakeSocketFactory();
            const runtime = createKelpiRuntime({ store: createKelpiStore(), url: `ws://${name}.test/ws`, socketFactory: sockets.factory, notifications: null });
            const plugin: PluginInfo = { manifest: decodePluginManifest({ id: pluginID, name, version: '1.0.0', apiVersion: 1, trust: 'full', backend: 'backend.mjs', contributes: {
                commands: [{ id: commandID, title: `${name} header action`, menu: 'pane.header', shortcut: 'ctrl+alt+r', when: { 'pane.type': 'markdown' }, enablement: { 'context.ready': true } }],
                items: [{ id: itemID, text: `${name} checks`, placement: 'pane.header', command: commandID }]
            } }), enabled: true, revision: 'r1', instanceID: `${name}-i1`, status: 'running', error: null };
            let state: PluginContributionInfo = { pluginID, instanceID: plugin.instanceID, sequence: 1, state: { context: { ready }, items: { [itemID]: { text: `From ${name}` } } } };
            const calls = vi.spyOn(runtime.commands, 'raw').mockImplementation(async payload => ({ ok: true, result: (
                payload['action'] === 'list' ? [plugin] : payload['action'] === 'identity' ? { daemonID: name } : payload['action'] === 'contributions' ? [state] : null
            ) as never }));
            runtime.connect(); completeHandshake(sockets.last(), { state: JSON.parse(JSON.stringify(native.getState())) });
            return { runtime, calls, plugin, sockets, update(next: boolean) {
                state = { ...state, sequence: state.sequence + 1, state: { ...state.state, context: { ready: next } } };
                sockets.last().emit({ type: 'plugin-event', event: { epoch: name, sequence: state.sequence, name: 'plugin.contributions.changed', pluginID: state.pluginID, data: state } });
            } };
        };
        const primary = fixture('primary', false), remote = fixture('remote', true);
        try {
            renderHook(() => usePluginCommands(primary.runtime, [], () => true));
            render(<PluginHostUIContext.Provider value={{ runtime: primary.runtime, request: () => null }}>
                <RemoteWorkspaceView daemonName="Remote" runtime={remote.runtime} workspaceID={WS} />
            </PluginHostUIContext.Provider>);
            const button = await screen.findByRole('button', { name: 'From remote' });
            expect(screen.queryByRole('button', { name: 'From primary' })).toBeNull();
            expect(button.hasAttribute('disabled')).toBe(false);
            fireEvent.click(button);
            expect(remote.calls.mock.calls.filter(([payload]) => payload['action'] === 'run').map(([payload]) => JSON.parse(String(payload['text'])))).toEqual([{ command: commandID, workspaceID: WS, paneID }]);
            fireEvent.click(screen.getByRole('button', { name: 'remote header action' }));
            expect(remote.calls.mock.calls.filter(([payload]) => payload['action'] === 'run')).toHaveLength(2);
            expect(primary.calls.mock.calls.some(([payload]) => payload['action'] === 'run')).toBe(false);

            const chord = new KeyboardEvent('keydown', { code: 'KeyR', ctrlKey: true, altKey: true, cancelable: true });
            fireEvent(window, chord);
            expect(chord.defaultPrevented).toBe(false);
            expect(remote.calls.mock.calls.filter(([payload]) => payload['action'] === 'run')).toHaveLength(2);
            await act(async () => { primary.update(true); remote.update(false); });
            await waitFor(() => expect(screen.getByRole('button', { name: 'From remote' }).hasAttribute('disabled')).toBe(true));
            expect(screen.getByRole('button', { name: 'remote header action' }).hasAttribute('disabled')).toBe(true);
            fireEvent.click(screen.getByRole('button', { name: 'From remote' }));
            expect(remote.calls.mock.calls.filter(([payload]) => payload['action'] === 'run')).toHaveLength(2);
            act(() => remote.sockets.last().emit({ type: 'plugins-changed', plugins: [{ ...remote.plugin, enabled: false, status: 'disabled' }] }));
            expect(screen.queryByRole('button', { name: 'From remote' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'remote header action' })).toBeNull();
        } finally { cleanup(); primary.runtime.dispose(); remote.runtime.dispose(); primary.calls.mockRestore(); remote.calls.mockRestore(); }
    });
});
