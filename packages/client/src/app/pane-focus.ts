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

import { currentFormFactor, defaultFormFactorWindow, type FormFactorWindow } from '../chrome/form-factor';

/**
 * Marks an element whose caret belongs to a PANE (the terminal host, an editor's textarea).
 *
 * Put it on the container, not the focusable leaf: the ghostty-web textarea is created by the
 * engine and is a descendant of the host, so the lookup walks up with `closest`.
 */
export const PANE_SURFACE_ATTR = 'data-pane-surface';

/**
 * C5 - may the client move the caret onto a pane surface WITHOUT being asked to?
 *
 * **Owner-directed divergence from the shipped Swift app**, like every phone rule: the shipped
 * app is a Mac app, so there is no parity reference for any of this and there cannot be one
 * (`chrome/form-factor.ts` says that once for the whole program). This is the caret layer's
 * instance of it, and it is the ONE seam the phone rule is written at - everything below and in
 * `terminal/TerminalPane.tsx` and `App.tsx` asks this rather than testing the form factor itself.
 *
 * On a desktop the answer is always yes and every path is byte for byte what it was: a window
 * left with the caret on a button that no longer exists types nowhere, which is why the
 * overlay-close handoff ({@link focusPaneSurface}) and the pane's own claim exist at all.
 *
 * On a PHONE the answer is no, because moving the caret onto a pane surface is not a focus
 * change there - it is summoning a software keyboard over half the screen. Measured on the
 * owner's phone (device round 4, 2026-09-07, Android Chrome): closing the Settings sheet raised
 * the keyboard, because `closeSettings` hands the caret back to the focused pane and
 * `focus()` on an editable IS how Android puts the keyboard up. So on a phone the keyboard is
 * the person's EXPLICIT choice and it has exactly two ways up, neither of which comes through
 * here: a direct tap on the terminal surface, which the engine's own `touchend` answers
 * (`vendor/ghostty-web-patched/source/lib/terminal.ts:490-493`), and the key bar's key when it
 * reads Show (`terminal/TerminalPane.tsx` ▸ `showKeyboard`).
 *
 * C9's round 9 added a third site and NOT a third way up: with a keyboard already on screen and
 * the caret on another pane's surface, a tap on a terminal hands the caret straight across inside
 * the gesture's first event (`TerminalPane.tsx`, "the caret is handed OVER"), because the browser's
 * own focus move for that tap parks the caret on nothing for the length of the gesture and Android
 * answers by animating the keyboard down and back up. It is the SAME gesture this comment already
 * names, made synchronous, and it is gated on a keyboard being measurably up - so a tap can still
 * never summon a keyboard the person has put away.
 *
 * Deliberately about EVERY pane surface and not only a terminal's: an editor pane's textarea
 * raises the same keyboard, and a person who has put it away has not asked for it back there
 * either. The caret is not moved AWAY from anything by this rule - `releasePaneCaret`,
 * `releaseFocusedPaneCaret` and {@link undoSurfaceAutoFocus} are unchanged, and so is the
 * engine's own grab when it opens: this governs claims, not releases.
 */
export function mayClaimPaneCaret(win: FormFactorWindow = defaultFormFactorWindow()): boolean {
    return currentFormFactor(win) !== 'phone';
}

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
 * Issue #35 - the same question a moment later: has the caret that said no been let go?
 *
 * {@link shouldGrabFocus} answers "may I take it NOW", and its `host.contains(active)` shortcut
 * is there so an engine that has already focused its own textarea is not talked out of it. That
 * shortcut is wrong as an answer to "has the blocker gone": a caret that has just landed inside
 * the asking host is the ENGINE's own grab (`terminal.ts:636` and its `setTimeout(0)` backup),
 * not the sidebar filter letting go, and treating it as an answer would spend the deferred claim
 * on the transient the arbiter is about to undo. So this is the same rule with that one clause
 * removed, and it is deliberately not exported: the only question anyone else asks is the first
 * one.
 */
