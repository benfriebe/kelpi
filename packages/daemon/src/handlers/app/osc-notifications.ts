/**
 * §TERM-050 — turning one parsed OSC notification into a client broadcast.
 *
 * The Swift original is `AppReducer+SearchNotify.swift:68-79`: suppress when the pane is focused
 * **in the active workspace** and the app is frontmost; otherwise post, attributed to the pane.
 *
 * This is the sibling of `applyAgentEvent` in `./events.ts` and shares everything that matters
 * with it — the same suppression matrix (`notificationDecision`, whose `'osc'` branch has been
 * sitting unused since M4), the same parked-INCLUSIVE `findPaneAnywhere` routing, and the same
 * `kelpi-<paneID>` dedup identity, so an OSC notification REPLACES the pane's previous banner
 * rather than stacking beside it. What it does not share is a store dispatch: a notification is
 * a message *about* the pane, not activity *in* it, and the Swift reducer likewise leaves
 * `lastActivityAt` alone.
 *
 * It is a factory rather than a function so boot can hand it live presence readers and a test
 * can hand it a fixed state — the alternative was a closure buried in `compose.ts`, which is
 * exactly the shape that leaves a branch permanently unexercised.
 *
 * **Cross-workspace is the default, not a special case.** The lookup is by pane id and the
 * active workspace never enters it, so a pane in a background workspace notifies — and always
 * notifies, because a background pane can never be "attended".
 */

import { notificationDecision } from '@kelpi/core/agent';

import { findPaneAnywhere, workspaceByID, type DaemonState } from '../../store/index.js';
import type { OscNotification } from '../../term/index.js';
import { notificationDedupeKey } from './events.js';

export interface OscNotificationSinkDeps {
    readonly getState: () => DaemonState;
    /** "Some VISIBLE client has this pane focused." Nothing attached ⇒ false ⇒ still notify. */
    readonly isPaneFocused: (paneID: string, workspaceID: string) => boolean;
    readonly isAppActive: () => boolean;
    readonly broadcast: (message: Record<string, unknown>) => void;
}

export type OscNotificationSink = (paneID: string, notification: OscNotification) => void;

export function createOscNotificationSink(deps: OscNotificationSinkDeps): OscNotificationSink {
    return (paneID, notification) => {
        const state = deps.getState();
        const location = findPaneAnywhere(state, paneID);
        if (location === null) return;
        const workspace = workspaceByID(state, location.workspaceID);
        if (workspace === null) return;
        const decision = notificationDecision('osc', {
            isFocused: deps.isPaneFocused(paneID, workspace.id),
            isAppActive: deps.isAppActive(),
            // No agent behind an OSC, and `notificationDecision`'s `osc` branch ignores it.
            backgroundTaskCount: 0
        });
        if (!decision.shouldNotify) return;
        deps.broadcast({
            type: 'notification',
            kind: 'osc',
            paneID,
            workspaceID: workspace.id,
            // OSC 9 carries no title of its own; fall back the way `NotificationService` does.
            title: notification.title ?? location.pane.title ?? workspace.name,
            body: notification.body,
            dedupeKey: notificationDedupeKey(paneID)
        });
    };
}
