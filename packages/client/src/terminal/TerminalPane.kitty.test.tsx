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

async function kittyHarness(flags = 0, props: { macosOptionAsAlt?: boolean } = {}): Promise<KittyHarness> {
    const pty = createFakePtyApi();
    const renderers = createFakeRendererFactory({ cell: { width: 10, height: 20 } });
    const view = render(
        <TerminalPane
            paneID="pane-1"
            ptyApi={pty}
            focused
            visible
            {...(props.macosOptionAsAlt === undefined ? {} : { macosOptionAsAlt: props.macosOptionAsAlt })}
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

    /**
     * #80. The pane's interceptor calls `preventDefault()` on everything it consumes, and
     * `preventDefault()` on ⌘V is the end of paste: the engine passes the chord through
     * un-prevented precisely so the browser's `paste` event fires, and the shell's Edit menu is
     * downstream of the page. So the assertion is BOTH halves, not just "no bytes": nothing on
     * the stream, the engine still saw the key, and the event is still cancelable.
     */
    it('keeps the macOS system-editing chords for the layers below (#80)', async () => {
        const h = await kittyHarness(11);
        const notPrevented: boolean[] = [];
        for (const key of ['v', 'c', 'x', 'a', 'z']) {
            notPrevented.push(
                fireEvent.keyDown(h.engine, { key, code: `Key${key.toUpperCase()}`, metaKey: true })
            );
        }
        expect(h.pty.last().input).toEqual([]);
        expect(h.pty.last().directInput).toEqual([]);
        expect(h.engineEvents).toEqual(['keydown', 'keydown', 'keydown', 'keydown', 'keydown']);
        // `fireEvent` returns false when a listener called preventDefault. All five must be true.
        expect(notPrevented).toEqual([true, true, true, true, true]);
    });

    it('still encodes every OTHER super chord, so the exemption is the five and no more', async () => {
        const h = await kittyHarness(11);
        fireEvent.keyDown(h.engine, { key: 'b', code: 'KeyB', metaKey: true });
        fireEvent.keyDown(h.engine, { key: 'Backspace', code: 'Backspace', metaKey: true });
        expect(h.pty.last().input).toEqual([esc('[98;9u'), esc('[127;9u')]);
        expect(h.engineEvents).toEqual([]);
    });

    /**
     * #95. The mirror image of the block above, and the difference is the whole fix.
     *
     * A system-editing chord is handed to fallbacks that live INSIDE the page, so the engine
     * must still see it. A PLATFORM chord is answered by a native `role` accelerator, which
     * fires only for a key the page did not consume, and the engine consumes every chord it
     * can map, `preventDefault()` included. So the pane takes these away from the engine and
     * leaves their default alone: `stopImmediatePropagation()` without `preventDefault()`.
     *
     * Asserted at BOTH flag sets, because the two layers fail differently: with the protocol
     * off the engine was the one eating ⌘H, and with it on the encoder got there first.
     */
    const PLATFORM_PRESSES = [
        { key: 'h', code: 'KeyH', metaKey: true },
        { key: 'h', code: 'KeyH', metaKey: true, altKey: true },
        { key: 'f', code: 'KeyF', metaKey: true, ctrlKey: true },
        { key: 'm', code: 'KeyM', metaKey: true },
        { key: 'q', code: 'KeyQ', metaKey: true }
    ];

    for (const flags of [0, 11]) {
        it(`hands ⌘H, ⌥⌘H, ⌃⌘F, ⌘M and ⌘Q to the platform with the protocol ${flags === 0 ? 'off' : 'on'} (#95)`, async () => {
            const h = await kittyHarness(flags);
            const notPrevented: boolean[] = [];
            for (const press of PLATFORM_PRESSES) notPrevented.push(fireEvent.keyDown(h.engine, press));
            // Nothing was encoded onto the stream…
            expect(h.pty.last().input).toEqual([]);
            expect(h.pty.last().directInput).toEqual([]);
            // …the ENGINE never saw them, which is what stops it preventing their default…
            expect(h.engineEvents).toEqual([]);
            // …and nothing prevented the default, which is the condition Chromium redispatches
            // an unhandled key on. `fireEvent` returns false when a listener prevented it.
            expect(notPrevented).toEqual([true, true, true, true, true]);
        });
    }

    it('guards keydown only: a release has nothing below it to protect it from (#95)', async () => {
        const h = await kittyHarness(11);
        // The engine registers zero `keyup` listeners in the real app, and the encoder has
        // already declined the chord, so the release is left to travel exactly as it did.
        expect(fireEvent.keyUp(h.engine, { key: 'h', code: 'KeyH', metaKey: true })).toBe(true);
        expect(h.pty.last().input).toEqual([]);
        expect(h.pty.last().directInput).toEqual([]);
        expect(h.engineEvents).toEqual(['keyup']);
    });

    it('is exact about the modifiers: the near misses still reach the terminal (#95)', async () => {
        const h = await kittyHarness(11);
        // ⇧⌘M is no role's accelerator, and ⌃⌘H is not Hide Others.
        fireEvent.keyDown(h.engine, { key: 'm', code: 'KeyM', metaKey: true, shiftKey: true });
        fireEvent.keyDown(h.engine, { key: 'h', code: 'KeyH', metaKey: true, ctrlKey: true });
        expect(h.pty.last().input).toEqual([esc('[109;10u'), esc('[104;13u')]);
        expect(h.engineEvents).toEqual([]);
    });

    /**
     * #171, at the pane rather than in the encoder's byte matrix.
     *
     * The two presses are the ones the ticket and the decision name, in the shape a browser on
     * macOS raises them: `key` is the glyph the LAYOUT composed, `altKey` is still true, `code` is
     * the physical key. jsdom reports an empty `navigator.platform`, which `chrome/keys.ts` reads
     * as mac-like on purpose, so `CLIENT_MAC_LIKE` is true here and the setting is the only
     * variable.
     *
     * What is asserted is the whole user-visible difference: WHO gets the keystroke. Declined, it
     * reaches the engine, which writes the composed character as text (the legacy path, measured
     * against the real engine in `KeyBar.test.tsx`); encoded, it is bytes on the pane's stream and
     * the engine never sees it.
     */
    const OPTION_SHIFT_MINUS = { key: '\u2014', code: 'Minus', altKey: true, shiftKey: true };
    const OPTION_B = { key: '\u222B', code: 'KeyB', altKey: true };

    it('lets the LAYOUT keep ⌥ by default, so a composed character reaches the engine (#171)', async () => {
        const h = await kittyHarness(1);
        fireEvent.keyDown(h.engine, OPTION_SHIFT_MINUS);
        fireEvent.keyDown(h.engine, OPTION_B);
        expect(h.pty.last().input).toEqual([]);
        expect(h.pty.last().directInput).toEqual([]);
        expect(h.engineEvents).toEqual(['keydown', 'keydown']);
    });

    it('…and the same two keys with macos-option-as-alt on are chords, as they were before (#171)', async () => {
        const h = await kittyHarness(1, { macosOptionAsAlt: true });
        fireEvent.keyDown(h.engine, OPTION_SHIFT_MINUS);
        fireEvent.keyDown(h.engine, OPTION_B);
        // `CSI 8212;4u` is the byte sequence #171 reported: the em dash, as alt+shift+glyph.
        expect(h.pty.last().input).toEqual([esc('[8212;4u'), esc('[8747;3u')]);
        expect(h.engineEvents).toEqual([]);
    });

    it('reports the glyph without the alt bit under report-all-keys, where the engine has no text to write (#171)', async () => {
        const h = await kittyHarness(11);
        fireEvent.keyDown(h.engine, OPTION_SHIFT_MINUS);
        fireEvent.keyDown(h.engine, OPTION_B);
        expect(h.pty.last().input).toEqual([esc('[8212;2u'), esc('[8747u')]);
        expect(h.engineEvents).toEqual([]);
    });

    it('changes nothing on a pane with no protocol negotiated, at either setting (#171)', async () => {
        // The legacy path is not gated by this setting and never was: with the flags at zero the
        // encoder declines every key, so both panes hand the composed character to the engine.
        for (const macosOptionAsAlt of [false, true]) {
            const h = await kittyHarness(0, { macosOptionAsAlt });
            fireEvent.keyDown(h.engine, OPTION_SHIFT_MINUS);
            fireEvent.keyDown(h.engine, OPTION_B);
            expect(h.pty.last().input).toEqual([]);
            expect(h.pty.last().directInput).toEqual([]);
            expect(h.engineEvents).toEqual(['keydown', 'keydown']);
            cleanup();
        }
    });

    it('leaves ⌥ word motion alone, whatever the setting says (#171)', async () => {
        const h = await kittyHarness(1, { macosOptionAsAlt: false });
        fireEvent.keyDown(h.engine, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true });
        fireEvent.keyDown(h.engine, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
        expect(h.pty.last().input).toEqual([esc('[1;3D'), esc('[1;3C')]);
        expect(h.engineEvents).toEqual([]);
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
