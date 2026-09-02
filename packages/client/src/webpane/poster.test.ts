/**
 * The page poster's policy (issue #12): when a pane holds its view back, what it paints, and
 * every way the mechanism is allowed to fail.
 *
 * The controller is exercised on its own — no React, no timers of its own — because everything
 * interesting about it is *ordering*: the frame is taken while the view is still on screen, the
 * hold ends exactly once, and a frame that arrives for a moment nobody is looking at any more is
 * dropped rather than painted. `WebPane.test.tsx` covers the same rules through the component
 * (the report it produces and the `<img>` it renders); this file covers them where they are
 * decided.
 */

import { describe, expect, it } from 'vitest';

import { SILENT_WEB_COMMANDS, webCommandIsSilent } from './commands';
import {
    createPosterController,
    posterAttempt,
    posterDataURL,
    posterStyle,
    posterViewRect,
    samePosterStyle,
    warmPosterImage,
    POSTER_COOLDOWN_MS,
    POSTER_DEADLINE_MS,
    POSTER_LINGER_MS,
    POSTER_MISS_LIMIT,
    POSTER_PAINT_DEADLINE_MS,
    type PosterAttempt,
    type WarmableImage
} from './poster';

const TAB = 'EEEEEEEE-0000-4000-8000-000000000001';
const OTHER_TAB = 'EEEEEEEE-0000-4000-8000-000000000002';
const FRAME = 'data:image/jpeg;base64,AAAA';

/** A schedule/cancel pair the test drives by hand, so no test waits for a real millisecond. */
function timers(): {
    schedule: (callback: () => void, ms: number) => unknown;
    cancel: (handle: unknown) => void;
    run: (ms: number) => void;
    readonly pending: number;
} {
    let seq = 0;
    const armed = new Map<number, { callback: () => void; at: number }>();
    return {
        schedule(callback, ms) {
            seq += 1;
            armed.set(seq, { callback, at: ms });
            return seq;
        },
        cancel(handle) {
            armed.delete(handle as number);
        },
        run(ms) {
            for (const [id, entry] of [...armed]) {
                if (entry.at > ms) continue;
                armed.delete(id);
                entry.callback();
            }
        },
        get pending() {
            return armed.size;
        }
    };
}

/** A capture the test settles when it chooses, so "while it is in flight" is a real state. */
function deferredCapture(): {
    capture: (tabID: string) => Promise<PosterAttempt>;
    settle: (src: string | null, transient?: boolean) => void;
    reject: () => void;
    readonly asked: readonly string[];
} {
    const asked: string[] = [];
    let settleOne: ((attempt: PosterAttempt) => void) | null = null;
    let rejectOne: (() => void) | null = null;
    return {
        asked,
        capture(tabID) {
            asked.push(tabID);
            return new Promise<PosterAttempt>((resolve, rejectPromise) => {
                settleOne = resolve;
                rejectOne = () => rejectPromise(new Error('socket closed'));
            });
        },
        settle(src, transient = false) {
            settleOne?.(src === null ? { src: null, transient } : { src });
        },
        reject() {
            rejectOne?.();
        }
    };
}

/** A clock the test moves by hand, so the cooldown is exercised without waiting for one. */
function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
    let value = start;
    return {
        now: () => value,
        advance(ms) {
            value += ms;
        }
    };
}

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

describe('posterDataURL', () => {
    it('builds a data URL from the reply the host sends', () => {
        expect(posterDataURL({ ok: true, image_base64: 'AAAA', mime: 'image/jpeg' })).toBe(FRAME);
    });

    it('defaults the mime rather than trusting one that is not an image', () => {
        expect(posterDataURL({ ok: true, image_base64: 'AAAA' })).toBe(FRAME);
        // A reply naming `text/html` would otherwise become an `<img src="data:text/html…">`.
        expect(posterDataURL({ ok: true, image_base64: 'AAAA', mime: 'text/html' })).toBe(FRAME);
    });

    it('is null for every kind of no', () => {
        expect(posterDataURL(null)).toBeNull();
        expect(posterDataURL(undefined)).toBeNull();
        expect(posterDataURL({ ok: false, error: 'no on-screen view to poster' })).toBeNull();
        expect(posterDataURL({ ok: true })).toBeNull();
        expect(posterDataURL({ ok: true, image_base64: '' })).toBeNull();
        expect(posterDataURL({ ok: true, image_base64: 42 })).toBeNull();
    });
});