function caretBlockerGone(host: HTMLElement | null): boolean {
    if (typeof document === 'undefined') return true;
    const active = document.activeElement;
    if (active === null || active === document.body) return true;
    if (host !== null && host.contains(active)) return false;
    if (!isEditable(active)) return true;
    return isPaneSurfaceCaret(active);
}

/**
 * Issue #35 - a claim that was DECLINED stays armed, and is answered when the caret it deferred
 * to is let go.
 *
 * Declining is correct: a rename, the sidebar filter or the palette mid-edit must survive a pane
 * taking the ring. What was missing is the SECOND attempt. A terminal's claim lived in an effect
 * with deps `[focused, visible, status]` (`terminal/TerminalPane.tsx`) and an editor's spent its
 * focus gain unconditionally (`content/PlainTextEditor.tsx`), so a declined claim was simply
 * dropped: the pane wore the ring, drew a blinking cursor, and the keystrokes went to the field
 * until the user clicked the pane a second time, the click blurring the field before the pane's
 * own handler ran and so making the claim succeed.
 *
 * The web pane has had this rule since §N30's residual (`webpane/WebPane.tsx`): "Stay armed and
 * re-decide when that changes. The gain is spent only when the claim is actually MADE, or on a
 * guard that stands." There it re-decides on the props that block it; a chrome field is not a
 * prop, so here the re-decision is driven by the document's own focus traffic. One listener,
 * removed the moment the claim lands, and removed by the caller's cleanup if the pane loses
 * focus first - so an armed claim can never outlive the ring that justified it.
 *
 * `claim` is the caller's own focus call (`renderer.focus()`, `area.focus()`), not a DOM call
 * made from here: what is focusable inside a terminal host belongs to the engine.
 *
 * Returns the disarm function, so the caller's effect cleanup is the whole lifetime.
 */
