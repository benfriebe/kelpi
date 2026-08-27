/**
 * §WS-001's show/hide motion, as a phase machine so it can be checked without a DOM.
 *
 * The shipped app wraps its `isSidebarVisible` toggle in `withAnimation` with SwiftUI's
 * `.default` curve (`ContentView.swift`, shell-ui.md §1: "Toggling animates (default ease,
 * ~0.25s)"), so the sidebar SLIDES out from under the window edge and the pane grid follows it.
 * A browser cannot animate a conditional mount, and that is exactly what this port did: the
 * sidebar was `{visible ? <Sidebar/> : null}`, which snaps.
 *
 * The fix has to survive one awkward CSS fact: a transition needs the element to be in the tree
 * at BOTH ends. So visibility is not one boolean but four phases, and the component that owns
 * them keeps the sidebar mounted for the length of the close:
 *
 *   hidden  → (show) → opening → (next frame) → open
 *   open    → (hide) → closing → (after SIDEBAR_SLIDE_MS) → hidden
 *
 * `opening` and `closing` are the SAME geometry — collapsed, translated off the leading edge —
 * which is what makes both directions a single declarative transition rather than two
 * hand-rolled animations. `opening` exists only so the browser gets one frame at the collapsed
 * geometry to transition *from*; without it React would commit the open geometry on the mount
 * and there would be nothing to animate.
 *
 * Reversing mid-flight is free and is the case a user hits by mashing ⌘⇧S: `closing` + show
 * lands straight back on `open` (the element is already mounted at the collapsed end, so the
 * transition simply runs the other way), and `opening` + hide lands on `hidden` (it never left
 * the collapsed end, so there is nothing to play out).
 */

/** Where the sidebar is between "not in the tree" and "fully out". */
export type SidebarPhase = 'hidden' | 'opening' | 'open' | 'closing';

/** ~0.25s, SwiftUI `.default`'s duration (shell-ui.md §1). */
export const SIDEBAR_SLIDE_MS = 250;

/**
 * SwiftUI `.default` is an ease-in-out-ish curve; CSS `ease` is the closest named equivalent
 * and is written out longhand so `getComputedStyle` reports something an audit can assert.
 */
export const SIDEBAR_SLIDE_EASING = 'cubic-bezier(0.25, 0.1, 0.25, 1)';

/** The phase a visibility change moves to. Same-visibility calls are no-ops, by construction. */
export function sidebarPhaseFor(phase: SidebarPhase, visible: boolean): SidebarPhase {
    if (visible) {
        // `closing` is mounted at the collapsed end, so it can transition straight back open.
        if (phase === 'hidden') return 'opening';
        if (phase === 'closing') return 'open';
        return phase;
    }
    if (phase === 'open') return 'closing';
    // A sidebar that never reached the open geometry has no exit to play.
    if (phase === 'opening') return 'hidden';
    return phase;
}

/**
 * The phase the *timer* moves to: the rAF that follows a mount, and the one that fires when a
 * close has run its length. Anything already settled stays where it is.
 */
export function sidebarPhaseAfterSettle(phase: SidebarPhase): SidebarPhase {
    if (phase === 'opening') return 'open';
    if (phase === 'closing') return 'hidden';
    return phase;
}

/** How long the owner should wait before calling `sidebarPhaseAfterSettle` again. */
export function sidebarSettleDelayMs(phase: SidebarPhase): number | null {
    if (phase === 'opening') return 0; // next frame — see the header
    if (phase === 'closing') return SIDEBAR_SLIDE_MS;
    return null;
}

/** Is the sidebar in the tree at all? True for every phase but `hidden`. */
export function isSidebarMounted(phase: SidebarPhase): boolean {
    return phase !== 'hidden';
}

/** Is the sidebar at its resting, fully-out geometry (the only phase that takes a pointer)? */
export function isSidebarSettledOpen(phase: SidebarPhase): boolean {
    return phase === 'open';
}

/**
 * §N31 — the colour the REVEAL is made of.
 *
 * `Sidebar.tsx` and `Inspector.tsx` both paint `sidebarBackground`, so one token covers both
 * panels; the literal fallback is the dark preset, exactly as every other chrome component
 * spells its own (`var(--nex-fg, #E6E6EA)`), so the strip is right even before `ThemeProvider`
 * has stamped anything.
 */
export const SIDEBAR_PANEL_GROUND = 'var(--nex-sidebar-bg, #0C0C10)';

