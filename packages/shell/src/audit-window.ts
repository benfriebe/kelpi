/**
 * Where a test window goes, and whether Chromium is allowed to throttle it. Two lanes use it.
 *
 * A full audit run is ~120 steps of real gestures against a real window. Two facts about that
 * window cost the run minutes and cost the machine's owner their screen:
 *
 *   1. **Throttling.** Chromium coalesces timers and drops `requestAnimationFrame` to ~0 Hz for a
 *      window it believes nobody is looking at. The audit's animation steps advance on double-rAF
 *      gates, so a buried window does not run slowly — it *stops*, and every step waiting on a
 *      slide phase dies on its timeout (the run-P attempts 3–4 death class). The harness works
 *      around it by raising the window; `webPreferences.backgroundThrottling: false` means a run
 *      survives the owner raising something over it instead.
 *   2. **Placement.** A run owns the machine for twenty minutes and there is no obvious reason for
 *      it to own the *display* as well. Which of the ways to give the display back is actually
 *      safe turned out to be a measurement rather than a preference — see the table below, and
 *      note that the answer on this platform is currently "none of them".
 *
 * Both are **test-only**, and there are two lanes that ask for them, each with its own gate and
 * its own reason (`resolveWindowPolicy` is where they meet):
 *
 *   - the **audit**, `KELPI_AUDIT=1` + `KELPI_AUDIT_WINDOW`, set by `scripts/ui-audit/audit.mjs`;
 *   - the **harness functional lane**, `KELPI_HARNESS_SOCKET` + `KELPI_HARNESS_WINDOW`, set by
 *     `scripts/ui-audit/lib/driver.mjs` ▸ `boot({ window })` for a scenario run (#65, below).
 *
 * Neither gate is a thing a user or a packaged build ever sets, so with both unset this module
 * returns the shipped defaults and `createWindow` builds byte-identical options:
 * `audit-window.test.ts` pins exactly that, for each gate and for the two of them crossed.
 *
 * ## Which placements are safe, measured
 *
 * Freeing the display was tried three ways and every one of them costs something the audit is
 * measuring. Electron 43, 120 Hz Retina display, `scripts/ui-audit` probes plus two full runs:
 *
 *   | placement                | devicePixelRatio | `outline: 1.5px` | rAF    | CDP screenshot | verdict |
 *   | ------------------------ | ---------------- | ---------------- | ------ | -------------- | ------- |
 *   | `default` (visible)      | 2                | 1.5px            | 120 /s | 2560×1640, real| **safe** |
 *   | `hidden` (zero opacity)  | 2                | 1.5px            | 120 /s | 2560×1640, **blank** | assertions only |
 *   | `offscreen`              | **1**            | **1px**          |  75 /s | 1280×820, real | lossy |
 *   | minimised / `hide()`     | 2                | 1.5px            | 121 /s | not tried      | rejected, see below |
 *
 *   - **`offscreen`** — a window AppKit no longer considers to be on a screen gets a 1× backing
 *     store, and Chromium takes its device scale from that; `--force-device-scale-factor` does not
 *     override it (measured: still 1). Every sub-pixel quantity moves with it — the sidebar's
 *     1.5 px accent stroke computes to 1 px, `outline-offset: -0.75px` to −1 px, the ring-clearance
 *     geometry snaps to different integers. A full offscreen run reproduced 113 of 118 steps
 *     exactly and turned two green assertions red (`sidebar-escape-clears-selection` ▸ "it wears
 *     the 1.5px accent stroke"; `sidebar-ring-clearance` ▸ "the engine paints it centred to within
 *     one device pixel"). Not flakes — the audit correctly reporting that it was shown a different
 *     rendering.
 *   - **`hidden`** — a full run at zero opacity was assertion-identical to the baseline, all 118
 *     steps, and every PNG it produced was **empty white**. `Page.captureScreenshot` composites
 *     the window's alpha even with `fromSurface: false`, which is the mode the harness already
 *     uses. 107 of the 118 steps are `needs-eyes`; a run whose pictures are blank has produced
 *     nothing. Kept, and only for a run where the assertions are the whole product.
 *   - **minimise / `hide()`** — rejected without a run: this app acts on both events
 *     (`webHost.releaseViews('window-minimized' | 'window-hidden')`), so either would change the
 *     product's behaviour in the middle of the run that is measuring it.
 *
 * So the default is `default`: on macOS, with this Electron, there is no way to take the display
 * back that leaves both the measurements and the screenshots intact. That is a finding, not a
 * failure to try — and the machinery to act on a better answer is all here (`--window`, and
 * `lib/shards.mjs` ▸ `ONSCREEN_STEPS`, which can pin a single step class to its own placement in
 * its own shard).
 *
 * `backgroundThrottling: false` is separate, and it survives all of that: it costs nothing, it is
 * what stops a run dying when the owner raises a window over the audit's, and both full runs above
 * were assertion-identical with it on.
 *
 * ## The harness functional lane, measured (#65)
 *
 * The verdicts above are the AUDIT's, and they are about pixels: 107 of its 118 steps are
 * `needs-eyes`, so a placement that costs the pictures costs the audit its product. A scenario
 * (`scripts/scenarios/`) asserts on DOM state, CLI replies, harness counters and native menu
 * state; its screenshots are for a human to glance at afterwards. Those are two different
 * contracts over the same three placements, so the placements were measured again against the
 * second one.
 *
 * Re-measured on this Electron for the scenario contract, one second of each, window blurred as
 * well as focused because a scenario blurs it (`dock-bounce-stop-only` must: the dock only
 * bounces while the app is inactive, and `BrowserWindow.blur()` on macOS is `orderBack:`, which
 * puts the frame behind every other window on the screen):
 *
 *   | placement, throttling  | rAF focused | rAF blurred | timers/s blurred | `visibilityState` blurred | dpr | CDP screenshot |
 *   | ---------------------- | ----------- | ----------- | ---------------- | ------------------------- | --- | -------------- |
 *   | `hidden`,   shipped    | 121         | **0**       | **6**            | **hidden**                | 2   | 2560×1640 **blank white** |
 *   | `hidden`,   throttle=0 | 121         | 121         | 220              | visible                   | 2   | blank white |
 *   | `onscreen`, shipped    | 121         | 121         | 208              | visible                   | 2   | 2560×1640 real |
 *   | `offscreen`, either    |  76         |  76         | 220              | visible                   | **1** | 1280×820 real |
 *
 * The surprise is the second row, and it is why this lane keeps Chromium's throttling ON while
 * the audit's lane turns it off. `backgroundThrottling: false` does not merely keep the timers
 * running: Electron implements it by pinning the render widget out of the hidden state, so the
 * page reports `visibilityState: 'visible'` forever. The client reports exactly that value to
 * the daemon (`client/src/state/bridge.ts` ▸ `reportVisibility`), the daemon's `isAppActive` is
 * `presence().anyVisible` (`daemon/src/boot/compose.ts`), and the stop-only dock bounce is gated
 * on the app being INACTIVE (agent-lifecycle §7.1). So a lane with throttling off silently tells
 * the product that somebody is always looking at it, and `dock-bounce-stop-only` fails on a real
 * behaviour change the lane introduced, measured at every placement and not just `hidden`:
 * `--window onscreen` failed it too. A test lane that changes the thing under test is the exact
 * failure this file rejects `hide()` and `minimize()` for; throttling off is the same mistake in
 * a quieter costume, so it is opt-in (`KELPI_HARNESS_WINDOW_THROTTLE=0`) and never the default.
 *
 * With the shipped throttling all three scenarios pass at `hidden`, at their onscreen speeds
 * (3.4 s / 1.7 s / 1.6 s against a 3.4 / 1.8 / 1.6 control), because a scenario does not wait on
 * the page's own frame clock: `settle`, `settleDom` and `page.waitFor` poll from Node over CDP,
 * and `Runtime.evaluate` is answered by a throttled renderer as promptly as by a busy one. That
 * is the whole finding: the audit needed the flag because its animation steps advance on
 * double-rAF gates INSIDE the page; nothing in a scenario does.
 *
 *   - **`hidden` is the lane.** Same bounds, same backing scale, zero opacity, click-through: the
 *     screen stays the machine owner's and several runs overlap. What it costs is the pixels, and
 *     `driver.mjs` ▸ `recorder` writes that caveat into every screenshot note rather than leaving
 *     a white PNG to be diagnosed as a rendering bug.
 *   - **`offscreen` is the fallback** for a scenario that wants a real picture without the screen:
 *     true pixels at half resolution, rAF ~76 /s (a window on no display gets a 60 Hz-class frame
 *     clock rather than the panel's 120).
 *   - **`onscreen` and `offscreen` never look inactive.** Neither is ever occluded (one is parked
 *     where nothing covers it, the other is on no screen at all), so a blurred window there still
 *     reports itself visible and the daemon still calls the app active. Both fail
 *     `dock-bounce-stop-only`, and that scenario now says so in its own words rather than reading
 *     as "a stop does not bounce the dock".
 *
 * ## And none of the three is ever the key window (#109)
 *
 * Measured after all of the above and fixed here: a lane window was still shown with `show()`,
 * which is `makeKeyAndOrderFront:` on macOS, so an invisible zero-opacity frame was holding the
 * machine's keyboard and the owner's own typing was landing in the run's terminal. Every lane
 * placement is `focusable: false` now. `auditWindowFocusable` has the rule, the measurement and
 * what the lane does instead.
 *
 * There is no Electron in here — the policy and the geometry are plain data, so both are unit
 * tested without a GUI.
 */

