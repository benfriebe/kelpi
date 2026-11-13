/**
 * `workspace.icon` / `workspace_group.icon` — not JSON, a flat prefix-qualified string:
 * `"system:<sf-symbol-name>"` or `"emoji:<grapheme>"`. Unknown prefix or empty payload
 * decodes to null, which renders the fallback avatar/glyph.
 */

import { liftLeadingIconEmoji, MAX_ICON_EMOJI_SCALARS, normalizeIconEmoji } from './emoji.js';

/** The longest `system:` name stored, well past any real SF Symbol name. */
export const MAX_ICON_SYMBOL_LENGTH = 128;

export type IconRef =
    | { readonly kind: 'system'; readonly name: string }
    | { readonly kind: 'emoji'; readonly grapheme: string };

export function parseIconString(value: string | null | undefined): IconRef | null {
    if (typeof value !== 'string') return null;
    const separator = value.indexOf(':');
    if (separator < 0) return null;
    const prefix = value.slice(0, separator);
    const payload = value.slice(separator + 1);
    if (payload.length === 0) return null;
    if (prefix === 'system') return { kind: 'system', name: payload };
    if (prefix === 'emoji') return { kind: 'emoji', grapheme: payload };
    return null;
}

export function formatIconString(icon: IconRef): string {
    return icon.kind === 'system' ? `system:${icon.name}` : `emoji:${icon.grapheme}`;
}

/**
 * Why a parsed icon may not be stored, or `null` when it may (§WS-074). An `emoji:` payload must
 * be exactly ONE grapheme that passes §WS-073's heuristic, so neither a letter (`emoji:a`) nor two
 * emoji (`emoji:🔥🔥`) reach the DB; a ZWJ, flag or skin-tone sequence is one grapheme and passes.
 * One grapheme can still be any length, so it is also capped at `MAX_ICON_EMOJI_SCALARS`, and the
 * refusal for an over-long one does not echo it back. A `system:` name is an opaque token, refused
 * only past `MAX_ICON_SYMBOL_LENGTH`. Every verb that writes an icon (the GUI's
 * `set-workspace-icon` / `set-group-icon`, the CLI's `workspace-icon` and `workspace-create`'s
 * `icon`) asks this one question, so they refuse alike.
 */
export function iconRefusal(icon: IconRef): string | null {
    if (icon.kind === 'system') {
        return icon.name.length > MAX_ICON_SYMBOL_LENGTH
            ? `the symbol name is too long: at most ${String(MAX_ICON_SYMBOL_LENGTH)} characters`
            : null;
    }
    if (normalizeIconEmoji(icon.grapheme) === icon.grapheme) return null;
    return [...icon.grapheme].length > MAX_ICON_EMOJI_SCALARS
        ? 'the icon is too long: give one emoji or symbol'
        : `'${icon.grapheme}' is not a usable icon: give one emoji or symbol`;
}

/**
 * The name and icon a workspace or group ends up with from the name it was given. A name that
 * starts with an emoji (`"🔥 auth refactor"`) gives it up as the icon and keeps the rest
 * (`liftLeadingIconEmoji`), the way a Figma file or a Notion page does; any other name is kept
 * whole and leaves `current`, the icon it already has, alone. The leading emoji is the user's
 * latest word on the icon, so it replaces a `system:` or `emoji:` icon that was there. When it
 * IS the icon that was there, `current` itself is returned, so a rename that only repeats the
 * emoji changes nothing a reducer or a diff could see.
 */
export function liftLeadingIcon(
    name: string,
    current: IconRef | null
): { readonly name: string; readonly icon: IconRef | null } {
    const lifted = liftLeadingIconEmoji(name);
    if (lifted === null) return { name, icon: current };
    const same = current !== null && current.kind === 'emoji' && current.grapheme === lifted.icon;
    return { name: lifted.name, icon: same ? current : { kind: 'emoji', grapheme: lifted.icon } };
}
