/**
 * Why a click on the embedded page made no pick, and what to do when it did not (#206).
 *
 * WHAT WENT WRONG. In one full battery `web-batch-pickup` armed the page picker, read
 * `__kelpiInspectorArmed() === true`, clicked `#hello`, and nothing was picked: no popover, no
 * badges, no panel rows. The step recorded the absence (`'no popover'`) and nothing else, so the
 * run could not say WHICH of the several ways a click can come to nothing had happened. Then
 * `web-batch-internals` clicked `#hello` itself, found no popover either, and died on
 * `document.querySelector('[data-kelpi-batch-comment]').focus()` with "Cannot read properties of
 * null", which cost the step its remaining thirteen assertions and replaced a plain failure with a
 * step error.
 *
 * THE CANDIDATES, and this is the whole point of the file: a pick that does not happen has five
 * possible explanations and the step could distinguish none of them.
 *
 *   1. The click never reached the page. `placement.mjs` documents the mechanism: a window whose
 *      rectangle is covered by another window is occluded, and Chromium then treats its native
 *      `WebContentsView`s as hidden and DROPS the synthesized input CDP delivers to them. Nothing
 *      throws and nothing in the DOM notices. The page's own `document.visibilityState` is the one
 *      reading that moves, which is why the probe below takes it.
 *   2. The picker was not armed at the moment of the click (`scripts.ts` ▸ `onClick`, `if (!armed)
 *      return`). The step reads `armed` BEFORE clicking, so a race between the two is invisible.
 *   3. A popover from an earlier pick was still open, which suspends the picker
 *      (`if (w.__kelpiBatchHasOpenPopover === true) return`).
 *   4. The click landed on one of the picker's own overlay surfaces, which are not pick targets
 *      (`if (isOverlay(event.target)) return`).
 *   5. None of the above: the pick was posted and the HOST dropped it, which is the only one of
 *      the five that is a product bug in the app rather than in the harness or the machine.
 *
 * HOW THIS TELLS THEM APART. A witness listener is installed on `window` at capture phase before
 * the click. Capture on `window` runs before capture on `document`, which is where the picker
 * listens, so the witness sees every click the picker sees plus every click the picker declines,
 * and it cannot be silenced by the picker's `stopImmediatePropagation`. It records the guard state
 * AS THE CLICK ARRIVES (armed, popover flag, overlay, focus, visibility), which is the reading that
 * matters and the one a probe taken afterwards cannot reconstruct. Zero clicks with the popover
 * never opening is candidate 1, and that is the positive control the ticket asked for: it separates
 * "the picker declined" from "the click never arrived".
 *
 * These are page sources rather than helpers because everything here runs inside the embedded page
 * through `Runtime.evaluate`, and they are in a lib module rather than inline in `audit.mjs`
 * because a diagnostic that is itself untested is worth very little on the day it has to speak.
 */

/** Mirrors `OVERLAY_ATTRS` in `packages/shell/src/webhost/scripts.ts`: the picker's own surfaces. */
export const OVERLAY_ATTRS = [
    'data-kelpi-overlay',
    'data-kelpi-batch-marker',
    'data-kelpi-batch-markers',
    'data-kelpi-batch-popover',
    'data-kelpi-batch-focus-ring'
];

/** The global the witness hangs off, shared by the installer and the probe. */
export const WITNESS_KEY = '__kelpiAuditPickWitness';

/*
 * The two page-side helpers both sources need. Written as a string of plain statements, with no
 * template literals inside it, so it can be pasted into either source without an escaping puzzle.
 */
const PAGE_HELPERS = `
        const OVERLAY_ATTRS = ${JSON.stringify(OVERLAY_ATTRS)};
        const isOverlay = (node) => {
            let el = node;
            while (el !== null && el !== undefined && el.nodeType === 1) {
                for (const attribute of OVERLAY_ATTRS) { if (el.hasAttribute(attribute) === true) return true; }
                el = el.parentElement;
            }
            return false;
        };
        const describeNode = (node) => {
            if (node === null || node === undefined || node.nodeType !== 1) return String(node);
            const id = typeof node.id === 'string' && node.id !== '' ? '#' + node.id : '';
            const owned = OVERLAY_ATTRS.filter((attribute) => node.hasAttribute(attribute) === true);
            return node.tagName.toLowerCase() + id + (owned.length > 0 ? ' [' + owned.join(' ') + ']' : '');
        };`;

/**
 * Install (or re-arm) the click witness in the embedded page. Evaluate this BEFORE the click.
 *
 * Idempotent by design: the listener is added once per page, the counters are replaced on every
 * call, and the listener reads the counter object off `window` rather than closing over it, so a
 * second step re-arming the witness gets a clean count without stacking a second listener.
 */
export function installPickWitnessSource() {
    return `(() => {${PAGE_HELPERS}
        const w = window;
        w.${WITNESS_KEY} = { clicks: 0, first: null, last: null };
        if (w.${WITNESS_KEY}Installed !== true) {
            w.${WITNESS_KEY}Installed = true;
            window.addEventListener('click', (event) => {
                const witness = w.${WITNESS_KEY};
                if (witness === null || witness === undefined) return;
                const record = {
                    target: describeNode(event.target),
                    overlay: isOverlay(event.target),
                    armed: typeof w.__kelpiInspectorArmed === 'function' ? w.__kelpiInspectorArmed() === true : null,
                    popoverOpen: w.__kelpiBatchHasOpenPopover === true,
                    trusted: event.isTrusted === true,
                    x: Math.round(event.clientX), y: Math.round(event.clientY),
                    focus: document.hasFocus(),
                    visibility: document.visibilityState
                };
                witness.clicks += 1;
                if (witness.first === null) witness.first = record;
                witness.last = record;
            }, true);
        }
        return true;
    })()`;
}

