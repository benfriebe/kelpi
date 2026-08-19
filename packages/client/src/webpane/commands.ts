/**
 * The web-pane chrome's command surface.
 *
 * Every button in `./WebPane.tsx` is one control-protocol verb — the same ones `nex web …`
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

import type { JsonObject } from '@nex/protocol';

import type { CommandReply } from '../connection';

/** Anything that can put a request object on the wire — `CommandClient` satisfies it. */
export interface WebCommandSender {
    raw(payload: JsonObject): Promise<CommandReply>;
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
    /** `</>`: toggle the docked inspector for the pane's active tab. */
    toggleDevTools(paneID: string, tabID?: string | null): Promise<CommandReply>;
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
        toggleDevTools: (paneID, tabID) =>
            sender.raw({
                command: 'web-devtools',
                pane_id: paneID,
                ...(tabID === undefined || tabID === null ? {} : { tab_id: tabID })
            })
    };
}
