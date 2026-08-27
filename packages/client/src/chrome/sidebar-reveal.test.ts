import { describe, expect, it } from 'vitest';

import {
    SIDEBAR_PANEL_GROUND,
    SIDEBAR_SLIDE_EASING,
    SIDEBAR_SLIDE_MS,
    isSidebarMounted,
    isSidebarSettledOpen,
    sidebarPhaseAfterSettle,
    sidebarPhaseFor,
    sidebarSettleDelayMs,
    sidebarSlideStyle,
    type SidebarPhase
} from './sidebar-reveal';

/** Drive the machine the way the component does: a visibility change, then its settle timers. */
function settle(phase: SidebarPhase, steps = 4): SidebarPhase {
    let current = phase;
    for (let index = 0; index < steps; index++) current = sidebarPhaseAfterSettle(current);
    return current;
}

describe('sidebar reveal phases (§WS-001)', () => {
    it('mounts collapsed on show, so the browser has a frame to transition from', () => {
        expect(sidebarPhaseFor('hidden', true)).toBe('opening');
        expect(isSidebarMounted('opening')).toBe(true);
        expect(sidebarSlideStyle('opening', 220).slot.width).toBe(0);
    });

    it('advances to the open geometry on the next frame', () => {
        expect(sidebarSettleDelayMs('opening')).toBe(0);
        expect(sidebarPhaseAfterSettle('opening')).toBe('open');
        expect(sidebarSlideStyle('open', 220).slot.width).toBe(220);
    });

    it('keeps the sidebar mounted for the length of a close, then drops it', () => {
        expect(sidebarPhaseFor('open', false)).toBe('closing');
        expect(isSidebarMounted('closing')).toBe(true);
        expect(sidebarSettleDelayMs('closing')).toBe(SIDEBAR_SLIDE_MS);
        expect(sidebarPhaseAfterSettle('closing')).toBe('hidden');
        expect(isSidebarMounted('hidden')).toBe(false);
    });

    it('reverses mid-flight without a second animation', () => {
        // Mash ⌘⇧S: the panel is already mounted at the collapsed end, so showing again is
        // simply the same transition run the other way.
        expect(sidebarPhaseFor('closing', true)).toBe('open');
        // …and hiding something that never reached the open geometry has nothing to play out.
        expect(sidebarPhaseFor('opening', false)).toBe('hidden');
    });

    it('treats a redundant toggle as a no-op in every phase', () => {
        expect(sidebarPhaseFor('open', true)).toBe('open');
        expect(sidebarPhaseFor('opening', true)).toBe('opening');
        expect(sidebarPhaseFor('hidden', false)).toBe('hidden');
        expect(sidebarPhaseFor('closing', false)).toBe('closing');
        expect(sidebarSettleDelayMs('open')).toBeNull();
        expect(sidebarSettleDelayMs('hidden')).toBeNull();
        expect(settle('open')).toBe('open');
        expect(settle('hidden')).toBe('hidden');
    });

    it('settles to a resting state from either direction', () => {
        expect(settle(sidebarPhaseFor('hidden', true))).toBe('open');
        expect(settle(sidebarPhaseFor('open', false))).toBe('hidden');
    });
});

