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
    chordLabel,
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

/** A non-⌘ chord, the kind that had no encoding at all before. */
function takesWith(code: string, overrides: Partial<ChordInput>): boolean {
    return forwardedChord(input(code, overrides), DEFAULTS) !== null;
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
        expect(claimedChordsForLines(['super+f=unbind']).has('meta+KeyF')).toBe(false);
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

    it('takes bare ⌘[ / ⌘] as focus prev/next pane (issue #229, NOT page back/forward)', () => {
        // The old carve-out left these to the page "because inside a page they are
        // back/forward". config-keybindings.md 7.3 says the opposite in as many words - "back/
        // forward are ⌘←/⌘→, NOT ⌘[/⌘], so ⌘[/⌘] keep meaning focus-previous/next-pane even
        // inside a web pane" - and nothing implements ⌘[ as back inside a WebContentsView
        // anyway, so the carve-out dropped the keys rather than handing them over.
        expect(takes('BracketLeft')).toBe(true);
        expect(takes('BracketRight')).toBe(true);
        // ⌘⇧[ / ⌘⇧] remain the priority layer's tab cycling, unchanged.
        expect(takes('BracketLeft', true)).toBe(true);
        expect(takes('BracketRight', true)).toBe(true);
    });

    it('never takes a bare key, however the map binds it', () => {
        // `escape=close_search` is a real default. Forwarding it would steal Escape from every
        // page in the app - a dialog that will not close is not a fix.
        expect(DEFAULTS.has('Escape')).toBe(false);
        expect(DEFAULTS.has('meta+Escape')).toBe(false);
        expect(forwardedChord(input('Escape', { meta: false }), DEFAULTS)).toBeNull();
        expect(forwardedChord(input('Escape'), DEFAULTS)).toBeNull();
    });

    it('takes ⌃ and ⌥ chords now that the wire can spell them (issue #33)', () => {
        // `move_pane_*` is ctrl+shift+arrow and holds no ⌘ at all; the ⌥⌘ arrows are
        // focus_*_pane and workspace nav. Both families were refused while the relay could only
        // say ⌘, because the alternative was mistranslating them.
        expect(takesWith('ArrowLeft', { meta: false, control: true, shift: true })).toBe(true);
        expect(takesWith('ArrowRight', { meta: false, control: true, shift: true })).toBe(true);
        expect(takesWith('ArrowUp', { meta: false, control: true, shift: true })).toBe(true);
        expect(takesWith('ArrowDown', { meta: false, control: true, shift: true })).toBe(true);
        expect(takesWith('ArrowLeft', { alt: true })).toBe(true);
        expect(takesWith('ArrowRight', { alt: true })).toBe(true);
        expect(takesWith('ArrowUp', { alt: true })).toBe(true);
        expect(takesWith('ArrowDown', { alt: true })).toBe(true);
    });

    it('still refuses a chord whose exact modifier set nothing claims', () => {
        // ⌃⇧← is `move_pane_left`; ⌃← alone is not bound, and on macOS it is Mission Control's.
        expect(takesWith('ArrowLeft', { meta: false, control: true })).toBe(false);
        // ⌥← without ⌘ is "previous word" in any text field on the page.
        expect(takesWith('ArrowLeft', { meta: false, alt: true })).toBe(false);
        // Shift alone is how a page's user types a capital, never a claim.
        expect(takesWith('KeyD', { meta: false, shift: true })).toBe(false);
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
        expect(rebound.has('meta+KeyD')).toBe(false);
        expect(rebound.has('shift+meta+KeyJ')).toBe(true);
        // ⇧⌘D is a separate line (`split_down`) and is untouched by rebinding `split_right`.
        expect(rebound.has('shift+meta+KeyD')).toBe(true);
    });

    it('hands a chord back to the page when the user unbinds the action', () => {
        expect(claimedChordsForLines(['super+p=unbind']).has('meta+KeyP')).toBe(false);
    });

    it('lets the bracket keys move with the map like any other binding', () => {
        const rebound = claimedChordsForLines(['super+[=unbind', 'super+]=unbind']);
        expect(rebound.has('meta+BracketLeft')).toBe(false);
        expect(rebound.has('meta+BracketRight')).toBe(false);
        // Tab cycling is the priority layer, not the map, so unbinding cannot touch it.
        expect(rebound.has('shift+meta+BracketLeft')).toBe(true);
        expect(rebound.has('shift+meta+BracketRight')).toBe(true);
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
            'alt+meta+ArrowDown', // next_workspace
            'alt+meta+ArrowLeft', // focus_previous_pane
            'alt+meta+ArrowRight', // focus_next_pane
            'alt+meta+ArrowUp', // previous_workspace
            'ctrl+shift+ArrowDown', // move_pane_down
            'ctrl+shift+ArrowLeft', // move_pane_left
            'ctrl+shift+ArrowRight', // move_pane_right
            'ctrl+shift+ArrowUp', // move_pane_up
            'meta+ArrowLeft', // web priority: back
            'meta+ArrowRight', // web priority: forward
            'meta+BracketLeft', // focus_previous_pane (issue #229: NOT page back)
            'meta+BracketRight', // focus_next_pane (issue #229: NOT page forward)
            'meta+Comma', // Settings (window listener, not a KelpiAction)
            'meta+Digit0', // reset_markdown_font_size / web priority: zoom reset
            'meta+Digit1',
            'meta+Digit2',
            'meta+Digit3',
            'meta+Digit4',
            'meta+Digit5',
            'meta+Digit6',
            'meta+Digit7',
            'meta+Digit8',
            'meta+Digit9', // switch_to_workspace_1…9
            'meta+Equal', // increase_markdown_font_size / web priority: zoom in
            'meta+KeyD', // split_right
            'meta+KeyE', // toggle_markdown_edit
            'meta+KeyF', // toggle_search (Kelpi's find bar over a web pane)
            'meta+KeyI', // toggle_inspector
            'meta+KeyL', // web priority: focus the URL bar
            'meta+KeyN', // new_workspace
            'meta+KeyO', // open_file
            'meta+KeyP', // command_palette
            'meta+KeyR', // web priority: reload
            'meta+KeyT', // web priority: new tab
            'meta+KeyW', // close_pane / web priority: close tab
            'meta+Minus', // decrease_markdown_font_size / web priority: zoom out
            'meta+Slash', // Help (window listener)
            'shift+meta+BracketLeft', // web priority: previous tab
            'shift+meta+BracketRight', // web priority: next tab
            'shift+meta+Enter', // toggle_zoom
            'shift+meta+Equal', // web priority: zoom in (⌘+ is a shifted `=`)
            'shift+meta+KeyD', // split_down
            'shift+meta+KeyG', // new_group
            'shift+meta+KeyN', // create_scratchpad
            'shift+meta+KeyO', // open_web_pane
            'shift+meta+KeyR', // rename_workspace
            'shift+meta+KeyS', // toggle_sidebar (bare ⌘S is the page's save, and stays there)
            'shift+meta+KeyT', // reopen_closed_pane
            'shift+meta+Slash', // Help, on the key the user sees (⌘?)
            'shift+meta+Space' // cycle_layout
        ]);
    });
});

