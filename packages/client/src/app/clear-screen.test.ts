import { describe, expect, it } from 'vitest';

import { clearFocusedScreen, clearScreenAction, type ClearScreenDeps, type ClearScreenTarget } from './clear-screen';

function harness(overrides: Partial<ClearScreenDeps> = {}) {
    const cleared: string[] = [];
    const deps: ClearScreenDeps = {
        focusedPaneID: () => 'pane-1',
        screenFor: () => ({ alternateScreen: () => false, kittyKeyboardActive: () => false }),
        macLike: true,
        clear: (paneID) => cleared.push(paneID),
        ...overrides
    };
    return { cleared, send: () => clearFocusedScreen(deps) };
}

const fullScreenApp = (kitty: boolean): ClearScreenTarget => ({ alternateScreen: () => true, kittyKeyboardActive: () => kitty });

describe('clearFocusedScreen', () => {
    it('asks the daemon to clear the focused terminal pane and consumes the chord', () => {
        const h = harness();
        expect(h.send()).toBe(true);
        expect(h.cleared).toEqual(['pane-1']);
    });

    it('takes ⌘K over a full-screen app on macOS and clears nothing, so no stray k reaches it', () => {
        const h = harness({ screenFor: () => fullScreenApp(false) });
        expect(h.send()).toBe(true);
        expect(h.cleared).toEqual([]);
    });

    it('hands ⌘K to a full-screen app that negotiated the kitty protocol, as Ghostty encodes it', () => {
        const h = harness({ screenFor: () => fullScreenApp(true) });
        expect(h.send()).toBe(false);
        expect(h.cleared).toEqual([]);
    });

    it('hands Ctrl+K to a full-screen app off macOS, where it is nano’s cut and emacs’s kill', () => {
        const h = harness({ screenFor: () => fullScreenApp(false), macLike: false });
        expect(h.send()).toBe(false);
        expect(h.cleared).toEqual([]);
    });

    it('falls through for a pane with no terminal renderer', () => {
        const h = harness({ screenFor: () => null });
        expect(h.send()).toBe(false);
        expect(h.cleared).toEqual([]);
    });

    it('falls through with no focused pane', () => {
        const h = harness({ focusedPaneID: () => null });
        expect(h.send()).toBe(false);
        expect(h.cleared).toEqual([]);
    });

    it('leaves the alternate-screen check to the daemon for a renderer that cannot answer', () => {
        const h = harness({ screenFor: () => ({}) });
        expect(h.send()).toBe(true);
        expect(h.cleared).toEqual(['pane-1']);
    });
});

describe('clearScreenAction', () => {
    it('clears the normal screen on every platform, kitty protocol or not', () => {
        for (const macLike of [true, false]) {
            for (const kitty of [true, false]) {
                expect(clearScreenAction({ alternateScreen: () => false, kittyKeyboardActive: () => kitty }, macLike)).toBe('clear');
            }
        }
    });

    it('swallows only a legacy-encoded ⌘K on the alternate screen on macOS', () => {
        expect(clearScreenAction(fullScreenApp(false), true)).toBe('swallow');
        expect(clearScreenAction(fullScreenApp(true), true)).toBe('pass');
        expect(clearScreenAction(fullScreenApp(false), false)).toBe('pass');
        expect(clearScreenAction({ alternateScreen: () => true }, true)).toBe('swallow');
    });
});
