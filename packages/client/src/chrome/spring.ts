/**
 * A real, interruptible spring — the thing a CSS transition cannot be.
 *
 * ## Why this file exists
 *
 * The sidebar's motion was ported as `cubic-bezier(0.22, 1.2, 0.36, 1)` over 350 ms, chosen to
 * *look* like SwiftUI's `.spring(response: 0.35, dampingFraction: 0.8)` in a still. It does, and
 * it is still wrong, because the two differ in the only situation the sidebar's drag is ever in:
 * **mid-flight**.
 *
 * A CSS transition restarted before it finished begins again from the current position with
 * **zero velocity** and a **fixed duration**. Drag a row down across three neighbours in 200 ms
 * and each neighbour's displacement is three separate 350 ms eases, each one stopping dead and
 * restarting. That full-stop-per-frame is the deadness this module removes.
 *
 * A spring is a differential equation with state. Retargeting it changes only where it is
 * heading; the position AND the velocity it already had carry straight through, so three
 * retargets in 200 ms produce ONE continuous motion. That is what SwiftUI does, and it is the
 * property the discriminator test in `spring.test.ts` checks: after a retarget, no frame jumps.
 *
 * ## The derivation, from SwiftUI's two parameters
 *
 * SwiftUI's `.spring(response:dampingFraction:)` names a unit-mass damped harmonic oscillator:
 *
 *   - `response` is the **period of the undamped oscillation**, so the natural frequency is
 *
 *         ω = 2π / response
 *
 *     and for the sidebar's `response: 0.35` that is `ω = 2π / 0.35 ≈ 17.9520 rad/s`.
 *
 *   - With unit mass, the spring constant is
 *
 *         k = ω²  ≈  322.27  (px/s² per px)
 *
 *   - `dampingFraction` is the damping ratio ζ, and the damping coefficient of a unit mass is
 *
 *         c = 2 · ζ · ω  ≈  2 · 0.8 · 17.9520  ≈  28.7233  (1/s)
 *
 * giving the equation of motion this module integrates:
 *
 *         ẍ = −k · (x − target) − c · ẋ
 *
 * ζ = 0.8 is **under**damped, which is the point: the step response overshoots by
 * `exp(−ζπ/√(1−ζ²)) = exp(−4.1888) ≈ 1.52 %` and comes back. A 100 px displacement crosses its
 * target by ~1.5 px before settling. That tiny overshoot is most of what "springy" means, and it
 * is asserted (both in the unit tests and in the `sidebar-spring` audit step) rather than
 * described, because it is exactly the part a decelerating curve fakes badly.
 *
 * ## The integrator
 *
 * Semi-implicit (symplectic) Euler, sub-stepped to a fixed maximum `h`:
 *
 *         v ← v + (−k·(x − target) − c·v) · h
 *         x ← x + v · h
 *
 * Velocity is updated first and the NEW velocity moves the position — that ordering is what
 * makes the scheme stable for oscillators, where explicit Euler injects energy and diverges. The
 * sub-step cap (`SPRING_MAX_SUBSTEP_S`) keeps `k·h²` far below the stability limit even when a
 * frame is late, and a late frame is clamped (`maxFrameMs`) so a tab that stalled for two seconds
 * resumes rather than teleporting.
 *
 * ## Degradation
 *
 * With no animation frames at all — jsdom, a headless render, an explicit `raf: null` — every
 * call applies its target immediately and keeps no state. This is `sidebar-scroll.ts`'s rule
 * ("no layout, nothing to animate") in the one other place motion is written by hand: the
 * *result* still happens, it simply happens at once. `prefers-reduced-motion` is the caller's
 * business, not this module's; the sidebar consults it before it asks for motion.
 *
 * This module owns numbers, not the DOM. It never reads or writes an element, which is what
 * lets the sidebar keep every spring-driven offset out of the geometry §WS-093's measure gate
 * walks: the caller decides which channel a number is written to, and answers `offset(key)` back
 * out of the measurement.
 */

/** SwiftUI's `response`, in seconds — `WorkspaceListView.swift`'s `.spring(response: 0.35, …)`. */
export const SPRING_RESPONSE_S = 0.35;
/** SwiftUI's `dampingFraction` — ζ. Under 1, so the motion overshoots and comes back. */
export const SPRING_DAMPING_FRACTION = 0.8;

/**
 * The largest integration sub-step, in seconds (240 Hz).
 *
 * At ω ≈ 17.95 the scheme is stable well past a 60 Hz step; sub-stepping to 240 Hz is cheap
 * insurance that keeps the trajectory identical whether frames arrive at 60, 120 or 30 Hz, so a
 * display's refresh rate cannot change how the sidebar feels.
 */
export const SPRING_MAX_SUBSTEP_S = 1 / 240;

/** Frames later than this are clamped: a stalled renderer must not teleport a row. */
export const SPRING_MAX_FRAME_MS = 64;

/** Settle when the remaining distance is under this many px … */
export const SPRING_REST_DISTANCE_PX = 0.1;
/** … and the speed is under this many px per second. Both, or a fast pass through 0 would stop. */
export const SPRING_REST_VELOCITY_PX_S = 2;