/** The rectangle shape shared with `./window-state.js`, restated so this module imports nothing. */
export interface AuditRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * Where an audit run wants its window.
 *
 *   - `default`  — exactly what a user's launch builds, and the audit's default. **The only
 *                  placement that keeps both the measurements and the screenshots.**
 *   - `hidden`   — same bounds, display and backing scale, painted at zero opacity and
 *                  click-through. Frees the screen; the screenshots come out blank. Assertion
 *                  runs only.
 *   - `offscreen`— the frame is parked past the work area. Frees the screen, and costs the
 *                  Retina backing store (see the table above). Kept for measurement, not for use.
 *   - `onscreen` — visible, parked at the work area's origin. The per-class fidelity fallback:
 *                  it pins a placement without moving anything else.
 *
 * None of them changes the window's **size**. That is not a detail: the audit asserts on layout
 * geometry (gutters, clearances, column counts, wrapped terminal rows), so a placement that also
 * resized the window would change the product under test and every one of those numbers with it.
 */
export type AuditWindowPlacement = 'default' | 'hidden' | 'offscreen' | 'onscreen';

const PLACEMENTS: readonly AuditWindowPlacement[] = ['default', 'hidden', 'offscreen', 'onscreen'];

/**
 * Which gate opened, if any. Only `shipped` is reachable without a test harness setting a
 * variable, and only `shipped` is what a user's launch gets.
 */
