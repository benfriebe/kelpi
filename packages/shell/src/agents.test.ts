import { describe, expect, it } from 'vitest';

import type { JsonObject, WsDeltaEvent } from '@nex/protocol';

import {
    ALL_CLEAR_GLYPH,
    AgentModel,
    RUNNING_GLYPH,
    WAITING_GLYPH,
    activitySummary,
    dockBadgeLabel,
    middleTruncate,
    newlyWaitingPanes,
    noLongerWaitingPanes,
    paneDisplayTitle,
    quitConfirmDetail,
    trayIndicator,
    trayMenuRows,
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

    /** §AGNT-077: the other direction — whose toast is now stale. */
    it('reports the panes that stopped waiting', () => {
        expect(noLongerWaitingPanes(['a', 'b'], ['a'])).toEqual(['b']);
        expect(noLongerWaitingPanes(['a'], ['a', 'b'])).toEqual([]);
        expect(noLongerWaitingPanes(['a'], [])).toEqual(['a']);
        expect(noLongerWaitingPanes([], ['a'])).toEqual([]);
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

// ---------------------------------------------------------------------------
// §AGNT-113 — the quit gate counts PARKED panes; §8.1's badge/tray do not
// ---------------------------------------------------------------------------

describe('active-agent summary (§AGNT-113)', () => {
    function withParked(): AgentModel {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot(
                {
                    id: 'w1',
                    name: 'alpha',
                    panes: [pane('p1', 'running')],
                    parkedPanes: [pane('p9', 'waitingForInput')]
                } as JsonObject,
                // A workspace whose ONLY live agent is parked: invisible to §8.1 entirely.
                {
                    id: 'w2',
                    name: 'beta',
                    panes: [pane('p2', 'idle')],
                    parkedPanes: [pane('p8', 'running')]
                } as JsonObject
            )
        );
        return model;
    }

    it('keeps parked panes out of the badge and the tray indicator', () => {
        const counts = withParked().counts();
        expect(counts.running).toBe(1);
        expect(counts.waiting).toBe(0);
        expect(dockBadgeLabel(counts)).toBe('');
        expect(trayIndicator(counts, true)).toBe('running');
        expect(counts.workspaces.map((entry) => entry.name)).toEqual(['alpha']);
    });

    it('counts them for the quit gate, workspaces included', () => {
        const counts = withParked().counts();
        expect(counts.parked).toBe(2);
        expect(activitySummary(counts)).toEqual({ agents: 3, workspaces: 2 });
        expect(quitConfirmDetail(counts)).toContain('3 agents across 2 workspaces');
    });

    it('moves a pane between the two lanes without double-counting it', () => {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot({ id: 'w1', name: 'alpha', panes: [pane('p1', 'running')] } as JsonObject)
        );
        model.applyDelta({
            kind: 'pane-upserted',
            workspaceID: 'w1',
            paneID: 'p1',
            lane: 'parked',
            pane: pane('p1', 'running')
        } as unknown as WsDeltaEvent);
        expect(model.counts()).toMatchObject({ running: 0, parked: 1 });

        model.applyDelta({
            kind: 'pane-upserted',
            workspaceID: 'w1',
            paneID: 'p1',
            lane: 'visible',
            pane: pane('p1', 'running')
        } as unknown as WsDeltaEvent);
        const restored = model.counts();
        expect(restored).toMatchObject({ running: 1, parked: 0 });
        expect(activitySummary(restored).agents).toBe(1);
    });

    it('applies an agent-status change to whichever lane holds the pane', () => {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot({
                id: 'w1',
                name: 'alpha',
                panes: [],
                parkedPanes: [pane('p9', 'running')]
            } as JsonObject)
        );
        model.applyDelta({
            kind: 'agent-status-changed',
            workspaceID: 'w1',
            paneID: 'p9',
            status: 'idle'
        } as unknown as WsDeltaEvent);
        expect(model.counts().parked).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// §AGNT-090…093 — the tray menu's per-workspace + per-pane rows
// ---------------------------------------------------------------------------

describe('tray menu rows (§AGNT-090…093)', () => {
    function populated(): AgentModel {
        const model = new AgentModel();
        model.applySnapshot(
            snapshot(
                {
                    id: 'w2',
                    name: 'beta',
                    panes: [pane('p3', 'running', { title: 'server' })]
                } as JsonObject,
                {
                    id: 'w1',
                    name: 'alpha',
                    panes: [
                        pane('p1', 'running', { title: 'build' }),
                        pane('p2', 'waitingForInput', { title: 'claude' })
                    ]
                } as JsonObject
            )
        );
        return model;
    }

    it('lists one header per workspace and one row per non-idle pane, sorted by name', () => {
        const rows = trayMenuRows(populated().counts(), true);
        expect(rows.map((row) => row.kind)).toEqual([
            'workspace',
            'pane',
            'pane',
            'workspace',
            'pane'
        ]);
        expect(rows[0]).toMatchObject({ kind: 'workspace', workspaceID: 'w1' });
        expect(rows[0]?.label).toBe(`${WAITING_GLYPH} alpha — 1 waiting, 1 running`);
        expect(rows[3]?.label).toBe(`${RUNNING_GLYPH} beta — 1 running`);
    });

    it('gives every pane row its own status glyph and its jump target', () => {
        const rows = trayMenuRows(populated().counts(), true);
        const paneRows = rows.filter((row) => row.kind === 'pane');
        expect(paneRows.map((row) => (row.kind === 'pane' ? row.paneID : ''))).toEqual([
            'p1',
            'p2',
            'p3'
        ]);
        expect(paneRows[0]?.label).toContain(RUNNING_GLYPH);
        expect(paneRows[0]?.label).toContain('build');
        expect(paneRows[1]?.label).toContain(WAITING_GLYPH);
        expect(paneRows[1]?.label).toContain('claude');
        // The click target is the pane AND its workspace: §8.5 switches workspace first.
        expect(paneRows[2]).toMatchObject({ paneID: 'p3', workspaceID: 'w2' });
    });

    it('keeps the two placeholder states as single disabled rows, with §AGNT-092’s checkmark', () => {
        const empty = new AgentModel().counts();
        expect(trayMenuRows(empty, true)).toEqual([
            { kind: 'message', label: `${ALL_CLEAR_GLYPH}  All clear` }
        ]);
        expect(trayMenuRows(empty, false)).toEqual([
            { kind: 'message', label: 'Daemon not reachable' }
        ]);
    });

    it('truncates a long pane title in the middle, keeping both ends', () => {
        expect(middleTruncate('short', 40)).toBe('short');
        const long = 'npm run build:watch --workspace=packages/client --verbose';
        const cut = middleTruncate(long, 21);
        expect(cut).toHaveLength(21);
        expect(cut.startsWith('npm run b')).toBe(true);
        expect(cut.endsWith('verbose')).toBe(true);
        expect(cut).toContain('…');
    });
});