describe('sidebar slide geometry (§WS-001)', () => {
    it('slides the panel off the leading edge rather than shrinking its contents', () => {
        const closed = sidebarSlideStyle('closing', 220);
        // The slot collapses (that is what the pane grid is pushed by)…
        expect(closed.slot.width).toBe(0);
        // …while the panel keeps its full width and travels, so nothing inside reflows.
        expect(closed.panel.width).toBe(220);
        expect(closed.panel.transform).toBe('translateX(-220px)');
        expect(closed.panel.opacity).toBe(0);
    });

    it('rests flush at the open end', () => {
        const open = sidebarSlideStyle('open', 260);
        expect(open.slot.width).toBe(260);
        expect(open.panel.transform).toBe('translateX(0px)');
        expect(open.panel.opacity).toBe(1);
        expect(isSidebarSettledOpen('open')).toBe(true);
    });

    it('declares the ~0.25s default-ease curve on both halves', () => {
        const style = sidebarSlideStyle('open', 220);
        expect(style.slot.transition).toBe(`width 250ms ${SIDEBAR_SLIDE_EASING}`);
        expect(style.panel.transition).toContain(`transform 250ms ${SIDEBAR_SLIDE_EASING}`);
        expect(style.panel.transition).toContain(`opacity 250ms ${SIDEBAR_SLIDE_EASING}`);
        expect(SIDEBAR_SLIDE_MS).toBe(250);
    });

    /**
     * The regression this guards is a real one: §WS-002's resize handle writes the SAME `width`
     * §WS-001's slide transitions, so with the transition always on, a drag became a 250 ms
     * chase rather than a track — `docs/audit/run-M` attempt 1 read the sidebar one whole drag
     * behind. A gesture turns the animation off for its length; the phase machine keeps it.
     */
    it('drops the transition while a drag owns the width, and keeps every geometry', () => {
        const dragging = sidebarSlideStyle('open', 260, false);
        expect(dragging.slot.transition).toBe('none');
        expect(dragging.panel.transition).toBe('none');
        // Geometry is untouched — only the animation is suppressed.
        expect(dragging.slot.width).toBe(260);
        expect(dragging.panel.width).toBe(260);
        expect(dragging.panel.transform).toBe('translateX(0px)');
        expect(dragging.panel.opacity).toBe(1);
        expect(dragging.panel.pointerEvents).toBe('auto');
        // And the default is still animated, so the toggle is unaffected.
        expect(sidebarSlideStyle('open', 260).slot.transition).toBe(`width 250ms ${SIDEBAR_SLIDE_EASING}`);
        expect(sidebarSlideStyle('closing', 260, false).slot.width).toBe(0);
    });

    it('refuses the pointer while it is on its way anywhere', () => {
        expect(sidebarSlideStyle('open', 220).panel.pointerEvents).toBe('auto');
        expect(sidebarSlideStyle('opening', 220).panel.pointerEvents).toBe('none');
        expect(sidebarSlideStyle('closing', 220).panel.pointerEvents).toBe('none');
        expect(isSidebarSettledOpen('closing')).toBe(false);
    });
});

/**
 * §APP-066's other half: the same machine, mirrored, for the trailing inspector.
 *
 * The item is one sentence covering both panels ("sidebar and inspector show/hide are
 * animated"), and the reason it stayed partial after burn-down 5 is that only one of the two had
 * an animation. What makes this a REUSE rather than a second implementation is that nothing here
 * introduces a phase, a duration or a curve: the only difference between the two panels is the
 * sign of the collapsed transform, because they leave by opposite edges.
 */
describe('the trailing edge (§APP-066, the inspector)', () => {
    it('travels off the RIGHT edge, where the sidebar travels off the left', () => {
        expect(sidebarSlideStyle('closing', 280, true, 'trailing').panel.transform).toBe(
            'translateX(280px)'
        );
        expect(sidebarSlideStyle('closing', 280, true, 'leading').panel.transform).toBe(
            'translateX(-280px)'
        );
        // …and `leading` is the default, so every existing sidebar call site is unchanged.
        expect(sidebarSlideStyle('closing', 280).panel.transform).toBe('translateX(-280px)');
    });

    it('shares the curve, the duration and every other geometry with the sidebar', () => {
        const inspector = sidebarSlideStyle('open', 280, true, 'trailing');
        const sidebar = sidebarSlideStyle('open', 280, true, 'leading');
        // Everything but the EDGE ANCHOR is identical at rest. The anchor is §N31's: a panel is
        // pinned to the edge it travels from for the whole of its life, not only while moving,
        // because that is what makes the two directions one arithmetic (see the anchor block
        // below) — so it is the one field that legitimately differs here.
        const { left: _il, right: _ir, ...inspectorRest } = inspector.panel;
        const { left: _sl, right: _sr, ...sidebarRest } = sidebar.panel;
        expect(inspectorRest).toEqual(sidebarRest);
        expect(inspector.slot).toEqual(sidebar.slot);
        expect(inspector.clip).toEqual(sidebar.clip);
        expect(inspector.slot.transition).toBe(`width ${String(SIDEBAR_SLIDE_MS)}ms ${SIDEBAR_SLIDE_EASING}`);
    });

    it('collapses the slot the same way, so the grid takes the space back', () => {
        for (const phase of ['hidden', 'opening', 'closing'] as const) {
            expect(sidebarSlideStyle(phase, 280, true, 'trailing').slot.width).toBe(0);
            expect(sidebarSlideStyle(phase, 280, true, 'trailing').panel.width).toBe(280);
            expect(sidebarSlideStyle(phase, 280, true, 'trailing').panel.pointerEvents).toBe('none');
        }
    });

    it('anchors the panel to the edge it travels from, both ways', () => {
        const inspector = sidebarSlideStyle('open', 280, true, 'trailing').panel;
        const sidebar = sidebarSlideStyle('open', 220, true, 'leading').panel;
        expect(inspector.position).toBe('absolute');
        expect([inspector.left, inspector.right]).toEqual(['auto', 0]);
        expect([sidebar.left, sidebar.right]).toEqual([0, 'auto']);
        // Full height either way: the clip is the containing block and the panel spans it.
        expect([sidebar.top, sidebar.bottom]).toEqual([0, 0]);
        expect([inspector.top, inspector.bottom]).toEqual([0, 0]);
    });

    it('still has the drag opt-out available, unused though the inspector leaves it', () => {
        // The inspector is a fixed 280px with no edge handle, so it passes `animate: true`. The
        // parameter is kept on the shared function rather than special-cased away, so the day
        // the inspector gains a resize gesture the fix §WS-002 needed is already here.
        const dragging = sidebarSlideStyle('open', 280, false, 'trailing');
        expect(dragging.slot.transition).toBe('none');
        expect(dragging.panel.transition).toBe('none');
    });
});