export type WindowPolicyLane = 'shipped' | 'audit' | 'harness';

export interface AuditWindowPolicy {
    /** Is this process running under a test harness that wants a placement at all? */
    readonly active: boolean;
    /** Which lane asked. `shipped` iff `active` is false. */
    readonly lane: WindowPolicyLane;
    /** `webPreferences.backgroundThrottling`. `true` is Electron's default and the shipped value. */
    readonly backgroundThrottling: boolean;
    readonly placement: AuditWindowPlacement;
}

/** What a shipped launch gets: Electron's own defaults, decided by nothing in this file. */
export const SHIPPED_WINDOW_POLICY: AuditWindowPolicy = {
    active: false,
    lane: 'shipped',
    backgroundThrottling: true,
    placement: 'default'
};

/** How far past the work area's trailing edge an offscreen window is pushed. */
export const OFFSCREEN_MARGIN = 400;

/**
 * Read the policy out of the environment.
 *
 * The gate is `KELPI_AUDIT=1` and only that. `KELPI_HARNESS=1` is deliberately NOT enough: the web
 * smoke and the packaging probes set it too, and they assert on a window a user would get.
 *
 * Inside an audit run:
 *   - throttling is off, unless `KELPI_AUDIT_THROTTLE=1` asks for the shipped behaviour back (the
 *     escape hatch that makes "is the flag doing anything?" a measurable question rather than an
 *     argument);
 *   - `KELPI_AUDIT_WINDOW` picks the placement, and an unset/unknown value means `default`, so a
 *     typo degrades to today's behaviour instead of hiding the window somewhere unexpected.
 */
