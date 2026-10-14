/**
 * Agent lifecycle events (socket-handlers.md §3, agent-lifecycle.md §5 + §7).
 *
 * All six are fire-and-forget. Routing uses the parked-INCLUSIVE pane lookup (a `kelpi open
 * --here` source shell keeps running its agent), and an event for a pane no workspace owns is
 * a total no-op.
 *
 * The state transition itself lives in `@kelpi/core/agent` (the store delegates to it); this
 * module owns the *daemon* half: persistence triggers and the notification/attention matrix.
 * `notification` deliberately routes through the agent-stopped transition, so a permission
 * prompt arriving mid-background-work keeps the pane `running` while still notifying
 * (`agentNotification` is not background-suppressed; the synthetic stop notification is).
 *
 * #387: every hook line the store applies also publishes one `agent.event` to plugins
 * (`./agent-events.ts`), whether or not a desktop notification is shown.
 */

import { notificationDecision, type AgentEvent } from '@kelpi/core/agent';
import type { WsNotificationKind } from '@kelpi/protocol';

import { dualFirePrimary, isDualFire } from '../../control/dual-fire.js';
import { findPaneAnywhere, previewAgentEvent, workspaceByID } from '../../store/index.js';
import { createAgentHookQueue, type AgentHookMessage } from './agent-events.js';
import { forCommand } from './common.js';
import type { AppContext, AppDeps, AppHandler } from './context.js';

/** Emitted alongside a notification when the daemon wants the shell to bounce the dock. */
export const ATTENTION_EVENT = 'attention-request';

const NOTIFICATION_KIND: Readonly<Record<'stop' | 'agentNotification' | 'error', WsNotificationKind>> = {
    stop: 'agent-waiting',
    agentNotification: 'agent-notification',
    error: 'agent-error'
};

/** Dedup identity preserved from the Swift app: a re-post replaces the pane's previous one. */
export function notificationDedupeKey(paneID: string): string {
    return `kelpi-${paneID}`;
}

/** True when the store applied the event (false for a muted, unknown or unowned pane). */
export function applyAgentEvent(
    paneID: string,
    event: AgentEvent,
    ctx: AppContext,
    deps: AppDeps
): boolean {
    // #372: the pane's agent is being restarted on a new terminal host; this is the old one dying.
    if (deps.agentEventsMuted(paneID)) return false;
    const state = ctx.store.getState();
    const location = findPaneAnywhere(state, paneID);
    if (location === null) return false;
    const workspace = workspaceByID(state, location.workspaceID);
    if (workspace === null) return false;

    const now = deps.now();
    const preview = previewAgentEvent(state, paneID, event, now);
    ctx.store.dispatch({
        type: 'pane-agent-event',
        paneID,
        event,
        now,
        workspaceID: workspace.id
    });
    if (preview === null) return true;
    const { effects } = preview;

    // §3.6 / issue #178: a cleared session id must survive the next launch.
    if (effects.persistImmediately) deps.persistNow();
    else if (effects.changed && effects.persist) deps.persist();

    const pending = effects.notification;
    if (pending === null) return true;

    const isFocused =
        deps.isPaneFocused !== null
            ? deps.isPaneFocused(paneID, workspace.id)
            : state.lastActiveWorkspaceID === workspace.id && workspace.focusedPaneID === paneID;
    const decision = notificationDecision(pending.source, {
        isFocused,
        isAppActive: deps.isAppActive(),
        backgroundTaskCount: preview.state.backgroundTaskCount,
        muted: workspace.muted
    });
    // §7.6: a muted workspace's events reach plugin observers only (`ws/sync.ts` gates them).
    const audience = decision.observersOnly ? { muted: true } : {};

    if (decision.shouldNotify) {
        ctx.broadcast({
            type: 'notification',
            kind: NOTIFICATION_KIND[pending.source],
            paneID,
            workspaceID: workspace.id,
            // A null title means "pane title, falling back to the workspace name".
            title: pending.title ?? location.pane.title ?? workspace.name,
            body: pending.body,
            dedupeKey: notificationDedupeKey(paneID),
            ...audience
        });
    }
    if (decision.shouldBounce) {
        ctx.broadcast({ type: ATTENTION_EVENT, paneID, workspaceID: workspace.id, ...audience });
    }
    return true;
}

export function eventHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    const hookEvents = createAgentHookQueue(deps.emitAgentEvent);
    /** Apply one lifecycle message, then build its `agent.event` and hold it for the line's dual-fire. */
    const apply = (msg: AgentHookMessage, event: AgentEvent, ctx: AppContext): void => {
        if (isDualFire(msg)) {
            // The second half of a hook line: it completes its own primary's event, adding none.
            // Another line's held event (this one's primary was a `ping`, say) keeps its own state.
            const completes = hookEvents.holds(dualFirePrimary(msg));
            if (!completes) hookEvents.flush();
            applyAgentEvent(msg.pane_id, event, ctx, deps);
            if (completes) hookEvents.complete(ctx.store.getState());
            return;
        }
        // An earlier line's held event goes out first; it was built from the state that line left.
        hookEvents.flush();
        if (applyAgentEvent(msg.pane_id, event, ctx, deps)) hookEvents.hold(msg, ctx.store.getState());
    };
    return [
        forCommand('start', (msg, ctx) => {
            // A start while already running means the previous stop was missed; the machine
            // restarts the elapsed clock and zeroes the background count, which is the same
            // observable state as the app's "reset to idle first".
            apply(msg, { type: 'agentStarted', agent: msg.agent }, ctx);
        }),
        forCommand('stop', (msg, ctx) => {
            apply(msg, { type: 'agentStopped', backgroundTaskCount: msg.background_tasks }, ctx);
        }),
        forCommand('error', (msg, ctx) => {
            apply(msg, { type: 'agentError', message: msg.message }, ctx);
        }),
        forCommand('notification', (msg, ctx) => {
            apply(
                msg,
                {
                    type: 'notification',
                    title: msg.title,
                    body: msg.body,
                    backgroundTaskCount: msg.background_tasks
                },
                ctx
            );
        }),
        forCommand('session-start', (msg, ctx) => {
            apply(
                msg,
                {
                    type: 'sessionStarted',
                    sessionID: msg.session_id,
                    agent: msg.agent,
                    // The profile the hook saw in the agent's own environment — recorded so a
                    // later resume can spawn the pane with the same profile env.
                    ...(msg.profile !== undefined ? { profileName: msg.profile } : {})
                },
                ctx
            );
        }),
        forCommand('session-end', (msg, ctx) => {
            apply(msg, { type: 'sessionEnded', sessionID: msg.session_id }, ctx);
        })
    ];
}
