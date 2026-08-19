/**
 * Which client acts on a reveal.
 *
 * The ordering half of §8.5 lives in assembly (activate the workspace, focus the pane last);
 * what is decided here is *whether this client is the one being talked to* — with a phone and a
 * desktop attached to the same daemon, a notification clicked on the desktop must not drag the
 * phone to the same pane.
 */

import { describe, expect, it } from 'vitest';

import { parseRevealMessage, revealAppliesHere, REVEAL_PANE_MESSAGE } from './reveal';

const W = 'AAAAAAAA-0000-4000-8000-000000000001';
const P = 'DDDDDDDD-0000-4000-8000-000000000001';

describe('parseRevealMessage', () => {
    it('reads the daemon’s fan-out frame', () => {
        expect(
            parseRevealMessage({ type: REVEAL_PANE_MESSAGE, workspaceID: W, paneID: P, windowID: 'WIN' })
        ).toEqual({ workspaceID: W, paneID: P, windowID: 'WIN' });
    });

    it('is null for anything else on the socket', () => {
        expect(parseRevealMessage({ type: 'delta', seq: 1 })).toBeNull();
        expect(parseRevealMessage({ type: REVEAL_PANE_MESSAGE, workspaceID: W })).toBeNull();
        expect(parseRevealMessage({ type: REVEAL_PANE_MESSAGE, paneID: P })).toBeNull();
    });

    it('treats a missing window as untargeted rather than as a window named ""', () => {
        expect(parseRevealMessage({ type: REVEAL_PANE_MESSAGE, workspaceID: W, paneID: P })?.windowID).toBeNull();
    });
});

describe('revealAppliesHere', () => {
    const targeted = { workspaceID: W, paneID: P, windowID: 'WIN' };
    const untargeted = { workspaceID: W, paneID: P, windowID: null };

    it('acts on a reveal aimed at this shell window', () => {
        expect(revealAppliesHere(targeted, 'WIN')).toBe(true);
    });

    it('ignores one aimed at another window, or at a shell when this is a browser', () => {
        expect(revealAppliesHere(targeted, 'OTHER')).toBe(false);
        expect(revealAppliesHere(targeted, null)).toBe(false);
    });

    it('acts on an untargeted reveal wherever it lands', () => {
        expect(revealAppliesHere(untargeted, null)).toBe(true);
        expect(revealAppliesHere(untargeted, 'WIN')).toBe(true);
    });
});
