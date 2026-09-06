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
 * find and zoom. That is the surface `kelpi-agentic` drives, and it is exercised end-to-end by
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

import type { JsonObject } from '@kelpi/protocol';

import type { DaemonLocation } from '../daemon.js';
import { log, logError, warn } from '../log.js';
import { clampInspectPayload, screenshotFileName } from './caps.js';
import { createWebHostClient, type WebHostClient } from './client.js';
import { chordCommand, setForwardedKeybindLines } from './keys.js';
import { parkKeyboardDecision, releaseBeforeHide } from './park-keyboard.js';
import { SCREENSHOT_WRITE_ERROR, createVerbDispatcher } from './dispatch.js';
import { createEmbedController, type EmbedController } from './embed.js';
import { GEOMETRY_NOTIFY_VERB, cssToDipScale, parsePaneGeometry, type WindowMetrics } from './geometry.js';
import type { KeyboardOwner } from './nav-focus.js';
import { createTabRegistry, type TabRegistry } from './registry.js';
import { traceFocus } from './view-focus.js';
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
    /** Panes this shell parked and still owes a placement to (#75). */
    readonly parkedPaneIDs: readonly string[];
    /**
     * Send every embedded view back to the holder and FORGET where it was: the window is closing
     * or the host is losing its role, so the placements are not ours to restore.
     */
    releaseViews(reason?: string): void;
    /**
     * Send every embedded view back to the holder and REMEMBER where it was (#75): the user hid
     * or minimised the window, and `restoreViews()` puts them back when it comes back.
     */
    parkViews(reason?: string): void;
    /**
     * Put back every view this shell parked (#75). Called on the window's `show` and `restore`.
     *
     * Also the repair for the park no event can undo: a placement that is still parked once the
     * window is live again is one the shell cannot honour from its own books, so the clients are
     * asked to re-state what belongs on screen.
     */
    restoreViews(reason?: string): void;
}

