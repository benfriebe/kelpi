/**
 * The form-factor signal: the one place the client decides it is on a phone.
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift
 * app.** There is no Swift phone UI to port - the shipped app is a Mac app - so nothing here has
 * a parity reference and nothing here can have one. The whole phone program (docs/MOBILE-PLAN.md)
 * hangs off this module, and this is the file that says so once, for all of it.
 *
 * ## The rule
 *
 * Phone when BOTH hold:
 *
 *   1. the viewport's NARROW dimension - `min(innerWidth, innerHeight)` - is under
 *      `PHONE_NARROW_MAX_PX` (768) CSS px, and
 *   2. `(pointer: coarse)` matches.
 *
 * Both are required, and that is the coordinator's decision of 2026-09-03 (MOBILE-PLAN.md §7).
 * The measurements it rests on are device geometry in CSS pixels: an iPhone 14/15 is 390×844 and
 * an iPhone 15 Pro 393×852, so the narrow side of every current phone is under 400 in both
 * orientations; an iPad in portrait is 768×1024, so 768 is the first width that must NOT be a
 * phone and the bound is therefore exclusive. Requiring a coarse pointer on top of that is what
 * keeps a narrow DESKTOP window a desktop: a 500 px-wide Kelpi window on a Mac has a fine
 * pointer, a real keyboard and a real menu bar, and shrinking it must not swap the whole layout
 * out from under the person dragging the edge.
 *
 * Known consequence, recorded rather than special-cased: an iPad mini is 744×1133 CSS px, so its
 * narrow side IS under 768 and it resolves to `phone`. §7 says "tablets are desktop until the
 * device round says otherwise", and it names 768 as the line; the mini sits on the phone side of
 * the line the decision drew. Changing that means changing the number (or adding a second
 * signal), not adding a device check here, and it is one line when the owner's device round asks
 * for it.
 *
 * ## What is measured, and what is only subscribed to
 *
 * The SIZE comes from the layout viewport (`innerWidth`/`innerHeight`), never from
 * `visualViewport`. A software keyboard shrinks the visual viewport by 300 px or more, and on an
 * iPad that would take the narrow dimension from 768 to about 450 - flipping a tablet into the
 * phone layout the moment somebody typed, and back out when they stopped. The layout viewport
 * does not move for a keyboard, so it is the honest input. `visualViewport`'s resize is still
 * SUBSCRIBED to, because on iOS a rotation reliably fires it and `window.resize` sometimes lands
 * a frame later; it is a change trigger, not a measurement.
 *
 * ## There is deliberately no "Electron is always desktop" rule
 *
 * The shell answers `desktop` because its media queries answer desktop: a Mac window has a fine
 * pointer. Hard-coding it would be a rule with no behaviour of its own AND it would break the
 * phone audit lane, which runs inside the Electron shell under CDP device emulation
 * (`scripts/ui-audit/audit.mjs` `emulatePhone`) - a hard override would make that lane assert
 * against a layout no phone will ever see.
 *
 * Measured on 2026-09-03 by the `phone-form-factor` step, inside the Electron shell: with
 * `Emulation.setDeviceMetricsOverride({ width: 390, height: 844, deviceScaleFactor: 3,
 * mobile: true })` plus `Emulation.setTouchEmulationEnabled({ enabled: true, maxTouchPoints: 5 })`,
 * the renderer reports `innerWidth` 390, `innerHeight` 844, `devicePixelRatio` 3,
 * `(pointer: coarse)` TRUE, `(hover: none)` true and `navigator.maxTouchPoints` 5 - so the rule
 * above resolves `phone` on its own and the `?form=` override is not needed to drive the lane.
 * Clearing the emulation puts the same window back at 1280x820 @2x with `(pointer: coarse)`
 * false, i.e. `desktop`, in the same session.
 */

import { useCallback, useSyncExternalStore } from 'react';

export type FormFactor = 'phone' | 'desktop';

/**
 * The first narrow-dimension width that is NOT a phone (an iPad portrait is exactly 768), so the
 * comparison below is strictly less-than.
 */
export const PHONE_NARROW_MAX_PX = 768;

/** The query the rule's second half asks. Exported so a test can fake exactly this string. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** The query parameter that overrides the answer, for tests and for the audit's escape hatch. */
export const FORM_FACTOR_PARAM = 'form';

