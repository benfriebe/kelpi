/**
 * Who owns the caret, and when a pane surface may take it.
 *
 * The Swift app answers this with AppKit's responder chain, and the answer is spread across
 * three files that agree with each other:
 *
 *   - `SurfaceContainerView.swift:146-156` — a terminal surface claims first responder unless
 *     `window.firstResponder is NSText`, i.e. unless a TEXT EDITOR holds it. A sibling
 *     terminal surface is not `NSText`, so terminal → terminal never blocks.
 *   - `ScratchpadEditorView.swift:86-89,108-116` / `MarkdownEditorView.swift:78-80,102-116` —
 *     an editor claims first responder **on creation** (`makeNSView`) and on a real
 *     `false → true` transition, blocked only by `sidebarTextEditingActive` (a sidebar rename
 *     in flight). It does NOT consult the terminal.
 *   - the same two files, `releaseFirstResponderIfHeld` — an editor RESIGNS first responder on
 *     `true → false`, with the comment "so the next pane's focus claim isn't blocked by
 *     `SurfaceContainerView`'s `firstResponder is NSText` guard".
 *
 * The port had the first rule and neither of the other two, and the gap is N19: the ghostty-web
 * engine drives keyboard input through a hidden `<textarea>` inside the terminal host
 * (`vendor/ghostty-web-patched/source/lib/terminal.ts:391`), so to a DOM-level "is a text field
 * focused?" test a plain terminal looks exactly like a sidebar rename. Every editor surface
 * therefore refused to claim the caret whenever the pane it was created from was a terminal —
 * ⇧⌘N drew the focus ring on a scratchpad whose `<textarea>` had no focus, and the first
 * keystrokes went to the terminal's PTY. Worse, `Terminal.blur()` blurs the CONTAINER, not the
 * textarea, so the terminal never released the caret on its own either.
 *
 * The fix is to port the distinction AppKit makes for free: a pane SURFACE holding the caret is
 * not a text field worth protecting (its pane has already lost focus, or is about to), while a
 * chrome text field — the sidebar rename, the command palette, an inline pane rename, the
 * search bar — is. Surfaces mark themselves with {@link PANE_SURFACE_ATTR}; everything else
 * editable is chrome.
 */

/**
 * Marks an element whose caret belongs to a PANE (the terminal host, an editor's textarea).
 *
 * Put it on the container, not the focusable leaf: the ghostty-web textarea is created by the
 * engine and is a descendant of the host, so the lookup walks up with `closest`.
 */
export const PANE_SURFACE_ATTR = 'data-pane-surface';

const PANE_SURFACE_SELECTOR = `[${PANE_SURFACE_ATTR}]`;

/** A DOM element that would swallow a keystroke: AppKit's `is NSText`, in the browser. */
function isEditable(element: Element): boolean {
    const tag = element.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return element instanceof HTMLElement && element.isContentEditable;
}

/** True when `element` is (or sits inside) a marked pane surface. */
export function isPaneSurfaceCaret(element: Element | null): boolean {
    if (element === null) return false;
    if (element.matches(PANE_SURFACE_SELECTOR)) return true;
    return element.closest(PANE_SURFACE_SELECTOR) !== null;
}

/**
 * Polite focus (terminal-surface.md §6): a (re)mounting surface grabs the caret unless a text
 * field OUTSIDE any pane currently holds it — a sidebar rename or the command palette must
 * survive a grid re-render.
 *
 * `host` is the surface asking: its own subtree always passes, so an engine that has already
 * focused its textarea is not talked out of it.
 */
export function shouldGrabFocus(host: HTMLElement | null): boolean {
    if (typeof document === 'undefined') return true;
    const active = document.activeElement;
    if (active === null || active === document.body) return true;
    if (host !== null && host.contains(active)) return true;
    if (!isEditable(active)) return true;
    // The Swift's `firstResponder is NSText` guard, minus the terminal's hidden textarea: a
    // caret held by ANOTHER PANE's surface is not chrome, and the pane holding it has already
    // lost focus (or is losing it in this same commit).
    return isPaneSurfaceCaret(active);
}

/**
 * The port of `releaseFirstResponderIfHeld` — a surface that has lost pane focus lets go.
 *
 * Only ever blurs a node INSIDE `host`, so a claim that already landed somewhere else (the
 * effects of two panes running in one commit, in either order) is never undone.
 */
export function releasePaneCaret(host: HTMLElement | null): void {
    if (typeof document === 'undefined' || host === null) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!host.contains(active)) return;
    active.blur();
}

