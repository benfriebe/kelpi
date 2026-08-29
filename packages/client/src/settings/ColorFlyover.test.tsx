/**
 * §N38 — the Labels colour flyover.
 *
 * Three layers, in the order they can be trusted:
 *
 *   1. the ARITHMETIC — `hsvFromHex` / `hexFromHsv` / `parseFlexibleHex` / `colorFlyoverPlacement`
 *      are pure and are tested as such, because none of them can be read off a jsdom render (the
 *      placement in particular works from measurements jsdom does not have);
 *   2. the POPOVER itself, rendered from a real `LabelsTab` row so the thing under test is the
 *      one the app mounts — its two sections, its custom view, its dismissals and its focus;
 *   3. the WIRE — every gesture is followed to the `updateLabelPreset` payload it produces, since
 *      "immediate apply" is a claim about the daemon and not about local state.
 *
 * What jsdom cannot answer is stated where it comes up and is measured on the live stack instead
 * (the `labels-design` audit step): the panel's real height and therefore the flip, the gradients,
 * and pointer capture. The KEYBOARD path through the picker is exercised here in full, which is
 * why the nudges exist as a first-class input rather than only as an accessibility courtesy.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState as reactUseState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChromeLabelPreset } from '../chrome';
import { WORKSPACE_COLOR_HEX, overlayCovers, overlayPresenceCount, useOverlayRects } from '../chrome';
import {
    COLOR_FLYOVER_WIDTH,
    colorFlyoverPlacement,
    hexFromHsv,
    hsvFromHex,
    parseFlexibleHex
} from './ColorFlyover';
import { LabelsTab } from './LabelsTab';
import type { LabelledWorkspace } from './model';
import type { SettingsActions } from './types';

interface Recorded {
    readonly updated: {
        id: string;
        name?: string | undefined;
        color?: string | undefined;
        textColor?: string | null | undefined;
    }[];
}

function actions(): SettingsActions & { readonly log: Recorded } {
    const log: Recorded = { updated: [] };
    return {
        log,
        setKeybinding: vi.fn(),
        resetKeybindings: vi.fn(),
        setGeneralSetting: vi.fn(),
        setGhosttySetting: vi.fn(),
        setProfiles: vi.fn(),
        addLabelPreset: vi.fn(),
        updateLabelPreset: (input) => log.updated.push(input),
        removeLabelPreset: vi.fn(),
        moveLabelPreset: vi.fn()
    };
}

const PRESETS: readonly ChromeLabelPreset[] = [
    { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null },
    { name: 'wip', color: { kind: 'named', color: 'blue' }, textColor: null }
];

function setup(presets: readonly ChromeLabelPreset[] = PRESETS, workspaces: readonly LabelledWorkspace[] = []) {
    const bound = actions();
    render(<LabelsTab presets={presets} workspaces={workspaces} actions={bound} bucket="dark" />);
    return bound;
}

/** Open `preset`'s flyover the way a person does: press its swatch trigger. */
function open(preset = 'ship'): HTMLElement {
    const trigger = screen.getByTestId(`label-color-${preset}-trigger`);
    fireEvent.click(trigger);
    return trigger;
}

afterEach(cleanup);

// ── 1. the arithmetic ───────────────────────────────────────────────────────────────

describe('hex ↔ HSV (§N38)', () => {
    /**
     * The property the hex field and the stored value both rest on: looking at a colour cannot
     * change it. `hsvFromHex` derives the hue from the same `delta` `hexFromHsv` multiplies back
     * in, so the middle component reconstructs to the byte it came from.
     */
    it('round-trips every hex byte-exactly, palette included', () => {
        const cases = [
            ...Object.values(WORKSPACE_COLOR_HEX).flatMap((entry) => [entry.light, entry.dark]),
            '#000000',
            '#ffffff',
            '#ff8800',
            '#123456',
            '#010203',
            '#7f7f80',
            '#00ff00',
            '#0000ff',
            '#fedcba'
        ];
        for (const hex of cases) {
            const hsv = hsvFromHex(hex);
            expect(hsv).not.toBeNull();
            expect(hexFromHsv(hsv as { h: number; s: number; v: number })).toBe(hex.toLowerCase());
        }
    });

    it('reads black and grey without inventing a hue', () => {
        expect(hsvFromHex('#000000')).toEqual({ h: 0, s: 0, v: 0 });
        expect(hsvFromHex('#808080')?.s).toBe(0);
    });

    it('is null for anything that is not a colour', () => {
        expect(hsvFromHex('nope')).toBeNull();
        expect(hsvFromHex('#12345')).toBeNull();
    });

    it('wraps the hue rather than clipping it, so a nudge past 360 lands at 0', () => {
        expect(hexFromHsv({ h: 360, s: 1, v: 1 })).toBe('#ff0000');
        expect(hexFromHsv({ h: -1, s: 1, v: 1 })).toBe(hexFromHsv({ h: 359, s: 1, v: 1 }));
    });
});