export interface SpringConstants {
    /** Natural frequency ω, rad/s. */
    readonly omega: number;
    /** Spring constant k = ω² for unit mass. */
    readonly stiffness: number;
    /** Damping coefficient c = 2ζω for unit mass. */
    readonly damping: number;
}

/** `response`/`dampingFraction` → the `k` and `c` the integrator actually uses. See the header. */
export function springConstants(
    response: number = SPRING_RESPONSE_S,
    dampingFraction: number = SPRING_DAMPING_FRACTION
): SpringConstants {
    const safeResponse = response > 0 ? response : SPRING_RESPONSE_S;
    const omega = (2 * Math.PI) / safeResponse;
    return { omega, stiffness: omega * omega, damping: 2 * Math.max(0, dampingFraction) * omega };
}

export interface SpringMotion {
    readonly position: number;
    readonly velocity: number;
}

/**
 * One frame of semi-implicit Euler, sub-stepped. Pure: the same inputs give the same outputs, so
 * a test can drive a whole trajectory without a clock or a DOM.
 */
export function integrateSpring(
    motion: SpringMotion,
    target: number,
    constants: SpringConstants,
    dtSeconds: number
): SpringMotion {
    if (!(dtSeconds > 0)) return motion;
    const steps = Math.max(1, Math.ceil(dtSeconds / SPRING_MAX_SUBSTEP_S));
    const h = dtSeconds / steps;
    let position = motion.position;
    let velocity = motion.velocity;
    for (let index = 0; index < steps; index++) {
        velocity += (-constants.stiffness * (position - target) - constants.damping * velocity) * h;
        position += velocity * h;
    }
    return { position, velocity };
}

/** What a channel is doing right now — what `read()` hands back. */
export interface SpringSample {
    readonly position: number;
    readonly velocity: number;
    readonly target: number;
}

export interface SpringAnimateSpec {
    /** Where the value is heading. */
    readonly to: number;
    /** Where it starts — honoured only when the channel is NEW; a retarget keeps what it had. */
    readonly from?: number | undefined;
    /** Seed velocity for a new channel, or an explicit override on a retarget. */
    readonly velocity?: number | undefined;
    /** Called with every value, including the final exact `to`. */
    readonly apply: (value: number) => void;
    /** Called once, after the last `apply`, when the channel settles. */
    readonly onSettle?: (() => void) | undefined;
}

export interface SpringDriverOptions {
    readonly response?: number | undefined;
    readonly dampingFraction?: number | undefined;
    readonly restDistance?: number | undefined;
    readonly restVelocity?: number | undefined;
    readonly maxFrameMs?: number | undefined;
    /**
     * Frame source. Omitted takes the global `requestAnimationFrame`; an explicit `null` forces
     * the instant degradation (what jsdom and `--no-motion` callers want).
     */
    readonly raf?: ((callback: (time: number) => void) => unknown) | null | undefined;
    readonly cancelRaf?: ((handle: unknown) => void) | null | undefined;
    readonly now?: (() => number) | undefined;
}

export interface SpringDriver {
    /**
     * Start, or **retarget**, the channel under `key`.
     *
     * Retargeting is the whole reason this exists: an existing channel keeps its position and its
     * velocity and only changes where it is heading. `from` is ignored for one that already runs.
     */
    animate(key: string, spec: SpringAnimateSpec): void;
    /**
     * Shift the channel's position by `delta` and spring it back to zero, keeping the velocity it
     * already had — the FLIP primitive, and the retarget the sidebar performs on every reorder.
     *
     * A row that moved while its previous displacement was still unwinding is one continuous
     * motion, not two: the old offset and the new layout delta ADD, and the velocity survives.
     */
    displace(key: string, delta: number, apply: (value: number) => void): void;
    /** The channel's live value, or `undefined` when nothing is running under `key`. */
    read(key: string): SpringSample | undefined;
    /** The channel's live value, or 0 — what a measurement subtracts to see past the animation. */
    offset(key: string): number;
    /** Jump to the target, apply it, and drop the channel. */
    settle(key: string): void;
    /** Drop the channel without applying anything (the element is going away). */
    cancel(key: string): void;
    settleAll(): void;
    cancelAll(): void;
    /** Advance every channel by `dtSeconds` by hand — how a test drives the physics. */
    step(dtSeconds: number): void;
    /** False when there are no animation frames at all, so every call lands instantly. */
    readonly animated: boolean;
    /** How many channels are live. */
    readonly size: number;
}

interface Channel {
    position: number;
    velocity: number;
    target: number;
    apply: (value: number) => void;
    onSettle: (() => void) | null;
}