/** The attribute `bindFormFactorAttribute` writes on `<html>`. */
export const FORM_FACTOR_ATTRIBUTE = 'data-form-factor';

/** Everything `resolveFormFactor` needs, and nothing else - so the decision is testable as data. */
export interface FormFactorSignal {
    /** Layout viewport width in CSS px (`window.innerWidth`). */
    readonly width: number;
    /** Layout viewport height in CSS px (`window.innerHeight`). */
    readonly height: number;
    readonly coarsePointer: boolean;
    /** `?form=phone|desktop`, or null. Wins outright when present. */
    readonly override?: FormFactor | null | undefined;
}

/** The decision itself: pure, total, and the only place the rule is written down. */
export function resolveFormFactor(signal: FormFactorSignal): FormFactor {
    const override = signal.override ?? null;
    if (override !== null) return override;
    const narrow = Math.min(signal.width, signal.height);
    return narrow < PHONE_NARROW_MAX_PX && signal.coarsePointer ? 'phone' : 'desktop';
}

/**
 * `?form=phone` / `?form=desktop` → that answer; anything else → null.
 *
 * The parameter survives `main.tsx`'s address-bar sanitising: `app/config.ts`'s `sanitizedSearch`
 * strips `daemon` and `token` and preserves every other parameter, so an overridden page keeps
 * its override across the `history.replaceState` that hides the token.
 */
export function formFactorOverride(search: string): FormFactor | null {
    const value = new URLSearchParams(search).get(FORM_FACTOR_PARAM);
    return value === 'phone' || value === 'desktop' ? value : null;
}

// ── the environment ─────────────────────────────────────────────────────────────────
//
// Injected as one window-shaped object rather than read from globals, so every test below is
// pure over the media-query state it hands in. The real `window` satisfies it.

export interface MediaQueryListLike {
    readonly matches: boolean;
    addEventListener?: ((type: 'change', listener: () => void) => void) | undefined;
    removeEventListener?: ((type: 'change', listener: () => void) => void) | undefined;
}

export interface VisualViewportLike {
    readonly width: number;
    readonly height: number;
    readonly offsetTop: number;
    addEventListener?: ((type: string, listener: () => void) => void) | undefined;
    removeEventListener?: ((type: string, listener: () => void) => void) | undefined;
}

export interface FormFactorWindow {
    readonly innerWidth: number;
    readonly innerHeight: number;
    readonly visualViewport?: VisualViewportLike | null | undefined;
    readonly location?: { readonly search: string } | undefined;
    matchMedia?: ((query: string) => MediaQueryListLike) | undefined;
    addEventListener?: ((type: string, listener: () => void) => void) | undefined;
    removeEventListener?: ((type: string, listener: () => void) => void) | undefined;
}

/**
 * The page's own window, or a zero-sized stand-in where there is none (SSR, a bare Node import).
 * A stand-in resolves `desktop`, which is the safe answer: it renders what ships today.
 */
export function defaultFormFactorWindow(): FormFactorWindow {
    const win = (globalThis as { window?: FormFactorWindow }).window;
    return win ?? { innerWidth: 0, innerHeight: 0 };
}

function coarsePointer(win: FormFactorWindow): boolean {
    // `matchMedia` is absent in some embedders and in a bare jsdom shim; no media query means no
    // coarse pointer, which resolves desktop.
    return win.matchMedia?.(COARSE_POINTER_QUERY).matches === true;
}

/** What the window currently says, in the shape `resolveFormFactor` reads. */
export function readFormFactorSignal(win: FormFactorWindow = defaultFormFactorWindow()): FormFactorSignal {
    return {
        width: win.innerWidth,
        height: win.innerHeight,
        coarsePointer: coarsePointer(win),
        override: formFactorOverride(win.location?.search ?? '')
    };
}

/** The current answer, outside React (the attribute binder and any non-component caller). */
export function currentFormFactor(win: FormFactorWindow = defaultFormFactorWindow()): FormFactor {
    return resolveFormFactor(readFormFactorSignal(win));
}

/**
 * Subscribe to everything that can change the answer: the pointer media query (a Bluetooth mouse
 * paired to an iPad flips it live), the window's own resize, and the visual viewport's resize
 * (the rotation trigger described in the header). Returns an unsubscribe.
 */
