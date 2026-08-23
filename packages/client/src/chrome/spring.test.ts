import { describe, expect, it, vi } from 'vitest';

import {
    SPRING_DAMPING_FRACTION,
    SPRING_RESPONSE_S,
    createSpringDriver,
    integrateSpring,
    springConstants
} from './spring';

/**
 * A hand-cranked frame source: `raf` queues a callback, `frame()` runs the queue with a fixed
 * `dt`, and nothing depends on a real clock. Every trajectory below is therefore deterministic —
 * which is the point of keeping the physics in a module that never touches the DOM.
 */
function harness(dtMs = 1000 / 60, options: Parameters<typeof createSpringDriver>[0] = {}) {
    let time = 0;
    let queued: ((value: number) => void) | null = null;
    const driver = createSpringDriver({
        ...options,
        now: () => time,
        raf: (callback) => {
            queued = callback;
            return 1;
        },
        cancelRaf: () => {
            queued = null;
        }
    });
    const frame = (): void => {
        const callback = queued;
        queued = null;
        time += dtMs;
        callback?.(time);
    };
    return { driver, frame, frames: (count: number) => { for (let i = 0; i < count; i++) frame(); } };
}

describe('spring constants (SwiftUI `.spring(response:dampingFraction:)`)', () => {
    it('derives ω, k and c from response 0.35 / dampingFraction 0.8', () => {
        const { omega, stiffness, damping } = springConstants(SPRING_RESPONSE_S, SPRING_DAMPING_FRACTION);
        // ω = 2π / 0.35
        expect(omega).toBeCloseTo(17.9520, 3);
        // k = ω² (unit mass)
        expect(stiffness).toBeCloseTo(322.276, 2);
        // c = 2ζω
        expect(damping).toBeCloseTo(28.7233, 3);
    });

    it('falls back to the sidebar response for a non-positive one', () => {
        expect(springConstants(0, 0.8).omega).toBeCloseTo(springConstants().omega, 9);
    });
});

describe('the integrator', () => {
    const constants = springConstants();

    it('converges on the target from rest', () => {
        let motion = { position: 100, velocity: 0 };
        for (let frame = 0; frame < 60; frame++) motion = integrateSpring(motion, 0, constants, 1 / 60);
        expect(Math.abs(motion.position)).toBeLessThan(0.05);
        expect(Math.abs(motion.velocity)).toBeLessThan(1);
    });

    it('OVERSHOOTS — ζ = 0.8 is underdamped, and that is what "springy" means', () => {
        let motion = { position: 100, velocity: 0 };
        let crossed = false;
        let extreme = 0;
        for (let frame = 0; frame < 60; frame++) {
            motion = integrateSpring(motion, 0, constants, 1 / 60);
            if (motion.position < 0) {
                crossed = true;
                extreme = Math.min(extreme, motion.position);
            }
        }
        expect(crossed).toBe(true);
        // exp(-ζπ/√(1−ζ²)) = exp(-4.1888) ≈ 1.52 % of the 100px step. Bracketed, not asserted
        // to a decimal, so a stability tweak to the sub-step cannot silently kill the overshoot.
        expect(Math.abs(extreme)).toBeGreaterThan(0.8);
        expect(Math.abs(extreme)).toBeLessThan(3);
    });

    it('does not overshoot at ζ = 1 (critically damped), so the ratio is really doing the work', () => {
        const critical = springConstants(SPRING_RESPONSE_S, 1);
        let motion = { position: 100, velocity: 0 };
        let minimum = 100;
        for (let frame = 0; frame < 90; frame++) {
            motion = integrateSpring(motion, 0, critical, 1 / 60);
            minimum = Math.min(minimum, motion.position);
        }
        expect(minimum).toBeGreaterThan(-0.05);
    });

    it('is stable at a long frame, because sub-stepping bounds k·h²', () => {
        let motion = { position: 100, velocity: 0 };
        // 64 ms frames — the clamp the driver applies to a stalled renderer.
        for (let frame = 0; frame < 40; frame++) motion = integrateSpring(motion, 0, constants, 0.064);
        expect(Number.isFinite(motion.position)).toBe(true);
        expect(Math.abs(motion.position)).toBeLessThan(0.05);
    });

    it('is a no-op for a non-positive dt', () => {
        const motion = { position: 7, velocity: -3 };
        expect(integrateSpring(motion, 0, constants, 0)).toBe(motion);
        expect(integrateSpring(motion, 0, constants, -1)).toBe(motion);
    });
});