describe('posterAttempt', () => {
    it('reads a frame, and every no with the one distinction the degrade rule turns on', () => {
        expect(posterAttempt({ ok: true, image_base64: 'AAAA', mime: 'image/jpeg' })).toEqual({
            src: FRAME,
            box: null
        });
        expect(
            posterAttempt({
                ok: true,
                image_base64: 'AAAA',
                mime: 'image/jpeg',
                bounds: { x: 14, y: 41, width: 897, height: 499 },
                css_scale: 1
            })
        ).toEqual({ src: FRAME, box: { x: 14, y: 41, w: 897, h: 499 } });
        // `transient` = "the view was not on screen when I looked", which is usually the client's
        // own park landing mid-capture: a fact about the moment, not about the host.
        expect(posterAttempt({ ok: false, error: 'no on-screen view to poster', transient: true })).toEqual({
            src: null,
            transient: true
        });
        expect(posterAttempt({ ok: false, error: 'poster too large to send inline' })).toEqual({
            src: null,
            transient: false
        });
        expect(posterAttempt(null)).toEqual({ src: null, transient: false });
    });
});

/**
 * The JUMP, where it is decided: the box a frame is laid out in.
 *
 * The picture has to occupy the view's own rectangle, and only the host knows what that is —
 * `viewBounds` rounds and clamps every edge of the rect the client reported. Re-deriving it here
 * would be wrong in all four numbers, and leaving it to the browser is worse: an `<img>` with
 * only insets keeps its intrinsic aspect under Tailwind's `img{max-width:100%;height:auto}`.
 */
describe('posterStyle', () => {
    // The shipped build's own numbers on a 2× display: a fractional hole, a rounded placement.
    const hole = { x: 751, y: 88.398, w: 529, h: 707.602 };
    const box = { x: 753, y: 88, w: 525, h: 706 };

    it('stands the frame on the host box, in the hole’s own coordinates', () => {
        expect(posterStyle(box, hole)).toEqual({
            left: 2,
            top: 88 - 88.398,
            width: 525,
            height: 706,
            objectFit: 'fill',
            maxWidth: 'none',
            maxHeight: 'none'
        });
    });

    it('pins width and height, because insets alone do not size a replaced element', () => {
        const style = posterStyle(box, hole);
        // The defect this replaces: 1050×1412 intrinsic → 528.99×711.38 laid out, against a view
        // of 525×706. Explicit numbers plus `max-*: none` is the only shape a browser cannot
        // reinterpret.
        expect(style.width).toBe(box.w);
        expect(style.height).toBe(box.h);
        expect(style.maxWidth).toBe('none');
        expect(style.maxHeight).toBe('none');
    });

    it('falls back to §N27a’s gutter when the host does not say', () => {
        expect(posterStyle(null, { x: 0, y: 0, w: 900, h: 500 })).toMatchObject({
            left: 2,
            top: 0,
            width: 896,
            height: 498
        });
        // A hole too small to give the strips up keeps them, exactly as the report does.
        expect(posterStyle(null, { x: 0, y: 0, w: 3, h: 1 })).toMatchObject({ left: 0, width: 3, height: 1 });
        expect(posterStyle(null, null)).toMatchObject({ left: 0, top: 0, width: 0, height: 0 });
    });

    it('answers equality on the numbers, so the publish can keep one object', () => {
        expect(samePosterStyle(posterStyle(box, hole), posterStyle(box, hole))).toBe(true);
        expect(samePosterStyle(posterStyle(box, hole), posterStyle({ ...box, w: 526 }, hole))).toBe(false);
    });
});

