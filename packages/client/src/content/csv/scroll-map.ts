/**
 * The csv grid's vertical scroll mapping (#324, plan §5) - pure, no DOM.
 *
 * The grid scrolls NATIVELY on both axes: a real scroller, a real spacer, the platform's own
 * wheel, trackpad, scrollbar and iOS momentum. That is free until the spacer has to be taller
 * than a browser will lay out (Chromium and WebKit cap an element's height somewhere between 16
 * and 33 million px; a 20-million-row file at 24 px a row is 480 million). So past
 * `SCROLL_MAP_MAX_PX` the spacer is capped and the scroll position is MAPPED:
 *
 *   - `physical` is the scroller's `scrollTop`, in [0, spacer - viewport];
 *   - `virtual` is where the content really is, in [0, content - viewport];
 *   - rows are drawn at `rowTop - (virtual - physical)`, so between two remaps they move with
 *     the native scroll and the compositor keeps them smooth.
 *
 * The rule that makes it feel native: a scroll delta under `SCROLL_MAP_JUMP_VIEWPORTS`
 * viewports moves `virtual` by EXACTLY the same amount (a wheel notch is a wheel notch, a fling
 * is a fling), while a bigger jump - a scrollbar drag, a page-sized programmatic move - goes
 * through the proportional `base` mapping, so the scrollbar still reaches the whole file. The
 * 1:1 steps make `virtual` drift away from `base(physical)`; that is fixed by RE-CENTRING the
 * physical position under the virtual one, and only when scrolling has gone idle, because
 * writing `scrollTop` mid-gesture kills iOS momentum. The first and last `SCROLL_MAP_EDGE_PX`
 * map 1:1 so the two ends of the file are exact and a re-centre near an end is a no-op; hitting
 * the physical top or bottom snaps `virtual` to the matching end.
 *
 * Every programmatic scroll (selection, find, Go to row, the phone scrubber) goes through
 * `scrollToVirtual`, which hands back the `scrollTop` to write, so the map and the element
 * cannot disagree.
 */

/** Above this many px of content the spacer is capped and the position is mapped. */
export const SCROLL_MAP_MAX_PX = 8_000_000;
/** The 1:1 zone at each end of a mapped range. */
export const SCROLL_MAP_EDGE_PX = 1_000_000;
/** Deltas larger than this many viewports are jumps (proportional), not scrolls (1:1). */
export const SCROLL_MAP_JUMP_VIEWPORTS = 4;
/** No scroll event for this long = idle, and the physical position may be re-centred. */
export const SCROLL_MAP_IDLE_MS = 150;

export interface ScrollMapSnapshot {
    readonly contentPx: number;
    readonly viewportPx: number;
    /** The spacer height to lay out: the content, capped at `SCROLL_MAP_MAX_PX`. */
    readonly spacerPx: number;
    readonly mapped: boolean;
    readonly physical: number;
    readonly virtual: number;
    /** `virtual - physical`: subtract it from a row's content position to place it. */
    readonly offset: number;
}

