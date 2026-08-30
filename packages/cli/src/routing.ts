/**
 * File-vs-URL routing (cli.md §13) — the two mirror-image oracles plus the three tables.
 *
 * These are user-visible contracts exercised by muscle memory (`kelpi open google.com`,
 * `kelpi web open foo.html`, `./app` to force a path), so they are ported as pure functions with
 * an injectable filesystem probe and covered by table-driven tests:
 *
 *   - `localFileURL` answers "is this argument a local path?" for `web open|navigate|tab-new`.
 *     Explicit paths (`/`, `./`, `../`, `~`) always are, even when they don't exist; a BARE
 *     name only is when a regular file WITH an extension exists in the cwd — that exclusion is
 *     what stops a dev hostname (`app`, `web`, `api`) colliding with a cwd directory from
 *     being hijacked into a `file://` URL.
 *   - `webTargetForOpenArg` answers the inverse for `kelpi open`: a real `scheme://`, a
 *     `host:port`, `localhost`, an IPv4 literal, or a bare dotted host whose last label is a
 *     recognised TLD is a web target; everything else falls through to the file router.
 *
 * The TLD list deliberately omits TLDs that collide with file extensions (`.sh`, `.ai`,
 * `.app`, `.rs`, `.zip`, `.mov`, `.md`, `.pt`) so `kelpi open run.sh` still routes by type.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Extensions that route to a markdown preview pane. */
export const markdownOpenExtensions: ReadonlySet<string> = new Set([
    'md',
    'markdown',
    'mdown',
    'mkd',
    'mkdn',
    'mdwn',
    'markdn'
]);

/** Extensions a web pane renders natively, opened as a `file://` URL. */
export const webOpenExtensions: ReadonlySet<string> = new Set([
    'html',
    'htm',
    'pdf',
    'svg',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'webp'
]);

/** TLDs that let `kelpi open` route a BARE dotted argument to a web pane. */
export const webOpenCommonTLDs: ReadonlySet<string> = new Set([
    // generic
    'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'info', 'biz',
    'name', 'pro', 'io', 'co', 'dev', 'xyz', 'tech', 'online', 'site',
    'store', 'blog', 'cloud', 'page', 'wiki', 'news', 'email', 'me',
    // country / regional (low collision; `.pt` intentionally omitted: PyTorch checkpoints)
    'us', 'uk', 'ca', 'au', 'nz', 'de', 'fr', 'es', 'it', 'nl', 'se',
    'no', 'fi', 'dk', 'ie', 'eu', 'jp', 'cn', 'kr', 'in', 'br', 'mx',
    'ru', 'ch', 'at', 'be', 'za', 'tv', 'fm', 'gg', 'to', 'ly',
    'id', 'sg', 'hk'
]);

export interface RoutingContext {
    readonly cwd: string;
    readonly home: string;
    /** Filesystem probe; injected so the routing tables are testable without a real tree. */
    readonly stat?: ((absolutePath: string) => { readonly isDirectory: boolean } | null) | undefined;
}

function probe(context: RoutingContext, absolutePath: string): { readonly isDirectory: boolean } | null {
    if (context.stat !== undefined) return context.stat(absolutePath);
    try {
        const stats = fs.statSync(absolutePath);
        return { isDirectory: stats.isDirectory() };
    } catch {
        return null;
    }
}

/** `~` / `~/x` against `home`; every other value untouched (Swift's `expandingTildeInPath`). */
export function expandTilde(value: string, home: string): string {
    if (value === '~') return home;
    if (value.startsWith('~/')) return path.join(home, value.slice(2));
    return value;
}

/** Swift's `URL(fileURLWithPath:).absoluteString`: percent-encoded, `/`-suffixed for dirs. */
export function fileURLString(absolutePath: string, isDirectory: boolean): string {
    const href = pathToFileURL(absolutePath).href;
    if (isDirectory && !href.endsWith('/')) return `${href}/`;
    return href;
}

/** Lowercased final extension of a path, or `""` (Swift's `pathExtension`). */
export function pathExtensionLower(absolutePath: string): string {
    const extension = path.extname(absolutePath);
    return extension.startsWith('.') ? extension.slice(1).toLowerCase() : extension.toLowerCase();
}

/**
 * `file://` URL when `arg` denotes a local path, else null (the caller forwards the raw
 * string and the app treats it as a URL / hostname).
 */
export function localFileURL(arg: string, context: RoutingContext): string | null {
    const trimmed = arg.trim();
    if (trimmed.length === 0) return null;
    // Already a full URL (http://, https://, file://, …).
    if (trimmed.includes('://')) return null;
    // Opaque scheme without `://` (data:, mailto:, about:, tel:, vscode:, …). A letter-led
    // token followed by a colon whose next char is NOT a digit is a scheme; a digit means
    // `host:port`, which is not local either but is handled by the caller.
    const colon = trimmed.indexOf(':');
    if (colon >= 0 && /^[A-Za-z]/.test(trimmed)) {
        const scheme = trimmed.slice(0, colon);
        const schemeChars = /^[A-Za-z0-9+\-.]*$/.test(scheme);
        const afterColon = trimmed.charAt(colon + 1);
        const looksLikePort = afterColon !== '' && /\d/.test(afterColon);
        if (schemeChars && !looksLikePort) return null;
    }

    const looksLikePath =
        trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~');
    const expanded = expandTilde(trimmed, context.home);
    const absolute = path.resolve(context.cwd, expanded);
    const stats = probe(context, absolute);

    if (looksLikePath) return fileURLString(absolute, stats?.isDirectory === true);
    // A bare argument is a file only when a REGULAR file with a non-empty extension exists.
    if (stats !== null && !stats.isDirectory && pathExtensionLower(absolute).length > 0) {
        return fileURLString(absolute, false);
    }
    return null;
}

/** The `kelpi open` URL/host detector — the mirror image of `localFileURL`. */
export function webTargetForOpenArg(arg: string, context: RoutingContext): string | null {
    const trimmed = arg.trim();
    if (trimmed.length === 0) return null;

    // An explicit path or an existing local file is never a web target.
    if (localFileURL(trimmed, context) !== null) return null;

    // A real URL with a scheme.
    if (trimmed.includes('://')) return trimmed;

    // Authority = everything before the first path / query / fragment.
    const authorityEnd = trimmed.search(/[/?#]/);
    const authority = authorityEnd < 0 ? trimmed : trimmed.slice(0, authorityEnd);
    if (authority.length === 0) return null;

    // Peel off an optional all-digit `:port`.
    let host = authority;
    let hasPort = false;
    const lastColon = host.lastIndexOf(':');
    if (lastColon >= 0) {
        const port = host.slice(lastColon + 1);
        if (port.length > 0 && /^\d+$/.test(port)) {
            hasPort = true;
            host = host.slice(0, lastColon);
        }
    }
    if (host.length === 0) return null;

    const lowerHost = host.toLowerCase();
    if (lowerHost === 'localhost') return trimmed;

    const octets = lowerHost.split('.');
    if (octets.length === 4 && octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)) {
        return trimmed;
    }

    // Any explicit host:port is a web target (a file never carries a numeric port suffix).
    if (hasPort) return trimmed;

    const labels = lowerHost.split('.');
    const tld = labels[labels.length - 1];
    if (labels.length >= 2 && labels.every((label) => label.length > 0) && tld !== undefined && webOpenCommonTLDs.has(tld)) {
        return trimmed;
    }
    return null;
}