export function armCaretClaim(host: HTMLElement | null, claim: () => void): () => void {
    if (typeof document === 'undefined') return () => undefined;
    if (shouldGrabFocus(host)) {
        claim();
        return () => undefined;
    }
    const owningDocument = host?.ownerDocument ?? document;
    let armed = true;
    let deferred: ReturnType<typeof setTimeout> | null = null;

    function stop(): void {
        armed = false;
        if (deferred !== null) {
            clearTimeout(deferred);
            deferred = null;
        }
        owningDocument.removeEventListener('focusin', onFocusIn, true);
        owningDocument.removeEventListener('focusout', onFocusOut, true);
    }

    /** The listeners come off BEFORE the claim, so the claim's own focus event cannot re-enter. */
    function decide(): void {
        if (!armed || !caretBlockerGone(host)) return;
        stop();
        claim();
    }

    /** The caret moved somewhere else outright: the answer is readable now. */
    function onFocusIn(): void {
        decide();
    }

    /**
     * The field let go, and WHO has it is not known yet.
     *
     * `focusout` is dispatched with the document's `activeElement` already dropped to `<body>`,
     * before the element gaining focus is dispatched its `focusin` - so deciding here would read
     * "nobody has the caret" during every ordinary move between two chrome fields, and the pane
     * would take a caret that was on its way to a rename. One task later the move has finished,
     * and Escape in the sidebar filter (a blur with nothing taking it) is answered by the same
     * line. `focusin` above still answers the common case synchronously; this is the tail.
     */
    function onFocusOut(): void {
        if (!armed || deferred !== null) return;
        deferred = setTimeout(() => {
            deferred = null;
            decide();
        }, 0);
    }

    // Capture phase: a chrome field that stops propagation of its own focus events must not be
    // able to strand an armed claim.
    owningDocument.addEventListener('focusin', onFocusIn, true);
    owningDocument.addEventListener('focusout', onFocusOut, true);
    return (): void => {
        if (!armed) return;
        stop();
    };
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
 * §N35 residual (a) — ONE owner for the caret while engines are coming up.
 *
 * The first cut of §N35 gave every pane its own answer to "who should hold the caret": each
 * `TerminalPane` tracked an `engineTookFrom` of its own, seeded from `document.activeElement`
 * and updated by a capture-phase `focusin` listener of its own — "the last element to take the
 * caret from outside THIS host". With one pane opening beside a settled window that is right.
 * With several opening at once it is a rule that disagrees with itself: pane A's engine grabs,
 * so B records A's textarea; B's engine grabs, so A records B's textarea; and then A's undo
 * hands the caret to B, whose undo hands it back to A, each hand-off raising a synchronous
 * `focusin` that runs the other pane's undo again. The run-AK verifier measured the shape of
 * that on a three-pane reload: **~50 synchronous `focusin` events inside one millisecond** where
 * the pre-§N35 tree raised 3. It settled on the right pane every time — the recursion is
 * mutual, not divergent — but its depth follows the pane count, which is not a property a
 * reattach with eight panes should have.
 *
 * The mechanism, not the symptom: there is one caret, so there is one owner of it. This module
 * holds it. While any engine is inside its autofocus window the arbiter answers three questions
 * for every pane at once:
 *
 *   1. **who owns the caret** — the element that held it when the first engine armed, plus any
 *      later claim from OUTSIDE every arming host (a person can start a sidebar rename while a
 *      wasm load is in flight, and that caret is the one nothing may move);
 *   2. **what is not an owner** — a caret inside a host whose engine is still grabbing. That is
 *      the grab itself. Refusing to record it is what makes the mutual recursion unconstructible
 *      rather than merely rare: no arming pane can ever be another arming pane's restore target;
 *   3. **whether a hand-off is already in flight** — the arbiter's own `focus()` call raises a
 *      `focusin` that looks exactly like an engine grab to the pane that receives it. One
 *      hand-off per grab, and a nested answer is a no-op.
 *
 * One listener for the whole window, too, instead of one per pane.
 */
interface EngineFocusWindow {
    /** Hosts whose engines are inside their autofocus window right now. */
    readonly hosts: Set<HTMLElement>;
    /** Who should hold the caret while they are: the arbiter's single answer. */
    owner: Element | null;
    /** The document the one shared listener is attached to (null when no window is open). */
    listeningOn: Document | null;
    /** True while the arbiter is moving the caret itself — see (3) above. */
    handingOff: boolean;
}

const engineFocusWindow: EngineFocusWindow = { hosts: new Set(), owner: null, listeningOn: null, handingOff: false };

/** A caret inside a host whose engine is still grabbing is the grab, not an owner. */
function isInsideArmingHost(node: Element): boolean {
    for (const host of engineFocusWindow.hosts) {
        if (host.contains(node)) return true;
    }
    return false;
}

/**
 * The arbiter's ownership rule, in one place.
 *
 * `<body>` is nobody: a caret that has been dropped is not an owner to give anything back to,
 * and saying so here is what sends a reload down the ring branch (where it belongs) instead of
 * through a `body.focus()` that lands the window on no pane at all.
 *
 * Issue #74 - and neither is a BUTTON, a sidebar row or the workspace switcher, which is the
 * same rule {@link shouldGrabFocus} already states one line up: what may not be moved is a caret
 * that is IN USE, and only an editable element can be in use. Without this the arbiter and the
 * politeness rule disagreed about what is worth protecting, and the disagreement was reachable
 * with one click: a sidebar row is `<div role="option" tabIndex={-1}>` whose mousedown does not
 * `preventDefault` (`chrome/Sidebar.tsx:1111-1152,2411-2446`), so after a workspace switch made
 * by CLICKING a row, the row itself holds the caret. Every incoming pane then armed with the row
 * as owner; the pane wearing the ring claimed correctly; and the LAST engine to finish its wasm
 * load handed the caret it had grabbed back to the row, taking it off the pane that had just
 * legitimately claimed it. The window drew a focus ring and a blinking cursor and took no
 * keystrokes until the user clicked another pane and clicked back.
 *
 * A caret held by another pane's SURFACE stays an owner (that is §N35's "the pane the user is
 * actually typing in", pinned below), because a surface's caret is editable by this test: the
 * engine drives input through a hidden `<textarea>`.
 */
function caretOwnerCandidate(node: Element | null): Element | null {
    if (node === null) return null;
    if (node === node.ownerDocument.body) return null;
    if (isInsideArmingHost(node)) return null;
    if (!isEditable(node)) return null;
    return node;
}

const noteCaretOwner = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const candidate = caretOwnerCandidate(target);
    if (candidate === null) return;
    engineFocusWindow.owner = candidate;
};

