/**
 * `WebPaneService` — the daemon's web-pane runtime: the host RPC seam, the per-pane console
 * ring buffers, and the element-picker arm/queue. One instance per daemon; `boot/compose.ts`
 * hands it to both the `web-*` command handlers and the WS sync hub (the hub is where a host
 * registers and where host events arrive).
 *
 * State ownership, restated because it is the whole design:
 *   - **daemon** — which panes are web panes, their tab lists, the active tab, the private
 *     flag (all in the store's `webPanes` sidecar, all persisted), plus the transient console
 *     buffers and inspector arms kept here;
 *   - **host** (Electron shell) — the actual browser views, cookies, page JS.
 *
 * So the daemon answers state questions with no host attached (`web tabs`, `web console`),
 * mirrors state changes to the host as fire-and-forget notifications, and forwards anything
 * that needs a live page as an awaited RPC — failing honestly with `no web pane host
 * connected` when nobody is there.
 */

import type { BrowserInspectionSnapshot, JsonObject } from '@kelpi/protocol';

import type { DomainStore } from '../seams.js';
import { findPaneAnywhere, workspaceByID } from '../store/derived.js';
import { resolvedActiveTab } from '../store/reducers/web.js';
import type { DaemonState, DomainAction, DomainEvent, WebPaneState } from '../store/types.js';
import {
    createConsoleStore,
    normalizeConsoleLevel,
    type ConsoleStore,
    type ConsoleSubscriber
} from './console.js';
import { GEOMETRY_NOTIFY_VERB, geometryNotifyArgs, type GeometryReportInput } from './geometry.js';
import {
    createHostRegistry,
    NO_HOST_ERROR,
    type HostCallOptions,
    type HostRegistration,
    type HostRegistry,
    type HostTransport
} from './host.js';
import { NO_ACTIVE_TAB_ERROR } from './resolve.js';
import {
    batchMarkerInputs,
    createBatchState,
    formatBatchForPaste,
    type BatchSession,
    type BatchState
} from './batch.js';
import {
    createFavouritesStore,
    type Favourite,
    type FavouritesStore,
    type FavouritesStoreOptions
} from './favourites.js';
import { createWebFindState, type WebFindAction, type WebFindState } from './find.js';
import {
    createInspectState,
    formatForPaste,
    sanitizeInspectPayload,
    type InspectState
} from './inspect.js';

export type WebDomainStore = DomainStore<DaemonState, DomainAction, DomainEvent>;

/** One host → daemon event, already unwrapped from its WS envelope. */
export interface HostEventInput {
    readonly event: string;
    readonly paneID: string;
    readonly tabID?: string | undefined;
    readonly payload: Record<string, unknown>;
}

/** Paste sink for `kelpi web inspect --send-to` (boot binds it to `TerminalInput.sendText`). */
export type WebPastePort = (paneID: string, text: string, options: { submit: boolean }) => void;

export interface WebPaneServiceOptions {
    /** Absent = no pane lifecycle mirroring and no host state sync (unit tests). */
    readonly store?: WebDomainStore | undefined;
    readonly paste?: WebPastePort | undefined;
    readonly now?: (() => number) | undefined;
    readonly newID?: (() => string) | undefined;
    readonly nonce?: (() => string) | undefined;
    readonly consoleCapacity?: number | undefined;
    readonly onError?: ((error: Error, context: string) => void) | undefined;
    /**
     * Where `favourites.json` lives (`./favourites.ts`). Absent = in-memory only, which is what
     * every unit test wants and what a daemon with no writable state dir falls back to.
     */
    readonly favourites?: Pick<FavouritesStoreOptions, 'path' | 'readFile' | 'writeFile'> | undefined;
    /** A batch session changed: the sync hub fans it out to attached clients. */
    readonly onBatchChanged?: ((paneID: string, session: BatchSession | null) => void) | undefined;
    /** The favourites list changed (a star toggle, a rename, a reorder). */
    readonly onFavouritesChanged?: ((favourites: readonly Favourite[]) => void) | undefined;
    /**
     * WEB-032/WEB-033/WEB-034: a tab's live loading + history state, per tab.
     *
     * Ephemeral by nature — it is the browser's opinion at this instant, not persisted state and
     * not a `DomainEvent` — so it takes the same route the batch session does: its own
     * broadcast, keyed by pane AND tab so a client can snap the strip to whichever tab is
     * active (WEB-034) instead of stranding a frozen bar from a tab left mid-load.
     */
    readonly onNavStateChanged?: ((state: WebNavState) => void) | undefined;
    /**
     * §N29: the user gave a pane's PAGE keyboard focus — a click inside the native view.
     *
     * The daemon does not move focus itself. Focus is a CLIENT fact (which window, which
     * workspace is on screen in it), and the point of the fix is that a page click takes the
     * same path a terminal body click takes: the client's `focusPane`, and the ordinary
     * `report-focus` back from it. So this is a fan-out, scoped to the shell window whose host
     * reported the click exactly as `shell-activation` is scoped.
     */
    readonly onViewFocused?: ((focus: WebViewFocus) => void) | undefined;
}

/** §N29: a user's click landed in a web pane's page (host → daemon → that window's client). */
export interface WebViewFocus {
    readonly paneID: string;
    readonly workspaceID: string;
    /** The shell window whose host reported it; null when that host declared no window. */
    readonly windowID: string | null;
}

