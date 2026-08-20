/**
 * Which chords the host takes from an embedded page (`./keys.ts`).
 *
 * The set has to be exactly the web-pane priority layer plus ⌘F. Too narrow and the layer is
 * unreachable the moment a user clicks the page; too wide and Nex starts eating a page's own
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