describe('the live set', () => {
    it('starts at the shipped defaults, so a view created before the handshake still works', () => {
        expect(forwardedChordKeys()).toEqual(DEFAULTS);
        expect(forwardedChord(input('KeyD'))).toEqual({ code: 'KeyD', meta: true, ctrl: false, alt: false, shift: false });
    });

    it('is replaced by the daemon’s lines, and restored by an empty one', () => {
        setForwardedKeybindLines(['super+d=unbind']);
        expect(forwardedChord(input('KeyD'))).toBeNull();
        setForwardedKeybindLines([]);
        expect(forwardedChord(input('KeyD'))).toEqual({ code: 'KeyD', meta: true, ctrl: false, alt: false, shift: false });
    });
});

describe('the relay command', () => {
    it('keeps the legacy ⌘-implied spelling, which a hand-written constant depends on', () => {
        // `CLOSE_PANE_CHORD_COMMAND` in `client/src/app/shell-close.ts` is literally
        // 'web-chord:KeyW'. Byte-identical output for every ⌘-only chord keeps it parsing.
        expect(chordCommand({ code: 'KeyF', meta: true, ctrl: false, alt: false, shift: false })).toBe(
            'web-chord:KeyF'
        );
        expect(chordCommand({ code: 'BracketRight', meta: true, ctrl: false, alt: false, shift: true })).toBe(
            'web-chord:BracketRight:shift'
        );
    });

    it('spells every modifier out once ⌃ or ⌥ is involved', () => {
        expect(chordCommand({ code: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: true })).toBe(
            'web-chord:ArrowLeft:ctrl:shift'
        );
        expect(chordCommand({ code: 'ArrowRight', meta: true, ctrl: false, alt: true, shift: false })).toBe(
            'web-chord:ArrowRight:meta:alt'
        );
    });

    it('always names meta in the explicit form, or ⌘⇧D and ⌃⇧D would encode alike', () => {
        const metaShift = chordCommand({ code: 'KeyD', meta: true, ctrl: true, alt: false, shift: true });
        const ctrlShift = chordCommand({ code: 'KeyD', meta: false, ctrl: true, alt: false, shift: true });
        expect(metaShift).toBe('web-chord:KeyD:meta:ctrl:shift');
        expect(ctrlShift).toBe('web-chord:KeyD:ctrl:shift');
        expect(metaShift).not.toBe(ctrlShift);
    });

    it('carries shift through for ⌘⇧= (which is ⌘+, zoom in)', () => {
        expect(forwardedChord(input('Equal', { shift: true }), DEFAULTS)).toEqual({
            code: 'Equal',
            meta: true,
            ctrl: false,
            alt: false,
            shift: true
        });
    });

    it('labels a chord the way the forwarding log prints it', () => {
        expect(chordLabel({ code: 'ArrowLeft', meta: false, ctrl: true, alt: false, shift: true })).toBe(
            '⌃⇧ArrowLeft'
        );
        expect(chordLabel({ code: 'KeyD', meta: true, ctrl: false, alt: false, shift: false })).toBe('⌘KeyD');
    });
});
