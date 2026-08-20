/**
 * The chrome's loading strip: WEB-033's visibility state machine, and WEB-034's tab snap.
 *
 * **What the port cannot have, and what it does instead.** The Swift strip's width was bound to
 * `WKWebView.estimatedProgress`, a KVO property that reports a real fraction of the load.
 * Chromium exposes no equivalent to an Electron host — `WebContents` has `isLoading()` and the
 * `did-start-loading` / `did-stop-loading` pair, and nothing between them. So the honest port of
 * "a Safari-style progress strip" is the documented approximation: an **indeterminate** strip
 * that runs while the load bracket is open, and the SAME completion choreography the Swift used
 * once it closes, because that part is timing, not measurement:
 *
 *     load starts        → the strip appears immediately (the Swift's `max(progress, 0.05)`
 *                          head-start existed for exactly this reason: the click must register)
 *     load ends          → pin to full width
 *     +300 ms            → fade out
 *     +150 ms more       → reset, so a stale event cannot redraw a full bar for one frame
 *
 * WEB-034: switching tabs SNAPS to the newly-active tab's state rather than animating from the
 * old one's — a tab left mid-load shows its strip the moment it is selected, and a tab that
 * finished while hidden shows nothing. Snapping is why `tabID` is an input here at all.
 */

import { useEffect, useRef, useState } from 'react';

/** WEB-033's two delays, injectable so a test does not have to wait 450 ms of real time. */
export interface LoadProgressTimings {
    /** Full-width hold before the fade begins. */
    readonly fadeAfterMs: number;
    /** Fade duration, after which the strip is gone and the phase resets. */
    readonly resetAfterMs: number;
}

export const DEFAULT_PROGRESS_TIMINGS: LoadProgressTimings = { fadeAfterMs: 300, resetAfterMs: 150 };

/**
 * `idle` — no strip at all.
 * `loading` — the bracket is open: an indeterminate sweep.
 * `complete` — the bracket closed: pinned full width, about to fade.
 * `fading` — opacity on its way to zero; still in the DOM so the transition is visible.
 */
export type LoadProgressPhase = 'idle' | 'loading' | 'complete' | 'fading';

export interface LoadProgressView {
    readonly phase: LoadProgressPhase;
    /** The strip is in the DOM (every phase but `idle`). */
    readonly visible: boolean;
    /** The sweep animation runs (only while the bracket is open). */
    readonly indeterminate: boolean;
}

function viewOf(phase: LoadProgressPhase): LoadProgressView {
    return {
        phase,
        visible: phase !== 'idle',
        indeterminate: phase === 'loading'
    };
}

/**
 * Drive the strip from the active tab's live loading flag.
 *
 * `loading` is the daemon's mirror of the host's bracket for the ACTIVE tab; `tabID` identifies
 * which tab that flag belongs to, and a change of it is a snap rather than a transition.
 */
export function useLoadProgress(
    loading: boolean,
    tabID: string | null,
    timings: LoadProgressTimings = DEFAULT_PROGRESS_TIMINGS
): LoadProgressView {
    const [phase, setPhase] = useState<LoadProgressPhase>(loading ? 'loading' : 'idle');
    const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const lastTab = useRef(tabID);
    const wasLoading = useRef(loading);

    const clearTimers = (): void => {
        for (const timer of timers.current) clearTimeout(timer);
        timers.current = [];
    };

    useEffect(() => {
        // WEB-034: a different tab is a different load. Cancel whatever choreography the old
        // tab left running and adopt the new tab's state outright.
        if (lastTab.current !== tabID) {
            lastTab.current = tabID;
            wasLoading.current = loading;
            clearTimers();
            setPhase(loading ? 'loading' : 'idle');
            return;
        }
        if (loading === wasLoading.current) return;
        wasLoading.current = loading;
        clearTimers();
        if (loading) {
            setPhase('loading');
            return;
        }
        // Completion: pin, hold, fade, reset.
        setPhase('complete');
        timers.current.push(
            setTimeout(() => {
                setPhase('fading');
                timers.current.push(
                    setTimeout(() => {
                        setPhase('idle');
                    }, timings.resetAfterMs)
                );
            }, timings.fadeAfterMs)
        );
    }, [loading, tabID, timings.fadeAfterMs, timings.resetAfterMs]);

    // A pane that unmounts mid-fade must not leave a timer holding a dead setter.
    useEffect(() => () => clearTimers(), []);

    return viewOf(phase);
}