describe('the driver', () => {
    it('runs a displacement home and stops on its own', () => {
        const { driver, frames } = harness();
        const seen: number[] = [];
        driver.displace('row', 34, (value) => seen.push(value));

        expect(driver.size).toBe(1);
        expect(seen[0]).toBe(34);
        frames(60);
        expect(driver.size).toBe(0);
        expect(seen.at(-1)).toBe(0);
        // Dense: one sample per frame, not two keyframes.
        expect(seen.length).toBeGreaterThan(20);
    });

    it('crosses zero and comes back — the audit step’s shape, in numbers', () => {
        const { driver, frames } = harness();
        const seen: number[] = [];
        driver.displace('row', 100, (value) => seen.push(value));
        frames(60);
        expect(seen.some((value) => value < -0.5)).toBe(true);
        expect(seen.at(-1)).toBe(0);
    });

    /**
     * THE DISCRIMINATOR.
     *
     * This is the test no CSS-transition implementation can pass. Halfway through one
     * displacement, retarget with a second one in the opposite direction and check the two
     * things a restarted transition destroys:
     *
     *   1. **position continuity** — no frame moves further than a real spring could at that
     *      speed. A restart from the current position keeps this, so it is necessary, not
     *      sufficient;
     *   2. **velocity continuity** — the value keeps moving the way it already was for at least
     *      a frame after the retarget. A CSS transition restarts at v = 0 and the sign of the
     *      motion flips on the very next frame.
     */
    it('retargets with position AND velocity continuous (a restarted transition cannot)', () => {
        const { driver, frames } = harness();
        const seen: number[] = [];
        driver.displace('row', 60, (value) => seen.push(value));
        frames(6);

        const before = driver.read('row');
        expect(before).toBeDefined();
        // Mid-flight and genuinely moving.
        expect(Math.abs(before?.position ?? 0)).toBeGreaterThan(1);
        expect(Math.abs(before?.velocity ?? 0)).toBeGreaterThan(10);

        const marker = seen.length;
        // The row is crossed again the other way: another layout delta lands on top.
        driver.displace('row', -34, (value) => seen.push(value));
        const after = driver.read('row');
        // Position shifted by exactly the delta; velocity untouched. That pair IS the retarget.
        expect(after?.position).toBeCloseTo((before?.position ?? 0) - 34, 9);
        expect(after?.velocity).toBeCloseTo(before?.velocity ?? 0, 9);

        frames(60);
        // No jump between consecutive frames beyond what the physics can produce.
        const jumps: number[] = [];
        for (let index = marker + 1; index < seen.length; index++) {
            jumps.push(Math.abs((seen[index] ?? 0) - (seen[index - 1] ?? 0)));
        }
        expect(Math.max(...jumps)).toBeLessThan(6);
        expect(seen.at(-1)).toBe(0);
    });

    it('keeps travelling in its old direction for a frame after a retarget (velocity carried)', () => {
        const { driver, frames } = harness();
        let value = 0;
        driver.displace('row', 60, (next) => {
            value = next;
        });
        frames(6);
        const beforeVelocity = driver.read('row')?.velocity ?? 0;
        // Falling toward 0 from +: velocity is negative.
        expect(beforeVelocity).toBeLessThan(0);

        // Retarget UPWARD. A zero-velocity restart would move up immediately; a spring that
        // carries its velocity must keep going down for at least one more frame.
        driver.displace('row', 40, (next) => {
            value = next;
        });
        const start = value;
        frames(1);
        expect(value).toBeLessThan(start);
        expect(driver.read('row')?.velocity ?? 0).toBeLessThan(0);
    });

    it('settles only when BOTH thresholds are met', () => {
        const { driver, frames } = harness(1000 / 60, { restDistance: 0.5, restVelocity: 1 });
        const seen: number[] = [];
        driver.displace('row', 20, (value) => seen.push(value));
        frames(200);
        expect(driver.size).toBe(0);
        expect(seen.at(-1)).toBe(0);

        // A displacement already inside both thresholds never starts a channel at all.
        const applied: number[] = [];
        driver.displace('tiny', 0.2, (value) => applied.push(value));
        expect(driver.size).toBe(0);
        expect(applied).toEqual([0]);

        // Inside the distance but moving fast: still animates, because a fast pass through the
        // target is not a rest.
        driver.animate('fast', { to: 0, from: 0.2, velocity: 400, apply: () => {} });
        expect(driver.size).toBe(1);
    });

    it('calls onSettle exactly once, after the final exact value', () => {
        const { driver, frames } = harness();
        const settle = vi.fn();
        const seen: number[] = [];
        driver.animate('row', {
            to: 0,
            from: 24,
            apply: (value) => seen.push(value),
            onSettle: settle
        });
        frames(90);
        expect(settle).toHaveBeenCalledTimes(1);
        expect(seen.at(-1)).toBe(0);
    });

    it('reports offset(), which is how a measurement sees past the animation', () => {
        const { driver, frames } = harness();
        driver.displace('row', 30, () => {});
        expect(driver.offset('row')).toBeCloseTo(30, 9);
        frames(4);
        expect(driver.offset('row')).toBeLessThan(30);
        expect(driver.offset('missing')).toBe(0);
        driver.settle('row');
        expect(driver.offset('row')).toBe(0);
    });

    it('settle() jumps to the target and cancel() abandons it', () => {
        const { driver, frames } = harness();
        let settled = 0;
        driver.animate('a', { to: 0, from: 40, apply: (value) => (settled = value) });
        driver.displace('b', 40, () => {});
        frames(3);
        driver.settle('a');
        expect(settled).toBe(0);
        expect(driver.size).toBe(1);
        driver.cancel('b');
        expect(driver.size).toBe(0);
        driver.cancelAll();
        expect(driver.size).toBe(0);
    });

    it('clamps a very late frame instead of teleporting', () => {
        const { driver, frame } = harness(4000);
        const seen: number[] = [];
        driver.displace('row', 100, (value) => seen.push(value));
        frame();
        // 4 s of wall clock, clamped to 64 ms of physics: still on the way down, not settled.
        expect(driver.size).toBe(1);
        expect(seen.at(-1)).toBeGreaterThan(0);
        expect(seen.at(-1)).toBeLessThan(100);
    });

    /**
     * The jsdom / no-rAF degradation, and the reason the sidebar's unit tests are unaffected by
     * any of this: with no frame source the target is simply the value, at once.
     */
    it('degrades to an instant set when there are no animation frames', () => {
        const driver = createSpringDriver({ raf: null });
        expect(driver.animated).toBe(false);
        const seen: number[] = [];
        const settle = vi.fn();
        driver.displace('row', 40, (value) => seen.push(value));
        expect(seen).toEqual([0]);
        expect(driver.size).toBe(0);
        expect(driver.offset('row')).toBe(0);

        driver.animate('row', { to: 12, from: 0, apply: (value) => seen.push(value), onSettle: settle });
        expect(seen).toEqual([0, 12]);
        expect(settle).toHaveBeenCalledTimes(1);
        expect(driver.size).toBe(0);
    });

    it('survives an apply() that starts or cancels other channels', () => {
        const { driver, frames } = harness();
        driver.displace('a', 30, () => {
            driver.cancel('b');
        });
        driver.displace('b', 30, () => {});
        expect(() => {
            frames(30);
        }).not.toThrow();
        expect(driver.size).toBe(0);
    });
});
