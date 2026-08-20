/**
 * The custom-icon emoji heuristic — a straight port of `Character.isGraphemeEmoji`
 * (Nex/Models/GroupIcon.swift:52-95, issue #254), shared by BOTH ends: the client's
 * "Custom Emoji…" field disables Set Icon for a rejected grapheme, and the daemon's
 * `set-workspace-icon` / `set-group-icon` verbs refuse one on the wire, so a hand-crafted
 * frame cannot store `emoji:a` as an icon (§WS-073 / §WS-074).
 *
 * The macOS character palette — the sheet's own "Browse All Emoji…" button — offers glyphs
 * well beyond RGI emoji (⛙ U+26D9 carries no Unicode emoji properties at all), so the check
 * accepts, in this order, anchored on the grapheme's FIRST scalar:
 *
 *   1. an emoji-presentation base (`🔥`, skin tones, flags, ZWJ sequences), or an explicit
 *      `U+FE0F` selector on an emoji-capable base (`❤️`, and keycaps like `1️⃣` — digits carry
 *      `Emoji=Yes`). Anchoring on the first scalar is what rejects the degenerate clusters:
 *      a lone invisible `U+FE0F`, a selector glued to a non-emoji base (`a️`), or a
 *      letter wearing a skin-tone modifier;
 *   2. text-presentation emoji pasted bare, i.e. without the `U+FE0F` the palette usually
 *      appends (`✂`, `ℹ`, `©`): `Emoji=Yes` on a NON-ASCII first scalar. The ASCII guard is
 *      what keeps `1`, `#` and `*` (all `Emoji=Yes`) rejected;
 *   3. non-emoji pictographs and symbols (`⛙`, `♞`, `→`, `⌘`): a non-ASCII first scalar in
 *      the So / Sm / Sc categories. Sk (spacing accents like `´`) is deliberately excluded —
 *      it is one dead-key mistype away and never icon-worthy.
 *
 * Letters, digits, punctuation, whitespace and lone combining marks — ASCII or not (`a`, `Ω`,
 * `あ`, `！`) — stay rejected.
 *
 * Swift reads scalar properties directly; JS gets the same three questions from Unicode
 * property escapes, which is why each regex is built once here and tested against a single
 * code point rather than the whole cluster.
 */

/** `Emoji_Presentation`: renders as emoji with no variation selector. */
const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
/** `Emoji=Yes`: emoji-capable, whatever its default presentation. */
const EMOJI = /\p{Emoji}/u;
/** General categories So / Sm / Sc. Sk is excluded on purpose (see the header). */
const SYMBOL = /[\p{So}\p{Sm}\p{Sc}]/u;

/** U+FE0F, the emoji variation selector the palette appends to text-presentation bases. */
const VARIATION_SELECTOR_16 = '️';

/**
 * The heuristic itself. Takes ONE grapheme cluster (callers should have narrowed the input
 * with `firstGrapheme` first); anything longer is judged by its first scalar exactly as
 * Swift's `Character` is.
 */
export function isGraphemeEmoji(grapheme: string): boolean {
    const scalars = [...grapheme];
    const first = scalars[0];
    if (first === undefined) return false;
    if (EMOJI_PRESENTATION.test(first)) return true;
    if (scalars.length > 1 && scalars.includes(VARIATION_SELECTOR_16) && EMOJI.test(first)) return true;
    const code = first.codePointAt(0) ?? 0;
    if (code < 0x80) return false;
    if (EMOJI.test(first)) return true;
    return SYMBOL.test(first);
}

interface SegmenterCtor {
    new (locale?: string | undefined, options?: { granularity: string }): {
        segment(input: string): Iterable<{ segment: string }>;
    };
}

/**
 * The first grapheme cluster of a string, or `null` when it has none.
 *
 * `Intl.Segmenter` is the only thing that gets this right — `[...value][0]` splits a ZWJ
 * family or a flag into its first code point — with a code-point fallback for a runtime
 * that lacks it (older Node, a stripped JS engine).
 */
export function firstGrapheme(value: string): string | null {
    if (value.length === 0) return null;
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    if (Segmenter === undefined) return [...value][0] ?? null;
    for (const piece of new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
        return piece.segment;
    }
    return null;
}

/**
 * Trim, take the FIRST grapheme cluster (`GroupCustomEmojiSheet`'s truncation, §WS-072), and
 * return it only when it passes the heuristic. `null` means "not an icon" — the field stays
 * invalid client-side and the verb is refused daemon-side.
 */
export function normalizeIconEmoji(value: string): string | null {
    const first = firstGrapheme(value.trim());
    if (first === null) return null;
    return isGraphemeEmoji(first) ? first : null;
}
