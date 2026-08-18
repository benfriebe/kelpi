/**
 * The pane agent status machine as a pure reducer.
 * Spec: docs/current/agent-lifecycle.md §5, workspace-feature.md §7.10.
 *
 *                  agentStarted            agentStopped(bg=0)
 *         idle ------------------> running -------------------> waitingForInput
 *          ^                        ^   |                            |    ^
 *          |     clearPaneStatus    |   | agentStopped(bg>0)         |    | agentError
 *          +------------------------+   +--(stays running)----------+    | (from any)
 *
 * Callers own routing: an event for a pane id no workspace contains is a total no-op
 * (invariant 1), and lifecycle events reach parked panes too (invariant 2).
 */

import {
    DEFAULT_ERROR_MESSAGE,
    ERROR_NOTIFICATION_TITLE,
    WAITING_NOTIFICATION_BODY
} from './types.js';
import type {
    AgentEvent,
    AgentEventEffects,
    AgentEventResult,
    PaneAgentState,
    PaneKind,
    PendingNotification
} from './types.js';

export interface AgentEventContext {
    /** Epoch ms used for `agentStartedAt`. */
    readonly now: number;
    /** Defaults to "shell"; only the manual override consults it. */
    readonly paneKind?: PaneKind | undefined;
}

interface EffectOverrides {
    readonly changed?: boolean;
    readonly persist?: boolean;
    readonly persistImmediately?: boolean;
    readonly refreshIndicators?: boolean;
    readonly notification?: PendingNotification | null;
    readonly removeDeliveredNotification?: boolean;
}

function effects(next: PaneAgentState, overrides: EffectOverrides = {}): AgentEventEffects {
    return {
        changed: overrides.changed ?? true,
        persist: overrides.persist ?? true,
        persistImmediately: overrides.persistImmediately ?? false,
        refreshIndicators: overrides.refreshIndicators ?? true,
        hasBackgroundWork: next.backgroundTaskCount > 0,
        notification: overrides.notification ?? null,
        removeDeliveredNotification: overrides.removeDeliveredNotification ?? false
    };
}

/** Shared by `agentStopped` and `notification` - both take the same transition (§5.3). */
function applyStop(
    state: PaneAgentState,
    backgroundTaskCount: number,
    now: number
): PaneAgentState {
    if (backgroundTaskCount > 0) {
        // The turn ended but background shells/subagents are still in flight: FORCE
        // running so the repeat Stops fired as each unit completes are idempotent.
        return {
            ...state,
            backgroundTaskCount,
            status: 'running',
            agentStartedAt: state.status === 'running' ? state.agentStartedAt : now
        };
    }
    return { ...state, backgroundTaskCount, status: 'waitingForInput' };
}

export function reduceAgentEvent(
    state: PaneAgentState,
    event: AgentEvent,
    context: AgentEventContext
): AgentEventResult {
    const now = context.now;
    switch (event.type) {
        case 'agentStarted': {
            // The elapsed clock restarts on every non-running → running transition, and
            // a `start` arriving while already running means the previous stop was missed
            // (the app resets the status to idle first) - so it is always a fresh run.
            const next: PaneAgentState = {
                ...state,
                agentStartedAt: now,
                status: 'running',
                agentKind: event.agent,
                backgroundTaskCount: 0
            };
            return { state: next, effects: effects(next) };
        }
        case 'agentStopped': {
            const next = applyStop(state, event.backgroundTaskCount, now);
            return {
                state: next,
                effects: effects(next, {
                    notification: {
                        source: 'stop',
                        title: null,
                        body: WAITING_NOTIFICATION_BODY
                    }
                })
            };
        }
        case 'notification': {
            const next = applyStop(state, event.backgroundTaskCount, now);
            return {
                state: next,
                effects: effects(next, {
                    notification: {
                        source: 'agentNotification',
                        title: event.title,
                        body: event.body
                    }
                })
            };
        }
        case 'agentError': {
            const next: PaneAgentState = {
                ...state,
                status: 'waitingForInput',
                backgroundTaskCount: 0
            };
            return {
                state: next,
                effects: effects(next, {
                    notification: {
                        source: 'error',
                        title: ERROR_NOTIFICATION_TITLE,
                        body: event.message ?? DEFAULT_ERROR_MESSAGE
                    }
                })
            };
        }
        case 'sessionStarted': {
            // Does NOT touch status or agentStartedAt; the count reset bounds a stuck
            // running state when a final empty Stop was lost.
            const next: PaneAgentState = {
                ...state,
                agentSessionID: event.sessionID,
                agentKind: event.agent,
                backgroundTaskCount: 0
            };
            return { state: next, effects: effects(next, { refreshIndicators: false }) };
        }
        case 'sessionEnded': {
            // Match guard: /clear and compaction fire SessionEnd(old) + SessionStart(new)
            // in either order; only the matching id is cleared. Always persists now.
            const matches = state.agentSessionID === event.sessionID;
            const next: PaneAgentState = matches ? { ...state, agentSessionID: null } : state;
            return {
                state: next,
                effects: effects(next, {
                    changed: matches,
                    persistImmediately: true,
                    refreshIndicators: false
                })
            };
        }
        case 'setPaneStatus': {
            const paneKind = context.paneKind ?? 'shell';
            if (paneKind !== 'shell') {
                // Status is a shell-only concept: a dispatch for any other pane type is a
                // complete no-op (no effects at all).
                return {
                    state,
                    effects: effects(state, {
                        changed: false,
                        persist: false,
                        refreshIndicators: false
                    })
                };
            }
            const next: PaneAgentState = {
                ...state,
                agentStartedAt:
                    event.status === 'running' && state.status !== 'running'
                        ? now
                        : state.agentStartedAt,
                status: event.status,
                backgroundTaskCount: 0
            };
            return { state: next, effects: effects(next) };
        }
        case 'clearPaneStatus': {
            // Only waitingForInput is cleared - never clobber a run that started during
            // the client's 600 ms focus-dwell window.
            const cleared = state.status === 'waitingForInput';
            const next: PaneAgentState = cleared ? { ...state, status: 'idle' } : state;
            return {
                state: next,
                effects: effects(next, {
                    changed: cleared,
                    removeDeliveredNotification: true
                })
            };
        }
    }
}
