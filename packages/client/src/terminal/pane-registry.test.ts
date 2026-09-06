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

function register(paneID: string, selection: () => string): () => void {
    const release = registerTerminalPane(paneID, { selection });
    releases.push(release);
    return release;
}

afterEach(() => {
    while (releases.length > 0) releases.pop()?.();
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

    it('counts what is registered', () => {
        const before = registeredPaneCount();
        register('pane-4', () => '');
        register('pane-5', () => '');
        expect(registeredPaneCount()).toBe(before + 2);
    });
});
