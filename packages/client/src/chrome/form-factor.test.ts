import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    PHONE_NARROW_MAX_PX,
    bindFormFactorAttribute,
    currentFormFactor,
    formFactorOverride,
    readSoftKeyboardInset,
    resolveFormFactor,
    useFormFactor,
    useSoftKeyboardInset,
    type FormFactorWindow
} from './index';

afterEach(cleanup);

/**
 * A window whose media-query state, size and visual viewport are data. The hooks take their
 * environment as a parameter precisely so these tests never have to monkey-patch a global.
 */
interface FakeViewport {
    width: number;
    height: number;
    offsetTop: number;
}

function fakeWindow(init: {
    width: number;
    height: number;
    coarse: boolean;
    search?: string;
    viewport?: FakeViewport | null;
}): FormFactorWindow & {
    resize(width: number, height: number): void;
    setPointer(coarse: boolean): void;
    moveViewport(next: Partial<FakeViewport>): void;
    listenerCount(): number;
} {
    const state = {
        width: init.width,
        height: init.height,
        coarse: init.coarse,
        search: init.search ?? '',
        viewport: init.viewport ?? null
    };
    const media = new Set<() => void>();
    const windowResize = new Set<() => void>();
    const viewportEvents = new Map<string, Set<() => void>>();
    const viewportSet = (type: string): Set<() => void> => {
        const existing = viewportEvents.get(type);
        if (existing !== undefined) return existing;
        const created = new Set<() => void>();
        viewportEvents.set(type, created);
        return created;
    };

    const viewport =
        state.viewport === null
            ? null
            : {
                  get width(): number {
                      return state.viewport?.width ?? 0;
                  },
                  get height(): number {
                      return state.viewport?.height ?? 0;
                  },
                  get offsetTop(): number {
                      return state.viewport?.offsetTop ?? 0;
                  },
                  addEventListener(type: string, listener: () => void): void {
                      viewportSet(type).add(listener);
                  },
                  removeEventListener(type: string, listener: () => void): void {
                      viewportSet(type).delete(listener);
                  }
              };

    const fire = (listeners: Set<() => void>): void => {
        for (const listener of [...listeners]) listener();
    };

    return {
        get innerWidth(): number {
            return state.width;
        },
        get innerHeight(): number {
            return state.height;
        },
        get location(): { readonly search: string } {
            return { search: state.search };
        },
        visualViewport: viewport,
        matchMedia(query: string) {
            return {
                get matches(): boolean {
                    return query === '(pointer: coarse)' ? state.coarse : false;
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
            if (type === 'resize') windowResize.add(listener);
        },
        removeEventListener(type: string, listener: () => void): void {
            windowResize.delete(listener);
        },
        resize(width: number, height: number): void {
            state.width = width;
            state.height = height;
            fire(windowResize);
        },
        setPointer(coarse: boolean): void {
            state.coarse = coarse;
            fire(media);
        },
        moveViewport(next: Partial<FakeViewport>): void {
            if (state.viewport === null) return;
            state.viewport = { ...state.viewport, ...next };
            fire(viewportSet('resize'));
            fire(viewportSet('scroll'));
        },
        listenerCount(): number {
            let total = media.size + windowResize.size;
            for (const set of viewportEvents.values()) total += set.size;
            return total;
        }
    };
}

describe('resolveFormFactor', () => {
    it('is desktop on a jsdom default window (1024x768, fine pointer)', () => {
        // The real `window` this suite runs in: the "and not on desktop" baseline every phone
        // behaviour in the program is asserted against.
        expect(window.innerWidth).toBe(1024);
        expect(window.innerHeight).toBe(768);
        expect(currentFormFactor()).toBe('desktop');
    });

    it('is phone for a portrait phone with a coarse pointer', () => {
        // iPhone 14/15 in CSS px.
        expect(resolveFormFactor({ width: 390, height: 844, coarsePointer: true })).toBe('phone');
    });

    it('is phone for the same device in landscape (the NARROW dimension decides)', () => {
        expect(resolveFormFactor({ width: 844, height: 390, coarsePointer: true })).toBe('phone');
    });

    it('is desktop for a phone-sized window with a fine pointer', () => {
        // A narrow desktop window: small, but a mouse and a keyboard are attached.
        expect(resolveFormFactor({ width: 390, height: 844, coarsePointer: false })).toBe('desktop');
    });

    it('is desktop for a large window with a coarse pointer (a touchscreen desktop)', () => {
        expect(resolveFormFactor({ width: 1024, height: 768, coarsePointer: true })).toBe('desktop');
    });

    it('is desktop exactly at the boundary: an iPad portrait is 768 CSS px wide', () => {
        expect(PHONE_NARROW_MAX_PX).toBe(768);
        expect(resolveFormFactor({ width: 768, height: 1024, coarsePointer: true })).toBe('desktop');
        // One pixel narrower is a phone, so the bound is exclusive and the test says which side.
        expect(resolveFormFactor({ width: 767, height: 1024, coarsePointer: true })).toBe('phone');
    });

    it('lets the override win in both directions', () => {
        expect(resolveFormFactor({ width: 1440, height: 900, coarsePointer: false, override: 'phone' })).toBe(
            'phone'
        );
        expect(resolveFormFactor({ width: 390, height: 844, coarsePointer: true, override: 'desktop' })).toBe(
            'desktop'
        );
    });
});

describe('formFactorOverride', () => {
    it('reads ?form=phone and ?form=desktop, and nothing else', () => {
        expect(formFactorOverride('?form=phone')).toBe('phone');
        expect(formFactorOverride('?form=desktop')).toBe('desktop');
        expect(formFactorOverride('?token=kd_x&form=phone')).toBe('phone');
        expect(formFactorOverride('?form=tablet')).toBeNull();
        expect(formFactorOverride('?form=')).toBeNull();
        expect(formFactorOverride('?other=phone')).toBeNull();
        expect(formFactorOverride('')).toBeNull();
    });

    it('reaches the resolved answer through the window', () => {
        const win = fakeWindow({ width: 1440, height: 900, coarse: false, search: '?form=phone' });
        expect(currentFormFactor(win)).toBe('phone');
    });
});

describe('useFormFactor', () => {
    it('follows the pointer media query and the window resize, and unsubscribes on unmount', () => {
        const win = fakeWindow({ width: 390, height: 844, coarse: false });
        const view = renderHook(() => useFormFactor(win));
        expect(view.result.current).toBe('desktop');

        act(() => {
            win.setPointer(true);
        });
        expect(view.result.current).toBe('phone');

        act(() => {
            win.resize(1440, 900);
        });
        expect(view.result.current).toBe('desktop');

        expect(win.listenerCount()).toBeGreaterThan(0);
        view.unmount();
        expect(win.listenerCount()).toBe(0);
    });

    it('answers desktop for the window this suite runs in, whatever else changes', () => {
        const view = renderHook(() => useFormFactor());
        expect(view.result.current).toBe('desktop');
    });
});

describe('useSoftKeyboardInset', () => {
    it('is zero where there is no visual viewport', () => {
        const win = fakeWindow({ width: 390, height: 844, coarse: true });
        expect(readSoftKeyboardInset(win)).toBe(0);
        const view = renderHook(() => useSoftKeyboardInset(win));
        expect(view.result.current).toBe(0);
        view.unmount();
    });

    it('measures the keyboard as the layout viewport minus the visual one, minus its offset', () => {
        const win = fakeWindow({
            width: 390,
            height: 844,
            coarse: true,
            viewport: { width: 390, height: 844, offsetTop: 0 }
        });
        const view = renderHook(() => useSoftKeyboardInset(win));
        expect(view.result.current).toBe(0);

        // A 336 px keyboard, with iOS scrolling the visual viewport 40 px to reveal the field:
        // the inset is the keyboard, not the keyboard plus the scroll.
        act(() => {
            win.moveViewport({ height: 468, offsetTop: 40 });
        });
        expect(view.result.current).toBe(336);

        // Fractional heights round; a viewport taller than the window clamps at zero rather than
        // reporting a negative inset.
        act(() => {
            win.moveViewport({ height: 843.6, offsetTop: 0 });
        });
        expect(view.result.current).toBe(0);

        expect(win.listenerCount()).toBeGreaterThan(0);
        view.unmount();
        expect(win.listenerCount()).toBe(0);
    });

    it('is zero on the desktop window this suite runs in', () => {
        expect(readSoftKeyboardInset()).toBe(0);
    });
});

describe('bindFormFactorAttribute', () => {
    it('writes data-form-factor, keeps it current, and stops after the unsubscribe', () => {
        const doc = document.implementation.createHTMLDocument('form-factor');
        const win = fakeWindow({ width: 390, height: 844, coarse: true });
        const stop = bindFormFactorAttribute(doc, win);
        expect(doc.documentElement.dataset['formFactor']).toBe('phone');
        expect(doc.documentElement.getAttribute('data-form-factor')).toBe('phone');

        win.resize(1440, 900);
        expect(doc.documentElement.dataset['formFactor']).toBe('desktop');

        win.resize(390, 844);
        expect(doc.documentElement.dataset['formFactor']).toBe('phone');

        stop();
        expect(win.listenerCount()).toBe(0);
        win.resize(1440, 900);
        expect(doc.documentElement.dataset['formFactor']).toBe('phone');
    });

    it('writes desktop for a desktop window (the shell and every Mac window)', () => {
        const doc = document.implementation.createHTMLDocument('form-factor');
        const win = fakeWindow({ width: 1440, height: 900, coarse: false });
        const stop = bindFormFactorAttribute(doc, win);
        expect(doc.documentElement.dataset['formFactor']).toBe('desktop');
        stop();
    });

    it('binds against the real document when called with no arguments', () => {
        const stop = bindFormFactorAttribute();
        expect(document.documentElement.dataset['formFactor']).toBe('desktop');
        stop();
    });
});
