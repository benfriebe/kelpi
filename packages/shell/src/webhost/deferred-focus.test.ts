/**
 * Issue #351 (`./deferred-focus.ts`): a page that asked for the keyboard while parked gets it when
 * it is placed again, and nothing else ever gets it from a stale claim.
 */

import { describe, expect, it } from 'vitest';

import { createDeferredFocus } from './deferred-focus.js';

const FOCUSED = { windowMayBeKey: true, windowIsFocused: true };
const INACTIVE = { windowMayBeKey: true, windowIsFocused: false };
const LANE = { windowMayBeKey: false, windowIsFocused: false };

describe('a focus-view that reached a parked view', () => {
    it('is honoured when that tab is placed again', () => {
        // The modal-close case: the hand-back arrives before the modal has unmounted, and the
        // next geometry report re-attaches the view.
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('focus');
        expect(slot.pending).toBeNull();
    });

    it('is consumed exactly once', () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('focus');
        // A later move or re-attach of the same view is not a second hand-back.
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
    });

    it('leaves a placement with no claim alone', () => {
        expect(createDeferredFocus().placed('P', 'T1', FOCUSED)).toBe('none');
    });

    it('waits through the placement of a different pane', () => {
        // Two web panes under one modal come back one at a time, in either order.
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('Q', 'T9', FOCUSED)).toBe('none');
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('focus');
    });

    it('is dropped when the pane comes back showing another tab', () => {
        // A tab switch while parked: the old tab must not take the keyboard whenever it is
        // shown again later.
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T2', FOCUSED)).toBe('dropped-other-tab');
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
    });

    it('never takes the keyboard for an inactive window', () => {
        // `contents.focus()` activates the app; a placement long after the request (a window
        // shown again) must not pull Kelpi in front of the app the user is in.
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T1', INACTIVE)).toBe('dropped-window-inactive');
        expect(slot.pending).toBeNull();
    });

    it("is refused for a background tab, which its pane is never placed showing", () => {
        const slot = createDeferredFocus({ isActiveTab: (_paneID, tabID) => tabID !== 'T1' });
        slot.defer({ paneID: 'Q', tabID: 'T9' });
        expect(slot.defer({ paneID: 'P', tabID: 'T1' })).toBe(false);
        // The refusal leaves the earlier claim where it was.
        expect(slot.pending).toEqual({ kind: 'view', paneID: 'Q', tabID: 'T9' });
        expect(slot.defer({ paneID: 'P', tabID: 'T2' })).toBe(true);
    });

    it('is honoured in a window that can never be key (the lane focuses over CDP)', () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T1', LANE)).toBe('focus');
    });
});

describe('everything else that speaks for the keyboard clears the claim', () => {
    it('a later request wins', () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        slot.defer({ paneID: 'Q', tabID: 'T9' });
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
        expect(slot.placed('Q', 'T9', FOCUSED)).toBe('focus');
    });

    it('cancel drops it and says what it dropped (blur-view, a page press, a focus that ran)', () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.cancel()).toEqual({ kind: 'view', paneID: 'P', tabID: 'T1' });
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
        expect(slot.cancel()).toBeNull();
    });

    it("a destroyed tab drops its own claim and nobody else's", () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        expect(slot.forgetTab('P', 'T2')).toBeNull();
        expect(slot.forgetTab('Q', 'T1')).toBeNull();
        expect(slot.pending).toEqual({ kind: 'view', paneID: 'P', tabID: 'T1' });
        expect(slot.forgetTab('P', 'T1')).toEqual({ paneID: 'P', tabID: 'T1' });
        expect(slot.pending).toBeNull();
    });
});

describe('#264: the client asked for the keyboard while the window was not focused', () => {
    it('gets it when the window is focused again, once', () => {
        const slot = createDeferredFocus();
        slot.deferClient();
        expect(slot.windowFocused()).toBe(true);
        expect(slot.windowFocused()).toBe(false);
    });

    it('is not a page claim: placing a view leaves it waiting', () => {
        const slot = createDeferredFocus();
        slot.deferClient();
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
        expect(slot.windowFocused()).toBe(true);
    });

    it('is cancelled by a press into a page after the refusal', () => {
        // The person clicked into a page (§N29's report runs `cancel`): replaying the client's
        // old request on the next activation would take the keyboard off the page they chose.
        const slot = createDeferredFocus();
        slot.deferClient();
        expect(slot.cancel()).toEqual({ kind: 'client' });
        expect(slot.windowFocused()).toBe(false);
    });

    it('is cancelled by a focus-view after the refusal, whether it ran or was deferred', () => {
        // A focus that ran ends it through `cancel` (`Tab.focusView`)...
        const ran = createDeferredFocus();
        ran.deferClient();
        ran.cancel();
        expect(ran.windowFocused()).toBe(false);
        // ...and one that reached a parked view replaces it: last request wins.
        const parked = createDeferredFocus();
        parked.deferClient();
        expect(parked.defer({ paneID: 'P', tabID: 'T1' })).toBe(true);
        expect(parked.windowFocused()).toBe(false);
        expect(parked.placed('P', 'T1', FOCUSED)).toBe('focus');
    });

    it('replaces a page claim that was still waiting', () => {
        const slot = createDeferredFocus();
        slot.defer({ paneID: 'P', tabID: 'T1' });
        slot.deferClient();
        expect(slot.placed('P', 'T1', FOCUSED)).toBe('none');
        expect(slot.windowFocused()).toBe(true);
    });

    it("is untouched by a tab's disposal", () => {
        const slot = createDeferredFocus();
        slot.deferClient();
        expect(slot.forgetTab('P', 'T1')).toBeNull();
        expect(slot.windowFocused()).toBe(true);
    });
});
