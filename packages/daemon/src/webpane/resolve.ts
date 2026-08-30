/**
 * Web-pane scope resolution (web-pane.md §8.1).
 *
 * Every `web-*` command except `web-open` carries the shared pane-target scope
 * (`pane_id` / `target` / `workspace`), resolved by the same `resolvePaneTarget` the `pane-*`
 * family uses — so a UUID target is global, a label target needs a scope, and every error
 * string is the resolver's verbatim (it is wire contract).
 *
 * `resolveWebPane` then layers the web-specific checks, each its own `ok:false` error:
 *   `pane not found: <uuid>` · `pane is not a web pane (type: shell)` ·
 *   `web pane state missing for <uuid>` — the last one is an invariant violation (§17.3), not
 *   a user error: `webPanes[paneID]` exists iff the pane exists with type web.
 *
 * Commands that touch the active tab additionally fail with `web pane has no active tab`.
 */

import type { Pane } from '@kelpi/core/layout';
import { resolvePaneTarget } from '@kelpi/core/resolve';

import {
    resolveStateOf,
    visiblePane,
    workspaceByID,
    type DaemonState,
    type WebPaneState,
    type WebTab,
    type WorkspaceState
} from '../store/index.js';
import { resolvedActiveTab } from '../store/reducers/web.js';

export const NO_ACTIVE_TAB_ERROR = 'web pane has no active tab';

export interface WebScopeFields {
    readonly pane_id?: string | undefined;
    readonly target?: string | undefined;
    readonly workspace?: string | undefined;
}

export interface ResolvedWebPane {
    readonly paneID: string;
    readonly pane: Pane;
    readonly workspace: WorkspaceState;
    readonly web: WebPaneState;
    /** §17.2: `activeTabID` with the `tabs[0]` fallback; null only for a tab-less pane. */
    readonly activeTab: WebTab | null;
}

export type WebPaneResolution =
    | { readonly ok: true; readonly target: ResolvedWebPane }
    | { readonly ok: false; readonly error: string };

export function resolveWebPane(state: DaemonState, fields: WebScopeFields): WebPaneResolution {
    const resolution = resolvePaneTarget(resolveStateOf(state), {
        paneID: fields.pane_id,
        target: fields.target,
        workspaceFilter: fields.workspace
    });
    if (!resolution.ok) return { ok: false, error: resolution.error };

    const workspace = workspaceByID(state, resolution.workspace.id);
    if (workspace === null) return { ok: false, error: `pane not found: ${resolution.paneID}` };
    const pane = visiblePane(workspace, resolution.paneID);
    if (pane === null) return { ok: false, error: `pane not found: ${resolution.paneID}` };
    if (pane.type !== 'web') {
        return { ok: false, error: `pane is not a web pane (type: ${pane.type})` };
    }
    const web = workspace.webPanes[resolution.paneID];
    if (web === undefined) {
        return { ok: false, error: `web pane state missing for ${resolution.paneID}` };
    }
    return {
        ok: true,
        target: {
            paneID: resolution.paneID,
            pane,
            workspace,
            web,
            activeTab: resolvedActiveTab(web)
        }
    };
}

export type TabRefResolution =
    | { readonly ok: true; readonly tab: WebTab; readonly index: number }
    | { readonly ok: false; readonly error: string };

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * §5.1 `tabRef`: a UUID must name a tab of THIS pane, otherwise an integer is a 0-based index
 * into the tab list, otherwise the ref is rejected. The three error strings are contract.
 */
export function resolveTabRef(web: WebPaneState, ref: string): TabRefResolution {
    if (UUID_PATTERN.test(ref)) {
        const index = web.tabs.findIndex((tab) => tab.id.toLowerCase() === ref.toLowerCase());
        if (index < 0) return { ok: false, error: `no tab with UUID '${ref}' in this web pane` };
        return { ok: true, tab: web.tabs[index] as WebTab, index };
    }
    if (/^\d+$/.test(ref)) {
        const index = Number.parseInt(ref, 10);
        const tab = web.tabs[index];
        if (tab === undefined) {
            return {
                ok: false,
                error: `tab index ${String(index)} out of range (0..<${String(web.tabs.length)})`
            };
        }
        return { ok: true, tab, index };
    }
    return { ok: false, error: `tab ref must be a UUID or numeric index, got '${ref}'` };
}
