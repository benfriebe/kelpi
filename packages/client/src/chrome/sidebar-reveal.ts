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

/** The two inline styles the slide needs: the slot that reserves width, and the panel that moves. */
export interface SidebarSlideStyle {
    /** The flex slot whose width the pane grid is pushed by. */
    readonly slot: {
        readonly width: number;
        readonly transition: string;
    };
    /** The panel inside it: fixed at its full width, translated off the edge while collapsed. */
    readonly panel: {
        readonly width: number;
        readonly opacity: number;
        readonly transform: string;
        readonly transition: string;
        readonly pointerEvents: 'auto' | 'none';
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
    return {
        slot: { width: out ? width : 0, transition },
        panel: {
            width,
            opacity: out ? 1 : 0,
            transform: out ? 'translateX(0px)' : `translateX(${String(offscreen)}px)`,
            transition: animate
                ? `transform ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}, opacity ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}`
                : 'none',
            pointerEvents: out ? 'auto' : 'none'
        }
    };
}
