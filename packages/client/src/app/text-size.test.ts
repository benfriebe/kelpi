/**
 * The rules both routes to terminal text size obey (#175), asserted where they live.
 *
 * The reason this is a module with a test rather than an expression inside `App.tsx`: the chord
 * and the View menu row reach the same behaviour by different roads, and only the chord's road
 * has the dispatcher's gates on it. A guard written into the dispatcher alone is one the menu
 * row walks past, which is precisely how the row came to be able to resize the LOCAL daemon's
 * terminals while an embedded remote workspace filled the pane area.
 */

import { describe, expect, it, vi } from 'vitest';

import { createPaneTextSizeStep, createTextSizeStep } from './text-size';

function harness(options: { remote?: boolean; preview?: boolean; scope?: 'pane' | 'all'; terminal?: boolean } = {}) {
    const previewStep = vi.fn(() => options.preview === true);
    const paneStep = vi.fn(() => options.terminal !== false);
    const daemonStep = vi.fn(() => true);
    const step = createTextSizeStep({
        remoteWorkspaceSelected: () => options.remote === true,
        previewStep,
        scope: () => options.scope ?? 'all',
        paneStep,
        daemonStep
    });
    return { step, previewStep, paneStep, daemonStep };
}

describe('the terminal text-size step', () => {
    it('steps the daemon-wide size under font-size-scope = all', () => {
        const { step, previewStep, paneStep, daemonStep } = harness();
        expect(step('increase')).toBe(true);
        expect(previewStep).toHaveBeenCalledWith('increase');
        expect(daemonStep).toHaveBeenCalledWith('increase');
        expect(paneStep).not.toHaveBeenCalled();
    });

    it("steps only the focused pane's own size under font-size-scope = pane", () => {
        const { step, paneStep, daemonStep } = harness({ scope: 'pane' });
        expect(step('decrease')).toBe(true);
        expect(paneStep).toHaveBeenCalledWith('decrease');
        expect(daemonStep).not.toHaveBeenCalled();
    });

    // Under `pane`, a focused pane that is not a terminal must not quietly resize every terminal
    // instead: the chord falls through, as any conditional binding does.
    it('falls through under font-size-scope = pane when the focused pane is not a terminal', () => {
        const { step, daemonStep } = harness({ scope: 'pane', terminal: false });
        expect(step('increase')).toBe(false);
        expect(daemonStep).not.toHaveBeenCalled();
    });

    /*
     * §3.16's own chord, kept. A markdown preview has had ⌘= / ⌘- / ⌘0 since long before #175,
     * and the three chords moving to the terminal actions must not have taken it away.
     */
    it('gives a focused markdown preview its own font size first, and stops there', () => {
        for (const scope of ['pane', 'all'] as const) {
            const { step, previewStep, paneStep, daemonStep } = harness({ preview: true, scope });
            expect(step('reset')).toBe(true);
            expect(previewStep).toHaveBeenCalledWith('reset');
            expect(paneStep).not.toHaveBeenCalled();
            expect(daemonStep).not.toHaveBeenCalled();
        }
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
        for (const scope of ['pane', 'all'] as const) {
            const { step, previewStep, paneStep, daemonStep } = harness({ remote: true, scope });
            for (const which of ['increase', 'decrease', 'reset'] as const) expect(step(which)).toBe(false);
            expect(previewStep).not.toHaveBeenCalled();
            expect(paneStep).not.toHaveBeenCalled();
            expect(daemonStep).not.toHaveBeenCalled();
        }
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
            scope: () => 'all',
            paneStep: () => true,
            daemonStep: () => false
        });
        expect(step('decrease')).toBe(false);
    });
});

describe("a terminal pane's own text size", () => {
    function paneHarness(own: number | null | undefined, fallback = 13) {
        const state = { own, fallback };
        const answers: (() => void)[] = [];
        const send = vi.fn((_paneID: string, size: number | null) => new Promise<void>((resolve) => {
            answers.push(() => {
                state.own = size;
                resolve();
            });
        }));
        const step = createPaneTextSizeStep({ ownSize: () => state.own, defaultSize: () => state.fallback, send });
        const answerAll = async (): Promise<void> => {
            for (const answer of answers.splice(0)) answer();
            await Promise.resolve();
            await Promise.resolve();
        };
        return { step, send, state, answerAll };
    }

    it('starts from the default when the pane has no size of its own', () => {
        const { step, send } = paneHarness(null, 13);
        expect(step('p1', 'increase')).toBe(true);
        expect(send).toHaveBeenCalledWith('p1', 14);
    });

    it("steps from the pane's own size when it has one", () => {
        const { step, send } = paneHarness(20);
        expect(step('p1', 'decrease')).toBe(true);
        expect(send).toHaveBeenCalledWith('p1', 19);
    });

    // Zoomed in and back out, the pane follows the Font size row again rather than pinning it.
    it('stores null, not the number, when a step lands back on the default', () => {
        const { step, send } = paneHarness(14, 13);
        step('p1', 'decrease');
        expect(send).toHaveBeenCalledWith('p1', null);
    });

    it('drops the own size on reset', () => {
        const { step, send } = paneHarness(18);
        step('p1', 'reset');
        expect(send).toHaveBeenCalledWith('p1', null);
    });

    it('consumes a step that changes nothing without sending it', () => {
        for (const [own, which] of [[32, 'increase'], [8, 'decrease'], [null, 'reset']] as const) {
            const { step, send } = paneHarness(own);
            expect(step('p1', which)).toBe(true);
            expect(send).not.toHaveBeenCalled();
        }
    });

    it('declines a pane that is gone or is not a terminal', () => {
        const { step, send } = paneHarness(undefined);
        expect(step('p1', 'increase')).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });

    /*
     * A held-down ⌘= repeats faster than the daemon answers. Each press has to start from the
     * size last ASKED for, or every repeat re-sends the first step and the pane moves by one.
     */
    it('composes repeats that arrive before the daemon has answered', async () => {
        const { step, send, state, answerAll } = paneHarness(null, 13);
        step('p1', 'increase');
        step('p1', 'increase');
        step('p1', 'increase');
        expect(send.mock.calls.map((call) => call[1])).toEqual([14, 15, 16]);
        await answerAll();
        expect(state.own).toBe(16);
        // Once every ask has settled, the store is the word again.
        state.own = 20;
        step('p1', 'increase');
        expect(send).toHaveBeenLastCalledWith('p1', 21);
    });

    it("keeps each pane's in-flight asks to itself", () => {
        const { step, send } = paneHarness(null, 13);
        step('p1', 'increase');
        step('p2', 'increase');
        expect(send.mock.calls).toEqual([['p1', 14], ['p2', 14]]);
    });

    it('lets go of the in-flight ask when the daemon refuses it', async () => {
        const state = { own: null as number | null };
        let refuse: (error: Error) => void = () => {};
        const send = vi.fn((_paneID: string, _size: number | null) => new Promise<void>((_resolve, reject) => { refuse = reject; }));
        const step = createPaneTextSizeStep({ ownSize: () => state.own, defaultSize: () => 13, send });
        step('p1', 'increase');
        refuse(new Error('pane gone'));
        await Promise.resolve();
        await Promise.resolve();
        step('p1', 'increase');
        expect(send).toHaveBeenLastCalledWith('p1', 14);
    });
});
