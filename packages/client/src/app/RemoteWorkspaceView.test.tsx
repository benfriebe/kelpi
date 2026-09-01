import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KelpiRuntime } from '../state';
import { createKelpiStore } from '../state';
import { createFakePtyApi } from '../terminal/testing';
import { RemoteWorkspaceView } from './RemoteWorkspaceView';

afterEach(cleanup);

const WS = 'AAAAAAAA-0000-0000-0000-000000000001';
const SHELL = 'BBBBBBBB-0000-0000-0000-000000000001';
const NOTE = 'CCCCCCCC-0000-0000-0000-000000000001';

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

function remoteRuntime(): { runtime: KelpiRuntime; calls: string[] } {
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
                focusedPaneID: SHELL,
                zoomedPaneID: null,
                isSyncInputActive: false,
                syncExcludedPaneIDs: [],
                parkedPaneIDs: [],
                panes: [pane(SHELL, 'shell'), pane(NOTE, 'markdown')],
                layout: {
                    kind: 'split',
                    direction: 'horizontal',
                    ratio: 0.5,
                    first: { kind: 'leaf', paneID: SHELL },
                    second: { kind: 'leaf', paneID: NOTE }
                }
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
            setSplitRatio: vi.fn(() => Promise.resolve({ ok: true }))
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

    it('says so when the workspace is gone or the daemon is still connecting', () => {
        const { runtime } = remoteRuntime();
        render(<RemoteWorkspaceView daemonName="werk" runtime={runtime} workspaceID="nope" />);
        expect(screen.getByTestId('remote-workspace-missing').textContent).toContain('Connecting to werk');
    });
});
