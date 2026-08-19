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

import type { JsonObject } from '@nex/protocol';

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
    type HostCallOptions,
    type HostRegistration,
    type HostRegistry,
    type HostTransport
} from './host.js';
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

/** Paste sink for `nex web inspect --send-to` (boot binds it to `TerminalInput.sendText`). */
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
}

export interface WebPaneService {
    readonly host: HostRegistry;
    readonly console: ConsoleStore;
    readonly inspect: InspectState;
    /** True when a host is attached (handlers use it to answer `no web pane host connected`). */
    readonly hasHost: boolean;
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
    const inspectState = createInspectState(
        options.nonce !== undefined ? { nonce: options.nonce } : {}
    );

    const report = (error: unknown, context: string): void => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)), context);
    };

    const host = createHostRegistry({
        ...(options.newID !== undefined ? { newID: options.newID } : {}),
        ...(options.onError !== undefined ? { onError: options.onError } : {})
    });

    /** Web panes the host has been told about, so a re-render does not re-announce them. */
    const announced = new Set<string>();

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
    };

    // Pane lifecycle mirroring: a web pane the GUI/CLI created must materialise in the host,
    // and a closed pane must take its browser views, console buffer and picker arm with it.
    const unsubscribe =
        store === undefined
            ? (): void => {}
            : store.subscribe((events) => {
                  for (const event of events) {
                      if (event.kind === 'pane-removed') {
                          consoleStore.disposePane(event.paneID);
                          inspectState.disposePane(event.paneID);
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
        if (store === undefined || event.tabID === undefined) return;
        const found = webPaneOf(event.paneID);
        if (found === null) return;
        const url = event.payload['url'];
        const title = event.payload['title'];
        store.dispatch({
            type: 'web-tab-state',
            workspaceID: found.workspaceID,
            paneID: event.paneID,
            tabID: event.tabID,
            ...(typeof url === 'string' ? { url } : {}),
            ...(typeof title === 'string' ? { title } : {})
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
            return;
        }
        const result = sanitizeInspectPayload(tabID, event.payload, now());
        if (result === null) return;
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

    const tabClosedEvent = (event: HostEventInput): void => {
        if (store === undefined || event.tabID === undefined) return;
        const found = webPaneOf(event.paneID);
        if (found === null) return;
        store.dispatch({
            type: 'web-tab-close',
            workspaceID: found.workspaceID,
            paneID: event.paneID,
            tabID: event.tabID
        });
    };

    return {
        host,
        console: consoleStore,
        inspect: inspectState,
        get hasHost() {
            return host.hasHost;
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
                    case 'inspect':
                        inspectEvent(event);
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
        }
    };
}
