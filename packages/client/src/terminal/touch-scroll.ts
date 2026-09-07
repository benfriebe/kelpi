/**
 * C3 - a finger on the terminal (docs/MOBILE-PLAN.md §4, and §7's spike of 2026-09-03).
 *
 * **Every phone rule in this program is an owner-directed divergence from the shipped Swift app**
 * - there is no Swift phone UI, so a touch gesture has no parity reference. `chrome/form-factor.ts`
 * says that once for the whole program; this file is the terminal's gesture half of it.
 *
 * ## Why a gesture machine exists at all
 *
 * The device round of 2026-09-07 is the whole brief: "you can't scrollback history by trying to
 * mobile scroll". Nothing in the client listened for a touch on a pane, and nothing in the engine
 * scrolls for one either. The spike measured why the obvious answers do not apply:
 *
 *   - **There is no scroll container to fling.** `ghostty-web`'s `open()` appends a bare canvas
 *     and paints its own 8 px scrollbar into it; the browser has nothing to scroll, so the
 *     platform's own momentum (and `overflow: auto`, and `scroll-behavior`) are not available
 *     without forking the engine.
 *   - **A one-finger drag produces no `wheel` event**, so the engine's own wheel handler - the
 *     thing that scrolls a desktop pane - is never reached by a thumb.
 *
 * So the pixels are turned into lines here and handed to `TerminalRenderer.scrollLines`, and the
 * flick's tail is an inertial scroller of about twenty frames rather than the compositor's.
 *
 * ## What a touch may NOT do
 *
 * **A touch never reaches the PTY unless an application asked for the mouse.** That is the spike's
 * rule and it is enforced by the caller (`TerminalPane`), which runs this machine only while
 * `data-terminal-mouse` is `none` and hands the touch to the mouse reporter otherwise. Nothing in
 * this file writes a byte anywhere; the only thing it can do is move a viewport.
 *
 * ## The numbers, and where they come from
 *
 * Everything below is a constant with a reason, because a gesture threshold with no reason is a
 * number somebody will change back.
 */

/** One contact, in client coordinates. Structural, so a real `Touch` satisfies it. */
export interface TouchPointLike {
    readonly clientX: number;
    readonly clientY: number;
}

/**
 * The parts of a `TouchEvent` this machine reads.
 *
 * `touches` is every contact still on the glass (empty on the last `touchend`) and
 * `changedTouches` is the ones this event is about - which is why the end of a gesture has to
 * read the second list. Both are `ArrayLike` rather than `TouchList` so a test needs no DOM.
 */
export interface TouchEventLike {
    readonly touches: ArrayLike<TouchPointLike>;
    readonly changedTouches: ArrayLike<TouchPointLike>;
}

/**
 * Chromium's own touch slop, and Android's: `ViewConfiguration`'s 8 dp, which is what the
 * platform's gesture recognizer uses to tell a tap from a drag. Below it a contact that wobbles
 * is still a press, which is what makes a long press possible on a hand that is not perfectly
 * still.
 */
export const TOUCH_SLOP_PX = 8;

/**
 * Chromium's long-press threshold (`kLongPressTimeout`, 500 ms), so the gesture fires at the
 * moment the platform would have fired its own. The audit's `session.longPress` holds for 600 ms
 * for the same reason.
 */
export const LONG_PRESS_MS = 500;

/**
 * How far back a velocity is measured. 100 ms is about six frames: long enough that one stray
 * sample cannot define the flick, short enough that a drag which STOPPED before the finger lifted
 * has a velocity of nearly zero, which is how a person cancels their own momentum.
 */
export const VELOCITY_WINDOW_MS = 100;

/**
 * The velocity below which the tail is over, in CSS px per ms. 0.05 px/ms is 3 px per frame at
 * 60 Hz - under a fifth of a cell, so the last frame this allows cannot move a row.
 */
export const MOMENTUM_MIN_VELOCITY = 0.05;

