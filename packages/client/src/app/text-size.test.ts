/**
 * The two rules both routes to terminal text size obey (#175), asserted where they live.
 *
 * The reason this is a module with a test rather than an expression inside `App.tsx`: the chord
 * and the View menu row reach the same behaviour by different roads, and only the chord's road
 * has the dispatcher's gates on it. A guard written into the dispatcher alone is one the menu
 * row walks past, which is precisely how the row came to be able to resize the LOCAL daemon's
 * terminals while an embedded remote workspace filled the pane area.
 */

import { describe, expect, it, vi } from 'vitest';

import { createTextSizeStep } from './text-size';

function harness(options: { remote?: boolean; preview?: boolean } = {}) {
    const previewStep = vi.fn(() => options.preview === true);
    const daemonStep = vi.fn(() => true);
    const step = createTextSizeStep({
        remoteWorkspaceSelected: () => options.remote === true,
        previewStep,
        daemonStep
    });
    return { step, previewStep, daemonStep };
}

describe('the terminal text-size step', () => {
    it('steps the daemon-wide size when no pane claims the chord for itself', () => {
        const { step, previewStep, daemonStep } = harness();
        expect(step('increase')).toBe(true);
        expect(previewStep).toHaveBeenCalledWith('increase');
        expect(daemonStep).toHaveBeenCalledWith('increase');
    });

    /*
     * §3.16's own chord, kept. A markdown preview has had ⌘= / ⌘- / ⌘0 since long before #175,
     * and the three chords moving to the terminal actions must not have taken it away.
     */
    it('gives a focused markdown preview its own font size first, and stops there', () => {
        const { step, previewStep, daemonStep } = harness({ preview: true });
        expect(step('reset')).toBe(true);
        expect(previewStep).toHaveBeenCalledWith('reset');
        expect(daemonStep).not.toHaveBeenCalled();
    });

    /**
     * §1.7, and the review's F4: the View menu row reaches this function WITHOUT passing the
     * window dispatcher, whose `hasActiveWorkspace` gate is what stands the local keymap down
     * while a remote workspace fills the pane area. So the gate is here, where both routes meet.
     *
     * Not a cosmetic guard: this window's settings surface holds the PRIMARY daemon's snapshot
     * and its verbs, so a step taken here would have written the local daemon's config while the
     * person was looking at another daemon's pane - the wrong daemon, and the opposite of what
     * config-keybindings.md §7.6 says happens there.
     */
    it('declines every step while an embedded remote workspace fills the pane area', () => {
        const { step, previewStep, daemonStep } = harness({ remote: true });
        for (const which of ['increase', 'decrease', 'reset'] as const) expect(step(which)).toBe(false);
        expect(previewStep).not.toHaveBeenCalled();
        expect(daemonStep).not.toHaveBeenCalled();
    });

    // …including when a markdown preview is focused inside that remote workspace: the preview's
    // own size is the OWNING daemon's pane state, which this window does not write either.
    it('declines a remote step even when a preview would otherwise have taken it', () => {
        const { step, previewStep } = harness({ remote: true, preview: true });
        expect(step('increase')).toBe(false);
        expect(previewStep).not.toHaveBeenCalled();
    });

    // A declining daemon step (the row gone, disabled, off screen) falls through rather than
    // consuming the chord, which is §7.2 step 7 and the shape every conditional binding has.
    it('falls through when neither surface takes it', () => {
        const step = createTextSizeStep({
            remoteWorkspaceSelected: () => false,
            previewStep: () => false,
            daemonStep: () => false
        });
        expect(step('decrease')).toBe(false);
    });
});
