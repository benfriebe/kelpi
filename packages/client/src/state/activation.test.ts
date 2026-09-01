import { describe, expect, it } from 'vitest';

import { KelpiConnection, completeHandshake, createFakeSocketFactory } from '../connection';
import {
    activationAppliesHere,
    frameStateAppliesHere,
    isAppActive,
    parseShellActivation,
    parseWindowFrameState
} from './activation';
import { connectStore } from './bridge';
import { createKelpiStore } from './store';

const WINDOW_ID = 'WIN-1';

describe('shell-activation (§AGNT-056)', () => {
    it('reads a well-formed report, with and without a window id', () => {
        expect(parseShellActivation({ type: 'shell-activation', active: false, windowID: WINDOW_ID })).toEqual({
            active: false,
            windowID: WINDOW_ID
        });
        expect(parseShellActivation({ type: 'shell-activation', active: true })).toEqual({
            active: true,
            windowID: null
        });
    });

    it('refuses to read anything that does not carry a boolean `active`', () => {
        expect(parseShellActivation({ type: 'hotkey-status', active: true })).toBeNull();
        expect(parseShellActivation({ type: 'shell-activation' })).toBeNull();
        expect(parseShellActivation({ type: 'shell-activation', active: 'yes' })).toBeNull();
        expect(parseShellActivation({ type: 'shell-activation', active: 1 })).toBeNull();
    });

    it('scopes a targeted report to the window it names, and lets an untargeted one through', () => {
        const targeted = { active: false, windowID: WINDOW_ID };
        expect(activationAppliesHere(targeted, WINDOW_ID)).toBe(true);
        // A second shell window losing focus says nothing about this one…
        expect(activationAppliesHere(targeted, 'WIN-2')).toBe(false);
        // …and a browser tab (no `?shellWindow=`) has no shell reporting for it at all.
        expect(activationAppliesHere(targeted, null)).toBe(false);

        const broadcast = { active: true, windowID: null };
        expect(activationAppliesHere(broadcast, WINDOW_ID)).toBe(true);
        expect(activationAppliesHere(broadcast, null)).toBe(true);
    });

    it('gates the dwell on BOTH the window being active and the document being visible', () => {
        expect(isAppActive({ appActive: true, documentVisible: true })).toBe(true);
        expect(isAppActive({ appActive: false, documentVisible: true })).toBe(false);
        expect(isAppActive({ appActive: true, documentVisible: false })).toBe(false);
        expect(isAppActive({ appActive: false, documentVisible: false })).toBe(false);
    });
});

/**
 * The wire half: a relayed `shell-activation` has to reach the store, because that is what the
 * pane grid reads to gate its 600 ms clear.
 */
describe('the bridge applies a relayed activation', () => {
    const harness = (shellWindowID: string | null) => {
        const store = createKelpiStore();
        const sockets = createFakeSocketFactory();
        const connection = new KelpiConnection({
            url: 'ws://daemon.test/ws',
            token: 't',
            socketFactory: sockets.factory,
            backoff: { initialMs: 10, maxMs: 10, factor: 1, jitter: 0 },
            heartbeatIntervalMs: 0
        });
        const dispose = connectStore({ store, connection, notifications: null, tokenStorage: null, shellWindowID });
        connection.connect();
        completeHandshake(sockets.last());
        return { store, sockets, dispose };
    };

    it('flips appActive for this window, and ignores another window’s report', () => {
        const h = harness(WINDOW_ID);
        // The default is "active": a client that has never heard from a shell behaves exactly
        // as it did before this existed.
        expect(h.store.getState().ui.appActive).toBe(true);

        h.sockets.last().emit({ type: 'shell-activation', active: false, windowID: WINDOW_ID } as never);
        expect(h.store.getState().ui.appActive).toBe(false);

        h.sockets.last().emit({ type: 'shell-activation', active: true, windowID: 'WIN-OTHER' } as never);
        expect(h.store.getState().ui.appActive).toBe(false);

        h.sockets.last().emit({ type: 'shell-activation', active: true, windowID: WINDOW_ID } as never);
        expect(h.store.getState().ui.appActive).toBe(true);
        h.dispose();
    });

    it('leaves a browser client alone unless the report is unscoped', () => {
        const h = harness(null);
        h.sockets.last().emit({ type: 'shell-activation', active: false, windowID: WINDOW_ID } as never);
        expect(h.store.getState().ui.appActive).toBe(true);

        h.sockets.last().emit({ type: 'shell-activation', active: false } as never);
        expect(h.store.getState().ui.appActive).toBe(false);
        h.dispose();
    });
});

describe('the window frame state (§APP-046b)', () => {
    it('reads a maximise report and the window it is about', () => {
        expect(parseWindowFrameState({ type: 'window-frame-state', maximized: true, windowID: WINDOW_ID })).toEqual({
            maximized: true,
            windowID: WINDOW_ID
        });
        expect(parseWindowFrameState({ type: 'window-frame-state', maximized: false })).toEqual({
            maximized: false,
            windowID: null
        });
    });

    it('refuses anything that is not one, and never defaults the boolean', () => {
        // A guess here draws the wrong glyph on a real button, and the next true report is
        // never far away — silence is the safer answer.
        expect(parseWindowFrameState({ type: 'shell-activation', active: true })).toBeNull();
        expect(parseWindowFrameState({ type: 'window-frame-state' })).toBeNull();
        expect(parseWindowFrameState({ type: 'window-frame-state', maximized: 'yes' })).toBeNull();
        expect(parseWindowFrameState({ type: 'window-frame-state', maximized: 1 })).toBeNull();
    });

    it('applies to the named window only, and to everyone when unnamed', () => {
        // Two windows are independently maximised; one being maximised says nothing about the
        // other's button.
        expect(frameStateAppliesHere({ maximized: true, windowID: WINDOW_ID }, WINDOW_ID)).toBe(true);
        expect(frameStateAppliesHere({ maximized: true, windowID: 'other' }, WINDOW_ID)).toBe(false);
        expect(frameStateAppliesHere({ maximized: true, windowID: WINDOW_ID }, null)).toBe(false);
        expect(frameStateAppliesHere({ maximized: true, windowID: null }, WINDOW_ID)).toBe(true);
        expect(frameStateAppliesHere({ maximized: true, windowID: null }, null)).toBe(true);
    });
});
