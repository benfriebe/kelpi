/**
 * The renderer watchdog (issue #79, shell-ui.md §"Recovering a stuck window").
 *
 * `applySecurityPolicy` already handles `render-process-gone` (`main.ts`): the renderer DIED,
 * so reload it. The failure this issue reports is the other one, and the shell had nothing to
 * say about it: the renderer is alive and simply not returning to its event loop, because
 * something in the page is spending the frame. Chromium reports that as `unresponsive` after
 * roughly 30 s of an unanswered hang monitor ping, and pairs it with `responsive` when the loop
 * comes back.
 *
 * ## Why two strikes and not one
 *
 * `unresponsive` is not a fault on its own. A workspace switch that starts eight terminal
 * engines, each parsing a multi-MB replay, legitimately blocks the main thread past the hang
 * monitor's patience, and so does a big enough `pane capture`. Acting on the first one would
 * mean tearing the window's views apart during ordinary heavy work.
 *
 * A SECOND one inside a minute is a different statement: the renderer went away, came back or
 * did not, and went away again. That is the shape the report describes ("have to restart"), and
 * it is the point at which the least-worst thing the main process can do is unstick the window
 * physically - park every native `WebContentsView` back in the off-screen holder. A parked view
 * stops intercepting mouse events over its rect, so the chrome underneath becomes clickable
 * again the moment the renderer draws a frame, instead of the user finding a window whose panes
 * swallow every click.
 *
 * ## What it deliberately does NOT do
 *
 * It does not reload the window. A wedged renderer usually has the user's scrollback in it and
 * a reload is exactly the restart the issue is about avoiding. It does not quit, and it does not
 * show a dialog: a modal over an app that is already unresponsive is one more thing to dismiss.
 * Every decision is logged instead, so a report can be read afterwards.
 *
 * The rule is pure and the effects are injected, so `unresponsive.test.ts` can drive real clock
 * values instead of waiting a minute.
 */

/** A second strike inside this window parks the views. */
export const UNRESPONSIVE_STRIKE_WINDOW_MS = 60_000;

/** The `releaseViews` reason the park is recorded under, so a log reader can tell it apart. */
export const UNRESPONSIVE_PARK_REASON = 'renderer-unresponsive';

export interface UnresponsiveWatchdogOptions {
    /** `Date.now`, injected so the rule can be tested without a real minute. */
    readonly now: () => number;
    readonly log: (message: string) => void;
    /** Park every native web view. Returns how many were parked, when the caller knows. */
    readonly park: (reason: string) => number | void;
    /** Defaults to `UNRESPONSIVE_STRIKE_WINDOW_MS`. */
    readonly windowMs?: number | undefined;
}

export interface UnresponsiveWatchdog {
    /** `webContents.on('unresponsive')`. True when this strike parked the views. */
    unresponsive(): boolean;
    /** `webContents.on('responsive')`. */
    responsive(): void;
    /** Strikes still inside the window, newest last. Diagnostics and tests. */
    strikes(): readonly number[];
}

export function createUnresponsiveWatchdog(options: UnresponsiveWatchdogOptions): UnresponsiveWatchdog {
    const windowMs = options.windowMs ?? UNRESPONSIVE_STRIKE_WINDOW_MS;
    let recent: number[] = [];
    let wedgedSince: number | null = null;

    return {
        unresponsive(): boolean {
            const at = options.now();
            // Strikes age out: two hangs half an hour apart are two ordinary heavy moments, not
            // a wedge, and a shell that has been up for a week must not accumulate them.
            recent = [...recent.filter((stamp) => at - stamp < windowMs), at];
            if (wedgedSince === null) wedgedSince = at;
            const seconds = Math.round(windowMs / 1000);
            if (recent.length < 2) {
                options.log(
                    `renderer unresponsive (strike 1 within ${String(seconds)}s); ` +
                        'watching, nothing parked - heavy work looks exactly like this'
                );
                return false;
            }
            const parked = options.park(UNRESPONSIVE_PARK_REASON);
            options.log(
                `renderer unresponsive (strike ${String(recent.length)} within ${String(seconds)}s); ` +
                    `parked ${typeof parked === 'number' ? String(parked) : 'every'} web pane view ` +
                    `(${UNRESPONSIVE_PARK_REASON}) so the window can be clicked`
            );
            return true;
        },

        responsive(): void {
            const at = options.now();
            const held = wedgedSince === null ? null : at - wedgedSince;
            wedgedSince = null;
            options.log(
                `renderer responsive again${held === null ? '' : ` after ${String(held)}ms`}` +
                    ` (${String(recent.filter((stamp) => at - stamp < windowMs).length)} strike(s) still counting)`
            );
        },

        strikes(): readonly number[] {
            const at = options.now();
            recent = recent.filter((stamp) => at - stamp < windowMs);
            return recent;
        }
    };
}
