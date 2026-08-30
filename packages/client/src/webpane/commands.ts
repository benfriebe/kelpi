/**
 * The web-pane chrome's command surface.
 *
 * Every button in `./WebPane.tsx` is one control-protocol verb — the same ones `kelpi web …`
 * sends — so the UI and the CLI cannot drift: a URL-bar submit IS `web-navigate`, the tab
 * strip's ✕ IS `web-tab-close`. They live here rather than on `CommandClient` because they are
 * a feature's vocabulary, not the transport's; `raw()` is public exactly so a feature can own
 * its own verbs.
 *
 * The one exception is `devtools`, which has no CLI verb at all (web-pane.md §16.5 is a GUI
 * gesture): it rides the WS-only `web-devtools` command, which the daemon forwards straight to
 * the shell host. Adding it to `WIRE_COMMANDS` would owe the Swift CLI a command it will never
 * send.
 *
 * Replies are `{ok:…}` envelopes. Failures are surfaced by the caller (assembly turns them into
 * the same error toast every other command uses), so nothing here throws on `ok:false` — an
 * optimistic ack is normal for web verbs (web-pane.md §17.4).
 */

import type { JsonObject } from '@kelpi/protocol';

import type { CommandReply } from '../connection';

/** Anything that can put a request object on the wire — `CommandClient` satisfies it. */
export interface WebCommandSender {
    raw(payload: JsonObject): Promise<CommandReply>;
}

/** The find bar's four operations (§10), the same set `__kelpiWebFind` exposes. */
export type WebFindOp = 'search' | 'next' | 'prev' | 'clear';

/** ⌘= / ⌘- / ⌘0 (§4.2). The daemon turns these into ±0.1 / reset, and the host clamps. */
export type WebZoomDirection = 'in' | 'out' | 'reset';

/** One cookie as the storage panel's form writes it (§13.2). */
export interface WebCookieWrite {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly is_secure: boolean;
    readonly is_http_only: boolean;
    /** Unix **seconds**; omit for a session cookie. */
    readonly expires?: number | undefined;
}

export interface WebPaneCommands {
    /** URL bar submit. The daemon normalizes the raw text (§4.1), so send it verbatim. */
    navigate(paneID: string, url: string): Promise<CommandReply>;
    back(paneID: string): Promise<CommandReply>;
    forward(paneID: string): Promise<CommandReply>;
    reload(paneID: string, hard?: boolean): Promise<CommandReply>;
    /** `+` button: a blank tab, focused (§5). */
    newTab(paneID: string, url?: string): Promise<CommandReply>;
    /** Tab ref is a tab UUID or a numeric index, exactly as the CLI accepts (§5.1). */
    selectTab(paneID: string, tabRef: string): Promise<CommandReply>;
    closeTab(paneID: string, tabRef: string): Promise<CommandReply>;
    /**
     * WEB-016: the tab strip's drag reorder. `order` must be an exact permutation of the pane's
     * tabs — the daemon drops anything else whole rather than truncating the strip.
     */
    reorderTabs(paneID: string, order: readonly string[]): Promise<CommandReply>;
    /** WEB-032: the reload button's ✕ half — stop the load that is in flight. */
    stop(paneID: string, tabID?: string | null): Promise<CommandReply>;
    /**
     * WEB-043: hand keyboard focus to the page.
     *
     * Sent only when no chrome text field has the caret — the URL-bar exemption lives at the
     * call site (`WebPane.tsx`), exactly as the Swift `claimFirstResponder` guard did.
     */
    focusView(paneID: string, tabID?: string | null): Promise<CommandReply>;
    /** `</>`: toggle the docked inspector for the pane's active tab. */
    toggleDevTools(paneID: string, tabID?: string | null): Promise<CommandReply>;

