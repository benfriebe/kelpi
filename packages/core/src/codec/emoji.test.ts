import { describe, expect, it } from 'vitest';

import { firstGrapheme, isGraphemeEmoji, liftLeadingIconEmoji, MAX_ICON_EMOJI_SCALARS, normalizeIconEmoji } from './emoji.js';

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

    it('refuses one cluster longer than any emoji, however it segments', () => {
        // The longest RGI emoji (a kiss with two skin tones) is 10 scalars and still passes.
        expect(normalizeIconEmoji('👩🏻‍❤️‍💋‍👨🏼')).toBe('👩🏻‍❤️‍💋‍👨🏼');
        // A ZWJ chain and a pile of combining marks are each ONE grapheme, so only the cap stops them.
        const chain = Array.from({ length: 2000 }, () => '🔥').join('\u200d');
        expect(firstGrapheme(chain)).toBe(chain);
        expect(normalizeIconEmoji(chain)).toBeNull();
        expect(normalizeIconEmoji(`🔥${'\u0301'.repeat(1000)}`)).toBeNull();
        // The cap is on scalars: 16 pass, 17 do not.
        const marks = (count: number): string => `🔥${'\u0301'.repeat(count - 1)}`;
        expect(normalizeIconEmoji(marks(MAX_ICON_EMOJI_SCALARS))).toBe(marks(MAX_ICON_EMOJI_SCALARS));
        expect(normalizeIconEmoji(marks(MAX_ICON_EMOJI_SCALARS + 1))).toBeNull();
    });
});

describe('liftLeadingIconEmoji', () => {
    it('splits a name that starts with an emoji into the icon and the rest', () => {
        expect(liftLeadingIconEmoji('🔥 auth refactor')).toEqual({ icon: '🔥', name: 'auth refactor' });
        // Trimmed on both sides of the emoji: no space, many spaces and outer whitespace all agree.
        expect(liftLeadingIconEmoji('🔥auth')).toEqual({ icon: '🔥', name: 'auth' });
        expect(liftLeadingIconEmoji('  🔥   auth  ')).toEqual({ icon: '🔥', name: 'auth' });
        // A compound cluster is lifted whole, never split into its code points.
        expect(liftLeadingIconEmoji('👨‍👩‍👧‍👦 family')).toEqual({ icon: '👨‍👩‍👧‍👦', name: 'family' });
        expect(liftLeadingIconEmoji('🇦🇺 sydney')).toEqual({ icon: '🇦🇺', name: 'sydney' });
        // Only the FIRST cluster is lifted; a second emoji stays in the name.
        expect(liftLeadingIconEmoji('🔥🔥 hot')).toEqual({ icon: '🔥', name: '🔥 hot' });
        // Symbols the Custom Emoji sheet accepts (§WS-073) are lifted alike.
        expect(liftLeadingIconEmoji('⛙ paddock')).toEqual({ icon: '⛙', name: 'paddock' });
    });

    it('leaves a name alone when it does not start with an emoji, or would be left empty', () => {
        for (const name of ['auth refactor', 'a🔥b', '7 wonders', '# tags', '$ budget', '- dash', '', '   ']) {
            expect(liftLeadingIconEmoji(name), JSON.stringify(name)).toBeNull();
        }
        // An emoji on its own is a name, since a workspace cannot have none.
        expect(liftLeadingIconEmoji('🔥')).toBeNull();
        expect(liftLeadingIconEmoji('  🔥  ')).toBeNull();
        // Past the icon cap it is not an icon either, so the name keeps it.
        expect(liftLeadingIconEmoji(`🔥${'\u0301'.repeat(MAX_ICON_EMOJI_SCALARS)} marks`)).toBeNull();
    });
});
