/**
 * The kitty keyboard protocol, wired into the pane (§TERM-030).
 *
 * `kitty-keyboard.test.ts` owns the byte matrix. What is asserted here is everything the
 * encoder's own tests cannot see, and it is the half the item's Swift counterpart is actually
 * about:
 *
 *   - the daemon's negotiated flags reach the encoder through `pane-modes`, and are published
 *     on the pane root where the audit can read them;
 *   - the bytes go up the pane's own PTY stream;
 *   - the ENGINE never sees a key that was encoded here — the reason capture-phase interception
 *     exists, and the thing a bubble-phase listener would get wrong;
 *   - a key the encoder declines still reaches the engine untouched, which is the legacy
 *     guarantee for plain typing;
 *   - **releases exist at all**, which is the whole gap: the engine registers zero `keyup`
 *     listeners, so this layer is the only place a release can be observed;
 *   - composition bypasses the encoder completely.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TerminalPane } from './TerminalPane';
import { createFakePtyApi, createFakeRendererFactory, installFakeResizeObserver } from './testing';

/** jsdom reports 0×0 for everything; the pane takes its box through this seam. */
function box(width: number, height: number): (element: HTMLElement) => { width: number; height: number } {
    return () => ({ width, height });
}

let observers: ReturnType<typeof installFakeResizeObserver>;

beforeEach(() => {
    observers = installFakeResizeObserver();
});

afterEach(() => {
    cleanup();
    observers.restore();
    vi.restoreAllMocks();
});

async function settle(): Promise<void> {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
}

/** `\e` written out, so the expectations below read like the wire. */
const esc = (rest: string): string => `\u001B${rest}`;

interface KittyHarness {
    pty: ReturnType<typeof createFakePtyApi>;
    root: HTMLElement;
    host: HTMLElement;
    /** A stand-in for the engine's own listener, mounted BELOW the host exactly as it is. */
    engine: HTMLElement;
    engineEvents: string[];
    setFlags(flags: number): void;
}

async function kittyHarness(flags = 0): Promise<KittyHarness> {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
    const view = render(
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused
            visible
            createRenderer={renderers.factory}
            measure={box(800, 480)}
        />
    );
    await settle();
    const root = view.container.querySelector('[data-pane-id="pane-1"]') as HTMLElement;
    const host = root.querySelector('[data-terminal-host]') as HTMLElement;
    const engine = document.createElement('div');
    const engineEvents: string[] = [];
    for (const type of ['keydown', 'keyup', 'compositionstart', 'compositionend']) {
        engine.addEventListener(type, () => engineEvents.push(type));
    }
    host.appendChild(engine);
    const setFlags = (next: number): void => {
        act(() => {
            pty.last().modes({ kittyKeyboardFlags: next });
        });
    };
    if (flags !== 0) setFlags(flags);
    return { pty, root, host, engine, engineEvents, setFlags };
}

