import { describe, expect, it } from 'vitest';
import { activeAgentCount, activeAgentSummary, chromeStatusSummary, syncedPaneIDs, workspaceByID } from './derived.js';
import { previewAgentEvent } from './reducers/index.js';
import { harness, id, NOW, seededState, W1 } from './testing.js';
import type { DaemonState, DomainAction, Pane, WorkspaceState } from './types.js';

const P0 = id('dddddddd', 100);
const PA = id('eeeeeeee', 1);
const PB = id('eeeeeeee', 2);

function ws(state: DaemonState): WorkspaceState {
    return workspaceByID(state, W1) as WorkspaceState;
}

function pane(state: DaemonState, paneID: string): Pane {
    const workspace = ws(state);
    return (workspace.panes.find((candidate) => candidate.id === paneID) ??
        workspace.parkedPanes.find((candidate) => candidate.id === paneID)) as Pane;
}

function split(paneID: string): DomainAction {
    return { type: 'split-pane', workspaceID: W1, paneID, direction: 'horizontal', now: NOW };
}

describe('agent lifecycle', () => {
    it('starts the elapsed clock on a fresh run and resets the background count', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentStarted', agent: 'codex' },
            now: NOW
        });
        expect(pane(h.state(), P0)).toMatchObject({
            status: 'running',
            agentKind: 'codex',
            agentStartedAt: NOW,
            backgroundTaskCount: 0
        });
    });

    it('keeps the pane running while background tasks are in flight', () => {
        const h = harness(seededState());
        h.dispatch(
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'agentStarted', agent: 'claude' },
                now: NOW
            },
            {
                type: 'pane-agent-event',
                paneID: P0,
                event: { type: 'agentStopped', backgroundTaskCount: 2 },
                now: NOW + 1000
            }
        );
        expect(pane(h.state(), P0)).toMatchObject({
            status: 'running',
            backgroundTaskCount: 2,
            agentStartedAt: NOW // not reset mid-run
        });

        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentStopped', backgroundTaskCount: 0 },
            now: NOW + 2000
        });
        expect(pane(h.state(), P0)).toMatchObject({
            status: 'waitingForInput',
            backgroundTaskCount: 0
        });
    });

    it('clears a session id only when the ending session matches', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'sessionStarted', sessionID: 'new', agent: 'claude' },
            now: NOW
        });
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'sessionEnded', sessionID: 'old' },
            now: NOW
        });
        expect(pane(h.state(), P0).agentSessionID).toBe('new');
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'sessionEnded', sessionID: 'new' },
            now: NOW
        });
        expect(pane(h.state(), P0).agentSessionID).toBeNull();
    });

    it('clears only a waiting status, never a running one', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentError' },
            now: NOW
        });
        expect(pane(h.state(), P0).status).toBe('waitingForInput');
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'clearPaneStatus' },
            now: NOW
        });
        expect(pane(h.state(), P0).status).toBe('idle');

        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        const running = h.state();
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'clearPaneStatus' },
            now: NOW
        });
        expect(h.state()).toBe(running);
    });

    it('reaches parked panes too', () => {
        const h = harness(seededState());
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PA,
            filePath: '/docs/a.md',
            reusePaneID: P0,
            now: NOW
        });
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        expect(ws(h.state()).parkedPanes[0]).toMatchObject({ id: P0, status: 'running' });
        expect(activeAgentCount(ws(h.state()))).toBe(1);
    });

    it('is a total no-op for an unknown pane id', () => {
        const h = harness(seededState());
        const before = h.state();
        h.dispatch({
            type: 'pane-agent-event',
            paneID: 'ghost',
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        expect(h.state()).toBe(before);
    });

    it('previewAgentEvent exposes effects without mutating', () => {
        const h = harness(seededState());
        const preview = previewAgentEvent(
            h.state(),
            P0,
            { type: 'agentStopped', backgroundTaskCount: 3 },
            NOW
        );
        expect(preview?.effects.hasBackgroundWork).toBe(true);
        expect(preview?.effects.notification?.source).toBe('stop');
        expect(pane(h.state(), P0).status).toBe('idle');
        expect(previewAgentEvent(h.state(), 'ghost', { type: 'clearPaneStatus' }, NOW)).toBeNull();
    });

    it('tracks title, cwd and branch updates and bumps lastActivityAt', () => {
        const h = harness(seededState());
        const before = pane(h.state(), P0).lastActivityAt;
        h.dispatch(
            { type: 'pane-title-changed', paneID: P0, title: 'zsh', now: NOW + 60_000 },
            { type: 'pane-directory-changed', paneID: P0, directory: '/repo', now: NOW + 61_000 },
            { type: 'pane-branch-changed', paneID: P0, branch: 'main' }
        );
        expect(pane(h.state(), P0)).toMatchObject({
            title: 'zsh',
            workingDirectory: '/repo',
            gitBranch: 'main'
        });
        expect(pane(h.state(), P0).lastActivityAt).toBeGreaterThan(before);
    });

    it('summarises active agents across workspaces', () => {
        const h = harness(seededState());
        h.dispatch(split(PA), {
            type: 'pane-agent-event',
            paneID: PA,
            event: { type: 'agentStarted', agent: 'claude' },
            now: NOW
        });
        h.dispatch({
            type: 'pane-agent-event',
            paneID: P0,
            event: { type: 'sessionStarted', sessionID: 'idle-session', agent: 'claude' },
            now: NOW
        });
        expect(activeAgentSummary(h.state())).toEqual({ agentCount: 1, workspaceCount: 1 });
        expect(chromeStatusSummary(h.state())).toEqual({ running: 1, waiting: 0, inactive: 1 });
    });
});