export function auditWindowPolicy(env: Readonly<Record<string, string | undefined>>): AuditWindowPolicy {
    if (env['KELPI_AUDIT'] !== '1') return SHIPPED_WINDOW_POLICY;
    const requested = env['KELPI_AUDIT_WINDOW'] as AuditWindowPlacement | undefined;
    const placement = requested !== undefined && PLACEMENTS.includes(requested) ? requested : 'default';
    return {
        active: true,
        lane: 'audit',
        backgroundThrottling: env['KELPI_AUDIT_THROTTLE'] === '1',
        placement
    };
}

/**
 * The placements the harness functional lane offers. `default` is deliberately NOT one of them.
 *
 * A scenario run picks a placement on purpose, and "the value that means I did not choose" and
 * "the value I chose" must not be the same string: `KELPI_HARNESS_WINDOW=default` would be
 * indistinguishable from the variable being absent, and a lane whose opt-in can be spelled the
 * same as its opt-out is a lane that will one day be entered by accident. Unset or unknown means
 * no lane at all, which is a user's window (`SHIPPED_WINDOW_POLICY`) rather than a placed one.
 * `onscreen` is the lane's visible member: same lane, same machinery, window on the screen. It is
 * a control for the other two, not the runner's default; `scenario.mjs` defaults to no lane at
 * all, because an `onscreen` window is parked where nothing covers it and so never looks
 * inactive (see the third bullet in the header's lane section).
 */
const HARNESS_PLACEMENTS: readonly AuditWindowPlacement[] = ['hidden', 'offscreen', 'onscreen'];

/**
 * The harness functional lane's policy (#65): a scenario window that need not own the screen.
 *
 * The gate is BOTH `KELPI_HARNESS_SOCKET` naming a channel (`./harness-protocol.ts` ▸
 * `harnessSocketPath` is the one that opens it; the test is restated here rather than imported
 * so this module keeps importing nothing) AND `KELPI_HARNESS_WINDOW` naming one of
 * `HARNESS_PLACEMENTS`. Two variables, because either alone already means something else:
 * `KELPI_HARNESS_SOCKET` is set by `dev-instance.mjs` for a window a human is looking at, and a
 * stray `KELPI_HARNESS_WINDOW` in some future environment must not move a window that has no
 * driver behind it to move it back.
 *
 * `KELPI_AUDIT` is not consulted at all, and the audit's own gate is not consulted here: the two
 * lanes are read separately and `resolveWindowPolicy` decides between them, so neither can
 * quietly change the other's behaviour.
 *
 * Throttling KEEPS Electron's shipped `true`, which is the opposite of what the audit's lane
 * does and was decided by running the scenarios both ways. `KELPI_HARNESS_WINDOW_THROTTLE=0`
 * turns it off for a run that wants the audit's behaviour; see the header's second table for why
 * that is an opt-in and not the default.
 */
export function harnessWindowPolicy(env: Readonly<Record<string, string | undefined>>): AuditWindowPolicy {
    const socket = env['KELPI_HARNESS_SOCKET'];
    if (typeof socket !== 'string' || socket.trim() === '') return SHIPPED_WINDOW_POLICY;
    const requested = env['KELPI_HARNESS_WINDOW'] as AuditWindowPlacement | undefined;
    if (requested === undefined || !HARNESS_PLACEMENTS.includes(requested)) return SHIPPED_WINDOW_POLICY;
    return {
        active: true,
        lane: 'harness',
        // Shipped `true` unless a run explicitly asks for the audit's behaviour. A typo lands on
        // the faithful side, which is the side where the product still behaves like the product.
        backgroundThrottling: env['KELPI_HARNESS_WINDOW_THROTTLE'] !== '0',
        placement: requested
    };
}

