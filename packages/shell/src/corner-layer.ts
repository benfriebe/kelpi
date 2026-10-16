/**
 * The corner layer: the page's toast stack, drawn by the shell ABOVE the web pages.
 *
 * A web pane's page is a native `WebContentsView` composited over the client's document, so the
 * client's toast stack is drawn under any page it overlaps. The client used to park every page
 * under the stack for the toast's life (a still frame in the page's place, the wheel scrolling
 * nothing), and the park took the keyboard out of the page (`./webhost/park-keyboard.ts`) without
 * ever giving it back. A "Removed worktree" toast stole the page from whoever was using it.
 *
 * The shell can stack views, so it draws the stack itself: a small see-through view loading the
 * client's `overlay.html`, placed over the box the page measured its stack in, above every page
 * view. The page stops parking anything once the layer has drawn (`client/src/chrome/corner-layer.ts`
 * has its half and the global's contract).
 *
 * There is no preload (`./main.ts`), so the three parties talk through `executeJavaScript`, the
 * route `./quit-prompt.ts` already takes, with a promise held open as the return channel:
 *
 *     page.next(after)  -> the page's next frame        -> overlay.render({frame, inset})
 *     overlay.next()    -> the next click on the layer   -> page.act(action)
 *
 * Every step fails toward today's behaviour. A page without the global (an older daemon), an
 * overlay that will not load or answer, a frame that will not draw: the page is told to `detach`
 * (or was never told to `attach`) and draws and parks for its own stack exactly as it did before.
 *
 * Pure by construction - no `electron` import - so the loops and the placement are unit-tested
 * under plain Node; `./corner-layer-view.ts` supplies the Electron view.
 */

import { cssToDipScale, viewBounds, type CssRect, type ViewBounds, type WindowMetrics } from './webhost/geometry.js';

/** The page's global (`client/src/chrome/corner-layer.ts`). */
export const CORNER_PAGE_GLOBAL = '__kelpiCorner';
/** The overlay's global (`client/src/overlay/CornerOverlay.tsx`). */
export const CORNER_OVERLAY_GLOBAL = '__kelpiCornerOverlay';
/** Both globals' shape. A page or overlay on another version is left alone. */
export const CORNER_LAYER_VERSION = 1;
/** Served by the daemon beside the client's `index.html`. */
export const CORNER_OVERLAY_PATH = '/overlay.html';

/**
 * See-through CSS px kept around the stack, so the cards' drop shadow is not cut off at the view's
 * edge. Small on purpose: the margin is part of the view, so a click or a wheel there reaches the
 * layer and not the page under it.
 */
export const CORNER_MARGIN_PX = 12;

/** A property read on a loaded page; a second of silence is a renderer that is not answering. */
export const CORNER_PROBE_TIMEOUT_MS = 2_000;
/** One React render and two animation frames. */
export const CORNER_RENDER_TIMEOUT_MS = 2_000;
/** How many times one page load may lose its overlay renderer before the layer gives up. */
export const CORNER_OVERLAY_RESTARTS = 3;

export type CornerAction =
    | { readonly kind: 'dismiss'; readonly id: string }
    | { readonly kind: 'restart-old-hosts' }
    | { readonly kind: 'later-old-hosts' };

/** A frame from the page, read as far as the shell needs and otherwise passed on untouched. */
export interface CornerFrame {
    readonly rev: number;
    readonly attached: boolean;
    readonly rect: CssRect | null;
    readonly hasContent: boolean;
    readonly devicePixelRatio: number;
    /** The frame as the page sent it: the overlay draws from this. */
    readonly raw: Readonly<Record<string, unknown>>;
}

export interface CornerPlacement {
    /** Window DIPs, for `setBounds`. */
    readonly bounds: ViewBounds;
    /** CSS px from the view's right and bottom edges to the stack's (see `CornerOverlayInput`). */
    readonly inset: { readonly right: number; readonly bottom: number };
    /** The overlay's zoom, so one of its CSS px is one of the page's. */
    readonly zoom: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function readRect(value: unknown): CssRect | null | undefined {
    if (value === null) return null;
    if (!isRecord(value)) return undefined;
    const { x, y, w, h } = value;
    if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w < 0 || h < 0) return undefined;
    return { x, y, w, h };
}

