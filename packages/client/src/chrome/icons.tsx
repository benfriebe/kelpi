/**
 * Chrome glyphs.
 *
 * Two kinds live here and they are deliberately different mechanisms:
 *
 *   1. **Structural chrome icons** (magnifier, chevron, ×, folder …) are hand-rolled inline
 *      SVG — no icon dependency may be added to the client, and these need to scale and take
 *      `currentColor`.
 *   2. **`IconRef` tokens** (workspace / group icons) round-trip through the daemon as opaque
 *      SF Symbol names (PLAN.md: "SF Symbol icon names round-trip as opaque tokens; client
 *      maps known ones, falls back to a generic glyph"). `ICON_TOKEN_GLYPHS` is that map: the
 *      curated set shell-ui.md §5.6 offers in "Change Icon ▸ Symbol", each rendered as a
 *      monochrome text glyph so it can be TINTED the workspace/group color the way the SF
 *      symbol is. `emoji` icons render as themselves (native colors, never tinted).
 */

import type { IconRef } from '@nex/daemon/store';
import type { ReactElement } from 'react';

// ── structural chrome icons ─────────────────────────────────────────────────────────

export type ChromeIconName =
    | 'search'
    | 'clear'
    | 'chevron-right'
    | 'chevron-down'
    | 'folder'
    | 'plus'
    | 'branch'
    | 'sidebar'
    | 'layout'
    | 'broadcast'
    | 'terminal'
    | 'stack'
    | 'document'
    | 'note'
    | 'plusminus'
    | 'globe'
    | 'bolt'
    | 'gear';

const PATHS: Record<ChromeIconName, ReactElement> = {
    search: (
        <>
            <circle cx="5.2" cy="5.2" r="3.4" />
            <path d="M7.8 7.8 10.4 10.4" />
        </>
    ),
    clear: (
        <>
            <circle cx="6" cy="6" r="4.4" />
            <path d="M4.4 4.4 7.6 7.6M7.6 4.4 4.4 7.6" />
        </>
    ),
    'chevron-right': <path d="M4.8 2.6 8.2 6l-3.4 3.4" />,
    'chevron-down': <path d="M2.6 4.8 6 8.2l3.4-3.4" />,
    folder: <path d="M1.6 3.4h3.2l1 1.4h4.6v5.4H1.6z" />,
    plus: <path d="M6 2.4v7.2M2.4 6h7.2" />,
    branch: (
        <>
            <circle cx="3.6" cy="3" r="1.3" />
            <circle cx="3.6" cy="9" r="1.3" />
            <circle cx="8.6" cy="4.4" r="1.3" />
            <path d="M3.6 4.3v3.4M4.9 3.6h1.4c1.2 0 1.9.4 1.9 1.4v.6" />
        </>
    ),
    sidebar: (
        <>
            <rect x="1.6" y="2.2" width="8.8" height="7.6" rx="1.2" />
            <path d="M4.6 2.2v7.6" />
        </>
    ),
    layout: (
        <>
            <rect x="1.6" y="2.2" width="8.8" height="7.6" rx="1.2" />
            <path d="M6 2.2v7.6M6 6h4.4" />
        </>
    ),
    broadcast: (
        <>
            <circle cx="6" cy="6" r="1.3" />
            <path d="M3.4 3.4a3.7 3.7 0 0 0 0 5.2M8.6 3.4a3.7 3.7 0 0 1 0 5.2" />
        </>
    ),
    terminal: (
        <>
            <path d="M2.4 3.2 5 6l-2.6 2.8" />
            <path d="M6 8.8h3.6" />
        </>
    ),
    stack: (
        <>
            <rect x="1.8" y="4.4" width="8.4" height="5.4" rx="1" />
            <path d="M3.2 2.8h5.6" />
        </>
    ),
    document: (
        <>
            <path d="M3 1.6h4l2 2v6.8H3z" />
            <path d="M7 1.6v2h2" />
        </>
    ),
    note: (
        <>
            <rect x="2.4" y="2" width="7.2" height="8" rx="1" />
            <path d="M4 4.6h4M4 6.4h4M4 8.2h2" />
        </>
    ),
    plusminus: (
        <>
            <path d="M3 3.6h3M4.5 2.1v3" />
            <path d="M3 8.6h6" />
            <path d="M7 3.6h2" />
        </>
    ),
    globe: (
        <>
            <circle cx="6" cy="6" r="4.2" />
            <path d="M1.8 6h8.4M6 1.8c1.6 1.8 1.6 6.6 0 8.4-1.6-1.8-1.6-6.6 0-8.4z" />
        </>
    ),
    bolt: <path d="M6.6 1.8 3.2 6.6h2.4l-.6 3.6 3.6-4.8H6.2z" />,
    /** Settings: a hub with four spokes — legible at 12px where real cog teeth are mush. */
    gear: (
        <>
            <circle cx="6" cy="6" r="2" />
            <path d="M6 1.4v1.6M6 9v1.6M1.4 6h1.6M9 6h1.6M2.8 2.8l1.1 1.1M8.1 8.1l1.1 1.1M9.2 2.8 8.1 3.9M3.9 8.1 2.8 9.2" />
        </>
    )
};

export interface ChromeIconProps {
    readonly name: ChromeIconName;
    readonly size?: number | undefined;
    readonly className?: string | undefined;
    readonly title?: string | undefined;
}

