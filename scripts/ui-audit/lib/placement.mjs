/**
 * Which window placement a single scenario runs at, when the run asked for one.
 *
 * WHY THIS EXISTS (#206, #205). The lane is `--window hidden`: same bounds, same backing scale,
 * painted at zero opacity and click-through, which is what gives the machine's owner their screen
 * back and lets several runs overlap. `driver.mjs` ▸ `boot` and `packages/shell/src/audit-window.ts`
 * have the measurements, and one line of them is the whole reason for this file: **AppKit counts a
 * zero-opacity frame as visible, but only while nothing is in front of it.** Put another window
 * over the lane's rectangle and the frame is occluded, and Chromium then treats the window's native
 * `WebContentsView`s as hidden: it throttles them and it drops the synthesized input CDP delivers
 * to them.
 *
 * Nothing in the DOM notices. What notices is a scenario that drives a REAL native page - a
 * `WebContentsView` the shell composites, not an iframe - and `plugin-browser-features` is the one
 * that does. Measured on 2026-09-13, three runs each, on the same tree and the same machine:
 *
 *   | placement    | result                              | wall  |
 *   | ------------ | ----------------------------------- | ----- |
 *   | `hidden`     | 37/44 and an abort; every failure is | 86 s  |
 *   |              | a click that never reached the page  |       |
 *   |              | (`clicks: 0`, `cookies: ""`)         |       |
 *   | `offscreen`  | 65/66                               | 20 s  |
 *
 * `offscreen` parks the frame past the work area, where nothing can be in front of it, and costs
 * the screenshots half their resolution - which that scenario does not spend, because a native
 * view is composited by the WINDOW and its screenshots were never evidence (it says so in its own
 * note). #206 recorded the same "a click that never reached the page" in the audit and could not
 * attribute it; a concurrent visible audit window is named there as a possible factor.
 *
 * So a scenario may declare the LOWEST placement it can be trusted at:
 *
 *     export const windowPlacement = 'offscreen';
 *
 * and a run at a weaker placement gives that scenario its own instance at the declared one. The
 * declaration is a floor, never a ceiling: a run at `onscreen` is not dragged down to `offscreen`,
 * and a run that asked for NO placement is the shipped window and is left exactly alone, because
 * "the lane did not open" has to keep meaning "nothing about this run changed".
 */

/** The lane's placements, weakest first. `default` is not one: it means "no lane". */
export const PLACEMENT_ORDER = ['hidden', 'offscreen', 'onscreen'];

const rank = (placement) => PLACEMENT_ORDER.indexOf(String(placement));

/**
 * Resolve one scenario's placement.
 *
 * `runPlacement` is what the runner opened the lane at (`undefined` for the shipped window and for
 * `--attach`); `declared` is the scenario's `windowPlacement` export, usually absent.
 *
 * Returns `{ placement, raised, warning }`: `placement` is what to run at, `raised` says whether
 * that needs an instance of its own, and `warning` is a sentence to print when a declaration was
 * made and could not be honoured or could not be read. A declaration is never fatal - a scenario
 * suite that refuses to start over a placement hint would be worse than the occlusion it is about.
 */
export function resolveScenarioPlacement(runPlacement, declared) {
    if (declared === undefined || declared === null) return { placement: runPlacement, raised: false, warning: null };
    if (rank(declared) < 0) {
        return {
            placement: runPlacement,
            raised: false,
            warning: `windowPlacement ${JSON.stringify(declared)} is not one of ${PLACEMENT_ORDER.join(' | ')}; ignored`
        };
    }
    if (runPlacement === undefined || rank(runPlacement) < 0) {
        return {
            placement: runPlacement,
            raised: false,
            warning: `it asks for at least ${String(declared)}, but this run opened no lane, so nothing is raised`
        };
    }
    if (rank(declared) <= rank(runPlacement)) return { placement: runPlacement, raised: false, warning: null };
    return { placement: declared, raised: true, warning: null };
}
