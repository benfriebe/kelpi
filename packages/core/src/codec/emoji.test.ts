import { describe, expect, it } from 'vitest';

import { firstGrapheme, isGraphemeEmoji, normalizeIconEmoji } from './emoji.js';

/**
 * The accept / reject table is `Character.isGraphemeEmoji`'s own doc comment
 * (Nex/Models/GroupIcon.swift:52-95), case for case.
 */
describe('isGraphemeEmoji', () => {
    it('accepts emoji-presentation bases, including modifiers, flags and ZWJ sequences', () => {
        for (const grapheme of ['🔥', '📁', '👍🏽', '🇦🇺', '👨‍👩‍👧‍👦', '🚀', '🎨']) {
            expect(isGraphemeEmoji(grapheme), grapheme).toBe(true);
        }
    });

    it('accepts a U+FE0F selector on an emoji-capable base, keycaps included', () => {
        for (const grapheme of ['❤️', '1️⃣', '#️⃣', '☁️', '⚠️']) {
            expect(isGraphemeEmoji(grapheme), grapheme).toBe(true);
        }
    });

    it('accepts bare text-presentation emoji (no variation selector)', () => {
        for (const grapheme of ['✂', 'ℹ', '©', '✈']) {
            expect(isGraphemeEmoji(grapheme), grapheme).toBe(true);
        }
    });

    it('accepts non-emoji pictographs and symbols — So, Sm, Sc', () => {
        // ⛙ (U+26D9) is issue #254's case: the palette offers it, Unicode gives it no emoji
        // property at all, and the Swift check lets it through on its So category.
        for (const grapheme of ['⛙', '♞', '→', '⌘', '€', '∑']) {
            expect(isGraphemeEmoji(grapheme), grapheme).toBe(true);
        }
    });

    it('rejects letters, digits, punctuation, whitespace and empties', () => {
        for (const grapheme of ['a', 'Z', '7', '-', '_', '.', '!', ' ', '', 'Ω', 'あ', '！']) {
            expect(isGraphemeEmoji(grapheme), JSON.stringify(grapheme)).toBe(false);
        }
    });

    it('rejects the degenerate clusters the first-scalar anchor exists for', () => {
        // A lone variation selector, a selector glued to a letter, and a letter wearing a
        // skin-tone modifier: each is one grapheme, none is an icon.
        expect(isGraphemeEmoji('️')).toBe(false);
        expect(isGraphemeEmoji('a️')).toBe(false);
        expect(isGraphemeEmoji('a\u{1F3FB}')).toBe(false);
        // Sk (a spacing accent) is excluded even though it is a non-ASCII symbol-ish mark.
        expect(isGraphemeEmoji('´')).toBe(false);
        expect(isGraphemeEmoji('^')).toBe(false);
    });
});

describe('firstGrapheme', () => {
    it('keeps a compound cluster whole rather than splitting its code points', () => {
        expect(firstGrapheme('👨‍👩‍👧‍👦')).toBe('👨‍👩‍👧‍👦');
        expect(firstGrapheme('🇦🇺')).toBe('🇦🇺');
        expect(firstGrapheme('👍🏽')).toBe('👍🏽');
    });

    it('truncates to the first cluster, and answers null for an empty string', () => {
        expect(firstGrapheme('ab')).toBe('a');
        expect(firstGrapheme('🔥🎨')).toBe('🔥');
        expect(firstGrapheme('')).toBeNull();
    });
});

describe('normalizeIconEmoji', () => {
    it('trims, truncates to one grapheme, and accepts only what the heuristic passes', () => {
        expect(normalizeIconEmoji('  🔥  ')).toBe('🔥');
        // §WS-072's truncation: a whole sentence collapses to its first cluster…
        expect(normalizeIconEmoji('🔥 is fine')).toBe('🔥');
        // …and that cluster still has to be an emoji.
        expect(normalizeIconEmoji('hello')).toBeNull();
        expect(normalizeIconEmoji('7')).toBeNull();
        expect(normalizeIconEmoji('   ')).toBeNull();
    });
});
