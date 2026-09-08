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
 * rule, and it is still the rule. What changed with #123 is WHERE the other half is decided: this
 * machine now recognises the gesture in both modes and tells the caller which bytes it earned
 * (`reportWheel` / `reportClick`), instead of the caller handing every raw touch event to the
 * mouse reporter the moment an application asks. Nothing in this file writes a byte itself.
 *
 * ## What a gesture becomes when an application DOES report the mouse (#123)
 *
 * The owner, on a real Android phone, on the R2/R3 shell: *"when on a Claude Code tab and
 * scrolling down it can scroll into the lower part of the TUI and open the menus"*, clarified as
 * *"which opens up agents/monitors"* - Claude Code's task line, which lists background agents and
 * monitors when it is clicked.
 *
 * MEASURED, on the base, by `phone-touch-mouse-reporting` (a drag down 200 px ending on the
 * bottom row of a 50-row grid, over `?1049h ?1000h ?1002h ?1006h`):
 *
 *     ^[[<0;24;16M  ^[[<32;24;18M … ^[[<32;24;50M  ^[[<0;24;50m
 *     └ press        └ 12 motion reports            └ release, on the LAST ROW
 *
 * A press and a release IS a click, and on a phone a drag ends wherever the thumb ran out of
 * glass - the bottom rows, which is where that task line is drawn. Not one wheel report was in
 * the trail, so the "the TUI read our wheel as navigation" theory was wrong: the client had
 * simply been forwarding the touch to the mouse reporter as a button-0 press, drag and release.
 *
 * THE RULE, which is this file's half of the fix. Over an application that reports the mouse:
 *
 *   - a drag is WHEEL reports (SGR button 64 / 65) at the finger, one per line of travel, and
 *     never a press or a release. A drag is how a person reads, and reading is what a wheel is
 *     for; a phone has no other way to send one, because a one-finger drag produces no `wheel`
 *     event (see above);
 *   - the momentum tail reports only while it is moving, and nothing when it comes to rest;
 *   - a TAP - a press that never passed the slop - is the ONE gesture reported as a click,
 *     because an application that turned mouse reporting on asked to be told about clicks;
 *   - a LONG PRESS does not run C3's word selection and Copy pill here. The application asked for
 *     the press, and it gets it (as the same click); C3's selection is what a long press means
 *     only where nothing asked.
 *
 * WHICH MODE A GESTURE IS IN IS LATCHED AT ITS START, and held for the whole of it, momentum
 * included. An application that turns reporting off mid-flick must not have the tail it is
 * already receiving turn into a scrollback scroll under it, and the reverse is worse: a tail that
 * started as a viewport scroll must not start writing bytes to a PTY halfway through.
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
    /**
     * A contact that stayed inside the slop for {@link LONG_PRESS_MS}.
     *
     * Never called while {@link reportsMouse} says an application is reporting: there, the press
     * belongs to the application (#123).
     */
    onLongPress?(point: TouchPointLike): void;
    /**
     * Is an application reporting the mouse right now? Read ONCE, at the start of each gesture,
     * and held for the whole of it including its momentum tail - see the header.
     *
     * Absent (the desktop's fake, a host that has no reporter) reads as `false`, which is C3's
     * original behaviour to the byte.
     */
    reportsMouse?(): boolean;
    /**
     * One wheel report per line, at the finger. `lines` is in the ENGINE's sign, the same sign
     * {@link scrollLines} takes, so a caller can pass it straight through: negative is back
     * through history, which is SGR button 64 (wheel up).
     */
    reportWheel?(lines: number, point: TouchPointLike): void;
    /**
     * A press and a release at one point: the one gesture an application is told is a click.
     *
     * The point is the contact's ORIGIN rather than wherever it lifted. A tap is by definition a
     * contact that never passed {@link TOUCH_SLOP_PX}, so it is one point; reporting the press
     * and the release at the same cell is what makes it a click the application cannot read as a
     * one-cell drag.
     */
    reportClick?(point: TouchPointLike): void;
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
    /**
     * #123: is THIS gesture the application's? Latched in `start`, cleared in `abandon`, and read
     * by everything downstream - including the momentum tail, which outlives the contact.
     */
    let reporting = false;
    let originX = 0;
    let originY = 0;
    let lastX = 0;
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
        reporting = false;
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
     *
     * #123 put a second destination behind the same accumulator. When the gesture is the
     * application's, the whole lines become WHEEL REPORTS at the finger instead of a viewport
     * move - one per line, which is what makes a drag over a TUI scroll it by the same amount a
     * drag over a shell scrolls the scrollback. An application has no end for a fling to run
     * past, so that branch never answers `clamped`: the tail there ends on its own decay, which
     * is the only thing that can end it.
     */
    const consume = (): 'idle' | 'moved' | 'clamped' => {
        const cell = host.cellHeight();
        if (!Number.isFinite(cell) || cell <= 0) return 'idle';
        const lines = Math.trunc(residual / cell);
        if (lines === 0) return 'idle';
        residual -= lines * cell;
        // The sign flip, and the only place it happens: down the glass is back through history.
        if (reporting) {
            host.reportWheel?.(-lines, { clientX: lastX, clientY: lastY });
            return 'moved';
        }
        const before = host.scrollOffset();
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
            // #123: the tail is over, so the mode it was latched in is spent too. Nothing is sent
            // at rest - the last report a reporting application gets is the last one that MOVED.
            reporting = false;
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
            // #123: latched HERE, before anything else can read it, and held until `abandon`.
            reporting = host.reportsMouse?.() === true;
            if (point === null) {
                gesture = 'none';
                // A second finger is not a gesture, in either mode - but while an application is
                // reporting, the event is still CONSUMED, because reporting is on and the engine
                // must not turn the contact into a selection either way (the same rule
                // `mouse.ts`'s `down` follows for a press the mode declined to encode).
                //
                // The latch is dropped again before returning: this contact has no origin (the
                // fields still hold the LAST gesture's), and a `touchend` that arrived with no
                // move in between would otherwise report a click at a point nobody touched.
                const consumed = reporting;
                reporting = false;
                return consumed;
            }
            gesture = 'press';
            originX = point.clientX;
            originY = point.clientY;
            lastX = point.clientX;
            lastY = point.clientY;
            sample(now(), point.clientY);
            // No long press while the application is reporting: the press is the application's
            // (#123), and C3's word selection would be a second meaning for the same contact.
            if (host.onLongPress !== undefined && !reporting) {
                cancelPress = timer(() => {
                    cancelPress = null;
                    // Still a press, still under the slop: this is the gesture the platform would
                    // have called a long press, and the contact is still down.
                    if (gesture !== 'press') return;
                    pressed = true;
                    host.onLongPress?.({ clientX: originX, clientY: originY });
                }, LONG_PRESS_MS);
            }
            // NOT consumed, unless the application is reporting. A press that turns out to be a
            // tap belongs to the engine, whose own `touchend` focuses the hidden textarea - which
            // is how a phone raises its keyboard.
            //
            // While an application IS reporting, the contact is consumed from its first event, as
            // it was before #123: `preventDefault` on `touchstart` is what suppresses the
            // browser's compatibility mouse events, and those would otherwise reach the pane's own
            // capture-phase `mousedown`/`mouseup` handlers and be reported as the very press and
            // release this change exists to stop sending.
            return reporting;
        },
        move(event): boolean {
            const point = only(event.touches);
            if (point === null) {
                // A second finger arriving mid-drag ends the drag, without momentum - and with
                // nothing sent, which is the point: the application is told the wheel stopped
                // turning, never that a button came up somewhere.
                const wasReporting = reporting;
                abandon();
                return wasReporting;
            }
            if (gesture !== 'press' && gesture !== 'scroll') return false;
            const time = now();
            if (gesture === 'press') {
                const dx = point.clientX - originX;
                const dy = point.clientY - originY;
                // Total distance, not the vertical alone: a diagonal drag past the slop is a drag,
                // and only its vertical component then means anything to a terminal.
                if (Math.hypot(dx, dy) <= TOUCH_SLOP_PX) {
                    lastX = point.clientX;
                    lastY = point.clientY;
                    sample(time, point.clientY);
                    // Inside the slop this is still a press, and still nobody's news - but while
                    // an application is reporting, the contact is already consumed (see `start`).
                    return reporting;
                }
                gesture = 'scroll';
                clearPressTimer();
                pressed = false;
            }
            residual += point.clientY - lastY;
            lastX = point.clientX;
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
            // A contact this machine actually recognised. `gesture` is `none` for an end with no
            // start of its own (a multi-touch that was refused, an event after a `cancel`), and
            // such an end has no origin to report a click at.
            const wasPress = gesture === 'press';
            const wasPressed = pressed;
            if (!wasScrolling) {
                gesture = 'none';
                pressed = false;
                if (reporting && wasPress) {
                    // #123: THE ONE GESTURE AN APPLICATION IS TOLD IS A CLICK. A contact that
                    // never passed the slop is a tap (or a long press, which over a reporting
                    // application is the same thing held longer), and an application that turned
                    // mouse reporting on asked to be told about clicks. A drag - the other branch
                    // - is told nothing here, which is the whole fix.
                    reporting = false;
                    host.reportClick?.({ clientX: originX, clientY: originY });
                    return true;
                }
                // A plain tap is the ENGINE's (it focuses the textarea, which raises the
                // keyboard); a long press is ours, because the word it selected must not be
                // cleared by the tap that made it.
                return wasPressed;
            }
            const last = only(event.changedTouches);
            const time = now();
            if (last !== null) {
                sample(time, last.clientY);
                // The tail reports at the finger's LAST position (the finger is gone, so there is
                // no other), which is the release point rather than the last `touchmove`.
                lastX = last.clientX;
                lastY = last.clientY;
            }
            velocity = measureVelocity(time);
            pressed = false;
            if (velocity === 0) {
                gesture = 'none';
                reporting = false;
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
