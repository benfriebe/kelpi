import { describe, expect, it } from 'vitest';

import { findPaneAnywhere } from '../../store/index.js';
import { harness, id, NOW, seeded } from './testing.js';

const W1 = id('aaaaaaaa', 1);
const W2 = id('aaaaaaaa', 2);
const P1 = id('dddddddd', 1);
const P2 = id('dddddddd', 2);
const PM = id('eeeeeeee', 1);

function paneOf(h: ReturnType<typeof harness>, paneID: string) {
    return findPaneAnywhere(h.state(), paneID)?.pane;
}

describe('start', () => {
    it('sets the pane running, records the agent kind and starts the clock', () => {
        const h = harness({ initial: seeded(1) });
        expect(h.send({ command: 'start', pane_id: P1, agent: 'codex' })).toEqual([]);
        expect(paneOf(h, P1)).toMatchObject({
            status: 'running',
            agentKind: 'codex',
            agentStartedAt: NOW,
            backgroundTaskCount: 0
        });
    });

    it('treats a start while already running as a fresh run (the missed stop is absorbed)', () => {
        let clock = NOW;
        const h = harness({ initial: seeded(1), now: () => clock });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1, background_tasks: 3 });
        clock = NOW + 60_000;
        h.send({ command: 'start', pane_id: P1 });
        expect(paneOf(h, P1)).toMatchObject({
            status: 'running',
            agentStartedAt: NOW + 60_000,
            backgroundTaskCount: 0
        });
    });

    it('defaults an absent/unknown agent to claude', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1, agent: 'gemini' });
        expect(paneOf(h, P1)?.agentKind).toBe('claude');
    });

    it('is a total no-op for a pane no workspace owns', () => {
        const h = harness({ initial: seeded(1) });
        const before = h.state();
        h.send({ command: 'start', pane_id: id('9999aaaa', 1) });
        expect(h.state()).toBe(before);
        expect(h.broadcasts).toEqual([]);
    });

    it('reaches a PARKED pane (its agent is still running)', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({
            type: 'open-markdown-pane',
            workspaceID: W1,
            paneID: PM,
            filePath: '/docs/a.md',
            reusePaneID: P1,
            now: NOW
        });
        expect(h.state().workspaces[0]?.parkedPanes.map((pane) => pane.id)).toEqual([P1]);
        h.send({ command: 'start', pane_id: P1 });
        expect(paneOf(h, P1)?.status).toBe('running');
    });
});

describe('stop', () => {
    it('flips to waitingForInput and notifies + bounces when nobody is watching', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1 });
        expect(paneOf(h, P1)?.status).toBe('waitingForInput');
        expect(h.broadcasts).toEqual([
            {
                type: 'notification',
                kind: 'agent-waiting',
                paneID: P1,
                workspaceID: W1,
                title: 'w1',
                body: 'Agent is waiting for input',
                dedupeKey: `nex-${P1}`
            },
            { type: 'attention-request', paneID: P1, workspaceID: W1 }
        ]);
    });

    it('uses the pane title over the workspace name', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'pane-title-changed', paneID: P1, title: 'vim README', now: NOW });
        h.send({ command: 'stop', pane_id: P1 });
        expect(h.broadcasts[0]).toMatchObject({ title: 'vim README' });
    });

    it('suppresses both when the pane is focused in the active workspace of an active client', () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.send({ command: 'stop', pane_id: P1 });
        expect(h.broadcasts).toEqual([]);
    });

    it('still notifies (but does not bounce) when a client is active on ANOTHER pane', () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.dispatch({ type: 'split-pane', workspaceID: W1, paneID: P2, direction: 'horizontal', now: NOW });
        h.send({ command: 'stop', pane_id: P1 });
        expect(h.broadcasts).toEqual([expect.objectContaining({ type: 'notification' })]);
    });

    it('keeps the pane RUNNING and stays silent while background work is in flight', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1, background_tasks: 2 });
        expect(paneOf(h, P1)).toMatchObject({ status: 'running', backgroundTaskCount: 2 });
        expect(h.broadcasts).toEqual([]);

        // The final empty Stop lands once the background units finish.
        h.send({ command: 'stop', pane_id: P1, background_tasks: 0 });
        expect(paneOf(h, P1)).toMatchObject({ status: 'waitingForInput', backgroundTaskCount: 0 });
        expect(h.broadcasts).toHaveLength(2);
    });

    it('defaults background_tasks to 0 when the field is absent', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'stop', pane_id: P1 });
        expect(paneOf(h, P1)?.backgroundTaskCount).toBe(0);
    });
});

