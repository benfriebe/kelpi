import { describe, expect, it } from 'vitest';
import { reduceAgentEvent } from './machine.js';
import { initialPaneAgentState } from './types.js';
import type { AgentEvent, PaneAgentState, PaneStatus } from './types.js';

const T0 = 1_000;
const T1 = 5_000;

function run(
    state: PaneAgentState,
    event: AgentEvent,
    now = T1,
    paneKind?: 'shell' | 'markdown'
): ReturnType<typeof reduceAgentEvent> {
    return reduceAgentEvent(state, event, paneKind === undefined ? { now } : { now, paneKind });
}

function withStatus(status: PaneStatus, extra: Partial<PaneAgentState> = {}): PaneAgentState {
    return { ...initialPaneAgentState, status, agentStartedAt: T0, ...extra };
}

describe('agentStarted', () => {
    it('starts the elapsed clock on a fresh run and records the kind', () => {
        const { state, effects } = run(initialPaneAgentState, {
            type: 'agentStarted',
            agent: 'codex'
        });
        expect(state).toEqual({
            status: 'running',
            agentSessionID: null,
            agentKind: 'codex',
            agentStartedAt: T1,
            backgroundTaskCount: 0
        });
        expect(effects.persist).toBe(true);
        expect(effects.refreshIndicators).toBe(true);
        expect(effects.notification).toBeNull();
    });

    it('restarts the clock when a start arrives mid-run (the missed-stop reset)', () => {
        const { state } = run(withStatus('running'), { type: 'agentStarted', agent: 'claude' });
        expect(state.status).toBe('running');
        expect(state.agentStartedAt).toBe(T1);
    });

    it('clears a stale background count', () => {
        const { state, effects } = run(withStatus('running', { backgroundTaskCount: 4 }), {
            type: 'agentStarted',
            agent: 'claude'
        });
        expect(state.backgroundTaskCount).toBe(0);
        expect(effects.hasBackgroundWork).toBe(false);
    });
});

describe('agentStopped', () => {
    it('goes to waitingForInput when no background work remains', () => {
        const { state, effects } = run(withStatus('running'), {
            type: 'agentStopped',
            backgroundTaskCount: 0
        });
        expect(state.status).toBe('waitingForInput');
        expect(state.agentStartedAt).toBe(T0);
        expect(effects.hasBackgroundWork).toBe(false);
        expect(effects.notification).toEqual({
            source: 'stop',
            title: null,
            body: 'Agent is waiting for input'
        });
    });

    it('forces running while background work is in flight (issues #215/#220)', () => {
        const { state, effects } = run(withStatus('running'), {
            type: 'agentStopped',
            backgroundTaskCount: 2
        });
        expect(state.status).toBe('running');
        expect(state.backgroundTaskCount).toBe(2);
        expect(state.agentStartedAt).toBe(T0);
        expect(effects.hasBackgroundWork).toBe(true);
    });

    it('is idempotent across the repeat Stops that fire as units complete', () => {
        const first = run(withStatus('running'), { type: 'agentStopped', backgroundTaskCount: 3 });
        const second = run(first.state, { type: 'agentStopped', backgroundTaskCount: 1 }, 9_000);
        expect(second.state.status).toBe('running');
        expect(second.state.backgroundTaskCount).toBe(1);
        expect(second.state.agentStartedAt).toBe(T0);
        const final = run(second.state, { type: 'agentStopped', backgroundTaskCount: 0 }, 9_500);
        expect(final.state.status).toBe('waitingForInput');
        expect(final.effects.hasBackgroundWork).toBe(false);
    });

    it('starts the clock when background work arrives on a non-running pane', () => {
        const { state } = run(withStatus('idle', { agentStartedAt: null }), {
            type: 'agentStopped',
            backgroundTaskCount: 1
        });
        expect(state.status).toBe('running');
        expect(state.agentStartedAt).toBe(T1);
    });
});

describe('notification', () => {
    it('takes the agentStopped transition and carries the agent message', () => {
        const { state, effects } = run(withStatus('running'), {
            type: 'notification',
            title: 'Claude',
            body: 'Approval requested: Bash',
            backgroundTaskCount: 2
        });
        expect(state.status).toBe('running');
        expect(state.backgroundTaskCount).toBe(2);
        expect(effects.notification).toEqual({
            source: 'agentNotification',
            title: 'Claude',
            body: 'Approval requested: Bash'
        });
    });
});

describe('agentError', () => {
    it('surfaces as waitingForInput with a cleared count and an always-posted notification', () => {
        const { state, effects } = run(withStatus('running', { backgroundTaskCount: 5 }), {
            type: 'agentError',
            message: 'boom'
        });
        expect(state.status).toBe('waitingForInput');
        expect(state.backgroundTaskCount).toBe(0);
        expect(effects.notification).toEqual({
            source: 'error',
            title: 'Agent Error',
            body: 'boom'
        });
    });

    it('defaults the message', () => {
        const { effects } = run(initialPaneAgentState, { type: 'agentError' });
        expect(effects.notification?.body).toBe('Unknown error');
    });
});

