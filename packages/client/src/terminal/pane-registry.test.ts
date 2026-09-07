/**
 * The terminal-pane handle registry (#81).
 *
 * Small, and the two properties it exists for are both about NOT lying to `copy`: an unknown
 * pane answers `null` (which is a decline, not an empty selection), and a stale cleanup cannot
 * unregister a live remount.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
    notifyTerminalPanes,
    paneHandle,
    registerTerminalPane,
    registeredPaneCount,
    subscribeTerminalPanes,
    terminalPanesVersion
} from './pane-registry';

const releases: (() => void)[] = [];
/** Everything any registered pane was asked to write, in order (#82). */
const written: string[] = [];

function register(paneID: string, selection: () => string): () => void {
    const release = registerTerminalPane(paneID, {
        selection,
        write: (data) => written.push(`${paneID}:${data}`),
        // C9's half of the handle. Stubbed flat here: what this file is about is the map, and
        // `PhoneKeyBar.test.tsx` is where the bar drives these against a real pane.
        root: () => null,
        dispatchKey: () => false,
        pasteText: () => false,
        showKeyboard: () => undefined,
        hideKeyboard: () => undefined,
        cellHeight: () => 0,
        focusedOnScreen: () => false
    });
    releases.push(release);
    return release;
}

afterEach(() => {
    while (releases.length > 0) releases.pop()?.();
    written.length = 0;
});

describe('the terminal pane registry', () => {
    it('reads through to the pane at call time, never a cached value', () => {
        let selected = 'first';
        register('pane-1', () => selected);
        expect(paneHandle('pane-1')?.selection()).toBe('first');
        selected = 'second';
        expect(paneHandle('pane-1')?.selection()).toBe('second');
    });

    it('answers null for a pane that never registered, and for a missing id', () => {
        expect(paneHandle('pane-unknown')).toBeNull();
        expect(paneHandle(null)).toBeNull();
        expect(paneHandle(undefined)).toBeNull();
    });

    it('releases on unregister, so a closed pane stops answering', () => {
        const release = register('pane-2', () => 'text');
        expect(paneHandle('pane-2')).not.toBeNull();
        release();
        expect(paneHandle('pane-2')).toBeNull();
    });

    it('is idempotent: a double release cannot remove someone else s registration', () => {
        const release = register('pane-3', () => 'old');
        release();
        register('pane-3', () => 'new');
        // The stale cleanup runs again (StrictMode's double invoke, a fast close/reopen that
        // reuses the id). It must not take the live handle with it.
        release();
        expect(paneHandle('pane-3')?.selection()).toBe('new');
    });

    // #82: the write seam the line-editing actions use, on the pane the registry names.
    it('routes a write to the pane it was registered for', () => {
        register('pane-w1', () => '');
        register('pane-w2', () => '');
        paneHandle('pane-w2')?.write('\u0015');
        expect(written).toEqual(['pane-w2:\u0015']);
    });

    it('counts what is registered', () => {
        const before = registeredPaneCount();
        register('pane-4', () => '');
        register('pane-5', () => '');
        expect(registeredPaneCount()).toBe(before + 2);
    });

    /*
     * C9: the window's key bar renders BEFORE any pane's mount effect has run, so a host that
     * only pulled would decide "no terminal" once and never look again. These three are what
     * make it look again.
     */
    describe('the change signal the window key bar re-reads on (C9)', () => {
        it('bumps the version on a registration and on a release', () => {
            const before = terminalPanesVersion();
            const release = register('pane-v1', () => '');
            expect(terminalPanesVersion()).toBe(before + 1);
            release();
            expect(terminalPanesVersion()).toBe(before + 2);
        });

        it('says nothing for a release that is already spent', () => {
            const release = register('pane-v2', () => '');
            release();
            const after = terminalPanesVersion();
            release();
            expect(terminalPanesVersion()).toBe(after);
        });

        it('tells its listeners, and stops when they unsubscribe', () => {
            let heard = 0;
            const stop = subscribeTerminalPanes(() => {
                heard += 1;
            });
            register('pane-v3', () => '');
            expect(heard).toBe(1);
            // The answer a handle GIVES has changed (the pane took the ring), not the handle.
            notifyTerminalPanes();
            expect(heard).toBe(2);
            stop();
            register('pane-v4', () => '');
            expect(heard).toBe(2);
        });
    });
});
