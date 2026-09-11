/**
 * Focus visuals + the focus-dwell timer.
 *
 * shell-ui.md §4.1: the focused pane gets a 2px inner border in `theme.paneFocus` around
 * the WHOLE pane (header included) — focus is never shown by tinting the header.
 * shell-ui.md §4.6 / agent-lifecycle.md §5.8: focusing a pane also schedules a 600 ms timer
 * that clears that pane's status back to idle, so an "awaiting input" badge auto-dismisses
 * shortly after the user attends to it. The timer is rescheduled (cancelling the old one) on
 * every focus change and only runs while the focused pane's status is non-idle.
 */

import { useEffect, useRef, type ReactElement } from 'react';

import type { PaneStatus } from '@kelpi/core/layout';

import { tokens } from './tokens';

export const FOCUS_RING_WIDTH = 2;
/** shell-ui.md §4.6 — the delay that lets the user see what is being acknowledged. */
export const FOCUS_DWELL_MS = 600;

export interface FocusRingProps {
    readonly focused: boolean;
    readonly radius?: number | undefined;
}

/** An inset, non-interactive border overlay. Renders nothing when the pane isn't focused. */
export function FocusRing({ focused, radius = 0 }: FocusRingProps): ReactElement | null {
    if (!focused) return null;
    return (
        <div
            data-testid="focus-ring"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
                border: `${FOCUS_RING_WIDTH}px solid ${tokens.paneFocus}`,
                borderRadius: radius
            }}
        />
    );
}

export interface FocusDwellOptions {
    /** The focused pane, or null when nothing is focused. */
    readonly paneID: string | null;
    /**
     * That pane's status; `idle` (or null) means there is nothing to clear. Read when the timer
     * is armed, never a trigger of its own.
     */
    readonly status: PaneStatus | null;
    readonly onDwellClear?: ((paneID: string) => void) | undefined;
    readonly delayMs?: number | undefined;
    /** Set false to suspend the timer entirely (e.g. the document is hidden). */
    readonly enabled?: boolean | undefined;
}

/**
 * Schedules the 600 ms dwell clear on a FOCUS: a new `paneID`, or `enabled` coming back on
 * (the Swift's `didBecomeActive`). A status change on the pane that already has focus never
 * arms it: the Swift's `scheduleClearStatus` runs only from those two events, and Status ▸
 * Awaiting Input is exactly such a change, which the clear undid 600 ms later (#108). Status
 * and callback are both read through refs, so neither a status delta nor a parent re-render
 * with a fresh closure can restart the countdown.
 */
export function useFocusDwell(options: FocusDwellOptions): void {
    const { paneID, status, onDwellClear, delayMs = FOCUS_DWELL_MS, enabled = true } = options;
    const callbackRef = useRef(onDwellClear);
    callbackRef.current = onDwellClear;
    const statusRef = useRef(status);
    statusRef.current = status;

    useEffect(() => {
        if (!enabled) return;
        if (paneID === null) return;
        const current = statusRef.current;
        if (current === null || current === 'idle') return;
        const timer = setTimeout(() => {
            callbackRef.current?.(paneID);
        }, delayMs);
        return () => {
            clearTimeout(timer);
        };
    }, [paneID, delayMs, enabled]);
}