describe('sessionStarted / sessionEnded', () => {
    it('binds the id and kind without touching status or the clock', () => {
        const { state, effects } = run(withStatus('running', { backgroundTaskCount: 2 }), {
            type: 'sessionStarted',
            sessionID: 'sess-1',
            agent: 'codex'
        });
        expect(state).toEqual({
            status: 'running',
            agentSessionID: 'sess-1',
            agentKind: 'codex',
            agentStartedAt: T0,
            backgroundTaskCount: 0
        });
        expect(effects.refreshIndicators).toBe(false);
        expect(effects.persist).toBe(true);
    });

    it('clears only a matching session id, and persists immediately either way', () => {
        const bound = withStatus('running', { agentSessionID: 'sess-1', agentKind: 'claude' });
        const matching = run(bound, { type: 'sessionEnded', sessionID: 'sess-1' });
        expect(matching.state.agentSessionID).toBeNull();
        expect(matching.state.agentKind).toBe('claude');
        expect(matching.effects.changed).toBe(true);
        expect(matching.effects.persistImmediately).toBe(true);

        const stale = run(bound, { type: 'sessionEnded', sessionID: 'sess-0' });
        expect(stale.state.agentSessionID).toBe('sess-1');
        expect(stale.effects.changed).toBe(false);
        expect(stale.effects.persistImmediately).toBe(true);
    });

    it('survives an out-of-order /clear (SessionEnd(old) after SessionStart(new))', () => {
        const bound = withStatus('running', { agentSessionID: 'old' });
        const restarted = run(bound, {
            type: 'sessionStarted',
            sessionID: 'new',
            agent: 'claude'
        });
        const ended = run(restarted.state, { type: 'sessionEnded', sessionID: 'old' });
        expect(ended.state.agentSessionID).toBe('new');
    });
});

describe('setPaneStatus', () => {
    it('overrides the status, resets the count and starts the clock on entering running', () => {
        const { state } = run(withStatus('waitingForInput'), {
            type: 'setPaneStatus',
            status: 'running'
        });
        expect(state.status).toBe('running');
        expect(state.agentStartedAt).toBe(T1);
        expect(state.backgroundTaskCount).toBe(0);
    });

    it('keeps the clock when already running', () => {
        const { state } = run(withStatus('running'), { type: 'setPaneStatus', status: 'running' });
        expect(state.agentStartedAt).toBe(T0);
    });

    it('is a complete no-op for non-shell panes', () => {
        const before = withStatus('idle', { backgroundTaskCount: 2 });
        const { state, effects } = run(before, { type: 'setPaneStatus', status: 'running' }, T1, 'markdown');
        expect(state).toBe(before);
        expect(effects).toEqual({
            changed: false,
            persist: false,
            persistImmediately: false,
            refreshIndicators: false,
            hasBackgroundWork: true,
            notification: null,
            removeDeliveredNotification: false
        });
    });
});

describe('clearPaneStatus', () => {
    it('clears waitingForInput and withdraws the delivered notification', () => {
        const { state, effects } = run(withStatus('waitingForInput'), { type: 'clearPaneStatus' });
        expect(state.status).toBe('idle');
        expect(effects.changed).toBe(true);
        expect(effects.removeDeliveredNotification).toBe(true);
    });

    it('never clobbers a run that restarted during the focus dwell', () => {
        const { state, effects } = run(withStatus('running'), { type: 'clearPaneStatus' });
        expect(state.status).toBe('running');
        expect(effects.changed).toBe(false);
        expect(effects.removeDeliveredNotification).toBe(true);
    });
});

describe('transition table', () => {
    const cases: ReadonlyArray<readonly [PaneStatus, AgentEvent, PaneStatus]> = [
        ['idle', { type: 'agentStarted', agent: 'claude' }, 'running'],
        ['running', { type: 'agentStarted', agent: 'claude' }, 'running'],
        ['waitingForInput', { type: 'agentStarted', agent: 'claude' }, 'running'],
        ['running', { type: 'agentStopped', backgroundTaskCount: 0 }, 'waitingForInput'],
        ['running', { type: 'agentStopped', backgroundTaskCount: 1 }, 'running'],
        ['idle', { type: 'agentStopped', backgroundTaskCount: 0 }, 'waitingForInput'],
        ['idle', { type: 'agentStopped', backgroundTaskCount: 2 }, 'running'],
        ['idle', { type: 'agentError' }, 'waitingForInput'],
        ['running', { type: 'agentError' }, 'waitingForInput'],
        ['running', { type: 'sessionStarted', sessionID: 's', agent: 'claude' }, 'running'],
        ['waitingForInput', { type: 'sessionEnded', sessionID: 's' }, 'waitingForInput'],
        ['waitingForInput', { type: 'clearPaneStatus' }, 'idle'],
        ['running', { type: 'clearPaneStatus' }, 'running'],
        ['idle', { type: 'clearPaneStatus' }, 'idle']
    ];

    it.each(cases)('%s + %o -> %s', (from, event, to) => {
        expect(run(withStatus(from), event).state.status).toBe(to);
    });

    it('keeps backgroundTaskCount > 0 implying running', () => {
        for (const event of [
            { type: 'agentStarted', agent: 'claude' } as const,
            { type: 'sessionStarted', sessionID: 's', agent: 'claude' } as const,
            { type: 'agentError' } as const,
            { type: 'setPaneStatus', status: 'idle' } as const
        ]) {
            const { state } = run(withStatus('running', { backgroundTaskCount: 7 }), event);
            expect(state.backgroundTaskCount).toBe(0);
        }
    });
});
