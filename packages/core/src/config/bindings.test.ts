import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KEYBINDINGS,
    actionForTrigger,
    applyKeybindOverrides,
    displayTriggerForAction,
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
    it('has the 59 bindable actions and the 16 menu-bar ones', () => {
        expect(KELPI_ACTIONS).toHaveLength(59);
        expect(new Set(KELPI_ACTIONS).size).toBe(59);
        // #175's three text-size actions are NOT among them, deliberately: the menu-bar set is
        // the one that still fires while a chrome text field has the caret.
        expect(MENU_BAR_ACTIONS.size).toBe(16);
        for (const action of ['increase_terminal_font_size', 'decrease_terminal_font_size', 'reset_terminal_font_size'] as const) {
            expect(MENU_BAR_ACTIONS.has(action)).toBe(false);
        }
    });
});

describe('the default map', () => {
    it('ships 46 triggers', () => {
        expect(DEFAULT_KEYBINDINGS.size).toBe(46);
    });

    /*
     * #175. ⌘= / ⌘- / ⌘0 are the TERMINAL text size now, and ⇧⌘= is the fourth trigger, because
     * ⌘+ on a US layout is a shifted `=`. The three markdown font-size actions keep their place
     * in the vocabulary and ship unbound; the preview's behaviour is unchanged because the
     * terminal handlers offer a focused preview its own size first (`App.tsx`).
     */
    it('spends the three text-size chords on the terminal, and reads ⌘+ as a shifted =', () => {
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+='))).toBe('increase_terminal_font_size');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('shift+super+='))).toBe('increase_terminal_font_size');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+-'))).toBe('decrease_terminal_font_size');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+0'))).toBe('reset_terminal_font_size');
        for (const action of ['increase_markdown_font_size', 'decrease_markdown_font_size', 'reset_markdown_font_size'] as const) {
            expect(triggersForAction(DEFAULT_KEYBINDINGS, action)).toEqual([]);
        }
    });

    // Rebindable like every other action: a `keybind` line moves them and `unbind` takes them
    // away, with no special case anywhere in the map.
    it('rebinds and unbinds a text-size action through ordinary keybind lines', () => {
        const map = applyKeybindOverrides(
            DEFAULT_KEYBINDINGS,
            parseKeybindOverrides(
                'keybind = super+==unbind\nkeybind = ctrl+alt+up=increase_terminal_font_size'
            )
        );
        expect(actionForTrigger(map, trigger('super+='))).toBeNull();
        expect(actionForTrigger(map, trigger('ctrl+alt+up'))).toBe('increase_terminal_font_size');
    });

    /**
     * The two spellings of ⌘+ go together, or the unbind is a lie.
     *
     * ⇧⌘= IS ⌘+ on a US layout. A user who unbinds ⌘=, or who binds it back to the markdown
     * preview's own font size to restore the pre-#175 behaviour, has said what that chord should
     * do - and without this would still have the shifted spelling resizing every terminal on the
     * daemon. Both directions, because either spelling may be the one they write.
     */
    describe('the two spellings of ⌘+ (#175)', () => {
        const overridden = (lines: string) =>
            applyKeybindOverrides(DEFAULT_KEYBINDINGS, parseKeybindOverrides(lines));

        it('takes the shifted twin away with an unbind of the unshifted spelling', () => {
            const map = overridden('keybind = super+==unbind');
            expect(actionForTrigger(map, trigger('super+='))).toBeNull();
            expect(actionForTrigger(map, trigger('shift+super+='))).toBeNull();
            expect(triggersForAction(map, 'increase_terminal_font_size')).toEqual([]);
        });

        it('and the other way round', () => {
            const map = overridden('keybind = shift+super+==unbind');
            expect(actionForTrigger(map, trigger('shift+super+='))).toBeNull();
            expect(actionForTrigger(map, trigger('super+='))).toBeNull();
        });

        it('leaves ⌘+ meaning ONE thing when ⌘= is bound back to the markdown preview', () => {
            const map = overridden('keybind = super+==increase_markdown_font_size');
            expect(actionForTrigger(map, trigger('super+='))).toBe('increase_markdown_font_size');
            expect(actionForTrigger(map, trigger('shift+super+='))).toBeNull();
        });

        it('keeps both when the user spelled both out, in either order', () => {
            const map = overridden(
                'keybind = super+==increase_markdown_font_size\nkeybind = shift+super+==toggle_zoom'
            );
            expect(actionForTrigger(map, trigger('super+='))).toBe('increase_markdown_font_size');
            expect(actionForTrigger(map, trigger('shift+super+='))).toBe('toggle_zoom');
        });

        /*
         * The rule is a pair of SPELLINGS, never a pair of shortcuts: `focus_next_pane` has ⌘]
         * and ⌥⌘→, which are two different chords a user chose between, and unbinding one must
         * leave the other exactly where it was.
         */
        it('does not touch an action whose two triggers are genuinely different shortcuts', () => {
            const map = overridden('keybind = super+]=unbind');
            expect(actionForTrigger(map, trigger('super+]'))).toBeNull();
            expect(actionForTrigger(map, trigger('alt+super+right'))).toBe('focus_next_pane');
        });

        // The hint names the spelling on the keycap, while the map still holds both.
        it('hints the unshifted spelling and leaves every other action’s hint alone', () => {
            expect(keyTriggerConfigString(displayTriggerForAction(DEFAULT_KEYBINDINGS, 'increase_terminal_font_size')!))
                .toBe('super+=');
            expect(keyTriggerConfigString(displayTriggerForAction(DEFAULT_KEYBINDINGS, 'focus_next_pane')!))
                .toBe('alt+super+right');
            expect(displayTriggerForAction(DEFAULT_KEYBINDINGS, 'open_diff')).toBeNull();
        });
    });

    // #82: Ghostty's macOS natural-text-editing set, matched exactly (Config.zig:7315-7334).
    it('binds the three line-editing chords by default', () => {
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+backspace'))).toBe('kill_line_backward');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+left'))).toBe('move_to_line_start');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+right'))).toBe('move_to_line_end');
    });

    // #81: ⌘C and ⌘V are Kelpi's own chords now, not the Edit menu role's alone.
    it('binds the clipboard chords by default', () => {
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+c'))).toBe('copy');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+v'))).toBe('paste');
    });

    it('binds the documented defaults', () => {
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+d'))).toBe('split_right');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('shift+super+d'))).toBe('split_down');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('escape'))).toBe('close_search');
        expect(actionForTrigger(DEFAULT_KEYBINDINGS, trigger('super+e'))).toBe(
            'toggle_markdown_edit'
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