/** A 12×12-viewBox stroke glyph inheriting `currentColor`. */
export function ChromeIcon(props: ChromeIconProps): ReactElement {
    const size = props.size ?? 12;
    return (
        <svg
            viewBox="0 0 12 12"
            width={size}
            height={size}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden={props.title === undefined ? true : undefined}
            role={props.title === undefined ? undefined : 'img'}
            data-icon={props.name}
        >
            {props.title === undefined ? null : <title>{props.title}</title>}
            {PATHS[props.name]}
        </svg>
    );
}

// ── IconRef tokens ──────────────────────────────────────────────────────────────────

/** The curated "Change Icon ▸ Symbol" set (§5.6) plus the palette's per-type symbols. */
export const ICON_TOKEN_GLYPHS: Readonly<Record<string, string>> = {
    folder: '❐',
    'folder.fill': '❐',
    tray: '▤',
    'tray.fill': '▤',
    archivebox: '▣',
    'archivebox.fill': '▣',
    star: '★',
    'star.fill': '★',
    flag: '⚑',
    'flag.fill': '⚑',
    pin: '⚲',
    'pin.fill': '⚲',
    bookmark: '❧',
    'bookmark.fill': '❧',
    hammer: '⚒',
    'hammer.fill': '⚒',
    'testtube.2': '⚗',
    terminal: '❯',
    'terminal.fill': '❯',
    shippingbox: '▩',
    'shippingbox.fill': '▩',
    book: '❑',
    'book.fill': '❑',
    sparkles: '✦',
    'rectangle.stack': '❏',
    'doc.text': '≡',
    'note.text': '✎',
    plusminus: '±',
    globe: '◍',
    gearshape: '⚙'
};

/** Every unmapped SF Symbol name renders as this (PLAN.md's "generic glyph"). */
export const GENERIC_ICON_GLYPH = '◆';

/**
 * The character an `IconRef` draws as. Emoji pass through unchanged; a `system:` token maps
 * through `ICON_TOKEN_GLYPHS`, and an unknown name (a newer app version wrote it, or the user
 * hand-edited the DB) degrades to the generic glyph rather than disappearing.
 */
export function iconGlyph(icon: IconRef | null | undefined): string | null {
    if (icon === null || icon === undefined) return null;
    if (icon.kind === 'emoji') return icon.grapheme;
    return ICON_TOKEN_GLYPHS[icon.name] ?? GENERIC_ICON_GLYPH;
}

/** True when the glyph is an SF-symbol stand-in and may be tinted (emoji must not be). */
export function iconIsTintable(icon: IconRef | null | undefined): boolean {
    return icon !== null && icon !== undefined && icon.kind === 'system';
}

// ── the "Change Icon" picker (§5.6) ─────────────────────────────────────────────────

export interface IconChoice {
    /** The SF Symbol token stored in the DB, kept verbatim so a legacy value round-trips. */
    readonly name: string;
    readonly label: string;
}

/**
 * §5.6's "Change Icon ▸ Symbol" list, in menu order. The TOKEN is what travels; which glyph a
 * client draws for it is `ICON_TOKEN_GLYPHS`'s business, and one it cannot draw falls back —
 * the same contract a value written by a newer app version gets.
 */
export const CURATED_SYMBOL_ICONS: readonly IconChoice[] = [
    { name: 'folder', label: 'Folder' },
    { name: 'tray', label: 'Tray' },
    { name: 'archivebox', label: 'Archive' },
    { name: 'star', label: 'Star' },
    { name: 'flag', label: 'Flag' },
    { name: 'pin', label: 'Pin' },
    { name: 'bookmark', label: 'Bookmark' },
    { name: 'hammer', label: 'Build' },
    { name: 'testtube.2', label: 'Tests' },
    { name: 'terminal', label: 'Terminal' },
    { name: 'shippingbox', label: 'Package' },
    { name: 'book', label: 'Docs' },
    { name: 'sparkles', label: 'AI' }
];

/** §5.6's "Change Icon ▸ Emoji" quick set. */
export const CURATED_EMOJI: readonly string[] = [
    '📁',
    '📂',
    '⭐',
    '🔥',
    '💼',
    '🎯',
    '🧪',
    '🐛',
    '📝',
    '🚀',
    '☁️',
    '🎨'
];

interface SegmenterCtor {
    new (locale?: string | undefined, options?: { granularity: string }): {
        segment(input: string): Iterable<unknown>;
    };
}

/**
 * The "Custom Emoji…" field's validation: exactly ONE grapheme cluster, so a ZWJ family or a
 * flag counts as one character and `ab` does not. `Intl.Segmenter` is the only thing that gets
 * this right — `[...value].length` splits an emoji into its code points — with a conservative
 * code-point fallback for a runtime that lacks it.
 */
export function isSingleGrapheme(value: string): boolean {
    if (value.length === 0) return false;
    const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
    if (Segmenter === undefined) return [...value].length === 1;
    return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1;
}

/** Trim, then accept a single grapheme; anything else is `null` (the field stays invalid). */
export function normalizeEmojiInput(value: string): string | null {
    const trimmed = value.trim();
    return isSingleGrapheme(trimmed) ? trimmed : null;
}

/** The flat DB spelling the wire carries; `null` clears it (§5.6 "Reset to Letter"). */
export function formatIconToken(icon: IconRef | null): string | null {
    if (icon === null) return null;
    return icon.kind === 'emoji' ? `emoji:${icon.grapheme}` : `system:${icon.name}`;
}

/** First grapheme of a name, uppercased — the letter avatar (§5.3); empty name → `"?"`. */
export function avatarLetter(name: string): string {
    const trimmed = name.trim();
    if (trimmed.length === 0) return '?';
    const first = [...trimmed][0] ?? '?';
    return first.toUpperCase();
}
