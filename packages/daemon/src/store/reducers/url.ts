/**
 * `normalizeURLInput` — shared by web-pane open / navigate / tab-open.
 * Spec: docs/current/workspace-feature.md §7.6.
 */

const SCHEME_CHARS = /^[A-Za-z][A-Za-z0-9+\-.]*$/;

/** localhost-ish hosts get http://, everything else https:// (§7.6). */
export function isLocalOrInternalHost(host: string): boolean {
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0' || lower === '::1') {
        return true;
    }
    if (lower.endsWith('.local') || lower.endsWith('.localhost')) return true;
    // Single-label hosts (no dot) are internal by construction.
    return !lower.includes('.');
}

export function normalizeURLInput(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed === '') return trimmed;
    if (trimmed.includes('://')) return trimmed;

    // Opaque schemes without "://" (data:, javascript:, mailto:, about:, file:, tel:).
    // A digit right after the colon means host:port, not a scheme.
    const colon = trimmed.indexOf(':');
    if (colon > 0) {
        const scheme = trimmed.slice(0, colon);
        const after = trimmed.charAt(colon + 1);
        if (SCHEME_CHARS.test(scheme) && !(after >= '0' && after <= '9')) return trimmed;
    }

    const host = (trimmed.split('/')[0] ?? '').split(':')[0] ?? '';
    const scheme = isLocalOrInternalHost(host) ? 'http' : 'https';
    return `${scheme}://${trimmed}`;
}
