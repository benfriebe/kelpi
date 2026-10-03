/**
 * What a page's request for a new window becomes: a tab in the same pane, or nothing.
 *
 * Chromium routes every "open this somewhere else" through `setWindowOpenHandler`: a middle-click
 * or ⌘-click on a link (`background-tab`), a ⇧⌘-click or a plain click on a `target=_blank` link
 * (`foreground-tab`), a ⇧-click or a `window.open` with window features (`new-window`). A web pane
 * has tabs and no windows, so each of those is answered the way a browser with tabs answers it: a
 * new tab beside the page, in the background for the gestures that ask for one.
 *
 * The host never creates the tab itself. The daemon mints tab ids and owns the tab list, so the
 * shell denies the native window and sends the daemon an `open-tab` request; the daemon adds the
 * tab and tells the host to build it with the ordinary `tab-open` verb.
 *
 * Only http(s) is passed on. A page asking for `about:blank` (a bare `window.open()`) wants a
 * scriptable popup it can write into, which a tab the daemon builds from a URL can never be, and a
 * `javascript:`, `file:` or `data:` target opened from a page is not a navigation a user asked for.
 */

/** The half of Electron's `HandlerDetails` this decision reads. */
export interface WindowOpenDetails {
    readonly url: string;
    readonly disposition: string;
}

/** A tab the daemon is asked to add to the pane that made the request. */
export interface TabOpenRequest {
    readonly url: string;
    /** False for a background tab: the page that was clicked stays the active one. */
    readonly active: boolean;
}

const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

export function tabRequestForWindowOpen(details: WindowOpenDetails): TabOpenRequest | null {
    let active: boolean;
    switch (details.disposition) {
        case 'background-tab':
            active = false;
            break;
        case 'foreground-tab':
        case 'new-window':
            active = true;
            break;
        default:
            // `default`, `save-to-disk` and `other` are not a request for somewhere new to show
            // the page.
            return null;
    }
    let parsed: URL;
    try {
        parsed = new URL(details.url);
    } catch {
        return null;
    }
    if (!OPENABLE_PROTOCOLS.has(parsed.protocol)) return null;
    return { url: parsed.href, active };
}
