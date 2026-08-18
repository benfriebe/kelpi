import { describe, expect, it } from 'vitest';

import type { JsonObject, WsDeltaEvent } from '@nex/protocol';

import {
    AgentModel,
    dockBadgeLabel,
    newlyWaitingPanes,
    paneDisplayTitle,
    quitConfirmDetail,
    trayIndicator,
    traySummaryLines,
    trayTooltip
} from './agents.js';

function pane(id: string, status: string, extra: Record<string, unknown> = {}): JsonObject {
    return { id, status, title: null, label: null, ...extra } as JsonObject;
}

function snapshot(...workspaces: JsonObject[]): JsonObject {
    return { workspaces } as JsonObject;
}

describe('AgentModel.applySnapshot', () => {
    it('counts running and waiting panes across workspaces', () => {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot(
                {
                    id: 'w1',
                    name: 'alpha',
                    panes: [pane('p1', 'running'), pane('p2', 'waitingForInput'), pane('p3', 'idle')]
                } as JsonObject,
                { id: 'w2', name: 'beta', panes: [pane('p4', 'running')] } as JsonObject
            )
        );
        const counts = model.counts();
        expect(counts.running).toBe(2);
        expect(counts.waiting).toBe(1);
        expect(counts.workspaces.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
        expect(counts.waitingPaneIDs).toEqual(['p2']);
    });

    it('excludes parked panes (agent-lifecycle §8.1)', () => {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot({
                id: 'w1',
                name: 'alpha',
                panes: [pane('p1', 'running')],
                parkedPanes: [pane('p9', 'waitingForInput')]
            } as JsonObject)
        );
        expect(model.counts()).toMatchObject({ running: 1, waiting: 0 });
    });

    it('omits idle-only workspaces from the summary but keeps them known', () => {
        const model = new AgentModel();
        model.applySnapshot(snapshot({ id: 'w1', name: 'alpha', panes: [pane('p1', 'idle')] } as JsonObject));
        expect(model.counts().workspaces).toEqual([]);
        model.applyDelta({
            kind: 'agent-status-changed',
            workspaceID: 'w1',
            paneID: 'p1',
            status: 'running',
            agentSessionID: null,
            agentKind: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        });
        expect(model.counts().workspaces).toEqual([{ workspaceID: 'w1', name: 'alpha', running: 1, waiting: 0 }]);
    });

    it('replaces the whole mirror so a resync cannot leave a stale count', () => {
        const model = new AgentModel();
        model.applySnapshot(snapshot({ id: 'w1', name: 'alpha', panes: [pane('p1', 'waitingForInput')] } as JsonObject));
        expect(model.counts().waiting).toBe(1);
        model.applySnapshot(snapshot({ id: 'w2', name: 'beta', panes: [] } as JsonObject));
        expect(model.counts()).toMatchObject({ running: 0, waiting: 0 });
    });

    it('survives malformed entries', () => {
        const model = new AgentModel();
        model.applySnapshot({ workspaces: [null, 7, { name: 'no id' }, { id: 'w', panes: 'nope' }] } as JsonObject);
        expect(model.counts()).toMatchObject({ running: 0, waiting: 0 });
    });
});

