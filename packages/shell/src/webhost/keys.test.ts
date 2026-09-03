/**
 * Which chords the host takes from an embedded page (`./keys.ts`).
 *
 * The set has to be exactly what Kelpi claims: the resolved binding map, plus the web-pane
 * priority layer and the two window-listener chords, minus bare ⌘[ / ⌘]. Too narrow and a
 * binding is unreachable the moment a user clicks the page - issue #33, where ⌘D never split
 * and ⌘P reached Chromium's print dialog. Too wide and Kelpi starts eating a page's own
 * shortcuts — ⌘K for a command palette, ⌘S for a save — which is a much worse failure, because
 * the page looks broken and nothing says why.
 *
 * So the negative cases carry as much weight here as the positive ones.
 */

import { DEFAULT_KEYBINDINGS, DEFAULT_KEYBIND_LINES } from '@kelpi/core/config';
import { describe, expect, it } from 'vitest';

import {
    chordCommand,
    claimedChords,
    claimedChordsForLines,
    forwardedChord,
    forwardedChordKeys,
    setForwardedKeybindLines,
    type ChordInput
} from './keys.js';

function input(code: string, overrides: Partial<ChordInput> = {}): ChordInput {
    return {
        type: 'keyDown',
        key: '',
        code,
        meta: true,
        shift: false,
        control: false,
        alt: false,
        ...overrides
    };
}

/** The shipped set, which is also what the module starts at before the daemon has said anything. */
const DEFAULTS = claimedChords(DEFAULT_KEYBINDINGS);

function takes(code: string, shift = false): boolean {
    return forwardedChord(input(code, { shift }), DEFAULTS) !== null;
}

describe('the derived set', () => {
    it('takes every pane binding that used to die on a focused page (issue #33)', () => {
        // ⌘D / ⇧⌘D split, ⌘W closes, ⌘P is the palette, ⇧⌘N is a scratchpad - the exact list
        // the issue reports as dead, plus the rest of the map's ⌘ chords.
        const claimed: readonly (readonly [string, boolean])[] = [
            ['KeyD', false], // split_right
            ['KeyD', true], // split_down
            ['KeyW', false], // close_pane
            ['KeyP', false], // command_palette
            ['KeyN', true], // create_scratchpad
            ['KeyN', false], // new_workspace
            ['KeyO', false], // open_file
            ['KeyO', true], // open_web_pane
            ['KeyI', false], // toggle_inspector
            ['KeyS', true], // toggle_sidebar
            ['KeyE', false], // toggle_markdown_edit
            ['KeyG', true], // new_group
            ['KeyR', true], // rename_workspace
            ['KeyT', true], // reopen_closed_pane
            ['Enter', true], // toggle_zoom
            ['Space', true], // cycle_layout
            ['Digit1', false], // switch_to_workspace_1
            ['Digit9', false] // switch_to_workspace_9
        ];
        for (const [code, shift] of claimed) {
            expect(takes(code, shift), `${shift ? 'shift+' : ''}${code}`).toBe(true);
        }
    });

    it('still takes every chord the web priority layer claims', () => {
        for (const code of ['KeyL', 'KeyR', 'KeyT', 'KeyW', 'ArrowLeft', 'ArrowRight', 'Minus', 'Digit0']) {
            expect(takes(code), code).toBe(true);
        }
        // ⌘= and ⌘⇧= both zoom in (⌘+ is a shifted `=` on a US layout), so both are taken.
        expect(takes('Equal')).toBe(true);
        expect(takes('Equal', true)).toBe(true);
    });

    it('still takes ⌘F for Kelpi’s find bar', () => {
        // Not a special case any more: `super+f=toggle_search` is an ordinary line in the map,
        // so a derived set gets it for free - and loses it if the user unbinds it, which is the
        // right answer rather than a carve-out.
        expect(takes('KeyF')).toBe(true);
        expect(claimedChordsForLines(['super+f=unbind']).has('KeyF')).toBe(false);
    });

    it('takes ⌘, and ⌘/ ⌘?, which open Settings and Help outside the binding map', () => {
        expect(takes('Comma')).toBe(true);
        expect(takes('Slash')).toBe(true);
        expect(takes('Slash', true)).toBe(true);
    });
});