/** The three inline styles the slide needs: the slot, the clip inside it, and the moving panel. */
export interface SidebarSlideStyle {
    /** The flex slot whose width the pane grid is pushed by. */
    readonly slot: {
        readonly width: number;
        readonly transition: string;
    };
    /**
     * §N31 — the clipping box between the slot and the panel, and the thing that made the port
     * flash.
     *
     * It is exactly the animated width, and it used to paint NOTHING: every pixel the panel did
     * not itself cover was whatever lay behind the window row, which is `<body>`'s ground —
     * `--nex-window-fill`, and under a window created transparent (§N17, `background-opacity <
     * 1`) that ground is `transparent`, i.e. **the desktop**. A slide therefore opened a
     * 220/280 px hole onto the wallpaper: measured at 100 % of the revealed strip fully cleared
     * mid-flight on the inspector's close, and up to 23 % on the sidebar's (whose panel *is*
     * over its slot the whole way, but fades in through `opacity`, so its own opaque fill is
     * translucent while it travels). On a light desktop that reads as a white flash in a dark
     * app, which is exactly what N31 reports.
     *
     * So the container carries the panel's ground for the full animated width. It cannot show
     * the wrong colour even for one frame, whatever the panel's opacity or geometry is doing,
     * and it does not touch §N17: this is the panel's OWN opaque colour inside the panel's own
     * slot — one of the surfaces the Swift keeps opaque at every background-opacity — never
     * `--nex-bg`, and it exists only while the slot has width, i.e. only where the panel is.
     */
    readonly clip: {
        readonly background: string;
        /** The containing block for the panel's edge anchor below. */
        readonly position: 'relative';
    };
    /**
     * The panel inside it: fixed at its full width, translated off the edge while collapsed, and
     * ANCHORED to the edge it travels from.
     *
     * The anchor is §N31's other half. In flow, a panel is laid out at its container's *leading*
     * edge — which is the right anchor for the sidebar (the clip's left edge is the window's,
     * fixed) and the wrong one for the inspector (the clip's RIGHT edge is the window's, and its
     * left edge is the thing that moves). With the panel in flow, an inspector at slide progress
     * `p` sat at `[280−280p, 560−280p]` inside a clip of `[0, 280p]`: the two do not intersect
     * at all until `p > 0.5`, so **the first half of every inspector slide revealed a strip with
     * no panel in it whatsoever** (measured coverage 0 %). Anchoring the panel to its own edge
     * makes both directions the same arithmetic — the panel spans exactly `[0, width]` in clip
     * space at every `p`, so it covers the whole reveal from the first frame.
     */
    readonly panel: {
        readonly width: number;
        readonly opacity: number;
        readonly transform: string;
        readonly transition: string;
        readonly pointerEvents: 'auto' | 'none';
        readonly position: 'absolute';
        readonly top: number;
        readonly bottom: number;
        readonly left: number | 'auto';
        readonly right: number | 'auto';
    };
}

/**
 * Which window edge a panel slides out from.
 *
 * `leading` is the sidebar; `trailing` is the inspector (§WS-137 / §APP-066), which is the same
 * animation mirrored — it must travel off the RIGHT edge, so its collapsed transform is `+width`
 * where the sidebar's is `−width`. Everything else about the two is identical, which is the
 * point: one phase machine, one curve, one set of rules about what is mounted when.
 */
export type SidebarEdge = 'leading' | 'trailing';

/**
 * The geometry for a phase.
 *
 * The slot animates its WIDTH (that is what moves the pane grid); the panel keeps its full
 * width throughout and translates, so its contents never reflow mid-flight — a 220px sidebar
 * relaying out to 3px and back would be a very different, very ugly animation.
 *
 * `animate` is the escape hatch a DRAG needs, and it exists because of a real regression: the
 * slot's `width` transition is on the same property §WS-002's resize handle writes on every
 * pointer move, so with the transition always attached the sidebar edge chased the cursor on a
 * 250 ms ease instead of tracking it — imperceptible on an idle machine, a visible lag on a busy
 * one, and enough to make `docs/audit`'s `sidebar-resize` flow read one drag behind under load
 * (run-M attempt 1). SwiftUI has the same split for the same reason: the shipped app wraps only
 * the visibility TOGGLE in `withAnimation`, never the drag. So: animated while the phase machine
 * is driving, not animated while a person is dragging.
 *
 * The inspector passes `edge: 'trailing'` and keeps `animate` at its default `true`, because it
 * is a FIXED 280px panel with no resize handle (`Inspector.tsx`'s `INSPECTOR_WIDTH_PX`) — there
 * is no gesture writing its width, so there is nothing for a transition to chase. The parameter
 * is still the one on this function rather than a second flag somewhere else: if the inspector
 * ever gains an edge handle, the opt-out it needs is already here and already tested.
 */
export function sidebarSlideStyle(
    phase: SidebarPhase,
    width: number,
    animate = true,
    edge: SidebarEdge = 'leading'
): SidebarSlideStyle {
    const out = phase === 'open';
    const transition = animate ? `width ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}` : 'none';
    const offscreen = edge === 'trailing' ? width : -width;
    const trailing = edge === 'trailing';
    return {
        slot: { width: out ? width : 0, transition },
        clip: { background: SIDEBAR_PANEL_GROUND, position: 'relative' },
        panel: {
            width,
            opacity: out ? 1 : 0,
            transform: out ? 'translateX(0px)' : `translateX(${String(offscreen)}px)`,
            transition: animate
                ? `transform ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}, opacity ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}`
                : 'none',
            pointerEvents: out ? 'auto' : 'none',
            // §N31: anchored to the edge it travels from, so the panel spans the whole clip at
            // every point of the slide instead of only once the transform has nearly finished.
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: trailing ? 'auto' : 0,
            right: trailing ? 0 : 'auto'
        }
    };
}