/**
 * §N31 — the reveal is the panel's own colour, at every point of the slide.
 *
 * The defect this closes was two faults with one symptom. The container between the slot and the
 * panel painted NOTHING, so anything the panel failed to cover was `<body>`'s ground — and under
 * a window created transparent (§N17) that ground is `transparent`, i.e. the desktop, which on a
 * light wallpaper is a white flash in a dark app. And the inspector's panel, travelling off the
 * TRAILING edge while flow laid it out at its container's LEADING one, failed to cover most of
 * its own slide: the frame harness measured 0 % coverage for the first half of every inspector
 * slide and 100 % of the revealed strip fully cleared mid-flight.
 *
 * Both halves are arithmetic, so both are checkable here rather than only in a screenshot.
 */
describe('the reveal shows the panel’s own colour (§N31)', () => {
    it('the clip carries the panel ground for the full animated width, in every phase', () => {
        for (const phase of ['hidden', 'opening', 'open', 'closing'] as const) {
            for (const edge of ['leading', 'trailing'] as const) {
                expect(sidebarSlideStyle(phase, 240, true, edge).clip.background).toBe(SIDEBAR_PANEL_GROUND);
            }
        }
        // The token, not a hex: the sidebar and the inspector both paint `sidebarBackground`, so
        // a recoloured chrome moves the reveal with them.
        expect(SIDEBAR_PANEL_GROUND).toContain('--nex-sidebar-bg');
    });

    it('the clip is the panel’s containing block, or the anchor anchors to the window', () => {
        expect(sidebarSlideStyle('open', 240).clip.position).toBe('relative');
    });

    /**
     * The invariant the flash was a violation of, stated as the geometry it is.
     *
     * At slide progress `p` the slot is `width·p` wide and the panel is translated by
     * `±width·(1−p)`. With the panel anchored to the edge it travels from, the panel's box in
     * clip space is `[0, width]` at EVERY `p` — so it covers `[0, width·p]`, which is the whole
     * clip, from the first frame to the last. In flow (the pre-fix arrangement) a trailing panel
     * sat at `[width−width·p, 2·width−width·p]`, which does not even intersect `[0, width·p]`
     * until `p > 0.5`.
     */
    it('covers the whole slot at every point of the slide, on both edges', () => {
        for (const edge of ['leading', 'trailing'] as const) {
            const width = edge === 'trailing' ? 280 : 220;
            const style = sidebarSlideStyle('open', width, true, edge);
            for (let p = 0; p <= 1.0001; p += 0.05) {
                const slot = width * p;
                // Where the anchor puts the panel's leading corner inside the clip, before the
                // transform: `left: 0`, or `right: 0` (i.e. `clipWidth − width`).
                const anchored = style.panel.left === 0 ? 0 : slot - width;
                const translated = anchored + (edge === 'trailing' ? width * (1 - p) : -(width * (1 - p)));
                const covered =
                    Math.max(0, Math.min(slot, translated + width) - Math.max(0, translated));
                expect(covered).toBeCloseTo(slot, 6);
            }
        }
    });

    it('the pre-fix arrangement fails that same invariant, so the test is not self-satisfying', () => {
        // Flow layout: a panel always starts at its container's LEADING edge.
        const width = 280;
        let worst = 1;
        for (let p = 0; p <= 1.0001; p += 0.05) {
            const slot = width * p;
            const translated = 0 + width * (1 - p);
            const covered = Math.max(0, Math.min(slot, translated + width) - Math.max(0, translated));
            worst = Math.min(worst, slot === 0 ? 1 : covered / slot);
        }
        expect(worst).toBe(0);
    });
});
