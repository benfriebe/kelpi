/**
 * A phone, and a software keyboard, for jsdom.
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * (there is no Swift phone UI; `chrome/form-factor.ts` says so once for all of it). This module is
 * the test double the phone rules are driven through.
 *
 * It exists because jsdom has no layout, no `matchMedia` at all and no `visualViewport` worth the
 * name, so the only way to render a component under the phone form factor is to hand it a window.
 * `chrome/form-factor.ts` takes exactly that: `useFormFactor(win)` and `useSoftKeyboardInset(win)`
 * read a `FormFactorWindow`, and B5's two sheets thread one in through a `formFactorWindow` prop
 * that assembly never passes.
 *
 * It lives under `phone/` rather than beside either sheet because B5 owns two components in two
 * different directories (`settings/SettingsOverlay.tsx` and `chrome/CommandPalette.tsx`) and both
 * of their tests need the same window. `phone/` is the program's shared client surface and is
 * already mapped in `scripts/verify.mjs`.
 *
 * Known sibling: C1/C2 grew a `createFakePhoneWindow` of their own in `terminal/testing.ts` for
 * the terminal's keyboard work, with a richer keyboard animation (a `raiseKeyboard(inset, frames)`
 * that fires one `resize` per animation frame, because C2's subject is a settle rule that has to
 * absorb a burst). B5 has no settle rule to test - an overlay applies the inset it is given, on
 * the render it is given it - so this one moves the keyboard in a single step. When both lanes are
 * merged the two are worth collapsing into this file; they are deliberately not shared across
 * unmerged branches.
 */

import { COARSE_POINTER_QUERY, type FormFactorWindow } from '../chrome/form-factor';

/** iPhone 14/15 in CSS px: the device MOBILE-PLAN.md names and the audit's phone viewport. */
export const FAKE_PHONE_VIEWPORT = { width: 390, height: 844 } as const;

export interface FakePhoneWindow extends FormFactorWindow {
    /**
     * Raise a software keyboard `inset` CSS px tall: the visual viewport shrinks by that much and
     * one `resize` fires on it, which is what `watchSoftKeyboardInset` subscribes to.
     */
    raiseKeyboard(inset: number): void;
    /** Put it away again. */
    lowerKeyboard(): void;
    /** Live listener count, so a test can pin that a desktop render subscribes to nothing. */
    listenerCount(): number;
}

export interface FakePhoneWindowInit {
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    /**
     * `(pointer: coarse)`. False with a phone-sized viewport is the "narrow desktop window" case
     * the form-factor rule deliberately keeps on the desktop side.
     */
    readonly coarse?: boolean | undefined;
}

/**
 * A `FormFactorWindow` that answers `phone` and whose software keyboard a test can drive.
 *
 * Everything the real window would give is faked at the narrowest point `chrome/form-factor.ts`
 * actually reads: `innerWidth`/`innerHeight` for the size, one media query for the pointer, and a
 * `visualViewport` with a live `height` getter for the keyboard. Nothing else is modelled, because
 * nothing else is read.
 */
export function createFakePhoneWindow(init: FakePhoneWindowInit = {}): FakePhoneWindow {
    const width = init.width ?? FAKE_PHONE_VIEWPORT.width;
    const height = init.height ?? FAKE_PHONE_VIEWPORT.height;
    const coarse = init.coarse ?? true;
    let viewportHeight = height;

    const media = new Set<() => void>();
    const windowListeners = new Set<() => void>();
    const viewportListeners = new Map<string, Set<() => void>>();

    const bucket = (type: string): Set<() => void> => {
        const existing = viewportListeners.get(type);
        if (existing !== undefined) return existing;
        const created = new Set<() => void>();
        viewportListeners.set(type, created);
        return created;
    };

    const setViewportHeight = (next: number): void => {
        viewportHeight = next;
        for (const listener of [...bucket('resize')]) listener();
    };

    return {
        innerWidth: width,
        innerHeight: height,
        visualViewport: {
            width,
            get height(): number {
                return viewportHeight;
            },
            // iOS also scrolls the visual viewport to reveal a focused field; B5's sheets pin the
            // field themselves, so this stays 0 and the inset is the keyboard alone.
            offsetTop: 0,
            addEventListener(type: string, listener: () => void): void {
                bucket(type).add(listener);
            },
            removeEventListener(type: string, listener: () => void): void {
                bucket(type).delete(listener);
            }
        },
        location: { search: '' },
        matchMedia(query: string) {
            return {
                get matches(): boolean {
                    return query === COARSE_POINTER_QUERY ? coarse : false;
                },
                addEventListener(_type: 'change', listener: () => void): void {
                    media.add(listener);
                },
                removeEventListener(_type: 'change', listener: () => void): void {
                    media.delete(listener);
                }
            };
        },
        addEventListener(type: string, listener: () => void): void {
            if (type === 'resize') windowListeners.add(listener);
        },
        removeEventListener(_type: string, listener: () => void): void {
            windowListeners.delete(listener);
        },
        raiseKeyboard(inset: number): void {
            setViewportHeight(height - inset);
        },
        lowerKeyboard(): void {
            setViewportHeight(height);
        },
        listenerCount(): number {
            let total = media.size + windowListeners.size;
            for (const set of viewportListeners.values()) total += set.size;
            return total;
        }
    };
}