/** One tab's live loading + history state (WEB-032/WEB-033). */
export interface WebNavState {
    readonly paneID: string;
    readonly tabID: string;
    readonly loading: boolean;
    readonly canGoBack: boolean;
    readonly canGoForward: boolean;
}

/** What `sendBatch` did, so the caller can answer honestly. */
export interface BatchSendOutcome {
    readonly ok: boolean;
    readonly error?: string | undefined;
    readonly sent: number;
    /** The destination pane, or null when the items were queued for `inspect-result`. */
    readonly sendTo: string | null;
}

export interface WebPaneService {
    readonly host: HostRegistry;
    readonly console: ConsoleStore;
    readonly inspect: InspectState;
    /** Per-pane find needle memory (WEB-063…WEB-065). */
    readonly find: WebFindState;
    /** The batch "element pickup" sessions (WEB-126…WEB-145). */
    readonly batch: BatchState;
    /** The saved-URL list behind the URL bar's star (WEB-037…WEB-046). */
    readonly favourites: FavouritesStore;
    /** True when a host is attached (handlers use it to answer `no web pane host connected`). */
    readonly hasHost: boolean;
    /** Last host navigation report for a current tab, available immediately on attach. */
    navState(paneID: string, tabID: string): WebNavState | null;
    /** Native view/session incarnation. Changes on private toggle, rebuild and pane reuse. */
    pageGeneration(paneID: string): number;
    /** One tab incarnation, including close/reopen with a reused id. */
    tabGeneration(paneID: string, tabID: string): number;
    /** Bounded metadata for live inspector/batch changes, excluding captured page payloads. */
    inspectionState(paneID: string): BrowserInspectionSnapshot;
    /** Pane changes; null means host availability or the shared favourites changed. */
    subscribeState(listener: (paneID: string | null) => void): () => void;
    /**
     * Drive the page's `__kelpiWebFind` on `tabID` and remember (or forget) the needle.
     *
     * The reply always names the tab it was measured on, so a consumer can drop a count that
     * arrived for a tab that is no longer active (WEB-063) — the failure that motivates it is an
     * outgoing tab's `clear()` racing the incoming tab's `search()` during a tab switch.
     */
    runFind(
        paneID: string,
        tabID: string,
        action: WebFindAction,
        needle: string,
        signal?: AbortSignal
    ): Promise<JsonObject>;
    /**
     * WEB-064: a tab switch (or close) while the bar is open. The outgoing tab is cleared and
     * the remembered needle re-runs on the incoming one. No-op when no find is open.
     */
    retargetFind(paneID: string, nextTabID: string | null): void;
    /**
     * §WEB-019: a tab was destroyed — drop the per-tab daemon state that outlives it. Today
     * that is the inspector arm (the only thing keyed by tab rather than pane that is not
     * already torn down with the tab object). A no-op when nothing was armed on that tab.
     */
    forgetTab(paneID: string, tabID: string): void;
    /**
     * §5.2 / issue #76: ask the host to build this pane's views again and mark its tabs live.
     *
     * The recovery for a dead renderer, reached automatically once per `AUTO_REBUILD_WINDOW_MS`
     * and by the user's Reload with no limit at all. False when the pane is not a web pane (or
     * the service has no store), which is the caller's cue to answer the ordinary way.
     */
    rebuildPane(paneID: string): boolean;
    /**
     * Arm the page picker STICKY for a batch (WEB-127): unlike `kelpi web inspect`, the arm is not
     * consumed by the first pick, so the user keeps clicking elements into the panel.
     */
    armBatch(paneID: string): Promise<JsonObject>;
    /** Push the pane's current batch onto the page (badges) and out to clients. */
    publishBatch(paneID: string): BatchSession | null;
    /** Focus one item: page ring + badge pulse, and a scroll only for a panel-origin focus. */
    focusBatchItem(paneID: string, itemID: string | null, origin: 'panel' | 'page'): BatchSession | null;
    /**
     * WEB-134/WEB-135: paste the batch into a shell pane (or queue it locally when `sendTo` is
     * null), then tear the session down — items cleared, picker disarmed, markers gone.
     */
    sendBatch(paneID: string, sendTo: string | null): BatchSendOutcome;
    /** WEB-136: drop the session, disarm the picker, clear the markers. */
    cancelBatch(paneID: string): void;
    /** Claim the web-pane host role for this connection, and replay pane state onto it. */
    registerHost(
        transport: HostTransport,
        options?: { name?: string | undefined; windowID?: string | undefined }
    ): HostRegistration;
    /** Route a `host-rpc-reply`. */
    settleHostReply(id: string, reply: JsonObject): void;
    /** Route a `host-event` (console line, URL/title change, picked element, closed tab). */
    handleHostEvent(event: HostEventInput): void;
    /** Await one host RPC; resolves to a failure envelope instead of rejecting. */
    call(verb: string, args: JsonObject, options?: HostCallOptions): Promise<JsonObject>;
    /** Fire-and-forget mirror of daemon-owned state. */
    notify(verb: string, args: JsonObject): void;
    /**
     * Forward one client `web-geometry-report` to the host as `pane-geometry` (§3.1).
     *
     * Silently dropped when there is no host (there are no views to move) or when the pane is
     * not a web pane — a client that reports geometry for something else is confused, and a
     * stream of them must not become host traffic.
     */
    notifyGeometry(report: GeometryReportInput): void;
    subscribeConsole(paneID: string, subscriber: ConsoleSubscriber): () => void;
    close(): void;
}

