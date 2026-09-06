/**
 * KELPI_HARNESS_SOCKET: a test-only control channel to the native surfaces a driver cannot reach.
 *
 * Why it exists. The UI audit and the smoke scripts drive this shell over CDP, and CDP stops at
 * the renderer. Three fixes shipped only unit-verified because the thing they changed is on the
 * other side of that line:
 *
 *   - #47: a rebound keybind moves a menu-bar chord (config-keybindings.md §7.1). A native
 *     accelerator outranks the page, so the only proof that ⌘N now does what the user bound it to
 *     is to press ⌘N natively and watch which row fires. `Input.dispatchKeyEvent` is a renderer
 *     event; the menu never sees it.
 *   - #53: a dialog's default button answers Return and Escape. The quit gate's native
 *     `dialog.showMessageBox` (quit.ts, §AGNT-116) is a Cocoa alert; CDP cannot see it, cannot
 *     click it, and a run that raises one hangs until a human does.
 *   - #55: the dock bounces on a stop, and only while the app is inactive
 *     (agent-lifecycle.md §7.1, §14 invariant 6). `app.dock.bounce` leaves no trace a page can
 *     read, so "did it bounce, and did it bounce ONLY then" was a code review, not a check.
 *
 * What it is. A Unix socket at `KELPI_HARNESS_SOCKET`, newline-delimited JSON, one response
 * line per request (`./harness-protocol.ts` has the wire shape and every rule; this file is the
 * plumbing). Over it a driver can read the application menu, click a row by id or label path,
 * press a chord and land where the OS would, count dock bounces, count and pre-answer message
 * boxes, read every notification the shell showed and click or close one as the OS would
 * (agent-lifecycle.md §7), read which URLs the shell handed the OS opener (#83, and under the
 * harness the open is recorded INSTEAD of performed, never as well as), and read, focus or blur
 * the main window (the bounce is only reachable while the window is unfocused, so `blur` is the
 * step before "make an agent stop").
 *
 * What makes it safe. The gate is the env var being a non-empty path and nothing else
 * (`harnessSocketPath`): a user's shell, the packaged app, and every existing probe that sets
 * `KELPI_HARNESS=1` or `KELPI_AUDIT=1` get no server, no socket file and no wrapper, and
 * `harness-protocol.test.ts` pins that the way `audit-window.test.ts` pins the window policy.
 * With the gate set, two of the three wrappers are property replacements on the live `app.dock`
 * and `dialog` objects (which is why `status.ts` and `quit.ts` call them by property, never
 * through a bound copy); both still call the original, except a message box a driver has armed
 * an answer for, which is resolved without being shown. The third is notifications (#67), which
 * have no property to replace, `new Notification(...)` is a class import, so `./notify.ts`
 * and `./notify-present.ts` give them one seam to be wrapped at instead, and it still posts for
 * real unless `KELPI_HARNESS_QUIET_NOTIFICATIONS=1`. The socket is unlinked before listening (a stale
 * file from a killed run) and again on `will-quit`. There is no auth on the socket because the
 * sandbox root it lives in is the auth: it is created 0700 by the harness that spawned this
 * process, and nothing else is expected to find it.
 */

