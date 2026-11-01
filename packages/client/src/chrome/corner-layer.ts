/**
 * The page half of the shell's corner layer: the toast stack drawn ABOVE a live web page.
 *
 * A web pane's page is a native `WebContentsView` the shell composites over this document, so a
 * toast drawn here lands under it. The stack used to register its box with `modal-presence`, which
 * parked every page under that box for the toast's whole life: a still frame where the page was,
 * a wheel that scrolled nothing, and the keyboard taken out of the page by the park
 * (`shell/src/webhost/park-keyboard.ts`) and never given back. A "Removed worktree" toast took the
 * page away from whoever was reading it.
 *
 * The shell can put a view above the pages, so it now draws the stack itself, in a small
 * see-through `WebContentsView` (`overlay.html`) placed over the stack's box. This module is how
 * the page tells it what to draw and hears the clicks back. There is no preload
 * (`shell/src/main.ts`), so both directions are `executeJavaScript` calls the shell makes into one
 * global, the route the quit dialog already uses (`shell/src/quit-prompt.ts`):
 *
 *     __kelpiCorner = { version, next(after), attach(), detach(), act(action) }
 *
 *   - `next(after)` resolves with the newest frame once its `rev` is past `after`. The shell keeps
 *     one call outstanding, so a change reaches it the moment it is published.
 *   - `attach()` is the shell saying its layer drew a frame. From then on the page's own stack is
 *     laid out (it is still the measurement) but not painted, and registers no cover, so no page
 *     parks for a toast.
 *   - `detach()` hands drawing back to the page: the layer died, or could not draw.
 *   - `act(action)` is a click on the layer, routed to the handler the page's own stack uses.
 *
 * Only a page inside a shell window installs the global (`?shellWindow=`). A browser tab, a phone
 * and an older shell never call `attach`, so their stack is drawn here exactly as before. A layer
 * that stops taking frames is dropped by the page itself (`UNTAKEN_FRAME_MS`), so a toast is never
 * left drawn by nobody.
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import type { WsOldTerminalHost } from '@kelpi/protocol';

import { readShellWindowID } from '../webpane/shell-window';
import { measureOverlayRect, type OverlayRect } from './modal-presence';

/** The page-side global the shell drives. */
export const CORNER_PAGE_GLOBAL = '__kelpiCorner';
/** The overlay page's global (`overlay/corner.tsx`). */
export const CORNER_OVERLAY_GLOBAL = '__kelpiCornerOverlay';
/** Bumped when either global changes shape; the shell refuses a page or overlay on another. */
export const CORNER_LAYER_VERSION = 1;

/**
 * How long a changed frame may sit untaken before the page stops trusting the layer.
 *
 * A live shell always has a `next` outstanding, so a frame is normally taken in the same turn it
 * is published. One that is still waiting after this long means the shell's loop is gone (it
 * crashed, or a newer shell is driving a page that outlived it), and a stack nobody draws is a
 * toast nobody sees.
 */
export const UNTAKEN_FRAME_MS = 1_500;

export interface CornerToast {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    /**
     * A click copies text the toast holds (an undelivered agent prompt, `state/agent-launch.ts`).
     * Only the mark crosses to the layer: the text stays in the page, which does the copy when
     * the click is relayed back (`act`). Absent = a click only dismisses.
     */
    readonly copy?: boolean;
}

/** #372's standing card at the bottom of the stack. */
export interface CornerOldHosts {
    readonly hosts: readonly WsOldTerminalHost[];
    /** A restart is in flight: the card's buttons are disabled. */
    readonly restarting: boolean;
}

/** What the stack is drawing. Plain data: it crosses two processes as JSON. */
export interface CornerContent {
    readonly toasts: readonly CornerToast[];
    readonly oldHosts: CornerOldHosts | null;
}