export function createSpringDriver(options: SpringDriverOptions = {}): SpringDriver {
    const constants = springConstants(options.response, options.dampingFraction);
    const restDistance = options.restDistance ?? SPRING_REST_DISTANCE_PX;
    const restVelocity = options.restVelocity ?? SPRING_REST_VELOCITY_PX_S;
    const maxFrameMs = options.maxFrameMs ?? SPRING_MAX_FRAME_MS;
    const raf =
        options.raf === undefined
            ? typeof globalThis.requestAnimationFrame === 'function'
                ? globalThis.requestAnimationFrame.bind(globalThis)
                : null
            : options.raf;
    const cancelRaf: ((handle: unknown) => void) | null =
        options.cancelRaf === undefined
            ? typeof globalThis.cancelAnimationFrame === 'function'
                ? (handle: unknown) => {
                      globalThis.cancelAnimationFrame(handle as number);
                  }
                : null
            : options.cancelRaf;
    const now =
        options.now ??
        (typeof performance === 'object' && typeof performance.now === 'function'
            ? () => performance.now()
            : () => Date.now());

    const channels = new Map<string, Channel>();
    let frameHandle: unknown = null;
    let lastTime = 0;

    const atRest = (position: number, target: number, velocity: number): boolean =>
        Math.abs(position - target) <= restDistance && Math.abs(velocity) <= restVelocity;

    const step = (dtSeconds: number): void => {
        if (channels.size === 0) return;
        // Snapshotted: an `apply` (or an `onSettle`) is free to start or cancel other channels,
        // and a Map mutated during its own iteration is how that becomes a heisenbug.
        for (const [key, channel] of [...channels]) {
            if (channels.get(key) !== channel) continue;
            const next = integrateSpring(channel, channel.target, constants, dtSeconds);
            channel.position = next.position;
            channel.velocity = next.velocity;
            if (atRest(channel.position, channel.target, channel.velocity)) {
                const target = channel.target;
                const settled = channel.onSettle;
                channel.position = target;
                channel.velocity = 0;
                channels.delete(key);
                channel.apply(target);
                settled?.();
                continue;
            }
            channel.apply(channel.position);
        }
    };

    const tick = (): void => {
        frameHandle = null;
        const time = now();
        const elapsed = Math.min(maxFrameMs, Math.max(0, time - lastTime));
        lastTime = time;
        step(elapsed / 1000);
        if (channels.size > 0) schedule();
    };

    function schedule(): void {
        if (raf === null || frameHandle !== null) return;
        frameHandle = raf(tick);
    }

    const start = (): void => {
        if (raf === null || frameHandle !== null) return;
        lastTime = now();
        schedule();
    };

    const stopLoop = (): void => {
        if (frameHandle === null) return;
        cancelRaf?.(frameHandle);
        frameHandle = null;
    };

    const settleOne = (key: string): void => {
        const channel = channels.get(key);
        if (channel === undefined) return;
        channels.delete(key);
        channel.apply(channel.target);
        channel.onSettle?.();
        if (channels.size === 0) stopLoop();
    };

    return {
        animate(key, spec) {
            if (raf === null) {
                channels.delete(key);
                spec.apply(spec.to);
                spec.onSettle?.();
                return;
            }
            const existing = channels.get(key);
            if (existing === undefined) {
                const from = spec.from ?? spec.to;
                const velocity = spec.velocity ?? 0;
                if (atRest(from, spec.to, velocity)) {
                    spec.apply(spec.to);
                    spec.onSettle?.();
                    return;
                }
                channels.set(key, {
                    position: from,
                    velocity,
                    target: spec.to,
                    apply: spec.apply,
                    onSettle: spec.onSettle ?? null
                });
                spec.apply(from);
                start();
                return;
            }
            // The retarget. `position` and `velocity` are deliberately untouched — that IS the
            // continuity, and `from` is ignored here for exactly that reason.
            existing.target = spec.to;
            existing.apply = spec.apply;
            if (spec.onSettle !== undefined) existing.onSettle = spec.onSettle;
            if (spec.velocity !== undefined) existing.velocity = spec.velocity;
            start();
        },

        displace(key, delta, apply) {
            if (raf === null) {
                channels.delete(key);
                apply(0);
                return;
            }
            const existing = channels.get(key);
            const position = (existing?.position ?? 0) + delta;
            const velocity = existing?.velocity ?? 0;
            if (atRest(position, 0, velocity)) {
                channels.delete(key);
                apply(0);
                return;
            }
            if (existing === undefined) {
                channels.set(key, { position, velocity, target: 0, apply, onSettle: null });
            } else {
                existing.position = position;
                existing.target = 0;
                existing.apply = apply;
            }
            apply(position);
            start();
        },

        read(key) {
            const channel = channels.get(key);
            if (channel === undefined) return undefined;
            return { position: channel.position, velocity: channel.velocity, target: channel.target };
        },

        offset(key) {
            return channels.get(key)?.position ?? 0;
        },

        settle: settleOne,

        cancel(key) {
            if (!channels.delete(key)) return;
            if (channels.size === 0) stopLoop();
        },

        settleAll() {
            for (const key of [...channels.keys()]) settleOne(key);
        },

        cancelAll() {
            channels.clear();
            stopLoop();
        },

        step,

        get animated() {
            return raf !== null;
        },

        get size() {
            return channels.size;
        }
    };
}
