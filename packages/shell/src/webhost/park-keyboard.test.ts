/**
 * The parking handoff (`./park-keyboard.ts`).
 *
 * The rule is three lines, and every one of them is a bug that was shipped:
 *
 *   - a parked view that held the keyboard has to give it up, or the next chord reaches nothing
 *     and the feature "works exactly once";
 *   - a parked view that did NOT hold it must not steal the keyboard from wherever it is - most
 *     parks are a menu opening or a pane hiding while the user types somewhere else entirely;
 *   - an inactive window has no keyboard here to move, and reaching for it would be the app
 *     pulling focus to itself while the user is in another application.
 */

import { describe, expect, it } from 'vitest';

import { parkKeyboardDecision, releaseBeforeHide } from './park-keyboard.js';

describe('parking a view that holds the keyboard', () => {
    it('hands the keyboard back to the client', () => {
        // ⌘⇧] parks the outgoing tab, ⌥⌘↓ parks the whole hidden pane. Both used to leave the
        // keyboard in a window nobody can see, which is why each worked exactly once.
        expect(parkKeyboardDecision({ viewHeldKeyboard: true, windowIsFocused: true })).toBe(
            'restore-to-client'
        );
    });

    it('leaves a park alone when the view did not have the keyboard', () => {
        // The common case by a distance: a menu opens, a pane hides, the window is resized. The
        // user is typing in a terminal and must keep typing there.
        expect(parkKeyboardDecision({ viewHeldKeyboard: false, windowIsFocused: true })).toBe('leave');
    });

    it('never reaches for the keyboard while this window is not the active one', () => {
        // An agent hiding a pane in a background window must not pull focus out of whatever app
        // the user is actually using.
        expect(parkKeyboardDecision({ viewHeldKeyboard: true, windowIsFocused: false })).toBe('leave');
        expect(parkKeyboardDecision({ viewHeldKeyboard: false, windowIsFocused: false })).toBe('leave');
    });
});

/**
 * The ordering, which is the part that was wrong the first time.
 *
 * A tab switch hides the outgoing view one notify BEFORE the park, and `setVisible(false)` drops
 * that view's keyboard focus itself. Sampling after it reads false and declines the handoff, so
 * the keyboard is left with a view nobody can see - ⌘⇧] cycles exactly once and then goes dead,
 * which is the very symptom the fix was for.
 */
describe('releasing before the hide', () => {
    it('gives the keyboard up first, then hides', () => {
        const order: string[] = [];
        const show = releaseBeforeHide<string>(
            (tab, visible) => order.push(`show(${tab},${String(visible)})`),
            (tab) => order.push(`release(${tab})`)
        );
        show('T1', false);
        expect(order).toEqual(['release(T1)', 'show(T1,false)']);
    });

    it('does not touch the keyboard when a view is being SHOWN', () => {
        const order: string[] = [];
        const show = releaseBeforeHide<string>(
            (tab, visible) => order.push(`show(${tab},${String(visible)})`),
            (tab) => order.push(`release(${tab})`)
        );
        show('T1', true);
        expect(order).toEqual(['show(T1,true)']);
    });

    it('runs for every tab the activate loop hides, not just the outgoing one', () => {
        // `registry.ts` calls show(view, tab === active) for EVERY tab in the pane, so this fires
        // for tabs that were already hidden. Harmless by construction: the release checks whether
        // the view actually holds the keyboard, and a hidden one never does.
        const released: string[] = [];
        const show = releaseBeforeHide<string>(
            () => {},
            (tab) => released.push(tab)
        );
        for (const tab of ['T1', 'T2', 'T3']) show(tab, tab === 'T2');
        expect(released).toEqual(['T1', 'T3']);
    });
});
