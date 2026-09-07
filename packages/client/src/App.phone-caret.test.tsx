/**
 * C5 - closing an overlay on a phone does not summon the software keyboard.
 *
 * **Owner-directed divergence from the shipped Swift app**, like every phone rule: the shipped
 * app is a Mac app, so there is no Swift behaviour to be faithful to here and there cannot be one
 * (`chrome/form-factor.ts` says that once for the whole program).
 *
 * The defect, reported from the owner's phone (device round 4, 2026-09-07, Android Chrome): with
 * the software keyboard put away, opening Settings and closing it again brought the keyboard
 * straight back. The chain is `closeSettings` → `handBackPaneCaret` → `focusPaneSurface`
 * (`app/pane-focus.ts`), which focuses the engine's hidden `<textarea>` - and `focus()` on an
 * editable IS how Android raises the keyboard. The same call is exactly right on a desktop, where
 * a window left with the caret on a button that no longer exists types nowhere, so the rule is
 * about the form factor and not about the close: `mayClaimPaneCaret` holds it, and both halves
 * are pinned below.
 *
 * ASSEMBLY, not the sheet: the close path lives in `App.tsx` and the caret it moves belongs to a
 * pane, so nothing smaller than the two together can measure it. The window is faked on the
 * global `window` (jsdom gives each test file its own) because `App` reads the program's one
 * form-factor signal rather than taking a window prop - which is the point of that module.
 */

import type { JsonObject } from '@kelpi/protocol';
import { createStore as createDaemonStore, emptyDaemonState } from '@kelpi/daemon/store';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';
import { completeHandshake, createFakeSocketFactory } from './connection';
import { createKelpiRuntime, createKelpiStore } from './state';
import { createFakeRendererFactory } from './terminal/testing';

const W1 = 'AAAAAAAA-0000-4000-8000-000000000001';
const PANE_A = 'DDDDDDDD-0000-4000-8000-000000000001';
const NOW = 1_755_500_000_000;

function snapshotState(): JsonObject {
    const store = createDaemonStore(emptyDaemonState('/Users/test'));
    store.dispatch({ type: 'create-workspace', id: W1, paneID: PANE_A, name: 'alpha', color: 'blue', now: NOW });
    store.dispatch({ type: 'set-active-workspace', id: W1, now: NOW });
    return store.getState() as unknown as JsonObject;
}

/**
 * The two form factors, at the one place `chrome/form-factor.ts` reads: the layout viewport's
 * narrow side and `(pointer: coarse)`. A 390x844 window with a FINE pointer is the "narrow
 * desktop window" the rule deliberately keeps on the desktop side, so the desktop twin below is
 * the same geometry with the pointer flipped - which is what makes it a test of the rule rather
 * than of the width.
 */
function useWindow(coarse: boolean): void {
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true, writable: true });
    window.matchMedia = ((query: string) => ({
        matches: query === '(pointer: coarse)' && coarse,
        media: query,
        onchange: null,
        addEventListener(): void {},
        removeEventListener(): void {},
        addListener(): void {},
        removeListener(): void {},
        dispatchEvent(): boolean {
            return false;
        }
    })) as unknown as typeof window.matchMedia;
}

interface Mounted {
    /** The pane's marked surface: the engine's textarea lives inside it. */
    readonly host: HTMLElement;
}

/** A live window with one shell pane, its engine open and its caret dropped. */
async function mountWithTheKeyboardDown(): Promise<Mounted> {
    Element.prototype.scrollIntoView = function (): void {
        /* jsdom has no layout; the sheet's own tests own that clause */
    };
    const sockets = createFakeSocketFactory();
    const store = createKelpiStore();
    const runtime = createKelpiRuntime({
        url: 'ws://daemon.test/ws',
        token: 'tok',
        socketFactory: sockets.factory,
        store,
        notifications: null,
        tokenStorage: null,
        heartbeatIntervalMs: 0,
        backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }
    });
    // `autoFocusOnOpen` models the vendored engine's own `open()`, which ends with `this.focus()`
    // - so the caret starts where a real phone's does, in the engine's textarea with the keyboard
    // up, and the drop below is a real transition rather than a starting state.
    const view = render(<App runtime={runtime} createRenderer={createFakeRendererFactory({ autoFocusOnOpen: true }).factory} />);
    act(() => {
        completeHandshake(sockets.last(), { state: snapshotState() });
    });
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
    const root = await waitFor(() => {
        const node = view.container.querySelector(`[data-pane-id="${PANE_A}"]`);
        expect(node).not.toBeNull();
        return node as HTMLElement;
    });
    const host = root.querySelector('[data-terminal-host]') as HTMLElement;
    // Every mount-time handoff is bounded at 1.5 s (`CARET_HANDOFF_BUDGET_MS`); let them all
    // expire, so what the close does below is the only thing being measured.
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1700));
    });
    // The person puts the keyboard away. On a phone that is the key bar's toggle; either way it
    // is `releasePaneCaret`, i.e. the caret leaving the engine.
    await act(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        await Promise.resolve();
    });
    expect(host.contains(document.activeElement)).toBe(false);
    return { host };
}

/** ⌘, then the sheet's own Close, which is the gesture the owner used. */
async function openAndCloseSettings(): Promise<void> {
    await act(async () => {
        fireEvent.keyDown(window, { code: 'Comma', key: ',', metaKey: true });
        await Promise.resolve();
    });
    const close = document.querySelector('[data-testid="settings-close"]');
    expect(close).not.toBeNull();
    await act(async () => {
        fireEvent.click(close as HTMLButtonElement);
        await Promise.resolve();
    });
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
    });
}

afterEach(cleanup);

describe('closing Settings and the software keyboard (C5)', () => {
    it('leaves the keyboard down on a phone: the caret does not go back to the engine', async () => {
        useWindow(true);
        const { host } = await mountWithTheKeyboardDown();
        await openAndCloseSettings();
        expect(host.contains(document.activeElement)).toBe(false);
    });

    it('and NOT on desktop: the same close hands the caret straight back (§10.4)', async () => {
        useWindow(false);
        const { host } = await mountWithTheKeyboardDown();
        await openAndCloseSettings();
        expect(host.contains(document.activeElement)).toBe(true);
    });
});
