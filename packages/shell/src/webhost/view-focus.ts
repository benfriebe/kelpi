/**
 * N29 — reporting a USER's click on a web pane's page.
 *
 * A web pane's page is a native `WebContentsView` composited over the client's renderer, so a
 * click inside it never reaches the DOM: the client cannot learn the pane was clicked, and the
 * focus ring stays on whatever pane it was on. The Swift app has no such gap, and HOW it closes
 * the gap is the thing to copy, because it is **not** first-responder wiring: a web pane's
 * `WKWebView` is mounted inside a `PaneFocusView`, whose `embed(_:)` hangs an
 * `NSClickGestureRecognizer` (`delaysPrimaryMouseButtonEvents = false`) on the tab container and
 * posts `SurfaceView.paneFocusedNotification` from it; `ContentView` turns that into `.focusPane`
 * (`PaneFocusView.swift:35-49`, `WebPaneView.swift:327-340`, `ContentView.swift:337-346`).
 * First responder is the TERMINAL's path — `SurfaceView.becomeFirstResponder` posts the same
 * notification (`SurfaceView.swift:267-275`) — and the two must not be confused.
 *
 * ## The first fix was wrong, and how it was wrong is the whole lesson
 *
 * N29's first attempt keyed on `webContents`'s **focus** event and subtracted the two things
 * that fire it and are not the user (the shell's own `focus()` claim, and a committing
 * navigation). It passed 118 live assertions, a packaged run and a positive control — and moved
 * nothing under the owner's finger. The reason, measured in
 * `docs/audit/n29-input-gesture/n29-confirm-hypothesis.mjs` (10/10):
 *
 *   | driven on the pane's own CDP target                    | raw `focus` events |
 *   |--------------------------------------------------------|--------------------|
 *   | click, view did NOT hold focus                          | **0** (2 → 2)      |
 *   | click, view ALREADY held focus (the owner's case)       | **0** (3 → 3)      |
 *   | `Page.bringToFront` — a focus MOVE, not an input        | 1 (2 → 3)          |
 *
 * Two facts fall out. First, `focus` is a **transition** signal, and by the time a user clicks
 * there is usually no transition left to make: a pane's own load leaves keyboard focus in the
 * view (measured — the client's `document.hasFocus()` reads false once a pane finishes loading,
 * which is also what N30 is filed for), so the user's very first click on a fresh pane is
 * already in the "nothing changes" state. No filter can rescue a signal that never fires.
 * Second, the old harness's "production signal" was `Page.bringToFront` — an operation whose job
 * is to move focus. It manufactured the transition it then observed, which is exactly how a
 * broken fix collected green assertions.
 *
 * ## So the signal is the INPUT, which is what Swift's gesture recogniser is
 *
 * Electron 43 exposes `webContents`'s `input-event`, which fires per input with a `type`. A
 * `mouseDown` delivered to the view IS the user's press — there is no "who asked" ambiguity to
 * discriminate, because nothing in this app synthesises input into a page (checked: the only
 * `sendInputEvent`-adjacent site is `webhost/index.ts`'s chord forwarder, and it deliberately
 * does NOT synthesise — it relays through the daemon). The two filters the old design needed are
 * therefore **deleted rather than kept**, and the reasons are worth stating because both are
 * "this cannot happen" rather than "we tolerate it":
 *
 *   * **the shell's own `focusView()`** (WEB-043's keyboard handoff) calls `contents.focus()`,
 *     which moves focus and produces no input. The re-entrancy flag and its 250 ms backstop are
 *     gone — and with them the residual the previous wave measured and recorded, where a real
 *     click landing inside that window was swallowed.
 *   * **a committing navigation** takes the keyboard (it is why N30 exists) but presses no mouse
 *     button, so it cannot raise a `mouseDown`. The hold-and-cancel machinery, the
 *     `did-navigate` cancellation and the 250 ms grace are gone too.
 *
 * What survives is not a discriminator but a **placement fact**: a view parked in the off-screen
 * holder is on nobody's screen, so an input cannot have landed on it (`embedded`, asserted in
 * `tab.ts`). N26's park/restore stays silent for the same reason it always did.
 *
 * ## Click only, matching Swift exactly
 *
 * `NSClickGestureRecognizer` recognises a **primary-button click and nothing else** — typing
 * into a `WKWebView` moves no ring in the shipped app. So `mouseDown` is the whole gesture set
 * here: keyboard input is deliberately NOT presence. Adding it would be a port-only behaviour,
 * and it would fire on an agent's `kelpi web` typing as readily as on a user's.
 *
 * ## No swallow window, deliberately
 *
 * Every `mouseDown` on an embedded view is reported. There is no coalescing timer, because the
 * previous design's one measured residual was a time window that swallowed real gestures, and
 * re-introducing one to save a handful of bytes on the wire would be trading the user's ring for
 * nothing. Repeat reports are idempotent at the client (`act.focusPane` on the focused pane is a
 * no-op), which is the same shape as Swift posting a notification per click.
 */

import { log } from '../log.js';

/**
 * Env-gated trace of the RAW signals, ahead of every guard (`KELPI_WEB_FOCUS_TRACE=1`).
 *
 * This exists because of how the first N29 fix failed. It keyed on `focus`, passed every
 * automated check, and still did nothing under the owner's finger — and no instrument anywhere
 * could separate "a gate filtered the event" from "no event ever arrived". Those are opposite
 * defects that look identical from outside, and picking the wrong one costs a whole wave. A
 * trace ahead of the guards makes the raw arrival a fact rather than an inference.
 */
export function traceFocus(message: string): void {
    if (process.env['KELPI_WEB_FOCUS_TRACE'] !== '1') return;
    // Through `log`, not `process.stdout` directly: a shell launched by a harness whose reader
    // dies would otherwise take an uncaught EPIPE, which is the exact failure `log.ts` exists to
    // swallow. A diagnostic must never be able to bring down the app it is diagnosing.
    log(`web-focus-trace: ${message}`);
}

/**
 * The Electron `InputEvent.type` values that count as the user taking this pane.
 *
 * `mouseDown` only — the press, not the release, so the ring moves under the finger rather than
 * when it lifts (`delaysPrimaryMouseButtonEvents = false` is Swift saying the same thing). The
 * set is deliberately not widened to keys: see the header.
 */
const GESTURE_INPUT_TYPES: ReadonlySet<string> = new Set(['mouseDown']);

/** Is this input event the user's press on the page? */
export function isGestureInput(type: string | undefined | null): boolean {
    return type !== undefined && type !== null && GESTURE_INPUT_TYPES.has(type);
}

export interface ViewFocusGateOptions {
    /** Called when an input is judged to be the user taking this pane. */
    readonly report: () => void;
}

export interface ViewFocusGate {
    /**
     * An input event reached this view (`webContents`'s `input-event`).
     *
     * `embedded` is the placement fact: false means the view is parked in the off-screen holder,
     * where nothing the user does can reach it.
     */
    inputEvent(context: { readonly type?: string | undefined; readonly embedded: boolean }): void;
    /** The tab is going away. */
    dispose(): void;
}

export function createViewFocusGate(options: ViewFocusGateOptions): ViewFocusGate {
    let disposed = false;

    return {
        inputEvent(context: { type?: string | undefined; embedded: boolean }): void {
            if (disposed) return;
            if (!isGestureInput(context.type)) return;
            // A parked view is on nobody's screen. This is not a discriminator standing in for a
            // gesture — the gesture is already unambiguous — it is the one fact that says the
            // press cannot have been aimed here.
            if (!context.embedded) return;
            options.report();
        },

        dispose(): void {
            disposed = true;
        }
    };
}