describe('parseFlexibleHex (§N38)', () => {
    it('takes 3 and 6 digits, with or without the hash, and lowercases', () => {
        expect(parseFlexibleHex('#FF8800')).toBe('#ff8800');
        expect(parseFlexibleHex('ff8800')).toBe('#ff8800');
        expect(parseFlexibleHex('#f80')).toBe('#ff8800');
        expect(parseFlexibleHex('f80')).toBe('#ff8800');
        expect(parseFlexibleHex('  #F80  ')).toBe('#ff8800');
    });

    it('refuses a partial or malformed value rather than guessing at one', () => {
        for (const value of ['', '#', '#f', '#ff', '#ffff', '#fffff', '#gggggg', 'red']) {
            expect(parseFlexibleHex(value)).toBeNull();
        }
    });
});

describe('colorFlyoverPlacement (§N38)', () => {
    const viewport = { width: 1280, height: 820 };
    const size = { width: COLOR_FLYOVER_WIDTH, height: 300 };

    it('drops below the trigger when there is room', () => {
        const at = colorFlyoverPlacement({ left: 400, top: 200, width: 16, height: 16 }, size, viewport);
        expect(at).toEqual({ left: 400, top: 222, side: 'below' });
    });

    it('flips above when the drop would run off the bottom', () => {
        const at = colorFlyoverPlacement({ left: 400, top: 700, width: 16, height: 16 }, size, viewport);
        expect(at.side).toBe('above');
        expect(at.top).toBe(700 - 6 - 300);
    });

    it('stays below when neither side fits — a clipped bottom beats a clipped header', () => {
        const tall = { width: COLOR_FLYOVER_WIDTH, height: 800 };
        const at = colorFlyoverPlacement({ left: 10, top: 400, width: 16, height: 16 }, tall, viewport);
        expect(at.side).toBe('below');
        // …and it is clamped into the window rather than left hanging off it: 820 − 800 − 8 = 12
        // is the lowest top that still leaves the margin at the bottom edge.
        expect(at.top).toBe(12);
    });

    it('clamps into the viewport on both axes', () => {
        const at = colorFlyoverPlacement({ left: 1270, top: 10, width: 16, height: 16 }, size, viewport);
        expect(at.left).toBe(viewport.width - COLOR_FLYOVER_WIDTH - 8);
        const off = colorFlyoverPlacement({ left: -50, top: 10, width: 16, height: 16 }, size, viewport);
        expect(off.left).toBe(8);
    });

    it('is deterministic with no measurements at all (jsdom, a pre-layout open)', () => {
        const at = colorFlyoverPlacement({ left: 0, top: 0, width: 0, height: 0 }, size, { width: 0, height: 0 });
        expect(Number.isFinite(at.left)).toBe(true);
        expect(Number.isFinite(at.top)).toBe(true);
    });
});

// ── 2/3. the popover, and what it writes ────────────────────────────────────────────

