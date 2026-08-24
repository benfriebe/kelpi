/**
 * §WEB-029 — the inline error card a failed navigation replaces the page with.
 *
 * `WebPaneCoordinator.swift:786-901` renders a self-contained dark card carrying a red `!`
 * badge, the heading "Couldn't load page", the failed URL, the localized error message and a
 * filled **Retry** anchor, loaded with `baseURL` set to the failed URL so the URL bar keeps
 * showing where the user was going. Without it the user meets Chromium's own error page — which
 * names Chromium, offers a reload button that belongs to a different browser, and does not match
 * the pane's chrome at all. `webErrorPageHTML` below is that document, rule for rule (§M32).
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

/**
 * The card itself: one document, no external anything, dark to match the pane chrome.
 *
 * §M32 — this is `WebPaneCoordinator.swift:803-901` transcribed, not merely inspired by it. The
 * port's own card had drifted on every axis at once: the heading read "Failed to open page"
 * where the shipped one reads **"Couldn't load page"**, there was no red `!` badge, the URL sat
 * grey *below* the message instead of blue *above* it, Retry was a muted outlined chip
 * (`#24405e` on `#3b6ea5`) instead of the filled `#0A84FF` button, and the card had no shadow.
 * Every rule below is the Swift's: the `#1c1c1e` / `#f2f2f7` ground, the `.wrap` centring at
 * 32 px, the 480 px `.card` on `rgba(255,255,255,0.04)` with a 10 px radius and
 * `0 10px 40px rgba(0,0,0,0.4)`, the 32 px `.icon` circle in `rgba(255,69,58,0.18)` / `#FF453A`,
 * the `#5AC8FA` monospace URL, and the `a.btn:hover{filter:brightness(1.1)}`.
 *
 * Two things are the port's and stay:
 *
 *   - the `data-nex-web-error-page` marker on `<html>`, which is how `tab.ts` recognises its own
 *     card in `did-navigate` (the Swift tracks `WKNavigation` identity instead — see §WEB-030);
 *   - the small `(-105)` net-error code after the message. Chromium hands `did-fail-load` a code
 *     the Swift's `NSError` path never had, and it is the one thing that tells a real
 *     `ERR_CONNECTION_RESET` from a proxy swallowing the request. It rides *inside* the message
 *     paragraph, so it displaces none of the five things the finding names.
 *
 * The Swift's `.btn.ghost` rule has no second button to style and is not carried over.
 */
export function webErrorPageHTML(input: WebErrorPageInput): string {
    const url = escapeHTML(input.url);
    const message = escapeHTML(webErrorMessage(input.description));
    const code = escapeHTML(String(input.code));
    return [
        '<!DOCTYPE html>',
        `<html lang="en" data-${ERROR_PAGE_MARKER}="1">`,
        '<head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width,initial-scale=1">',
        "<title>Couldn't load page</title><style>",
        ':root{color-scheme:dark;}',
        'html,body{height:100%;margin:0;background:#1c1c1e;color:#f2f2f7;',
        'font:14px -apple-system,system-ui,sans-serif;}',
        '.wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:32px;',
        'box-sizing:border-box;}',
        '.card{max-width:480px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);',
        'border-radius:10px;padding:24px 28px;box-shadow:0 10px 40px rgba(0,0,0,0.4);}',
        '.icon{width:32px;height:32px;border-radius:50%;background:rgba(255,69,58,0.18);color:#FF453A;',
        'display:flex;align-items:center;justify-content:center;',
        'font:700 16px/1 -apple-system,system-ui,sans-serif;margin-bottom:14px;}',
        'h1{font-size:16px;font-weight:600;margin:0 0 6px;}',
        '.url{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#5AC8FA;',
        'word-break:break-all;margin:0 0 14px;}',
        'p.message{margin:0 0 18px;color:rgba(242,242,247,0.75);line-height:1.45;}',
        '.code{color:rgba(242,242,247,0.45);font-size:11px;}',
        '.actions{display:flex;gap:8px;}',
        'a.btn{display:inline-block;padding:6px 14px;border-radius:6px;background:#0A84FF;color:white;',
        'text-decoration:none;font-weight:600;font-size:12px;}',
        'a.btn:hover{filter:brightness(1.1);}',
        '</style></head><body><div class="wrap"><div class="card">',
        '<div class="icon">!</div>',
        "<h1>Couldn't load page</h1>",
        `<p class="url">${url}</p>`,
        `<p class="message">${message} <span class="code">(${code})</span></p>`,
        '<div class="actions">',
        `<a class="btn" href="${url}">Retry</a>`,
        '</div></div></div></body></html>'
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