describe('synchronise input', () => {
    it('needs two non-excluded shell panes to form a group', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        expect(syncedPaneIDs(ws(h.state()))).toEqual([]);

        h.dispatch(split(PA));
        expect(syncedPaneIDs(ws(h.state()))).toEqual([P0, PA]);

        h.dispatch({ type: 'set-sync-input-excluded', workspaceID: W1, paneID: PA, excluded: true });
        expect(syncedPaneIDs(ws(h.state()))).toEqual([]);
    });

    it('excludes non-shell panes even when they host a terminal', () => {
        const h = harness(seededState());
        h.dispatch(
            split(PA),
            {
                type: 'open-markdown-pane',
                workspaceID: W1,
                paneID: PB,
                filePath: '/docs/a.md',
                now: NOW
            },
            { type: 'set-sync-input-active', workspaceID: W1, active: true }
        );
        expect(syncedPaneIDs(ws(h.state()))).toEqual([P0, PA]);
    });

    it('clears exclusions on every activation transition but not on a repeated `sync on`', () => {
        const h = harness(seededState());
        h.dispatch(
            split(PA),
            { type: 'set-sync-input-active', workspaceID: W1, active: true },
            { type: 'set-sync-input-excluded', workspaceID: W1, paneID: PA, excluded: true }
        );
        expect(ws(h.state()).syncInputExcluded).toEqual([PA]);

        // Idempotent: `sync on` while already on keeps exclusions.
        const unchanged = h.state();
        h.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        expect(h.state()).toBe(unchanged);

        h.dispatch({ type: 'toggle-sync-input', workspaceID: W1 });
        expect(ws(h.state()).isSyncInputActive).toBe(false);
        expect(ws(h.state()).syncInputExcluded).toEqual([]);

        h.dispatch(
            { type: 'set-sync-input-excluded', workspaceID: W1, paneID: PA, excluded: true },
            { type: 'toggle-sync-input', workspaceID: W1 }
        );
        // Staged while off -> wiped by the transition.
        expect(ws(h.state()).syncInputExcluded).toEqual([]);
        expect(syncedPaneIDs(ws(h.state()))).toEqual([P0, PA]);
    });

    it('ignores exclusion requests for panes that are not visible', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        const before = h.state();
        h.dispatch({ type: 'set-sync-input-excluded', workspaceID: W1, paneID: 'ghost', excluded: true });
        expect(h.state()).toBe(before);
    });

    it('emits a sync-changed event when the shell-pane set changes while active', () => {
        const h = harness(seededState());
        h.dispatch({ type: 'set-sync-input-active', workspaceID: W1, active: true });
        const seen = h.events.length;
        h.dispatch(split(PA));
        const sync = h.events.slice(seen).filter((event) => event.kind === 'sync-changed');
        expect(sync).toHaveLength(1);
        expect(sync[0]).toMatchObject({ syncedPaneIDs: [P0, PA] });
    });
});