/**
 * How long an automatic rebuild locks out the next one, per pane (§5.2, issue #76).
 *
 * The shape of the failure this bounds is a page that crashes its renderer AS IT LOADS: rebuild
 * it and it dies again, immediately, for ever. One automatic recovery is worth having (a
 * one-off renderer death, an OS memory reclaim, a GPU restart is invisible to the user and the
 * page simply comes back); a second one inside the window is evidence the page itself is the
 * problem, and the honest answer to that is the card with a Reload button on it. Thirty seconds
 * is long enough that no crash-on-load can beat it and short enough that a page which crashed
 * once this morning still recovers by itself this afternoon.
 */
export const AUTO_REBUILD_WINDOW_MS = 30_000;

function paneStateArgs(paneID: string, web: WebPaneState): JsonObject {
    const active = resolvedActiveTab(web);
    return {
        paneID,
        isPrivate: web.isPrivate,
        activeTabID: active?.id ?? null,
        tabs: web.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title }))
    };
}

export function createWebPaneService(options: WebPaneServiceOptions = {}): WebPaneService {
    const now = options.now ?? ((): number => Date.now());
    const store = options.store;
    const consoleStore = createConsoleStore(
        options.consoleCapacity !== undefined ? { capacity: options.consoleCapacity } : {}
    );
    const inspectState = createInspectState({ ...(options.nonce !== undefined ? { nonce: options.nonce } : {}), onChange: paneID => inspectionChanged(paneID) });
    const findState = createWebFindState();
    const batchState = createBatchState({ onChange: paneID => inspectionChanged(paneID) });
    const newID = options.newID ?? ((): string => `${String(now())}-${Math.random().toString(16).slice(2)}`);
    const stateListeners = new Set<(paneID: string | null) => void>();
    const navStates = new Map<string, Map<string, WebNavState>>();
    const pages = new Map<string, { workspaceID: string; createdAt: number; web: WebPaneState; generation: number }>();
    const tabGenerations = new Map<string, Map<string, number>>();
    const inspectionRevisions = new Map<string, number>();
    let nextInspectionRevision = 0;
    let nextPageGeneration = 0;
    const findRequests = new Map<string, { latest: object | null; query: object | null }>();
    const stateChanged = (paneID: string | null): void => {
        for (const listener of stateListeners) {
            try { listener(paneID); } catch (error) { options.onError?.(error instanceof Error ? error : new Error(String(error)), 'browser-state'); }
        }
    };
    const inspectionChanged = (paneID: string): void => {
        // State can also be used without real panes in unit tests. Only retain live ids.
        if (!pages.has(paneID)) return;
        inspectionRevisions.set(paneID, ++nextInspectionRevision);
        stateChanged(paneID);
    };

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const host = createHostRegistry({
        ...(options.newID !== undefined ? { newID: options.newID } : {}),
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
        onHostChanged: () => {
            navStates.clear(); findRequests.clear();
            // The nonce belongs to a picker installed in the previous host's document.
            // Keep collected results and batch items, but never accept picks from that arm.
            for (const paneID of pages.keys()) inspectState.disarm(paneID);
            stateChanged(null);
        }
    });

    const favouritesStore = createFavouritesStore({
        ...(options.favourites?.path === undefined ? {} : { path: options.favourites.path }),
        ...(options.favourites?.readFile === undefined ? {} : { readFile: options.favourites.readFile }),
        ...(options.favourites?.writeFile === undefined ? {} : { writeFile: options.favourites.writeFile }),
        ...(options.newID !== undefined ? { uuid: options.newID } : {}),
        now,
        ...(options.onError !== undefined ? { onError: options.onError } : {}),
        onChange: favourites => { options.onFavouritesChanged?.(favourites); stateChanged(null); }
    });

    /** Web panes the host has been told about, so a re-render does not re-announce them. */
    const announced = new Set<string>();

    /** §5.2: when each pane was last rebuilt, so a page that dies on load cannot loop. */
    const rebuiltAt = new Map<string, number>();

    const webPaneOf = (paneID: string): { workspaceID: string; web: WebPaneState } | null => {
        if (store === undefined) return null;
        const state = store.getState();
        const location = findPaneAnywhere(state, paneID);
        if (location === null) return null;
        const workspace = workspaceByID(state, location.workspaceID);
        if (workspace === null) return null;
        const web = workspace.webPanes[paneID];
        if (web === undefined) return null;
        return { workspaceID: workspace.id, web };
    };

    /** The pane's active tab id, or '' when it has none (every host verb wants one). */
    const activeTabOf = (paneID: string): string => {
        const found = webPaneOf(paneID);
        if (found === null) return '';
        return resolvedActiveTab(found.web)?.id ?? '';
    };

    const trackPages = (): void => {
        if (!store) return;
        const live = new Set<string>();
        for (const workspace of store.getState().workspaces) for (const pane of workspace.panes) {
            const web = workspace.webPanes[pane.id];
            if (pane.type !== 'web' || !web) continue;
            live.add(pane.id);
            const previous = pages.get(pane.id);
            if (previous?.web === web && previous.createdAt === pane.createdAt && previous.workspaceID === workspace.id) continue;
            const replaced = !previous || previous.createdAt !== pane.createdAt || previous.web.isPrivate !== web.isPrivate
                || previous.web.tabs.some(tab => tab.live !== false && web.tabs.find(next => next.id === tab.id)?.live === false);
            pages.set(pane.id, { workspaceID: workspace.id, createdAt: pane.createdAt, web, generation: replaced ? ++nextPageGeneration : previous.generation });
            const tabIDs = replaced ? new Map<string, number>() : tabGenerations.get(pane.id) ?? new Map<string, number>();
            for (const tab of web.tabs) if (!tabIDs.has(tab.id)) tabIDs.set(tab.id, ++nextPageGeneration);
            for (const tabID of tabIDs.keys()) if (!web.tabs.some(tab => tab.id === tabID)) tabIDs.delete(tabID);
            tabGenerations.set(pane.id, tabIDs);
            if (replaced) { navStates.delete(pane.id); findRequests.delete(pane.id); inspectState.disarm(pane.id); }
            else for (const id of navStates.get(pane.id)?.keys() ?? []) if (!web.tabs.some(tab => tab.id === id)) navStates.get(pane.id)?.delete(id);
            stateChanged(pane.id);
        }
        for (const paneID of pages.keys()) if (!live.has(paneID)) {
            pages.delete(paneID); tabGenerations.delete(paneID); navStates.delete(paneID); findRequests.delete(paneID); inspectionRevisions.delete(paneID); stateChanged(paneID);
        }
    };
    trackPages();

    // ── batch element pickup (§12) ──────────────────────────────────────────

    /**
     * Push the pane's batch to both ends: the page's numbered badges (the diff-rebuild in
     * `__kelpiBatchSetMarkers`) and every attached client. A hidden batch syncs an EMPTY marker
     * set — its items live on in daemon state, but the page shows nothing (WEB-127).
     */
    const publishBatch = (paneID: string): BatchSession | null => {
        const session = batchState.sessionOf(paneID);
        const tabID = activeTabOf(paneID);
        if (tabID !== '') {
            const items = session === null ? [] : batchMarkerInputs(session);
            if (items.length === 0) host.notify('batch-clear', { paneID, tabID });
            else host.notify('batch-markers', { paneID, tabID, items });
        }
        options.onBatchChanged?.(paneID, session);
        return session;
    };

    const disarmPicker = (paneID: string): void => {
        inspectState.disarm(paneID);
        host.notify('inspect-disarm', { paneID });
    };

    /**
     * §WEB-019: a destroyed tab takes its inspector arm with it.
     *
     * The Swift drops the arm inside `destroyTab` because the arm's listeners lived in that
     * WKWebView. Here the arm is daemon state, so an arm left on a closed tab outlives its page
     * and is merely INERT — every inbound payload is checked against `arm.tabID`. Inert is not
     * gone: `kelpi web inspect` would still report an arm that can never fire, and a `--send-to`
     * arm would wait forever. Both tab-close paths (the verb and a page-initiated close) call
     * this. No `inspect-disarm` notify: it would address a tab the host has already destroyed.
     */
    const forgetTab = (paneID: string, tabID: string): void => {
        const arm = inspectState.armOf(paneID);
        if (arm === null || arm.tabID !== tabID) return;
        inspectState.disarm(paneID);
    };

    // ── find (§10) ──────────────────────────────────────────────────────────

    const callFind = (paneID: string, tabID: string, action: WebFindAction, needle: string): Promise<JsonObject> =>
        host.call('find', { paneID, tabID, action, needle });

    /** WEB-065: a load rebuilt the DOM *and* `window.__kelpiWebFind`, so re-mark the needle. */
    const reapplyFind = (paneID: string, tabID: string): void => {
        const session = findState.sessionOf(paneID);
        if (session === null || session.tabID !== tabID) return;
        void callFind(paneID, tabID, 'search', session.needle);
    };

    /** Replay every known web pane onto a freshly registered host (it starts empty). */
    const syncHost = (): void => {
        if (store === undefined) return;
        announced.clear();
        for (const workspace of store.getState().workspaces) {
            for (const pane of workspace.panes) {
                if (pane.type !== 'web') continue;
                const web = workspace.webPanes[pane.id];
                if (web === undefined) continue;
                announced.add(pane.id);
                host.notify('pane-open', paneStateArgs(pane.id, web));
            }
        }
        // A new host starts with blank pages: anything the daemon is still holding open — a
        // batch's badges, an armed picker's needle — has to be pushed back onto them.
        for (const paneID of batchState.panes()) publishBatch(paneID);
    };

    // Pane lifecycle mirroring: a web pane the GUI/CLI created must materialise in the host,
    // and a closed pane must take its browser views, console buffer and picker arm with it.
    const unsubscribe =
        store === undefined
            ? (): void => {}
            : store.subscribe((events) => {
                  trackPages();
                  for (const event of events) {
                      if (event.kind === 'pane-removed') {
                          // A workspace move emits removal from the old workspace before its
                          // upsert in the new one. The final state still owns the same page.
                          if (pages.has(event.paneID)) continue;
                          consoleStore.disposePane(event.paneID);
                          inspectState.disposePane(event.paneID);
                          findState.disposePane(event.paneID);
                          batchState.disposePane(event.paneID);
                          rebuiltAt.delete(event.paneID);
                          if (announced.delete(event.paneID)) {
                              host.notify('pane-close', { paneID: event.paneID });
                          }
                          continue;
                      }
                      if (event.kind !== 'pane-upserted') continue;
                      if (event.pane.type !== 'web') continue;
                      if (announced.has(event.paneID)) continue;
                      const found = webPaneOf(event.paneID);
                      if (found === null) continue;
                      announced.add(event.paneID);
                      host.notify('pane-open', paneStateArgs(event.paneID, found.web));
                  }
              });

    // ── rebuilding a pane whose renderer died (§5.2, issue #76) ─────────────

    /**
     * Ask the host to build this pane's views again, at the URLs the daemon holds.
     *
     * There is no new verb for it: `pane-open` is idempotent by contract (HOST_PROTOCOL §1) and
     * the host's registry already creates a view for any tab in the spec it does not hold
     * (`shell/src/webhost/registry.ts` ▸ `openPane`), which is the same reconcile that rebuilds
     * every pane when a shell reconnects. So a rebuild is one notify.
     *
     * The tab is marked live again HERE rather than when the page next reports a URL: a rebuilt
     * view that lands on a dead host shows Kelpi's own error card (§4.3) and never emits a
     * `page-state`, and leaving the "stopped responding" card over a perfectly good error card
     * would be a worse lie than optimism. If the new renderer dies too, the next `tab-closed`
     * marks it not-live again within milliseconds and the loop guard keeps the card up.
     */
    const rebuildPane = (paneID: string): boolean => {
        if (store === undefined) return false;
        const found = webPaneOf(paneID);
        if (found === null) return false;
        const page = pages.get(paneID);
        if (page) pages.set(paneID, { ...page, generation: ++nextPageGeneration });
        navStates.delete(paneID); findRequests.delete(paneID);
        inspectState.disarm(paneID);
        rebuiltAt.set(paneID, now());
        for (const tab of found.web.tabs) {
            if (tab.live !== false) continue;
            store.dispatch({
                type: 'web-tab-live',
                workspaceID: found.workspaceID,
                paneID,
                tabID: tab.id,
                live: true
            });
        }
        // Re-read: the dispatches above replaced the sidecar, and the host must be handed the
        // tabs as they are now, not as they were before the flag came off.
        const refreshed = webPaneOf(paneID);
        if (refreshed === null) return false;
        announced.add(paneID);
        host.notify('pane-open', paneStateArgs(paneID, refreshed.web));
        stateChanged(paneID);
        return true;
    };

    /**
     * One automatic rebuild per pane per window. The user's Reload is never rate-limited: it is
     * a person asking, and a person who asks twice means it.
     */
    const mayAutoRebuild = (paneID: string): boolean => {
        const last = rebuiltAt.get(paneID);
        return last === undefined || now() - last >= AUTO_REBUILD_WINDOW_MS;
    };

    // ── host events ─────────────────────────────────────────────────────────

    const consoleEvent = (event: HostEventInput): void => {
        const payload = event.payload;
        const message = typeof payload['message'] === 'string' ? payload['message'] : '';
        const url = typeof payload['url'] === 'string' ? payload['url'] : '';
        const rawLevel = typeof payload['level'] === 'string' ? payload['level'] : 'log';
        const lineNumber = payload['line'] ?? payload['lineNumber'];
        const columnNumber = payload['column'] ?? payload['columnNumber'];
        const found = webPaneOf(event.paneID);
        const tabID = event.tabID ?? (found === null ? '' : (resolvedActiveTab(found.web)?.id ?? ''));
        consoleStore.append(event.paneID, {
            tabID,
            level: normalizeConsoleLevel(rawLevel),
            message,
            url,
            capturedAt: now(),
            ...(typeof lineNumber === 'number' ? { lineNumber } : {}),
            ...(typeof columnNumber === 'number' ? { columnNumber } : {})
        });
    };

    const pageStateEvent = (event: HostEventInput): void => {
        if (event.tabID === undefined) return;
        const tabID = event.tabID;
        const url = event.payload['url'];
        const title = event.payload['title'];
        if (store !== undefined) {
            const found = webPaneOf(event.paneID);
            if (found !== null) {
                store.dispatch({
                    type: 'web-tab-state',
                    workspaceID: found.workspaceID,
                    paneID: event.paneID,
                    tabID,
                    ...(typeof url === 'string' ? { url } : {}),
                    ...(typeof title === 'string' ? { title } : {})
                });
            }
        }
        // A URL change means a completed navigation: the document (and the find script's state)
        // is new, so a still-open find re-marks itself, and the batch's badges are re-pushed
        // against the new DOM. Both are no-ops when nothing is open (WEB-065, WEB-137).
        if (typeof url !== 'string') return;
        reapplyFind(event.paneID, tabID);
        if (batchState.sessionOf(event.paneID) !== null) publishBatch(event.paneID);
    };

    /**
     * WEB-032/WEB-033: mirror the host's loading + history report to whoever is drawing chrome.
     *
     * Keep one report per current tab so a replacement can draw correct chrome immediately.
     * The cache is transient and disappears with the native page/session or host.
     */
    const navStateEvent = (event: HostEventInput): void => {
        if (event.tabID === undefined || event.tabID === '') return;
        const found = webPaneOf(event.paneID);
        const currentTab = found?.web.tabs.some(tab => tab.id === event.tabID) === true;
        const state = {
            paneID: event.paneID,
            tabID: event.tabID,
            loading: event.payload['loading'] === true,
            canGoBack: event.payload['can_go_back'] === true,
            canGoForward: event.payload['can_go_forward'] === true
        };
        // A service without a store is used by protocol tests; do not retain unbounded ids.
        if (currentTab) {
            const tabs = navStates.get(event.paneID) ?? new Map<string, WebNavState>();
            tabs.set(event.tabID, state); navStates.set(event.paneID, tabs);
        }
        options.onNavStateChanged?.(state);
        if (currentTab) stateChanged(event.paneID);
    };

    /**
     * §N29: a page click. Resolved to a workspace here (the client's `focusPane` needs one, and
     * the daemon is the only party that knows which workspace holds the pane) and dropped when
     * the pane is not a live web pane — a host reporting focus for something else is confused,
     * and a stray one would yank the user's ring.
     */
    const viewFocusEvent = (event: HostEventInput): void => {
        const found = webPaneOf(event.paneID);
        if (found === null) return;
        options.onViewFocused?.({
            paneID: event.paneID,
            workspaceID: found.workspaceID,
            windowID: host.hostWindowID
        });
    };

    const inspectEvent = (event: HostEventInput): void => {
        const arm = inspectState.armOf(event.paneID);
        if (arm === null) return;
        // §17.6: a payload without the current nonce (or from a tab that is not the armed one)
        // is silently dropped — page JS can reach the host binding, the nonce is what cannot.
        const nonce = event.payload['nonce'];
        if (typeof nonce !== 'string' || nonce !== arm.nonce) return;
        const tabID = event.tabID ?? arm.tabID;
        if (tabID !== arm.tabID) return;
        if (event.payload['cancelled'] === true) {
            inspectState.disarm(event.paneID);
            // Escape inside a batch means "cancel the batch" — WEB-131's empty-state hint says
            // so out loud. (Escape while the comment popover is open belongs to the popover and
            // never reaches the picker, WEB-143.)
            if (batchState.sessionOf(event.paneID) !== null) {
                batchState.take(event.paneID);
                publishBatch(event.paneID);
            }
            return;
        }
        const result = sanitizeInspectPayload(tabID, event.payload, now());
        if (result === null) return;

        // WEB-128: a VISIBLE batch takes the pick, leaves the picker armed (it is sticky), and
        // focuses the new item with page origin — no re-scroll, the element is already under
        // the cursor. A HIDDEN batch is paused, so the single-shot path below runs instead and
        // a `web inspect --send-to` arm can take the payload.
        const session = batchState.sessionOf(event.paneID);
        if (session !== null && session.visible) {
            const item = { id: newID(), result, comment: '' };
            batchState.add(event.paneID, item);
            // Issue #50 (web-26), §12.1: a `kelpi web inspect --submit` arm whose pick the batch
            // absorbs hands its `--submit` to the session, so Send presses Enter (WEB-134).
            // The flag lived on the arm alone: Send's disarm dropped it, `setSubmit` had no
            // caller, and every batch send wrote bare. The session is the vehicle now.
            if (arm.submit) batchState.setSubmit(event.paneID, true);
            publishBatch(event.paneID);
            host.notify('batch-highlight', {
                paneID: event.paneID,
                tabID,
                itemID: item.id,
                scrollIntoView: false
            });
            return;
        }

        // Single-shot: the arm is consumed before the result is surfaced (§11.3).
        inspectState.disarm(event.paneID);
        inspectState.enqueue(event.paneID, result);
        if (arm.sendTo === null) return;
        try {
            options.paste?.(arm.sendTo, formatForPaste(result, now()), { submit: arm.submit });
        } catch (error) {
            report(error, 'inspect-paste');
        }
    };

    /**
     * The page's batch surfaces talking back (WEB-130, WEB-141, WEB-142):
     *
     *   `{id}`             a badge was clicked → focus that row, page origin (no re-scroll);
     *   `{commentChanged}` the popover textarea was typed into → store it, do NOT echo back;
     *   `{dismiss}`        Done / Escape / ⌘-Return → unfocus (the next element can be picked);
     *   `{remove}`         Remove → drop the item and re-sync the badges.
     */
    const batchMarkerEvent = (event: HostEventInput): void => {
        const payload = event.payload;
        const paneID = event.paneID;
        if (batchState.sessionOf(paneID) === null) return;

        const nested = (key: string): Record<string, unknown> | null => {
            const value = payload[key];
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
            return value as Record<string, unknown>;
        };

        const removed = nested('remove');
        if (removed !== null) {
            const itemID = typeof removed['id'] === 'string' ? removed['id'] : '';
            if (itemID === '') return;
            batchState.remove(paneID, itemID);
            publishBatch(paneID);
            return;
        }
        if (nested('dismiss') !== null) {
            batchState.focus(paneID, null);
            const tabID = event.tabID ?? activeTabOf(paneID);
            if (tabID !== '') host.notify('batch-unfocus', { paneID, tabID });
            options.onBatchChanged?.(paneID, batchState.sessionOf(paneID));
            return;
        }
        const comment = nested('commentChanged');
        if (comment !== null) {
            const itemID = typeof comment['id'] === 'string' ? comment['id'] : '';
            const text = typeof comment['comment'] === 'string' ? comment['comment'] : '';
            if (itemID === '') return;
            batchState.setComment(paneID, itemID, text);
            // Deliberately no `batch-comment` push back: the page IS the author of this edit,
            // and writing it back into a focused textarea would move the user's cursor.
            options.onBatchChanged?.(paneID, batchState.sessionOf(paneID));
            return;
        }
        const badgeID = typeof payload['id'] === 'string' ? payload['id'] : '';
        if (badgeID === '') return;
        // Page origin: the badge is already on screen, so the page must not scroll under the
        // click. The panel still moves its keyboard focus into the row's comment field.
        batchState.focus(paneID, badgeID);
        const tabID = event.tabID ?? activeTabOf(paneID);
        if (tabID !== '') {
            host.notify('batch-highlight', { paneID, tabID, itemID: badgeID, scrollIntoView: false });
        }
        options.onBatchChanged?.(paneID, batchState.sessionOf(paneID));
    };

    const tabClosedEvent = (event: HostEventInput): void => {
        if (store === undefined || event.tabID === undefined) return;
        const found = webPaneOf(event.paneID);
        if (found === null) return;
        // §WEB-019: the page closed itself; the arm it carried dies with it.
        forgetTab(event.paneID, event.tabID);
        // The reducer refuses to remove a pane's only tab (`store/reducers/web.ts`), so this is
        // the shape of the crash the user reports: chrome over nothing. Read the refusal BEFORE
        // dispatching, because after it the state looks exactly as it did.
        const sole = found.web.tabs.length === 1 && found.web.tabs[0]?.id === event.tabID;
        store.dispatch({
            type: 'web-tab-close',
            workspaceID: found.workspaceID,
            paneID: event.paneID,
            tabID: event.tabID
        });
        // A pane with other tabs needs nothing more: the reducer activated the left neighbour,
        // the host destroyed the dead view and the client's next geometry report - which names
        // the NEW active tab, so it is not a duplicate - places the neighbour. Only the sole-tab
        // pane is stuck, because nothing about it changed.
        if (!sole) return;
        if (mayAutoRebuild(event.paneID)) {
            // One free recovery, and no card for it: a renderer the OS reclaimed, or one taken
            // down by a GPU restart, comes back at its own URL and the user sees a reload. A
            // "this page stopped responding" card that vanished half a second later would be a
            // worse report of that than the reload itself.
            rebuildPane(event.paneID);
            return;
        }
        /*
         * A second death inside the window: the page is what is broken, and rebuilding it again
         * would crash, rebuild, crash for ever. So the daemon stops, marks the tab not-live, and
         * hands the decision back - §16.7's "This page stopped responding" card, whose Reload
         * runs `rebuildPane` with no rate limit at all, because a person asking twice means it.
         */
        store.dispatch({
            type: 'web-tab-live',
            workspaceID: found.workspaceID,
            paneID: event.paneID,
            tabID: event.tabID,
            live: false
        });
        report(
            new Error(
                `web pane ${event.paneID}: renderer died again within ` +
                    `${String(AUTO_REBUILD_WINDOW_MS)} ms of the last rebuild; showing the ` +
                    'stopped-responding card rather than rebuilding in a loop'
            ),
            'tab-closed'
        );
    };

    return {
        host,
        console: consoleStore,
        inspect: inspectState,
        find: findState,
        batch: batchState,
        favourites: favouritesStore,
        get hasHost() {
            return host.hasHost;
        },
        navState: (paneID, tabID) => navStates.get(paneID)?.get(tabID) ?? null,
        pageGeneration: paneID => pages.get(paneID)?.generation ?? 0,
        tabGeneration: (paneID, tabID) => tabGenerations.get(paneID)?.get(tabID) ?? 0,
        inspectionState(paneID) {
            const arm = inspectState.armOf(paneID), batch = batchState.sessionOf(paneID);
            return { revision: inspectionRevisions.get(paneID) ?? 0, armed: arm !== null, tabID: arm?.tabID ?? null,
                pendingResults: inspectState.queued(paneID).length, batchVisible: batch?.visible ?? false,
                batchItems: batch?.items.length ?? 0, batchFocusedID: batch?.focusedID ?? null };
        },
        subscribeState(listener) {
            if (stateListeners.size >= 256) throw new Error('too many browser state listeners');
            stateListeners.add(listener); return () => { stateListeners.delete(listener); };
        },

        async runFind(paneID, tabID, action, needle, signal) {
            const request = {}, generation = pages.get(paneID)?.generation, tabGeneration = tabGenerations.get(paneID)?.get(tabID), owner = host.hostID;
            const requests = findRequests.get(paneID) ?? { latest: null, query: null };
            requests.latest = request;
            // Stepping changes the current match, not the query. Its newer count must not
            // prevent an outstanding search/clear from updating the remembered needle.
            if (action === 'search' || action === 'clear') requests.query = request;
            findRequests.set(paneID, requests);
            const envelope = await host.call('find', { paneID, tabID, action, needle }, { signal });
            const current = webPaneOf(paneID);
            const active = findRequests.get(paneID) === requests;
            const latest = active && requests.latest === request, query = active && requests.query === request;
            const targetChanged = signal?.aborted || owner !== host.hostID || !active || (store && (pages.get(paneID)?.generation !== generation || tabGenerations.get(paneID)?.get(tabID) !== tabGeneration || !current?.web.tabs.some(tab => tab.id === tabID)));
            if (!targetChanged && query && envelope['ok'] === true) {
                if (action === 'clear') findState.forget(paneID);
                else if (action === 'search') findState.remember(paneID, tabID, needle);
            }
            if (latest) requests.latest = null;
            if (query) requests.query = null;
            if (active && requests.latest === null && requests.query === null) findRequests.delete(paneID);
            if (targetChanged || !latest) return { ok: false, error: 'browser find target changed', tab_id: tabID };
            // The tab rides back so a stale count (WEB-063) is recognisable as stale.
            return { ...envelope, tab_id: tabID };
        },

        forgetTab(paneID, tabID) {
            forgetTab(paneID, tabID);
        },

        rebuildPane(paneID) {
            return rebuildPane(paneID);
        },

        retargetFind(paneID, nextTabID) {
            findRequests.delete(paneID);
            const session = findState.sessionOf(paneID);
            if (session === null) return;
            // Clear the tab that is going away, then re-run on the incoming one. The clear is
            // best-effort: a closed tab has no page left to unmark.
            if (session.tabID !== '' && session.tabID !== nextTabID) {
                void callFind(paneID, session.tabID, 'clear', '');
            }
            if (nextTabID === null || nextTabID === '') {
                findState.forget(paneID);
                return;
            }
            findState.remember(paneID, nextTabID, session.needle);
            void callFind(paneID, nextTabID, 'search', session.needle);
        },

        async armBatch(paneID) {
            const tabID = activeTabOf(paneID);
            if (tabID === '') return { ok: false, error: NO_ACTIVE_TAB_ERROR };
            if (!host.hasHost) return { ok: false, error: NO_HOST_ERROR };
            const nonce = inspectState.newNonce();
            const envelope = await host.call('inspect-arm', { paneID, tabID, nonce, sticky: true });
            if (envelope['ok'] !== true) return envelope;
            inspectState.arm({ paneID, tabID, nonce, sendTo: null, submit: false });
            return { ok: true, tab_id: tabID };
        },

        publishBatch,

        focusBatchItem(paneID, itemID, origin) {
            const session = batchState.focus(paneID, itemID);
            if (session === null) return null;
            const tabID = activeTabOf(paneID);
            if (tabID !== '') {
                if (itemID === null) host.notify('batch-unfocus', { paneID, tabID });
                else {
                    // Panel-origin focus scrolls the page to the element; page-origin does not,
                    // because the user is already looking at it (WEB-130).
                    host.notify('batch-highlight', {
                        paneID,
                        tabID,
                        itemID,
                        scrollIntoView: origin === 'panel'
                    });
                }
            }
            options.onBatchChanged?.(paneID, session);
            return session;
        },

        sendBatch(paneID, sendTo) {
            const session = batchState.sessionOf(paneID);
            if (session === null) return { ok: false, error: 'no batch in progress', sent: 0, sendTo };
            const items = session.items;
            const taken = batchState.take(paneID, ...(sendTo === null ? [] : [{ rememberTarget: sendTo }]));
            const submit = taken?.submit === true;
            disarmPicker(paneID);
            publishBatch(paneID);
            // An empty batch just tears down — nothing to paste, nothing to queue (WEB-135).
            if (items.length === 0) return { ok: true, sent: 0, sendTo };
            if (sendTo === null) {
                // No destination: every item is queued for `kelpi web inspect-result` to drain,
                // with its comment stamped onto the result (the single-shot path always leaves
                // `comment` empty, so this is the only way an annotation reaches the CLI).
                for (const item of items) {
                    inspectState.enqueue(paneID, { ...item.result, comment: item.comment });
                }
                return { ok: true, sent: items.length, sendTo: null };
            }
            try {
                options.paste?.(sendTo, formatBatchForPaste(items, now()), { submit });
            } catch (error) {
                report(error, 'batch-paste');
                return { ok: false, error: 'failed to paste batch', sent: 0, sendTo };
            }
            return { ok: true, sent: items.length, sendTo };
        },

        cancelBatch(paneID) {
            batchState.take(paneID);
            disarmPicker(paneID);
            publishBatch(paneID);
        },

        registerHost(transport, registerOptions = {}) {
            const registration = host.register(transport, registerOptions);
            syncHost();
            return registration;
        },

        settleHostReply(id, reply) {
            host.settle(id, reply);
        },

        handleHostEvent(event) {
            try {
                switch (event.event) {
                    case 'console':
                        consoleEvent(event);
                        return;
                    case 'page-state':
                        pageStateEvent(event);
                        return;
                    case 'nav-state':
                        navStateEvent(event);
                        return;
                    case 'view-focus':
                        viewFocusEvent(event);
                        return;
                    case 'inspect':
                        inspectEvent(event);
                        return;
                    case 'batch-marker':
                        batchMarkerEvent(event);
                        return;
                    case 'tab-closed':
                        tabClosedEvent(event);
                        return;
                    default:
                        // Forward compatibility: a newer host may emit events we do not know.
                        return;
                }
            } catch (error) {
                report(error, `host-event ${event.event}`);
            }
        },

        call(verb, args, callOptions) {
            return host.call(verb, args, callOptions);
        },

        notify(verb, args) {
            host.notify(verb, args);
        },

        notifyGeometry(report) {
            if (!host.hasHost) return;
            // With a store attached, only real web panes are forwarded: geometry is a hot path
            // (every divider drag, every resize) and a bogus paneID would be pure host churn.
            if (store !== undefined && webPaneOf(report.paneID) === null) return;
            host.notify(GEOMETRY_NOTIFY_VERB, geometryNotifyArgs(report, host.hostWindowID));
        },

        subscribeConsole(paneID, subscriber) {
            return consoleStore.subscribe(paneID, subscriber);
        },

        close() {
            unsubscribe();
            host.close();
            consoleStore.close();
            stateListeners.clear(); navStates.clear(); pages.clear(); tabGenerations.clear(); findRequests.clear(); inspectionRevisions.clear();
        }
    };
}