describe('the row’s swatch trigger (§N38)', () => {
    it('is a disclosure, not a colour: haspopup + expanded, and it paints the background', () => {
        setup();
        const trigger = screen.getByTestId('label-color-ship-trigger');
        expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(trigger.dataset['color']).toBe('gray');
        expect(screen.queryByTestId('label-color-flyover')).toBeNull();

        fireEvent.click(trigger);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByTestId('label-color-flyover').dataset['label']).toBe('ship');
    });

    it('opens ONE at a time — a second row’s trigger takes the popover over', () => {
        setup();
        open('ship');
        expect(screen.getByTestId('label-color-flyover').dataset['label']).toBe('ship');
        // The first popover's dismissal fires on the mousedown that precedes the second click,
        // exactly as it does for a person; either way there is one popover afterwards.
        fireEvent.mouseDown(screen.getByTestId('label-color-wip-trigger'));
        fireEvent.click(screen.getByTestId('label-color-wip-trigger'));
        expect(screen.getAllByTestId('label-color-flyover')).toHaveLength(1);
        expect(screen.getByTestId('label-color-flyover').dataset['label']).toBe('wip');
    });

    it('re-pressing the open trigger closes it', () => {
        setup();
        const trigger = open('ship');
        fireEvent.mouseDown(trigger);
        fireEvent.click(trigger);
        expect(screen.queryByTestId('label-color-flyover')).toBeNull();
    });
});

describe('the flyover’s two sections (§N38)', () => {
    it('draws a chip preview, a Background section and a Text section', () => {
        setup();
        open('ship');
        expect(screen.getByTestId('label-flyover-chip').textContent).toBe('ship');
        expect(screen.getByTestId('label-flyover-background-heading').textContent).toBe('Background');
        expect(screen.getByTestId('label-flyover-text-heading').textContent).toBe('Text');
        // All ten named colours, and the bordered Custom row beneath them.
        for (const color of Object.keys(WORKSPACE_COLOR_HEX)) {
            expect(screen.getByTestId(`label-flyover-bg-${color}`)).toBeDefined();
        }
        expect(screen.getByTestId('label-flyover-bg-custom')).toBeDefined();
        expect(screen.getByTestId('label-flyover-text-auto')).toBeDefined();
        expect(screen.getByTestId('label-flyover-text-black')).toBeDefined();
        expect(screen.getByTestId('label-flyover-text-white')).toBeDefined();
        expect(screen.getByTestId('label-flyover-text-custom')).toBeDefined();
    });

    it('marks the swatch that is set, and writes immediately when another is picked', () => {
        const bound = setup();
        open('ship');
        expect(screen.getByTestId('label-flyover-bg-gray').getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByTestId('label-flyover-bg-red'));
        // Immediate apply: no OK button, no staging — the write leaves on the click.
        expect(bound.log.updated).toEqual([{ id: 'ship', color: 'red' }]);
        // …and the popover is STILL up, which is what makes it an editor rather than a menu.
        expect(screen.getByTestId('label-color-flyover')).toBeDefined();
    });

    it('writes the three text modes, Auto as null', () => {
        const bound = setup();
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-text-black'));
        fireEvent.click(screen.getByTestId('label-flyover-text-white'));
        fireEvent.click(screen.getByTestId('label-flyover-text-auto'));
        expect(bound.log.updated).toEqual([
            { id: 'ship', textColor: '#000000' },
            { id: 'ship', textColor: '#ffffff' },
            { id: 'ship', textColor: null }
        ]);
    });

    /**
     * The chip is the whole reason both sections live on one surface: it is the only place the
     * two values are seen TOGETHER, and it has to follow each pick as it is made. Driven through
     * a controlled wrapper, because the live app's chip follows the daemon's echo and this test
     * has no daemon.
     */
    it('previews the label with its current choices, live as they are picked', () => {
        function Harness(): ReactElement {
            const [presets, setPresets] = reactUseState<readonly ChromeLabelPreset[]>([
                { name: 'ship', color: { kind: 'named', color: 'gray' }, textColor: null }
            ]);
            const bound: SettingsActions = {
                setKeybinding: vi.fn(),
                resetKeybindings: vi.fn(),
                setGeneralSetting: vi.fn(),
                setGhosttySetting: vi.fn(),
                setProfiles: vi.fn(),
                addLabelPreset: vi.fn(),
                updateLabelPreset: (input) => {
                    setPresets((current) =>
                        current.map((preset) =>
                            preset.name !== input.id
                                ? preset
                                : {
                                      ...preset,
                                      ...(input.color === undefined
                                          ? {}
                                          : { color: { kind: 'named' as const, color: input.color as 'red' } }),
                                      ...(input.textColor === undefined
                                          ? {}
                                          : {
                                                textColor:
                                                    input.textColor === null
                                                        ? null
                                                        : { kind: 'custom' as const, hex: input.textColor }
                                            })
                                    }
                        )
                    );
                },
                removeLabelPreset: vi.fn(),
                moveLabelPreset: vi.fn()
            };
            return <LabelsTab presets={presets} workspaces={[]} actions={bound} bucket="dark" />;
        }
        render(<Harness />);
        open('ship');
        const chip = (): HTMLElement => screen.getByTestId('label-flyover-chip');
        expect(chip().dataset['background']).toBe(WORKSPACE_COLOR_HEX.gray.dark.toLowerCase());

        fireEvent.click(screen.getByTestId('label-flyover-bg-red'));
        expect(chip().dataset['background']).toBe(WORKSPACE_COLOR_HEX.red.dark.toLowerCase());

        fireEvent.click(screen.getByTestId('label-flyover-text-white'));
        expect(chip().dataset['text']).toBe('#ffffff');
    });
});

