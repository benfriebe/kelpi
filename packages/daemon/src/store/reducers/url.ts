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
    // RFC 1918 + link-local IPv4 (WEB-023). A LAN address is a dev server far more often than a
    // TLS endpoint, and `https://192.168.1.5` fails in a way that reads as "Kelpi is broken"
    // rather than "that box speaks http".
    if (isPrivateIPv4(lower)) return true;
    // Single-label hosts (no dot) are internal by construction.
    return !lower.includes('.');
}

/** 10/8, 172.16–31/12, 192.168/16, 169.254/16 — and nothing that merely looks like one. */
export function isPrivateIPv4(host: string): boolean {
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const octets: number[] = [];
    for (const part of parts) {
        // No empty parts and no leading zeros: `010.0.0.1` is not an address worth guessing at.
        if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return false;
        const value = Number(part);
        if (value > 255) return false;
        octets.push(value);
    }
    const [a, b] = octets as [number, number, number, number];
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return a === 169 && b === 254;
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