/**
 * Where a screenshot over the inline budget is spilled. §8.4 pins both the directory (the OS
 * per-app temp dir) and the name (`kelpi-web-capture-<paneID>-<unixts>.png`) because the CLI
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
            title: 'Kelpi Web Host',
            skipTaskbar: true
        });
        log(`web host holder window created (${String(viewport.width)}×${String(viewport.height)}, never shown)`);
        return holder;
    };

    const sessions = createPaneSessions({ onError });

    /**
     * §N30 — the keyboard census: which widget inside the shell window is the one being typed
     * into right now.
     *
     * Only this module can answer it, because only this module knows about the window and about
     * every other pane's view. `isFocused()` is `RenderWidgetHostViewMac::HasFocus()` on macOS —
     * the window's **first responder**, i.e. where a keystroke would actually go — which is why
     * this and not `document.hasFocus()` is what the guard decides from.
     *
     * With the window INACTIVE every entry reads false (measured; an earlier version of this
     * comment claimed the opposite). That is not a gap: a commit cannot take the keyboard in that
     * state either, so `viewHasKeyboard` is false too and the guard decides nothing.
     *
     * The client's own renderer is checked FIRST and the views second: they are mutually
     * exclusive in practice, and asking the cheap question first keeps the common case to one
     * call.
     */
    const keyboardOwner = (): KeyboardOwner => {
        const window = options.window?.() ?? null;
        const live = window !== null && !window.isDestroyed() && !window.webContents.isDestroyed();
        const clientHasKeyboard = live && window.webContents.isFocused();
        const views: string[] = [];
        let focusedView: string | null = null;
        for (const paneID of registry.paneIDs()) {
            for (const tab of registry.pane(paneID)?.tabs ?? []) {
                const focused = tab.view.hasKeyboardFocus();
                views.push(`${tab.id.slice(0, 8)}=${String(focused)}`);
                if (focused && focusedView === null) focusedView = tab.id;
            }
        }
        // The ingredients, not just the verdict: "nobody has it" and "the client has it" are
        // opposite states that produce the same decision here, and telling them apart from
        // outside the process is otherwise impossible (§N29's lesson about instruments).
        traceFocus(
            `keyboard census: window=${live ? String(window.isFocused()) : 'gone'} ` +
                `client=${String(clientHasKeyboard)} views=[${views.join(' ')}]`
        );
        if (clientHasKeyboard) return { kind: 'client' };
        if (focusedView !== null) return { kind: 'view', tabID: focusedView };
        return { kind: 'none' };
    };

    /**
     * §N30 — give the keyboard back to the owner a commit displaced.
     *
     * **`webContents.focus()`, and NOT `focusOnWebView()`** — the opposite of what this function
     * did when it was written, and the correction matters more than the call:
     * `BrowserWindow.focusOnWebView()` does not move the window's first responder at all. It
     * reaches `RenderWidgetHostImpl::Focus()`, which sets Blink's **page focus** bit and nothing
     * else, so the client's `document.hasFocus()` flips to true while the web view keeps the
     * first responder — and the first responder is where a keystroke actually goes. The handoff
     * would then be invisible to the user's fingers and perfectly visible to any probe that reads
     * `document.hasFocus()`, which is the shape of mistake §N29's post-mortem is about.
     *
     * Measured on this app's own Electron (43.4.0 / Chromium 150) with a plain window and a plain
     * `WebContentsView`, in `docs/audit/n30-verify/electron-focus-api.cjs`:
     *
     *   after view.webContents.focus()  client.isFocused=false view.isFocused=true  client.hasFocus=false page.hasFocus=true
     *   after win.focusOnWebView()      client.isFocused=false view.isFocused=true  client.hasFocus=TRUE  page.hasFocus=true
     *   after win.webContents.focus()   client.isFocused=TRUE  view.isFocused=FALSE client.hasFocus=true  page.hasFocus=FALSE
     *
     * (`webContents.isFocused()` on macOS is `RenderWidgetHostViewMac::HasFocus()` — the first
     * responder. Only the last line is a handoff; the middle one is a bit being set.)
     *
     * The reason `focusOnWebView` was chosen is real but cannot apply here: `WebContents::Focus()`
     * asks its owner window to activate on macOS, which would turn an agent's background
     * navigation into the app taking the user's screen. This runs **only** when the commit
     * actually took the keyboard, and a commit can only take the keyboard while the window is
     * already the key window (measured: with the window inactive every `isFocused()` in the
     * census reads false and no commit ever reports a steal). The `isFocused()` guard below makes
     * that structural fact explicit rather than assumed — a restore that would have to activate
     * the app is refused, and says so in the log.
     */
    const restoreKeyboard = (owner: KeyboardOwner): boolean => {
        if (owner.kind === 'client') {
            const window = options.window?.() ?? null;
            if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return false;
            try {
                // Never at the cost of an app activation: if this window is not already the one
                // being typed into, there is no keyboard here to give back.
                if (!window.isFocused()) return false;
                window.webContents.focus();
                return true;
            } catch (error) {
                // A window mid-teardown. The keyboard stays where Chromium put it, which is the
                // pre-§N30 behaviour rather than a crash in a focus handler.
                onError(error instanceof Error ? error : new Error(String(error)), 'restore-keyboard');
                return false;
            }
        }
        if (owner.kind === 'view') {
            for (const paneID of registry.paneIDs()) {
                for (const tab of registry.pane(paneID)?.tabs ?? []) {
                    if (tab.id !== owner.tabID) continue;
                    // Through the tab's own WEB-043 verb, so the page it goes back to marks the
                    // handoff as deliberate and its own in-flight load cannot undo it.
                    tab.view.focusView?.();
                    return true;
                }
            }
        }
        return false;
    };

    /**
     * Hand the keyboard back to the client if THIS view is the one holding it (issue #33).
     *
     * Must be called BEFORE whatever is about to take the view off the screen, because both of
     * those operations drop the view's focus themselves and the answer stops being true - see
     * `./park-keyboard.ts` on the two moments this has to run at, and why sampling at only one
     * of them left tab cycling broken.
     */
    const releaseKeyboardIfHeld = (tab: HostTab, reason: string): void => {
        const window = options.window?.() ?? null;
        const viewHeldKeyboard = tab.hasKeyboardFocus();
        const decision = parkKeyboardDecision({
            viewHeldKeyboard,
            windowIsFocused: window !== null && !window.isDestroyed() && window.isFocused()
        });
        if (decision === 'leave') {
            // Logged even when nothing happens: "the view did not have it" and "we never looked"
            // are opposite states that were indistinguishable from outside the process, which is
            // what made the first version of this fix look like it had not run at all.
            traceFocus(`keyboard park (${reason}): held=${String(viewHeldKeyboard)} -> left alone`);
            return;
        }
        const restored = restoreKeyboard({ kind: 'client' });
        log(
            `web pane ${tab.paneID}: ${reason} view held the keyboard; ` +
                `${restored ? 'handed it back to the client' : 'could not hand it back'}`
        );
    };

    const hooks = createTabHooks({
        keyboardOwner,
        restoreKeyboard,
        holder: holderWindow,
        sessionFor: (paneID, isPrivate) => sessions.sessionFor(paneID, isPrivate),
        viewport,
        onError,
        /**
         * §7.3's other half: the chords the web-pane key layer owns are taken from the page and
         * replayed into the shell window's renderer, which is the process that implements them.
         * Without this, clicking a page permanently disables ⌘F / ⌘L / ⌘T for that pane — the
         * page's renderer has keyboard focus and Kelpi's never sees the keystroke.
         */
        forwardChord: (chord) => {
            // NOT `webContents.sendInputEvent`: a synthetic OS key is delivered to whichever
            // widget the browser considers focused, which — by construction, here — is the page
            // that just gave the chord up. It would bounce straight back. The daemon's
            // `menu-request` relay reaches the page in this window directly, and is the same
            // channel the native menu bar already uses.
            client?.sendWindowCommand(chordCommand(chord));
        },
        /*
         * A destroyed view must leave the embed controller's books BEFORE Electron tears it
         * down, or the next placement would try to remove a child that no longer exists.
         *
         * #72: and it must leave the WINDOW too, which `forget()` deliberately does not do. The
         * view is still alive at this moment (`createTabHooks.destroy` calls this before
         * `dispose`), so the ordinary detach runs and the view goes back to the holder, where
         * `destroy` then removes it. Without this the view stayed a child of the shell window
         * with no entry in the books, and only its own destruction took it off screen: for a
         * `pane-close` that is immediate, but for the reconcile path it is a dead page sitting
         * over the workspace until Chromium gets round to it.
         */
        beforeDestroy: (tab) => {
            embed.releaseView(tab, 'view-destroyed');
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

    const registry: TabRegistry<HostTab> = createTabRegistry<HostTab>({
        ...hooks,
        /*
         * A tab switch hides the outgoing view HERE, one notify before the geometry that parks
         * it - and `setVisible(false)` drops that view's keyboard focus itself. Sampling only at
         * the park was therefore always too late: the census said "it does not have it" because
         * hiding had just taken it, and the keyboard was left with nothing. Measured as ⌘⇧]
         * cycling exactly once and then going dead.
         */
        show: releaseBeforeHide(hooks.show, (tab) => {
            releaseKeyboardIfHeld(tab, 'hidden');
        }),
        /*
         * #72: a tab whose renderer died is dropped from the registry without being destroyed
         * (`render-process-gone` -> `tabClosed` -> `forgetTab`), and its view can still be
         * embedded in the shell window. Nothing used to take it off screen, so the pane showed
         * a dead rectangle that ate every click that landed on it.
         *
         * Deliberately the minimum: the view leaves the window and the books, and nothing else
         * about the crashed-renderer story changes here. Rebuilding the tab, telling the daemon
         * and offering the user a Reload card is issue #76's, in these same files.
         */
        forget: (tab) => {
            embed.releaseView(tab, 'renderer-gone');
        }
    });

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
                // The pane's rect is the viewport now: a pin left by an automation read while
                // the view was parked is cleared, or the page keeps laying out at 1280×800 and
                // the hole shows its clipped top-left corner at 1× (run-B L2). `setEmbedded`
                // sequences itself behind CDP readiness.
                tab.setEmbedded(true);
            },
            detach: (tab) => {
                const view = tab.contentsView;
                const window = options.window?.() ?? null;
                /*
                 * Before the re-parent, which drops the view's focus itself. This is the moment
                 * for every park that does NOT go through a tab switch - a hidden pane, a
                 * workspace change, a closing window - where the view is still visible and still
                 * holding the keyboard when it gets here.
                 *
                 * #72: guarded, like every step below it. This hook has ONE job that must happen
                 * whatever else fails - the view leaves the window and goes back to the holder -
                 * and the books are cleared before it runs, so a throw part-way used to leave a
                 * view parented to the window that nothing would ever take off screen again.
                 * Each step reports and continues instead.
                 */
                try {
                    releaseKeyboardIfHeld(tab, 'parked');
                } catch (error) {
                    onError(error instanceof Error ? error : new Error(String(error)), 'detach-keyboard');
                }
                if (window !== null && !window.isDestroyed()) {
                    try {
                        window.contentView.removeChildView(view);
                    } catch {
                        // Already removed (the window is tearing down).
                    }
                }
                /*
                 * The view keeps the SIZE it had on screen (`./viewport-pin.ts`).
                 *
                 * This used to put the view back at the 1280×800 automation viewport, bounds and
                 * emulated metrics both, on every park - and most parks are a menu. A page
                 * resized to 1280 px reflows: one wider than the pane loses its sideways scroll,
                 * media queries flip, resize handlers run; coming back it reflows again and comes
                 * back scrolled somewhere else. Measured: a 1200 px page scrolled to x=300 came
                 * back from a header menu at x=0, the whole page 300 px to the right of the still
                 * frame (issue #12) that had just shown it where it was. The automation viewport
                 * is now applied by the first automation read on the parked view
                 * (`HostTab.pinViewport`, from the dispatcher), so `capture` and friends still
                 * answer against 1280×800 @1× as specified, and a view nobody reads while it is
                 * parked comes back exactly as it left.
                 *
                 * Only the position moves, which does not reflow. The holder is never shown, and
                 * a child that overhangs it is still laid out at its own size, but keeping every
                 * parked view inside the holder's box costs nothing.
                 */
                try {
                    const { width, height } = view.getBounds();
                    view.setBounds({ x: 0, y: 0, width, height });
                } catch (error) {
                    onError(error instanceof Error ? error : new Error(String(error)), 'detach-bounds');
                }
                try {
                    tab.setEmbedded(false);
                } catch (error) {
                    // A CDP call on a tab whose renderer has already gone. The re-parent below
                    // is the part that matters and must not be skipped for it (#72).
                    onError(error instanceof Error ? error : new Error(String(error)), 'detach-embedded');
                }
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
            // #75: this host now holds a placement (or has just parked one), and macOS gives no
            // dependable event for the moment either can change (see the reconciler below).
            // Arming here rather than at each call site means no path added later can forget to.
            watchWindowState();
        },
        onError
    });

    /*
     * ── #75: a park this shell performs is a park this shell undoes ─────────────────
     *
     * Two mechanisms, and the SECOND one is the load-bearing one. That is the opposite of what
     * the issue proposes, and the reason is measurable rather than a preference.
     *
     * Measured on this app's own Electron (43.4.0 / Chromium 150), plain window, in
     * `docs/audit/n75-verify/electron-window-events.cjs`:
     *
     *     win.hide()      no events at all       win.show()     no events at all
     *     win.minimize()  minimize, show, hide   win.restore()  restore, show
     *     app.hide()      hide, and only while the app is actually the active one
     *     app.show()      no events at all
     *
     * So on macOS a hide and an unhide have NO dependable event: `orderOut:` / `orderFront:`
     * post nothing Electron forwards, `NSApplicationDidUnhide` does not reach a window's `show`,
     * and a Space switch, which is the gesture the issue was actually reported for, has no API
     * at all. A restore wired only to `window.on('show')` would pass a unit test and do nothing
     * on the machine it was written for. (It also explains the field reports: the park that bit
     * users is mostly not the `hide` handler but a geometry report landing while `isVisible()`
     * is false, which released with reason `no-window`.)
     *
     *   1. **The events, where they fire.** `main.ts` wires `hide`/`minimize` to `parkViews` and
     *      `show`/`restore` to `restoreViews`, so where macOS does say something the answer
     *      lands in one frame. `refresh()` re-applies each placement against the window's LIVE
     *      metrics, so a window resized or moved to another display while it was away comes
     *      back correctly clamped rather than at the box it left.
     *   2. **A reconciler that looks at the window itself.** While this host holds any
     *      placement at all it re-checks four booleans on a backing-off timer (150 ms after a
     *      change, up to 2 s at rest) and makes the books match: a window that is not usable
     *      parks what is in it, a window that is usable again places back what it parked. No
     *      event, no gesture and no client report is required for either direction.
     *
     * If the window is usable and a placement STILL cannot be honoured (its view is gone, or
     * never existed), the clients are asked to re-state theirs through the daemon's
     * `web-geometry-resync` broadcast (#34's message: the only party that knows where the holes
     * are is the one that drew them). That ask is rate-limited, because a broadcast reaches every
     * attached client and a stuck placement must not become a message per tick.
     */
    const WATCH_MIN_MS = 150;
    const WATCH_MAX_MS = 2_000;
    const RESYNC_MIN_INTERVAL_MS = 5_000;
    let watchTimer: NodeJS.Timeout | null = null;
    let watchDelay = WATCH_MIN_MS;
    let lastResyncAsk = 0;

    /**
     * Is there a window a view could be in right now?
     *
     * Deliberately cheaper than `windowMetrics()`, which also reads the content bounds and asks
     * the screen module which display the frame is on: this runs on a timer, and the expensive
     * question is only worth asking once the cheap one has changed its answer.
     */
    const windowUsable = (): boolean => {
        const window = options.window?.() ?? null;
        return window !== null && !window.isDestroyed() && window.isVisible() && !window.isMinimized();
    };

    const askClientsToRestate = (reason: string): void => {
        const now = Date.now();
        if (now - lastResyncAsk < RESYNC_MIN_INTERVAL_MS) return;
        lastResyncAsk = now;
        log(
            `web host asking clients to re-state ${String(embed.parkedPaneIDs.length)} parked placement(s) (${reason})`
        );
        client?.requestGeometryResync();
    };

    /**
     * Re-place everything this shell parked. Safe to call at any time: with nothing parked it
     * does nothing, and on a window that is still away it leaves the books exactly as they are.
     */
    const restoreParkedViews = (reason: string): void => {
        const waiting = embed.parkedPaneIDs.length;
        if (waiting === 0) return;
        if (!windowUsable()) {
            watchWindowState();
            return;
        }
        embed.refresh();
        const stillParked = embed.parkedPaneIDs.length;
        log(
            `web host restoring ${String(waiting)} parked view(s) (${reason}): ` +
                `${String(waiting - stillParked)} placed, ${String(stillParked)} still parked`
        );
        if (stillParked > 0) askClientsToRestate(reason);
        watchWindowState();
    };

    /**
     * Take every placed view back to the holder, keeping the placement (#75).
     *
     * The window's own state decides, not the event that called this. Measured on this Electron:
     * `win.minimize()` emits `minimize`, `show` AND `hide`, and a `hide` can arrive tens of
     * milliseconds AFTER the matching `restore` (observed at 20 ms in
     * `scripts/ui-audit/web-view-restore.mjs`'s own run). Acting on that event alone parks every
     * web pane's view while the window is sitting there perfectly visible - which is the shipped
     * bug by a third route, since `releaseViews` used to delete the placement. Events are hints
     * here; `windowUsable()` is the truth.
     */
    const parkPlacedViews = (reason: string): void => {
        if (embed.embeddedPaneIDs.length === 0) return;
        if (windowUsable()) {
            log(`web host ignoring a ${reason} park: the window is visible and not minimised`);
            watchWindowState();
            return;
        }
        log(`web host parking ${String(embed.embeddedPaneIDs.length)} view(s) (${reason})`);
        embed.parkAll(reason);
    };

    /*
     * ── #72: a hide issued while the host slot was empty ────────────────────────────
     *
     * Three correct behaviours compose into a wrong one. The daemon drops geometry while no
     * host is attached (`webpane/service.ts` ▸ `notifyGeometry`), including `visible:false`.
     * This host keeps its views across a socket drop, deliberately, because that is what makes
     * live pages survive a `kelpid` restart - but "keeps them" means keeps them ON SCREEN. And
     * the client cannot re-state a hide even if asked: `reassert()` re-sends only placements
     * (#34's safety rule), and its `hide()` deletes the entry outright, so by the time the host
     * is back there is no record on the client that the pane was ever placed.
     *
     * Net: after the host re-registers it holds a placement no party still believes in, and
     * nothing will contradict it until that pane's geometry changes for some unrelated reason.
     *
     * **Confirm or drop, rather than drop and wait to be told.** On re-registration every
     * placement is flagged unconfirmed; the daemon's `web-geometry-resync` broadcast (#34) makes
     * the clients re-state what they are drawing within a frame or two, and any report about a
     * pane clears its flag. What is still unconfirmed after a short grace was a claim nobody
     * makes any more, and it goes.
     *
     * The issue proposes parking everything up front and letting the re-statements put back what
     * belongs. That is the same idea one step cruder, and it is the shape #12 was about: every
     * web pane's page would blink out and back on EVERY host reconnect, which is precisely the
     * hole-flicker the issue rejects the daemon-side version for. Confirming instead means the
     * common case (every pane still on screen) moves nothing at all: the re-statements arrive,
     * `apply()` sees identical bounds and does nothing, and the sweep finds nothing to drop.
     * #75's parked flag is the wrong tool here for a related reason: a park with memory is a
     * claim the shell WILL restore, and on re-registration the point is to stop claiming.
     */
    const CLAIM_GRACE_MS = 2_000;
    let claimTimer: NodeJS.Timeout | null = null;

    const sweepUnclaimedPlacements = (): void => {
        const held = embed.markUnconfirmed();
        if (held === 0) return;
        log(
            `web host holding ${String(held)} placement(s) across the reconnect; ` +
                `${String(CLAIM_GRACE_MS)} ms for the clients to re-state them`
        );
        if (claimTimer !== null) clearTimeout(claimTimer);
        claimTimer = setTimeout(() => {
            claimTimer = null;
            const dropped = embed.releaseUnconfirmed('unclaimed-after-reconnect');
            log(
                dropped.length === 0
                    ? 'web host: every placement was re-stated after the reconnect'
                    : `web host dropped ${String(dropped.length)} placement(s) no client re-stated after the reconnect`
            );
        }, CLAIM_GRACE_MS);
        claimTimer.unref?.();
    };

    /**
     * The reconciler. Runs only while this host holds a placement, so a shell with no web panes
     * never arms a timer at all, and backs off to two seconds once the state stops changing.
     */
    function watchWindowState(): void {
        if (watchTimer !== null) return;
        if (embed.embeddedPaneIDs.length === 0 && embed.parkedPaneIDs.length === 0) {
            watchDelay = WATCH_MIN_MS;
            return;
        }
        watchTimer = setTimeout(() => {
            watchTimer = null;
            const before = `${String(embed.embeddedPaneIDs.length)}/${String(embed.parkedPaneIDs.length)}`;
            if (windowUsable()) restoreParkedViews('window-usable-again');
            else parkPlacedViews('window-not-visible');
            const after = `${String(embed.embeddedPaneIDs.length)}/${String(embed.parkedPaneIDs.length)}`;
            // Fast again after any change, slower while nothing is happening: a window can stay
            // hidden for hours, and a tick that finds nothing has still woken the process.
            watchDelay = before === after ? Math.min(WATCH_MAX_MS, Math.round(watchDelay * 1.5)) : WATCH_MIN_MS;
            watchWindowState();
        }, watchDelay);
        watchTimer.unref?.();
    }

    const dispatcher = createVerbDispatcher<HostTab>({
        registry,
        // The client's ring has left every web pane in this window (issue #33).
        restoreClientKeyboard: () => restoreKeyboard({ kind: 'client' }),
        storage: sessions.storage,
        writeScreenshot: spillScreenshot,
        /**
         * Issue #12 — where the view actually sits, in the client's own units.
         *
         * The poster is a photograph of the placed view, and the client has to lay it out on
         * exactly that box. `viewBounds` rounded and clamped every edge to get there, so the
         * client cannot re-derive it from the rect it measured; this hands back the placement
         * itself plus the factor that turns those DIP numbers back into the CSS pixels the
         * client laid out in (the inverse of `cssToDipScale`, i.e. of the page zoom).
         */
        viewPlacement: (paneID) => {
            const placed = embed.placementOf(paneID);
            if (placed === null) return null;
            const metrics = windowMetrics();
            if (metrics === null) return null;
            /*
             * Both halves of the conversion have to be from the SAME moment. The client's
             * `devicePixelRatio` is whatever its last report carried; the window's `scaleFactor`
             * is read now. Drag the window from a retina panel to a 1× one while a menu is open
             * and multiplying one by the other gives a factor that was never true — so the
             * placement's own scale factor is compared with the live one and the box is withheld
             * when they disagree. The client then falls back to the ring gutter, which is right
             * at any scale.
             */
            if (placed.scaleFactor !== metrics.scaleFactor) return null;
            const scale = cssToDipScale(placed.geometry.devicePixelRatio, metrics.scaleFactor);
            if (!Number.isFinite(scale) || scale <= 0) return null;
            return { bounds: placed.bounds, cssScale: 1 / scale };
        },
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
        name: 'kelpi-shell',
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
        /**
         * Issue #33: the chord relay's claimed set follows the user's `keybind` lines.
         *
         * `./keys.ts` holds the set as module state and starts it at the shipped defaults, so
         * this is a refresh rather than an initialisation - a view created before the handshake
         * lands still forwards the standard chords, and a rebind applied while the app is
         * running reaches the relay on the `settings-changed` that carries it.
         */
        onKeybindLines: (lines) => {
            setForwardedKeybindLines(lines);
        },
        onRegistered: (hostID, superseded) => {
            log(`web host ready (${hostID}${superseded ? ', took over' : ''}) — waiting for pane-open replay`);
            sweepUnclaimedPlacements();
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
            if (watchTimer !== null) {
                clearTimeout(watchTimer);
                watchTimer = null;
            }
            if (claimTimer !== null) {
                clearTimeout(claimTimer);
                claimTimer = null;
            }
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
        get parkedPaneIDs(): readonly string[] {
            return embed.parkedPaneIDs;
        },
        releaseViews(reason = 'window-closed'): void {
            // The views outlive the window: put them back in the holder so every automation
            // verb keeps working while there is nothing to look at. The placements go with it:
            // a window that closed is not one this shell can put anything back into, and the
            // next window's client reports for itself.
            embed.releaseAll(reason);
        },
        parkViews(reason = 'window-hidden'): void {
            parkPlacedViews(reason);
        },
        restoreViews(reason = 'window-shown'): void {
            restoreParkedViews(reason);
        }
    };
}