describe('TerminalPane — kitty keyboard protocol', () => {
    it('publishes the negotiated flags on the pane root, and starts at zero', async () => {
        const h = await kittyHarness();
        expect(h.root.getAttribute('data-terminal-kitty')).toBe('0');
        h.setFlags(3);
        expect(h.root.getAttribute('data-terminal-kitty')).toBe('3');
        // A value carrying bits this port does not implement is published as what it will
        // actually honour, so the attribute never over-promises either.
        h.setFlags(31);
        expect(h.root.getAttribute('data-terminal-kitty')).toBe('11');
    });

    it('intercepts nothing while the protocol is off', async () => {
        const h = await kittyHarness();
        fireEvent.keyDown(h.engine, { key: 'Escape', code: 'Escape' });
        fireEvent.keyUp(h.engine, { key: 'Escape', code: 'Escape' });
        fireEvent.keyDown(h.engine, { key: 'i', code: 'KeyI', ctrlKey: true });
        expect(h.pty.last().input).toEqual([]);
        // Every one of them reached the engine, which is what "byte-identical legacy" means.
        expect(h.engineEvents).toEqual(['keydown', 'keyup', 'keydown']);
    });

    it('encodes an intercepted key onto the pane stream, and the engine never sees it', async () => {
        const h = await kittyHarness(1);
        fireEvent.keyDown(h.engine, { key: 'Escape', code: 'Escape' });
        fireEvent.keyDown(h.engine, { key: 'i', code: 'KeyI', ctrlKey: true });
        expect(h.pty.last().input).toEqual([esc('[27u'), esc('[105;5u')]);
        expect(h.engineEvents).toEqual([]);
    });

    it('leaves plain typing to the engine even with the protocol on', async () => {
        const h = await kittyHarness(3);
        fireEvent.keyDown(h.engine, { key: 'a', code: 'KeyA' });
        fireEvent.keyDown(h.engine, { key: 'Enter', code: 'Enter' });
        expect(h.pty.last().input).toEqual([]);
        expect(h.engineEvents).toEqual(['keydown', 'keydown']);
    });

    it('reports a RELEASE — the event the engine has no listener for at all', async () => {
        const h = await kittyHarness(3);
        fireEvent.keyDown(h.engine, { key: 'ArrowUp', code: 'ArrowUp' });
        fireEvent.keyUp(h.engine, { key: 'ArrowUp', code: 'ArrowUp' });
        // The press is `CSI A` in both protocols and stays the engine's (only it knows DECCKM);
        // the release has no legacy form at all, so it is ours. It rides the UN-mirrored frame:
        // terminal-surface.md §8.2 mirrors only the press that carries the input (#51).
        expect(h.pty.last().directInput).toEqual([esc('[1;1:3A')]);
        expect(h.pty.last().input).toEqual([]);
        expect(h.engineEvents).toEqual(['keydown']);
    });

    it('reports the modifier keys themselves once report-all-keys is negotiated', async () => {
        const h = await kittyHarness(11);
        fireEvent.keyDown(h.engine, { key: 'Shift', code: 'ShiftLeft', location: 1, shiftKey: true });
        fireEvent.keyUp(h.engine, { key: 'Shift', code: 'ShiftLeft', location: 1 });
        fireEvent.keyDown(h.engine, { key: 'Control', code: 'ControlRight', location: 2, ctrlKey: true });
        fireEvent.keyUp(h.engine, { key: 'Control', code: 'ControlRight', location: 2 });
        // Presses on the mirrored stream, releases on the un-mirrored one (§8.2, #51).
        expect(h.pty.last().input).toEqual([esc('[57441;2u'), esc('[57448;5u')]);
        expect(h.pty.last().directInput).toEqual([esc('[57441;1:3u'), esc('[57448;1:3u')]);
        expect(h.engineEvents).toEqual([]);
    });

    it('stops encoding the moment the application pops the flags', async () => {
        const h = await kittyHarness(1);
        fireEvent.keyDown(h.engine, { key: 'Escape', code: 'Escape' });
        h.setFlags(0);
        fireEvent.keyDown(h.engine, { key: 'Escape', code: 'Escape' });
        expect(h.pty.last().input).toEqual([esc('[27u')]);
        expect(h.engineEvents).toEqual(['keydown']);
    });

    it('bypasses composition entirely, by the flag and by the window', async () => {
        const h = await kittyHarness(11);
        // `isComposing` on the event itself.
        fireEvent.keyDown(h.engine, { key: 'a', code: 'KeyA', isComposing: true });
        // The IME's own placeholder keydown, which carries no useful key at all.
        fireEvent.keyDown(h.engine, { key: 'Process', code: 'KeyA', keyCode: 229 });
        // And the window: a keydown between compositionstart and compositionend, where some
        // IMEs report `isComposing: false` for the terminating key.
        fireEvent.compositionStart(h.engine, { data: '' });
        fireEvent.keyDown(h.engine, { key: 'Enter', code: 'Enter' });
        fireEvent.compositionEnd(h.engine, { data: '한글' });
        expect(h.pty.last().input).toEqual([]);
        // Every one of them reached the engine, which is the layer that owns composition.
        expect(h.engineEvents).toEqual([
            'keydown',
            'keydown',
            'compositionstart',
            'keydown',
            'compositionend'
        ]);
        // And the window closed: the next Enter is encoded again.
        fireEvent.keyDown(h.engine, { key: 'Enter', code: 'Enter' });
        expect(h.pty.last().input).toEqual([esc('[13u')]);
    });
});
