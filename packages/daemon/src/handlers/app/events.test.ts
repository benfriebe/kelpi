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
                dedupeKey: `kelpi-${P1}`
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
                dedupeKey: `kelpi-${P1}`
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
                dedupeKey: `kelpi-${P1}`
            }
        ]);
    });

    it('defaults the message', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'error', pane_id: P1 });
        expect(h.broadcasts[0]).toMatchObject({ body: 'Unknown error' });
    });
});

describe('muted workspace (agent-lifecycle §7.6)', () => {
    it('marks the stop notification and attention request muted, keeping the pane status', () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'set-workspace-muted', id: W1, muted: true });
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
                dedupeKey: `kelpi-${P1}`,
                muted: true
            },
            { type: 'attention-request', paneID: P1, workspaceID: W1, muted: true }
        ]);
    });

    it('marks agent notifications and errors muted, errors included while focused', () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.dispatch({ type: 'set-workspace-muted', id: W1, muted: true });
        h.send({ command: 'error', pane_id: P1, message: 'boom' });
        expect(h.broadcasts).toEqual([expect.objectContaining({ kind: 'agent-error', muted: true })]);

        const unfocused = harness({ initial: seeded(1) });
        unfocused.dispatch({ type: 'set-workspace-muted', id: W1, muted: true });
        unfocused.send({ command: 'notification', pane_id: P1, title: 't', body: 'b' });
        expect(unfocused.broadcasts).toEqual([expect.objectContaining({ kind: 'agent-notification', muted: true })]);
    });

    it('mutes only the muted workspace, and follows the flag when it changes', () => {
        const h = harness({ initial: seeded(2) });
        h.dispatch({ type: 'set-workspace-muted', id: W2, muted: true });
        h.send({ command: 'stop', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P2 });
        expect(h.broadcasts.filter((message) => message['type'] === 'notification')).toEqual([
            expect.not.objectContaining({ muted: true }),
            expect.objectContaining({ workspaceID: W2, muted: true })
        ]);
        expect(h.broadcasts.filter((message) => message['muted'] === undefined)).toHaveLength(2);

        h.dispatch({ type: 'set-workspace-muted', id: W2, muted: false });
        h.send({ command: 'start', pane_id: P2 });
        h.send({ command: 'stop', pane_id: P2 });
        expect(h.broadcasts.slice(-2).every((message) => !('muted' in message))).toBe(true);
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

    it('records the reported launch profile, and keeps the last-known one when a line omits it', () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 'abc-123', agent: 'claude', profile: 'work' });
        expect(paneOf(h, P1)).toMatchObject({ agentSessionID: 'abc-123', agentProfileName: 'work' });

        // An older CLI's session-start carries no profile: the recorded one survives.
        h.send({ command: 'session-start', pane_id: P1, session_id: 'def-456', agent: 'claude' });
        expect(paneOf(h, P1)).toMatchObject({ agentSessionID: 'def-456', agentProfileName: 'work' });
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

    it('drops every event for a pane whose agent is being restarted (#372)', () => {
        let muted = false;
        const h = harness({ initial: seeded(1), agentEventsMuted: (paneID) => muted && paneID === P1 });
        h.send({ command: 'session-start', pane_id: P1, session_id: 'live' });

        // The dying agent's hooks: none of them may clear the session the restart resumes.
        muted = true;
        h.send({ command: 'session-end', pane_id: P1, session_id: 'live' });
        h.send({ command: 'start', pane_id: P1 });
        expect(paneOf(h, P1)).toMatchObject({ agentSessionID: 'live', status: 'idle' });

        muted = false;
        h.send({ command: 'session-end', pane_id: P1, session_id: 'live' });
        expect(paneOf(h, P1)?.agentSessionID).toBeNull();
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

describe('agent.event plugin events (#387, agent-lifecycle §7.7)', () => {
    /** A line's event is published once its dual-fire applied, or by the next microtask. */
    const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

    it('fires for the focused pane of an active app, where no desktop notification shows', async () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.send({ command: 'stop', pane_id: P1 });
        expect(h.broadcasts).toEqual([]);
        await settle();
        // An older CLI's line: none of the optional keys, and no `muted` key either.
        expect(h.agentEvents).toStrictEqual([
            { type: 'stop', paneID: P1, workspaceID: W1, agent: 'claude', status: 'waitingForInput' }
        ]);
    });

    it('marks a muted workspace muted: true', async () => {
        const h = harness({ initial: seeded(1) });
        h.dispatch({ type: 'set-workspace-muted', id: W1, muted: true });
        h.send({ command: 'notification', pane_id: P1, title: 't', body: 'b' });
        await settle();
        expect(h.agentEvents).toStrictEqual([
            {
                type: 'notification',
                paneID: P1,
                workspaceID: W1,
                agent: 'claude',
                status: 'waitingForInput',
                title: 't',
                body: 'b',
                muted: true
            }
        ]);
    });

    it('fires for a notification on a pane already waitingForInput (status unchanged)', async () => {
        const h = harness({ initial: seeded(1), isAppActive: () => true });
        h.send({ command: 'stop', pane_id: P1 });
        await settle();
        h.send({ command: 'notification', pane_id: P1, title: 'Claude', body: 'Approve Bash?' });
        await settle();
        expect(paneOf(h, P1)?.status).toBe('waitingForInput');
        expect(h.agentEvents.map((event) => [event.type, event.status])).toEqual([
            ['stop', 'waitingForInput'],
            ['notification', 'waitingForInput']
        ]);
    });

    it('fires for a stop while background tasks keep the pane running', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1, background_tasks: 2 });
        expect(h.broadcasts).toEqual([]);
        await settle();
        expect(h.agentEvents).toStrictEqual([
            { type: 'start', paneID: P1, workspaceID: W1, agent: 'claude', status: 'running' },
            { type: 'stop', paneID: P1, workspaceID: W1, agent: 'claude', status: 'running', backgroundTasks: 2 }
        ]);
    });

    it('publishes after the store applied the event, so pane state already agrees', async () => {
        const seen: [string, string | undefined][] = [];
        const h = harness({
            initial: seeded(1),
            emitAgentEvent: (event) => {
                seen.push([event.status, paneOf(h, P1)?.status]);
            }
        });
        h.send({ command: 'start', pane_id: P1 });
        await settle();
        h.send({ command: 'stop', pane_id: P1 });
        await settle();
        expect(seen).toEqual([
            ['running', 'running'],
            ['waitingForInput', 'waitingForInput']
        ]);
    });

    it('gives each of two lines in one tick its own event, against the state its line left', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1 });
        await settle();
        expect(h.agentEvents.map((event) => [event.type, event.status])).toEqual([
            ['start', 'running'],
            ['stop', 'waitingForInput']
        ]);
    });

    it('keeps the state its own line left when a pane-close follows in the same socket chunk', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'start', pane_id: P1 });
        h.send({ command: 'stop', pane_id: P1, last_assistant_message: 'Done.' });
        // The next line of the chunk, before any microtask: what `pane-close` does to the store.
        h.dispatch({ type: 'close-pane', workspaceID: W1, paneID: P1 });
        expect(paneOf(h, P1)).toBeUndefined();
        await settle();
        expect(h.agentEvents).toStrictEqual([
            { type: 'start', paneID: P1, workspaceID: W1, agent: 'claude', status: 'running' },
            {
                type: 'stop',
                paneID: P1,
                workspaceID: W1,
                agent: 'claude',
                status: 'waitingForInput',
                lastAssistantMessage: 'Done.'
            }
        ]);
    });

    it('sends nothing for an agentEventsMuted pane (#372) or an unknown pane', async () => {
        const h = harness({ initial: seeded(1), agentEventsMuted: (paneID) => paneID === P1 });
        h.send({ command: 'stop', pane_id: P1, session_id: 'live' });
        h.send({ command: 'notification', pane_id: P1 });
        h.send({ command: 'stop', pane_id: id('9999aaaa', 1), session_id: 'gone' });
        await settle();
        expect(h.agentEvents).toEqual([]);
    });

    it.each(['permission_prompt', 'idle_prompt'])('carries notification_type %s as notificationType', async (kind) => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'notification', pane_id: P1, title: 'Claude Code', body: 'Needs you', notification_type: kind });
        await settle();
        expect(h.agentEvents).toHaveLength(1);
        expect(h.agentEvents[0]).toMatchObject({ type: 'notification', notificationType: kind });
    });

    it('carries the final reply of a stop, and the truncated flag when the CLI cut it', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'stop', pane_id: P1, last_assistant_message: 'All 12 tests pass.' });
        h.send({
            command: 'stop',
            pane_id: P1,
            last_assistant_message: 'x'.repeat(100),
            last_assistant_message_truncated: true,
            transcript_path: '/tmp/t.jsonl'
        });
        await settle();
        expect(h.agentEvents[0]).toMatchObject({ lastAssistantMessage: 'All 12 tests pass.' });
        expect(h.agentEvents[0]).not.toHaveProperty('lastAssistantMessageTruncated');
        expect(h.agentEvents[1]).toMatchObject({
            lastAssistantMessage: 'x'.repeat(100),
            lastAssistantMessageTruncated: true,
            transcriptPath: '/tmp/t.jsonl'
        });
    });

    it('is one event per line through the dual-fire, carrying the session and kind it bound', async () => {
        const h = harness({ initial: seeded(1) });
        // A missed SessionStart: the codex stop's dual-fire binds the session.
        h.send({ command: 'stop', pane_id: P1, session_id: 'sess-1', agent: 'codex' });
        expect(h.agentEvents).toHaveLength(1);
        await settle();
        expect(h.agentEvents).toStrictEqual([
            {
                type: 'stop',
                paneID: P1,
                workspaceID: W1,
                agent: 'codex',
                sessionID: 'sess-1',
                status: 'waitingForInput'
            }
        ]);
    });

    it('pairs a dual-fire with its own line, so an unrelated line in the same tick leaves a held stop as built', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'stop', pane_id: P1 });
        // The next line of the chunk is no hook, but its session_id dual-fires a session-start.
        h.send({ command: 'ping', pane_id: P1, session_id: 'sess-ping' });
        expect(paneOf(h, P1)?.agentSessionID).toBe('sess-ping');
        await settle();
        expect(h.agentEvents).toStrictEqual([
            { type: 'stop', paneID: P1, workspaceID: W1, agent: 'claude', status: 'waitingForInput' }
        ]);
    });

    it('covers every verb: start, error, notification, session-start and session-end', async () => {
        const h = harness({ initial: seeded(1) });
        h.send({ command: 'session-start', pane_id: P1, session_id: 's1', transcript_path: '/tmp/s1.jsonl' });
        h.send({ command: 'start', pane_id: P1, session_id: 's1' });
        h.send({
            command: 'notification',
            pane_id: P1,
            agent: 'codex',
            title: 'Codex',
            body: 'Approval requested: Bash',
            background_tasks: 1,
            tool_name: 'Bash',
            transcript_path: '/tmp/s1.jsonl'
        });
        h.send({ command: 'error', pane_id: P1, message: 'boom' });
        h.send({ command: 'session-end', pane_id: P1, session_id: 's1' });
        await settle();
        expect(h.agentEvents).toStrictEqual([
            {
                type: 'session-start',
                paneID: P1,
                workspaceID: W1,
                agent: 'claude',
                sessionID: 's1',
                status: 'idle',
                transcriptPath: '/tmp/s1.jsonl'
            },
            { type: 'start', paneID: P1, workspaceID: W1, agent: 'claude', sessionID: 's1', status: 'running' },
            {
                type: 'notification',
                paneID: P1,
                workspaceID: W1,
                agent: 'claude',
                sessionID: 's1',
                status: 'running',
                title: 'Codex',
                body: 'Approval requested: Bash',
                transcriptPath: '/tmp/s1.jsonl',
                backgroundTasks: 1,
                toolName: 'Bash'
            },
            {
                type: 'error',
                paneID: P1,
                workspaceID: W1,
                agent: 'claude',
                sessionID: 's1',
                status: 'waitingForInput',
                message: 'boom'
            },
            // The session it ended is gone from the pane, so no sessionID.
            { type: 'session-end', paneID: P1, workspaceID: W1, agent: 'claude', status: 'waitingForInput' }
        ]);
    });
});
