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
    /**
     * §N34: re-measure the destination instead of trusting the one taken at the start.
     *
     * A `scrollTop` is a number, but "reveal this row" is a promise about a row — and between
     * the frame the caller measured and the frame the animation lands on, the row can move.
     * The reveal's own caller is the proof: `runCreateGroup` queues the scroll target and the
     * inline rename as two separate updates, so the header is measured at 36 px and mounts its
     * rename field a commit later at 38 — and every later relayout (a row entering above it, a
     * label chip wrapping) moves it again. Called on every frame while the animation runs and
     * through `settleMs` afterwards; return `null` to keep the current target.
     */
    readonly retarget?: (() => number | null) | undefined;
    /**
     * §N34: how long after landing the animation keeps honouring `retarget`.
     *
     * The window is bounded and short — long enough for the commits that follow a reveal to
     * settle, far too short to fight a person who has started scrolling (and the caller stops
     * the whole reveal on the first user gesture anyway). `0`, the default, is the historical
     * behaviour: land once and stop looking.
     */
    readonly settleMs?: number | undefined;
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
 *
 * §N34: `to` is the destination as measured when the caller asked, and `options.retarget` is
 * how it stays honest — see the option's own note. Without it this behaves exactly as it did.
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
    const settleMs = Math.max(0, options.settleMs ?? 0);
    /** The live destination: the last thing `retarget` said, or the caller's number. */
    let target = to;
    const aim = (): number => {
        const next = options.retarget?.();
        if (typeof next === 'number' && Number.isFinite(next)) target = next;
        return target;
    };
    const from = element.scrollTop;
    if (options.durationMs <= 0 || raf === undefined || (from === to && settleMs === 0)) {
        element.scrollTop = aim();
        return () => {};
    }
    const started = now();
    let cancelled = false;
    let landed = false;
    /**
     * The settle window: after the animation has landed, the destination is still re-measured
     * every frame and re-applied the moment it moves. A correction here is a handful of pixels
     * against a layout that has just changed under the row, so it is applied outright rather
     * than animated — an eased 2 px is not a motion anyone can read.
     */
    const watch = (): void => {
        if (cancelled) return;
        if (now() - started > options.durationMs + settleMs) return;
        const want = aim();
        // A scroller clamps an offset its content cannot reach, so this can be a write that
        // does not move: idempotent, raises no `scroll`, and the next frame asks again — which
        // is what has to happen, because the content growing is exactly how such a target
        // becomes reachable.
        if (Math.abs(element.scrollTop - want) > 0.5) element.scrollTop = want;
        raf(watch);
    };
    const land = (): void => {
        if (cancelled || landed) return;
        landed = true;
        element.scrollTop = aim();
        if (settleMs > 0) raf(watch);
    };
    const step = (): void => {
        if (cancelled || landed) return;
        const progress = (now() - started) / options.durationMs;
        if (progress >= 1) {
            land();
            return;
        }
        element.scrollTop = from + (aim() - from) * easeOut(progress);
        raf(step);
    };
    if (from === to && settleMs > 0) land();
    else raf(step);
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