    // ── find (§10) ──────────────────────────────────────────────────────────
    /**
     * Drive the page's find. `tabID` is explicit because the reply carries it back: a count that
     * arrives for a tab that is no longer active is stale and must be dropped (WEB-063).
     */
    find(paneID: string, tabID: string, op: WebFindOp, needle?: string): Promise<CommandReply>;

    // ── zoom (§4.2) ─────────────────────────────────────────────────────────
    zoom(paneID: string, tabID: string, direction: WebZoomDirection): Promise<CommandReply>;

    // ── private mode (§6) ───────────────────────────────────────────────────
    /** Flipping the flag destroys and rebuilds the pane's views against the other store. */
    setPrivate(paneID: string, isPrivate: boolean): Promise<CommandReply>;

    // ── batch element pickup (§12) ──────────────────────────────────────────
    batchState(paneID: string): Promise<CommandReply>;
    /** The three-way scope button: start / hide / show (WEB-126). */
    batchToggle(paneID: string): Promise<CommandReply>;
    batchCancel(paneID: string): Promise<CommandReply>;
    batchRemove(paneID: string, itemID: string): Promise<CommandReply>;
    batchComment(paneID: string, itemID: string, comment: string, tabID?: string | null): Promise<CommandReply>;
    batchFocus(paneID: string, itemID: string | null, origin: 'panel' | 'page'): Promise<CommandReply>;
    /** `sendTo === null` queues the items for `kelpi web inspect-result` instead (WEB-135). */
    batchSend(paneID: string, sendTo: string | null): Promise<CommandReply>;

    // ── cookies / storage (§13.2) ───────────────────────────────────────────
    cookiesList(paneID: string): Promise<CommandReply>;
    cookieDelete(paneID: string, name: string, domain?: string | undefined): Promise<CommandReply>;
    /** `domain` absent + `all` true = every site-data type (WEB-054). */
    cookiesClear(paneID: string, scope: { all?: boolean; domain?: string | undefined }): Promise<CommandReply>;
    cookieSet(
        paneID: string,
        cookie: WebCookieWrite,
        original?: { name: string; domain: string; path?: string | undefined } | undefined
    ): Promise<CommandReply>;
    /** localStorage read-out: `web exec` against the page, so no new host verb is needed. */
    exec(paneID: string, script: string): Promise<CommandReply>;

    // ── favourites (§14) ────────────────────────────────────────────────────
    favouritesList(): Promise<CommandReply>;
    favouriteToggle(url: string, title: string): Promise<CommandReply>;
    favouriteRemove(id: string): Promise<CommandReply>;
    favouriteRename(id: string, title: string): Promise<CommandReply>;
    favouriteMove(from: number, to: number): Promise<CommandReply>;
}