/**
 * The ceiling, in CSS px per ms. 6 px/ms is 360 px per frame; a real flick measures well under
 * that, so this is the guard against a synthetic event (or a wildly sampled one) turning into
 * hundreds of lines in a single frame - the same defence `mouse.ts`'s
 * `MAX_WHEEL_REPORTS_PER_EVENT` is.
 */
export const MOMENTUM_MAX_VELOCITY = 6;

/**
 * The tail's e-folding time in ms: velocity is multiplied by `exp(-dt / 325)` every frame, so a
 * flick has lost 95 % of its speed after about a second and is under
 * {@link MOMENTUM_MIN_VELOCITY} well before that. 325 ms is the deceleration a scroll view on
 * either platform reads like; anything shorter feels like the finger hit glue.
 */
export const MOMENTUM_DECAY_MS = 325;

/** A frame loop. Returns a cancel; the default is `requestAnimationFrame`. */
export type FrameScheduler = (frame: (now: number) => void) => () => void;

/** A one-shot timer. Returns a cancel; the default is `setTimeout`. */
export type TimerScheduler = (callback: () => void, ms: number) => () => void;

export interface TouchScrollHost {
    /**
     * Scroll by whole lines, in the ENGINE's sign (positive = toward the bottom). The machine
     * flips the gesture's own sign before it calls this: a finger moving DOWN reveals OLDER
     * lines, which is content following the finger.
     */
    scrollLines(delta: number): void;
    /** How far the viewport sits above the live bottom; the machine reads it to know it stalled. */
    scrollOffset(): number;
    /** The cell's height in CSS px - the pixels-to-lines divisor. Zero suspends the gesture. */
    cellHeight(): number;
    /** A contact that stayed inside the slop for {@link LONG_PRESS_MS}. */
    onLongPress?(point: TouchPointLike): void;
}

export interface TouchScrollOptions {
    readonly now?: (() => number) | undefined;
    readonly frame?: FrameScheduler | undefined;
    readonly timer?: TimerScheduler | undefined;
}

/**
 * What the gesture is, right now. Reported so the caller can decide whether the event it just
 * handed over belongs to the ENGINE as well (a plain tap does: it is how the engine's own
 * `touchend` raises the software keyboard).
 */
export type TouchGesture = 'none' | 'press' | 'scroll' | 'momentum';

export interface TouchScroll {
    /** What the machine is doing. */
    readonly gesture: TouchGesture;
    /** True once this gesture has fired its long press. */
    readonly pressed: boolean;
    /** Each returns whether the machine CONSUMED the event (the engine must not also see it). */
    start(event: TouchEventLike): boolean;
    move(event: TouchEventLike): boolean;
    end(event: TouchEventLike): boolean;
    /** Drop the gesture and any momentum: a `touchcancel`, a mode change, an unmount. */
    cancel(): void;
}

const defaultFrame: FrameScheduler = (frame) => {
    if (typeof requestAnimationFrame !== 'function') {
        const handle = setTimeout(() => frame(Date.now()), 16);
        return () => clearTimeout(handle);
    }
    const handle = requestAnimationFrame((time) => frame(time));
    return () => cancelAnimationFrame(handle);
};

const defaultTimer: TimerScheduler = (callback, ms) => {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
};

function only(points: ArrayLike<TouchPointLike>): TouchPointLike | null {
    return points.length === 1 ? (points[0] ?? null) : null;
}

/**
 * The gesture machine: one per pane, driven by the pane's own touch listeners.
 *
 * It is deliberately a plain object rather than a hook or a component: the events it reads are
 * attached in the capture phase with `passive: false` (React cannot express either), and every
 * decision it makes is arithmetic that a test can drive with numbers instead of a browser.
 */