export interface CornerFrame {
    readonly version: number;
    /** Increases on every change, so the shell can wait for "anything after N". */
    readonly rev: number;
    /** Whether the page has handed drawing to the layer (it echoes `attach`/`detach`). */
    readonly attached: boolean;
    /** The stack's box in this page's viewport CSS pixels; null when nothing is up. */
    readonly rect: OverlayRect | null;
    readonly content: CornerContent | null;
    /** The theme's `--kelpi-*` custom properties, as `ThemeProvider` stamped them on `:root`. */
    readonly vars: Readonly<Record<string, string>>;
    /** `:root`'s `data-kelpi-theme`, which the stylesheet's light blocks key on. */
    readonly theme: string | null;
    /** With the shell's scale factor, turns the CSS rect into the window's DIPs. */
    readonly devicePixelRatio: number;
}

export type CornerAction =
    | { readonly kind: 'dismiss'; readonly id: string }
    | { readonly kind: 'restart-old-hosts' }
    | { readonly kind: 'later-old-hosts' };

/** Read a click the shell relayed, or null when it is not one. */
export function parseCornerAction(value: unknown): CornerAction | null {
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const kind = record['kind'];
    if (kind === 'dismiss') {
        const id = record['id'];
        return typeof id === 'string' && id.length > 0 ? { kind, id } : null;
    }
    if (kind === 'restart-old-hosts' || kind === 'later-old-hosts') return { kind };
    return null;
}

// ── the bridge ──────────────────────────────────────────────────────────────────────

interface Published {
    readonly rect: OverlayRect | null;
    readonly content: CornerContent | null;
    readonly vars: Readonly<Record<string, string>>;
    readonly theme: string | null;
    readonly devicePixelRatio: number;
}

const EMPTY: Published = { rect: null, content: null, vars: {}, theme: null, devicePixelRatio: 1 };

let installed = false;
let attached = false;
let rev = 0;
let published: Published = EMPTY;
let publishedKey = JSON.stringify(EMPTY);
/** The newest rev a `next` has handed to the shell. */
let taken = 0;
let waiters: ((frame: CornerFrame) => void)[] = [];
let handler: ((action: CornerAction) => void) | null = null;
let untakenTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function currentFrame(): CornerFrame {
    return { version: CORNER_LAYER_VERSION, rev, attached, ...published };
}

function armUntaken(): void {
    if (!attached || taken >= rev) {
        if (untakenTimer !== null) clearTimeout(untakenTimer);
        untakenTimer = null;
        return;
    }
    if (untakenTimer !== null) return;
    untakenTimer = setTimeout(() => {
        untakenTimer = null;
        if (attached && taken < rev) setAttached(false);
    }, UNTAKEN_FRAME_MS);
}

function bump(): void {
    rev += 1;
    const waiting = waiters;
    waiters = [];
    if (waiting.length > 0) {
        taken = rev;
        const frame = currentFrame();
        for (const resolve of waiting) resolve(frame);
    }
    armUntaken();
}

function setAttached(next: boolean): void {
    if (attached === next) return;
    attached = next;
    // A frame of its own, so the shell hears that the page took drawing back.
    bump();
    for (const listener of [...listeners]) listener();
}

function next(after: unknown): Promise<CornerFrame> {
    const since = typeof after === 'number' && Number.isFinite(after) ? after : -1;
    // `since > rev` is a shell holding a rev from a page that has since reloaded: answer now.
    if (rev !== since) {
        taken = Math.max(taken, rev);
        armUntaken();
        return Promise.resolve(currentFrame());
    }
    return new Promise((resolve) => {
        waiters.push(resolve);
    });
}

function act(value: unknown): boolean {
    const action = parseCornerAction(value);
    if (action === null || handler === null) return false;
    handler(action);
    return true;
}

/**
 * Install `__kelpiCorner` on `target`. Called once at import time inside a shell window; tests
 * call it directly.
 */
export function installCornerBridge(target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): void {
    if (installed) return;
    installed = true;
    target[CORNER_PAGE_GLOBAL] = Object.freeze({
        version: CORNER_LAYER_VERSION,
        next,
        attach: (): boolean => {
            setAttached(true);
            return true;
        },
        detach: (): boolean => {
            setAttached(false);
            return true;
        },
        act
    });
}