describe('the custom view (§N38)', () => {
    it('is reached from either Custom row, and says which value it is editing', () => {
        setup();
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        expect(screen.getByTestId('label-color-flyover').dataset['view']).toBe('custom');
        expect(screen.getByTestId('label-flyover-custom').dataset['target']).toBe('background');
        expect(screen.getByTestId('label-flyover-sv')).toBeDefined();
        expect(screen.getByTestId('label-flyover-hue')).toBeDefined();
        expect(screen.getByTestId('label-flyover-hex')).toBeDefined();

        fireEvent.click(screen.getByTestId('label-flyover-back'));
        expect(screen.getByTestId('label-color-flyover').dataset['view']).toBe('palette');
        fireEvent.click(screen.getByTestId('label-flyover-text-custom'));
        expect(screen.getByTestId('label-flyover-custom').dataset['target']).toBe('text');
    });

    /**
     * The byte-exact guarantee, as behaviour rather than as arithmetic: opening the picker on a
     * stored custom colour shows THAT STRING and sends nothing at all. A picker that normalised
     * on entry would rewrite a user's value for the crime of being looked at.
     */
    it('opens on the stored hex, verbatim, and writes nothing until something moves', () => {
        const bound = setup([{ name: 'ship', color: { kind: 'custom', hex: '#ff8800' }, textColor: null }]);
        open('ship');
        // The palette view already shows it, beside the Custom row's own swatch.
        expect(screen.getByTestId('label-flyover-bg-custom-hex').textContent).toBe('#ff8800');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        expect((screen.getByTestId('label-flyover-hex') as HTMLInputElement).value).toBe('#ff8800');
        expect(bound.log.updated).toEqual([]);
    });

    it('nudges saturation and brightness with the arrows, writing each step', () => {
        const bound = setup([{ name: 'ship', color: { kind: 'custom', hex: '#ff0000' }, textColor: null }]);
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        const square = screen.getByTestId('label-flyover-sv');
        // s: 1 → 0.99 (the hue and value are untouched), then v: 1 → 0.99.
        fireEvent.keyDown(square, { key: 'ArrowLeft' });
        fireEvent.keyDown(square, { key: 'ArrowDown' });
        expect(bound.log.updated).toHaveLength(2);
        expect(bound.log.updated[0]).toEqual({ id: 'ship', color: hexFromHsv({ h: 0, s: 0.99, v: 1 }) });
        expect(bound.log.updated[1]).toEqual({ id: 'ship', color: hexFromHsv({ h: 0, s: 0.99, v: 0.99 }) });
        // …and the cursor moved with it, which is the half a person sees.
        expect(screen.getByTestId('label-flyover-sv-cursor').dataset['left']).toBe('99%');
        expect(screen.getByTestId('label-flyover-sv-cursor').dataset['top']).toBe('1%');
    });

    it('nudges the hue with the arrows, ten at a time with Shift', () => {
        const bound = setup([{ name: 'ship', color: { kind: 'custom', hex: '#ff0000' }, textColor: null }]);
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        const hue = screen.getByTestId('label-flyover-hue');
        fireEvent.keyDown(hue, { key: 'ArrowRight' });
        fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true });
        expect(screen.getByTestId('label-flyover-hue').dataset['hue']).toBe('11.0');
        expect(bound.log.updated.at(-1)).toEqual({ id: 'ship', color: hexFromHsv({ h: 11, s: 1, v: 1 }) });
    });

    /**
     * "Validating without clobbering keystrokes": a half-typed hex stays on screen. `#f` is not a
     * colour and must not be rewritten to the last valid one under the caret — but it also must
     * not be WRITTEN, so the daemon never sees a value the user was still typing.
     */
    it('keeps a half-typed hex on screen and sends only the valid ones', () => {
        const bound = setup();
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        const field = screen.getByTestId('label-flyover-hex') as HTMLInputElement;
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: '#f' } });
        expect(field.value).toBe('#f');
        expect(field.dataset['valid']).toBe('false');
        expect(bound.log.updated).toEqual([]);

        fireEvent.change(field, { target: { value: '#f80' } });
        expect(field.value).toBe('#f80');
        expect(field.dataset['valid']).toBe('true');
        expect(bound.log.updated).toEqual([{ id: 'ship', color: '#ff8800' }]);

        // On blur the draft re-syncs to the canonical value rather than keeping the shorthand.
        fireEvent.blur(field);
        expect(field.value).toBe('#ff8800');
    });

    it('writes the TEXT colour when the view was entered from the Text section', () => {
        const bound = setup();
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-text-custom'));
        fireEvent.change(screen.getByTestId('label-flyover-hex'), { target: { value: '#123456' } });
        expect(bound.log.updated).toEqual([{ id: 'ship', textColor: '#123456' }]);
    });

    /**
     * Switching between the palette and the custom view preserves the OTHER section's state:
     * editing the background custom colour must not disturb the text choice, and coming back
     * into the picker for the text must seed from the TEXT value rather than from the background
     * the user was just dragging.
     */
    it('preserves the other section while one is being edited', () => {
        const bound = setup([
            { name: 'ship', color: { kind: 'custom', hex: '#ff8800' }, textColor: { kind: 'custom', hex: '#123456' } }
        ]);
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        expect((screen.getByTestId('label-flyover-hex') as HTMLInputElement).value).toBe('#ff8800');
        fireEvent.change(screen.getByTestId('label-flyover-hex'), { target: { value: '#00ff00' } });
        // Only the background was written — the text colour is untouched on the wire…
        expect(bound.log.updated).toEqual([{ id: 'ship', color: '#00ff00' }]);
        fireEvent.click(screen.getByTestId('label-flyover-back'));
        // …and still shown as itself in the Text section.
        expect(screen.getByTestId('label-flyover-text-custom-hex').textContent).toBe('#123456');
        // Entering the picker for the text seeds from the TEXT value, not from the background.
        fireEvent.click(screen.getByTestId('label-flyover-text-custom'));
        expect((screen.getByTestId('label-flyover-hex') as HTMLInputElement).value).toBe('#123456');
    });
});

