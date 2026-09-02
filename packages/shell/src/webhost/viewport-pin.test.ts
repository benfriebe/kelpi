/**
 * The lazy automation-viewport rule (`./viewport-pin.ts`): a park must not reflow the page.
 *
 * Every row here is a behaviour a person can see. The one that motivated the module - a park
 * keeps the page as it is - is the difference between a header menu that closes over a sideways-
 * scrolled page and leaves it where it was, and one that hands the page back 300 px to the right.
 */

import { describe, expect, it } from 'vitest';

import { viewportPinAction } from './viewport-pin.js';

describe('viewportPinAction', () => {
    it('a park keeps the page exactly as it was on screen, pinned or not', () => {
        expect(viewportPinAction({ embedded: false, pinned: false }, 'parked')).toBe('keep');
        // A view that was pinned in the holder and never placed stays pinned: nothing to do.
        expect(viewportPinAction({ embedded: false, pinned: true }, 'parked')).toBe('keep');
    });

    it('a placement clears a pin an automation read left, and touches nothing otherwise', () => {
        expect(viewportPinAction({ embedded: true, pinned: true }, 'placed')).toBe('unpin');
        expect(viewportPinAction({ embedded: true, pinned: false }, 'placed')).toBe('keep');
    });

    it('an automation read on a parked, unpinned view pins first', () => {
        expect(viewportPinAction({ embedded: false, pinned: false }, 'automation-read')).toBe('pin');
    });

    it('an automation read on a view that is already pinned pins nothing again', () => {
        expect(viewportPinAction({ embedded: false, pinned: true }, 'automation-read')).toBe('keep');
    });

    it('an automation read on a view that is ON screen leaves the pane as its viewport', () => {
        // Pinning an embedded view would show the person the clipped corner of a 1280 px page.
        expect(viewportPinAction({ embedded: true, pinned: false }, 'automation-read')).toBe('keep');
        // …and even a stale pin on an embedded view is the placement's to clear, not the read's.
        expect(viewportPinAction({ embedded: true, pinned: true }, 'automation-read')).toBe('keep');
    });

    it('a placement that overtook a park still clears the pin (the state is read when the transition runs)', () => {
        // Placed, then parked before the queued transition ran: the view is off screen again, but
        // an unpin is harmless there and the next read simply pins afresh.
        expect(viewportPinAction({ embedded: false, pinned: true }, 'placed')).toBe('unpin');
    });
});
