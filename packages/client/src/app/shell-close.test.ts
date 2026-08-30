/**
 * N14 — the renderer half of File ▸ Close (⌘W).
 *
 * What is pinned here is the CONTRACT the shell's menu row depends on: the request runs the
 * dispatcher (not a private close path), it answers honestly when there is nothing to close (so
 * the shell can fall back to closing the window), and it never lets one ⌘W close two panes.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    CLOSE_PANE_CHORD_COMMAND,
    KEYBOARD_CLOSE_COALESCE_MS,
    SHELL_CLOSE_GLOBAL,
    createShellCloseBridge,
    installShellCloseBridge,
    type ShellCloseGlobalTarget
} from './shell-close';
import { parseChordCommand } from '../webpane/priority';

describe('the chord the row stands for', () => {
    it('is ⌘W, in the vocabulary `replayChordCommand` already parses', () => {
        // Not a second spelling of the chord: the shell's Close row and the web-pane relay
        // replay through the same parser, so a ⌘W from either lands on the same binding lookup.
        expect(parseChordCommand(CLOSE_PANE_CHORD_COMMAND)).toEqual({
            code: 'KeyW',
            metaKey: true,
            shiftKey: false,
            ctrlKey: false,
            altKey: false
        });
    });

    it('names the global the shell evaluates (pinned on both sides)', () => {
        // `shell/src/menu.ts`'s CLOSE_PANE_EXPRESSION contains this literal and asserts it too.
        expect(SHELL_CLOSE_GLOBAL).toBe('__kelpiShellClosePane');
    });
});

describe('createShellCloseBridge', () => {
    it('answers true when the dispatcher consumed the replayed chord', () => {
        const replay = vi.fn(() => true);
        const bridge = createShellCloseBridge({ replay });

        expect(bridge.request()).toBe(true);
        expect(replay).toHaveBeenCalledTimes(1);
    });

    it('answers false when nothing consumed it — the shell then closes the window', () => {
        const bridge = createShellCloseBridge({ replay: () => false });
        expect(bridge.request()).toBe(false);
    });

    it('does not close a second pane for a ⌘W the keyboard already closed one for', () => {
        // The double-fire case: the frame relayed the chord AND the native accelerator reached
        // the menu row anyway. The second arrival must be absorbed, not acted on.
        let now = 1_000;
        const replay = vi.fn(() => true);
        const bridge = createShellCloseBridge({ replay, now: () => now });

        bridge.noteKeyboardClose();
        now += 10;

        expect(bridge.request()).toBe(true);
        expect(replay).not.toHaveBeenCalled();
    });

    it('stops absorbing once the coalescing window has passed', () => {
        let now = 1_000;
        const replay = vi.fn(() => true);
        const bridge = createShellCloseBridge({ replay, now: () => now });

        bridge.noteKeyboardClose();
        now += KEYBOARD_CLOSE_COALESCE_MS + 1;

        expect(bridge.request()).toBe(true);
        expect(replay).toHaveBeenCalledTimes(1);
    });

    it('does not treat its OWN replay as a keyboard close — two menu clicks close two panes', () => {
        let now = 1_000;
        const bridge: { request(): boolean; noteKeyboardClose(): void } = createShellCloseBridge({
            // The replay reaches the `close_pane` action, which reports back. That report must
            // not arm the guard against the KELPIT menu click.
            replay: () => {
                bridge.noteKeyboardClose();
                return true;
            },
            now: () => now
        });

        expect(bridge.request()).toBe(true);
        now += 10;
        expect(bridge.request()).toBe(true);
    });

    it('only guards against a close that actually happened', () => {
        // `close_pane` returning false (nothing focused) never calls `noteKeyboardClose`, so a
        // menu click straight after a no-op keystroke still gets its own answer.
        const replay = vi.fn(() => false);
        const bridge = createShellCloseBridge({ replay, now: () => 1_000 });

        expect(bridge.request()).toBe(false);
        expect(replay).toHaveBeenCalledTimes(1);
    });
});

describe('installShellCloseBridge', () => {
    it('publishes the request as the global the shell calls, and restores on dispose', () => {
        const target: ShellCloseGlobalTarget = {};
        const bridge = createShellCloseBridge({ replay: () => true });

        const dispose = installShellCloseBridge(bridge, target);
        const global = target[SHELL_CLOSE_GLOBAL] as (() => boolean) | undefined;

        expect(typeof global).toBe('function');
        expect(global?.()).toBe(true);

        dispose();
        expect(target[SHELL_CLOSE_GLOBAL]).toBeUndefined();
    });

    it('restores a previous global rather than deleting someone else’s', () => {
        const previous = (): boolean => false;
        const target: ShellCloseGlobalTarget = { [SHELL_CLOSE_GLOBAL]: previous };

        const dispose = installShellCloseBridge(createShellCloseBridge({ replay: () => true }), target);
        dispose();

        expect(target[SHELL_CLOSE_GLOBAL]).toBe(previous);
    });
});