describe('notification', () => {
    it('routes through the stop transition and posts the wire title/body', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'notification', pane_id: P1, title: 'Claude', body: 'Approve Bash?' });
        expect(paneOf(h, P1)?.status).toBe('waitingForInput');
        expect(h.broadcasts).toEqual([
            {
                type: 'notification',
                kind: 'agent-notification',
                paneID: P1,
                workspaceID: W1,
                title: 'Claude',
                body: 'Approve Bash?',
                dedupeKey: `nex-${P1}`
            }
        ]);
    });

    it('is NOT background-suppressed (a permission prompt is actionable) and never bounces', () => {
        const h = harness({ initial: seeded(1) });
        h.send({
            command: 'notification',
            pane_id: P1,
            title: 'Codex',
            body: 'Approval requested: Bash',
            background_tasks: 4
        });
        expect(paneOf(h, P1)).toMatchObject({ status: 'running', backgroundTaskCount: 4 });
        expect(h.broadcasts).toEqual([expect.objectContaining({ kind: 'agent-notification' })]);
    });

    it('is suppressed by focus like the stop path', () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.send({ command: 'notification', pane_id: P1, title: 't', body: 'b' });
        expect(h.broadcasts).toEqual([]);
    });

    it('defaults an absent title/body', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'notification', pane_id: P1 });
        expect(h.broadcasts[0]).toMatchObject({ title: 'Agent', body: '' });
    });
});

describe('error', () => {
    it('always posts, focused or not, with the Agent Error title', () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.send({ command: 'error', pane_id: P1, message: 'boom' });
        expect(paneOf(h, P1)?.status).toBe('waitingForInput');
        expect(h.broadcasts).toEqual([
            {
                type: 'notification',
                kind: 'agent-error',
                paneID: P1,
                workspaceID: W1,
                title: 'Agent Error',
                body: 'boom',
                dedupeKey: `nex-${P1}`
            }
        ]);
    });

    it('defaults the message', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'error', pane_id: P1 });
        expect(h.broadcasts[0]).toMatchObject({ body: 'Unknown error' });
    });
});

describe('session-start / session-end', () => {
    it('binds the session id and kind without touching status', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 'abc-123', agent: 'codex' });
        expect(paneOf(h, P1)).toMatchObject({
            agentSessionID: 'abc-123',
            agentKind: 'codex',
            status: 'idle'
        });
        expect(h.broadcasts).toEqual([]);
    });

    it('clears the id ONLY when it still matches, and persists immediately either way', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 'live' });
        const persistsBefore = h.persistsNow.length;

        h.send({ command: 'session-end', pane_id: P1, session_id: 'stale' });
        expect(paneOf(h, P1)?.agentSessionID).toBe('live');
        expect(h.persistsNow.length).toBe(persistsBefore + 1);

        h.send({ command: 'session-end', pane_id: P1, session_id: 'live' });
        expect(paneOf(h, P1)?.agentSessionID).toBeNull();
        expect(paneOf(h, P1)?.agentKind).toBe('claude');
        expect(h.persistsNow.length).toBe(persistsBefore + 2);
    });

    it('binds the session through the dual-fire on a bare stop', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'stop', pane_id: P1, session_id: 'dual-1', agent: 'codex' });
        expect(paneOf(h, P1)).toMatchObject({
            agentSessionID: 'dual-1',
            agentKind: 'codex',
            status: 'waitingForInput'
        });
    });

    it('does not dual-fire on session-end (its whole purpose is dropping the id)', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 'live' });
        h.send({ command: 'session-end', pane_id: P1, session_id: 'live' });
        expect(paneOf(h, P1)?.agentSessionID).toBeNull();
    });
});

describe('routing across workspaces', () => {
    it('targets the workspace that owns the pane, not the active one', () => {
        const h = harness({ initial: seeded(2) });
        expect(h.state().lastActiveWorkspaceID).toBe(W2);
        h.send({ command: 'stop', pane_id: P1 });
        expect(paneOf(h, P1)?.status).toBe('waitingForInput');
        expect(paneOf(h, P2)?.status).toBe('idle');
        expect(h.broadcasts[0]).toMatchObject({ workspaceID: W1 });
    });

    it('honors an injected focus predicate over the daemon-canonical one', () => {
        const h = harness({
            initial: seeded(1),
            isAppActive: () => true,
            isPaneFocused: () => false
        });
        h.send({ command: 'stop', pane_id: P1 });
        expect(h.broadcasts).toEqual([expect.objectContaining({ type: 'notification' })]);
    });
});
