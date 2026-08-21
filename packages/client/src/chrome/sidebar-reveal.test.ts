import { describe, expect, it } from 'vitest';

import {
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