/**
 * Arm the shared window for one engine, and return the function that disarms it.
 *
 * Called when a pane starts its engine and closed when its undo window ends (or the pane goes
 * away). The snapshot is taken once, when the FIRST engine arms: after that the listener keeps
 * the answer current, and a pane that joins a window already open inherits the same owner rather
 * than minting a second opinion.
 */
export function openEngineFocusWindow(host: HTMLElement | null): () => void {
    if (typeof document === 'undefined' || host === null) return () => undefined;
    /*
     * A host that has left the document cannot be grabbing anything, so it is not allowed to keep
     * the shared window open. The pane's own teardown closes it in every path this component
     * takes; this is the bound on the one it cannot (an engine that throws out of `start()`
     * before the teardown is installed), and it keeps a single leak from being permanent.
     */
    for (const armed of engineFocusWindow.hosts) {
        if (!armed.isConnected) engineFocusWindow.hosts.delete(armed);
    }
    if (engineFocusWindow.hosts.size === 0) {
        const owningDocument = host.ownerDocument;
        engineFocusWindow.owner = caretOwnerCandidate(owningDocument.activeElement);
        engineFocusWindow.listeningOn = owningDocument;
        owningDocument.addEventListener('focusin', noteCaretOwner, true);
    }
    engineFocusWindow.hosts.add(host);
    let closed = false;
    return (): void => {
        if (closed) return;
        closed = true;
        engineFocusWindow.hosts.delete(host);
        if (engineFocusWindow.hosts.size > 0) return;
        engineFocusWindow.listeningOn?.removeEventListener('focusin', noteCaretOwner, true);
        engineFocusWindow.listeningOn = null;
        engineFocusWindow.owner = null;
        engineFocusWindow.handingOff = false;
    };
}