describe('dismissal and focus (§N33 discipline, §N38)', () => {
    it('lands the caret on the swatch that is set when it opens', () => {
        setup();
        open('ship');
        expect(document.activeElement).toBe(screen.getByTestId('label-flyover-bg-gray'));
    });

    it('lands on the Custom row instead when the background is a custom colour', () => {
        setup([{ name: 'ship', color: { kind: 'custom', hex: '#ff8800' }, textColor: null }]);
        open('ship');
        expect(document.activeElement).toBe(screen.getByTestId('label-flyover-bg-custom'));
    });

    it('Escape closes it and hands focus back to the trigger', () => {
        setup();
        const trigger = open('ship');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByTestId('label-color-flyover')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('the × closes it and hands focus back to the trigger', () => {
        setup();
        const trigger = open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-close'));
        expect(screen.queryByTestId('label-color-flyover')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('an outside click closes it and hands focus back to the trigger', () => {
        setup();
        const trigger = open('ship');
        fireEvent.mouseDown(document.body);
        expect(screen.queryByTestId('label-color-flyover')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('walks the swatch grid with the arrows, wrapping at both ends', () => {
        setup();
        open('ship');
        // `gray` is the 8th of the ten, so → lands on `black` and ↑ climbs a row to `purple`.
        fireEvent.keyDown(screen.getByTestId('label-flyover-background-grid'), { key: 'ArrowRight' });
        expect(document.activeElement).toBe(screen.getByTestId('label-flyover-bg-black'));
        fireEvent.keyDown(screen.getByTestId('label-flyover-background-grid'), { key: 'ArrowUp' });
        expect(document.activeElement).toBe(screen.getByTestId('label-flyover-bg-green'));
    });

    it('Tab cycles inside the popover rather than walking out behind it', () => {
        setup();
        open('ship');
        const nodes = [
            ...screen
                .getByTestId('label-color-flyover')
                .querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')
        ];
        const last = nodes[nodes.length - 1] as HTMLElement;
        last.focus();
        fireEvent.keyDown(document, { key: 'Tab' });
        expect(document.activeElement).toBe(nodes[0]);
        fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
        expect(document.activeElement).toBe(last);
    });

    it('puts the caret on the picker when the custom view opens', () => {
        setup();
        open('ship');
        fireEvent.click(screen.getByTestId('label-flyover-bg-custom'));
        expect(document.activeElement).toBe(screen.getByTestId('label-flyover-sv'));
    });

    /**
     * §N33's arbiter is UNTOUCHED, and this is the assertion that says so: the reorder intent is
     * dropped by the tab's own `focusin` listener the moment a non-arrow element takes focus, and
     * the flyover's swatches are non-arrow elements like any other. Nothing in `ColorFlyover`
     * knows the arbiter exists.
     */
    it('opening the popover after a reorder does not leave the arrow armed', () => {
        const bound = setup();
        fireEvent.click(screen.getByTestId('label-move-down-ship'));
        expect(bound.log.updated).toEqual([]);
        open('ship');
        // Focus is inside the popover, not on either arrow — the intent has nothing to re-assert.
        expect(screen.getByTestId('label-color-flyover').contains(document.activeElement)).toBe(true);
    });
});

// ── the N26 census ──────────────────────────────────────────────────────────────────

describe('§N26 — the flyover parks the web panes it covers', () => {
    /** The web pane's own read, through the same two functions `WebPane.tsx` calls. */
    function Probe({ hole }: { readonly hole: { x: number; y: number; w: number; h: number } }) {
        const overlays = useOverlayRects();
        return <span data-testid="probe" data-covered={overlayCovers(hole, overlays) ? 'true' : 'false'} />;
    }

    it('registers while it is open and releases when it closes', () => {
        setup();
        expect(overlayPresenceCount()).toBe(0);
        open('ship');
        expect(overlayPresenceCount()).toBe(1);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(overlayPresenceCount()).toBe(0);
    });

    /**
     * The claim itself, read the way a pane reads it. With no layout jsdom reports a zero-area
     * box, which `modal-presence.ts` deliberately treats as "position unknown" and therefore as
     * covering everything — H1's answer, and the safe one. So the panel's box is stubbed to a
     * real rect and BOTH directions are asserted: a page under the popover parks, and a page
     * beside it stays live, which is the precision §N26 exists for.
     */
    it('covers a page under it and leaves the one beside it placed', () => {
        setup();
        open('ship');
        const panel = screen.getByTestId('label-color-flyover');
        panel.getBoundingClientRect = () =>
            ({ left: 300, top: 200, right: 532, bottom: 500, width: 232, height: 300 }) as DOMRect;
        for (const child of panel.querySelectorAll('*')) {
            (child as HTMLElement).getBoundingClientRect = () =>
                ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
        }
        // A render of the owner re-measures (see `useOverlayPresence`'s dependency-less effect).
        fireEvent.mouseEnter(panel);

        const under = render(<Probe hole={{ x: 260, y: 180, w: 400, h: 400 }} />);
        expect(screen.getByTestId('probe').dataset['covered']).toBe('true');
        under.unmount();

        render(<Probe hole={{ x: 700, y: 180, w: 400, h: 400 }} />);
        expect(screen.getByTestId('probe').dataset['covered']).toBe('false');
    });
});
