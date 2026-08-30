/**
 * The two window concessions the UI audit needs, and nothing else.
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
 * Both are **audit-only**. `KELPI_AUDIT` is set by `scripts/ui-audit/audit.mjs` (and by nothing a
 * user or a packaged build ever runs), so with it unset this module returns the shipped defaults
 * and `createWindow` builds byte-identical options — `audit-window.test.ts` pins exactly that.
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

export interface AuditWindowPolicy {
    /** Is this process running under the audit harness at all? */
    readonly active: boolean;
    /** `webPreferences.backgroundThrottling`. `true` is Electron's default and the shipped value. */
    readonly backgroundThrottling: boolean;
    readonly placement: AuditWindowPlacement;
}

/** What a shipped launch gets: Electron's own defaults, decided by nothing in this file. */
export const SHIPPED_WINDOW_POLICY: AuditWindowPolicy = {
    active: false,
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
        backgroundThrottling: env['KELPI_AUDIT_THROTTLE'] === '1',
        placement
    };
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
 * Emitted only under `KELPI_AUDIT`, so a shipped log is unchanged; the audit reads it back to prove
 * the run it *thinks* was hidden actually was (and, via `actual`, what AppKit did with the origin
 * it was handed). Note that `shell.log` holds only the LAST shell's lines — `reattach-after-relaunch`
 * starts a second one — which is why `results.json`'s `meta.windowPlacement` states it for the
 * whole run as well.
 */
export function auditWindowLogLine(policy: AuditWindowPolicy, requested: AuditRect, actual: AuditRect): string {
    const rect = (value: AuditRect): string =>
        `${String(Math.round(value.x))},${String(Math.round(value.y))} ${String(Math.round(value.width))}x${String(Math.round(value.height))}`;
    const visibility = auditWindowVisibility(policy.placement);
    return (
        `audit-window: placement=${policy.placement} backgroundThrottling=${String(policy.backgroundThrottling)} ` +
        `opacity=${visibility.opacity === null ? 'default' : String(visibility.opacity)} ` +
        `clickThrough=${String(visibility.ignoreMouseEvents)} ` +
        `requested=${rect(requested)} actual=${rect(actual)}`
    );
}
