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
 */

import { notificationDecision, type AgentEvent } from '@kelpi/core/agent';
import type { WsNotificationKind } from '@kelpi/protocol';

import { findPaneAnywhere, previewAgentEvent, workspaceByID } from '../../store/index.js';
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

export function applyAgentEvent(
    paneID: string,
    event: AgentEvent,
    ctx: AppContext,
    deps: AppDeps
): void {
    const state = ctx.store.getState();
    const location = findPaneAnywhere(state, paneID);
    if (location === null) return;
    const workspace = workspaceByID(state, location.workspaceID);
    if (workspace === null) return;

    const now = deps.now();
    const preview = previewAgentEvent(state, paneID, event, now);
    ctx.store.dispatch({
        type: 'pane-agent-event',
        paneID,
        event,
        now,
        workspaceID: workspace.id
    });
    if (preview === null) return;
    const { effects } = preview;

    // §3.6 / issue #178: a cleared session id must survive the next launch.
    if (effects.persistImmediately) deps.persistNow();
    else if (effects.changed && effects.persist) deps.persist();

    const pending = effects.notification;
    if (pending === null) return;

    const isFocused =
        deps.isPaneFocused !== null
            ? deps.isPaneFocused(paneID, workspace.id)
            : state.lastActiveWorkspaceID === workspace.id && workspace.focusedPaneID === paneID;
    const decision = notificationDecision(pending.source, {
        isFocused,
        isAppActive: deps.isAppActive(),
        backgroundTaskCount: preview.state.backgroundTaskCount
    });

    if (decision.shouldNotify) {
        ctx.broadcast({
            type: 'notification',
            kind: NOTIFICATION_KIND[pending.source],
            paneID,
            workspaceID: workspace.id,
            // A null title means "pane title, falling back to the workspace name".
            title: pending.title ?? location.pane.title ?? workspace.name,
            body: pending.body,
            dedupeKey: notificationDedupeKey(paneID)
        });
    }
    if (decision.shouldBounce) {
        ctx.broadcast({ type: ATTENTION_EVENT, paneID, workspaceID: workspace.id });
    }
}

export function eventHandlerEntries(deps: AppDeps): readonly (readonly [string, AppHandler])[] {
    return [
        forCommand('start', (msg, ctx) => {
            // A start while already running means the previous stop was missed; the machine
            // restarts the elapsed clock and zeroes the background count, which is the same
            // observable state as the app's "reset to idle first".
            applyAgentEvent(msg.pane_id, { type: 'agentStarted', agent: msg.agent }, ctx, deps);
        }),
        forCommand('stop', (msg, ctx) => {
            applyAgentEvent(
                msg.pane_id,
                { type: 'agentStopped', backgroundTaskCount: msg.background_tasks },
                ctx,
                deps
            );
        }),
        forCommand('error', (msg, ctx) => {
            applyAgentEvent(msg.pane_id, { type: 'agentError', message: msg.message }, ctx, deps);
        }),
        forCommand('notification', (msg, ctx) => {
            applyAgentEvent(
                msg.pane_id,
                {
                    type: 'notification',
                    title: msg.title,
                    body: msg.body,
                    backgroundTaskCount: msg.background_tasks
                },
                ctx,
                deps
            );
        }),
        forCommand('session-start', (msg, ctx) => {
            applyAgentEvent(
                msg.pane_id,
                {
                    type: 'sessionStarted',
                    sessionID: msg.session_id,
                    agent: msg.agent,
                    // The profile the hook saw in the agent's own environment — recorded so a
                    // later resume can spawn the pane with the same profile env.
                    ...(msg.profile !== undefined ? { profileName: msg.profile } : {})
                },
                ctx,
                deps
            );
        }),
        forCommand('session-end', (msg, ctx) => {
            applyAgentEvent(
                msg.pane_id,
                { type: 'sessionEnded', sessionID: msg.session_id },
                ctx,
                deps
            );
        })
    ];
}