describe('posterViewRect', () => {
    it('multiplies the host’s DIP placement into CSS pixels', () => {
        // css_scale is the inverse of the page zoom; at ⌘+ the view is bigger in DIP than in CSS.
        expect(posterViewRect({ ok: true, bounds: { x: 20, y: 10, width: 200, height: 100 }, css_scale: 0.5 })).toEqual(
            { x: 10, y: 5, w: 100, h: 50 }
        );
        expect(posterViewRect({ ok: true, bounds: { x: 14, y: 41, width: 897, height: 499 }, css_scale: 1 })).toEqual({
            x: 14,
            y: 41,
            w: 897,
            h: 499
        });
    });

    it('is null when the host says nothing usable — the client then uses the gutter', () => {
        expect(posterViewRect({ ok: true })).toBeNull();
        expect(posterViewRect({ ok: true, bounds: { x: 0, y: 0, width: 0, height: 10 }, css_scale: 1 })).toBeNull();
        expect(posterViewRect({ ok: true, bounds: 'nope', css_scale: 1 })).toBeNull();
        expect(posterViewRect(null)).toBeNull();
    });
});

describe('the poster controller', () => {
    it('holds the view on screen while the frame is taken, then paints it', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        // The frame is asked for in the same call that discovers the cover — the whole point is
        // that it is taken while the view is still on screen.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: true, box: null });
        expect(shot.asked).toEqual([TAB]);
        // Every later render of the same cover rides the same capture.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: true, box: null });
        expect(shot.asked).toEqual([TAB]);
        expect(poster.captures).toBe(1);

        shot.settle(FRAME);
        await flush();

        expect(renders).toBe(1);
        /*
         * The frame is here — and the view STAYS on screen until it is painted. This is the
         * flicker the owner reported, as a unit: parking on arrival hands the view back a frame
         * or two before the `<img>` can appear, and the pane shows its own background in between
         * (measured on the shipped build: view gone at t+0, image first present at t+12ms).
         */
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: true, box: null });
        poster.painted(FRAME);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: false, box: null });
        // The deadline was disarmed by the answer, not left to fire into a settled session.
        expect(clock.pending).toBe(0);
    });

    it('parks anyway when the paint is never confirmed', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        // A decode that never resolves, a renderer that stopped producing frames: the menu must
        // not stay invisible for it.
        clock.run(POSTER_PAINT_DEADLINE_MS);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: false, box: null });
    });

    it('ignores a paint confirmation for a frame it is no longer showing', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        shot.settle(FRAME);
        await flush();
        poster.painted('data:image/jpeg;base64,SOMETHINGELSE');
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        poster.painted(FRAME);
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
    });

    it('gives up on the deadline so a silent host cannot hide a menu', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        clock.run(POSTER_DEADLINE_MS);
        // The view goes back with nothing to paint: exactly the behaviour that shipped before
        // the poster existed, which is what makes this a safe addition rather than a new risk.
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false, box: null });

        // A late frame is still worth painting — the menu is very likely still open — and it does
        // NOT re-hold a view that has already gone back.
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: FRAME, hold: false, box: null });
    });

    it('stops asking for a cooldown after a real no, then holds again and recovers', async () => {
        const clock = timers();
        const wall = clockAt();
        let answer: PosterAttempt = { src: null };
        let asks = 0;
        const poster = createPosterController({
            capture: () => {
                asks += 1;
                return Promise.resolve(answer);
            },
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        await flush();
        expect(poster.degraded).toBe(true);
        poster.sync({ covered: false, tabID: TAB });

        /*
         * Inside the cooldown the pane parks at once AND ASKS NOTHING — the second half is the
         * one the audit forced. A capture fired here would arrive after the park it just caused,
         * be refused for exactly that reason, and re-arm the cooldown: the state that stops the
         * pane waiting would be the state that guarantees it can never stop.
         */
        answer = { src: FRAME };
        const asksBefore = asks;
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
        await flush();
        expect(asks).toBe(asksBefore);
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBeNull();
        poster.sync({ covered: false, tabID: TAB });

        // Once it expires the pane HOLDS again, which is the only condition under which a frame
        // can come back at all — and the frame that lands clears the mark.
        wall.advance(POSTER_COOLDOWN_MS + 1);
        expect(poster.degraded).toBe(false);
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);
        expect(poster.degraded).toBe(false);
    });

    /**
     * The failure the `web-popup-layering` audit caught, as a unit: the client's own park lands
     * while the capture is in flight (a menu that raises a dialog, a workspace switch), the host
     * answers "the view is not on screen", and the pane must NOT read that as a verdict on the
     * host. It did once — and because a marked pane parks instantly, every later capture raced a
     * park it could not win, so the pane never postered again.
     */
    it('does not hold a TRANSIENT no against the host — it is about the moment, not the host', async () => {
        const clock = timers();
        const wall = clockAt();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        poster.sync({ covered: true, tabID: TAB });
        // "no on-screen view to poster": our own park got there first.
        shot.settle(null, true);
        await flush();
        expect(poster.degraded).toBe(false);

        poster.sync({ covered: false, tabID: TAB });
        // …so the very next cover still waits for a frame, and gets one.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        shot.settle(FRAME);
        await flush();
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);
    });

    it('treats a rejected call as a refusal, not as a reason to hold forever', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
        shot.reject();
        await flush();
        expect(renders).toBe(1);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false, box: null });
        expect(clock.pending).toBe(0);
    });

    it('keeps the frame painted across the swap back, then lets it go', async () => {
        const clock = timers();
        const poster = createPosterController({
            capture: () => Promise.resolve({ src: FRAME }),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        await flush();
        poster.painted(FRAME);
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);

        // Uncovered: the view is on its way back, and the frame stays under it so the handover
        // has no blank in it. This is the same no-flash rule as the hold, at the other end.
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: FRAME, hold: false, box: null });
        clock.run(POSTER_LINGER_MS);
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: null, hold: false, box: null });
    });

    it('drops a frame that was taken for a cover the pane has already left', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        poster.sync({ covered: true, tabID: TAB });
        // The pointer swept off the surface before the frame came back.
        poster.sync({ covered: false, tabID: TAB });
        shot.settle(FRAME);
        await flush();

        // Nothing lingers, because nothing was ever painted: a frame that lands after the view
        // is back would be a picture of the page appearing OVER the live page.
        expect(poster.sync({ covered: false, tabID: TAB })).toEqual({ src: null, hold: false, box: null });
        expect(clock.pending).toBe(0);
    });

    it('re-photographs when the pane switches tab under the surface', async () => {
        const clock = timers();
        const shot = deferredCapture();
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });

        poster.sync({ covered: true, tabID: TAB });
        shot.settle(FRAME);
        await flush();
        poster.painted(FRAME);
        expect(poster.sync({ covered: true, tabID: TAB }).src).toBe(FRAME);

        // A tab switch while the menu is up: the old frame is of a page that is no longer in the
        // pane, so it goes immediately rather than lingering over the new one.
        expect(poster.sync({ covered: true, tabID: OTHER_TAB })).toEqual({ src: null, hold: true, box: null });
        expect(shot.asked).toEqual([TAB, OTHER_TAB]);
    });

    it('never photographs a pane with no live tab', () => {
        const clock = timers();
        let asked = 0;
        const poster = createPosterController({
            capture: () => {
                asked += 1;
                return Promise.resolve({ src: FRAME });
            },
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        expect(poster.sync({ covered: true, tabID: null })).toEqual({ src: null, hold: false, box: null });
        expect(asked).toBe(0);
    });

    it('answers nothing once disposed, and leaves no timer behind', async () => {
        const clock = timers();
        const shot = deferredCapture();
        let renders = 0;
        const poster = createPosterController({
            capture: shot.capture,
            onChange: () => {
                renders += 1;
            },
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        poster.dispose();
        expect(clock.pending).toBe(0);
        shot.settle(FRAME);
        await flush();
        // A pane that has unmounted must not ask React for a render, and has nothing to paint.
        expect(renders).toBe(0);
        expect(poster.sync({ covered: true, tabID: TAB })).toEqual({ src: null, hold: false, box: null });
    });
});

/**
 * A run of missed deadlines is the one failure the deadline alone does not answer: each miss is
 * forgiven on its own (the frame may still be coming), so a host that is consistently slower than
 * the deadline would cost 250ms of invisible menu on every right-click, for ever.
 */
describe('a host that keeps missing the deadline', () => {
    it('cools off after a run of misses, and is forgiven by one landed frame', async () => {
        const clock = timers();
        const wall = clockAt();
        let hang = true;
        const poster = createPosterController({
            capture: (): Promise<PosterAttempt> =>
                hang ? new Promise<PosterAttempt>(() => undefined) : Promise.resolve({ src: FRAME }),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel,
            now: wall.now
        });

        for (let miss = 1; miss <= POSTER_MISS_LIMIT; miss++) {
            expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
            clock.run(POSTER_DEADLINE_MS);
            // Every miss releases the view; the run is what changes what happens NEXT time.
            expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
            expect(poster.degraded).toBe(miss >= POSTER_MISS_LIMIT);
            poster.sync({ covered: false, tabID: TAB });
        }

        // Cooling: the menu is instant, and nothing is asked for at all.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(false);
        poster.sync({ covered: false, tabID: TAB });

        hang = false;
        wall.advance(POSTER_COOLDOWN_MS + 1);
        poster.sync({ covered: true, tabID: TAB });
        await flush();
        expect(poster.degraded).toBe(false);
        poster.sync({ covered: false, tabID: TAB });
        clock.run(POSTER_LINGER_MS);
        // One frame that landed is enough to say the host works; the pane waits again.
        expect(poster.sync({ covered: true, tabID: TAB }).hold).toBe(true);
    });

    it('does not cool off on a single miss — a page can be busy once', () => {
        const clock = timers();
        const poster = createPosterController({
            capture: (): Promise<PosterAttempt> => new Promise<PosterAttempt>(() => undefined),
            onChange: () => undefined,
            schedule: clock.schedule,
            cancel: clock.cancel
        });
        poster.sync({ covered: true, tabID: TAB });
        clock.run(POSTER_DEADLINE_MS);
        expect(poster.degraded).toBe(false);
    });
});

/**
 * The contract the module header promises the user — "every failure degrades to the behaviour
 * that shipped before" — is worth nothing unless the assembly agrees to it, because `App.tsx`
 * wraps every web verb in a toast on `ok:false`. The verb is on the silent list for that reason;
 * `App.window-chrome.test.tsx` pins the assembly end of the same rule.
 */
describe('the verb is exempt from the assembly’s error toasts', () => {
    it('names `web-poster` and nothing else', () => {
        expect([...SILENT_WEB_COMMANDS]).toEqual(['web-poster']);
        expect(webCommandIsSilent({ command: 'web-poster', pane_id: 'p', tab_id: 't' })).toBe(true);
    });

    it('leaves every gesture verb loud — a refused gesture is news', () => {
        expect(webCommandIsSilent({ command: 'web-navigate', pane_id: 'p', url: 'u' })).toBe(false);
        expect(webCommandIsSilent({ command: 'web-capture', pane_id: 'p', mode: 'screenshot' })).toBe(false);
        expect(webCommandIsSilent({})).toBe(false);
    });
});

/**
 * The decode step, which is the difference between "the bytes arrived" and "the picture can be
 * painted". Parking on the former hands the view back before its replacement is ready, which is
 * the black frame the whole mechanism exists to avoid.
 */
describe('warmPosterImage', () => {
    it('waits for the frame to decode before calling it landed', async () => {
        const order: string[] = [];
        let release: (() => void) | null = null;
        const image: WarmableImage = {
            src: '',
            decode: () =>
                new Promise<void>((resolve) => {
                    release = () => {
                        order.push('decoded');
                        resolve();
                    };
                })
        };
        const warmed = warmPosterImage(FRAME, () => image).then(() => order.push('landed'));
        await Promise.resolve();
        expect(order).toEqual([]);
        expect(image.src).toBe(FRAME);
        (release as unknown as () => void)();
        await warmed;
        expect(order).toEqual(['decoded', 'landed']);
    });

    it('yields the frame anyway when the decode fails or does not exist', async () => {
        await expect(
            warmPosterImage(FRAME, () => ({ src: '', decode: () => Promise.reject(new Error('no codec')) }))
        ).resolves.toBe(FRAME);
        // jsdom has no image pipeline at all; a frame is still a frame.
        await expect(warmPosterImage(FRAME, () => ({ src: '' }))).resolves.toBe(FRAME);
        await expect(
            warmPosterImage(FRAME, () => {
                throw new Error('no Image in this realm');
            })
        ).resolves.toBe(FRAME);
    });
});
