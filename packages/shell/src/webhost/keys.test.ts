/**
 * Which chords the host takes from an embedded page (`./keys.ts`).
 *
 * The set has to be exactly the web-pane priority layer plus ⌘F. Too narrow and the layer is
 * unreachable the moment a user clicks the page; too wide and Kelpi starts eating a page's own
 * shortcuts — ⌘K for a command palette, ⌘S for a save — which is a much worse failure, because
 * the page looks broken and nothing says why.
 */

import { describe, expect, it } from 'vitest';

import { chordCommand, forwardedChord, type ChordInput } from './keys.js';

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

describe('the forwarded set', () => {
    it('takes every chord the priority layer claims, plus ⌘F', () => {
        const taken = ['KeyF', 'KeyL', 'KeyR', 'KeyT', 'KeyW', 'ArrowLeft', 'ArrowRight', 'Equal', 'Minus', 'Digit0'];
        for (const code of taken) {
            expect(forwardedChord(input(code)), code).not.toBeNull();
        }
        expect(forwardedChord(input('BracketLeft', { shift: true }))).toEqual({
            code: 'BracketLeft',
            shift: true
        });
        expect(forwardedChord(input('BracketRight', { shift: true }))).toEqual({
            code: 'BracketRight',
            shift: true
        });
    });

    it('leaves the page its own ⌘ shortcuts', () => {
        for (const code of ['KeyK', 'KeyS', 'KeyC', 'KeyA', 'KeyP', 'KeyD', 'Digit1']) {
            expect(forwardedChord(input(code)), code).toBeNull();
        }
    });

    it('leaves bare ⌘[ / ⌘] to the page (they are back/forward there, SET-189)', () => {
        expect(forwardedChord(input('BracketLeft'))).toBeNull();
        expect(forwardedChord(input('BracketRight'))).toBeNull();
    });

    it('ignores anything without ⌘, and anything with ⌃ or ⌥', () => {
        expect(forwardedChord(input('KeyF', { meta: false }))).toBeNull();
        expect(forwardedChord(input('KeyF', { control: true }))).toBeNull();
        expect(forwardedChord(input('KeyF', { alt: true }))).toBeNull();
    });

    it('forwards key-downs only — a key-up would fire the binding twice', () => {
        expect(forwardedChord(input('KeyF', { type: 'keyUp' }))).toBeNull();
        expect(forwardedChord(input('KeyF', { type: 'char' }))).toBeNull();
        expect(forwardedChord(input('KeyF', { type: 'rawKeyDown' }))).not.toBeNull();
    });

    it('carries shift through for ⌘⇧= (which is ⌘+, zoom in)', () => {
        expect(forwardedChord(input('Equal', { shift: true }))).toEqual({ code: 'Equal', shift: true });
    });

    it('encodes the relay command the client parses back', () => {
        expect(chordCommand({ code: 'KeyF', shift: false })).toBe('web-chord:KeyF');
        expect(chordCommand({ code: 'BracketRight', shift: true })).toBe('web-chord:BracketRight:shift');
    });
});

/**
 * Issue #33 — the regression the hardcoded set caused.
 *
 * Every one of these is an ordinary binding in `DEFAULT_KEYBIND_LINES`, so a user pressing it
 * over a focused page expects Kelpi to act. Until the set is derived from the binding map they
 * all fall into the page instead, and ⌘P in particular lands on Chromium's print dialog.
 */
describe('issue #33: bindings that must reach Kelpi from a focused page', () => {
    it('forwards ⌘D / ⇧⌘D (split_right / split_down)', () => {
        expect(forwardedChord(input('KeyD'))).toEqual({ code: 'KeyD', shift: false });
        expect(forwardedChord(input('KeyD', { shift: true }))).toEqual({ code: 'KeyD', shift: true });
    });

    it('forwards ⌘P (command_palette), so the palette is a workaround for anything else', () => {
        expect(forwardedChord(input('KeyP'))).toEqual({ code: 'KeyP', shift: false });
    });

    it('forwards ⇧⌘N (create_scratchpad) and ⌘N (new_workspace)', () => {
        expect(forwardedChord(input('KeyN', { shift: true }))).not.toBeNull();
        expect(forwardedChord(input('KeyN'))).not.toBeNull();
    });
});