/** Test seam: forget everything, as a fresh page would. */
export function resetCornerBridgeForTests(target?: Record<string, unknown>): void {
    if (target !== undefined) delete target[CORNER_PAGE_GLOBAL];
    if (untakenTimer !== null) clearTimeout(untakenTimer);
    untakenTimer = null;
    installed = false;
    attached = false;
    rev = 0;
    published = EMPTY;
    publishedKey = JSON.stringify(EMPTY);
    taken = 0;
    waiters = [];
    handler = null;
    for (const listener of [...listeners]) listener();
}

function readThemeVars(): { vars: Record<string, string>; theme: string | null } {
    const root = globalThis.document?.documentElement;
    if (root === undefined || root === null) return { vars: {}, theme: null };
    const vars: Record<string, string> = {};
    for (const name of Array.from(root.style)) {
        if (name.startsWith('--kelpi-')) vars[name] = root.style.getPropertyValue(name).trim();
    }
    return { vars, theme: root.dataset['kelpiTheme'] ?? null };
}

/**
 * Publish what the stack draws now. A no-op outside a shell window, and when nothing changed.
 *
 * The theme is only read while something is up: an empty frame draws nothing, so its colours
 * cannot matter, and the stack's owner renders far more often than a toast arrives.
 */
export function publishCorner(
    rect: OverlayRect | null,
    content: CornerContent | null,
    onAction: ((action: CornerAction) => void) | null
): void {
    if (!installed) return;
    handler = onAction;
    const theme = content === null ? { vars: {}, theme: null } : readThemeVars();
    const nextPublished: Published = {
        rect: content === null ? null : rect,
        content,
        vars: theme.vars,
        theme: theme.theme,
        devicePixelRatio: globalThis.devicePixelRatio > 0 ? globalThis.devicePixelRatio : 1
    };
    const key = JSON.stringify(nextPublished);
    if (key === publishedKey) return;
    published = nextPublished;
    publishedKey = key;
    bump();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Whether the shell's layer is drawing the stack right now. */
export function cornerLayerAttached(): boolean {
    return installed && attached;
}

/**
 * Publish the stack at `ref` to the shell's layer and say whether the layer is drawing it.
 *
 * Measured after every render of the owner, the way `useOverlayPresence` measures: a toast arriving
 * or leaving is a render, and each one moves the box. A window resize, a theme change and a card
 * reflowing on its own are not renders, so those are watched while something is up.
 */
export function useCornerLayer(
    ref: RefObject<Element | null>,
    content: CornerContent | null,
    onAction: (action: CornerAction) => void
): boolean {
    const isAttached = useSyncExternalStore(subscribe, cornerLayerAttached, () => false);
    const action = useRef(onAction);
    action.current = onAction;
    const latest = useRef(content);
    latest.current = content;

    useLayoutEffect(() => {
        publishCorner(content === null ? null : measureOverlayRect(ref.current), content, (value) => {
            action.current(value);
        });
    });
    // A stack that is gone draws nothing, wherever it was drawn.
    useLayoutEffect(() => () => publishCorner(null, null, null), []);

    const showing = content !== null;
    useEffect(() => {
        if (!installed || !showing) return undefined;
        const republish = (): void => {
            const current = latest.current;
            publishCorner(current === null ? null : measureOverlayRect(ref.current), current, (value) => {
                action.current(value);
            });
        };
        const view = globalThis as {
            ResizeObserver?: new (callback: () => void) => { observe(target: Element): void; disconnect(): void };
            MutationObserver?: new (callback: () => void) => {
                observe(target: Node, options: { attributes: boolean; attributeFilter: string[] }): void;
                disconnect(): void;
            };
        };
        const element = ref.current;
        const resize = element !== null && view.ResizeObserver !== undefined ? new view.ResizeObserver(republish) : null;
        if (element !== null) resize?.observe(element);
        const root = globalThis.document?.documentElement ?? null;
        const theme = root !== null && view.MutationObserver !== undefined ? new view.MutationObserver(republish) : null;
        if (root !== null) theme?.observe(root, { attributes: true, attributeFilter: ['style', 'data-kelpi-theme'] });
        globalThis.addEventListener?.('resize', republish);
        return () => {
            resize?.disconnect();
            theme?.disconnect();
            globalThis.removeEventListener?.('resize', republish);
        };
    }, [showing, ref]);

    return isAttached;
}

if (readShellWindowID() !== null) installCornerBridge();