export function watchFormFactor(win: FormFactorWindow, onChange: () => void): () => void {
    const media = win.matchMedia?.(COARSE_POINTER_QUERY);
    media?.addEventListener?.('change', onChange);
    win.addEventListener?.('resize', onChange);
    const viewport = win.visualViewport ?? null;
    viewport?.addEventListener?.('resize', onChange);
    return () => {
        media?.removeEventListener?.('change', onChange);
        win.removeEventListener?.('resize', onChange);
        viewport?.removeEventListener?.('resize', onChange);
    };
}

/** The live form factor. Re-renders the caller only when the ANSWER changes, not on every event. */
export function useFormFactor(win: FormFactorWindow = defaultFormFactorWindow()): FormFactor {
    const subscribe = useCallback((onChange: () => void) => watchFormFactor(win, onChange), [win]);
    // The snapshot is a string, so React's identity check is a value check and re-computing it
    // on every render cannot loop (which a fresh object snapshot would).
    return useSyncExternalStore(
        subscribe,
        () => currentFormFactor(win),
        () => 'desktop' as const
    );
}

// ── the software keyboard ───────────────────────────────────────────────────────────

/**
 * How many CSS pixels the software keyboard occupies at the bottom of the window.
 *
 * `innerHeight - visualViewport.height - visualViewport.offsetTop`: the layout viewport is the
 * whole window, the visual viewport is what is actually visible above the keyboard, and
 * `offsetTop` is how far iOS has scrolled the visual viewport down inside the layout one when it
 * pins a focused field. Subtracting it is what keeps the number "keyboard", not "keyboard plus
 * the scroll iOS did to reveal the field". Clamped at zero and rounded: iOS reports fractional
 * viewport heights, and a -0.5 px inset is a layout the client must never try to honour.
 *
 * Zero where there is no `visualViewport` (every desktop browser that predates it, jsdom, the
 * Electron shell before a keyboard exists), which is the correct answer there: no software
 * keyboard, no inset.
 */
export function readSoftKeyboardInset(win: FormFactorWindow = defaultFormFactorWindow()): number {
    const viewport = win.visualViewport ?? null;
    if (viewport === null) return 0;
    return Math.max(0, Math.round(win.innerHeight - viewport.height - viewport.offsetTop));
}

/**
 * Subscribe to the visual viewport's resize AND scroll: iOS moves `offsetTop` on scroll without
 * resizing anything, and an inset computed from a stale `offsetTop` is wrong by exactly the
 * distance the page was pushed up.
 */
export function watchSoftKeyboardInset(win: FormFactorWindow, onChange: () => void): () => void {
    const viewport = win.visualViewport ?? null;
    if (viewport === null) return () => {};
    viewport.addEventListener?.('resize', onChange);
    viewport.addEventListener?.('scroll', onChange);
    return () => {
        viewport.removeEventListener?.('resize', onChange);
        viewport.removeEventListener?.('scroll', onChange);
    };
}

/** The live software-keyboard inset in CSS px; always 0 where there is no visual viewport. */
export function useSoftKeyboardInset(win: FormFactorWindow = defaultFormFactorWindow()): number {
    const subscribe = useCallback((onChange: () => void) => watchSoftKeyboardInset(win, onChange), [win]);
    return useSyncExternalStore(
        subscribe,
        () => readSoftKeyboardInset(win),
        () => 0
    );
}

// ── the attribute ───────────────────────────────────────────────────────────────────

/** The slice of `Document` the binder writes to. */
export interface FormFactorDocument {
    readonly documentElement: { readonly dataset: DOMStringMap };
    readonly defaultView?: FormFactorWindow | null | undefined;
}

/**
 * Write `data-form-factor` on `<html>` and keep it current. Returns an unsubscribe.
 *
 * Called once from `main.tsx` before render. It exists so that everything which needs the answer
 * but is not a React component can read ONE attribute: the live audit's `phone-form-factor` step
 * (E2) asserts on it from CDP, `styles.css` can select on it, and the phone shell (B1) is spared
 * threading a prop into surfaces that only need to know which world they are in. The React hook
 * above stays the source of truth for anything that renders.
 */
export function bindFormFactorAttribute(
    doc: FormFactorDocument = document,
    win: FormFactorWindow = doc.defaultView ?? defaultFormFactorWindow()
): () => void {
    const apply = (): void => {
        doc.documentElement.dataset['formFactor'] = currentFormFactor(win);
    };
    apply();
    return watchFormFactor(win, apply);
}
