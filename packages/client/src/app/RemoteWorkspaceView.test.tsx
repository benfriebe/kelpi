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

interface Shape {
    readonly panes: Record<string, unknown>[];
    readonly layout: Record<string, unknown>;
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

function pane(id: string, type: string): Record<string, unknown> {
    return {
        id,
        type,
        label: null,
        title: null,
        workingDirectory: '/home/remote',
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
                isSyncInputActive: false,
                syncExcludedPaneIDs: [],
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
    it('renders the remote grid — a terminal for the shell pane, an honest placeholder for content', () => {
        const { runtime, calls } = remoteRuntime();
        render(
            <RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID={WS} />
        );
        // The activation contract: the remote daemon fans PTY bytes by what we report.
        expect(calls).toContain(`activate:${WS}`);
        // The shell pane mounts a real terminal host; the markdown pane says what it is not.
        expect(document.querySelector('[data-pane-id]')).toBeTruthy();
        expect(screen.getByTestId(`remote-pane-placeholder-${NOTE}`).textContent).toContain(
            'not supported on remote daemons yet'
        );
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
    function renderTiled(): { calls: string[] } {
        const { runtime, calls } = remoteRuntime(TILED_2X2);
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
        const { calls } = renderTiled();
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
        const { calls } = renderTiled();
        // "dL" is the left column's divider: its children are leaves, so a pane names it.
        const divider = screen.getByTestId('divider-dL');
        act(() => firePointer(divider, 'pointerdown', { clientX: 100, clientY: 299 }));
        act(() => firePointer(window, 'pointermove', { clientX: 100, clientY: 359 }));
        act(() => firePointer(window, 'pointerup', { clientX: 100, clientY: 359 }));
        expect(calls.some((call) => call.startsWith(`resize:${TILE[0]}:`))).toBe(true);
        expect(calls.some((call) => call.startsWith('ratio:'))).toBe(false);
    });

    it('says so when the workspace is gone or the daemon is still connecting', () => {
        const { runtime } = remoteRuntime();
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID="nope" />);
        expect(screen.getByTestId('remote-workspace-missing').textContent).toContain('Connecting to werk');
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
