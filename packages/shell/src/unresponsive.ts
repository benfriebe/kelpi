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
 * ## What puts the views back (issue #96)
 *
 * The park KEEPS each placement and asks every client to re-state it (`webHost.recoverViews`),
 * so a pane a client still draws comes back on its own. The first version of this parked with
 * the FORGETTING release, and the user's report was the consequence: "the web pane went blank,
 * and was only recovered by going in and out of the workspace". A forgotten placement is a dead
 * end - the client's geometry reporter dedupes an identical re-render, so nothing on either side
 * ever contradicts it.
 *
 * The ask goes out while the renderer is still wedged, which is the point of the second half:
 * a renderer that is not returning to its event loop cannot process a message either, so
 * `responsive` asks again. Structurally the queued ask would arrive on its own once the loop
 * comes back, and this is the case where it would not - the client's socket dropped during the
 * wedge, so the message was delivered to a connection that no longer existed.
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

/** The reason the park is recorded under, so a log reader can tell it apart. */
export const UNRESPONSIVE_PARK_REASON = 'renderer-unresponsive';

export interface UnresponsiveWatchdogOptions {
    /** `Date.now`, injected so the rule can be tested without a real minute. */
    readonly now: () => number;
    readonly log: (message: string) => void;
    /**
     * Park every native web view, KEEPING each placement, and ask the clients to re-state it
     * (#96: `webHost.recoverViews`, never the forgetting `releaseViews`). Returns how many were
     * parked, when the caller knows.
     */
    readonly park: (reason: string) => number | void;
    /**
     * #96: ask every client to re-state its placements. Called on `responsive` when this
     * watchdog has parked, because the ask `park` already sent went to a renderer that could not
     * process it. Absent (tests, a shell with no web host) means the queued ask is all there is.
     */
    readonly restate?: ((reason: string) => void) | undefined;
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
    /** #96: a park has happened and the renderer has not answered since. */
    let owesRestatement = false;

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
            owesRestatement = true;
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
            // #96: only after a park of ours, and only once. A renderer coming back from ordinary
            // heavy work has nothing to re-state, and a broadcast reaches every attached client.
            if (!owesRestatement) return;
            owesRestatement = false;
            options.restate?.(UNRESPONSIVE_PARK_REASON);
            options.log(`asked every client to re-state its web-pane placements (${UNRESPONSIVE_PARK_REASON})`);
        },

        strikes(): readonly number[] {
            const at = options.now();
            recent = recent.filter((stamp) => at - stamp < windowMs);
            return recent;
        }
    };
}
