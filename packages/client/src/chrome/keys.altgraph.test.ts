/**
 * AltGr off macOS (config-keybindings.md section 3.5): Windows reports AltGr as ctrl+alt, and the
 * off-mac defaults for the tab chords are ctrl+alt, so a character typed with AltGr on a Czech or
 * German layout must never run one.
 */

import type { KelpiAction } from '@kelpi/core/config';
import { describe, expect, it } from 'vitest';

import { clientKeyBindings, createKeyDispatcher, typesAltGraphText, type KeyActionRegistry, type KeyEventLike } from './keys';

function event(code: string, key: string, options: { altGraph?: boolean; shift?: boolean } = {}): KeyEventLike {
    return {
        code,
        key,
        metaKey: false,
        ctrlKey: true,
        altKey: true,
        shiftKey: options.shift ?? false,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
        getModifierState: (name: string) => name === 'AltGraph' && options.altGraph === true
    };
}

function dispatcher(): { readonly dispatch: (event: KeyEventLike) => boolean; readonly fired: KelpiAction[] } {
    const fired: KelpiAction[] = [];
    const actions: KeyActionRegistry = {};
    for (const action of ['close_tab', 'go_to_tab_7', 'go_to_tab_8', 'previous_tab', 'new_tab'] as KelpiAction[]) {
        actions[action] = () => {
            fired.push(action);
            return true;
        };
    }
    return { dispatch: createKeyDispatcher({ bindings: clientKeyBindings([], false), actions, macLike: false }), fired };
}

describe('AltGr off macOS', () => {
    it('types Czech AltGr+W and German AltGr+8 rather than closing a tab or going to tab 8', () => {
        const d = dispatcher();
        expect(d.dispatch(event('KeyW', '|', { altGraph: true }))).toBe(false);
        expect(d.dispatch(event('Digit8', '[', { altGraph: true }))).toBe(false);
        expect(d.fired).toEqual([]);
    });

    it('reads a symbol typed by a letter or digit key as AltGr even without the modifier state', () => {
        expect(typesAltGraphText(event('Digit7', '{'), false)).toBe(true);
        expect(typesAltGraphText(event('KeyQ', '@'), false)).toBe(true);
    });

    it('still runs a real Ctrl+Alt chord, letter, digit or symbol key', () => {
        const d = dispatcher();
        expect(d.dispatch(event('KeyT', 't'))).toBe(true);
        expect(d.dispatch(event('Digit7', '7'))).toBe(true);
        // US Ctrl+Alt+[ types `[`, and it is the previous-tab chord.
        expect(d.dispatch(event('BracketLeft', '['))).toBe(true);
        expect(d.fired).toEqual(['new_tab', 'go_to_tab_7', 'previous_tab']);
    });

    it('never applies on macOS, where Option is alt and there is no AltGr', () => {
        expect(typesAltGraphText(event('KeyW', '|', { altGraph: true }), true)).toBe(false);
    });
});
