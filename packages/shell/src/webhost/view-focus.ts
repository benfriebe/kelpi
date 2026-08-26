/**
 * N29 — telling a USER's click on a web pane's page from every other way a view takes focus.
 *
 * A web pane's page is a native `WebContentsView` composited over the client's renderer, so a
 * click inside it never reaches the DOM: the client cannot learn the pane was clicked, and the
 * focus ring stays on whatever pane it was on. The Swift app has no such gap, and HOW it closes
 * the gap is the thing to get right here, because it is **not** first-responder wiring: a web
 * pane's `WKWebView` is mounted inside a `PaneFocusView`, whose `embed(_:)` hangs an
 * `NSClickGestureRecognizer` (`delaysPrimaryMouseButtonEvents = false`) on the tab container and
 * posts `SurfaceView.paneFocusedNotification` from it; `ContentView` turns that into `.focusPane`
 * (`PaneFocusView.swift:35-49`, `WebPaneView.swift:327-340`, `ContentView.swift:337-346`).
 * First responder is the TERMINAL's path — `SurfaceView.becomeFirstResponder` posts the same
 * notification (`SurfaceView.swift:267-275`) — and the two must not be confused.
 *
 * That distinction is the whole reason this file exists. Swift keys on the CLICK, which is
 * unambiguous by construction: a programmatic `makeFirstResponder(webView)` — WEB-043's own
 * handoff, `WebPaneView.swift:396-403` — moves no ring there, and neither does a navigation. The
 * only signal this port has is `webContents`'s `focus` event, which is strictly weaker: the OS
 * gives the view keyboard focus when it is clicked, but the event does not say WHO asked — and
 * two things ask that are not the user. So the port reconstructs Swift's unambiguous gesture by
 * subtracting them.
 *
 * ## What was measured
 *
 * Electron 43 / macOS 15, a `WebContentsView` moved between an off-screen `BaseWindow` holder and
 * a visible `BrowserWindow`, with the window's own renderer holding focus unless stated:
 *
 *   | operation                                                        | fires `focus`? |
 *   |------------------------------------------------------------------|----------------|
 *   | `webContents.focus()`                                             | **yes**, synchronously (0.075 ms, inside the call) |
 *   | `webContents.focus()` on an already-focused view                  | no (so a mark can go unconsumed) |
 *   | `addChildView` / `removeChildView` (N26's park/restore cycle)      | no |
 *   | `setVisible(true)` / `setVisible(false)` / `setBounds(…)`          | no |
 *   | `Emulation.clearDeviceMetricsOverride` (`setEmbedded`)             | no |
 *   | attaching a second CDP session (a DevTools client)                 | no |
 *   | page JS: `window.focus()`, `element.focus()`, `<input autofocus>`  | no |
 *   | **a navigation committing in an embedded view**                    | **yes — TWICE**, ~1–3 ms *before* `did-navigate`, always with `isLoading() === true` |
 *   | CDP `Page.bringToFront` (and a real click)                         | **yes** |
 *
 * The navigation row is the one that matters and the one that is easy to miss: it fires even
 * while the window's own renderer holds focus, it is not an artefact (the view really does take
 * the keyboard — Chromium focuses the newly committed widget), and it fires for the FIRST load of
 * every pane. Left unfiltered, opening a web pane, reloading one, or an agent's `nex web navigate`
 * would each yank the user's focus ring into that pane. It was caught by running the audit's
 * live step, not by reading the docs.
 *
 * ## The two filters, and why each is shaped the way it is
 *
 *   1. **The shell's own claim** (`focusView()`, WEB-043's keyboard handoff) raises a re-entrancy
 *      flag across the call, because the event is delivered *inside* it. A short deadline backs
 *      the flag up in case a future build posts the event instead; it has to expire, because a
 *      redundant `focus()` fires nothing and a mark that lived forever would eventually swallow a
 *      real click.
 *   2. **A commit taking focus** is caught by the one fact that separates it from a click: it
 *      arrives while the tab is LOADING. A click on a loaded page arrives with `isLoading()`
 *      false, and — crucially — so does a click on a *link*, because the click precedes the
 *      navigation it starts. A focus that arrives mid-load is therefore held rather than dropped:
 *      the commit that follows within a few ms cancels it, and if no commit follows (the user
 *      really did click a page that happens to be loading) it is reported after the grace.
 *
 * Everything here is pure but for the timer, which is injectable, so both filters are testable
 * without an Electron window.
 */

