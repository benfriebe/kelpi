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

import { parkKeyboardDecision } from './park-keyboard.js';

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