/** Read a frame from the page, or null when it is not one this shell understands. */
export function parseCornerFrame(value: unknown): CornerFrame | null {
    if (!isRecord(value) || value['version'] !== CORNER_LAYER_VERSION) return null;
    const rev = value['rev'];
    const attached = value['attached'];
    const rect = readRect(value['rect']);
    const content = value['content'];
    if (!finite(rev) || typeof attached !== 'boolean' || rect === undefined) return null;
    if (content !== null && !isRecord(content)) return null;
    const dpr = value['devicePixelRatio'];
    return {
        rev,
        attached,
        rect,
        hasContent: content !== null,
        devicePixelRatio: finite(dpr) && dpr > 0 ? dpr : 1,
        raw: value
    };
}

/** Read a click from the overlay, or null. The page validates it again. */
export function parseCornerAction(value: unknown): CornerAction | null {
    if (!isRecord(value)) return null;
    const kind = value['kind'];
    if (kind === 'dismiss') {
        const id = value['id'];
        return typeof id === 'string' && id.length > 0 && id.length <= 512 ? { kind, id } : null;
    }
    if (kind === 'restart-old-hosts' || kind === 'later-old-hosts') return { kind };
    return null;
}

/**
 * Where the overlay goes for a stack at `rect` (the page's viewport CSS px), or null when that
 * lands nowhere inside the window.
 *
 * The margin is clamped at the window's edges along with everything else (`viewBounds`), so the
 * inset is read back off the bounds actually chosen rather than assumed to be the margin.
 */
export function cornerPlacement(
    rect: CssRect,
    devicePixelRatio: number,
    metrics: WindowMetrics,
    margin: number = CORNER_MARGIN_PX
): CornerPlacement | null {
    if (rect.w <= 0 || rect.h <= 0) return null;
    const box = { x: rect.x - margin, y: rect.y - margin, w: rect.w + margin * 2, h: rect.h + margin * 2 };
    const bounds = viewBounds(
        { paneID: '', tabID: null, rect: box, visible: true, devicePixelRatio, ownWindow: true, shellWindowID: null },
        metrics
    );
    if (bounds === null) return null;
    const scale = cssToDipScale(devicePixelRatio, metrics.scaleFactor);
    const right = (bounds.x + bounds.width) / scale - (rect.x + rect.w);
    const bottom = (bounds.y + bounds.height) / scale - (rect.y + rect.h);
    return { bounds, inset: { right: Math.max(0, right), bottom: Math.max(0, bottom) }, zoom: scale };
}

/** The overlay page's address, beside the page the window loaded; null for anything not served. */
export function cornerOverlayURL(pageURL: string): string | null {
    try {
        const url = new URL(pageURL);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return `${url.origin}${CORNER_OVERLAY_PATH}`;
    } catch {
        return null;
    }
}

/** An expression answering the global's `version`, or null when there is none. */
export function cornerProbeScript(global: string): string {
    return `(() => { const g = globalThis[${JSON.stringify(global)}]; return typeof g === 'object' && g !== null ? g.version : null; })()`;
}

/** `globalThis[global][method](...args)`, with every argument embedded as JSON. */
export function cornerCallScript(global: string, method: string, ...args: readonly unknown[]): string {
    return `globalThis[${JSON.stringify(global)}][${JSON.stringify(method)}](${args.map((arg) => JSON.stringify(arg)).join(', ')})`;
}

/** The overlay view, as the controller drives it (`./corner-layer-view.ts`). */
export interface CornerOverlayView {
    /** Create the view if there is none, and load `url` into it. True once it has loaded. */
    load(url: string): Promise<boolean>;
    run(script: string): Promise<unknown>;
    /** Put the view at `bounds`, above every page view, and show it. */
    place(bounds: ViewBounds, zoom: number): void;
    hide(): void;
    /** Take the view down; the next `load` makes a fresh one. */
    destroy(): void;
}

export interface CornerLayerSeams {
    /** Run an expression in the shell window's page. Rejects when the page cannot answer. */
    runInPage(script: string): Promise<unknown>;
    readonly overlay: CornerOverlayView;
    /** The window's content size and scale, or null when there is no window to place in. */
    metrics(): WindowMetrics | null;
    log(line: string): void;
    warn(line: string): void;
    readonly probeTimeoutMs?: number;
    readonly renderTimeoutMs?: number;
}

