/**
 * §WEB-029 — the inline error card a failed navigation replaces the page with.
 *
 * `WebPaneCoordinator.swift:786-901` renders a self-contained dark card carrying the failed
 * URL, the localized error message and a **Retry** anchor, loaded with `baseURL` set to the
 * failed URL so the URL bar keeps showing where the user was going. Without it the user meets
 * Chromium's own error page — which names Chromium, offers a reload button that belongs to a
 * different browser, and does not match the pane's chrome at all.
 *
 * Two port-specific decisions, both forced:
 *
 *   - **The card is a `data:` URL**, because Electron's `loadURL` has no `baseURL` parameter
 *     (`loadURL(url, {baseURLForDataURL})` exists but applies to relative sub-resources, which a
 *     self-contained card has none of). The URL BAR is unaffected: the tab reports
 *     `lastAttemptedURL` while `failedLoad` is set (§WEB-026), so it still shows the address that
 *     failed rather than the card's own data URL.
 *   - **Retry is a plain anchor to the failed URL**, exactly as the Swift's is. It needs no
 *     bridge, no injected script and no binding: clicking it is an ordinary navigation, which is
 *     what a retry is.
 *
 * The HTML is built here, and only here, so it can be asserted without an Electron process.
 */

/** The marker the tab uses to recognise its own card in `did-navigate` (never a real page). */
export const ERROR_PAGE_MARKER = 'nex-web-error-page';

export interface WebErrorPageInput {
    /** The address the user was going to; also the Retry target. */
    readonly url: string;
    /** Chromium's error description (`did-fail-load`'s third argument). */
    readonly description: string;
    /** Chromium's negative net error code, shown small beside the message. */
    readonly code: number;
}

function escapeHTML(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * A human sentence for the failure. Chromium's `description` is a symbol
 * (`ERR_NAME_NOT_RESOLVED`); the Swift showed `NSError.localizedDescription`, so the common
 * cases are spelled out and anything unknown falls back to the symbol rather than inventing one.
 */
export function webErrorMessage(description: string): string {
    switch (description) {
        case 'ERR_NAME_NOT_RESOLVED':
            return 'The server could not be found.';
        case 'ERR_CONNECTION_REFUSED':
            return 'The connection was refused.';
        case 'ERR_CONNECTION_TIMED_OUT':
        case 'ERR_TIMED_OUT':
            return 'The connection timed out.';
        case 'ERR_INTERNET_DISCONNECTED':
            return 'There is no internet connection.';
        case 'ERR_CONNECTION_RESET':
            return 'The connection was reset.';
        case 'ERR_CONNECTION_CLOSED':
            return 'The connection was closed.';
        case 'ERR_SSL_PROTOCOL_ERROR':
        case 'ERR_CERT_AUTHORITY_INVALID':
        case 'ERR_CERT_COMMON_NAME_INVALID':
            return 'The secure connection could not be established.';
        case 'ERR_FILE_NOT_FOUND':
            return 'The file could not be found.';
        case 'ERR_ADDRESS_UNREACHABLE':
            return 'The address is unreachable.';
        default:
            return description === '' ? 'The page could not be loaded.' : description;
    }
}

/** The card itself: one document, no external anything, dark to match the pane chrome. */
export function webErrorPageHTML(input: WebErrorPageInput): string {
    const url = escapeHTML(input.url);
    const message = escapeHTML(webErrorMessage(input.description));
    const code = escapeHTML(String(input.code));
    return [
        '<!doctype html>',
        `<html lang="en" data-${ERROR_PAGE_MARKER}="1">`,
        '<head><meta charset="utf-8"><title>Failed to open page</title><style>',
        'html,body{margin:0;height:100%;background:#141416;color:#e6e6ea;',
        'font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}',
        'main{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}',
        'section{max-width:520px;width:100%;background:#1b1b1f;border:1px solid #2c2c32;',
        'border-radius:10px;padding:20px 22px;}',
        'h1{margin:0 0 6px;font-size:15px;font-weight:600;}',
        'p{margin:0 0 10px;color:#a8a8b0;line-height:1.45;}',
        '.url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:#c8c8d0;',
        'word-break:break-all;margin:0 0 14px;}',
        '.code{color:#6f6f78;font-size:11px;}',
        'a.retry{display:inline-block;padding:5px 12px;border-radius:6px;border:1px solid #3b6ea5;',
        'background:#24405e;color:#dce8f6;text-decoration:none;font-size:12px;}',
        'a.retry:hover{background:#2c4d71;}',
        '</style></head><body><main><section>',
        '<h1>Failed to open page</h1>',
        `<p>${message} <span class="code">(${code})</span></p>`,
        `<p class="url">${url}</p>`,
        `<a class="retry" href="${url}">Retry</a>`,
        '</section></main></body></html>'
    ].join('');
}

/** What `contents.loadURL` is handed. Percent-encoded so quotes and `#` survive intact. */
export function webErrorPageDataURL(input: WebErrorPageInput): string {
    return `data:text/html;charset=utf-8,${encodeURIComponent(webErrorPageHTML(input))}`;
}

/** True for a URL this module produced — the tab's guard against treating it as a page. */
export function isWebErrorPageURL(url: string): boolean {
    return url.startsWith('data:text/html') && url.includes(ERROR_PAGE_MARKER);
}
