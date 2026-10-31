/** Hosts for the phone's cross-host units: a store mirror per host, no socket. */

import type { WorkspaceState } from '@kelpi/daemon/store';

import { createKelpiStore, type KelpiRuntime } from '../state';
import type { PhoneHostModel } from './model';

export interface FakePane {
    readonly id: string;
    readonly status?: 'idle' | 'running' | 'waitingForInput';
    readonly agentKind?: 'claude' | 'codex' | null;
    readonly title?: string;
}

export interface FakeWorkspace {
    readonly id: string;
    readonly name: string;
    readonly muted?: boolean;
    readonly panes: readonly FakePane[];
}

function workspaceRecord(workspace: FakeWorkspace): Record<string, unknown> {
    return {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.name,
        color: 'blue',
        icon: null,
        labels: [],
        muted: workspace.muted ?? false,
        profileName: null,
        repoAssociations: [],
        recentlyClosedCount: 0,
        webPanes: {},
        focusedPaneID: workspace.panes[0]?.id ?? null,
        zoomedPaneID: null,
        isSyncInputActive: false,
        syncInputExcluded: [],
        parkedPaneIDs: [],
        panes: workspace.panes.map((pane) => ({
            id: pane.id,
            type: 'shell',
            label: null,
            title: pane.title ?? 'zsh',
            workingDirectory: '/home/me',
            gitBranch: null,
            status: pane.status ?? 'idle',
            agentSessionID: null,
            agentKind: pane.agentKind ?? null,
            agentProfileName: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        })),
        layout: workspace.panes[0] === undefined ? null : { kind: 'leaf', paneID: workspace.panes[0].id }
    };
}

/** A host whose mirror holds these workspaces, connected unless told otherwise. */
export function fakeHost(key: string, workspaces: readonly FakeWorkspace[], connected = true): PhoneHostModel & { setWorkspaces(next: readonly FakeWorkspace[]): void } {
    const store = createKelpiStore();
    let seq = 0;
    const apply = (next: readonly FakeWorkspace[]): void => {
        seq += 1;
        store.getState().applySnapshot(seq, {
            workspaces: next.map(workspaceRecord),
            groups: [],
            topLevelOrder: next.map((workspace) => ({ kind: 'workspace', id: workspace.id })),
            lastActiveWorkspaceID: next[0]?.id ?? null,
            repos: [],
            labelPresets: []
        } as never);
    };
    apply(workspaces);
    store.getState().setConnectionStatus(connected ? 'connected' : 'reconnecting');
    return {
        key,
        name: key,
        kind: key === 'origin' ? 'origin' : 'phone',
        runtime: { store } as unknown as KelpiRuntime,
        removable: key !== 'origin',
        setWorkspaces: apply
    };
}

export type { WorkspaceState };
