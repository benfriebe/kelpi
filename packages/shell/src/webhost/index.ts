/**
 * The web-pane host (M6, shell half) — composition root.
 *
 * The daemon owns web-pane *state* and cannot render a page; this is the process that can. It
 * connects to the daemon as an ordinary WS client claiming the `web-pane-host` role
 * (`daemon/src/webpane/HOST_PROTOCOL.md`), mirrors the daemon's pane/tab set onto real
 * `WebContentsView`s, and answers every verb that only exists in a live browser.
 *
 * Wiring, in the order it matters:
 *
 *   holder window ──▶ tab hooks (./tab.ts) ──▶ registry (./registry.ts)
 *                                                   │
 *   pane sessions (./sessions.ts) ─────────────▶ dispatcher (./dispatch.ts)
 *                                                   │
 *                                          WS client (./client.ts)
 *
 * Everything is created eagerly except the holder window, which is built on the first pane so a
 * shell with no web panes never allocates a native window.
 *
 * ## What v1 does and does not do
 *
 * Every **non-visual** verb works: open, navigate, back, forward, reload, url, the whole actuator
 * surface (click, type, the `q-` reads, wait, select, scroll, hover, key), `exec`, `capture` in
 * all five modes, the console pipeline, the element picker, cookies, find and zoom. That is the
 * surface `nex-agentic` drives, and it is exercised end-to-end by
 * `packages/shell/scripts/web-smoke.mjs` against the **real Swift CLI**.
 *
 * The views are **not shown**: they live in an off-screen holder window (see `./tab.ts` for why
 * one exists at all), while the web client keeps drawing its placeholder card for web panes.
 * Visual embedding — re-parenting these same views into the main window at the pane's rect,
 * which needs a client→shell channel that does not exist yet (there is deliberately no preload
 * bridge) — is the documented follow-up. Nothing else in this directory changes when it lands.
 */

import { BaseWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@nex/protocol';

import type { DaemonLocation } from '../daemon.js';
import { log, logError, warn } from '../log.js';
import { clampInspectPayload, screenshotFileName } from './caps.js';
import { createWebHostClient, type WebHostClient } from './client.js';
import { SCREENSHOT_WRITE_ERROR, createVerbDispatcher } from './dispatch.js';
import { createTabRegistry, type TabRegistry } from './registry.js';
import { createPaneSessions } from './sessions.js';
import { DEFAULT_VIEWPORT, createTabHooks, type HostTab } from './tab.js';

export interface WebPaneHostOptions {
    readonly location: DaemonLocation;
    /** Reported to the daemon for diagnostics. */
    readonly version?: string | undefined;
    readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

export interface WebPaneHost {
    start(): void;
    stop(): void;
    /** Re-point at a (re)discovered daemon. */
    setLocation(location: DaemonLocation): void;
    readonly registered: boolean;
    /** Live pane count (diagnostics, and the smoke's proof that views were built). */
    readonly paneCount: number;
}

/**
 * Where a screenshot over the inline budget is spilled. §8.4 pins both the directory (the OS
 * per-app temp dir) and the name (`nex-web-capture-<paneID>-<unixts>.png`) because the CLI
 * prints the path and an agent then reads it.
 */
async function spillScreenshot(paneID: string, png: Uint8Array): Promise<string> {
    const file = path.join(os.tmpdir(), screenshotFileName(paneID, Date.now()));
    try {
        await writeFile(file, png);
    } catch (error) {
        // The path is the whole point of the failure message: it is what the agent (or the
        // user) has to go look at. `./dispatch.ts` passes a `failed to write screenshot…`
        // message through to the CLI verbatim.
        throw new Error(`${SCREENSHOT_WRITE_ERROR} to ${file}`, { cause: error });
    }
    return file;
}

export function createWebPaneHost(options: WebPaneHostOptions): WebPaneHost {
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    let holder: BaseWindow | null = null;
    let client: WebHostClient | null = null;

    const onError = (error: Error, context: string): void => {
        logError(`web host: ${context}`, error);
    };

    /**
     * The off-screen parent for every tab view. It is never shown and never focused; it exists
     * only so the views have a compositor surface (a parentless `WebContentsView` has no layout,
     * so `innerText`, element rects and screenshots would all be undefined).
     */
    const holderWindow = (): BaseWindow => {
        if (holder !== null && !holder.isDestroyed()) return holder;
        holder = new BaseWindow({
            show: false,
            width: viewport.width,
            height: viewport.height,
            title: 'Nex Web Host',
            skipTaskbar: true
        });
        log(`web host holder window created (${String(viewport.width)}×${String(viewport.height)}, never shown)`);
        return holder;
    };

    const sessions = createPaneSessions({ onError });

    const hooks = createTabHooks({
        holder: holderWindow,
        sessionFor: (paneID, isPrivate) => sessions.sessionFor(paneID, isPrivate),
        viewport,
        onError,
        events: {
            console: (paneID, tabID, payload) => {
                client?.sendEvent('console', paneID, tabID, {
                    level: payload.level,
                    message: payload.message,
                    url: payload.url,
                    ...(payload.line === undefined ? {} : { line: payload.line }),
                    ...(payload.column === undefined ? {} : { column: payload.column })
                });
            },
            pageState: (paneID, tabID, payload) => {
                client?.sendEvent('page-state', paneID, tabID, {
                    ...(payload.url === undefined ? {} : { url: payload.url }),
                    ...(payload.title === undefined ? {} : { title: payload.title })
                });
            },
            inspect: (paneID, tabID, payload) => {
                // Clamped, not reshaped: the nonce and the `cancelled` flag travel untouched (the
                // daemon compares the nonce for equality and re-sanitises every other field before
                // it can reach a PTY, §11.6) — this pass only stops a page's multi-megabyte
                // `outerHTML` from crossing the socket to be clamped at the other end.
                client?.sendEvent('inspect', paneID, tabID, clampInspectPayload(payload) as JsonObject);
            },
            tabClosed: (paneID, tabID) => {
                // The daemon drops the tab and re-activates the left neighbour; our registry
                // forgets it without trying to destroy a view that is already gone.
                registry.forgetTab(paneID, tabID);
                client?.sendEvent('tab-closed', paneID, tabID, {});
            }
        }
    });

    const registry: TabRegistry<HostTab> = createTabRegistry<HostTab>(hooks);

    const dispatcher = createVerbDispatcher<HostTab>({
        registry,
        storage: sessions.storage,
        writeScreenshot: spillScreenshot,
        onError
    });

    /** Session bookkeeping the dispatcher does not own (partitions are this module's problem). */
    const notify = (verb: string, args: JsonObject): void => {
        const paneID = typeof args['paneID'] === 'string' ? args['paneID'] : '';
        // A private flip changes the partition, and the partition is sealed into the views —
        // dropping the handle first is what makes the rebuilt views land on the new store.
        if (verb === 'pane-set-private' && paneID !== '') sessions.forget(paneID);
        dispatcher.notify(verb, args);
        if (verb === 'pane-close' && paneID !== '') sessions.forget(paneID);
    };

    client = createWebHostClient({
        location: options.location,
        name: 'nex-shell',
        version: options.version ?? '0.0.0',
        call: (verb, args) => {
            if (verb === 'pane-close' || verb === 'pane-set-private') {
                // Keep the session bookkeeping identical whichever framing the daemon uses.
                notify(verb, args);
                return Promise.resolve({ ok: true });
            }
            return dispatcher.call(verb, args);
        },
        notify,
        onRegistered: (hostID, superseded) => {
            log(`web host ready (${hostID}${superseded ? ', took over' : ''}) — waiting for pane-open replay`);
        },
        onRevoked: (reason) => {
            if (reason === 'disconnected') {
                // Keep the views: the daemon replays `pane-open` on the next registration and
                // the registry reconciles in place, so live pages survive a daemon restart.
                warn('web host disconnected; keeping live views for the reconnect');
                return;
            }
            // Superseded / shutdown / unregistered: another host (or nobody) owns these panes
            // now. Two shells driving the same pages would double every console line.
            log(`web host releasing ${String(registry.paneIDs().length)} pane(s) (${reason})`);
            for (const paneID of registry.paneIDs()) sessions.forget(paneID);
            registry.dispose();
        }
    });

    return {
        start(): void {
            client?.start();
        },
        stop(): void {
            client?.stop();
            for (const paneID of registry.paneIDs()) sessions.forget(paneID);
            registry.dispose();
            if (holder !== null && !holder.isDestroyed()) holder.destroy();
            holder = null;
        },
        setLocation(next: DaemonLocation): void {
            client?.setLocation(next);
        },
        get registered(): boolean {
            return client?.registered ?? false;
        },
        get paneCount(): number {
            return registry.paneIDs().length;
        }
    };
}
