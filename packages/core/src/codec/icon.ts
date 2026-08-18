/**
 * `workspace.icon` / `workspace_group.icon` — not JSON, a flat prefix-qualified string:
 * `"system:<sf-symbol-name>"` or `"emoji:<grapheme>"`. Unknown prefix or empty payload
 * decodes to null, which renders the fallback avatar/glyph.
 */

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
