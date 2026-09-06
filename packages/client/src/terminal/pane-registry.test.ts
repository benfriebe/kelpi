/**
 * The terminal-pane handle registry (#81).
 *
 * Small, and the two properties it exists for are both about NOT lying to `copy`: an unknown
 * pane answers `null` (which is a decline, not an empty selection), and a stale cleanup cannot
 * unregister a live remount.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { paneHandle, registerTerminalPane, registeredPaneCount } from './pane-registry';

const releases: (() => void)[] = [];
/** Everything any registered pane was asked to write, in order (#82). */
const written: string[] = [];

function register(paneID: string, selection: () => string): () => void {
    const release = registerTerminalPane(paneID, {
        selection,
        write: (data) => written.push(`${paneID}:${data}`)
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
});
