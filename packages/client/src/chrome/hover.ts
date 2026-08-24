/**
 * The chrome's hover recipe (UI-FIDELITY H11) — what a pointer-over does to a control.
 *
 * AppKit gives every control a hover/press response for free; a `<button>` in this document gets
 * one only if somebody writes it, and the global reset (`styles.css`) strips the user-agent
 * defaults without adding anything back. The result was a title bar and a status footer where
 * nothing — not the sidebar/inspector/••• toggles, not the layout chip, not an agent-count chip,
 * not a popover row — answered the pointer at all.
 *
 * Two tones, and only two, so a highlight means the same thing everywhere in the chrome:
 *
 *   · **text** — an icon or label control brightens to `textPrimary`. Nothing moves and no box
 *     appears, which is what an AppKit toolbar button does under the pointer.
 *   · **fill** — a control that already has a box (a chip, a menu/popover row) takes a
 *     `selectionFill` wash. This is `ContextMenu`'s `rowHighlight` rule, named here so the
 *     footer's popover rows and the title bar's layout rows use the same one.
 *
 * `useHoverKey` is the state: ONE `hovered` slot per surface, keyed by a control id, rather than
 * a `useState` per button — the surfaces this covers render their controls inline (and some of
 * them in a `map`), where a hook per control is not available.
 *
 * Hover only, deliberately not focus. `ContextMenu` highlights a focused row because a menu is
 * walked with the arrow keys and a menu that lights up only for the mouse is unusable from the
 * keyboard; a title-bar button is not walked, and highlighting it on focus would leave it lit
 * after every click.
 */

import { useCallback, useState } from 'react';

import { tokens } from './tokens';

/** An icon/text control: brighten to primary under the pointer. */
export function hoverText(hovered: boolean, base: string): string {
    return hovered ? tokens.textPrimary : base;
}

/** A boxed control (chip, menu row): a selection-fill wash under the pointer. */
export function hoverFill(hovered: boolean, base = 'transparent'): string {
    return hovered ? tokens.selectionFill : base;
}

export interface HoverBinding {
    readonly onMouseEnter: () => void;
    readonly onMouseLeave: () => void;
}

/**
 * One hover slot for a whole surface.
 *
 * Returns the currently hovered control's key (or null) and a `bind(key)` that produces the two
 * handlers for a control. `onMouseLeave` only clears the slot when it is still ITS key, so a
 * leave that arrives after the pointer has already entered the next control cannot blank the
 * new highlight.
 */
export function useHoverKey(): readonly [string | null, (key: string) => HoverBinding] {
    const [hovered, setHovered] = useState<string | null>(null);
    const bind = useCallback(
        (key: string): HoverBinding => ({
            onMouseEnter: () => {
                setHovered(key);
            },
            onMouseLeave: () => {
                setHovered((current) => (current === key ? null : current));
            }
        }),
        []
    );
    return [hovered, bind] as const;
}