/** Who the arbiter says should hold the caret right now — `null` when that is nobody. */
export function engineFocusWindowOwner(): Element | null {
    const owner = engineFocusWindow.owner;
    if (owner === null || !owner.isConnected) return null;
    return owner;
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
 *
 * `previous` is the ARBITER's answer ({@link engineFocusWindowOwner}) unless a caller names one:
 * omitting it is what every pane does, and it is what makes the hand-off single-valued instead
 * of one opinion per pane (§N35 residual (a), above). Passing an element explicitly is the unit
 * form of the same question — "give it back to THIS" — and is what the rule's own tests use.
 */
export function undoSurfaceAutoFocus(host: HTMLElement | null, previous?: Element | null): void {
    if (typeof document === 'undefined' || host === null) return;
    const active = document.activeElement;
    // The engine did not take it, or something else has taken it since: leave it alone.
    if (!(active instanceof HTMLElement) || !host.contains(active)) return;
    /*
     * A hand-off already in flight is not a grab to answer.
     *
     * The arbiter moves the caret with `focus()`, which raises a synchronous `focusin` the
     * receiving pane cannot tell from its own engine grabbing — so an undo that runs INSIDE
     * another undo is the recursion itself, one level down. At most one hand-off per grab.
     */
    if (engineFocusWindow.handingOff) return;
    const restoreTo = previous === undefined ? engineFocusWindowOwner() : previous;
    engineFocusWindow.handingOff = true;
    try {
        if (restoreTo instanceof HTMLElement && restoreTo.isConnected && !host.contains(restoreTo)) {
            restoreTo.focus?.();
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
    } finally {
        engineFocusWindow.handingOff = false;
    }
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
 *
 * A web pane's chrome must still let go when the PANE loses focus (issue #32). Not here, because
 * this also runs on the page-click path: see `releaseWebChromeCaret` in `webpane/priority.ts`.
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
 *
 * Reports whether it found something to hand the caret TO. A pane that has not mounted yet, or
 * whose engine has not built a surface yet, is the reason issue #74's reveal handoff was a silent
 * no-op on a cross-workspace jump; {@link handCaretToPaneWhenReady} is that answer used.
 */
export function focusPaneSurface(paneID: string): boolean {
    if (typeof document === 'undefined') return false;
    const pane = document.querySelector<HTMLElement>(`[data-pane-id="${paneID}"]`);
    if (pane === null) return false;
    const surface = pane.querySelector<HTMLElement>(PANE_SURFACE_SELECTOR);
    if (surface === null) return false;
    if (isEditable(surface)) {
        surface.focus?.();
        return true;
    }
    const focusable = surface.querySelector<HTMLElement>('textarea, canvas[tabindex], [tabindex]') ?? surface;
    focusable.focus?.();
    return true;
}

/**
 * How long {@link handCaretToPaneWhenReady} keeps asking, in wall clock.
 *
 * A budget rather than a frame count because what it is waiting for is a WASM load, and because
 * a frame is not a fixed amount of time in a window the compositor is throttling. Long enough
 * for an engine to come up on a cold sandbox, short enough that it cannot still be running when
 * the user has moved on to something else.
 */
const CARET_HANDOFF_BUDGET_MS = 1_500;

/**
 * Issue #74 - the same handoff, for the paths where the destination does not exist yet.
 *
 * A jump that crosses workspaces unmounts the outgoing panes and mounts the incoming ones
 * (`terminal/mount-policy.ts`), so a handoff made in the same turn as the activation has nothing
 * to aim at: `focusPaneSurface` returns having found no pane, silently, which is what the
 * `reveal-pane` path did on a `kelpi workspace create` and what made an agent launched that way
 * come up with a ring and no keyboard. The status-popover path already knew this and fired twice
 * (§APP-076); asking until there is an answer is that idea with the arbitrary number taken out.
 *
 * POLITE, unlike {@link focusPaneSurface} on the overlay-close paths, and that difference is the
 * point: there the chrome field holding the caret IS the overlay that is closing, while here it
 * is a sidebar rename or a filter the user is still typing in, which {@link shouldGrabFocus}
 * exists to protect. Declining costs nothing now that a declined claim stays armed
 * ({@link armCaretClaim}): the pane takes the caret itself the moment the field lets go.
 *
 * Returns a cancel function; it stops on its own once the question is settled.
 *
 * C5 - and it does not run at all on a phone, where a handoff nobody asked for is a software
 * keyboard nobody asked for ({@link mayClaimPaneCaret}). The check is here rather than inside
 * `attempt` because this is a per-FRAME loop with a 1.5 s budget: asking once, at the top, is
 * both the whole answer and the cheap place to ask it.
 */
export function handCaretToPaneWhenReady(paneID: string, win?: FormFactorWindow): () => void {
    if (typeof document === 'undefined') return () => undefined;
    if (!mayClaimPaneCaret(win)) return () => undefined;
    let cancelled = false;
    const deadline = Date.now() + CARET_HANDOFF_BUDGET_MS;
    const attempt = (): void => {
        if (cancelled) return;
        const pane = document.querySelector<HTMLElement>(`[data-pane-id="${paneID}"]`);
        // A caret in use keeps its field, and the question is settled: the pane's own armed
        // claim collects it when the field lets go.
        if (pane !== null && !shouldGrabFocus(pane)) return;
        /*
         * The test is whether the caret LANDED, not whether a surface exists. A terminal host is
         * marked the moment the pane mounts, while the element that can actually hold a caret is
         * the `<textarea>` the engine builds when its wasm finishes loading, and `focus()` on the
         * host in between is a silent no-op on a div with no tabindex. Asking again until the
         * caret is inside the pane is what makes this wait for the engine rather than for React.
         */
        if (pane !== null && focusPaneSurface(paneID) && pane.contains(document.activeElement)) return;
        if (Date.now() >= deadline) return;
        const soon = globalThis.requestAnimationFrame;
        if (typeof soon === 'function') soon(attempt);
        else setTimeout(attempt, 16);
    };
    attempt();
    return (): void => {
        cancelled = true;
    };
}
