/**
 * The notification / attention suppression matrix.
 * Spec: docs/agent-lifecycle.md §7.1–7.3, invariant 6.
 *
 * The daemon supplies focus + visibility (multi-client: `isAppActive` = any connected
 * client is visible/focused, `isFocused` = that pane is the focused pane of the active
 * workspace in a focused client; both default false when no client is attached, so
 * headless operation still notifies).
 */

import type { NotificationSource } from './types.js';

export interface NotificationContext {
    readonly isFocused: boolean;
    readonly isAppActive: boolean;
    readonly backgroundTaskCount: number;
}

export interface NotificationDecision {
    readonly shouldNotify: boolean;
    /** Dock bounce / attention signal - only ever true on the stop path. */
    readonly shouldBounce: boolean;
}

export function notificationDecision(
    source: NotificationSource,
    context: NotificationContext
): NotificationDecision {
    const unattended = !context.isFocused || !context.isAppActive;
    const hasBackgroundWork = context.backgroundTaskCount > 0;
    switch (source) {
        case 'stop':
            // Background work suppresses BOTH: the repeat Stops fired as each background
            // unit completes were the notification churn of issues #215/#220.
            return {
                shouldNotify: unattended && !hasBackgroundWork,
                shouldBounce: !context.isAppActive && !hasBackgroundWork
            };
        case 'agentNotification':
            // Deliberately NOT background-suppressed: the agent's own message may be an
            // actionable permission prompt.
            return { shouldNotify: unattended, shouldBounce: false };
        case 'error':
            return { shouldNotify: true, shouldBounce: false };
        case 'osc':
            return { shouldNotify: unattended, shouldBounce: false };
    }
}