/** How long after a programmatic claim a `focus` event is still assumed to be that claim's. */
export const PROGRAMMATIC_FOCUS_WINDOW_MS = 250;

/**
 * How long a focus that arrived mid-load is held, waiting for the commit that would explain it.
 *
 * Measured spread between the focus event and its `did-navigate`: 0.4–2.9 ms, including a
 * navigation whose *server* took 1.5 s (the delay is before the commit, not inside it). 250 ms is
 * a ~100× margin, and it is the worst-case added latency on the rarest branch — a click landing
 * on a page that is still loading.
 */
export const NAVIGATION_COMMIT_GRACE_MS = 250;

/** Cancels a scheduled callback. */
export type CancelTimer = () => void;

export interface ViewFocusGateOptions {
    /** Called when a focus event is judged to be the user's. */
    readonly report: () => void;
    readonly now?: (() => number) | undefined;
    readonly windowMs?: number | undefined;
    readonly graceMs?: number | undefined;
    /** Defaults to `setTimeout`/`clearTimeout`; a test drives its own clock through this. */
    readonly schedule?: ((run: () => void, ms: number) => CancelTimer) | undefined;
}

export interface ViewFocusGate {
    /**
     * Run `claim` (the shell's own `webContents.focus()`) with the gate raised, so the `focus`
     * event it fires — synchronously, inside the call — is not reported as a user gesture.
     */
    claim(run: () => void): void;
    /**
     * A `focus` event arrived. `loading` is `webContents.isLoading()` read at that moment: true
     * means a navigation is in flight, and this is probably its commit taking the keyboard.
     */
    focusEvent(context: { readonly loading: boolean }): void;
    /** `did-navigate` / `did-frame-navigate`: the commit that explains a held focus event. */
    navigationCommitted(): void;
    /** Drop any held event (the tab is going away). */
    dispose(): void;
}

const defaultSchedule = (run: () => void, ms: number): CancelTimer => {
    const timer = setTimeout(run, ms);
    return () => {
        clearTimeout(timer);
    };
};

export function createViewFocusGate(options: ViewFocusGateOptions): ViewFocusGate {
    const now = options.now ?? ((): number => Date.now());
    const windowMs = options.windowMs ?? PROGRAMMATIC_FOCUS_WINDOW_MS;
    const graceMs = options.graceMs ?? NAVIGATION_COMMIT_GRACE_MS;
    const schedule = options.schedule ?? defaultSchedule;

    /** True only while the shell's own `focus()` call is on the stack. */
    let claiming = false;
    /** When that call happened; the mark expires by time rather than by use. */
    let markedAt: number | null = null;
    /** A focus that arrived mid-load, waiting to see whether a commit explains it. */
    let held: CancelTimer | null = null;
    let disposed = false;

    const dropHeld = (): void => {
        if (held === null) return;
        held();
        held = null;
    };

    /** Is this event attributable to the shell's own `focusView()`? */
    const isOurs = (): boolean => {
        if (claiming) return true;
        if (markedAt === null) return false;
        if (now() - markedAt > windowMs) {
            markedAt = null;
            return false;
        }
        return true;
    };

    return {
        claim(run: () => void): void {
            claiming = true;
            markedAt = now();
            // A claim also invalidates anything held: the shell is moving focus itself, so an
            // older event has nothing left to say about where the ring belongs.
            dropHeld();
            try {
                run();
            } finally {
                claiming = false;
            }
        },

        focusEvent(context: { loading: boolean }): void {
            if (disposed) return;
            if (isOurs()) return;
            if (!context.loading) {
                // Nothing is in flight, so nothing but the user can have done this — including
                // the click on a LINK, which precedes the navigation it is about to start.
                dropHeld();
                options.report();
                return;
            }
            // Mid-load: hold it. The commit that is about to land cancels it; if none does,
            // the user really did click a page that happens to be loading.
            dropHeld();
            held = schedule(() => {
                held = null;
                if (disposed) return;
                options.report();
            }, graceMs);
        },

        navigationCommitted(): void {
            dropHeld();
        },

        dispose(): void {
            disposed = true;
            dropHeld();
        }
    };
}
