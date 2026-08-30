/**
 * §N30's decision seam: does a committing navigation give the keyboard back, and to whom?
 *
 * The rule under test is **preserve** — a commit restores whoever held the keyboard when the
 * navigation started, and does nothing at all otherwise. Everything here is pure: the guard
 * takes facts (who had it, did the view end up with it, is the view on screen) and answers with
 * an owner or null, so the whole rule is assertable without Electron, a window, or a page.
 *
 * The live half — that Chromium really does move focus into a committing embedded view, and
 * that handing it back lands in the client's renderer — is `docs/audit/n29-verify/`'s probe,
 * because no unit test can observe a native first responder.
 */

import { describe, expect, it } from 'vitest';

import { createNavFocusGuard, describeKeyboardOwner, type KeyboardOwner } from './nav-focus.js';

const TAB = 'TAB-1';
const OTHER_TAB = 'TAB-2';
const CLIENT: KeyboardOwner = { kind: 'client' };
const THIS_VIEW: KeyboardOwner = { kind: 'view', tabID: TAB };
const OTHER_VIEW: KeyboardOwner = { kind: 'view', tabID: OTHER_TAB };
const NOBODY: KeyboardOwner = { kind: 'none' };

/** The state a real steal arrives in: the view is on screen and now holds the keyboard. */
const STOLEN = { viewHasKeyboard: true, embedded: true };

const guard = (): ReturnType<typeof createNavFocusGuard> => createNavFocusGuard({ tabID: TAB });

describe('§N30 — a navigation must not move the keyboard', () => {
    it('hands the keyboard back to the client when a background pane commits', () => {
        const gate = guard();
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted(STOLEN)).toEqual(CLIENT);
    });

    it('hands it back to ANOTHER pane’s page, not merely to the client', () => {
        // Two web panes side by side: the user is typing in one page, an agent navigates the
        // other. Restoring "the client" would leave the ring on a pane whose page cannot type —
        // the same §N19/§N20 divergence one step sideways.
        const gate = guard();
        gate.navigationStarted(OTHER_VIEW);
        expect(gate.navigationCommitted(STOLEN)).toEqual(OTHER_VIEW);
    });

    it('leaves the keyboard in the page when the page already had it', () => {
        // The focused pane's own case: a wire `navigate` against the pane the user is typing
        // into keeps the caret in the page, which is what a `WKWebView` does in the Swift app —
        // a load there changes first responder not at all.
        const gate = guard();
        gate.navigationStarted(THIS_VIEW);
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
    });

    it('does nothing when the commit took no keyboard', () => {
        // The common case by a wide margin: same-process loads, and every load while the window
        // is not the one being typed into, move no focus at all.
        const gate = guard();
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted({ viewHasKeyboard: false, embedded: true })).toBeNull();
    });

    it('does nothing for a PARKED view — nobody can be looking at it', () => {
        const gate = guard();
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted({ viewHasKeyboard: true, embedded: false })).toBeNull();
    });

    it('does nothing when nobody in the window held the keyboard', () => {
        // Taking focus off the page would mean CHOOSING a new owner, which is a decision this
        // module refuses to make.
        const gate = guard();
        gate.navigationStarted(NOBODY);
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
    });

    it('does nothing for a commit no navigation start was seen for', () => {
        const gate = guard();
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
    });

    it('consumes the snapshot: a second commit decides nothing on its own', () => {
        const gate = guard();
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted(STOLEN)).toEqual(CLIENT);
        // A redirect chain re-arms it from its own `did-start-navigation`; a stray second commit
        // must not fire a handoff the user never had coming.
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
    });

    it('re-arms from the next navigation start', () => {
        const gate = guard();
        gate.navigationStarted(CLIENT);
        gate.navigationCommitted(STOLEN);
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted(STOLEN)).toEqual(CLIENT);
    });

    describe('a deliberate claim cancels the pending handoff', () => {
        it('when the client hands the page the keyboard mid-load (WEB-043)', () => {
            // `kelpi web open` is exactly this race: the pane is created, the client focuses it
            // (`focus-view`), and the page loads — all at once. Undoing the client's own handoff
            // would leave the ring on the new pane and the keyboard in the renderer.
            const gate = guard();
            gate.navigationStarted(CLIENT);
            gate.pageClaimedKeyboard();
            expect(gate.navigationCommitted(STOLEN)).toBeNull();
        });

        it('when the USER presses into the page mid-load (§N29’s gesture)', () => {
            const gate = guard();
            gate.navigationStarted(CLIENT);
            gate.pageClaimedKeyboard();
            expect(gate.navigationCommitted(STOLEN)).toBeNull();
        });

        it('but only for the navigation it was in flight for', () => {
            const gate = guard();
            gate.navigationStarted(CLIENT);
            gate.pageClaimedKeyboard();
            gate.navigationCommitted(STOLEN);
            // The user clicks away to a terminal, then an agent navigates this pane again.
            gate.navigationStarted(CLIENT);
            expect(gate.navigationCommitted(STOLEN)).toEqual(CLIENT);
        });

        it('and a claim with nothing pending is harmless', () => {
            const gate = guard();
            gate.pageClaimedKeyboard();
            gate.navigationStarted(CLIENT);
            expect(gate.navigationCommitted(STOLEN)).toEqual(CLIENT);
        });
    });

    it('decides nothing at all once disposed', () => {
        const gate = guard();
        gate.navigationStarted(CLIENT);
        gate.dispose();
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
        gate.navigationStarted(CLIENT);
        expect(gate.navigationCommitted(STOLEN)).toBeNull();
    });

    it('names an owner readably for the log line the probe asserts on', () => {
        expect(describeKeyboardOwner(CLIENT)).toBe('client');
        expect(describeKeyboardOwner(NOBODY)).toBe('none');
        expect(describeKeyboardOwner(OTHER_VIEW)).toBe(`view:${OTHER_TAB}`);
    });
});