export interface ScrollMap {
    /** New content or viewport size. Keeps `virtual` (clamped) so a growing file does not jump. */
    configure(contentPx: number, viewportPx: number): void;
    /** A native scroll landed at `physical`; returns the new `virtual`. */
    onScroll(physical: number): number;
    /** The `scrollTop` to write to re-centre after scrolling went idle, or null for none. */
    recentre(): number | null;
    /** Move the content to `virtual`; returns the `scrollTop` to write. */
    scrollToVirtual(virtual: number): number;
    /** The proportional mapping (physical → virtual), exposed for the scrubber and tests. */
    toVirtual(physical: number): number;
    toPhysical(virtual: number): number;
    snapshot(): ScrollMapSnapshot;
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

export function createScrollMap(contentPx = 0, viewportPx = 0): ScrollMap {
    let content = Math.max(0, contentPx);
    let viewport = Math.max(0, viewportPx);
    let physical = 0;
    let virtual = 0;

    const mapped = (): boolean => content > SCROLL_MAP_MAX_PX;
    const spacer = (): number => Math.min(content, SCROLL_MAP_MAX_PX);
    const vmax = (): number => Math.max(0, content - viewport);
    const pmax = (): number => Math.max(0, spacer() - viewport);
    const edge = (): number => Math.min(SCROLL_MAP_EDGE_PX, pmax() / 4);

    const toVirtual = (p: number): number => {
        if (!mapped()) return clamp(p, 0, vmax());
        const P = pmax();
        const V = vmax();
        const E = edge();
        const at = clamp(p, 0, P);
        if (at <= E) return at;
        if (at >= P - E) return V - (P - at);
        return E + ((at - E) * (V - 2 * E)) / (P - 2 * E);
    };

    const toPhysical = (v: number): number => {
        if (!mapped()) return clamp(v, 0, pmax());
        const P = pmax();
        const V = vmax();
        const E = edge();
        const at = clamp(v, 0, V);
        if (at <= E) return at;
        if (at >= V - E) return P - (V - at);
        return E + ((at - E) * (P - 2 * E)) / (V - 2 * E);
    };

    const map: ScrollMap = {
        configure(nextContent, nextViewport) {
            content = Math.max(0, nextContent);
            viewport = Math.max(0, nextViewport);
            virtual = clamp(virtual, 0, vmax());
            physical = mapped() ? clamp(physical, 0, pmax()) : virtual;
        },

        onScroll(next) {
            const p = clamp(next, 0, pmax());
            if (!mapped()) {
                physical = p;
                virtual = p;
                return virtual;
            }
            const delta = p - physical;
            if (Math.abs(delta) > SCROLL_MAP_JUMP_VIEWPORTS * Math.max(viewport, 1)) virtual = toVirtual(p);
            else virtual = clamp(virtual + delta, 0, vmax());
            // The physical ends are the file's ends, whatever drift the 1:1 steps accumulated.
            if (p <= 0) virtual = 0;
            else if (p >= pmax()) virtual = vmax();
            physical = p;
            return virtual;
        },

        recentre() {
            if (!mapped()) return null;
            const target = Math.round(toPhysical(virtual));
            if (Math.abs(target - physical) < 1) return null;
            physical = target;
            return target;
        },

        scrollToVirtual(next) {
            const v = clamp(next, 0, vmax());
            if (!mapped()) {
                virtual = v;
                physical = v;
                return physical;
            }
            const delta = v - virtual;
            let p: number;
            if (Math.abs(delta) <= SCROLL_MAP_JUMP_VIEWPORTS * Math.max(viewport, 1)) {
                // A small move keeps the current offset, so the scrollbar thumb does not twitch.
                p = physical + delta;
                if (p < 0 || p > pmax() || (p <= 0 && v > 0) || (p >= pmax() && v < vmax())) p = toPhysical(v);
            } else {
                p = toPhysical(v);
            }
            virtual = v;
            physical = Math.round(clamp(p, 0, pmax()));
            return physical;
        },

        toVirtual,
        toPhysical,

        snapshot() {
            return {
                contentPx: content,
                viewportPx: viewport,
                spacerPx: spacer(),
                mapped: mapped(),
                physical,
                virtual,
                offset: virtual - physical
            };
        }
    };
    return map;
}

/**
 * The rows a viewport at `virtual` shows, padded by `overscan` on each side, as a half-open
 * range of body indices.
 */
export function visibleRows(
    virtual: number,
    viewportPx: number,
    rowPx: number,
    count: number,
    overscan: number
): { readonly start: number; readonly end: number } {
    if (count <= 0 || rowPx <= 0) return { start: 0, end: 0 };
    const first = Math.floor(virtual / rowPx);
    const last = Math.ceil((virtual + Math.max(viewportPx, 0)) / rowPx);
    return { start: clamp(first - overscan, 0, count), end: clamp(last + overscan, 0, count) };
}
