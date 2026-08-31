import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KEYBINDINGS,
    actionForTrigger,
    applyKeybindOverrides,
    canonicalKeyBindingsForPlatform,
    parseKeybindValue,
    removeAllBindings,
    resolveKeyBindings,
    setBinding,
    triggersForAction
} from './bindings.js';
import { parseKeybindOverrides } from './keybinds.js';
import { keyTriggerConfigString, parseKeyTrigger } from './keys.js';
import { MENU_BAR_ACTIONS, KELPI_ACTIONS } from './actions.js';

const trigger = (config: string) => {
    const parsed = parseKeyTrigger(config);
    if (parsed === null) throw new Error(`unparseable trigger: ${config}`);
    return parsed;
};

describe('the action table', () => {
    it('has the 51 bindable actions and the 16 menu-bar ones', () => {
        expect(KELPI_ACTIONS).toHaveLength(51);
        expect(new Set(KELPI_ACTIONS).size).toBe(51);
        expect(MENU_BAR_ACTIONS.size).toBe(16);
    });
});

describe('the default map', () => {
    it('ships 40 triggers', () => {
        expect(DEFAULT_KEYBINDINGS.size).toBe(40);
    });

    it('binds the documented defaults', () => {
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+d'))).toBe('split_right');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('shift+super+d'))).toBe('split_down');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('escape'))).toBe('close_search');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+='))).toBe(
            'increase_markdown_font_size'
        );
    });

    it('leaves the 13 unbound actions unbound', () => {
        for (const action of ['open_diff', 'toggle_sync_input', 'web_zoom_reset'] as const) {
            expect(triggersForAction(DEFAULT_KEYBINDINGS, action)).toEqual([]);
        }
    });

    it('gives the focus actions two triggers each, sorted by config string', () => {
        expect(
            triggersForAction(DEFAULT_KEYBINDINGS, 'focus_next_pane').map(keyTriggerConfigString)
        ).toEqual(['alt+super+right', 'super+]']);
        expect(
            triggersForAction(DEFAULT_KEYBINDINGS, 'focus_previous_pane').map(keyTriggerConfigString)
        ).toEqual(['alt+super+left', 'super+[']);
    });
});

describe('applying overrides', () => {
    it('unbinds a default and adds a new trigger', () => {
        const map = applyKeybindOverrides(
            DEFAULT_KEYBINDINGS,
            parseKeybindOverrides('keybind = super+e=unbind\nkeybind = ctrl+alt+n=create_scratchpad')
        );
        expect(actionForTrigger(map, trigger('super+e'))).toBeNull();
        expect(actionForTrigger(map, trigger('ctrl+alt+n'))).toBe('create_scratchpad');
        expect(actionForTrigger(map, trigger('shift+super+n'))).toBe('create_scratchpad');
    });

    it('lets a later line win for the same trigger', () => {
        const map = applyKeybindOverrides(
            DEFAULT_KEYBINDINGS,
            parseKeybindOverrides('keybind = super+d=toggle_zoom\nkeybind = super+d=toggle_search')
        );
        expect(actionForTrigger(map, trigger('super+d'))).toBe('toggle_search');
    });

    it('steals a trigger from the action that held it', () => {
        const map = setBinding(DEFAULT_KEYBINDINGS, trigger('super+d'), 'toggle_zoom');
        expect(triggersForAction(map, 'split_right')).toEqual([]);
        expect(triggersForAction(map, 'toggle_zoom').map(keyTriggerConfigString)).toEqual([
            'shift+super+return',
            'super+d'
        ]);
    });

    it('removeAllBindings drops every trigger of an action', () => {
        const map = removeAllBindings(DEFAULT_KEYBINDINGS, 'focus_next_pane');
        expect(triggersForAction(map, 'focus_next_pane')).toEqual([]);
        expect(map.size).toBe(DEFAULT_KEYBINDINGS.size - 2);
    });

    it('resolveKeyBindings returns the untouched defaults when there are no overrides', () => {
        expect(resolveKeyBindings([])).toBe(DEFAULT_KEYBINDINGS);
        expect(resolveKeyBindings(parseKeybindOverrides('# nothing here'))).toBe(DEFAULT_KEYBINDINGS);
    });

    it('does not mutate the defaults', () => {
        applyKeybindOverrides(DEFAULT_KEYBINDINGS, parseKeybindOverrides('keybind = super+d=unbind'));
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+d'))).toBe('split_right');
    });
});

describe('parseKeybindValue', () => {
    it('accepts the unbind pseudo-action', () => {
        expect(parseKeybindValue('super+e=unbind')?.action).toBe('unbind');
    });

    it('rejects a value with no =', () => {
        expect(parseKeybindValue('super+e')).toBeNull();
    });
});

describe('canonicalKeyBindingsForPlatform (§3.5)', () => {
    it('macLike returns the very same map', () => {
        expect(canonicalKeyBindingsForPlatform(DEFAULT_KEYBINDINGS, true)).toBe(DEFAULT_KEYBINDINGS);
    });

    it('off-mac the super defaults re-key to ctrl and the ctrl defaults stay put', () => {
        const map = canonicalKeyBindingsForPlatform(DEFAULT_KEYBINDINGS, false);
        // super+d=split_right now answers on Ctrl+D…
        expect(actionForTrigger(map, parseKeyTrigger('ctrl+d')!)).toBe('split_right');
        expect(actionForTrigger(map, parseKeyTrigger('ctrl+shift+d')!)).toBe('split_down');
        // …the Super/Win key answers nothing…
        expect(actionForTrigger(map, parseKeyTrigger('super+d')!)).toBeNull();
        // …and the shipped ctrl bindings are untouched.
        expect(actionForTrigger(map, parseKeyTrigger('ctrl+shift+left')!)).toBe('move_pane_left');
        expect(map.size).toBe(DEFAULT_KEYBINDINGS.size);
    });

    it('a collision created by canonicalization resolves last-in-map-order (override beats default)', () => {
        const override = parseKeybindValue('ctrl+d=toggle_zoom');
        expect(override).not.toBeNull();
        const overridden = applyKeybindOverrides(DEFAULT_KEYBINDINGS, [override!]);
        const map = canonicalKeyBindingsForPlatform(overridden, false);
        // The user's explicit ctrl+d line was applied AFTER the defaults, so it wins over
        // the canonicalized super+d=split_right.
        expect(actionForTrigger(map, parseKeyTrigger('ctrl+d')!)).toBe('toggle_zoom');
        // 41 entries (40 defaults + the added ctrl+d) collapse by exactly the one collision.
        expect(map.size).toBe(DEFAULT_KEYBINDINGS.size);
    });
});
