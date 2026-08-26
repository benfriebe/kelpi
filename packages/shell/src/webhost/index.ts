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
 * ## Two places a view can live
 *
 * Every **non-visual** verb works with no window at all: open, navigate, back, forward, reload,
 * url, the whole actuator surface (click, type, the `q-` reads, wait, select, scroll, hover,
 * key), `exec`, `capture` in all five modes, the console pipeline, the element picker, cookies,
 * find and zoom. That is the surface `nex-agentic` drives, and it is exercised end-to-end by
 * `packages/shell/scripts/web-smoke.mjs` against the **real Swift CLI**.
 *
 * Views are therefore born in an off-screen holder window (see `./tab.ts` for why one exists at
 * all) and stay there until somebody can see them. When the web UI **running in this shell's
 * own window** reports where it drew a web pane's page area, the daemon forwards it as a
 * `pane-geometry` notify and `./embed.ts` re-parents that pane's active view into the window at
 * those bounds; hiding the pane, switching workspace, closing the window or quitting puts it
 * straight back. Geometry from any other client (a browser, another machine) is ignored — those
 * clients keep drawing the placeholder card, which is why the automation surface is unaffected
 * by all of this.
 */

import { BaseWindow, screen, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { JsonObject } from '@nex/protocol';

import type { DaemonLocation } from '../daemon.js';
import { log, logError, warn } from '../log.js';
import { clampInspectPayload, screenshotFileName } from './caps.js';
import { createWebHostClient, type WebHostClient } from './client.js';
import { chordCommand } from './keys.js';
import { SCREENSHOT_WRITE_ERROR, createVerbDispatcher } from './dispatch.js';
import { createEmbedController, type EmbedController } from './embed.js';
import { GEOMETRY_NOTIFY_VERB, parsePaneGeometry, type WindowMetrics } from './geometry.js';
import { createTabRegistry, type TabRegistry } from './registry.js';
import { createPaneSessions } from './sessions.js';
import { DEFAULT_VIEWPORT, createTabHooks, type HostTab } from './tab.js';

export interface WebPaneHostOptions {
    readonly location: DaemonLocation;
    /** Reported to the daemon for diagnostics. */
    readonly version?: string | undefined;
    readonly viewport?: { readonly width: number; readonly height: number } | undefined;
    /**
     * The shell window embedded views are placed in, looked up lazily (it is created after the
     * host, can be closed and re-opened, and must never be captured as a stale reference).
     * Absent = a host that only ever runs views off-screen.
     */
    readonly window?: (() => BrowserWindow | null) | undefined;
    /**
     * This shell window's identity, declared to the daemon and repeated by the UI it loads
     * (`?shellWindow=`). Without it the host receives geometry but can never own any of it.
     */
    readonly windowID?: string | undefined;
}

export interface WebPaneHost {
    start(): void;
    stop(): void;
    /** Re-point at a (re)discovered daemon. */
    setLocation(location: DaemonLocation): void;
    readonly registered: boolean;
    /** Live pane count (diagnostics, and the smoke's proof that views were built). */
    readonly paneCount: number;
    /** Panes whose view is currently inside the shell window. */
    readonly embeddedPaneIDs: readonly string[];
    /** Send every embedded view back to the holder (the window closed, or is about to). */
    releaseViews(reason?: string): void;
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
        /**
         * §7.3's other half: the chords the web-pane key layer owns are taken from the page and
         * replayed into the shell window's renderer, which is the process that implements them.
         * Without this, clicking a page permanently disables ⌘F / ⌘L / ⌘T for that pane — the
         * page's renderer has keyboard focus and Nex's never sees the keystroke.
         */
        forwardChord: (chord) => {
            // NOT `webContents.sendInputEvent`: a synthetic OS key is delivered to whichever
            // widget the browser considers focused, which — by construction, here — is the page
            // that just gave the chord up. It would bounce straight back. The daemon's
            // `menu-request` relay reaches the page in this window directly, and is the same
            // channel the native menu bar already uses.
            client?.sendWindowCommand(chordCommand(chord));
        },
        // A destroyed view must leave the embed controller's books BEFORE Electron tears it
        // down, or the next placement would try to remove a child that no longer exists.
        beforeDestroy: (tab) => {
            embed.forget(tab);
        },
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
            navState: (paneID, tabID, payload) => {
                // WEB-032/WEB-033: three booleans, deduplicated tab-side, so a chatty page
                // cannot turn the loading bracket into a stream.
                client?.sendEvent('nav-state', paneID, tabID, {
                    loading: payload.loading,
                    can_go_back: payload.canGoBack,
                    can_go_forward: payload.canGoForward
                });
            },
            /**
             * §N29: the user clicked the pane's page. It rides the same `host-event` channel
             * every other unsolicited host fact does — the daemon re-broadcasts it to the client
             * running in THIS shell window, which then runs the focus path a terminal body click
             * runs. No new transport, and no focus decision taken in this process: the shell
             * reports the gesture, the client owns the ring.
             */
            viewFocus: (paneID, tabID) => {
                client?.sendEvent('view-focus', paneID, tabID, {});
            },
            inspect: (paneID, tabID, payload) => {
                // Clamped, not reshaped: the nonce and the `cancelled` flag travel untouched (the
                // daemon compares the nonce for equality and re-sanitises every other field before
                // it can reach a PTY, §11.6) — this pass only stops a page's multi-megabyte
                // `outerHTML` from crossing the socket to be clamped at the other end.
                client?.sendEvent('inspect', paneID, tabID, clampInspectPayload(payload) as JsonObject);
            },
            batchMarker: (paneID, tabID, payload) => {
                // Intents only (`{id}` badge click, `{commentChanged}`, `{dismiss}`, `{remove}`):
                // small by construction, and the daemon re-validates every field against the
                // batch it owns before anything changes.
                client?.sendEvent('batch-marker', paneID, tabID, payload as JsonObject);
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

    /**
     * The shell window's live measurements, or null when there is nothing to embed into: no
     * window, a destroyed one, or one the user hid/minimised (a view placed in a hidden window
     * is invisible anyway, and the holder is where an unseen view belongs).
     */
    const windowMetrics = (): WindowMetrics | null => {
        const window = options.window?.() ?? null;
        if (window === null || window.isDestroyed() || !window.isVisible() || window.isMinimized()) {
            return null;
        }
        const content = window.getContentBounds();
        // `getDisplayMatching` rather than the primary display: dragging the window to a 1×
        // monitor changes the CSS→DIP factor, and the next report has to land correctly there.
        const scaleFactor = screen.getDisplayMatching(window.getBounds()).scaleFactor;
        return { contentWidth: content.width, contentHeight: content.height, scaleFactor };
    };

    const embed: EmbedController<HostTab> = createEmbedController<HostTab>({
        resolveView: (paneID, tabID) =>
            tabID === null ? registry.activeView(paneID) : registry.view(paneID, tabID),
        metrics: windowMetrics,
        ...(options.windowID === undefined ? {} : { windowID: options.windowID }),
        hooks: {
            attach: (tab, bounds) => {
                const window = options.window?.() ?? null;
                if (window === null || window.isDestroyed()) return;
                const view = tab.contentsView;
                try {
                    // Removing from the holder first keeps a view from being a child of two
                    // windows for an instant, which Electron tolerates but the books do not.
                    holderWindow().contentView.removeChildView(view);
                } catch {
                    // Not currently in the holder — nothing to undo.
                }
                window.contentView.addChildView(view);
                view.setBounds(bounds);
                tab.setVisible(true);
                // The pane's rect is the viewport now: drop the pinned automation one, or the
                // page keeps laying out at 1280×800 and the hole shows its clipped top-left
                // corner at 1× (run-B L2). `setEmbedded` sequences itself behind CDP readiness.
                tab.setEmbedded(true);
            },
            detach: (tab) => {
                const view = tab.contentsView;
                const window = options.window?.() ?? null;
                if (window !== null && !window.isDestroyed()) {
                    try {
                        window.contentView.removeChildView(view);
                    } catch {
                        // Already removed (the window is tearing down).
                    }
                }
                // Back to the fixed off-screen viewport: every non-visual verb (capture,
                // element rects, screenshots) is specified against it — both the view's bounds
                // and the emulated metrics that make the layout deterministic.
                view.setBounds({ x: 0, y: 0, width: viewport.width, height: viewport.height });
                tab.setEmbedded(false);
                holderWindow().contentView.addChildView(view);
            },
            setBounds: (tab, bounds) => {
                tab.contentsView.setBounds(bounds);
            }
        },
        onChange: (event) => {
            const box =
                event.bounds === null
                    ? '-'
                    : `${String(event.bounds.x)},${String(event.bounds.y)} ${String(event.bounds.width)}×${String(event.bounds.height)}`;
            // The live smoke asserts on this line: it is the only externally visible proof that
            // a view moved into the shell window rather than staying in the holder.
            log(
                `web pane ${event.paneID} view ${event.outcome === 'placed' ? 'owner=main' : 'owner=holder'} ` +
                    `bounds=${box} (${event.reason})`
            );
        },
        onError
    });

    const dispatcher = createVerbDispatcher<HostTab>({
        registry,
        storage: sessions.storage,
        writeScreenshot: spillScreenshot,
        onError
    });

    /** Session bookkeeping the dispatcher does not own (partitions are this module's problem). */
    const notify = (verb: string, args: JsonObject): void => {
        // Geometry is placement, not pane state: it never reaches the dispatcher (which would
        // rightly call it an unknown verb) and it never touches the registry.
        if (verb === GEOMETRY_NOTIFY_VERB) {
            const geometry = parsePaneGeometry(args);
            if (geometry !== null) embed.apply(geometry);
            return;
        }
        const paneID = typeof args['paneID'] === 'string' ? args['paneID'] : '';
        // A private flip changes the partition, and the partition is sealed into the views —
        // dropping the handle first is what makes the rebuilt views land on the new store.
        if (verb === 'pane-set-private' && paneID !== '') sessions.forget(paneID);
        if (verb === 'pane-close' && paneID !== '') embed.release(paneID, 'pane-closed');
        dispatcher.notify(verb, args);
        if (verb === 'pane-close' && paneID !== '') sessions.forget(paneID);
        // A tab-level change moves which view is the active one; re-apply the last geometry so
        // the window shows the tab the daemon just selected, without waiting for the client's
        // next report (they race, and the loser must not leave the wrong page on screen).
        if (verb === 'tab-open' || verb === 'tab-select' || verb === 'tab-close' || verb === 'pane-open') {
            embed.refresh();
        }
    };

    client = createWebHostClient({
        location: options.location,
        name: 'nex-shell',
        version: options.version ?? '0.0.0',
        // Declared at registration so the daemon can tell this window's geometry reports from
        // any other client's (HOST_PROTOCOL §1 + §3.5).
        ...(options.windowID === undefined ? {} : { windowID: options.windowID }),
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
            embed.releaseAll(reason);
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
            embed.releaseAll('host-stopped');
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
        },
        get embeddedPaneIDs(): readonly string[] {
            return embed.embeddedPaneIDs;
        },
        releaseViews(reason = 'window-closed'): void {
            // The views outlive the window: put them back in the holder so every automation
            // verb keeps working while there is nothing to look at.
            embed.releaseAll(reason);
        }
    };
}