describe('AgentModel.applyDelta', () => {
    const base = (): AgentModel => {
        const model = new AgentModel();
        model.applySnapshot(snapshot({ id: 'w1', name: 'alpha', panes: [pane('p1', 'running')] } as JsonObject));
        return model;
    };

    it('applies agent-status-changed transitions', () => {
        const model = base();
        model.applyDelta({
            kind: 'agent-status-changed',
            workspaceID: 'w1',
            paneID: 'p1',
            status: 'waitingForInput',
            agentSessionID: null,
            agentKind: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        });
        expect(model.counts()).toMatchObject({ running: 0, waiting: 1 });

        model.applyDelta({
            kind: 'agent-status-changed',
            workspaceID: 'w1',
            paneID: 'p1',
            status: 'idle',
            agentSessionID: null,
            agentKind: null,
            agentStartedAt: null,
            backgroundTaskCount: 0
        });
        expect(model.counts()).toMatchObject({ running: 0, waiting: 0 });
    });

    it('drops a pane that gets parked and re-adds it when it comes back visible', () => {
        const model = base();
        model.applyDelta({
            kind: 'pane-upserted',
            workspaceID: 'w1',
            paneID: 'p1',
            lane: 'parked',
            index: 0,
            pane: pane('p1', 'running')
        });
        expect(model.counts().running).toBe(0);
        model.applyDelta({
            kind: 'pane-upserted',
            workspaceID: 'w1',
            paneID: 'p1',
            lane: 'visible',
            index: 0,
            pane: pane('p1', 'running')
        });
        expect(model.counts().running).toBe(1);
    });

    it('forgets panes and workspaces that are removed', () => {
        const model = base();
        model.applyDelta({ kind: 'pane-removed', workspaceID: 'w1', paneID: 'p1' });
        expect(model.counts().running).toBe(0);
        model.applySnapshot(snapshot({ id: 'w1', name: 'alpha', panes: [pane('p1', 'running')] } as JsonObject));
        model.applyDelta({ kind: 'workspace-removed', id: 'w1' });
        expect(model.counts().running).toBe(0);
    });

    it('renames a workspace without losing its panes', () => {
        const model = base();
        model.applyDelta({
            kind: 'workspace-upserted',
            id: 'w1',
            workspace: { id: 'w1', name: 'renamed' } as JsonObject
        });
        expect(model.counts().workspaces[0]).toMatchObject({ name: 'renamed', running: 1 });
    });

    it('ignores unrelated delta kinds', () => {
        const model = base();
        const events: WsDeltaEvent[] = [
            { kind: 'focus-changed', workspaceID: 'w1', focusedPaneID: 'p1', focusHistory: [] },
            { kind: 'active-workspace-changed', workspaceID: 'w1' },
            { kind: 'repos-changed', repos: [] }
        ];
        model.applyDeltas(events);
        expect(model.counts().running).toBe(1);
    });
});

describe('derivations', () => {
    const counts = (running: number, waiting: number) => {
        const model = new AgentModel();
        const panes: JsonObject[] = [];
        for (let index = 0; index < running; index += 1) panes.push(pane(`r${String(index)}`, 'running'));
        for (let index = 0; index < waiting; index += 1) panes.push(pane(`w${String(index)}`, 'waitingForInput'));
        model.applySnapshot(snapshot({ id: 'w1', name: 'alpha', panes } as JsonObject));
        return model.counts();
    };

    it('badges the waiting count only (§8.4)', () => {
        expect(dockBadgeLabel(counts(0, 0))).toBe('');
        expect(dockBadgeLabel(counts(3, 0))).toBe('');
        expect(dockBadgeLabel(counts(3, 2))).toBe('2');
    });

    it('lets waiting win over running (§8.2)', () => {
        expect(trayIndicator(counts(0, 0), true)).toBe('idle');
        expect(trayIndicator(counts(4, 0), true)).toBe('running');
        expect(trayIndicator(counts(4, 1), true)).toBe('waiting');
        expect(trayIndicator(counts(4, 1), false)).toBe('disconnected');
    });

    it('summarises per workspace, waiting first', () => {
        expect(traySummaryLines(counts(0, 0))).toEqual(['All clear']);
        expect(traySummaryLines(counts(2, 1))).toEqual(['alpha — 1 waiting, 2 running']);
        expect(traySummaryLines(counts(2, 1), false)).toEqual(['Daemon not reachable']);
        expect(trayTooltip(counts(2, 1), true)).toBe('Nex — 1 waiting, 2 running');
        expect(trayTooltip(counts(0, 0), true)).toBe('Nex — all clear');
        expect(trayTooltip(counts(0, 0), false)).toBe('Nex — daemon not reachable');
    });

    it('reports only the panes that newly entered waiting', () => {
        expect(newlyWaitingPanes(['a'], ['a', 'b'])).toEqual(['b']);
        expect(newlyWaitingPanes(['a', 'b'], ['a'])).toEqual([]);
        expect(newlyWaitingPanes([], [])).toEqual([]);
    });

    it('titles panes as title ?? label ?? Shell', () => {
        expect(paneDisplayTitle(pane('p', 'running', { title: 'vim', label: 'edit' }))).toBe('vim');
        expect(paneDisplayTitle(pane('p', 'running', { label: 'edit' }))).toBe('edit');
        expect(paneDisplayTitle(pane('p', 'running'))).toBe('Shell');
    });

    it('tells the truth about quitting: sessions keep running', () => {
        expect(quitConfirmDetail(counts(0, 0))).toContain('keep running in the background');
        const detail = quitConfirmDetail(counts(1, 1));
        expect(detail).toContain('2 agents across 1 workspace');
        expect(detail).toContain('keep running in the background');
        expect(detail).not.toContain('terminate');
    });
});