export function createTouchScroll(host: TouchScrollHost, options: TouchScrollOptions = {}): TouchScroll {
    const now = options.now ?? (() => Date.now());
    const frame = options.frame ?? defaultFrame;
    const timer = options.timer ?? defaultTimer;

    let gesture: TouchGesture = 'none';
    let pressed = false;
    let originX = 0;
    let originY = 0;
    let lastY = 0;
    /** Pixels dragged but not yet worth a whole line. Fractional on purpose: see `consume`. */
    let residual = 0;
    /** `{ t, y }` samples inside the velocity window, oldest first. */
    let samples: { t: number; y: number }[] = [];
    let cancelPress: (() => void) | null = null;
    let cancelFrame: (() => void) | null = null;
    let velocity = 0;
    let lastFrameAt = 0;

    const clearPressTimer = (): void => {
        cancelPress?.();
        cancelPress = null;
    };

    const stopMomentum = (): void => {
        cancelFrame?.();
        cancelFrame = null;
        velocity = 0;
    };

    const abandon = (): void => {
        clearPressTimer();
        stopMomentum();
        gesture = 'none';
        pressed = false;
        residual = 0;
        samples = [];
    };

    /**
     * Spend the accumulated pixels as whole lines.
     *
     * The remainder is KEPT, which is the whole reason this is an accumulator: at a 17 px cell a
     * 12 px move is no lines, and a machine that dropped the remainder would turn a slow drag into
     * no scroll at all rather than into one line every second move.
     *
     * The three answers are what the tail reads: `idle` is "not a whole line yet", `moved` is a
     * viewport that went somewhere, and `clamped` is a viewport that was ASKED to and could not -
     * the end of the scrollback, which is where a fling has to stop.
     */
    const consume = (): 'idle' | 'moved' | 'clamped' => {
        const cell = host.cellHeight();
        if (!Number.isFinite(cell) || cell <= 0) return 'idle';
        const lines = Math.trunc(residual / cell);
        if (lines === 0) return 'idle';
        residual -= lines * cell;
        const before = host.scrollOffset();
        // The sign flip, and the only place it happens: down the glass is back through history.
        host.scrollLines(-lines);
        return host.scrollOffset() === before ? 'clamped' : 'moved';
    };

    const sample = (time: number, y: number): void => {
        samples.push({ t: time, y });
        const floor = time - VELOCITY_WINDOW_MS;
        while (samples.length > 2 && (samples[0]?.t ?? 0) < floor) samples.shift();
    };

    /** px/ms across the sample window, clamped; `0` when the finger had already stopped. */
    const measureVelocity = (time: number): number => {
        const first = samples[0];
        const last = samples[samples.length - 1];
        if (first === undefined || last === undefined) return 0;
        // The gap to the RELEASE is part of the measurement: a finger that rested for 200 ms
        // before lifting has stopped, whatever it was doing before that.
        const span = Math.max(1, time - first.t);
        const raw = (last.y - first.y) / span;
        if (!Number.isFinite(raw)) return 0;
        const capped = Math.max(-MOMENTUM_MAX_VELOCITY, Math.min(MOMENTUM_MAX_VELOCITY, raw));
        return Math.abs(capped) < MOMENTUM_MIN_VELOCITY ? 0 : capped;
    };

    const step = (time: number): void => {
        // Clamped to 64 ms: a tab that was backgrounded mid-fling comes back with one enormous
        // `dt`, and a tail must not teleport through a thousand lines because a frame was late.
        const dt = Math.max(1, Math.min(64, time - lastFrameAt));
        lastFrameAt = time;
        residual += velocity * dt;
        const spent = consume();
        // Exponential decay rather than a per-frame constant: the frame budget is not fixed (a
        // busy pane drops to 30 Hz), and a decay measured in TIME slows by the same amount per
        // second either way.
        velocity *= Math.exp(-dt / MOMENTUM_DECAY_MS);
        // Stop at the end of the scrollback rather than spending a second of frames asking an
        // engine that has already clamped.
        if (Math.abs(velocity) < MOMENTUM_MIN_VELOCITY || spent === 'clamped') {
            gesture = 'none';
            stopMomentum();
            return;
        }
        cancelFrame = frame(step);
    };

    return {
        get gesture(): TouchGesture {
            return gesture;
        },
        get pressed(): boolean {
            return pressed;
        },
        start(event): boolean {
            // A second finger is not a gesture this terminal has: pinch does nothing (the font
            // size is a setting), and a two-finger drag is not a scroll either. Whatever was in
            // flight stops, and nothing takes its place.
            const point = only(event.touches);
            stopMomentum();
            clearPressTimer();
            residual = 0;
            samples = [];
            pressed = false;
            if (point === null) {
                gesture = 'none';
                return false;
            }
            gesture = 'press';
            originX = point.clientX;
            originY = point.clientY;
            lastY = point.clientY;
            sample(now(), point.clientY);
            if (host.onLongPress !== undefined) {
                cancelPress = timer(() => {
                    cancelPress = null;
                    // Still a press, still under the slop: this is the gesture the platform would
                    // have called a long press, and the contact is still down.
                    if (gesture !== 'press') return;
                    pressed = true;
                    host.onLongPress?.({ clientX: originX, clientY: originY });
                }, LONG_PRESS_MS);
            }
            // NOT consumed. A press that turns out to be a tap belongs to the engine, whose own
            // `touchend` focuses the hidden textarea - which is how a phone raises its keyboard.
            return false;
        },
        move(event): boolean {
            const point = only(event.touches);
            if (point === null) {
                // A second finger arriving mid-drag ends the drag, without momentum.
                abandon();
                return false;
            }
            if (gesture !== 'press' && gesture !== 'scroll') return false;
            const time = now();
            if (gesture === 'press') {
                const dx = point.clientX - originX;
                const dy = point.clientY - originY;
                // Total distance, not the vertical alone: a diagonal drag past the slop is a drag,
                // and only its vertical component then means anything to a terminal.
                if (Math.hypot(dx, dy) <= TOUCH_SLOP_PX) {
                    lastY = point.clientY;
                    sample(time, point.clientY);
                    return false;
                }
                gesture = 'scroll';
                clearPressTimer();
                pressed = false;
            }
            residual += point.clientY - lastY;
            lastY = point.clientY;
            sample(time, point.clientY);
            consume();
            // Consumed: the page must not also pan (`touch-action: none` says so in CSS, and this
            // is the half that stops the engine's canvas listeners seeing the same drag).
            return true;
        },
        end(event): boolean {
            clearPressTimer();
            const wasScrolling = gesture === 'scroll';
            const wasPressed = pressed;
            if (!wasScrolling) {
                gesture = 'none';
                pressed = false;
                // A plain tap is the ENGINE's (it focuses the textarea, which raises the
                // keyboard); a long press is ours, because the word it selected must not be
                // cleared by the tap that made it.
                return wasPressed;
            }
            const last = only(event.changedTouches);
            const time = now();
            if (last !== null) sample(time, last.clientY);
            velocity = measureVelocity(time);
            pressed = false;
            if (velocity === 0) {
                gesture = 'none';
                stopMomentum();
                return true;
            }
            gesture = 'momentum';
            lastFrameAt = time;
            cancelFrame = frame(step);
            return true;
        },
        cancel(): void {
            abandon();
        }
    };
}

// ── what the pane publishes (the audit's read) ──────────────────────────────────────

/**
 * How far this pane's viewport sits above the live bottom, in lines. `0` is "at the bottom".
 *
 * Published for the same reason `data-terminal-mouse` and `data-terminal-selection` are: a
 * screenshot cannot tell a scrolled-back canvas from a live one, and `kelpi pane capture` reads
 * the DAEMON's buffer, which does not move when a client scrolls. So "the drag reached the
 * scrollback" has to be an observable fact about the pane.
 *
 * PHONE ONLY. A desktop pane never writes it, so a desktop terminal's DOM is byte-identical to
 * what it has always been (MOBILE-PLAN.md §3, principle 1).
 */
export const TERMINAL_SCROLL_ATTRIBUTE = 'data-terminal-scroll';

export function publishTouchScrollOffset(root: HTMLElement | null, offset: number): void {
    if (root === null) return;
    root.setAttribute(TERMINAL_SCROLL_ATTRIBUTE, String(Math.max(0, Math.round(offset))));
}

/** Take it away again: a pane that stops being a phone carries no phone state at all. */
export function clearTouchScrollOffset(root: HTMLElement | null): void {
    root?.removeAttribute(TERMINAL_SCROLL_ATTRIBUTE);
}