export type CornerLayerState = 'idle' | 'starting' | 'drawing' | 'off';

export interface CornerLayer {
    /** The window's page finished loading `pageURL`: (re)start the layer for it. */
    pageLoaded(pageURL: string): void;
    /** The page is going (a navigation, a crash, the window closing): stop and hide. */
    pageGone(reason: string): void;
    /** The overlay's renderer died: give drawing back to the page, then load a fresh one. */
    overlayGone(reason: string): void;
    dispose(): void;
    readonly state: CornerLayerState;
}

class TimedOut extends Error {}

function timed<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimedOut(`no answer in ${String(ms)} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function createCornerLayer(seams: CornerLayerSeams): CornerLayer {
    const probeMs = seams.probeTimeoutMs ?? CORNER_PROBE_TIMEOUT_MS;
    const renderMs = seams.renderTimeoutMs ?? CORNER_RENDER_TIMEOUT_MS;
    /** Bumped by every stop; a loop that sees a newer one has been superseded and exits. */
    let generation = 0;
    let pageURL: string | null = null;
    let restarts = 0;
    let state: CornerLayerState = 'idle';
    /** The view's bounds while it is showing; null while it is hidden. */
    let shown: ViewBounds | null = null;
    /** Renders are serialized: a frame never draws over one that has not finished. */
    let queue: Promise<unknown> = Promise.resolve();

    const enqueue = (task: () => Promise<boolean>): Promise<boolean> => {
        const run = queue.then(task, task);
        queue = run.catch(() => undefined);
        return run;
    };

    const hideNow = (): void => {
        if (shown === null) return;
        shown = null;
        try {
            seams.overlay.hide();
        } catch (error) {
            seams.warn(`corner layer: hide failed (${message(error)})`);
        }
    };

    const stop = (): number => {
        generation += 1;
        hideNow();
        return generation;
    };

    /** Draw `frame`, or hide the view when it holds nothing. False when the overlay failed. */
    const show = async (frame: CornerFrame, gen: number): Promise<boolean> => {
        if (gen !== generation) return false;
        const metrics = seams.metrics();
        const placement =
            frame.rect === null || !frame.hasContent || metrics === null
                ? null
                : cornerPlacement(frame.rect, frame.devicePixelRatio, metrics);
        try {
            if (placement === null) {
                if (shown !== null) {
                    // Painted empty while still on screen, so the next show cannot flash this card.
                    await timed(seams.overlay.run(cornerCallScript(CORNER_OVERLAY_GLOBAL, 'render', null)), renderMs);
                    if (gen === generation) hideNow();
                }
                return true;
            }
            const draw = cornerCallScript(CORNER_OVERLAY_GLOBAL, 'render', { frame: frame.raw, inset: placement.inset });
            if (shown === null) {
                // A hidden view paints nothing, so its frame would never land: show it first. It
                // was emptied before it was hidden, so what appears for that instant is nothing.
                seams.overlay.place(placement.bounds, placement.zoom);
                shown = placement.bounds;
                await timed(seams.overlay.run(draw), renderMs);
            } else {
                // On screen: draw first and move after, so the old box never shows the new frame
                // at the wrong offset. The cards are anchored bottom-right, so a box that has not
                // grown yet only clips the newest card for that instant.
                await timed(seams.overlay.run(draw), renderMs);
                if (gen !== generation) return false;
                seams.overlay.place(placement.bounds, placement.zoom);
                shown = placement.bounds;
            }
            return true;
        } catch (error) {
            seams.warn(`corner layer: the overlay did not draw (${message(error)})`);
            return false;
        }
    };

    /** The layer cannot be trusted with the stack any more: hand it back to the page. */
    const giveBack = (gen: number, why: string): void => {
        if (gen !== generation) return;
        stop();
        state = 'off';
        seams.warn(`corner layer: off, the page draws its own toasts (${why})`);
        void seams.runInPage(cornerCallScript(CORNER_PAGE_GLOBAL, 'detach')).catch(() => undefined);
    };

    const followFrames = async (gen: number): Promise<void> => {
        let after = -1;
        while (gen === generation) {
            let raw: unknown;
            try {
                raw = await seams.runInPage(cornerCallScript(CORNER_PAGE_GLOBAL, 'next', after));
            } catch (error) {
                // A page that is navigating or gone rejects its pending calls; `pageGone` or the
                // next `pageLoaded` is already on its way and owns what happens next.
                if (gen === generation) giveBack(gen, `the page stopped answering: ${message(error)}`);
                return;
            }
            if (gen !== generation) return;
            const frame = parseCornerFrame(raw);
            if (frame === null) {
                giveBack(gen, 'the page sent a frame this shell cannot read');
                return;
            }
            after = frame.rev;
            const drawn = await enqueue(() => show(frame, gen));
            if (gen !== generation) return;
            if (!drawn) {
                giveBack(gen, 'a frame did not draw');
                return;
            }
            if (!frame.attached) {
                await seams.runInPage(cornerCallScript(CORNER_PAGE_GLOBAL, 'attach')).catch(() => undefined);
            }
        }
    };

    const collectClicks = async (gen: number): Promise<void> => {
        while (gen === generation) {
            let raw: unknown;
            try {
                raw = await seams.overlay.run(cornerCallScript(CORNER_OVERLAY_GLOBAL, 'next'));
            } catch {
                return;
            }
            if (gen !== generation) return;
            const action = parseCornerAction(raw);
            if (action === null) continue;
            await seams.runInPage(cornerCallScript(CORNER_PAGE_GLOBAL, 'act', action)).catch((error: unknown) => {
                seams.warn(`corner layer: a click on the layer did not reach the page (${message(error)})`);
            });
        }
    };

    const start = async (gen: number, url: string): Promise<void> => {
        state = 'starting';
        const pageVersion = await timed(seams.runInPage(cornerProbeScript(CORNER_PAGE_GLOBAL)), probeMs).catch(
            () => null
        );
        if (gen !== generation) return;
        if (pageVersion !== CORNER_LAYER_VERSION) {
            state = 'off';
            seams.log(`corner layer: off, the page has no corner bridge (${JSON.stringify(pageVersion)})`);
            return;
        }
        const overlayURL = cornerOverlayURL(url);
        if (overlayURL === null) {
            state = 'off';
            return;
        }
        const loaded = await seams.overlay.load(overlayURL).catch((error: unknown) => {
            seams.warn(`corner layer: ${overlayURL} did not load (${message(error)})`);
            return false;
        });
        if (gen !== generation) return;
        const overlayVersion = loaded
            ? await timed(seams.overlay.run(cornerProbeScript(CORNER_OVERLAY_GLOBAL)), probeMs).catch(() => null)
            : null;
        if (gen !== generation) return;
        if (overlayVersion !== CORNER_LAYER_VERSION) {
            state = 'off';
            seams.warn(`corner layer: off, the overlay did not come up (${JSON.stringify(overlayVersion)})`);
            seams.overlay.destroy();
            return;
        }
        state = 'drawing';
        seams.log('corner layer: drawing the toast stack above the web pages');
        void collectClicks(gen);
        void followFrames(gen);
    };

    return {
        pageLoaded(url: string): void {
            const gen = stop();
            pageURL = url;
            restarts = 0;
            void start(gen, url);
        },
        pageGone(reason: string): void {
            if (pageURL === null && state !== 'drawing') return;
            stop();
            pageURL = null;
            state = 'idle';
            seams.log(`corner layer: stopped (${reason})`);
        },
        overlayGone(reason: string): void {
            const gen = stop();
            seams.overlay.destroy();
            const url = pageURL;
            if (url === null) return;
            // The page is still hiding its own stack behind a layer that is no longer there.
            void seams.runInPage(cornerCallScript(CORNER_PAGE_GLOBAL, 'detach')).catch(() => undefined);
            if (restarts >= CORNER_OVERLAY_RESTARTS) {
                state = 'off';
                seams.warn(`corner layer: off, the overlay died ${String(restarts + 1)} times (${reason})`);
                return;
            }
            restarts += 1;
            seams.warn(`corner layer: the overlay died (${reason}); loading a fresh one`);
            void start(gen, url);
        },
        dispose(): void {
            stop();
            pageURL = null;
            state = 'idle';
            seams.overlay.destroy();
        },
        get state(): CornerLayerState {
            return state;
        }
    };
}
