/**
 * The phone test double, tested against the real rule it feeds.
 *
 * A double that lies is worse than no double: every phone assertion in `settings/` and `chrome/`
 * rests on this window resolving `phone` through `chrome/form-factor.ts`'s OWN rule rather than
 * through anything this file asserts about itself. So the checks below run the shipped
 * `currentFormFactor` and `readSoftKeyboardInset` over it.
 */

import { describe, expect, it } from 'vitest';

import { currentFormFactor, readSoftKeyboardInset } from '../chrome/form-factor';
import { FAKE_PHONE_VIEWPORT, createFakePhoneWindow } from './testing';

describe('the phone test double', () => {
    it('resolves `phone` through the shipped form-factor rule', () => {
        const win = createFakePhoneWindow();
        expect(win.innerWidth).toBe(FAKE_PHONE_VIEWPORT.width);
        expect(currentFormFactor(win)).toBe('phone');
    });

    // The narrow-desktop-window case the rule exists to protect: a phone-sized viewport with a
    // FINE pointer is still a desktop (MOBILE-PLAN.md §7, "Form-factor threshold").
    it('resolves `desktop` when the pointer is not coarse, at the same size', () => {
        expect(currentFormFactor(createFakePhoneWindow({ coarse: false }))).toBe('desktop');
    });

    it('reports the keyboard it was told to raise, and zero once it is put away', () => {
        const win = createFakePhoneWindow();
        expect(readSoftKeyboardInset(win)).toBe(0);
        win.raiseKeyboard(300);
        expect(readSoftKeyboardInset(win)).toBe(300);
        win.lowerKeyboard();
        expect(readSoftKeyboardInset(win)).toBe(0);
    });

    it('fires a viewport resize the inset watcher can hear, and hands its listeners back', () => {
        const win = createFakePhoneWindow();
        let heard = 0;
        win.visualViewport?.addEventListener?.('resize', () => {
            heard += 1;
        });
        win.raiseKeyboard(300);
        expect(heard).toBe(1);
        expect(win.listenerCount()).toBe(1);
    });
});
