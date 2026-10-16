/**
 * The corner layer's view (`./corner-layer.ts`): a see-through `WebContentsView` in the shell
 * window, kept above every web page view.
 *
 * Three things here are not just "a view":
 *
 *   - **It stays on top.** A page view is added to the window each time it is placed
 *     (`./webhost/index.ts` ▸ `attach`), and `addChildView` puts the newest child on top, so the
 *     web host calls `raise` after every attach.
 *   - **It never keeps the keyboard.** A click on a `WebContentsView` makes it the window's first
 *     responder, and this view has nothing to type into: a toast clicked away would leave every
 *     keystroke and shortcut going nowhere. So the moment it takes focus, the keyboard goes back
 *     to whoever had it while the pointer was over the layer, before the click: a web page keeps
 *     its caret, the client keeps its terminal. The click itself still lands here.
 *   - **It is see-through and keeps nothing.** A transparent background, its own in-memory
 *     session (a zoom set on it must not reach the page's origin, which it shares), and a fresh
 *     document on every `load`.
 */

import { WebContentsView, type BrowserWindow } from 'electron';

import type { CornerOverlayView } from './corner-layer.js';
import type { ViewBounds } from './webhost/geometry.js';
import type { KeyboardOwner } from './webhost/nav-focus.js';

export interface CornerOverlayViewOptions {
    readonly window: () => BrowserWindow | null;
    /** Who holds the keyboard in the window right now (the web host's census). */
    readonly keyboardOwner: () => KeyboardOwner;
    /** Hand the keyboard to `owner`. */
    readonly restoreKeyboard: (owner: KeyboardOwner) => void;
    /** The overlay's renderer died. */
    readonly onGone: (reason: string) => void;
}

export interface CornerOverlayViewHandle extends CornerOverlayView {
    /** Put the view back above the page views, if it exists. */
    raise(): void;
}

/** In-memory (no `persist:` prefix): there is nothing here worth keeping. */
const PARTITION = 'kelpi-corner-layer';

export function createCornerOverlayView(options: CornerOverlayViewOptions): CornerOverlayViewHandle {
    let view: WebContentsView | null = null;
    let zoom = 1;
    /** The keyboard's owner as of the pointer's last move over the layer: before any click. */
    let keyboardBefore: KeyboardOwner | null = null;

    const liveWindow = (): BrowserWindow | null => {
        const window = options.window();
        return window === null || window.isDestroyed() ? null : window;
    };

    const create = (window: BrowserWindow): WebContentsView => {
        const created = new WebContentsView({
            webPreferences: {
                partition: PARTITION,
                // The daemon-served client's posture (`./main.ts`): it is the same remote content.
                contextIsolation: true,
                sandbox: true,
                nodeIntegration: false,
                webviewTag: false,
                webSecurity: true,
                spellcheck: false,
                // Hidden whenever no toast is up, and its timers must still run.
                backgroundThrottling: false
            }
        });
        created.setBackgroundColor('#00000000');
        created.setVisible(false);
        const contents = created.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        // `loadURL` from here is not a `will-navigate`; anything the document starts itself is.
        contents.on('will-navigate', (event) => {
            event.preventDefault();
        });
        contents.on('render-process-gone', (_event, details) => {
            options.onGone(details.reason);
        });
        contents.on('input-event', (_event, input) => {
            if (input.type === 'mouseMove' || input.type === 'mouseEnter') keyboardBefore = options.keyboardOwner();
        });
        contents.on('focus', () => {
            const before = keyboardBefore;
            const owner: KeyboardOwner = before === null || before.kind === 'none' ? { kind: 'client' } : before;
            // After the focus change that is still being delivered, not inside it.
            setImmediate(() => {
                options.restoreKeyboard(owner);
            });
        });
        window.contentView.addChildView(created);
        return created;
    };

    const destroy = (): void => {
        const old = view;
        if (old === null) return;
        view = null;
        zoom = 1;
        const window = liveWindow();
        try {
            window?.contentView.removeChildView(old);
        } catch {
            // Already gone with its window.
        }
        try {
            if (!old.webContents.isDestroyed()) old.webContents.close();
        } catch {
            // A renderer already torn down.
        }
    };

    const raise = (): void => {
        const window = liveWindow();
        if (view === null || window === null) return;
        const children = window.contentView.children;
        if (children[children.length - 1] !== view) window.contentView.addChildView(view);
    };

    return {
        async load(url: string): Promise<boolean> {
            const window = liveWindow();
            if (window === null) return false;
            // A fresh document every time: nothing drawn for an earlier page can show for this one.
            destroy();
            view = create(window);
            // A committing load can take the keyboard (§N30); `focus` above gives it back to this.
            keyboardBefore = options.keyboardOwner();
            await view.webContents.loadURL(url);
            return true;
        },
        run(script: string): Promise<unknown> {
            if (view === null || view.webContents.isDestroyed()) return Promise.reject(new Error('no overlay view'));
            return view.webContents.executeJavaScript(script, false);
        },
        place(bounds: ViewBounds, nextZoom: number): void {
            if (view === null) return;
            view.setBounds(bounds);
            if (nextZoom !== zoom) {
                zoom = nextZoom;
                view.webContents.setZoomFactor(nextZoom);
            }
            raise();
            view.setVisible(true);
        },
        hide(): void {
            view?.setVisible(false);
        },
        destroy,
        raise
    };
}