/**
 * §N35 — undo a surface that focused ITSELF, and give the caret back to whoever had it.
 *
 * `releasePaneCaret` above is for a surface that has LOST pane focus; this is for one that
 * never had it. ghostty-web's `Terminal.open()` ends with `this.focus()` — "auto-focus so user
 * can start typing immediately", `vendor/ghostty-web-patched/source/lib/terminal.ts:636` — so
 * every terminal that mounts takes the caret whichever pane wears the ring. The politeness rule
 * ({@link shouldGrabFocus}) is applied to the port's own `renderer.focus()`, and the engine goes
 * straight around it. The Swift has no equivalent at all: creating a `ghostty_surface_t` claims
 * nothing, and `SurfaceContainerView` (`:146-156`) is what decides.
 *
 * `previous` is the element the grab took the caret FROM, and putting it back is the half that
 * matters: what an opening engine interrupts is a sidebar rename, the command palette, or the
 * pane the user is actually typing in. It takes precedence over the ring, because a chrome text
 * field mid-edit is the one caret nothing may move (`shouldGrabFocus`, WEB-043's `NSText`).
 *
 * When `previous` is gone — unmounted, or `<body>` because nothing held it — the caret goes to
 * whichever pane WEARS THE RING, which is where a reload has to leave it. Measured on the
 * packaged stack, where the engines come up in a different order than on the dev one: without
 * this the grab was undone to `<body>` and the window came back taking no keystrokes at all,
 * ring drawn and caret nowhere — §N19's original symptom, one cause further on. The blur is the
 * last resort, for a window with no focused pane to give it to.
 */
export function undoSurfaceAutoFocus(host: HTMLElement | null, previous: Element | null): void {
    if (typeof document === 'undefined' || host === null) return;
    const active = document.activeElement;
    // The engine did not take it, or something else has taken it since: leave it alone.
    if (!(active instanceof HTMLElement) || !host.contains(active)) return;
    if (previous instanceof HTMLElement && previous.isConnected && !host.contains(previous)) {
        previous.focus?.();
        if (document.activeElement !== active) return;
    }
    const ringed = document.querySelector<HTMLElement>('[data-pane-id][data-focused="true"]');
    const ringedID = ringed === null || ringed.contains(host) ? null : (ringed.getAttribute('data-pane-id') ?? '');
    if (ringedID !== null && ringedID !== '' && ringed !== null && ringed.querySelector(PANE_SURFACE_SELECTOR) !== null) {
        /*
         * The focused pane HAS a surface, so the caret is its business and not `<body>`'s. It
         * may not be focusable yet — an engine that has not finished loading has built no
         * textarea — and that is exactly why this returns either way: its own `open()` claims
         * the caret a moment later, and `shouldGrabFocus` lets it take one held by another
         * pane's surface. Blurring into the void here is what made the outcome depend on which
         * engine came up first: the window drew a ring and took no keystrokes.
         */
        focusPaneSurface(ringedID);
        return;
    }
    // Nothing in this document can hold it — a web pane wears the ring, and its surface is a
    // native view in another process — so the caret is dropped rather than left in the wrong
    // pane's PTY.
    active.blur();
}

/**
 * §N29's caret half: let go of whichever PANE SURFACE holds the caret, wherever it is.
 *
 * `releasePaneCaret` above is the ordinary case — a surface that can see it lost pane focus lets
 * go itself. A web pane's page cannot: it is a native view over this document, so when the user
 * clicks into it nothing in the DOM changes at all. The outgoing pane's surface keeps
 * `document.activeElement` — a terminal's hidden `<textarea>`, an editor's field — and the moment
 * the renderer gets keyboard focus back (clicking the window chrome, ⌘-tabbing home) the next
 * keystroke goes to a pane that no longer wears the ring. N19's caret handoff and N20's cursor
 * rendering read the same state, so the release is what keeps all three telling one story.
 *
 * Only a *pane surface* is released, never chrome: a sidebar rename, the palette or the URL bar
 * holding the caret is the same "is NSText" case the Swift guard protected, and blurring it here
 * would cancel an edit the user is in the middle of.
 */
export function releaseFocusedPaneCaret(): void {
    if (typeof document === 'undefined') return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (!isPaneSurfaceCaret(active)) return;
    active.blur();
}

/**
 * Hand the caret to a pane's surface after an overlay closes (the palette's §10.4 handoff, the
 * Settings/Help close paths, a status-popover jump, a socket-driven focus).
 *
 * The renderer owns whatever is actually focusable inside a terminal host (a textarea for both
 * engines today), so this asks the DOM rather than the engine — the engine seam deliberately
 * exposes no such handle. An editor pane has no terminal host at all; its marked surface IS the
 * focusable, which is why the lookup is over `PANE_SURFACE_ATTR` and not over
 * `[data-terminal-host]` as it was when only terminals could be handed the caret.
 */
export function focusPaneSurface(paneID: string): void {
    if (typeof document === 'undefined') return;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${paneID}"]`);
    if (pane === null) return;
    const surface = pane.querySelector<HTMLElement>(PANE_SURFACE_SELECTOR);
    if (surface === null) return;
    if (isEditable(surface)) {
        surface.focus?.();
        return;
    }
    const focusable = surface.querySelector<HTMLElement>('textarea, canvas[tabindex], [tabindex]') ?? surface;
    focusable.focus?.();
}