export function createWebPaneCommands(sender: WebCommandSender): WebPaneCommands {
    return {
        navigate: (paneID, url) => sender.raw({ command: 'web-navigate', pane_id: paneID, url }),
        back: (paneID) => sender.raw({ command: 'web-back', pane_id: paneID }),
        forward: (paneID) => sender.raw({ command: 'web-forward', pane_id: paneID }),
        reload: (paneID, hard = false) =>
            sender.raw({ command: 'web-reload', pane_id: paneID, ...(hard ? { hard: true } : {}) }),
        newTab: (paneID, url = '') =>
            sender.raw({ command: 'web-tab-new', pane_id: paneID, url, make_active: true }),
        selectTab: (paneID, tabRef) =>
            sender.raw({ command: 'web-tab-select', pane_id: paneID, tab: tabRef }),
        closeTab: (paneID, tabRef) => sender.raw({ command: 'web-tab-close', pane_id: paneID, tab: tabRef }),
        reorderTabs: (paneID, order) =>
            sender.raw({ command: 'web-tab-reorder', pane_id: paneID, order: [...order] }),
        stop: (paneID, tabID) =>
            sender.raw({
                command: 'web-stop',
                pane_id: paneID,
                ...(tabID === undefined || tabID === null ? {} : { tab_id: tabID })
            }),
        focusView: (paneID, tabID) =>
            sender.raw({
                command: 'web-focus-view',
                pane_id: paneID,
                ...(tabID === undefined || tabID === null ? {} : { tab_id: tabID })
            }),
        toggleDevTools: (paneID, tabID) =>
            sender.raw({
                command: 'web-devtools',
                pane_id: paneID,
                ...(tabID === undefined || tabID === null ? {} : { tab_id: tabID })
            }),

        find: (paneID, tabID, op, needle = '') =>
            sender.raw({ command: 'web-find', pane_id: paneID, tab_id: tabID, action: op, needle }),

        zoom: (paneID, tabID, direction) =>
            sender.raw({ command: 'web-zoom', pane_id: paneID, tab_id: tabID, direction }),

        setPrivate: (paneID, isPrivate) =>
            sender.raw({ command: 'web-private', pane_id: paneID, private: isPrivate }),

        batchState: (paneID) => sender.raw({ command: 'web-batch-state', pane_id: paneID }),
        batchToggle: (paneID) => sender.raw({ command: 'web-batch-toggle', pane_id: paneID }),
        batchCancel: (paneID) => sender.raw({ command: 'web-batch-cancel', pane_id: paneID }),
        batchRemove: (paneID, itemID) =>
            sender.raw({ command: 'web-batch-remove', pane_id: paneID, item_id: itemID }),
        batchComment: (paneID, itemID, comment, tabID) =>
            sender.raw({
                command: 'web-batch-comment',
                pane_id: paneID,
                item_id: itemID,
                comment,
                ...(tabID === undefined || tabID === null ? {} : { tab_id: tabID })
            }),
        batchFocus: (paneID, itemID, origin) =>
            sender.raw({
                command: 'web-batch-focus',
                pane_id: paneID,
                origin,
                ...(itemID === null ? {} : { item_id: itemID })
            }),
        batchSend: (paneID, sendTo) =>
            sender.raw({
                command: 'web-batch-send',
                pane_id: paneID,
                ...(sendTo === null ? {} : { send_to: sendTo })
            }),

        cookiesList: (paneID) => sender.raw({ command: 'web-cookies-list', pane_id: paneID }),
        cookieDelete: (paneID, name, domain) =>
            sender.raw({
                command: 'web-cookies-delete',
                pane_id: paneID,
                name,
                ...(domain === undefined || domain === '' ? {} : { domain })
            }),
        cookiesClear: (paneID, scope) =>
            sender.raw({
                command: 'web-cookies-clear',
                pane_id: paneID,
                ...(scope.all === true ? { all: true } : {}),
                ...(scope.domain === undefined || scope.domain === '' ? {} : { domain: scope.domain })
            }),
        cookieSet: (paneID, cookie, original) =>
            sender.raw({
                command: 'web-cookie-set',
                pane_id: paneID,
                cookie: {
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    is_secure: cookie.is_secure,
                    is_http_only: cookie.is_http_only,
                    ...(cookie.expires === undefined ? {} : { expires: cookie.expires })
                },
                ...(original === undefined
                    ? {}
                    : {
                          original: {
                              name: original.name,
                              domain: original.domain,
                              ...(original.path === undefined ? {} : { path: original.path })
                          }
                      })
            }),
        exec: (paneID, script) => sender.raw({ command: 'web-exec', pane_id: paneID, script }),

        favouritesList: () => sender.raw({ command: 'web-favourites-list' }),
        favouriteToggle: (url, title) =>
            sender.raw({ command: 'web-favourite-toggle', url, title }),
        favouriteRemove: (id) => sender.raw({ command: 'web-favourite-remove', id }),
        favouriteRename: (id, title) => sender.raw({ command: 'web-favourite-rename', id, title }),
        favouriteMove: (from, to) => sender.raw({ command: 'web-favourite-move', from, to })
    };
}