/**
 * Read the witness back, plus the page state a missing pick has to be explained against.
 *
 * `x`/`y` are the click point (`view.click` returns the box it aimed at), used for the
 * `elementFromPoint` reading. Pass nothing and that reading is simply absent, which is the honest
 * result rather than a made-up one.
 */
export function pickProbeSource(x, y) {
    const px = Number.isFinite(Number(x)) ? Math.round(Number(x)) : -1;
    const py = Number.isFinite(Number(y)) ? Math.round(Number(y)) : -1;
    return `(() => {${PAGE_HELPERS}
        const w = window;
        const px = ${px}, py = ${py};
        const under = px >= 0 && py >= 0 ? document.elementFromPoint(px, py) : null;
        const witness = w.${WITNESS_KEY} ?? null;
        return {
            witness: witness === null ? null : { clicks: witness.clicks, first: witness.first, last: witness.last },
            armed: typeof w.__kelpiInspectorArmed === 'function' ? w.__kelpiInspectorArmed() === true : null,
            popoverOpen: w.__kelpiBatchHasOpenPopover === true,
            popover: document.querySelector('[data-kelpi-batch-popover]') !== null,
            markers: document.querySelectorAll('[data-kelpi-batch-marker]').length,
            underPointer: under === null ? null : { node: describeNode(under), overlay: isOverlay(under) },
            point: { x: px, y: py },
            focus: document.hasFocus(),
            visibility: document.visibilityState,
            url: document.location === null || document.location === undefined ? '' : String(document.location.href)
        };
    })()`;
}

/**
 * Focus the page-side comment textarea and type into it, WITHOUT assuming it is there.
 *
 * The unguarded form of this expression is what turned a missed pick into a step error in #206.
 * The sentinel is a value the caller can record: a step that reaches this with no textarea has
 * already failed its popover precondition, and it should say so rather than abort.
 */
export const NO_COMMENT_TEXTAREA = 'no comment textarea';

export function focusPageCommentSource(text) {
    return `(() => {
        const t = document.querySelector('[data-kelpi-batch-comment]');
        if (t === null || t === undefined) return ${JSON.stringify(NO_COMMENT_TEXTAREA)};
        t.focus();
        t.value = ${JSON.stringify(String(text))};
        return document.activeElement === t;
    })()`;
}

const facet = (label, value) => `${label} ${value === null || value === undefined ? 'unknown' : String(value)}`;

/**
 * Say WHICH guard declined the click, in one line fit for a check's detail.
 *
 * The order of the tests is the order `onClick` applies them, with "the click never arrived" first
 * because it is not a guard at all and it invalidates every reading after it. The last branch is
 * the interesting one: every guard passed, so the picker posted the payload and the host dropped
 * it, and that is the only verdict here that points at the app rather than at the harness or the
 * machine it is sharing.
 */
export function describePickGuards(probe) {
    if (probe === null || probe === undefined || typeof probe !== 'object') {
        return 'no pick, and the page could not be probed for why';
    }
    if (typeof probe.probeError === 'string') {
        return `no pick, and the page could not be probed for why: ${probe.probeError}`;
    }
    const witness = probe.witness ?? null;
    const clicked = witness?.last ?? null;
    const facets = [
        facet('clicks seen', witness === null ? null : witness.clicks),
        facet('armed at the click', clicked === null ? probe.armed : clicked.armed),
        facet('popover open at the click', clicked === null ? probe.popoverOpen : clicked.popoverOpen),
        facet('target', clicked === null ? null : clicked.target),
        facet('under the pointer', probe.underPointer === null || probe.underPointer === undefined
            ? null
            : `${probe.underPointer.node}${probe.underPointer.overlay === true ? ' (an overlay)' : ''}`),
        facet('page focus', probe.focus),
        facet('visibility', probe.visibility),
        facet('markers now', probe.markers)
    ].join(', ');

    let guard;
    if (witness === null) {
        guard = 'no click witness was installed, so whether the click reached the page is not known';
    } else if ((witness.clicks ?? 0) === 0) {
        guard =
            'no click reached the page at all, which is what an occluded window does to the input CDP ' +
            `delivers to a native WebContentsView (see lib/placement.mjs); page visibility ${String(probe.visibility)}, focus ${String(probe.focus)}`;
    } else if (clicked?.armed !== true) {
        guard = 'the picker was not armed when the click arrived, so it returned before picking';
    } else if (clicked?.popoverOpen === true) {
        guard = 'a popover was already open, which suspends the picker until Done dismisses it';
    } else if (clicked?.overlay === true) {
        guard = `the click landed on one of the picker's own overlay surfaces (${String(clicked.target)}), which are not pick targets`;
    } else {
        guard =
            'no guard declined: the click reached an armed picker, with no open popover and not on an ' +
            'overlay, so the payload was posted and the host dropped it';
    }
    return `${guard} [${facets}]`;
}
