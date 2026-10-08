/**
 * `workspace.icon` / `workspace_group.icon` — not JSON, a flat prefix-qualified string:
 * `"system:<sf-symbol-name>"` or `"emoji:<grapheme>"`. Unknown prefix or empty payload
 * decodes to null, which renders the fallback avatar/glyph.
 */

import { normalizeIconEmoji } from './emoji.js';

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
 * A `system:` name is an opaque token and is never refused. Every verb that writes an icon (the
 * GUI's `set-workspace-icon` / `set-group-icon`, the CLI's `workspace-icon` and
 * `workspace-create`'s `icon`) asks this one question, so they refuse alike.
 */
export function iconRefusal(icon: IconRef): string | null {
    if (icon.kind === 'emoji' && normalizeIconEmoji(icon.grapheme) !== icon.grapheme) {
        return `'${icon.grapheme}' is not a usable icon: give one emoji or symbol`;
    }
    return null;
}
