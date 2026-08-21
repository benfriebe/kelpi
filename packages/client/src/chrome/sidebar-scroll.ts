/**
 * §WS-102's reveal arithmetic, kept out of the component so it can be checked without a DOM.
 *
 * The Swift's `scrollEntryIntoView` does four things, and only one of them (`block: 'nearest'`)
 * is free in a browser:
 *
 *   1. it **waits** until the newly inserted row has actually measured — that half lives in
 *      `Sidebar.tsx`, because only the component knows whether a row has laid out yet;
 *   2. it scrolls the **minimum** amount that makes the entry fully visible;
 *   3. it honours the insets at the top and bottom of the scroll view;
 *   4. it **animates** over 0.22s, and no-ops when the entry is already visible.
 *
 * `scrollIntoView({ block: 'nearest' })` gives 2 and the no-op, but owns 4 (its `behavior:
 * 'smooth'` has no duration a caller can name and no way to be observed mid-flight) and knows
 * nothing about 3. So the reveal computes its own target `scrollTop` here and animates to it.
 *
 * On the insets: the shipped app overlays its selection header and footer ON the list, so the
 * inset is what keeps a revealed row out from under them. In this port both are siblings of the
 * scroller — they take their own height out of the flex column and never cover a row — so the
 * only inset that is not structurally zero is the list's own content padding, which the caller
 * passes as `topInset`.
 */

/** Everything the reveal needs to know about the scroller and the row it is revealing. */
export interface RevealGeometry {
    /** The scroller's current `scrollTop`. */
    readonly scrollTop: number;
    /** The scroller's visible height (`clientHeight`). */
    readonly viewportHeight: number;
    /** The row's top in the scroller's CONTENT space (`offsetTop`), not its client rect. */
    readonly rowTop: number;
    readonly rowHeight: number;
    /** Content padding at the top of the list; a revealed row is never flush against it. */
    readonly topInset?: number | undefined;
    /** Reserved for a footer that overlays the list. Zero in this port — see the header. */
    readonly bottomInset?: number | undefined;
}

/**
 * The `scrollTop` that makes the row fully visible with the least movement, or `null` when it
 * already is — the "no-op when already visible" half of the item, expressed as an absence.
 *
 * A row TALLER than the viewport can never be fully visible; it aligns to the top, which is the
 * same choice `block: 'nearest'` makes and the only one that shows the row's name.
 */
export function revealScrollTop(geometry: RevealGeometry): number | null {
    const topInset = geometry.topInset ?? 0;
    const bottomInset = geometry.bottomInset ?? 0;
    const viewportTop = geometry.scrollTop + topInset;
    const viewportBottom = geometry.scrollTop + geometry.viewportHeight - bottomInset;
    const rowBottom = geometry.rowTop + geometry.rowHeight;
    if (viewportBottom <= viewportTop) return null;
    if (geometry.rowTop >= viewportTop && rowBottom <= viewportBottom) return null;
    if (geometry.rowTop < viewportTop || rowBottom - geometry.rowTop > viewportBottom - viewportTop) {
        return Math.max(0, geometry.rowTop - topInset);
    }
    return Math.max(0, rowBottom + bottomInset - geometry.viewportHeight);
}

/** The scroller, reduced to the two members the animation touches (so a test can supply them). */
export interface ScrollTarget {
    scrollTop: number;
}

export interface ScrollAnimationOptions {
    readonly durationMs: number;
    /** Injectable for tests; defaults to `performance.now()` / `Date.now()`. */
    readonly now?: (() => number) | undefined;
    /** Injectable for tests; defaults to `requestAnimationFrame`. */
    readonly raf?: ((callback: (time: number) => void) => unknown) | undefined;
    /**
     * Injectable for tests; defaults to `setTimeout`. Backs the settle guard below — pass
     * `null` to run the animation on frames alone.
     */
    readonly timer?: ((callback: () => void, ms: number) => unknown) | null | undefined;
}

/**
 * The spring's decelerating half, which is what a 0.22s reveal reads as. A full overshoot is
 * wrong here: a scroll that goes past its target and comes back looks like a mis-scroll.
 */
function easeOut(progress: number): number {
    const clamped = Math.min(1, Math.max(0, progress));
    return 1 - (1 - clamped) ** 3;
}

/**
 * Animate `element.scrollTop` to `to` over `durationMs`, and return a cancel function.
 *
 * Degradations, both deliberate: a non-positive duration, or an environment with no animation
 * frames at all (jsdom), assigns the target immediately — the reveal still happens, it simply
 * does not animate, which is exactly what "no layout, nothing to animate" should mean.
 */
export function animateScrollTop(
    element: ScrollTarget,
    to: number,
    options: ScrollAnimationOptions
): () => void {
    const raf = options.raf ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined);
    const now =
        options.now ??
        (typeof performance === 'object' && typeof performance.now === 'function'
            ? () => performance.now()
            : () => Date.now());
    const from = element.scrollTop;
    if (options.durationMs <= 0 || raf === undefined || from === to) {
        element.scrollTop = to;
        return () => {};
    }
    const started = now();
    let cancelled = false;
    let landed = false;
    const land = (): void => {
        if (cancelled || landed) return;
        landed = true;
        element.scrollTop = to;
    };
    const step = (): void => {
        if (cancelled || landed) return;
        const progress = (now() - started) / options.durationMs;
        if (progress >= 1) {
            land();
            return;
        }
        element.scrollTop = from + (to - from) * easeOut(progress);
        raf(step);
    };
    raf(step);
    /**
     * The settle guard: frame delivery is not a guarantee. A renderer can stop issuing
     * animation frames for reasons the page cannot see — occlusion, a throttled compositor, a
     * tab moved to the background mid-reveal — and an interrupted `scrollTop` animation would
     * leave the row short of the "minimum scroll" the reveal was asked for, silently. So the
     * last position is also pinned by a timer just past the duration. Landing is idempotent, so
     * whichever gets there first wins and the other is a no-op.
     */
    const timer = options.timer === undefined ? setTimeout : options.timer;
    if (typeof timer === 'function') timer(land, options.durationMs + 40);
    return () => {
        cancelled = true;
    };
}
