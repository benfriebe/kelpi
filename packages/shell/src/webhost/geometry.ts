/**
 * Where a web pane's view goes in the shell window — the arithmetic half of embedded panes.
 *
 * The client measures the hole it left for the page in **CSS pixels relative to its viewport**
 * (`daemon/src/webpane/HOST_PROTOCOL.md` §3.5) and the daemon forwards that rect untouched. A
 * `WebContentsView` added to a window's `contentView`, on the other hand, is positioned in
 * **DIP relative to the content area's top-left**. Two conversions bridge them, and both are
 * easy to get subtly wrong, so they live here with tests rather than inline in the wiring:
 *
 *   - **CSS px → DIP.** The renderer's `devicePixelRatio` is *display scale × page zoom*. The
 *     window's own `scaleFactor` is the display scale alone, so `dpr / scaleFactor` is the page
 *     zoom — exactly the factor between a CSS pixel and a DIP. On an unzoomed page (the normal
 *     case, on any display) that is 1 and the rect passes through unchanged; at ⌘+ it grows the
 *     view to match the chrome the client just drew bigger.
 *   - **Clamp to the content area.** The client's viewport IS the window's content area, so no
 *     origin offset is needed — but a pane can be scrolled or dragged partly out of view, and a
 *     view placed outside its window is either invisible or (on some platforms) drawn over
 *     another window. Clamping both edges keeps a partly-visible pane partly visible instead of
 *     misplacing it, and collapses a fully off-screen one to nothing, which the caller reads as
 *     "put it back in the holder".
 *
 * Nothing here touches Electron: it takes numbers and returns numbers, which is why the shell's
 * plain-Node vitest project can cover it.
 */

/** The daemon's notify verb (`host-notify`), spelled once on this side too. */
export const GEOMETRY_NOTIFY_VERB = 'pane-geometry';

/** A rect as the client reports it: CSS px, viewport-relative. */
export interface CssRect {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

/** A rect as Electron wants it: DIP, relative to the window's content area. */
export interface ViewBounds {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** The window the view would be placed in. */
export interface WindowMetrics {
    /** `BrowserWindow.getContentBounds()` size, in DIP. */
    readonly contentWidth: number;
    readonly contentHeight: number;
    /** The display's `scaleFactor` (1 on a normal screen, 2 on a Mac retina panel). */
    readonly scaleFactor: number;
}

/** One `pane-geometry` notification, already read off the wire. */
export interface PaneGeometry {
    readonly paneID: string;
    /** The pane's active tab; null when the daemon did not name one. */
    readonly tabID: string | null;
    readonly rect: CssRect;
    readonly visible: boolean;
    /**
     * Issue #12: `visible:false` because a menu (or any floating surface) is momentarily OVER the
     * pane, not because the pane has left the screen.
     *
     * The two need different answers, and the difference is the page's layout. Taking a view back
     * to the holder re-pins its viewport to `DEFAULT_VIEWPORT` @1× (§3.5), so the page reflows on
     * the way out and again on the way back, and the frames between the view returning and the
     * page repainting show the automation layout clipped into the pane. A transient park is over
     * in a second and the pane's rect has not changed, so the view is hidden where it stands.
     */
    readonly transient: boolean;
    readonly devicePixelRatio: number;
    /** The daemon's answer to "did this come from my own window?" (§3.5). */
    readonly ownWindow: boolean;
    readonly shellWindowID: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Parse the notify args. A malformed report degrades to "not visible", never to NaN bounds. */
export function parsePaneGeometry(args: Record<string, unknown>): PaneGeometry | null {
    const paneID = str(args['paneID']);
    if (paneID === null) return null;
    const rawRect = isRecord(args['rect']) ? args['rect'] : {};
    const rect: CssRect = {
        x: num(rawRect['x'], 0),
        y: num(rawRect['y'], 0),
        w: Math.max(0, num(rawRect['w'], 0)),
        h: Math.max(0, num(rawRect['h'], 0))
    };
    return {
        paneID,
        tabID: str(args['tabID']),
        rect,
        visible: args['visible'] === true && rect.w > 0 && rect.h > 0,
        transient: args['transient'] === true,
        devicePixelRatio: num(args['devicePixelRatio'], 1),
        ownWindow: args['ownWindow'] === true,
        shellWindowID: str(args['shellWindowID'])
    };
}

/**
 * The CSS→DIP factor. Guarded on both inputs: a zero/NaN scale factor or device pixel ratio
 * would otherwise produce a zero-sized (or NaN) view rather than a merely mis-scaled one.
 */
export function cssToDipScale(devicePixelRatio: number, scaleFactor: number): number {
    if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1;
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return 1;
    return devicePixelRatio / scaleFactor;
}

/**
 * The bounds to hand `WebContentsView.setBounds`, or `null` when the rect lands nowhere inside
 * the window (fully scrolled off, zero-sized, a window with no content area yet).
 */
export function viewBounds(geometry: PaneGeometry, metrics: WindowMetrics): ViewBounds | null {
    if (!geometry.visible) return null;
    const scale = cssToDipScale(geometry.devicePixelRatio, metrics.scaleFactor);
    const width = Math.max(0, Math.floor(metrics.contentWidth));
    const height = Math.max(0, Math.floor(metrics.contentHeight));
    if (width === 0 || height === 0) return null;

    // Clamp the two EDGES rather than the origin plus a size: a pane whose top is above the
    // viewport must lose that overhang, not slide down into it.
    const left = clamp(Math.round(geometry.rect.x * scale), 0, width);
    const top = clamp(Math.round(geometry.rect.y * scale), 0, height);
    const right = clamp(Math.round((geometry.rect.x + geometry.rect.w) * scale), 0, width);
    const bottom = clamp(Math.round((geometry.rect.y + geometry.rect.h) * scale), 0, height);
    if (right <= left || bottom <= top) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, low: number, high: number): number {
    if (!Number.isFinite(value)) return low;
    return Math.min(high, Math.max(low, value));
}

/** Bounds equality, so a re-report that changed nothing does not touch the view. */
export function sameBounds(a: ViewBounds | null, b: ViewBounds | null): boolean {
    if (a === null || b === null) return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