/**
 * The one call `createWindow` makes: the audit's lane, else the harness lane, else the shipped
 * defaults.
 *
 * The audit wins a tie because an audit run is the stricter contract: it measures pixels, and
 * `scripts/ui-audit/audit.mjs` sets `KELPI_HARNESS_SOCKET` too (the native surfaces its steps
 * click are on the far side of that channel), so a run with both variables set is an audit run
 * that also has a channel, never a scenario. Order, not precedence in the vocabulary sense: the
 * two lanes never disagree about geometry, only about which gate is allowed to open it.
 */
export function resolveWindowPolicy(env: Readonly<Record<string, string | undefined>>): AuditWindowPolicy {
    const audit = auditWindowPolicy(env);
    return audit.active ? audit : harnessWindowPolicy(env);
}

/**
 * Whether a placed window may become the OS KEY window. `false` for every lane placement.
 *
 * ## The rule
 *
 * A lane window (`hidden`, `offscreen`, `onscreen`) never becomes the key window on its own, and
 * the machine's real keyboard never reaches it. Every keystroke a lane delivers goes through CDP
 * (`Input.dispatchKeyEvent` and friends), which is answered by the render widget directly and
 * needs no key status at all. So the window has nothing to gain from being key and one very
 * expensive thing to lose by it.
 *
 * ## The reason, measured (#109, and the "Not in this PR" note on PR #113)
 *
 * `hidden` paints the window at zero opacity and makes it click-through, and it was still shown
 * with `show()`, which on macOS is `makeKeyAndOrderFront:` plus an app activation. Measured on
 * this Electron, on the base tree, at `--window hidden`:
 *
 *   - right after boot the frontmost application was `Electron` and `harness.window()` reported
 *     `focused: true`. The run had taken the machine's keyboard, invisibly;
 *   - a `harness.focus()` took it back off the app the person had moved to;
 *   - a CGEvent keystroke posted the way a physical one arrives landed in the lane's terminal
 *     pane: `kelpi pane capture` came back `sh-3.2$ echo urecaret-ok` where the scenario had
 *     typed `echo caret-ok` through CDP and `ure` was typed on the machine.
 *
 * That is exactly the shape PR #113 recorded and could not attribute (`sh-3.2$ ortecho caret-ok`,
 * `stctureecho caret-ok`), and the shape the phone program recorded as "`terminal-ls` can mangle
 * its own typed fixture on a first run" (`cd <path>` arriving as ` to bcd <path>`). It is not a
 * flake in a scenario: it is the machine's owner typing into an invisible test terminal while
 * their own keystrokes vanish from wherever they thought they were typing.
 *
 * `focusable: false` is what closes it. On macOS it makes the frame refuse key status, so AppKit
 * has nowhere to route a key event even when the app is frontmost, and `Page.bringToFront`,
 * `show()` and `focus()` all stop being able to steal it. Nothing the lane needs goes through
 * that path: CDP input, `Runtime.evaluate`, `Page.captureScreenshot`, the harness channel and the
 * CLI are all indifferent to key status.
 *
 * What it costs is `document.hasFocus()` inside the page, which is a real signal the client reads
 * (`client/src/terminal/TerminalPane.tsx` seeds `windowFocused` from it,
 * `client/src/chrome/attention.ts` gates on it). The lane pays that back through CDP focus
 * emulation rather than through the OS: `scripts/ui-audit/lib/driver.mjs` ▸ `boot` turns
 * `Emulation.setFocusEmulationEnabled` on, and `harness.focus()` / `harness.blur()` in the lane
 * mean "make the page believe it is focused / unfocused" rather than "make the OS window key".
 *
 * `default` keeps `true`, so the on-screen full audit and every user launch are untouched: a
 * visible window that could not be typed into would be a worse lie than the one this fixes.
 */
export function auditWindowFocusable(placement: AuditWindowPlacement): boolean {
    return placement === 'default';
}

