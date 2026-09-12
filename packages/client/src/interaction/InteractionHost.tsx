/**
 * The window's interaction host: everything about a prompt or a palette session that must keep
 * working whoever draws it.
 *
 * It replaces the prompt host (formerly `plugins/UIServiceHost.tsx`, now deleted), and the split is
 * the point. That component was both the wrapper and the presenter, so the rules a presenter must
 * not be able to take with it (the modal registration that parks native pages, the visibility gate,
 * the focus capture and release, the Escape policy) were entangled with the JSX that happened to
 * draw a dialog. Here:
 *
 *   - **One modal registration** for as long as EITHER surface is painted (§2.3). The palette
 *     outranks a queued prompt, so a prompt's visibility additionally requires `!palette.open`.
 *   - **One focus authority** (§2.4), replacing the two that used to compete: capture on the first
 *     painted surface, containment while a modal is up (the presenter's own business - it knows
 *     what "inside" means), and release with a fixed precedence: a pending palette pane handoff
 *     wins, then the captured origin if it is still focusable, then the focused pane.
 *   - **Host-guaranteed keys** (§2.5): Escape cancels the active request, capture phase, with the
 *     `isComposing` guard that stops an IME commit from answering a prompt. The rebindable
 *     `close_pane` chord is the dispatcher's, and reaches `surface.dismissTopmost()`.
 *
 * `InteractionPaletteSlot` is the palette's mount, separate because the palette is NOT in the body
 * portal: UI-FIDELITY M53 hangs it off the content row so the title bar and the status footer stay
 * live behind it.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import type { FormFactorWindow } from '../chrome/form-factor';
import { modalPresenceCount, useModalPresence, useModalPresenceCount } from '../chrome/modal-presence';
import type { ChromeBucket } from '../chrome/theme';
import { ModalRequest, Notifications } from './BundledPrompts';
import { PaletteHost } from './PaletteHost';
import type { InteractionSurface } from './surface';

/**
 * Can this element actually hold a caret?
 *
 * `document.activeElement` is `document.body` whenever nothing in the page is focused, so a capture
 * taken at that moment records the body. Focusing the body back is a no-op that LOOKS like a
 * successful restore, and that is exactly how a window ends up with no caret at all: precedence (b)
 * reports it handled the release and precedence (c) never runs. So the body and the root element
 * are rejected outright, and anything else has to be a real focus target.
 */
function canTakeCaret(target: HTMLElement): boolean {
    if (target === document.body || target === document.documentElement) return false;
    if (target.tabIndex >= 0 || target.isContentEditable) return true;
    return (
        target instanceof HTMLIFrameElement ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement ||
        (target instanceof HTMLAnchorElement && target.hasAttribute('href'))
    );
}

/**
 * Whether the captured origin may still be given the caret back.
 *
 * A plugin's prompt is usually raised BY its own view, so the origin is that view's iframe, and by
 * the time the prompt is answered the view may have been unmounted, hidden behind a tab, or slid
 * off-screen with its pane. Focusing it then either throws or yanks the viewport.
 */
function canRestoreFocus(target: HTMLElement): boolean {
    if (!canTakeCaret(target)) return false;
    if (!target.isConnected || target.closest('[hidden], [inert], [aria-hidden="true"]') || ('disabled' in target && target.disabled)) return false;
    for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0') return false;
    }
    if (target instanceof HTMLIFrameElement) {
        const box = target.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0 || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) return false;
    }
    return true;
}

export function InteractionHost({ surface }: { readonly surface: InteractionSurface }): ReactElement | null {
    const snapshot = useSyncExternalStore(surface.subscribe, surface.getSnapshot, surface.getSnapshot);
    // Read so a native modal peer arriving or leaving re-renders this host: `visibleSurface()`
    // subtracts our own registration from that same count.
    const count = useModalPresenceCount();
    const origin = useRef<HTMLElement | null>(null);
    const mounted = useRef(false);
    const painted = useMemo(() => surface.visibleSurface(), [surface, snapshot, count]);
    const visible = painted === 'prompt';

    // Tell the surface what we hold BEFORE the registration change notifies the shared count's
    // subscribers, so nothing reads a count that includes us as if it were somebody else's.
    useLayoutEffect(() => {
        surface.noteHostRegistration(painted !== null);
        return () => surface.noteHostRegistration(false);
    }, [surface, painted]);
    useModalPresence(painted !== null);

    const captureFocus = useCallback(() => {
        if (origin.current === null && document.activeElement instanceof HTMLElement) origin.current = document.activeElement;
    }, []);
    /** False while another modal still owns the window, so the release can be retried later. */
    const restoreFocus = useCallback((): boolean => {
        if (surface.visibleSurface() !== null || modalPresenceCount() > 0) return false;
        // (a) §10.4's pane handoff is already on its way; it decides, and the origin is dropped.
        if (surface.hasPendingPaneHandoff()) {
            origin.current = null;
            return true;
        }
        const target = origin.current;
        origin.current = null;
        // (b) back where the caret came from, when that is still a real place.
        if (target && canRestoreFocus(target)) {
            target.focus({ preventScroll: true });
            return true;
        }
        // (c) otherwise the window must not be left without a caret at all.
        surface.handBackFallbackCaret();
        return true;
    }, [surface]);

    /**
     * Release only what this host actually took. Without the latch, precedence (c) would fire on
     * the very first commit - a window that has never shown a prompt would have its caret moved to
     * the focused pane for no reason. It is cleared only when the release COMPLETED, so a prompt
     * that was hidden by a native modal peer is still released when that peer goes away.
     */
    const tookTheWindow = useRef(false);
    useLayoutEffect(() => {
        if (painted !== null) {
            tookTheWindow.current = true;
            return;
        }
        if (!tookTheWindow.current) return;
        if (restoreFocus()) tookTheWindow.current = false;
    }, [painted, count, restoreFocus]);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            queueMicrotask(() => {
                if (!mounted.current && tookTheWindow.current) restoreFocus();
            });
        };
    }, [restoreFocus]);

    // §2.5: Escape belongs to the host, so it cancels the active request even for a presenter that
    // never bound a key. Capture phase, and `isComposing` respected - an Enter or an Escape that
    // commits an IME composition is the composition's, not the prompt's.
    useLayoutEffect(() => {
        if (!visible) return;
        const onKey = (event: KeyboardEvent): void => {
            if (event.isComposing || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const active = surface.getSnapshot().activeModal;
            if (active !== null) surface.answer(active.id, null);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [visible, surface]);

    if (typeof document === 'undefined') return null;
    return createPortal(<>
        {snapshot.activeModal && <ModalRequest key={snapshot.activeModal.id} request={snapshot.activeModal} visible={visible} answer={surface.answer} captureFocus={captureFocus} />}
        <Notifications requests={snapshot.notifications} answer={surface.answer} />
    </>, document.body);
}

/**
 * The palette's mount. Always rendered: `CommandPalette` stays on screen for H19's 150 ms exit
 * animation after the session closes, so unmounting it on dismissal would pop it off instead.
 */
export function InteractionPaletteSlot({ surface, bucket, formFactorWindow }: {
    readonly surface: InteractionSurface;
    readonly bucket?: ChromeBucket | undefined;
    readonly formFactorWindow?: FormFactorWindow | undefined;
}): ReactElement {
    return <PaletteHost surface={surface} bucket={bucket} formFactorWindow={formFactorWindow} />;
}