describe('what stays with the page', () => {
    it('leaves the page every ⌘ chord Kelpi does not claim', () => {
        // ⌘C / ⌘A are the floor: a page whose copy and select-all stopped working would be a
        // far worse defect than the one this module fixes. ⌘K is the shape of a page's own
        // command palette, ⌘S a save, ⌘V/⌘X/⌘Z the rest of the editing set.
        for (const code of ['KeyC', 'KeyA', 'KeyK', 'KeyS', 'KeyV', 'KeyX', 'KeyZ', 'KeyJ', 'KeyB']) {
            expect(takes(code), code).toBe(false);
        }
        // ⇧⌘F is not `toggle_search` (that is bare ⌘F), so it stays with the page too - the set
        // is per (key, shift), not per key.
        expect(takes('KeyF', true)).toBe(false);
    });

    it('leaves bare ⌘[ / ⌘] to the page (they are back/forward there, SET-189)', () => {
        // Both ARE in the binding map (focus_previous_pane / focus_next_pane), so this is the
        // one place the derived set is deliberately narrower than the map.
        expect(takes('BracketLeft')).toBe(false);
        expect(takes('BracketRight')).toBe(false);
        expect(takes('BracketLeft', true)).toBe(true);
        expect(takes('BracketRight', true)).toBe(true);
    });

    it('never takes a bare key, however the map binds it', () => {
        // `escape=close_search` is a real default. Forwarding it would steal Escape from every
        // page in the app - a dialog that will not close is not a fix.
        expect(DEFAULTS.has('Escape')).toBe(false);
        expect(forwardedChord(input('Escape', { meta: false }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('Escape'), DEFAULTS)).toBeNull();
    });

    it('ignores anything without ⌘, and anything with ⌃ or ⌥', () => {
        expect(forwardedChord(input('KeyF', { meta: false }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('KeyF', { control: true }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('KeyF', { alt: true }), DEFAULTS)).toBeNull();
        // The two default chord families the relay cannot encode: `move_pane_*` is
        // ctrl+shift+arrow and `focus_*_pane` / workspace nav are alt+super+arrow. They are
        // refused rather than mistranslated - `web-chord:ArrowLeft:shift` would replay ⌘⇧← and
        // navigate the page back. See the module header.
        expect(forwardedChord(input('ArrowLeft', { meta: false, control: true, shift: true }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('ArrowRight', { alt: true }), DEFAULTS)).toBeNull();
    });

    it('forwards key-downs only — a key-up would fire the binding twice', () => {
        expect(forwardedChord(input('KeyF', { type: 'keyUp' }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('KeyF', { type: 'char' }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('KeyF', { type: 'rawKeyDown' }), DEFAULTS)).not.toBeNull();
    });
});

describe('the set follows the config file', () => {
    it('moves a rebound action with its new trigger, and drops the old one', () => {
        const rebound = claimedChordsForLines(['super+d=unbind', 'shift+super+j=split_right']);
        expect(rebound.has('KeyD')).toBe(false);
        expect(rebound.has('shift+KeyJ')).toBe(true);
        // ⇧⌘D is a separate line (`split_down`) and is untouched by rebinding `split_right`.
        expect(rebound.has('shift+KeyD')).toBe(true);
    });

    it('hands a chord back to the page when the user unbinds the action', () => {
        expect(claimedChordsForLines(['super+p=unbind']).has('KeyP')).toBe(false);
    });

    it('keeps the carve-out even when the user rebinds the bracket keys', () => {
        const rebound = claimedChordsForLines(['super+[=command_palette', 'super+]=toggle_zoom']);
        expect(rebound.has('BracketLeft')).toBe(false);
        expect(rebound.has('BracketRight')).toBe(false);
    });

    it('drops an unparseable line rather than the whole map', () => {
        // `KeybindingService.loadFromDisk`: zero valid lines is the untouched defaults, so one
        // typo cannot cost the user every other chord.
        expect(claimedChordsForLines(['not a keybind at all'])).toEqual(DEFAULTS);
        expect(claimedChordsForLines([])).toEqual(DEFAULTS);
    });

    it('is exactly this, for the shipped config (the whole claim, reviewable at a glance)', () => {
        // A snapshot rather than a spot check, because the failure this module can cause is a
        // chord SILENTLY added: nothing in the app says "Kelpi ate your ⌘K". Any change to what
        // a page gives up has to be typed out here, next to the reason.
        expect([...DEFAULTS].sort()).toEqual([
            'ArrowLeft', // web priority: back
            'ArrowRight', // web priority: forward
            'Comma', // Settings (window listener, not a KelpiAction)
            'Digit0', // reset_markdown_font_size / web priority: zoom reset
            'Digit1',
            'Digit2',
            'Digit3',
            'Digit4',
            'Digit5',
            'Digit6',
            'Digit7',
            'Digit8',
            'Digit9', // switch_to_workspace_1…9
            'Equal', // increase_markdown_font_size / web priority: zoom in
            'KeyD', // split_right
            'KeyE', // toggle_markdown_edit
            'KeyF', // toggle_search (Kelpi's find bar over a web pane)
            'KeyI', // toggle_inspector
            'KeyL', // web priority: focus the URL bar
            'KeyN', // new_workspace
            'KeyO', // open_file
            'KeyP', // command_palette
            'KeyR', // web priority: reload
            'KeyT', // web priority: new tab
            'KeyW', // close_pane / web priority: close tab
            'Minus', // decrease_markdown_font_size / web priority: zoom out
            'Slash', // Help (window listener)
            'shift+BracketLeft', // web priority: previous tab
            'shift+BracketRight', // web priority: next tab
            'shift+Enter', // toggle_zoom
            'shift+Equal', // web priority: zoom in (⌘+ is a shifted `=`)
            'shift+KeyD', // split_down
            'shift+KeyG', // new_group
            'shift+KeyN', // create_scratchpad
            'shift+KeyO', // open_web_pane
            'shift+KeyR', // rename_workspace
            'shift+KeyS', // toggle_sidebar (bare ⌘S is the page's save, and stays there)
            'shift+KeyT', // reopen_closed_pane
            'shift+Slash', // Help, on the key the user sees (⌘?)
            'shift+Space' // cycle_layout
        ]);
    });
});

describe('the live set', () => {
    it('starts at the shipped defaults, so a view created before the handshake still works', () => {
        expect(forwardedChordKeys()).toEqual(DEFAULTS);
        expect(forwardedChord(input('KeyD'))).toEqual({ code: 'KeyD', shift: false });
    });

    it('is replaced by the daemon’s lines, and restored by an empty one', () => {
        setForwardedKeybindLines(['super+d=unbind']);
        expect(forwardedChord(input('KeyD'))).toBeNull();
        setForwardedKeybindLines([]);
        expect(forwardedChord(input('KeyD'))).toEqual({ code: 'KeyD', shift: false });
    });
});

describe('the relay command', () => {
    it('encodes what the client parses back', () => {
        expect(chordCommand({ code: 'KeyF', shift: false })).toBe('web-chord:KeyF');
        expect(chordCommand({ code: 'BracketRight', shift: true })).toBe('web-chord:BracketRight:shift');
    });

    it('carries shift through for ⌘⇧= (which is ⌘+, zoom in)', () => {
        expect(forwardedChord(input('Equal', { shift: true }), DEFAULTS)).toEqual({
            code: 'Equal',
            shift: true
        });
    });
});