import type { App, BrowserWindow, Dialog, Menu, MenuItem, MessageBoxReturnValue, shell as ElectronShell } from 'electron';
import { rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import {
    HarnessCounters,
    LineBuffer,
    encodeResponse,
    messageBoxSpecFrom,
    respondToLine,
    type HarnessSurface,
    type WindowSnapshot
} from './harness-protocol.js';
import { setNotificationPresenter } from './notify-present.js';
import type { NotificationPresenter } from './notify.js';

export interface HarnessOptions {
    readonly app: App;
    readonly dialog: Dialog;
    /** Electron's `shell` module, for the `openExternal` wrapper (#83). */
    readonly shell: typeof ElectronShell;
    readonly BrowserWindow: typeof BrowserWindow;
    readonly Menu: typeof Menu;
    readonly socketPath: string;
    /**
     * `KELPI_HARNESS_QUIET_NOTIFICATIONS=1` (#67): record every notification and post none.
     * The caller reads the gate (`harnessQuietNotifications`) so both gates have one spelling
     * each and neither is read anywhere a user's shell can reach.
     */
    readonly quietNotifications: boolean;
    /** The main window, read on every request: it can be replaced or destroyed mid-run. */
    readonly mainWindow: () => BrowserWindow | null;
    readonly log: (message: string) => void;
    readonly logError: (message: string, error?: unknown) => void;
}

interface Running {
    readonly socketPath: string;
    readonly server: Server;
    readonly sockets: Set<Socket>;
    /** Put `app.dock.bounce`, `dialog.showMessageBox` and `shell.openExternal` back. */
    readonly restore: () => void;
    readonly log: (message: string) => void;
}

let running: Running | null = null;

function liveWindow(get: () => BrowserWindow | null): BrowserWindow | null {
    const window = get();
    return window !== null && !window.isDestroyed() ? window : null;
}

/**
 * Count bounces, then bounce. The original is still called, because a driver checking #55 wants
 * to see the shell do the real thing, not a stub of it.
 */
function wrapDock(app: App, counters: HarnessCounters): () => void {
    const dock = app.dock;
    if (dock === undefined) return () => {};
    const original = dock.bounce;
    dock.bounce = (type) => {
        counters.recordBounce(type);
        return original.call(dock, type);
    };
    return () => {
        dock.bounce = original;
    };
}

/**
 * Record every `shell.openExternal`, and DO NOT perform it (#83).
 *
 * The opposite choice from `wrapDock`, deliberately. A dock bounce happens inside this app and a
 * driver wants to see the shell do the real thing; an external open leaves the app entirely and
 * launches the user's browser, and a battery of scenarios that pops a browser window onto the
 * machine's screen every time it ⌘-clicks a link is not something anyone can run. So this
 * swallows the call the same way `wrapDialog` swallows an armed message box: the record is
 * complete, the side effect is not performed, and the caller's `Promise<void>` resolves exactly
 * as the real one does. Only ever installed behind `KELPI_HARNESS_SOCKET`: a user's app has no
 * wrapper and opens links for real.
 *
 * `main.ts`'s `openExternally` calls `shell.openExternal(...)` by property, so replacing the
 * property is enough; `defineProperty` is the fallback for an Electron build that ships these as
 * non-writable accessors, since a silently un-wrapped opener would read as "the app opened
 * nothing" and be diagnosed as a product bug.
 */
function wrapExternalOpen(shell: typeof ElectronShell, counters: HarnessCounters): () => void {
    const target = shell as unknown as { openExternal: (url: string, options?: unknown) => Promise<void> };
    const original = target.openExternal;
    const wrapper = async (url: string): Promise<void> => {
        counters.recordExternalOpen(url);
    };
    target.openExternal = wrapper;
    if (target.openExternal !== wrapper) {
        Object.defineProperty(target, 'openExternal', { value: wrapper, configurable: true, writable: true });
    }
    return () => {
        target.openExternal = original;
    };
}

type AnyShowMessageBox = (...args: unknown[]) => Promise<MessageBoxReturnValue>;

/**
 * Record every message box; answer the armed one without showing it.
 *
 * Both `showMessageBox` overloads pass through untouched (`messageBoxSpecFrom` reads whichever
 * was used). An armed answer resolves on the microtask queue, which is the same shape as the
 * real call's promise, so the quit gate's `await` sees no difference between a driver's answer
 * and a user's click.
 */
function wrapDialog(dialog: Dialog, counters: HarnessCounters): () => void {
    const target = dialog as unknown as { showMessageBox: AnyShowMessageBox };
    const original = target.showMessageBox;
    target.showMessageBox = (...args) => {
        const handle = counters.openDialog(messageBoxSpecFrom(args));
        const armed = counters.takeArm();
        if (armed !== null) {
            counters.settleDialog(handle, armed.response);
            return Promise.resolve({ response: armed.response, checkboxChecked: armed.checkboxChecked });
        }
        return original.apply(dialog, args).then((value) => {
            counters.settleDialog(handle, value.response);
            return value;
        });
    };
    return () => {
        target.showMessageBox = original;
    };
}

/**
 * Record every notification the shell posts, and keep posting it (#67).
 *
 * Not a property replacement like the two above, because there is no property: `new
 * Notification(...)` is a class import, which is exactly why the channel could not see a
 * notification at all before this. `./notify-present.ts` is the seam that makes it wrappable, 
 * one module-level function every site calls, and this swaps the presenter behind it and puts
 * the previous one back on `stopHarness`.
 *
 * The site's own handlers are routed THROUGH the record rather than handed to the real
 * notification directly, so `notification-click` fires the same closure the OS would and the
 * record still learns about a close the OS started (a user swiping the banner away). All three
 * are forwarded whether or not the site supplied one: an extra listener on an Electron
 * `Notification` has no observable effect, and the alternative is a record that quietly stops
 * tracking `closed` for the shell's own notices.
 *
 * `quiet` removes exactly one thing: the OS call. The record, the handlers and both ops behave
 * identically, which is what lets a parallel run keep its Notification Centre to itself.
 */
function wrapNotifications(counters: HarnessCounters, quiet: boolean): () => void {
    let original: NotificationPresenter;
    const wrapper: NotificationPresenter = (request, handlers) => {
        const entry = counters.openNotification(request, handlers);
        entry.attach(
            quiet
                ? null
                : original(request, {
                      onClick: () => entry.dispatchClick(),
                      onAction: (index) => entry.dispatchAction(index),
                      onClose: () => entry.dispatchClose()
                  })
        );
        return entry;
    };
    original = setNotificationPresenter(wrapper);
    return () => {
        setNotificationPresenter(original);
    };
}

function makeSurface(options: HarnessOptions, counters: HarnessCounters): HarnessSurface<MenuItem> {
    const { app, BrowserWindow: Windows, Menu: Menus, mainWindow } = options;
    return {
        platform: process.platform,
        pid: process.pid,
        version: () => app.getVersion(),
        menuItems: () => Menus.getApplicationMenu()?.items ?? [],
        clickItem: (item) => {
            // Exactly the call Electron makes for a menu selection, `menuItem.click(event,
            // focusedWindow, focusedWebContents)`, with the same window a click would get: the
            // focused one, else the main window (closeFocusedPaneOrWindow in main.ts makes the
            // same choice).
            const focused = Windows.getFocusedWindow();
            const target = focused ?? liveWindow(mainWindow);
            (item.click as (...args: unknown[]) => unknown)(undefined, target ?? undefined, focused?.webContents);
        },
        window: (): WindowSnapshot | null => {
            const window = liveWindow(mainWindow);
            if (window === null) return null;
            const bounds = window.getBounds();
            return {
                focused: window.isFocused(),
                visible: window.isVisible(),
                bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
            };
        },
        focus: () => {
            const window = liveWindow(mainWindow);
            if (window === null) return null;
            window.show();
            window.focus();
            return window.isFocused();
        },
        blur: () => {
            const window = liveWindow(mainWindow);
            if (window === null) return null;
            window.blur();
            return window.isFocused();
        },
        counters
    };
}

/**
 * Install the wrappers and open the socket. Idempotent: a second call stops the first channel.
 * Only ever reached with `harnessSocketPath(process.env)` non-null; the caller owns that check
 * so the gate has exactly one spelling.
 */
export function startHarness(options: HarnessOptions): void {
    stopHarness();
    const { socketPath, log, logError } = options;
    const counters = new HarnessCounters();
    const restoreDock = wrapDock(options.app, counters);
    const restoreDialog = wrapDialog(options.dialog, counters);
    const restoreExternalOpen = wrapExternalOpen(options.shell, counters);
    const restoreNotifications = wrapNotifications(counters, options.quietNotifications);
    const surface = makeSurface(options, counters);
    const sockets = new Set<Socket>();

    const server = createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        const lines = new LineBuffer();
        socket.on('data', (chunk: string | Buffer) => {
            for (const line of lines.push(String(chunk))) {
                // Synchronous end to end, so responses leave in request order per connection.
                const response = respondToLine(line, surface);
                if (!socket.destroyed) socket.write(encodeResponse(response));
            }
        });
        // A driver that disconnects mid-line is not an error of ours.
        socket.on('error', () => {});
        socket.on('close', () => {
            sockets.delete(socket);
        });
    });
    server.on('error', (error) => {
        logError(`harness: cannot listen on ${socketPath}`, error);
    });

    // A stale socket file from a hard-killed run would make `listen` fail with EADDRINUSE even
    // though nothing is behind it; `force` makes a missing file a no-op.
    rmSync(socketPath, { force: true });
    server.listen(socketPath, () => {
        log(`harness: control channel listening on ${socketPath}`);
    });

    running = {
        socketPath,
        server,
        sockets,
        restore: () => {
            restoreNotifications();
            restoreExternalOpen();
            restoreDialog();
            restoreDock();
        },
        log
    };
}

/** Close the socket, drop every client, restore the wrapped methods. Safe to call when idle. */
export function stopHarness(): void {
    const current = running;
    if (current === null) return;
    running = null;
    for (const socket of current.sockets) socket.destroy();
    current.sockets.clear();
    current.server.close();
    current.restore();
    rmSync(current.socketPath, { force: true });
    current.log(`harness: control channel closed ${current.socketPath}`);
}
