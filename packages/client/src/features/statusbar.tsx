import { useEffect, useMemo, type ReactNode } from 'react';
import type { WorkspaceState } from '@kelpi/daemon/store';
import { StatusFooter, type AgentBucket, type FooterAssociation, type StatusBarItem, type StatusFooterProps, type SystemStatsView } from '../chrome/StatusFooter';
import type { ChromePane } from '../chrome/types';
import { selectActiveWorkspace, selectAgentSummary, selectFocusedPaneID, type KelpiRuntime, type KelpiState } from '../state';
import { STATUSBAR_FEATURE } from './definitions';
import type { BundledFeatureBinding } from './feature';

export function statusItems(workspaces: readonly WorkspaceState[], bucket: AgentBucket): readonly StatusBarItem[] {
    return workspaces.flatMap(workspace => workspace.panes.filter(pane => bucket === 'running' ? pane.status === 'running'
        : bucket === 'waiting' ? pane.status === 'waitingForInput' : pane.status === 'idle' && pane.agentSessionID !== null).map(pane => ({
        paneID: pane.id, workspaceID: workspace.id, workspaceName: workspace.name, workspaceColor: workspace.color,
        paneTitle: pane.label ?? pane.title ?? pane.workingDirectory, status: pane.status, agentStartedAt: pane.agentStartedAt
    })));
}
/** Shared by native status presentation and the public chrome projection. */
export function statusbarModel(state: KelpiState, associations: readonly FooterAssociation[]) {
    const workspace = selectActiveWorkspace(state), focusedID = selectFocusedPaneID(state), chrome = state.settings.value.chrome;
    const focusedPane: ChromePane | null = workspace?.panes.find(pane => pane.id === focusedID) ?? null;
    const systemStats: SystemStatsView | undefined = state.systemStats.loaded ? {
        stats: state.systemStats.stats, history: state.systemStats.history, intervalMs: state.systemStats.intervalMs,
        showSystemStats: chrome.showSystemStats, enabled: chrome.enabledSystemStats, showGraphs: chrome.showSystemStatGraphs,
        graphStyle: chrome.sparklineStyle, graphColor: chrome.sparklineColor, graphWidth: chrome.sparklineWidth
    } : undefined;
    return { summary: selectAgentSummary(state), focusedPane, associations, systemStats,
        homeDirectory: state.daemon.info?.home,
        bucketItems: (bucket: AgentBucket) => statusItems(state.daemon.state.workspaces, bucket) };
}
export interface StatusbarActionHost {
    readonly runtime: KelpiRuntime;
    readonly activateWorkspace: (workspaceID: string) => void;
    readonly isPrimarySelected?: () => boolean;
    readonly handBackCaret: (paneID: string) => void;
}
/** A queued cross-workspace caret handoff must not steal focus after another navigation. */
export function createStatusbarActions(host: StatusbarActionHost) {
    let disposed = false, generation = 0;
    const pending = new Set<() => void>();
    const cancel = (): void => { for (const stop of pending) stop(); pending.clear(); };
    return {
        selectPane(workspaceID: string, paneID: string): void {
            const state = host.runtime.store.getState();
            if (disposed || state.ui.connection !== 'connected' || !state.daemon.hasSnapshot || state.daemon.desynced) throw new Error('Status navigation is unavailable.');
            if (!state.daemon.state.workspaces.some(workspace => workspace.id === workspaceID && workspace.panes.some(pane => pane.id === paneID))) throw new Error('Status pane is no longer available.');
            cancel(); const attempt = ++generation;
            host.activateWorkspace(workspaceID); host.runtime.focusPane(workspaceID, paneID); host.handBackCaret(paneID);
            let stop = (): void => {};
            const again = (): void => {
                pending.delete(stop); const current = host.runtime.store.getState();
                if (!disposed && host.isPrimarySelected?.() !== false && attempt === generation && selectActiveWorkspace(current)?.id === workspaceID && selectFocusedPaneID(current) === paneID) host.handBackCaret(paneID);
            };
            if (typeof requestAnimationFrame === 'function') { const id = requestAnimationFrame(again); stop = () => cancelAnimationFrame(id); }
            else { const id = setTimeout(again, 0); stop = () => clearTimeout(id); }
            pending.add(stop);
        },
        dispose() { disposed = true; generation++; cancel(); },
    };
}
export function useStatusbarActions(host: StatusbarActionHost) {
    // The constructor is effect-free. StrictMode's effect replay needs a fresh active scope.
    const actions = useMemo(() => {
        let current = createStatusbarActions(host);
        return { selectPane: (workspaceID: string, paneID: string) => current.selectPane(workspaceID, paneID),
            attach() { current = createStatusbarActions(host); }, dispose() { current.dispose(); } };
    }, [host.runtime, host.activateWorkspace, host.handBackCaret, host.isPrimarySelected]);
    useEffect(() => { actions.attach(); return () => actions.dispose(); }, [actions]);
    return actions;
}
export function bindStatusbarFeature(input: { model: ReturnType<typeof statusbarModel>; presentation: Pick<StatusFooterProps, 'bucket'>;
    contributions: ReactNode; contributionsKey: string; selectPane(workspaceID: string, paneID: string): void }): BundledFeatureBinding {
    return { definition: STATUSBAR_FEATURE, render: () => <StatusFooter {...input.model} {...input.presentation}
        contributions={input.contributions} contributionsKey={input.contributionsKey} onSelectPane={input.selectPane} /> };
}