/**
 * How the window is made invisible, for the placements that do it that way.
 *
 * `opacity: 0` rather than `hide()`/`minimize()`: this app acts on both of those events
 * (`webHost.releaseViews('window-hidden' | 'window-minimized')`), so using either would change
 * the product's behaviour in the middle of the run that is supposed to be measuring it. Opacity
 * fires nothing, keeps `isVisible()` true, and leaves the compositor untouched.
 *
 * `ignoreMouseEvents` is the other half of giving the screen back: without it the run leaves an
 * invisible rectangle that swallows the owner's clicks, which is worse than a visible window
 * because there is nothing to see. CDP delivers the audit's own input straight to the renderer,
 * below AppKit's hit-testing, so the run is unaffected.
 */
export function auditWindowVisibility(placement: AuditWindowPlacement): {
    readonly opacity: number | null;
    readonly ignoreMouseEvents: boolean;
} {
    if (placement === 'hidden') return { opacity: 0, ignoreMouseEvents: true };
    return { opacity: null, ignoreMouseEvents: false };
}

/**
 * Move `bounds` to satisfy `placement`, keeping its size.
 *
 * `offscreen` pushes the origin past the **trailing** edge of the work area, on both axes.
 * Trailing rather than leading because macOS constrains a window's frame on the way in: asking
 * for a negative origin gets clamped back until part of the window is on screen (measured:
 * x −1680 came back as −1240, leaving a 40 px sliver visible), while a large positive x is
 * accepted verbatim. The y push is belt-and-braces — AppKit does claw the y back so the title
 * strip stays reachable, but with x fully past the edge the window is invisible regardless.
 *
 * `onscreen` is the fidelity fallback: same size, origin parked at the work area's top-left. It
 * exists so a step class that measurably degrades offscreen can be run visible **without**
 * changing anything else about the window.
 */
export function auditWindowBounds(
    placement: AuditWindowPlacement,
    bounds: AuditRect,
    workArea: AuditRect
): AuditRect {
    if (placement === 'offscreen') {
        return {
            ...bounds,
            x: workArea.x + workArea.width + OFFSCREEN_MARGIN,
            y: workArea.y + workArea.height + OFFSCREEN_MARGIN
        };
    }
    if (placement === 'onscreen') {
        return { ...bounds, x: workArea.x, y: workArea.y };
    }
    return bounds;
}

/**
 * The line `createWindow` logs when the policy is active.
 *
 * Emitted only when a lane opened, so a shipped log is unchanged; the audit reads it back to prove
 * the run it *thinks* was hidden actually was (and, via `actual`, what AppKit did with the origin
 * it was handed), and `driver.boot` waits for the harness lane's copy before it hands a scenario
 * a page, so "the placement did not take" fails at boot instead of as a puzzling screenshot.
 *
 * The tag names the lane, `audit-window:` or `harness-window:`, because the two runs otherwise
 * produce the same line and a log with both in it (a scenario run started while an audit runs) is
 * the case where telling them apart matters. Everything after the tag is identical, so a reader
 * that only wants the placement can match `placement=`.
 *
 * Note that `shell.log` holds only the LAST shell's lines, since `reattach-after-relaunch`
 * starts a second one — which is why `results.json`'s `meta.windowPlacement` states it for the
 * whole run as well.
 */
export function auditWindowLogLine(policy: AuditWindowPolicy, requested: AuditRect, actual: AuditRect): string {
    const rect = (value: AuditRect): string =>
        `${String(Math.round(value.x))},${String(Math.round(value.y))} ${String(Math.round(value.width))}x${String(Math.round(value.height))}`;
    const visibility = auditWindowVisibility(policy.placement);
    return (
        `${policy.lane === 'harness' ? 'harness' : 'audit'}-window: ` +
        `placement=${policy.placement} backgroundThrottling=${String(policy.backgroundThrottling)} ` +
        `opacity=${visibility.opacity === null ? 'default' : String(visibility.opacity)} ` +
        `clickThrough=${String(visibility.ignoreMouseEvents)} ` +
        // The key-window rule, stated in the run's own log: a lane window is `focusable=false`,
        // so "did the policy take?" is answerable from outside the process rather than by
        // reading this file. See `auditWindowFocusable`.
        `focusable=${String(auditWindowFocusable(policy.placement))} ` +
        `requested=${rect(requested)} actual=${rect(actual)}`
    );
}
